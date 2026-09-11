// 音乐下载插件运行时: 登录/搜索/下载经本机 music-agent sidecar

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"sync"
	"time"
)

const (
	chromeUA         = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
	neteaseDesktopUA = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152"
	maxPersistBytes  = 4 << 20
	persistLogLimit  = 60
)

var neteaseLevels = []string{"jymaster", "jyeffect", "sky", "hires", "lossless", "dolby", "exhigh", "standard"}

type hostCallRequest struct {
	Method     string            `json:"method"`
	Path       string            `json:"path"`
	Headers    map[string]string `json:"headers,omitempty"`
	BodyBase64 string            `json:"body_base64,omitempty"`
}

type hostCallResponse struct {
	Status     int                 `json:"status"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"body_base64"`
}

func hostCall(request hostCallRequest) (hostCallResponse, error) { return wasmHostCall(request) }

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

func safeUnmarshal(data []byte, v any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("json panic: %v (input %d bytes)", r, len(data))
		}
	}()
	err = json.Unmarshal(data, v)
	return
}

// ── 状态 ─────────────────────────────────────────────────────

type AppSettings struct {
	Quality    map[string]string `json:"quality"`
	SaveDir    string            `json:"save_dir"`
	MaxHistory int               `json:"max_history"`
	MaxLogs    int               `json:"max_logs"`
}

