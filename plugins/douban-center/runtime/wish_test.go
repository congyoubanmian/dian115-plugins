package main

import (
	"encoding/json"
	"testing"
	"time"
)

// 真实接口形态: subject.id / year 是字符串, 兴趣列表里混着 book 类型
// (2026-09-29 实抓: type=tv 的响应返回了 movie 和 book 条目)。
const wishResponseStringID = `{
  "start": 0, "count": 20, "total": 3,
  "interests": [
    {"id": 4935623109, "subject": {"id": "36808876", "title": "奥德赛", "year": "2026", "type": "movie",
      "pic": {"large": "https://img.doubanio.com/l.jpg"}}},
    {"id": 4781059772, "subject": {"id": "26968034", "title": "正面管教（修订版）", "year": null, "type": "book",
      "pic": {"large": "https://img.doubanio.com/b.jpg"}}},
    {"id": 3776939214, "subject": {"id": "36809864", "title": "南京照相馆", "year": "2025", "type": "movie",
      "pic": {"large": "https://img.doubanio.com/n.jpg"}}}
  ]
}`

// 部分接口给数字 id: 同样要能解。
const wishResponseNumericID = `{
  "interests": [
    {"subject": {"id": 12345, "title": "某剧集", "year": "2026", "type": "tv", "pic": {"large": ""}}}
  ]
}`

func parseWishInterests(t *testing.T, body string) []wishInterest {
	t.Helper()
	var res struct {
		Interests []wishInterest `json:"interests"`
	}
	if err := json.Unmarshal([]byte(body), &res); err != nil {
		t.Fatalf("wish response did not unmarshal: %v", err)
	}
	return res.Interests
}

func TestWishStringSubjectID(t *testing.T) {
	items := wishItemsFromInterests(parseWishInterests(t, wishResponseStringID))
	if len(items) != 2 {
		t.Fatalf("want 2 video items (book filtered), got %d: %+v", len(items), items)
	}
	if items[0].DoubanRef != "36808876" || items[0].Title != "奥德赛" || items[0].Type != "movie" {
		t.Fatalf("item[0] wrong: %+v", items[0])
	}
	if items[1].DoubanRef != "36809864" || items[1].Year != "2025" {
		t.Fatalf("item[1] wrong: %+v", items[1])
	}
	for _, it := range items {
		if it.Type != "movie" && it.Type != "tv" {
			t.Fatalf("non-video type leaked: %+v", it)
		}
	}
}

func TestWishNumericSubjectID(t *testing.T) {
	items := wishItemsFromInterests(parseWishInterests(t, wishResponseNumericID))
	if len(items) != 1 || items[0].DoubanRef != "12345" || items[0].Type != "tv" {
		t.Fatalf("numeric id handling wrong: %+v", items)
	}
}

func TestCookieCacheFresh(t *testing.T) {
	now := time.Now().Format(time.RFC3339)
	fresh := CookieCache{Header: "dbcl2=x", UID: "1", Source: "cookiecloud", FetchedAt: now}
	if !cookieCacheFresh(fresh) {
		t.Fatal("just-fetched cache must be fresh")
	}
	old := CookieCache{Header: "dbcl2=x", UID: "1", Source: "cookiecloud",
		FetchedAt: time.Now().Add(-time.Hour).Format(time.RFC3339)}
	if cookieCacheFresh(old) {
		t.Fatal("1h-old cache must be stale (TTL 45m)")
	}
	if cookieCacheFresh(CookieCache{}) {
		t.Fatal("empty cache must be stale")
	}
}
