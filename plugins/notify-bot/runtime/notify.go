// 通知机器人插件: 企业微信 / 飞书 / Server酱 / QQ(Qmsg)
// 所有出站请求经宿主 host.call 代理; 配置了代理地址的走 music-agent sidecar 中转。

package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxPersistBytes = 4 << 20
	persistLogLimit = 60
	// 企业微信/飞书等单条 hook 发送的超时预算由宿主控制; 动作整体预算约 6.5s,
	// 广播条数过多时按 enabled 顺序逐条发送, 前台建议单平台不超过 5 条配置。
	relayBase = "http://127.0.0.1:8791"
)

type WebhookConfig struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Platform string `json:"platform"` // wecom | feishu | serverchan | qq
	Webhook  string `json:"webhook"`
	Secret   string `json:"secret,omitempty"`
	Proxy    string `json:"proxy,omitempty"`
	Enabled  bool   `json:"enabled"`
}

type Settings struct {
	Webhooks []WebhookConfig `json:"webhooks"`
	MaxLogs  int             `json:"max_logs"`
}

type LogEntry struct {
	At      string `json:"at"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

type HistoryEntry struct {
	At       string `json:"at"`
	Platform string `json:"platform"`
	Config   string `json:"config,omitempty"`
	Action   string `json:"action"`
	Result   string `json:"result"`
	Message  string `json:"message,omitempty"`
}

type runtime struct {
	mu         sync.Mutex
	settings   Settings
	logs       []LogEntry
	history    []HistoryEntry
	revision   int64
	lastStatus string
	lastMsg    string
}

var guestRT *runtime

func newRuntime() *runtime {
	rt := &runtime{}
	if raw, ok := wasmStorageGet("state"); ok {
		_ = safeUnmarshal(raw, rt)
	}
	if rt.settings.MaxLogs <= 0 {
		rt.settings.MaxLogs = 200
	}
	return rt
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
	if r.settings.MaxLogs > 0 && len(r.history) > r.settings.MaxLogs {
		r.history = r.history[:r.settings.MaxLogs]
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

// persistAll 落盘; 注意不能在持有 r.mu 时调用 (内部不加锁, 单线程 WASM 下安全)。
func (r *runtime) persistAll() {
	r.mu.Lock()
	logs := make([]LogEntry, len(r.logs))
	copy(logs, r.logs)
	history := make([]HistoryEntry, len(r.history))
	copy(history, r.history)
	st := r.settings
	revision := r.revision
	r.mu.Unlock()
	if len(logs) > persistLogLimit {
		logs = logs[len(logs)-persistLogLimit:]
	}
	data, err := json.Marshal(map[string]any{
		"settings": st, "logs": logs, "history": history,
		"webhooks": st.Webhooks, "revision": revision,
	})
	if err != nil || len(data) > maxPersistBytes {
		return
	}
	_ = wasmStoragePut("state", data)
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
	settings := r.settings
	history := r.history
	logs := r.logs
	revision := r.revision
	status := r.lastStatus
	lastMsg := r.lastMsg
	r.mu.Unlock()
	return map[string]any{
		"state": map[string]any{
			"settings":     settings,
			"history":      history,
			"logs":         logs,
			"revision":     revision,
			"status":       status,
			"last_message": lastMsg,
		},
		"etag":          etag,
		"state_version": etag,
	}, nil
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
	case "send":
		platform := get("platform")
		title := get("title")
		content := get("content")
		if platform == "" || content == "" {
			return map[string]any{"status": "failed", "message": "缺少 platform 或 content"}, nil
		}
		return r.broadcast("send", platform, "", title, content), nil

	case "test":
		platform := get("platform")
		configID := get("config_id")
		if platform == "" {
			return map[string]any{"status": "failed", "message": "缺少 platform"}, nil
		}
		return r.broadcast("test", platform, configID, "测试通知", "这是一条测试消息，收到说明配置正确。"), nil

	case "settings-update":
		r.mu.Lock()
		if w, ok := input["webhooks"].([]any); ok {
			var hooks []WebhookConfig
			for _, item := range w {
				if m, ok := item.(map[string]any); ok {
					hook := WebhookConfig{}
					if v, ok := m["id"].(string); ok {
						hook.ID = v
					}
					if v, ok := m["name"].(string); ok {
						hook.Name = v
					}
					if v, ok := m["platform"].(string); ok {
						hook.Platform = v
					}
					if v, ok := m["webhook"].(string); ok {
						hook.Webhook = strings.TrimSpace(v)
					}
					if v, ok := m["secret"].(string); ok {
						hook.Secret = strings.TrimSpace(v)
					}
					if v, ok := m["proxy"].(string); ok {
						hook.Proxy = strings.TrimSpace(v)
					}
					if v, ok := m["enabled"].(bool); ok {
						hook.Enabled = v
					}
					hooks = append(hooks, hook)
				}
			}
			r.settings.Webhooks = hooks
		}
		if n, ok := input["max_logs"].(float64); ok && n >= 20 && n <= 1000 {
			r.settings.MaxLogs = int(n)
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
		r.bump("succeeded", "已清空")
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

// broadcast 向平台下所有启用的配置发送 (configID 非空时只发指定配置)。
// 全部成功 → succeeded; 部分成功 → succeeded(带失败说明); 全部失败 → failed。
func (r *runtime) broadcast(action, platform, configID, title, content string) map[string]any {
	r.mu.Lock()
	var hooks []WebhookConfig
	for _, h := range r.settings.Webhooks {
		if h.Platform != platform {
			continue
		}
		if configID != "" {
			if h.ID == configID {
				hooks = append(hooks, h)
			}
			continue
		}
		if h.Enabled && h.Webhook != "" {
			hooks = append(hooks, h)
		}
	}
	r.mu.Unlock()

	if len(hooks) == 0 {
		msg := fmt.Sprintf("未找到启用的 %s 配置", platform)
		r.log("warn", msg)
		r.bump("failed", msg)
		return map[string]any{"status": "failed", "message": msg}
	}

	var okCount, failCount int
	var failMsgs []string
	start := time.Now()
	for _, hook := range hooks {
		err := r.deliver(hook, title, content)
		elapsed := time.Since(start)
		if err != nil {
			failCount++
			failMsgs = append(failMsgs, hook.Name+": "+err.Error())
			r.log("error", fmt.Sprintf("[%s/%s] 发送失败 (%.1fs): %s", platform, hook.Name, elapsed.Seconds(), err.Error()))
			r.addHistory(HistoryEntry{Platform: platform, Config: hook.Name, Action: action, Result: "failed", Message: err.Error()})
			continue
		}
		okCount++
		r.log("info", fmt.Sprintf("[%s/%s] 发送成功 (%.1fs)", platform, hook.Name, elapsed.Seconds()))
		r.addHistory(HistoryEntry{Platform: platform, Config: hook.Name, Action: action, Result: "succeeded"})
	}

	status := "succeeded"
	msg := fmt.Sprintf("已发送 %d/%d 条配置", okCount, len(hooks))
	if okCount == 0 {
		status = "failed"
		msg = "全部发送失败: " + strings.Join(failMsgs, "; ")
	} else if failCount > 0 {
		msg += "（失败: " + strings.Join(failMsgs, "; ") + "）"
	}
	r.bump(status, msg)
	r.persistAll()
	return map[string]any{"status": status, "message": msg, "sent": okCount, "total": len(hooks)}
}

// ── 通知发送 ─────────────────────────────────────────────────

// deliver 发送单条配置: 先按平台构造请求体, 配置了 proxy 时经 sidecar 中转。
func (r *runtime) deliver(hook WebhookConfig, title, content string) error {
	if hook.Webhook == "" {
		return fmt.Errorf("webhook 地址为空")
	}
	body, contentType, err := buildPayload(hook, title, content)
	if err != nil {
		return err
	}

	var status int
	var respBody []byte
	if hook.Proxy != "" {
		status, respBody, err = relayPost(hook.Webhook, contentType, body, hook.Proxy)
	} else {
		status, respBody, err = postJSON(hook.Webhook, contentType, body)
	}
	if err != nil {
		return fmt.Errorf("请求失败: %w", err)
	}
	if status >= 400 {
		return fmt.Errorf("HTTP %d: %s", status, trunc(respBody))
	}
	return checkPlatformResult(hook.Platform, respBody)
}

// buildPayload 构造各平台请求体。
func buildPayload(hook WebhookConfig, title, content string) ([]byte, string, error) {
	text := content
	if title != "" {
		text = title + "\n" + content
	}
	switch hook.Platform {
	case "wecom":
		body, _ := json.Marshal(map[string]any{
			"msgtype":  "markdown",
			"markdown": map[string]string{"content": fmt.Sprintf("**%s**\n%s", title, content)},
		})
		return body, "application/json", nil

	case "feishu":
		payload := map[string]any{
			"msg_type": "text",
			"content":  map[string]string{"text": text},
		}
		if hook.Secret != "" {
			ts := time.Now().Unix()
			payload["timestamp"] = strconv.FormatInt(ts, 10)
			payload["sign"] = feishuSign(hook.Secret, ts)
		}
		body, _ := json.Marshal(payload)
		return body, "application/json", nil

	case "serverchan":
		form := url.Values{}
		form.Set("title", title)
		form.Set("desp", content)
		return []byte(form.Encode()), "application/x-www-form-urlencoded", nil

	case "qq":
		// Qmsg 酱: POST {webhook}(https://qmsg.zber.com/send/{key}), form 参数 msg
		form := url.Values{}
		form.Set("msg", text)
		return []byte(form.Encode()), "application/x-www-form-urlencoded", nil

	default:
		return nil, "", fmt.Errorf("不支持的平台: %s", hook.Platform)
	}
}

// feishuSign 飞书自定义机器人签名: hmac-sha256(key=timestamp+"\n"+secret), base64。
func feishuSign(secret string, timestamp int64) string {
	stringToSign := strconv.FormatInt(timestamp, 10) + "\n" + secret
	h := hmac.New(sha256.New, []byte(stringToSign))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// relayPost 经 music-agent sidecar 中转发送 (用配置的代理出口)。
// 协议: POST /relay {url, content_type, body_base64, proxy} → {status, body_base64} 。
func relayPost(target, contentType string, body []byte, proxy string) (int, []byte, error) {
	req, _ := json.Marshal(map[string]string{
		"url":         target,
		"content_type": contentType,
		"body_base64": base64.StdEncoding.EncodeToString(body),
		"proxy":       proxy,
	})
	resp, err := hostCall(hostCallRequest{
		Method: "POST", Path: relayBase + "/relay",
		Headers:    map[string]string{"content-type": "application/json", "accept": "application/json"},
		BodyBase64: base64.StdEncoding.EncodeToString(req),
	})
	if err != nil {
		return 0, nil, fmt.Errorf("代理中转不可达(music-agent 未运行?): %w", err)
	}
	raw, err := decodeBody(resp)
	if err != nil {
		return resp.Status, nil, err
	}
	var out struct {
		Status     int    `json:"status"`
		BodyBase64 string `json:"body_base64"`
		Error      string `json:"error"`
	}
	if safeUnmarshal(raw, &out) != nil {
		return resp.Status, raw, fmt.Errorf("中转响应解析失败: %s", trunc(raw))
	}
	if out.Error != "" {
		return out.Status, nil, fmt.Errorf("代理发送失败: %s", out.Error)
	}
	bodyOut, _ := base64.StdEncoding.DecodeString(out.BodyBase64)
	return out.Status, bodyOut, nil
}

// checkPlatformResult 解析各平台业务应答 (HTTP 200 也可能业务失败)。
func checkPlatformResult(platform string, raw []byte) error {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]any
	if safeUnmarshal(raw, &m) != nil {
		return nil // 非 JSON 应答视为成功 (HTTP 层已校验)
	}
	switch platform {
	case "wecom":
		if code, ok := numField(m, "errcode"); ok && code != 0 {
			return fmt.Errorf("企业微信 errcode %d: %s", int(code), strField(m, "errmsg"))
		}
	case "feishu":
		if code, ok := numField(m, "code"); ok && code != 0 {
			return fmt.Errorf("飞书 code %d: %s", int(code), strField(m, "msg"))
		}
		if code, ok := numField(m, "StatusCode"); ok && code != 0 {
			return fmt.Errorf("飞书 code %d: %s", int(code), strField(m, "StatusMessage"))
		}
	case "serverchan":
		if code, ok := numField(m, "code"); ok && code != 0 {
			return fmt.Errorf("Server酱 code %d: %s", int(code), strField(m, "message"))
		}
	case "qq":
		if s, ok := m["success"].(bool); ok && !s {
			return fmt.Errorf("Qmsg 发送失败: %s", strField(m, "info"))
		}
	}
	return nil
}

func numField(m map[string]any, key string) (float64, bool) {
	v, ok := m[key].(float64)
	return v, ok
}

func strField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}
