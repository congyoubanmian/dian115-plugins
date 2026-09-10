package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	protocol  = "dian115:process@1"
	frameSize = 16 << 20
	// 持久化预算: wasip1 单线程下序列化 + Base64 编码会同时占两份内存, 单个键超过
	// maxPersistBytes 就放弃(避免把堆顶到 manifest memory_mb 的线性内存硬限额而 OOM)。
	maxPersistBytes  = 4 << 20
	persistLogLimit  = 40
	logMessageLimit  = 400
	posterCacheLimit = 64
	// 每次刷新最多为多少条口碑榜条目补海报(每条 1~2 次外部 host.call)。
	posterLookupLimit = 8
	// 前台动作/后台任务的时间预算: 宿主实测约 10 秒就会强杀 worker, 主动提前收尾。
	actionBudget = 6500 * time.Millisecond
	jobBudget    = 8 * time.Minute
)

// ---------------------------------------------------------------------------
// 帧协议 / JSON-RPC 通道（与宿主规范一致）
// ---------------------------------------------------------------------------

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type pendingResult struct {
	result json.RawMessage
	err    error
}

type hostCallRequest struct {
	Method        string            `json:"method"`
	Path          string            `json:"path"`
	Headers       map[string]string `json:"headers,omitempty"`
	BodyBase64    string            `json:"body_base64,omitempty"`
	CredentialRef string            `json:"credential_ref,omitempty"`
}

type hostCallResponse struct {
	Status     int                 `json:"status"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"body_base64"`
}

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

const (
	listUpcoming  = "upcoming"
	listHot       = "hot"
	listCNWom     = "cn_wom"
	listGlobalWom = "global_wom"
	listMovieWom  = "movie_wom"
)

type ListConfig struct {
	Source  string `json:"source"` // coming_html | subjects_json | chart_html
	Type    string `json:"type"`   // movie | tv
	Tag     string `json:"tag"`
	Sort    string `json:"sort"`
	Limit   int    `json:"limit"`
	Enabled bool   `json:"enabled"`
}

type Settings struct {
	Lists              map[string]ListConfig `json:"lists"`
	Blacklist          []string              `json:"blacklist"`
	ObservePeriodHours int                   `json:"observe_period_hours"`
	AutoSubscribe      bool                  `json:"auto_subscribe"`
	NotifyOnSubscribe  bool                  `json:"notify_on_subscribe"`
	SubscribeSources   []string              `json:"subscribe_source_filter"`
	MaxHistory         int                   `json:"max_history"`
	MaxLogs            int                   `json:"max_logs"`
}

type ChartItem struct {
	DoubanRef string `json:"douban_ref"`
	Title     string `json:"title"`
	Rate      string `json:"rate"`
	Rank      string `json:"rank,omitempty"`
	Hotness   int    `json:"hotness"`
	PosterURL string `json:"poster_url"`
	URL       string `json:"url"`
	Year      string `json:"year,omitempty"`
}

type Snapshot struct {
	FetchedAt string                 `json:"fetched_at"`
	Lists     map[string][]ChartItem `json:"lists"`
}

type QueueItem struct {
	DoubanRef  string `json:"douban_ref"`
	Title      string `json:"title"`
	List       string `json:"list"`
	PosterURL  string `json:"poster_url"`
	URL        string `json:"url"`
	TmdbRef    string `json:"tmdb_ref,omitempty"`
	MediaType  string `json:"media_type,omitempty"`
	Year       string `json:"year,omitempty"`
	PosterPath string `json:"poster_path,omitempty"`
	EnteredAt  string `json:"entered_at"`
	DueAt      string `json:"due_at"`
	State      string `json:"state"` // observing | needs_review | subscribed
	Attempt    int    `json:"attempt"`
	LastError  string `json:"last_error,omitempty"`
}

type Queue struct {
	Items []QueueItem `json:"items"`
}

type HistoryEntry struct {
	DoubanRef string `json:"douban_ref"`
	TmdbRef   string `json:"tmdb_ref"`
	Title     string `json:"title"`
	List      string `json:"list"`
	Action    string `json:"action"` // subscribe | skip
	Result    string `json:"result"` // succeeded | failed
	Message   string `json:"message"`
	IntentID  int64  `json:"intent_id,omitempty"`
	CreatedAt string `json:"created_at"`
}

type LogEntry struct {
	At      string `json:"at"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

type Stats struct {
	Total         int            `json:"total"`
	MonthNew      int            `json:"month_new"`
	Month         string         `json:"month"`
	ByList        map[string]int `json:"by_list"`
	LastArchiveAt string         `json:"last_archive_at"`
}

type BlackHit struct {
	Title   string `json:"title"`
	Keyword string `json:"keyword"`
	At      string `json:"at"`
}

type BlackState struct {
	Keywords []string   `json:"keywords"`
	Hits     int        `json:"hits"`
	Recent   []BlackHit `json:"recent"`
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

type runtime struct {
	dataDir string

	mu         sync.Mutex
	settings   Settings
	snapshot   Snapshot
	queue      Queue
	history    []HistoryEntry
	logs       []LogEntry
	stats      Stats
	blackState BlackState

	revision    int
	lastStatus  string
	lastMessage string
	lastRun     string
	refreshing  bool
	// deepRefresh: 后台任务(预算宽松)才做逐条海报补全等昂贵操作。
	deepRefresh bool

	posterCache map[string]string // poster_url -> dataURL（避免重复抓取）
}

func (r *runtime) now() string { return time.Now().Format(time.RFC3339) }

// persistedState 是宿主存储里的单一状态文档。
// 宿主 wazero 是解释器, 每次 host.call 都是真实开销; 把 7 个键合并成 1 个,
// 读/写各只需一次往返(旧版本遗留的分键数据在首次加载时自动迁移)。
type persistedState struct {
	Settings   Settings       `json:"settings"`
	Snapshot   Snapshot       `json:"snapshot"`
	Queue      Queue          `json:"queue"`
	History    []HistoryEntry `json:"history"`
	Logs       []LogEntry     `json:"logs"`
	Stats      Stats          `json:"stats"`
	BlackState BlackState     `json:"blackstate"`
}

const stateStorageKey = "state"

func (r *runtime) loadAll() {
	if raw, ok := wasmStorageGet(stateStorageKey); ok {
		var doc persistedState
		if safeUnmarshal(raw, &doc) == nil && doc.Settings.Lists != nil {
			r.settings = doc.Settings
			r.snapshot = doc.Snapshot
			r.queue = doc.Queue
			r.history = doc.History
			r.logs = doc.Logs
			r.stats = doc.Stats
			r.blackState = doc.BlackState
		}
	} else {
		// 迁移旧的分键持久化格式(每个键一次读取)。
		loadJSON(filepath.Join(r.dataDir, "settings.json"), &r.settings)
		loadJSON(filepath.Join(r.dataDir, "snapshot.json"), &r.snapshot)
		loadJSON(filepath.Join(r.dataDir, "queue.json"), &r.queue)
		loadJSON(filepath.Join(r.dataDir, "history.json"), &r.history)
		loadJSON(filepath.Join(r.dataDir, "logs.json"), &r.logs)
		loadJSON(filepath.Join(r.dataDir, "stats.json"), &r.stats)
		loadJSON(filepath.Join(r.dataDir, "blackstate.json"), &r.blackState)
	}
	if r.settings.Lists == nil {
		r.settings = defaultSettings()
	}
	if r.stats.ByList == nil {
		r.stats.ByList = map[string]int{}
	}
	r.normalizeSettingsLocked()
}

// normalizeSettingsLocked 防呆：即将上映必须用 coming_html 来源（豆瓣 /later/ 页，含海报），
// 防止持久化 settings 里被误配成 subjects_json 导致抓取为空。
func (r *runtime) normalizeSettingsLocked() {
	up := r.settings.Lists[listUpcoming]
	if up.Source != "coming_html" || up.Type != "movie" {
		up.Source = "coming_html"
		up.Type = "movie"
		up.Sort = ""
		up.Tag = ""
		if up.Limit <= 0 {
			up.Limit = 20
		}
		up.Enabled = true
		r.settings.Lists[listUpcoming] = up
	}
}

func (r *runtime) persistAll() {
	// wasip1 单线程下大对象序列化会把堆顶到宿主的内存硬限额(manifest memory_mb),
	// 因此只保留最近少量日志; 整份状态超过 maxPersistBytes 时放弃本次落盘。
	r.mu.Lock()
	logTail := make([]LogEntry, 0, persistLogLimit)
	if n := len(r.logs); n > 0 {
		start := n - persistLogLimit
		if start < 0 {
			start = 0
		}
		logTail = append(logTail, r.logs[start:]...)
	}
	doc := persistedState{
		Settings: r.settings, Snapshot: r.snapshot, Queue: r.queue,
		History: r.history, Logs: logTail, Stats: r.stats, BlackState: r.blackState,
	}
	r.mu.Unlock()

	data, err := json.Marshal(&doc)
	if err != nil {
		r.log("warning", "持久化失败: marshal:"+err.Error())
		return
	}
	if len(data) > maxPersistBytes {
		r.log("warning", "持久化跳过: 状态过大 "+strconv.Itoa(len(data))+"B")
		return
	}
	if err := wasmStoragePut(stateStorageKey, data); err != nil {
		r.log("warning", "持久化失败: "+err.Error())
	}
}

func (r *runtime) bump(status, message string) {
	r.mu.Lock()
	r.revision++
	r.lastStatus = status
	r.lastMessage = message
	r.mu.Unlock()
}

// touch 仅递增状态版本号，用于任意状态变更后让宿主能感知并推送新状态。
func (r *runtime) touch() {
	r.mu.Lock()
	r.revision++
	r.mu.Unlock()
}

// ---------------------------------------------------------------------------
// 榜单抓取
// ---------------------------------------------------------------------------

var (
	reLi       = regexp.MustCompile(`(?s)<li>(.*?)</li>`)
	reSubj     = regexp.MustCompile(`https://movie\.douban\.com/subject/(\d+)/"[^>]*>\s*([^<]{1,120}?)\s*</a>`)
	reWant     = regexp.MustCompile(`([\d,]+)\s*人?\s*想看`)
	reRate     = regexp.MustCompile(`<span class="rating_nums">([\d.]+)</span>`)
	reTitle    = regexp.MustCompile(`<a[^>]*href="https://movie\.douban\.com/subject/(\d+)/"[^>]*>([^<]{1,120})</a>`)
	reListCont = regexp.MustCompile(`(?s)id="listCont2"(.*?)</ul>`)
	reLiClear  = regexp.MustCompile(`(?s)<li class="clearfix">(.*?)</li>`)
	reNo       = regexp.MustCompile(`class="no">\s*(\d+)`)
	// 豆瓣新旧模板的外层容器分别用 class="name" 和 class="box_chart", 直接按标题链接匹配更稳。
	reName        = regexp.MustCompile(`<a[^>]*href="https://movie\.douban\.com/subject/(\d+)/"[^>]*>\s*([^<]+)`)
	reShowingSoon = regexp.MustCompile(`(?s)id="showing-soon"(.*)`)
	reItemMod     = regexp.MustCompile(`(?s)<div class="item mod[^"]*">.*?</div>\s*</div>`)
	reItemSubj    = regexp.MustCompile(`<h3>\s*<a[^>]*href="https://movie\.douban\.com/subject/(\d+)/"[^>]*>\s*([^<]+)`)
	reItemImg     = regexp.MustCompile(`<img[^>]+src="([^"]+)"`)
)

