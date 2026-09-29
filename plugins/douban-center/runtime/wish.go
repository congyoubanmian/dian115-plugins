// 豆瓣「想看」同步: 从 CookieCloud 或手动粘贴的 cookie 拉取用户的
// kind=mark 列表(电影+剧集), 新条目直接走现有 TMDB 匹配 + 聚合订阅链路。

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type WishItem struct {
	DoubanRef string `json:"douban_ref"`
	Title     string `json:"title"`
	Year      string `json:"year"`
	Type      string `json:"type"` // movie | tv
	PosterURL string `json:"poster_url,omitempty"`
	AddedAt   string `json:"added_at,omitempty"`
}

type WishInfo struct {
	Enabled    bool   `json:"enabled"`
	LastSync   string `json:"last_sync"`
	LastCount  int    `json:"last_count"`
	LastNew    int    `json:"last_new"`
	LastStatus string `json:"last_status"`
	LastError  string `json:"last_error,omitempty"`
	UID        string `json:"uid,omitempty"`
	Source     string `json:"source,omitempty"` // cookiecloud | manual
}

// doubanCookie 解析豆瓣登录 cookie: 优先 CookieCloud, 失败回退手动粘贴。
// 返回 cookie 头和 uid(dbcl2 冒号前段)。
func (r *runtime) doubanCookie() (header, uid, source string, err error) {
	r.mu.Lock()
	s := cloneSettings(r.settings)
	r.mu.Unlock()
	if s.CookieCloudURL != "" && s.CookieCloudUUID != "" && s.CookieCloudKey != "" {
		data, perr := r.cookieCloudPull(s.CookieCloudURL, s.CookieCloudUUID, s.CookieCloudKey)
		if perr == nil {
			h, u, _ := doubanCookieFromCloud(data)
			if h != "" {
				return h, u, "cookiecloud", nil
			}
			return "", "", "cookiecloud", errors.New("CookieCloud 同步数据里没有豆瓣登录 cookie（浏览器需登录 douban.com）")
		}
		if s.ManualCookie == "" {
			return "", "", "", fmt.Errorf("CookieCloud 拉取失败: %w", perr)
		}
		// CookieCloud 失败但填了手动 cookie → 回退
		header, uid = parseManualCookie(s.ManualCookie)
		if header != "" {
			return header, uid, "manual", nil
		}
		return "", "", "", fmt.Errorf("CookieCloud 拉取失败: %v；手动 cookie 也无效", perr)
	}
	if s.ManualCookie != "" {
		header, uid = parseManualCookie(s.ManualCookie)
		if header != "" {
			return header, uid, "manual", nil
		}
		return "", "", "", errors.New("手动 cookie 里缺少 dbcl2")
	}
	return "", "", "", errors.New("未配置 CookieCloud 或手动豆瓣 cookie")
}

// parseManualCookie 接受整段 cookie 头或仅 dbcl2=xxx, 透传有效字段。
func parseManualCookie(raw string) (header, uid string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	if !strings.Contains(raw, "=") {
		return "", ""
	}
	dbcl2 := ""
	for _, part := range strings.Split(raw, ";") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		if kv[0] == "dbcl2" {
			dbcl2 = kv[1]
		}
	}
	if dbcl2 == "" {
		// 只给了 dbcl2 值本身(含冒号)
		return "", ""
	}
	uid = strings.SplitN(dbcl2, ":", 2)[0]
	return raw, uid
}

// wishFlexString: 豆瓣 rexxar 接口对 subject.id 时而给字符串时而给数字
// (实测想看接口给的是 "36808876" 字符串), 统一收成字符串。
type wishFlexString string

func (f *wishFlexString) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		*f = ""
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = wishFlexString(s)
		return nil
	}
	*f = wishFlexString(string(b))
	return nil
}

type wishInterest struct {
	Subject struct {
		ID     wishFlexString `json:"id"`
		Title  string         `json:"title"`
		Year   string         `json:"year"`
		Type   string         `json:"type"` // movie | tv | book | music ... 只收影视
		Pic    struct {
			Large string `json:"large"`
		} `json:"pic"`
	} `json:"subject"`
}

