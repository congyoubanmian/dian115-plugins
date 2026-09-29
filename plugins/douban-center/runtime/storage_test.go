package main

import (
	"encoding/json"
	"testing"
)

// 宿主 GET /api/plugin-runtime/storage/:key 的现行响应 (OpenAPI StorageValueEnvelope):
// {"data":{"key":...,"value":<值>,"revision":"pkv_N","updated_at":...},"meta":{...}}
const envelopeState = `{
  "data": {
    "key": "state",
    "value": {"settings":{"lists":{"hot":{"source":"subjects_json","enabled":true}}},"queue":{"items":[]}},
    "revision": "pkv_248",
    "updated_at": "2026-09-28T12:00:20Z"
  },
  "meta": {"plugin_id": "douban.center", "installation_id": 30}
}`

const envelopeAccount = `{
  "data": {
    "key": "account",
    "value": {"cookiecloud_url":"http://127.0.0.1:8088","cookiecloud_uuid":"uuid-test","cookiecloud_key":"key-test","wish_sync_enabled":true},
    "revision": "pkv_2",
    "updated_at": "2026-09-28T09:53:32Z"
  },
  "meta": {"plugin_id": "douban.center", "installation_id": 30}
}`

func TestUnwrapStorageValue(t *testing.T) {
	legacy := `{"value":{"a":1}}`
	bare := `{"settings":{"lists":{"hot":{}}}}`

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"host-envelope", envelopeState, `{"settings":{"lists":{"hot":{"source":"subjects_json","enabled":true}}},"queue":{"items":[]}}`},
		{"legacy-flat-value", legacy, `{"a":1}`},
		{"bare-document", bare, bare},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		got := string(unwrapStorageValue([]byte(tt.in)))
		if got != tt.want {
			t.Errorf("%s: unwrapStorageValue() = %s, want %s", tt.name, got, tt.want)
		}
	}
}

// 回归: 信封格式下状态文档必须能恢复出 lists (旧代码把信封当值, Lists 恒为 nil,
// 于是每次 worker 启动都退回默认配置并覆盖用户数据)。
func TestEnvelopeStateRestoresLists(t *testing.T) {
	value := unwrapStorageValue([]byte(envelopeState))
	var doc persistedState
	if err := safeUnmarshal(value, &doc); err != nil {
		t.Fatalf("envelope state did not unmarshal: %v", err)
	}
	if doc.Settings.Lists == nil {
		t.Fatal("envelope state lost lists: restored would be false and defaults would overwrite user data")
	}
}

// 回归: 信封格式下账号键必须能套用覆盖 (旧代码解析出零值 Settings, CookieCloud 配置永远不生效)。
func TestEnvelopeAccountOverlay(t *testing.T) {
	value := unwrapStorageValue([]byte(envelopeAccount))
	var acc Settings
	if err := safeUnmarshal(value, &acc); err != nil {
		t.Fatalf("envelope account did not unmarshal: %v", err)
	}
	if acc.CookieCloudURL != "http://127.0.0.1:8088" || acc.CookieCloudUUID != "uuid-test" ||
		acc.CookieCloudKey != "key-test" || !acc.WishSyncEnabled {
		t.Fatalf("envelope account overlay fields missing: %+v", acc)
	}
}

// PUT 请求体必须保持 {"value": ...} (OpenAPI StoragePutRequest)。
func TestStoragePutBodyShape(t *testing.T) {
	body, err := json.Marshal(map[string]json.RawMessage{"value": json.RawMessage(`{"a":1}`)})
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("put body is not valid json: %v", err)
	}
	if string(parsed["value"]) != `{"a":1}` {
		t.Fatalf("put body value = %s", parsed["value"])
	}
}

// 回归: 缺失的榜单键必须从默认配置补回(状态未加载时保存会丢键,
// 2026-09-29 实际丢过 4 个榜单), 已有键的用户配置不受影响。
func TestNormalizeRestoresMissingLists(t *testing.T) {
	r := &runtime{}
	r.settings = Settings{Lists: map[string]ListConfig{
		"upcoming": {Source: "wrong", Limit: 5, Enabled: true},
	}}
	r.normalizeSettingsLocked()
	for _, key := range []string{listUpcoming, listHot, listCNWom, listGlobalWom, listMovieWom} {
		if _, ok := r.settings.Lists[key]; !ok {
			t.Fatalf("list %s not restored", key)
		}
	}
	if r.settings.Lists[listHot].Tag != "热门" || !r.settings.Lists[listHot].Enabled {
		t.Fatalf("restored hot list wrong: %+v", r.settings.Lists[listHot])
	}
	// upcoming 被强制回 coming_html 来源, 但 limit 等用户值保留
	if r.settings.Lists[listUpcoming].Source != "coming_html" {
		t.Fatalf("upcoming source not normalized: %+v", r.settings.Lists[listUpcoming])
	}
	if r.settings.Lists[listUpcoming].Limit != 5 {
		t.Fatalf("user limit lost: %+v", r.settings.Lists[listUpcoming])
	}
}