func parseWant(s string) int {
	m := reWant.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	v, _ := strconv.Atoi(strings.ReplaceAll(m[1], ",", ""))
	return v
}

// sourceCost 粗略表示各榜单来源的抓取成本(越小越便宜)。
func sourceCost(source string) int {
	switch source {
	case "subjects_json":
		return 1
	case "chart_html":
		return 2
	case "coming_html":
		return 3
	}
	return 4
}

func (r *runtime) fetchList(key string, cfg ListConfig) ([]ChartItem, error) {
	switch cfg.Source {
	case "subjects_json":
		return r.fetchSubjectsJSON(cfg)
	case "coming_html":
		return r.fetchComing(cfg.Limit)
	case "chart_html":
		return r.fetchChart(cfg.Limit)
	default:
		return nil, fmt.Errorf("未知榜单来源 %q", cfg.Source)
	}
}

func (r *runtime) httpGet(fullURL string, accept string) ([]byte, int, error) {
	response, err := r.hostCall(hostCallRequest{
		Method: "GET",
		Path:   fullURL,
		Headers: map[string]string{
			"accept":     accept,
			"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
			// 豆瓣图片 CDN 防盗链：必须带豆瓣来源 Referer，否则返回 418
			"referer": "https://movie.douban.com/",
		},
	})
	if err != nil {
		return nil, 0, err
	}
	if response.Status >= 400 {
		return nil, response.Status, fmt.Errorf("HTTP %d", response.Status)
	}
	body, err := decodeBody(response)
	if err != nil {
		return nil, response.Status, err
	}
	return body, response.Status, nil
}

func (r *runtime) fetchSubjectsJSON(cfg ListConfig) ([]ChartItem, error) {
	u := "https://movie.douban.com/j/search_subjects?type=" + url.QueryEscape(cfg.Type) +
		"&tag=" + url.QueryEscape(cfg.Tag) + "&sort=" + url.QueryEscape(cfg.Sort) +
		"&page_limit=" + strconv.Itoa(cfg.Limit) + "&page_start=0"
	body, _, err := r.httpGet(u, "application/json, text/plain;q=0.9")
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Subjects []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
			Rate  string `json:"rate"`
			Cover string `json:"cover"`
			URL   string `json:"url"`
		} `json:"subjects"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	items := make([]ChartItem, 0, len(parsed.Subjects))
	for _, s := range parsed.Subjects {
		if strings.TrimSpace(s.Title) == "" {
			continue
		}
		items = append(items, ChartItem{
			DoubanRef: "db:subj:" + s.ID,
			Title:     strings.TrimSpace(s.Title),
			Rate:      s.Rate,
			PosterURL: s.Cover,
			URL:       s.URL,
		})
	}
	return items, nil
}

// 即将上映页是 <table> 结构（每行一个 <tr>：日期 / 片名链接 / 类型 / 地区 / 想看数）
var reRow = regexp.MustCompile(`(?s)<tr>(.*?)</tr>`)
var reRowSubj = regexp.MustCompile(`https://movie\.douban\.com/subject/(\d+)/"[^>]*>\s*([^<]{1,120}?)\s*</a>`)

func (r *runtime) fetchComing(limit int) ([]ChartItem, error) {
	// 豆瓣已把 /later/ 301 到 /cinema/later/; 直接请求新地址, 避免依赖宿主是否跟随重定向。
	body, _, err := r.httpGet("https://movie.douban.com/cinema/later/", "text/html,application/xhtml+xml;q=0.9")
	if err != nil {
		return nil, err
	}
	html := string(body)
	// 即将上映在 #showing-soon 内，每个 <div class="item mod"> 一条：海报 + 片名 + 日期/类型/想看
	items := []ChartItem{}
	seen := map[string]bool{}
	space := regexp.MustCompile(`\s+`)
	seg := sectionAfter(html, `id="showing-soon"`, "", "")
	for _, it := range reItemMod.FindAllString(seg, -1) {
		nm := reItemSubj.FindStringSubmatch(it)
		if nm == nil {
			continue
		}
		id := nm[1]
		if seen[id] {
			continue
		}
		seen[id] = true
		title := strings.TrimSpace(space.ReplaceAllString(nm[2], " "))
		if title == "" {
			continue
		}
		poster := ""
		if im := reItemImg.FindStringSubmatch(it); im != nil && strings.HasPrefix(im[1], "http") {
			poster = im[1]
		}
		items = append(items, ChartItem{
			DoubanRef: "db:subj:" + id,
			Title:     title,
			Hotness:   parseWant(it),
			PosterURL: poster,
			URL:       "https://movie.douban.com/subject/" + id + "/",
		})
		if len(items) >= limit {
			break
		}
	}
	return items, nil
}

var reImg = regexp.MustCompile(`<img[^>]+src="([^"]+)"`)

