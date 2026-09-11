package main

// WASM 适配层: hostCall 实现 + invocation 分发 + 存储替换文件系统

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unsafe"
)

// sessionNonce 让 Host API 的幂等键在每个 worker 周期内唯一。
// 仅用进程内自增计数会在 worker 重启后从头开始, 与上一次会话遗留的幂等记录
// (宿主保留 24h) 撞上同一个 key、不同指纹, 宿主会直接回 412 idempotency_conflict。
var sessionNonce = strconv.FormatInt(time.Now().UnixNano(), 36)

type invokeParams struct {
	Envelope struct {
		Op           string          `json:"op"`
		InvocationID string          `json:"invocation_id"`
		Payload      json.RawMessage `json:"payload"`
	} `json:"envelope"`
	Background bool `json:"background"`
}

var idCounter int

func wasmHostCall(request hostCallRequest) (hostCallResponse, error) {
	idCounter++
	payload, err := json.Marshal(map[string]any{
		"method": "host.call",
		"params": request,
	})
	if err != nil {
		return hostCallResponse{}, err
	}
	n := host_call(uint32(uintptr(unsafeSliceData(payload))), uint32(len(payload)))
	if n == 0 || n > (8<<20) {
		return hostCallResponse{}, fmt.Errorf("host_call 返回长度 %d", n)
	}
	buf := make([]byte, n)
	got := host_read(uint32(uintptr(unsafeSliceData(buf))), uint32(len(buf)))
	if got == 0 {
		return hostCallResponse{}, fmt.Errorf("host_read 返回 0")
	}
	var resp struct {
		Result hostCallResponse `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := safeUnmarshal(buf[:got], &resp); err != nil {
		return hostCallResponse{}, fmt.Errorf("host 响应解析失败: %w", err)
	}
	if resp.Error != nil {
		return hostCallResponse{}, fmt.Errorf("host RPC %d: %s", resp.Error.Code, resp.Error.Message)
	}
	return resp.Result, nil
}

// ─────────── invocation 分发 (从原 handle/invoke 精简) ───────────

// ensureGuest 已移至 main.go

func wasmDispatch(req []byte) (out []byte) {
	defer func() {
		if r := recover(); r != nil {
			out = rpcErr(-32603, fmt.Sprintf("PANIC: %v", r))
		}
	}()
	// 宿主发送完整 JSON-RPC 消息: {"method":"runtime.invoke","params":{"envelope":{...},"background":false}}
	var msg struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(req, &msg); err != nil || msg.Method == "" {
		return rpcErr(-32602, "invalid invoke: recv="+trunc(req))
	}
	if msg.Method == "runtime.initialize" {
		// 初始化握手期间禁止 host.call 重入: 直接返回 ready
		return mustJSON(map[string]any{
			"result": map[string]any{"ready": true, "protocol": "dian115:wasm@1"},
		})
	}
	// 进入正常业务后才加载运行时(loadAll 会调用 host.call)
	guest := ensureGuest()
	var input invokeParams
	if err := json.Unmarshal(msg.Params, &input); err != nil || input.Envelope.Op == "" {
		return rpcErr(-32602, "invalid params: method="+msg.Method+" recv="+trunc(msg.Params))
	}
	var result any
	var bizErr error
	switch input.Envelope.Op {
	case "state":
		result, bizErr = guest.stateResult(input.Envelope.Payload)
	case "action":
		result, bizErr = guest.action(input.Envelope.InvocationID, input.Envelope.Payload)
	case "job":
		result, bizErr = guest.job(input.Envelope.InvocationID, input.Envelope.Payload)
	case "event":
		result, bizErr = guest.event(input.Envelope.Payload)
	case "shutdown":
		return mustJSON(map[string]any{"stopping": true})
	default:
		return rpcErr(-32601, "unsupported op: "+input.Envelope.Op)
	}
	if bizErr != nil {
		return rpcErr(-32602, bizErr.Error())
	}
	return mustJSON(map[string]any{"result": result})
}

func rpcErr(code int, msg string) []byte {
	return mustJSON(map[string]any{"error": map[string]any{"code": code, "message": msg}})
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"error":{"code":-32603,"message":"encode failed"}}`)
	}
	return b
}

// ─────────── 存储适配: 原文件读写 → Host Storage KV ───────────

// wasmStorageRead 读取键值并返回宿主给出的 ETag。
// 宿主存储用 "pkv_N" 做乐观锁: 已存在的键必须带 If-Match 才允许更新, 否则 412。
func wasmStorageRead(key string) ([]byte, string, bool) {
	resp, err := wasmHostCall(hostCallRequest{
		Method: "GET", Path: "/api/plugin-runtime/storage/" + key,
		Headers: map[string]string{"accept": "application/json"},
	})
	if err != nil || resp.Status != 200 {
		return nil, "", false
	}
	etag := ""
	for name, values := range resp.Headers {
		if strings.EqualFold(name, "etag") && len(values) > 0 {
			etag = values[0]
			break
		}
	}
	raw, err := decodeBody(resp)
	if err != nil {
		return nil, etag, false
	}
	var wrapper struct {
		Value json.RawMessage `json:"value"`
	}
	if safeUnmarshal(raw, &wrapper) == nil && len(wrapper.Value) > 0 {
		return wrapper.Value, etag, true
	}
	return raw, etag, true
}

func wasmStorageGet(key string) ([]byte, bool) {
	value, _, ok := wasmStorageRead(key)
	return value, ok
}

func wasmStoragePut(key string, value json.RawMessage) error {
	body, _ := json.Marshal(map[string]json.RawMessage{"value": value})
	put := func(ifMatch string) (hostCallResponse, error) {
		headers := map[string]string{
			"content-type": "application/json", "accept": "application/json",
			"idempotency-key": "dc-put-" + key + "-" + sessionNonce + "-" + strconv.Itoa(idCounter),
		}
		if ifMatch != "" {
			headers["if-match"] = ifMatch
		}
		return wasmHostCall(hostCallRequest{
			Method: "PUT", Path: "/api/plugin-runtime/storage/" + key,
			Headers: headers, BodyBase64: base64.RawStdEncoding.EncodeToString(body),
		})
	}
	// 先取当前 ETag: 键存在时不带 If-Match 会被宿主以 412 拒绝(乐观锁)。
	_, etag, exists := wasmStorageRead(key)
	resp, err := put(etag)
	if err != nil {
		return err
	}
	if resp.Status == 412 && exists {
		// ETag 过期(并发写入): 重读一次再用新 ETag 重试。
		if _, fresh, ok := wasmStorageRead(key); ok {
			resp, err = put(fresh)
			if err != nil {
				return err
			}
		}
	}
	if resp.Status >= 400 {
		detail := ""
		if raw, derr := decodeBody(resp); derr == nil && len(raw) > 0 {
			detail = ": " + trunc(raw)
		}
		return fmt.Errorf("storage PUT HTTP %d%s", resp.Status, detail)
	}
	return nil
}

// ─────────── 工具 ───────────

func unsafeSliceData(b []byte) unsafe.Pointer { return unsafe.Pointer(unsafe.SliceData(b)) }

func trimSpace(s string) string { return strings.TrimSpace(s) }

func trunc(b []byte) string {
	s := string(b)
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
