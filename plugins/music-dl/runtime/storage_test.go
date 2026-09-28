package main

import "testing"

// 宿主 GET /api/plugin-runtime/storage/:key 的现行响应 (OpenAPI StorageValueEnvelope)。
const envelope = `{"data":{"key":"k","value":{"a":1},"revision":"pkv_9","updated_at":"2026-09-28T12:00:00Z"},"meta":{}}`

func TestUnwrapStorageValue(t *testing.T) {
	bare := `{"logins":{}}`
	tests := []struct{ name, in, want string }{
		{"host-envelope", envelope, `{"a":1}`},
		{"legacy-flat-value", `{"value":{"a":1}}`, `{"a":1}`},
		{"bare-document", bare, bare},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		if got := string(unwrapStorageValue([]byte(tt.in))); got != tt.want {
			t.Errorf("%s: got %s want %s", tt.name, got, tt.want)
		}
	}
}