func extractPoster(s string) string {
	// 优先取 subject 封面缩略图（只接受绝对 http(s) 地址，
	// 避免把 douban 相对路径 /pXXX.jpg 混入状态导致宿主安全过滤拒绝响应）
	for _, m := range reImg.FindAllStringSubmatch(s, -1) {
		u := m[1]
		if strings.HasPrefix(u, "http") && (strings.Contains(u, "doubanio") || strings.Contains(u, "douban.com")) {
			return u
		}
	}
	if m := reImg.FindStringSubmatch(s); m != nil && strings.HasPrefix(m[1], "http") {
		return m[1]
	}
	return ""
}

// sectionAfter 用字节查找截出目标段落, 替代在大页面上的惰性正则匹配。
// openTag/closeTag 为空时表示取锚点之后的全部内容。
func sectionAfter(html, anchor, openTag, closeTag string) string {
	i := strings.Index(html, anchor)
	if i < 0 {
		return html
	}
	seg := html[i:]
	if openTag != "" {
		if j := strings.Index(seg, openTag); j >= 0 {
			seg = seg[j:]
		}
	}
	if closeTag != "" {
		if j := strings.Index(seg, closeTag); j >= 0 {
			seg = seg[:j]
		}
	}
	return seg
}

func (r *runtime) fetchChart(limit int) ([]ChartItem, error) {
	body, _, err := r.httpGet("https://movie.douban.com/chart", "text/html,application/xhtml+xml;q=0.9")
	if err != nil {
		return nil, err
	}
	html := string(body)
	// 一周口碑榜位于 <ul id="listCont2">，每行 <li class="clearfix">：排名 + 片名链接 + 排名变化。
	// 列表本身不含海报，按标题调用豆瓣 suggest 接口逐条补充（校验返回 id 一致）。
	items := []ChartItem{}
	seen := map[string]bool{}
	space := regexp.MustCompile(`\s+`)
	// 用字节定位取段落: wazero 下在几十 KB 文本上跑正则太贵。
	// 注意: 该页面的写法是 <ul class="content" id="listCont2">, <ul 在锚点之前,
	// 所以只能从锚点往后截到 </ul>。
	seg := sectionAfter(html, `id="listCont2"`, "", `</ul>`)
	for _, li := range reLiClear.FindAllString(seg, -1) {
		nm := reName.FindStringSubmatch(li)
		if nm == nil {
			continue
		}
		id := nm[1]
		if seen[id] {
			continue
		}
		seen[id] = true
		title := strings.TrimSpace(space.ReplaceAllString(nm[2], " "))
		if title == "" {
			continue
		}
		rank := ""
		if rm := reNo.FindStringSubmatch(li); rm != nil {
			rank = rm[1]
		}
		// 口碑榜 HTML 不带海报, 只能按标题逐条问豆瓣。宿主侧每多一次 host.call 就是
		// 一次真实网络往返(解释器里尤其贵), 因此只给前若干条补海报, 其余交给前端
		// 的 get-poster 动作按需取图。
		poster := ""
		// 前台动作只有 10 秒预算(宿主侧), 逐条补海报要多次外部请求, 放到后台任务里做。
		if r.deepRefresh && len(items) < posterLookupLimit {
			poster = r.moviePoster(title, id)
		}
		items = append(items, ChartItem{
			DoubanRef: "db:subj:" + id,
			Title:     title,
			Rank:      rank,
			Rate:      "",
			Hotness:   parseWant(li),
			PosterURL: poster,
			URL:       "https://movie.douban.com/subject/" + id + "/",
		})
		if len(items) >= limit {
			break
		}
	}
	return items, nil
}

// moviePoster 优先用豆瓣搜索建议接口按标题取海报（校验 id 一致），
// 查不到时回退豆瓣移动端 rexxar API 按 subject id 精确取海报（豆瓣自身图源）。
func (r *runtime) moviePoster(title, wantID string) string {
	if p := r.suggestPoster(title, wantID); p != "" {
		return p
	}
	return r.rexxarPoster(wantID)
}

// suggestPoster 调用豆瓣搜索建议接口按标题查海报，仅当返回条目 id 与目标一致时才采用，
// 避免同名不同片导致海报错配。
func (r *runtime) suggestPoster(title, wantID string) string {
	u := "https://movie.douban.com/j/subject_suggest?q=" + url.QueryEscape(title)
	body, _, err := r.httpGet(u, "application/json, text/plain;q=0.9")
	if err != nil {
		return ""
	}
	var arr []struct {
		ID  string `json:"id"`
		Img string `json:"img"`
	}
	if json.Unmarshal(body, &arr) != nil {
		return ""
	}
	for _, s := range arr {
		if s.ID == wantID && strings.HasPrefix(s.Img, "http") {
			return s.Img
		}
	}
	return ""
}

// rexxarPoster 调用豆瓣移动端 rexxar API 按 subject id 取海报（豆瓣自身图源）。
func (r *runtime) rexxarPoster(subjectID string) string {
	u := "https://m.douban.com/rexxar/api/v2/movie/" + url.PathEscape(subjectID)
	body, _, err := r.httpGet(u, "application/json, text/plain;q=0.9")
	if err != nil {
		return ""
	}
	var d struct {
		Pic struct {
			Normal string `json:"normal"`
		} `json:"pic"`
	}
	if json.Unmarshal(body, &d) != nil || !strings.HasPrefix(d.Pic.Normal, "http") {
		return ""
	}
	return d.Pic.Normal
}

// ---------------------------------------------------------------------------
// TMDB 匹配
// ---------------------------------------------------------------------------

type TmdbItem struct {
	ID            int     `json:"id"`
	Title         string  `json:"title"`
	Name          string  `json:"name"`
	OriginalTitle string  `json:"original_title"`
	OriginalName  string  `json:"original_name"`
	MediaType     string  `json:"media_type"`
	ReleaseDate   string  `json:"release_date"`
	FirstAirDate  string  `json:"first_air_date"`
	PosterPath    string  `json:"poster_path"`
	BackdropPath  string  `json:"backdrop_path"`
	VoteAverage   float64 `json:"vote_average"`
}

type tmdbSearchResult struct {
	Results []TmdbItem `json:"results"`
}

