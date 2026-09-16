// 通知机器人插件入口: host.call 通道类型 + HTTP 应答解码。
// 全部网络请求经由宿主 host.call 代理 (WASM 无 socket), 出站域名受 manifest 白名单约束。

package main

import (
	"encoding/base64"
	"fmt"
)

func main() {}

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

// postJSON 通过 host.call 发送 POST 并返回 (状态码, 响应体)。
func postJSON(url, contentType string, body []byte) (int, []byte, error) {
	resp, err := hostCall(hostCallRequest{
		Method: "POST", Path: url,
		Headers: map[string]string{
			"content-type": contentType,
			"accept":       "application/json",
			"user-agent":   "dian115-notify-bot/0.1",
		},
		BodyBase64: base64.StdEncoding.EncodeToString(body),
	})
	if err != nil {
		return 0, nil, err
	}
	raw, err := decodeBody(resp)
	if err != nil {
		return resp.Status, nil, fmt.Errorf("响应解码失败: %w", err)
	}
	return resp.Status, raw, nil
}
