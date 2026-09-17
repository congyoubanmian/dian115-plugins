//go:build !wasm

package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

var storedState []byte
var storageFailure error

func wasmStorageGet(key string) ([]byte, bool) { return storedState, len(storedState) > 0 }
func wasmStoragePut(key string, value json.RawMessage) error {
	if storageFailure != nil {
		return storageFailure
	}
	storedState = append([]byte(nil), value...)
	return nil
}
func safeUnmarshal(data []byte, target any) error { return json.Unmarshal(data, target) }
func wasmHostCall(request hostCallRequest) (hostCallResponse, error) {
	return hostCallResponse{}, errors.New("network disabled in unit tests")
}
func trunc(b []byte) string { return string(b) }

func TestRecoveryAndSaveRollback(t *testing.T) {
	storedState = []byte(`{"settings":{"webhooks":[{"id":"saved","platform":"wecom","webhook":"https://example.invalid","enabled":true}],"max_logs":80},"logs":[{"message":"saved log"}],"history":[{"result":"succeeded"}],"revision":42}`)
	storageFailure = nil
	r := newRuntime()
	if len(r.settings.Webhooks) != 1 || r.settings.Webhooks[0].ID != "saved" || r.settings.MaxLogs != 80 || len(r.logs) != 1 || len(r.history) != 1 || r.revision != 42 {
		t.Fatalf("state did not recover: %+v", r)
	}
	storageFailure = errors.New("disk unavailable")
	result, err := r.action("save", json.RawMessage(`{"id":"settings-update","input":{"webhooks":[{"id":"unsaved"}]}}`))
	if err != nil || result.(map[string]any)["status"] != "failed" {
		t.Fatalf("expected failed action: %v %v", result, err)
	}
	if len(r.settings.Webhooks) != 1 || r.settings.Webhooks[0].ID != "saved" {
		t.Fatal("failed save changed active settings")
	}
	if newRuntime().revision != 42 {
		t.Fatal("failed save modified stored revision")
	}
	storageFailure = nil
	result, err = r.action("save", json.RawMessage(`{"id":"settings-update","input":{"webhooks":[{"id":"new"}]}}`))
	if err != nil || result.(map[string]any)["status"] != "succeeded" {
		t.Fatalf("save failed: %v %v", result, err)
	}
	recovered := newRuntime()
	if recovered.settings.Webhooks[0].ID != "new" || recovered.revision != r.revision {
		t.Fatalf("restart state/revision mismatch: recovered=%d live=%d", recovered.revision, r.revision)
	}
	result, _ = recovered.stateResult(json.RawMessage(`{"if_none_match":"\"state-v42\""}`))
	if result.(map[string]any)["not_modified"] == true {
		t.Fatal("stale revision incorrectly matched")
	}
}

func TestArchiveRollback(t *testing.T) {
	storageFailure = errors.New("disk unavailable")
	defer func() { storageFailure = nil }()
	r := &runtime{settings: Settings{MaxLogs: 200}, history: []HistoryEntry{{Result: "succeeded"}}, logs: []LogEntry{{Message: "keep"}}}
	result, _ := r.action("clear", json.RawMessage(`{"id":"archive"}`))
	if result.(map[string]any)["status"] != "failed" || len(r.history) != 1 || len(r.logs) != 1 {
		t.Fatal("failed archive erased active history")
	}
}

func TestPlatformResponses(t *testing.T) {
	cases := []struct {
		platform, body string
		valid          bool
	}{
		{"wecom", `{"errcode":0}`, true}, {"wecom", `{"errcode":40013,"errmsg":"invalid"}`, false},
		{"feishu", `{"code":0}`, true}, {"feishu", `{"StatusCode":0}`, true}, {"feishu", `{"code":0,"StatusCode":1}`, false},
		{"serverchan", `{"code":0}`, true}, {"qq", `{"success":true}`, true}, {"qq", `{"success":false}`, false},
	}
	for _, platform := range []string{"wecom", "feishu", "serverchan", "qq"} {
		for _, body := range []string{"", "<html>proxy error</html>", "{}", "null", `{"code":"0"}`} {
			cases = append(cases, struct {
				platform, body string
				valid          bool
			}{platform, body, false})
		}
	}
	for _, c := range cases {
		t.Run(c.platform+"/"+c.body, func(t *testing.T) {
			if (checkPlatformResult(c.platform, []byte(c.body)) == nil) != c.valid {
				t.Fatalf("unexpected validation for %s", c.body)
			}
		})
	}
}

func TestPersistLimit(t *testing.T) {
	storageFailure = nil
	r := &runtime{settings: Settings{Webhooks: []WebhookConfig{{Webhook: strings.Repeat("x", maxPersistBytes)}}}}
	if r.persistAll() == nil {
		t.Fatal("oversized state accepted")
	}
}