func (r *runtime) tmdbSearch(query string) (*tmdbSearchResult, error) {
	path := "/api/tmdb/search?q=" + url.QueryEscape(query)
	response, err := r.hostCall(hostCallRequest{Method: "GET", Path: path, Headers: map[string]string{"accept": "application/json"}})
	if err != nil {
		return nil, err
	}
	if response.Status >= 400 {
		return nil, fmt.Errorf("TMDB 搜索失败 HTTP %d", response.Status)
	}
	body, err := decodeBody(response)
	if err != nil {
		return nil, err
	}
	var out tmdbSearchResult
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func normalizeTitle(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer("（", "(", "）", ")", "：", ":", "·", " ", "，", ",", "。", "", "！", "", "？", "").Replace(s)
	return s
}

// matchTMDB 返回最佳候选、显示标题、年份与置信度（0..1）。
func matchTMDB(res *tmdbSearchResult, query, wantType string) (TmdbItem, float64) {
	if res == nil || len(res.Results) == 0 {
		return TmdbItem{}, 0
	}
	q := normalizeTitle(query)
	best := res.Results[0]
	bestScore := -1.0
	for _, it := range res.Results {
		score := 0.0
		titles := []string{it.Title, it.Name, it.OriginalTitle, it.OriginalName}
		matchAny := false
		for _, t := range titles {
			tn := normalizeTitle(t)
			if tn == q {
				score += 0.7
				matchAny = true
			} else if tn != "" && (strings.Contains(tn, q) || strings.Contains(q, tn)) {
				score += 0.4
				matchAny = true
			}
		}
		if !matchAny {
			continue
		}
		if wantType != "" && it.MediaType == wantType {
			score += 0.25
		}
		if it.VoteAverage >= 6 {
			score += 0.05
		}
		if score > bestScore {
			bestScore = score
			best = it
		}
	}
	if bestScore < 0 {
		bestScore = 0
	}
	return best, bestScore
}

func tmdbTitle(it TmdbItem) string {
	if it.Title != "" {
		return it.Title
	}
	return it.Name
}

func tmdbYear(it TmdbItem) string {
	if len(it.ReleaseDate) >= 4 {
		return it.ReleaseDate[:4]
	}
	if len(it.FirstAirDate) >= 4 {
		return it.FirstAirDate[:4]
	}
	return ""
}

// ---------------------------------------------------------------------------
// 订阅
// ---------------------------------------------------------------------------

type poolIntentCreateRequest struct {
	TmdbID           int      `json:"tmdb_id"`
	MediaType        string   `json:"media_type"`
	Season           int      `json:"season"`
	Title            string   `json:"title"`
	Year             string   `json:"year,omitempty"`
	PosterPath       string   `json:"poster_path,omitempty"`
	BackdropPath     string   `json:"backdrop_path,omitempty"`
	EnabledSources   []string `json:"enabled_sources,omitempty"`
	EpisodeScopeMode string   `json:"episode_scope_mode"`
}

type poolIntentResult struct {
	Code string `json:"code"`
	Data struct {
		ID int64 `json:"id"`
	} `json:"data"`
}

type poolIntentListResult struct {
	Code string `json:"code"`
	Data []struct {
		ID        int64  `json:"id"`
		TmdbID    int    `json:"tmdb_id"`
		MediaType string `json:"media_type"`
		Title     string `json:"title"`
		State     string `json:"state"`
	} `json:"data"`
}

func (r *runtime) hostIntentExists(tmdbID int, mediaType string) (bool, int64) {
	response, err := r.hostCall(hostCallRequest{Method: "GET", Path: "/api/subscribe/pool/intents?limit=200", Headers: map[string]string{"accept": "application/json"}})
	if err != nil || response.Status >= 400 {
		return false, 0
	}
	body, err := decodeBody(response)
	if err != nil {
		return false, 0
	}
	var out poolIntentListResult
	if err := json.Unmarshal(body, &out); err != nil {
		return false, 0
	}
	for _, it := range out.Data {
		if it.TmdbID == tmdbID && (mediaType == "" || it.MediaType == mediaType) {
			return true, it.ID
		}
	}
	return false, 0
}

func (r *runtime) createSubscription(invocationID string, item TmdbItem, wantType, title, year string) (int64, error) {
	if item.ID == 0 {
		return 0, errors.New("TMDB 条目无效")
	}
	season := 1
	if item.MediaType == "movie" || wantType == "movie" {
		season = 0
	}
	body := poolIntentCreateRequest{
		TmdbID:           item.ID,
		MediaType:        item.MediaType,
		Season:           season,
		Title:            title,
		Year:             year,
		PosterPath:       item.PosterPath,
		BackdropPath:     item.BackdropPath,
		EnabledSources:   r.settings.SubscribeSources,
		EpisodeScopeMode: "follow",
	}
	if body.MediaType == "" {
		body.MediaType = wantType
	}
	raw, _ := json.Marshal(body)
	headers := map[string]string{
		"content-type":    "application/json",
		"accept":          "application/json",
		"idempotency-key": "dc-sub-" + safeKey(invocationID) + "-" + strconv.Itoa(item.ID),
	}
	response, err := r.hostCall(hostCallRequest{Method: "POST", Path: "/api/subscribe/pool/intents", Headers: headers, BodyBase64: base64.RawStdEncoding.EncodeToString(raw)})
	if err != nil {
		return 0, err
	}
	if response.Status >= 400 {
		return 0, fmt.Errorf("创建订阅失败 HTTP %d", response.Status)
	}
	bodyBytes, err := decodeBody(response)
	if err != nil {
		return 0, err
	}
	var out poolIntentResult
	if err := json.Unmarshal(bodyBytes, &out); err != nil {
		return 0, err
	}
	if out.Code != "ok" {
		return 0, fmt.Errorf("创建订阅返回异常 code=%q", out.Code)
	}
	return out.Data.ID, nil
}

func safeKey(s string) string {
	if s == "" {
		return "unknown"
	}
	var b strings.Builder
	for _, c := range s {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			b.WriteRune(c)
		}
	}
	if b.Len() == 0 {
		return "unknown"
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 持久化辅助
// ---------------------------------------------------------------------------

func loadJSON(path string, target any) {
	if raw, ok := wasmStorageGet(pathToKey(path)); ok {
		_ = safeUnmarshal(raw, target)
	}
}

func saveJSON(path string, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	_ = wasmStoragePut(pathToKey(path), data)
}

func pathToKey(path string) string {
	path = strings.TrimPrefix(path, "/")
	path = strings.TrimPrefix(path, ".data/")
	return strings.TrimSuffix(path, ".json")
}

// ---------------------------------------------------------------------------
// 核心业务
// ---------------------------------------------------------------------------

func (r *runtime) log(level, message string) {
	// 单条日志截断: 上游错误串可能带上整个响应体, 不截断会让 logs 累积成 MB 级对象。
	if len(message) > logMessageLimit {
		cut := message[:logMessageLimit]
		for len(cut) > 0 && !utf8.ValidString(cut) {
			cut = cut[:len(cut)-1]
		}
		message = cut + "…(截断)"
	}
	r.mu.Lock()
	r.logs = append(r.logs, LogEntry{At: r.now(), Level: level, Message: message})
	if max := r.settings.MaxLogs; max > 0 && len(r.logs) > max {
		r.logs = r.logs[len(r.logs)-max:]
	}
	r.revision++
	r.mu.Unlock()
}

// trace 写一条极轻量的诊断面包屑(单键覆盖写)。
// 宿主若在某次 host.call 期间直接杀掉 worker(不留 panic 输出), 事后仍可从
// plugin_kv 的 diag 键看出最后成功执行到哪一步。
func (r *runtime) trace(step string) {
	payload, err := json.Marshal(map[string]string{"at": r.now(), "step": step})
	if err != nil {
		return
	}
	_ = wasmStoragePut("diag", payload)
}

func (r *runtime) addHistory(entry HistoryEntry) {
	r.mu.Lock()
	entry.CreatedAt = r.now()
	r.history = append([]HistoryEntry{entry}, r.history...)
	if max := r.settings.MaxHistory; max > 0 && len(r.history) > max {
		r.history = r.history[:max]
	}
	if entry.Result == "succeeded" && entry.Action == "subscribe" {
		r.stats.Total++
		month := time.Now().Format("2006-01")
		if r.stats.Month != month {
			r.stats.Month = month
			r.stats.MonthNew = 0
		}
		r.stats.MonthNew++
		if r.stats.ByList == nil {
			r.stats.ByList = map[string]int{}
		}
		r.stats.ByList[entry.List]++
	}
	r.revision++
	r.mu.Unlock()
}

func (r *runtime) addHistoryAndLog(entry HistoryEntry, logMsg string) {
	r.addHistory(entry)
	r.log("info", logMsg)
}

// refreshNow 执行一次完整刷新+订阅流程。
func (r *runtime) refreshNow(invocationID string) error {
	r.mu.Lock()
	if r.refreshing {
		r.mu.Unlock()
		return errors.New("榜单刷新正在进行中")
	}
	r.refreshing = true
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.refreshing = false
		r.mu.Unlock()
	}()
	r.mu.Lock()
	settings := cloneSettings(r.settings)
	r.mu.Unlock()

	// 面包屑: 每步单独落盘一个 diag 键。宿主若在某次 host.call 期间直接终止 worker
	// (无 panic 输出), 也能从 plugin_kv.diag 看出最后成功的一步。
	r.trace("refresh:start")

	// 宿主用 wazero 解释器托管模块, 每次 host.call 都要走一次真实网络/编解码,
	// 因此刷新路径上不做多余的探测请求, 只保留必要的抓取。

	// 1. 串行抓取各榜单(wasip1 单线程, 避免 goroutine+host_call 风险)
	type listResult struct {
		key   string
		items []ChartItem
		err   error
	}
	// 按抓取成本排序: 便宜的 JSON 榜单先抓, 昂贵的 HTML 大页面放最后,
	// 这样一旦时间预算不够, 牺牲的也是最后那个而不是全部。
	keys := make([]string, 0, len(settings.Lists))
	for key, cfg := range settings.Lists {
		if cfg.Enabled {
			keys = append(keys, key)
		}
	}
	sort.SliceStable(keys, func(i, j int) bool {
		return sourceCost(settings.Lists[keys[i]].Source) < sourceCost(settings.Lists[keys[j]].Source)
	})

	// 宿主对前台动作只有约 10 秒(实测), 超过就强杀 worker; 留足余量后主动收尾。
	r.mu.Lock()
	budget := actionBudget
	if r.deepRefresh {
		budget = jobBudget
	}
	r.mu.Unlock()
	started := time.Now()

	results := []listResult{}
	for _, key := range keys {
		cfg := settings.Lists[key]
		used := time.Since(started)
		if used > budget {
			r.log("warning", fmt.Sprintf("本次已用 %d 秒, 跳过剩余榜单(下轮自动刷新会补齐)", int(used.Seconds())))
			break
		}
		r.log("info", "开始抓取榜单 "+key+" source="+cfg.Source)
		items, err := r.fetchList(key, cfg)
		if err != nil {
			r.log("warning", "榜单 "+key+" 抓取失败: "+err.Error())
		} else {
			r.log("info", fmt.Sprintf("榜单 %s 抓到 %d 条", key, len(items)))
		}
		results = append(results, listResult{key: key, items: items, err: err})
	}
	r.trace("lists:done")

	snapshot := Snapshot{FetchedAt: r.now(), Lists: map[string][]ChartItem{}}
	failures := []string{}
	for _, res := range results {
		if res.err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", res.key, res.err))
			r.log("warning", "榜单 "+res.key+" 抓取失败: "+res.err.Error())
			continue
		}
		snapshot.Lists[res.key] = res.items
	}

	r.mu.Lock()
	r.snapshot = snapshot
	r.lastRun = snapshot.FetchedAt
	r.mu.Unlock()

	// 2. 黑名单过滤 + 入观察队列
	r.filterAndEnqueue(snapshot, settings)

	// 3. 处理到期观察条目 -> 订阅
	subscribed, needsReview, errMsg := r.processDue(invocationID, settings)

	summary := fmt.Sprintf("榜单刷新完成：%d 榜，新增订阅 %d，待人工确认 %d", len(snapshot.Lists), subscribed, needsReview)
	if len(failures) > 0 {
		summary += "；失败榜：" + strings.Join(failures, "；")
	}
	if errMsg != "" {
		summary += "；" + errMsg
	}
	r.log("info", summary)
	r.bump("succeeded", summary)
	r.persistAll()
	return nil
}

