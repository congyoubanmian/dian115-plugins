// music-agent sidecar 透传层
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
)

const agentBase = "http://127.0.0.1:8791"

// agentGet / agentPost: 透传到 music-agent
func agentGet(path string) (int, []byte, error) {
	resp, err := hostCall(hostCallRequest{
		Method: "GET", Path: agentBase + path,
		Headers: map[string]string{"accept": "application/json"},
	})
	if err != nil {
		return 0, nil, err
	}
	body, _ := decodeBody(resp)
	return resp.Status, body, nil
}

func agentPost(path string, payload any) (int, []byte, error) {
	body, _ := json.Marshal(payload)
	resp, err := hostCall(hostCallRequest{
		Method: "POST", Path: agentBase + path,
		Headers:    map[string]string{"content-type": "application/json", "accept": "application/json"},
		BodyBase64: base64.StdEncoding.EncodeToString(body),
	})
	if err != nil {
		return 0, nil, err
	}
	out, _ := decodeBody(resp)
	return resp.Status, out, nil
}

// agentFetchJSON 透传并解析; 非 2xx 时返回宿主原始错误信息
func agentFetchJSON(method, path string, payload any) (map[string]any, error) {
	var status int
	var body []byte
	var err error
	if payload != nil {
		status, body, err = agentPost(path, payload)
	} else {
		status, body, err = agentGet(path)
	}
	if err != nil {
		return nil, fmt.Errorf("music-agent 不可达: %w", err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("music-agent 响应解析失败: %w", err)
	}
	if status >= 400 {
		msg := ""
		if e, ok := out["error"].(string); ok {
			msg = e
		}
		return out, fmt.Errorf("music-agent HTTP %d: %s", status, msg)
	}
	return out, nil
}