// fetchWish 拉取单类型想看列表(分页, 上限 wishPageLimit 页)。
func (r *runtime) fetchWish(header, uid, wantType string) ([]WishItem, error) {
	const pageSize = 50
	const maxPages = 4
	items := []WishItem{}
	for page := 0; page < maxPages; page++ {
		u := fmt.Sprintf("https://m.douban.com/rexxar/api/v2/user/%s/interests?kind=mark&type=%s&start=%d&limit=%d",
			uid, wantType, page*pageSize, pageSize)
		body, status, err := r.httpGetWithCookie(u, header)
		if err != nil {
			return nil, fmt.Errorf("HTTP %d: %w", status, err)
		}
		var res struct {
			Interests []wishInterest `json:"interests"`
			Total     int            `json:"total"`
		}
		if err := json.Unmarshal(body, &res); err != nil {
			return nil, fmt.Errorf("响应解析失败: %v", err)
		}
		items = append(items, wishItemsFromInterests(res.Interests)...)
		if len(res.Interests) < pageSize || len(items) >= res.Total {
			break
		}
	}
	return items, nil
}

// wishItemsFromInterests 把 rexxar 兴趣条目映射成 WishItem。
// 纯函数, 便于用真实响应样本做回归。
func wishItemsFromInterests(interests []wishInterest) []WishItem {
	items := []WishItem{}
	for _, it := range interests {
		id := strings.TrimSpace(string(it.Subject.ID))
		if id == "" {
			continue
		}
		// 只收影视条目: 豆瓣"想看"混着书/音乐(实测 type=tv 的响应里混进了
		// movie 和 book), 书目拿去 TMDB 匹配会订阅到同名电影。
		kind := it.Subject.Type
		if kind != "movie" && kind != "tv" {
			continue
		}
		items = append(items, WishItem{
			DoubanRef: id,
			Title:     it.Subject.Title,
			Year:      it.Subject.Year,
			PosterURL: it.Subject.Pic.Large,
			Type:      kind,
		})
	}
	return items
}

// syncWishList 全量同步想看: 新条目立即尝试订阅, 已处理的跳过。
func (r *runtime) syncWishList(invocationID string) {
	r.mu.Lock()
	s := cloneSettings(r.settings)
	info := r.wishInfo
	seen := r.wishSeen
	if seen == nil {
		seen = map[string]bool{}
	}
	r.mu.Unlock()
	if !s.WishSyncEnabled {
		return
	}

	header, uid, source, err := r.doubanCookie()
	if err != nil {
		info.LastStatus = "failed"
		info.LastError = err.Error()
		info.LastSync = r.now()
		r.mu.Lock()
		r.wishInfo = info
		r.mu.Unlock()
		r.log("warning", "想看同步跳过: "+err.Error())
		return
	}
	info.Enabled = true
	info.UID = uid
	info.Source = source
	info.LastError = ""

	all := []WishItem{}
	merged := map[string]bool{}
	for _, t := range []string{"movie", "tv"} {
		items, ferr := r.fetchWish(header, uid, t)
		if ferr != nil {
			info.LastStatus = "failed"
			info.LastError = t + " 拉取失败: " + ferr.Error()
			r.log("warning", "想看("+t+")拉取失败: "+ferr.Error())
			continue
		}
		// movie/tv 两个查询的响应会重叠(豆瓣对 type 过滤不严格), 按条目去重。
		for _, wi := range items {
			if merged[wi.DoubanRef] {
				continue
			}
			merged[wi.DoubanRef] = true
			wi.AddedAt = r.now()
			all = append(all, wi)
		}
	}
	if len(all) == 0 && info.LastStatus == "failed" {
		info.LastSync = r.now()
		r.mu.Lock()
		r.wishInfo = info
		r.mu.Unlock()
		r.persistAll()
		return
	}

	settings := s
	newCount := 0
	for _, wi := range all {
		if seen[wi.DoubanRef] {
			continue
		}
		newCount++
		seen[wi.DoubanRef] = true
		if settings.AutoSubscribe {
			q := QueueItem{
				DoubanRef: wi.DoubanRef, Title: wi.Title, List: "wish",
				PosterURL: wi.PosterURL, URL: "https://www.douban.com/subject/" + wi.DoubanRef + "/",
				EnteredAt: r.now(), State: "observing",
			}
			status, _, msg := r.subscribeQueueItem(invocationID, q, settings)
			_ = msg
			_ = status
		} else {
			// 未开自动订阅: 只进观察队列等人工处理
			r.mu.Lock()
			dup := false
			for _, e := range r.queue.Items {
				if e.DoubanRef == wi.DoubanRef {
					dup = true
					break
				}
			}
			if !dup {
				due := r.now()
				if t, err := time.Parse(time.RFC3339, due); err == nil {
					due = t.Add(time.Duration(settings.ObservePeriodHours) * time.Hour).Format(time.RFC3339)
				}
				r.queue.Items = append(r.queue.Items, QueueItem{
					DoubanRef: wi.DoubanRef, Title: wi.Title, List: "wish",
					PosterURL: wi.PosterURL, URL: "https://www.douban.com/subject/" + wi.DoubanRef + "/",
					EnteredAt: r.now(), DueAt: due, State: "observing",
				})
			}
			r.mu.Unlock()
		}
	}

	info.LastSync = r.now()
	info.LastCount = len(all)
	info.LastNew = newCount
	info.LastStatus = "succeeded"
	r.mu.Lock()
	r.wish = all
	r.wishSeen = seen
	r.wishInfo = info
	r.revision++
	r.mu.Unlock()
	if newCount > 0 {
		r.log("info", fmt.Sprintf("想看同步完成: 共 %d 条, 新增 %d (已%s)", len(all), newCount, map[bool]string{true: "自动订阅", false: "入观察队列"}[settings.AutoSubscribe]))
	}
}