func (r *runtime) filterAndEnqueue(snapshot Snapshot, settings Settings) {
	blacklist := settings.Blacklist
	hitKeywords := map[string]string{} // title -> keyword
	for _, item := range snapshot.Lists[listUpcoming] {
		checkItem(r, item, listUpcoming, blacklist, &hitKeywords)
	}
	for key := range snapshot.Lists {
		if key == listUpcoming {
			continue
		}
		for _, item := range snapshot.Lists[key] {
			checkItem(r, item, key, blacklist, &hitKeywords)
		}
	}
	r.mu.Lock()
	if len(hitKeywords) > 0 {
		r.blackState.Hits += len(hitKeywords)
		now := r.now()
		for title, kw := range hitKeywords {
			r.blackState.Recent = append([]BlackHit{{Title: title, Keyword: kw, At: now}}, r.blackState.Recent...)
			if len(r.blackState.Recent) > 20 {
				r.blackState.Recent = r.blackState.Recent[:20]
			}
		}
	}
	r.mu.Unlock()
}

func checkItem(r *runtime, item ChartItem, list string, blacklist []string, hits *map[string]string) {
	// 黑名单
	for _, kw := range blacklist {
		if kw != "" && strings.Contains(item.Title, kw) {
			(*hits)[item.Title] = kw
			return
		}
	}
	r.mu.Lock()
	// 已订阅（历史成功）或已在队列 -> 跳过
	for _, h := range r.history {
		if h.DoubanRef == item.DoubanRef && h.Result == "succeeded" && h.Action == "subscribe" {
			r.mu.Unlock()
			return
		}
	}
	for _, q := range r.queue.Items {
		if q.DoubanRef == item.DoubanRef {
			// 已存在：仅刷新热度，不重复入队
			r.mu.Unlock()
			return
		}
	}
	period := r.settings.ObservePeriodHours
	if period <= 0 {
		period = 24
	}
	due := time.Now().Add(time.Duration(period) * time.Hour)
	r.queue.Items = append(r.queue.Items, QueueItem{
		DoubanRef: item.DoubanRef,
		Title:     item.Title,
		List:      list,
		PosterURL: item.PosterURL,
		URL:       item.URL,
		EnteredAt: r.now(),
		DueAt:     due.Format(time.RFC3339),
		State:     "observing",
	})
	r.mu.Unlock()
}

// processDue 处理到期条目：TMDB 匹配 -> 创建聚合订阅。
func (r *runtime) processDue(invocationID string, settings Settings) (subscribed, needsReview int, errMsg string) {
	now := time.Now()
	r.mu.Lock()
	due := []QueueItem{}
	keep := []QueueItem{}
	for _, q := range r.queue.Items {
		dueAt, err := time.Parse(time.RFC3339, q.DueAt)
		if q.State == "needs_review" {
			keep = append(keep, q)
			continue
		}
		if err == nil && dueAt.After(now) {
			keep = append(keep, q)
			continue
		}
		due = append(due, q)
	}
	r.mu.Unlock()

	for _, q := range due {
		status, intentID, msg := r.subscribeQueueItem(invocationID, q, settings)
		switch status {
		case "succeeded":
			subscribed++
		case "needs_review":
			needsReview++
		}
		if status == "succeeded" || status == "needs_review" {
			_ = intentID
			continue
		}
		// failed 且未达重试上限 -> 保留为 needs_review
		if q.Attempt < 3 {
			q.State = "needs_review"
			q.LastError = msg
			keep = append(keep, q)
			needsReview++
		} else {
			r.addHistory(HistoryEntry{
				DoubanRef: q.DoubanRef, Title: q.Title, List: q.List, Action: "subscribe",
				Result: "failed", Message: msg, TmdbRef: q.TmdbRef,
			})
		}
	}
	r.mu.Lock()
	r.queue.Items = keep
	r.mu.Unlock()
	return subscribed, needsReview, ""
}

// subscribeQueueItem 匹配并订阅单个队列条目，返回 status: succeeded|needs_review|failed。
func (r *runtime) subscribeQueueItem(invocationID string, q QueueItem, settings Settings) (string, int64, string) {
	res, err := r.tmdbSearch(q.Title)
	if err != nil {
		return "failed", 0, "TMDB 搜索失败: " + err.Error()
	}
	item, confidence := matchTMDB(res, q.Title, "")
	if confidence < 0.5 || item.ID == 0 {
		return "needs_review", 0, fmt.Sprintf("TMDB 匹配置信不足 (%.2f)", confidence)
	}
	return r.doSubscribe(invocationID, q, item, settings)
}

func (r *runtime) doSubscribe(invocationID string, q QueueItem, item TmdbItem, settings Settings) (string, int64, string) {
	// 宿主侧去重
	if exists, id := r.hostIntentExists(item.ID, item.MediaType); exists {
		r.mu.Lock()
		for i := range r.queue.Items {
			if r.queue.Items[i].DoubanRef == q.DoubanRef {
				r.queue.Items[i].State = "subscribed"
				r.queue.Items[i].TmdbRef = fmt.Sprintf("tmdb:%s:%d", item.MediaType, item.ID)
			}
		}
		r.mu.Unlock()
		r.addHistoryAndLog(HistoryEntry{
			DoubanRef: q.DoubanRef, TmdbRef: fmt.Sprintf("tmdb:%s:%d", item.MediaType, item.ID),
			Title: q.Title, List: q.List, Action: "subscribe", Result: "succeeded",
			Message: "已存在同类聚合订阅，跳过重复创建", IntentID: id,
		}, "已存在订阅，跳过："+q.Title)
		return "succeeded", id, ""
	}
	title := tmdbTitle(item)
	year := tmdbYear(item)
	intentID, err := r.createSubscription(invocationID, item, "", title, year)
	if err != nil {
		return "failed", 0, "创建聚合订阅失败: " + err.Error()
	}
	entry := HistoryEntry{
		DoubanRef: q.DoubanRef, TmdbRef: fmt.Sprintf("tmdb:%s:%d", item.MediaType, item.ID),
		Title: q.Title, List: q.List, Action: "subscribe", Result: "succeeded",
		Message: "订阅成功", IntentID: intentID,
	}
	r.addHistoryAndLog(entry, "已创建聚合订阅："+q.Title)
	r.mu.Lock()
	for i := range r.queue.Items {
		if r.queue.Items[i].DoubanRef == q.DoubanRef {
			r.queue.Items[i].State = "subscribed"
			r.queue.Items[i].TmdbRef = entry.TmdbRef
			r.queue.Items[i].MediaType = item.MediaType
			r.queue.Items[i].Year = year
			r.queue.Items[i].PosterPath = item.PosterPath
		}
	}
	r.mu.Unlock()
	// 通知功能已停用（宿主 /api/notifications/plugin 拒绝所有插件通知 payload，v3.8.93 宿主侧限制）
	return "succeeded", intentID, ""
}