type LogEntry struct {
	At      string `json:"at"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

type HistoryEntry struct {
	At      string `json:"at"`
	Source  string `json:"source"`
	Song    string `json:"song"`
	Singers string `json:"singers"`
	Quality string `json:"quality"`
	Result  string `json:"result"`
	Message string `json:"message,omitempty"`
}

type State struct {
	Sessions map[string]map[string]string `json:"sessions"`
	Settings AppSettings                  `json:"settings"`
	Logs     []LogEntry                   `json:"logs"`
	History  []HistoryEntry               `json:"history"`
	Revision int64                        `json:"revision"`
}

var guestRT *runtime

type runtime struct {
	mu         sync.Mutex
	settings   AppSettings
	logs       []LogEntry
	history    []HistoryEntry
	revision   int64
	lastStatus string
	lastMsg    string
}

func loadState() State {
	st := State{Sessions: map[string]map[string]string{}, Settings: AppSettings{Quality: map[string]string{"netease": "jymaster", "qq": "flac", "kugou": "flac"}, SaveDir: "音乐下载", MaxHistory: 200, MaxLogs: 200}}
	if raw, ok := wasmStorageGet("state"); ok {
		_ = safeUnmarshal(raw, &st)
		if st.Sessions == nil {
			st.Sessions = map[string]map[string]string{}
		}
		if st.Settings.Quality == nil {
			st.Settings.Quality = map[string]string{"netease": "jymaster", "qq": "flac", "kugou": "flac"}
		}
		if st.Settings.SaveDir == "" {
			st.Settings.SaveDir = "音乐下载"
		}
		if st.Settings.MaxHistory <= 0 {
			st.Settings.MaxHistory = 200
		}
		if st.Settings.MaxLogs <= 0 {
			st.Settings.MaxLogs = 200
		}
	}
	return st
}

func saveSessionCookies(source string, cookies map[string]string) {
	st := loadState()
	if st.Sessions == nil {
		st.Sessions = map[string]map[string]string{}
	}
	st.Sessions[source] = cookies
	data, _ := json.Marshal(st)
	_ = wasmStoragePut("sessions", data)
}

func newRuntime() *runtime {
	rt := &runtime{}
	if raw, ok := wasmStorageGet("state"); ok {
		_ = safeUnmarshal(raw, rt)
	}
	if rt.settings.Quality == nil {
		rt.settings = AppSettings{Quality: map[string]string{"netease": "jymaster", "qq": "flac", "kugou": "flac"}, SaveDir: "音乐下载", MaxHistory: 200, MaxLogs: 200}
	}
	return rt
}

var guestRTInit bool

func ensureGuest() *runtime {
	if !guestRTInit {
		guestRT = newRuntime()
		guestRTInit = true
	}
	return guestRT
}

func (r *runtime) now() string { return time.Now().Format(time.RFC3339) }

func (r *runtime) log(level, message string) {
	if len(message) > 400 {
		message = message[:400] + "…"
	}
	r.mu.Lock()
	r.logs = append(r.logs, LogEntry{At: r.now(), Level: level, Message: message})
	if r.settings.MaxLogs > 0 && len(r.logs) > r.settings.MaxLogs {
		r.logs = r.logs[len(r.logs)-r.settings.MaxLogs:]
	}
	r.revision++
	r.mu.Unlock()
}

func (r *runtime) addHistory(e HistoryEntry) {
	r.mu.Lock()
	e.At = r.now()
	r.history = append([]HistoryEntry{e}, r.history...)
	if r.settings.MaxHistory > 0 && len(r.history) > r.settings.MaxHistory {
		r.history = r.history[:r.settings.MaxHistory]
	}
	r.revision++
	r.mu.Unlock()
}

func (r *runtime) bump(status, msg string) {
	r.mu.Lock()
	r.lastStatus = status
	r.lastMsg = msg
	r.revision++
	r.mu.Unlock()
}

func (r *runtime) persistAll() {
	r.mu.Lock()
	logs := make([]LogEntry, len(r.logs))
	copy(logs, r.logs)
	history := make([]HistoryEntry, len(r.history))
	copy(history, r.history)
	st := r.settings
	r.mu.Unlock()
	if len(logs) > persistLogLimit {
		logs = logs[len(logs)-persistLogLimit:]
	}
	data, err := json.Marshal(map[string]any{"settings": st, "logs": logs, "history": history, "revision": r.revision})
	if err != nil || len(data) > maxPersistBytes {
		return
	}
	if err := wasmStoragePut("state", data); err != nil {
		r.mu.Lock()
		r.log("warning", "持久化失败: "+err.Error())
		r.mu.Unlock()
	}
}

func (r *runtime) stateResult(payload json.RawMessage) (any, error) {
	var req struct {
		IfNoneMatch string `json:"if_none_match"`
	}
	_ = json.Unmarshal(payload, &req)
	r.mu.Lock()
	etag := fmt.Sprintf(`"state-v%d"`, r.revision)
	if req.IfNoneMatch == etag {
		r.mu.Unlock()
		return map[string]any{"not_modified": true, "etag": etag}, nil
	}
	out := map[string]any{
		"state": map[string]any{
			"settings":     r.settings,
			"history":      r.history,
			"logs":         r.logs,
			"revision":     r.revision,
			"status":       r.lastStatus,
			"last_message": r.lastMsg,
		},
		"etag":          etag,
		"state_version": etag,
	}
	r.mu.Unlock()
	return out, nil
}

// ── 动作 ─────────────────────────────────────────────────────

func (r *runtime) action(invocationID string, raw json.RawMessage) (any, error) {
	var payload struct {
		ID    string          `json:"id"`
		Input json.RawMessage `json:"input"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.ID == "" {
		return nil, fmt.Errorf("invalid action payload")
	}
	var input map[string]any
	_ = json.Unmarshal(payload.Input, &input)
	get := func(k string) string { s, _ := input[k].(string); return s }

	switch payload.ID {
	case "search":
		source, query := get("source"), get("query")
		page := 1
		if f, ok := input["page"].(float64); ok {
			page = int(f)
		}
		if source == "" || query == "" {
			return map[string]any{"status": "failed", "message": "缺少来源或关键词"}, nil
		}
		out, err := agentFetchJSON("GET", fmt.Sprintf("/search?source=%s&query=%s&page=%d", source, url.QueryEscape(query), page), nil)
		if err != nil {
			r.log("error", "搜索失败: "+err.Error())
			return map[string]any{"status": "failed", "message": err.Error()}, nil
		}
		r.mu.Lock()
		out["quality"] = r.settings.Quality[source]
		r.bump("succeeded", "搜索: "+query)
		r.mu.Unlock()
		return out, nil

	case "download":
		source, id := get("source"), get("id")
		name, singers := get("name"), get("singers")
		hash := get("hash")
		r.mu.Lock()
		quality := r.settings.Quality[source]
		saveDir := r.settings.SaveDir
		r.mu.Unlock()
		if quality == "" {
			quality = "flac"
		}
		payload := map[string]any{"source": source, "id": id, "hash": hash, "quality": quality, "name": name, "singers": singers, "save_dir": saveDir}
		out, err := agentFetchJSON("POST", "/download", payload)
		if err != nil {
			if out != nil {
				if msg, ok := out["error"].(string); ok {
					r.log("error", "下载提交失败: "+msg)
					return map[string]any{"status": "failed", "message": msg}, nil
				}
			}
			r.log("error", "下载提交失败: "+err.Error())
			return map[string]any{"status": "failed", "message": err.Error()}, nil
		}
		taskID, _ := out["task_id"].(string)
		r.addHistory(HistoryEntry{Source: source, Song: name, Singers: singers, Quality: quality, Result: "accepted", Message: "任务 " + taskID})
		r.bump("succeeded", "已提交下载: "+name)
		r.persistAll()
		return map[string]any{"status": "succeeded", "message": "已提交下载", "task_id": taskID}, nil

	case "agent-get":
		path := get("path")
		if path == "" {
			return nil, fmt.Errorf("path required")
		}
		out, err := agentFetchJSON("GET", path, nil)
		if err != nil {
			if out != nil {
				return map[string]any{"status": "failed", "agent_error": out, "message": err.Error()}, nil
			}
			return nil, err
		}
		return out, nil

	case "agent-post":
		path := get("path")
		if path == "" {
			return nil, fmt.Errorf("path required")
		}
		var payloadAny any = input["payload"]
		out, err := agentFetchJSON("POST", path, payloadAny)
		if err != nil {
			if out != nil {
				return map[string]any{"status": "failed", "agent_error": out, "message": err.Error()}, nil
			}
			return nil, err
		}
		return out, nil

	case "settings-update":
		r.mu.Lock()
		if q, ok := input["quality"].(map[string]any); ok {
			if r.settings.Quality == nil {
				r.settings.Quality = map[string]string{}
			}
			for k, v := range q {
				if sv, ok := v.(string); ok {
					r.settings.Quality[k] = sv
				}
			}
		}
		if sd, ok := input["save_dir"].(string); ok && sd != "" {
			r.settings.SaveDir = sd
		}
		r.mu.Unlock()
		r.persistAll()
		r.bump("succeeded", "设置已保存")
		return map[string]any{"status": "succeeded", "message": "设置已保存"}, nil

	case "archive":
		r.mu.Lock()
		r.history = nil
		r.logs = nil
		r.mu.Unlock()
		r.persistAll()
		r.bump("succeeded", "已清空历史")
		return map[string]any{"status": "succeeded", "message": "已清空"}, nil
	}
	return nil, fmt.Errorf("未知动作: %s", payload.ID)
}

func (r *runtime) job(invocationID string, raw json.RawMessage) (any, error) {
	return map[string]any{"status": "skipped", "message": "暂无后台任务"}, nil
}

func (r *runtime) event(payload json.RawMessage) (any, error) {
	return map[string]any{"status": "skipped"}, nil
}

func main() {}