// httpGetWithCookie 带 cookie 的豆瓣请求(m.douban.com 接口要求登录态)。
func (r *runtime) httpGetWithCookie(fullURL, cookie string) ([]byte, int, error) {
	response, err := r.hostCall(hostCallRequest{
		Method: "GET",
		Path:   fullURL,
		Headers: map[string]string{
			"accept":     "application/json",
			"user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
			"referer":    "https://m.douban.com/mine/wish/",
			"cookie":     cookie,
		},
	})
	if err != nil {
		return nil, 0, err
	}
	body, derr := decodeBody(response)
	if response.Status >= 400 {
		return nil, response.Status, fmt.Errorf("HTTP %d", response.Status)
	}
	if derr != nil {
		return nil, response.Status, derr
	}
	return body, response.Status, nil
}

// actionCookieCloudTest 验证 CookieCloud 配置: 拉取+解密+报告豆瓣登录态。
func (r *runtime) actionCookieCloudTest() (any, error) {
	r.mu.Lock()
	s := cloneSettings(r.settings)
	r.mu.Unlock()
	if s.CookieCloudURL == "" || s.CookieCloudUUID == "" || s.CookieCloudKey == "" {
		return map[string]any{"status": "failed", "message": "请先填写 CookieCloud 地址/UUID/密钥并保存"}, nil
	}
	data, err := r.cookieCloudPull(s.CookieCloudURL, s.CookieCloudUUID, s.CookieCloudKey)
	if err != nil {
		return map[string]any{"status": "failed", "message": err.Error()}, nil
	}
	header, uid, n := doubanCookieFromCloud(data)
	if header == "" {
		return map[string]any{"status": "failed", "message": fmt.Sprintf("解密成功(同步 %d 个域名, 豆瓣 cookie %d 个)，但没有 dbcl2——浏览器需要登录 douban.com", len(data), n)}, nil
	}
	return map[string]any{
		"status":  "succeeded",
		"message": fmt.Sprintf("连接成功：同步 %d 个域名，豆瓣登录有效 (uid=%s)", len(data), uid),
		"uid":     uid,
	}, nil
}

// actionWishSync 手动触发想看同步。
func (r *runtime) actionWishSync(invocationID string) (any, error) {
	r.mu.Lock()
	enabled := r.settings.WishSyncEnabled
	r.mu.Unlock()
	if !enabled {
		return map[string]any{"status": "failed", "message": "请先在设置中开启「同步我的想看」"}, nil
	}
	r.syncWishList(invocationID)
	r.mu.Lock()
	info := r.wishInfo
	r.mu.Unlock()
	if info.LastStatus != "succeeded" {
		return map[string]any{"status": "failed", "message": info.LastError}, nil
	}
	return map[string]any{"status": "succeeded", "message": fmt.Sprintf("想看同步完成：共 %d 条，新增 %d", info.LastCount, info.LastNew)}, nil
}