func posterURL(path string) string {
	if path == "" {
		return ""
	}
	return "https://image.tmdb.org/t/p/w500" + path
}

func listLabel(key string) string {
	switch key {
	case listUpcoming:
		return "即将上映"
	case listHot:
		return "实时热门"
	case listCNWom:
		return "华语口碑"
	case listGlobalWom:
		return "全球口碑"
	case listMovieWom:
		return "电影口碑"
	}
	return key
}

// ---------------------------------------------------------------------------
// 运行时协议处理
// ---------------------------------------------------------------------------

func (r *runtime) handle(message rpcMessage) (any, *rpcError, bool) {
	switch message.Method {
	case "runtime.initialize":
		var input struct {
			Protocol string `json:"protocol"`
		}
		if json.Unmarshal(message.Params, &input) != nil || input.Protocol != protocol {
			return nil, &rpcError{Code: -32602, Message: "unsupported process protocol"}, false
		}
		r.loadAll()
		return map[string]any{"ready": true, "protocol": protocol}, nil, false
	case "runtime.invoke":
		var input invokeParams
		if json.Unmarshal(message.Params, &input) != nil || input.Envelope.Op == "" || input.Envelope.InvocationID == "" {
			return nil, &rpcError{Code: -32602, Message: "invalid runtime.invoke params"}, false
		}
		result, err := r.invoke(input)
		if err != nil {
			return nil, &rpcError{Code: -32602, Message: err.Error()}, false
		}
		return result, nil, false
	case "runtime.shutdown":
		r.persistAll()
		return map[string]any{"stopping": true}, nil, true
	default:
		return nil, &rpcError{Code: -32601, Message: "method not found"}, false
	}
}

func (r *runtime) invoke(input invokeParams) (any, error) {
	switch input.Envelope.Op {
	case "state":
		return r.stateResult(input.Envelope.Payload)
	case "action":
		return r.action(input.Envelope.InvocationID, input.Envelope.Payload)
	case "job":
		return r.job(input.Envelope.InvocationID, input.Envelope.Payload)
	case "event":
		return r.event(input.Envelope.Payload)
	default:
		return nil, fmt.Errorf("unsupported invocation op %q", input.Envelope.Op)
	}
}

func (r *runtime) stateResult(raw json.RawMessage) (any, error) {
	var payload struct {
		View        string `json:"view"`
		IfNoneMatch string `json:"if_none_match"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return nil, errors.New("invalid state payload")
	}
	r.mu.Lock()
	revision := r.revision
	status := r.lastStatus
	message := r.lastMessage
	lastRun := r.lastRun
	settings := cloneSettings(r.settings)
	snapshot := cloneSnapshot(r.snapshot)
	queue := cloneQueue(r.queue)
	history := make([]HistoryEntry, len(r.history))
	copy(history, r.history)
	logs := make([]LogEntry, len(r.logs))
	copy(logs, r.logs)
	stats := r.stats
	black := r.blackState
	r.mu.Unlock()

	if len(history) > 30 {
		history = history[:30]
	}
	if len(logs) > 50 {
		logs = logs[:50]
	}
	state := map[string]any{
		"status":       status,
		"last_message": message,
		"last_run":     lastRun,
		"revision":     revision,
		"snapshot":     snapshot,
		"blacklist":    black,
		"observe_queue": map[string]any{
			"items": queue.Items,
		},
		"history":  history,
		"logs":     logs,
		"stats":    stats,
		"settings": settings,
	}
	version := fmt.Sprintf("state-v%d", revision)
	etag := `"` + version + `"`
	if payload.IfNoneMatch == etag {
		return map[string]any{"not_modified": true, "etag": etag}, nil
	}
	// 序列化后按普通 JSON 值净化，避免结构体字段中的绝对路径字符串混入响应
	stateRaw, _ := json.Marshal(state)
	var sanitized any
	_ = json.Unmarshal(stateRaw, &sanitized)
	return map[string]any{"state_version": version, "etag": etag, "state": sanitizeState(sanitized)}, nil
}

// sanitizeState 递归清除任何被宿主判定为“绝对路径”的字符串（如 douban 相对
// 封面 /pXXX.jpg），避免宿主安全过滤以 502 拒绝整个 state 响应。
func sanitizeState(v any) any {
	switch t := v.(type) {
	case string:
		if looksLikeAbsPath(t) {
			return ""
		}
		return t
	case []any:
		for i := range t {
			t[i] = sanitizeState(t[i])
		}
		return t
	case map[string]any:
		for k := range t {
			t[k] = sanitizeState(t[k])
		}
		return t
	default:
		return v
	}
}

func looksLikeAbsPath(s string) bool {
	if len(s) < 2 || s[0] != '/' {
		return false
	}
	if strings.HasPrefix(s, "//") {
		return false // 协议相对 URL（//host/...）
	}
	// Windows 盘符：C:/ 或 C:\
	if len(s) >= 3 && s[1] == ':' && (s[2] == '/' || s[2] == '\\') {
		return true
	}
	// 其余以单斜杠开头的字符串一律视为绝对路径
	return true
}

func (r *runtime) action(invocationID string, raw json.RawMessage) (any, error) {
	var payload struct {
		ID    string          `json:"id"`
		Input json.RawMessage `json:"input"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.ID == "" {
		return nil, errors.New("invalid action payload")
	}
	var input map[string]any
	_ = json.Unmarshal(payload.Input, &input)
	switch payload.ID {
	case "refresh":
		// wasip1 单线程: 不能用 goroutine 异步(模块返回后 goroutine 不再被调度), 同步执行
		if err := r.refreshNow(invocationID); err != nil {
			r.log("error", "手动刷新失败: "+err.Error())
			r.bump("failed", "手动刷新失败: "+err.Error())
			return map[string]any{"status": "failed", "message": "手动刷新失败: " + err.Error()}, nil
		}
		return map[string]any{"status": "succeeded", "message": "榜单刷新完成"}, nil
	case "subscribe":
		doubanRef, _ := input["douban_ref"].(string)
		if doubanRef == "" {
			return map[string]any{"status": "failed", "message": "缺少 douban_ref"}, nil
		}
		return r.subscribeFromSnapshot(invocationID, doubanRef)
	case "subscribe-now":
		doubanRef, _ := input["douban_ref"].(string)
		if doubanRef == "" {
			return map[string]any{"status": "failed", "message": "缺少 douban_ref"}, nil
		}
		return r.subscribeQueueNow(invocationID, doubanRef)
	case "observe-remove":
		doubanRef, _ := input["douban_ref"].(string)
		r.mu.Lock()
		kept := r.queue.Items[:0]
		for _, q := range r.queue.Items {
			if q.DoubanRef != doubanRef {
				kept = append(kept, q)
			}
		}
		r.queue.Items = kept
		r.mu.Unlock()
		r.persistAll()
		r.bump("succeeded", "已从观察队列移除")
		return map[string]any{"status": "succeeded", "message": "已从观察队列移除"}, nil
	case "blacklist-add":
		keyword := strings.TrimSpace(stringVal(input["keyword"]))
		if keyword == "" {
			return map[string]any{"status": "failed", "message": "关键词不能为空"}, nil
		}
		r.mu.Lock()
		for _, k := range r.settings.Blacklist {
			if k == keyword {
				r.mu.Unlock()
				return map[string]any{"status": "succeeded", "message": "关键词已存在"}, nil
			}
		}
		r.settings.Blacklist = append(r.settings.Blacklist, keyword)
		r.mu.Unlock()
		r.persistAll()
		r.bump("succeeded", "已添加黑名单关键词："+keyword)
		return map[string]any{"status": "succeeded", "message": "已添加黑名单关键词：" + keyword}, nil
	case "blacklist-remove":
		keyword := strings.TrimSpace(stringVal(input["keyword"]))
		r.mu.Lock()
		kept := r.settings.Blacklist[:0]
		for _, k := range r.settings.Blacklist {
			if k != keyword {
				kept = append(kept, k)
			}
		}
		r.settings.Blacklist = kept
		r.mu.Unlock()
		r.persistAll()
		r.bump("succeeded", "已移除黑名单关键词："+keyword)
		return map[string]any{"status": "succeeded", "message": "已移除黑名单关键词：" + keyword}, nil
	case "settings-update":
		return r.settingsUpdate(input)
	case "archive":
		return r.archive()
	case "open-source":
		doubanRef, _ := input["douban_ref"].(string)
		url := r.findSourceURL(doubanRef)
		if url == "" {
			return map[string]any{"status": "failed", "message": "未找到对应豆瓣条目"}, nil
		}
		return map[string]any{"status": "succeeded", "message": "豆瓣来源已生成", "url": url}, nil
	case "send-test":
		// 通知功能已停用：宿主 /api/notifications/plugin 拒绝所有插件通知 payload（宿主侧限制）。
		// 仅返回提示，不再调用宿主通知接口。
		return map[string]any{"status": "skipped", "message": "通知功能已停用（宿主通知通道不可用），不会发送 Telegram 消息"}, nil
	case "get-poster":
		return r.getPoster(input)
	default:
		return map[string]any{"status": "failed", "code": "unknown_action", "message": "未知动作"}, nil
	}
}

// ---------------------------------------------------------------------------
// 通知功能已停用（宿主 /api/notifications/plugin 拒绝所有插件通知 payload，宿主侧限制）
// ---------------------------------------------------------------------------

func (r *runtime) subscribeFromSnapshot(invocationID, doubanRef string) (any, error) {
	r.mu.Lock()
	var found *ChartItem
	for _, items := range r.snapshot.Lists {
		for i := range items {
			if items[i].DoubanRef == doubanRef {
				it := items[i]
				found = &it
				break
			}
		}
		if found != nil {
			break
		}
	}
	settings := cloneSettings(r.settings)
	r.mu.Unlock()
	if found == nil {
		return map[string]any{"status": "failed", "message": "榜单快照中未找到该条目"}, nil
	}
	res, err := r.tmdbSearch(found.Title)
	if err != nil {
		return map[string]any{"status": "failed", "message": "TMDB 搜索失败: " + err.Error()}, nil
	}
	item, confidence := matchTMDB(res, found.Title, "")
	if confidence < 0.5 || item.ID == 0 {
		return map[string]any{"status": "failed", "message": fmt.Sprintf("TMDB 匹配置信不足 (%.2f)，无法自动订阅", confidence)}, nil
	}
	q := QueueItem{DoubanRef: found.DoubanRef, Title: found.Title, URL: found.URL}
	status, intentID, msg := r.doSubscribe(invocationID, q, item, settings)
	if status == "succeeded" {
		r.mu.Lock()
		for i := range r.queue.Items {
			if r.queue.Items[i].DoubanRef == q.DoubanRef {
				r.queue.Items[i].State = "subscribed"
			}
		}
		r.mu.Unlock()
		r.persistAll()
		return map[string]any{"status": "succeeded", "message": "订阅成功", "intent_id": intentID}, nil
	}
	r.addHistoryAndLog(HistoryEntry{
		DoubanRef: q.DoubanRef, Title: q.Title, List: q.List, Action: "subscribe", Result: "failed",
		Message: msg,
	}, "订阅失败："+q.Title+" ("+msg+")")
	r.persistAll()
	return map[string]any{"status": "failed", "message": msg}, nil
}

func (r *runtime) subscribeQueueNow(invocationID, doubanRef string) (any, error) {
	r.mu.Lock()
	var q *QueueItem
	for i := range r.queue.Items {
		if r.queue.Items[i].DoubanRef == doubanRef {
			q = &r.queue.Items[i]
			break
		}
	}
	settings := cloneSettings(r.settings)
	r.mu.Unlock()
	if q == nil {
		return map[string]any{"status": "failed", "message": "观察队列中未找到该条目"}, nil
	}
	status, intentID, msg := r.subscribeQueueItem(invocationID, *q, settings)
	if status == "succeeded" {
		r.mu.Lock()
		for i := range r.queue.Items {
			if r.queue.Items[i].DoubanRef == doubanRef {
				r.queue.Items[i].State = "subscribed"
			}
		}
		r.mu.Unlock()
		r.persistAll()
		return map[string]any{"status": "succeeded", "message": "订阅成功", "intent_id": intentID}, nil
	}
	if status == "needs_review" {
		r.addHistoryAndLog(HistoryEntry{
			DoubanRef: q.DoubanRef, Title: q.Title, List: q.List, Action: "subscribe", Result: "needs_review",
			Message: msg,
		}, "TMDB 匹配待确认："+q.Title+" ("+msg+")")
		r.mu.Lock()
		for i := range r.queue.Items {
			if r.queue.Items[i].DoubanRef == doubanRef {
				r.queue.Items[i].State = "needs_review"
				r.queue.Items[i].LastError = msg
			}
		}
		r.mu.Unlock()
		r.persistAll()
		return map[string]any{"status": "failed", "message": msg}, nil
	}
	r.addHistoryAndLog(HistoryEntry{
		DoubanRef: q.DoubanRef, Title: q.Title, List: q.List, Action: "subscribe", Result: "failed",
		Message: msg,
	}, "订阅失败："+q.Title+" ("+msg+")")
	r.persistAll()
	return map[string]any{"status": "failed", "message": msg}, nil
}

func (r *runtime) getPoster(input map[string]any) (any, error) {
	posterURL := strings.TrimSpace(stringVal(input["poster_url"]))
	if posterURL == "" {
		return map[string]any{"status": "failed", "message": "缺少 poster_url"}, nil
	}
	if !strings.HasPrefix(posterURL, "https://") && !strings.HasPrefix(posterURL, "http://") {
		return map[string]any{"status": "failed", "message": "非法的海报地址"}, nil
	}
	r.mu.Lock()
	if cached, ok := r.posterCache[posterURL]; ok {
		r.mu.Unlock()
		return map[string]any{"status": "succeeded", "url": cached}, nil
	}
	r.mu.Unlock()

	// 豆瓣图片 CDN 防盗链，Referer 已由 httpGet 附带。
	// 豆瓣海报 CDN 是镜像集群：同一图片可在 img1~img9.doubanio.com 任一域名访问。
	// 宿主网络对个别 imgN 域名会返回非图片内容（拦截页），因此失败时依次回退其他镜像域名。
	// 候选顺序：原域名 → img3 → img1 → img2 → img4 → img5 → img6 → img7 → img8 → img9
	var posterHostRe = regexp.MustCompile(`(https?://)(img\d+)\.(doubanio\.com/)`)
	candidates := []string{""}
	if m := posterHostRe.FindStringSubmatch(posterURL); len(m) == 4 {
		seen := map[string]bool{m[2]: true}
		for _, alt := range []string{"img3", "img1", "img2", "img4", "img5", "img6", "img7", "img8", "img9"} {
			if !seen[alt] {
				candidates = append(candidates, alt)
				seen[alt] = true
			}
		}
	}
	var lastErr string
	for _, alt := range candidates {
		u := posterURL
		if alt != "" {
			u = posterHostRe.ReplaceAllString(posterURL, "${1}"+alt+".${3}")
		}
		// 单个候选做有限次重试，容忍间歇性限流
		for attempt := 0; attempt < 2; attempt++ {
			if attempt > 0 {
				time.Sleep(200 * time.Millisecond)
			}
			body, status, err := r.httpGet(u, "image/avif,image/webp,image/jpeg,image/*;q=0.8")
			if err != nil {
				lastErr = fmt.Sprintf("HTTP %d", status)
				continue
			}
			mime := http.DetectContentType(body)
			if !strings.HasPrefix(mime, "image/") {
				lastErr = fmt.Sprintf("非图片内容(mime=%s, %dB)", mime, len(body))
				continue
			}
			dataURL := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(body)
			r.mu.Lock()
			// 缓存上限保护: 每张海报 data URL 可达上百 KB, 上限过大会把堆顶到内存硬限额。
			if len(r.posterCache) > posterCacheLimit {
				r.posterCache = map[string]string{}
			}
			r.posterCache[posterURL] = dataURL
			r.mu.Unlock()
			return map[string]any{"status": "succeeded", "url": dataURL}, nil
		}
	}
	return map[string]any{"status": "failed", "message": "海报抓取失败: " + lastErr}, nil
}

func (r *runtime) settingsUpdate(input map[string]any) (any, error) {
	r.mu.Lock()
	old := r.settings
	r.mu.Unlock()
	raw, _ := json.Marshal(input)
	var patch map[string]any
	_ = json.Unmarshal(raw, &patch)

	if v, ok := patch["lists"]; ok {
		rawList, _ := json.Marshal(v)
		var lists map[string]ListConfig
		if json.Unmarshal(rawList, &lists) == nil && lists != nil {
			old.Lists = lists
		}
	}
	if v, ok := patch["blacklist"]; ok {
		rawList, _ := json.Marshal(v)
		var bl []string
		if json.Unmarshal(rawList, &bl) == nil {
			old.Blacklist = bl
		}
	}
	if v, ok := patch["observe_period_hours"]; ok {
		if n, e := v.(float64); e {
			old.ObservePeriodHours = int(n)
		}
	}
	if v, ok := patch["auto_subscribe"]; ok {
		if b, e := v.(bool); e {
			old.AutoSubscribe = b
		}
	}
	if v, ok := patch["notify_on_subscribe"]; ok {
		if b, e := v.(bool); e {
			old.NotifyOnSubscribe = b
		}
	}
	if v, ok := patch["subscribe_source_filter"]; ok {
		rawList, _ := json.Marshal(v)
		var src []string
		if json.Unmarshal(rawList, &src) == nil {
			old.SubscribeSources = src
		}
	}
	r.mu.Lock()
	r.settings = old
	r.normalizeSettingsLocked()
	r.mu.Unlock()
	r.persistAll()
	r.bump("succeeded", "设置已保存")
	return map[string]any{"status": "succeeded", "message": "设置已保存"}, nil
}

func (r *runtime) archive() (any, error) {
	r.mu.Lock()
	r.history = nil
	r.logs = nil
	r.blackState = BlackState{Keywords: r.blackState.Keywords}
	r.stats = Stats{ByList: map[string]int{}, LastArchiveAt: r.now()}
	r.mu.Unlock()
	r.persistAll()
	r.bump("succeeded", "已归档历史与日志")
	return map[string]any{"status": "succeeded", "message": "已归档历史与日志"}, nil
}

func (r *runtime) findSourceURL(doubanRef string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, items := range r.snapshot.Lists {
		for _, it := range items {
			if it.DoubanRef == doubanRef {
				return it.URL
			}
		}
	}
	for _, q := range r.queue.Items {
		if q.DoubanRef == doubanRef {
			return q.URL
		}
	}
	return ""
}

func (r *runtime) job(invocationID string, raw json.RawMessage) (any, error) {
	r.mu.Lock()
	r.deepRefresh = true // 后台任务预算 600s, 允许补海报
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.deepRefresh = false
		r.mu.Unlock()
	}()
	var payload struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.ID != "refresh-charts" {
		return map[string]any{"status": "skipped", "message": "未声明的任务"}, nil
	}
	if err := r.refreshNow(invocationID); err != nil {
		r.log("error", "定时刷新失败: "+err.Error())
		r.bump("failed", "定时刷新失败: "+err.Error())
		return map[string]any{"status": "skipped", "message": "定时刷新失败: " + err.Error()}, nil
	}
	return map[string]any{"status": "accepted", "message": "榜单定时刷新完成"}, nil
}

func (r *runtime) event(raw json.RawMessage) (any, error) {
	var payload struct {
		Topic string          `json:"topic"`
		Data  json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.Topic == "" {
		return nil, errors.New("invalid event payload")
	}
	return map[string]any{"accepted": true}, nil
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

func cloneSettings(s Settings) Settings {
	out := s
	out.Lists = map[string]ListConfig{}
	for k, v := range s.Lists {
		out.Lists[k] = v
	}
	out.Blacklist = append([]string(nil), s.Blacklist...)
	out.SubscribeSources = append([]string(nil), s.SubscribeSources...)
	return out
}

func cloneSnapshot(s Snapshot) Snapshot {
	out := Snapshot{FetchedAt: s.FetchedAt, Lists: map[string][]ChartItem{}}
	for k, v := range s.Lists {
		out.Lists[k] = append([]ChartItem(nil), v...)
	}
	return out
}

func cloneQueue(q Queue) Queue {
	return Queue{Items: append([]QueueItem(nil), q.Items...)}
}

func stringVal(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

func defaultSettings() Settings {
	return Settings{
		Lists: map[string]ListConfig{
			listUpcoming:  {Source: "coming_html", Type: "movie", Limit: 20, Enabled: true},
			listHot:       {Source: "subjects_json", Type: "movie", Tag: "热门", Sort: "recommend", Limit: 30, Enabled: true},
			listCNWom:     {Source: "subjects_json", Type: "tv", Tag: "国产剧", Sort: "recommend", Limit: 30, Enabled: true},
			listGlobalWom: {Source: "subjects_json", Type: "movie", Tag: "欧美", Sort: "recommend", Limit: 30, Enabled: true},
			listMovieWom:  {Source: "chart_html", Type: "movie", Limit: 20, Enabled: true},
		},
		ObservePeriodHours: 24,
		AutoSubscribe:      true,
		NotifyOnSubscribe:  true,
		MaxHistory:         200,
		MaxLogs:            200,
	}
}

func decodeBody(response hostCallResponse) ([]byte, error) {
	if response.BodyBase64 == "" {
		return nil, nil
	}
	b, err := base64.RawStdEncoding.DecodeString(response.BodyBase64)
	if err != nil {
		b, err = base64.StdEncoding.DecodeString(response.BodyBase64)
		if err != nil {
			return nil, err
		}
	}
	return b, nil
}

func (r *runtime) hostCall(request hostCallRequest) (hostCallResponse, error) {
	return wasmHostCall(request)
}

// ---------------------------------------------------------------------------
// WASM 全局入口
// ---------------------------------------------------------------------------

var guestRT *runtime

func newRuntime() *runtime {
	// GC 软目标压在线性内存硬限额(manifest memory_mb = 256MiB)之下,
	// 让运行时在撞到 wasm 内存天花板之前就主动回收。
	debug.SetMemoryLimit(192 << 20)
	rt := &runtime{dataDir: ".data", posterCache: map[string]string{}}
	rt.loadAll()
	// 首次安装: 无保存配置时初始化默认榜单设置
	rt.mu.Lock()
	if rt.settings.Lists == nil {
		rt.settings = Settings{
			Lists: map[string]ListConfig{
				listUpcoming:  {Source: "coming_html", Type: "movie", Limit: 20, Enabled: true},
				listHot:       {Source: "subjects_json", Type: "movie", Tag: "热门", Sort: "recommend", Limit: 20, Enabled: true},
				listCNWom:     {Source: "subjects_json", Type: "movie", Tag: "华语", Sort: "recommend", Limit: 20, Enabled: false},
				listGlobalWom: {Source: "subjects_json", Type: "movie", Tag: "欧美", Sort: "recommend", Limit: 20, Enabled: false},
				listMovieWom:  {Source: "chart_html", Type: "movie", Limit: 20, Enabled: false},
			},
			Blacklist:          []string{},
			ObservePeriodHours: 24,
			AutoSubscribe:      true,
			NotifyOnSubscribe:  true,
			SubscribeSources:   []string{},
			MaxHistory:         200,
			MaxLogs:            500,
		}
		rt.normalizeSettingsLocked()
		rt.settings = rt.settings // no-op keep
		rt.mu.Unlock()
		rt.persistAll()
		rt.bump("succeeded", "初始化默认配置，点击「刷新」开始抓取豆瓣榜单")
	} else {
		rt.mu.Unlock()
	}
	return rt
}
func main() {}
