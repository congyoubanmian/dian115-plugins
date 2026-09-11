// 网易云: 搜索 / eapi 取链 / 扫码登录

package main

import (
	"crypto/aes"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func aesECBEncrypt(data, key []byte) []byte {
	block, _ := aes.NewCipher(key)
	pad := block.BlockSize() - len(data)%block.BlockSize()
	for i := 0; i < pad; i++ {
		data = append(data, byte(pad))
	}
	out := make([]byte, len(data))
	for i := 0; i < len(data); i += block.BlockSize() {
		block.Encrypt(out[i:i+block.BlockSize()], data[i:i+block.BlockSize()])
	}
	return out
}

func neteaseEapiParams(apiURL string, payload map[string]any) string {
	pj := mustJSON(payload)
	path := strings.Replace(apiURL, "/eapi/", "/api/", 1)
	sum := md5.Sum([]byte("nobody" + path + "use" + string(pj) + "md5forencrypt"))
	digest := hex.EncodeToString(sum[:])
	text := path + "-36cd479b6b5-" + string(pj) + "-36cd479b6b5-" + digest
	return hex.EncodeToString(aesECBEncrypt([]byte(text), []byte("e82ckenh8dichen8")))
}

func loadNeteaseCookie() map[string]string {
	st := loadState()
	if st.Sessions == nil {
		return map[string]string{}
	}
	if c, ok := st.Sessions["netease"]; ok {
		return c
	}
	return map[string]string{}
}

func neteaseCookieHeader() string {
	nc := loadNeteaseCookie()
	extra := "os=pc; appver=; osver=; deviceId=pyncm!"
	if mu, ok := nc["MUSIC_U"]; ok {
		extra += "; MUSIC_U=" + mu
	}
	if t, ok := nc["__csrf_token"]; ok {
		extra += "; __csrf_token=" + t
	}
	return extra
}

func neteaseSearch(query string, page int) (any, error) {
	form := url.Values{}
	form.Set("s", query)
	form.Set("type", "1")
	form.Set("limit", "30")
	form.Set("offset", strconv.Itoa((page-1)*30))
	resp, err := hostCall(hostCallRequest{
		Method: "POST", Path: "https://music.163.com/api/cloudsearch/pc",
		Headers:    map[string]string{"content-type": "application/x-www-form-urlencoded", "referer": "https://music.163.com/", "user-agent": chromeUA},
		BodyBase64: base64.StdEncoding.EncodeToString([]byte(form.Encode())),
	})
	if err != nil {
		return nil, err
	}
	body, _ := decodeBody(resp)
	var out struct {
		Result struct {
			Songs []struct {
				ID   int64                   `json:"id"`
				Name string                  `json:"name"`
				Ar   []struct{ Name string } `json:"ar"`
				Al   struct {
					Name   string `json:"name"`
					PicURL string `json:"picUrl"`
				} `json:"al"`
				DT int64 `json:"dt"`
			} `json:"songs"`
			SongCount int `json:"songCount"`
		} `json:"result"`
		Code int `json:"code"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("搜索解析失败: %w", err)
	}
	songs := []map[string]any{}
	for _, s := range out.Result.Songs {
		artists := []string{}
		for _, a := range s.Ar {
			artists = append(artists, a.Name)
		}
		songs = append(songs, map[string]any{
			"id": s.ID, "name": s.Name, "singers": strings.Join(artists, "/"),
			"album": s.Al.Name, "cover": s.Al.PicURL, "duration_ms": s.DT, "source": "netease",
		})
	}
	return map[string]any{"songs": songs, "total": out.Result.SongCount, "page": page}, nil
}

// neteaseSongURL 按所选音质向下逐级尝试官方 eapi 接口
func neteaseSongURL(songID string, level string) (dlURL, ext string, actual string, size int64, err error) {
	start := 0
	for i, l := range neteaseLevels {
		if l == level {
			start = i
			break
		}
	}
	payloadBase := map[string]any{
		"encodeType": "flac",
		"header":     `{"os":"pc","appver":"","osver":"","deviceId":"pyncm!"}`,
	}
	for _, lv := range neteaseLevels[start:] {
		payload := map[string]any{
			"ids": []string{songID}, "level": lv, "encodeType": "flac",
			"header": `{"os":"pc","appver":"","osver":"","deviceId":"pyncm!","requestId":"` + strconv.Itoa(int(time.Now().UnixNano()%1e8)) + `"`,
		}
		if lv == "sky" {
			payload["immerseType"] = "c51"
		}
		_ = payloadBase
		params := neteaseEapiParams("https://interface3.music.163.com/eapi/song/enhance/player/url/v1", payload)
		form := url.Values{}
		form.Set("params", params)
		resp, err := hostCall(hostCallRequest{
			Method: "POST", Path: "https://interface3.music.163.com/eapi/song/enhance/player/url/v1",
			Headers: map[string]string{
				"content-type": "application/x-www-form-urlencoded",
				"user-agent":   chromeUA,
				"cookie":       neteaseCookieHeader(),
			},
			BodyBase64: base64.StdEncoding.EncodeToString([]byte(form.Encode())),
		})
		if err != nil {
			return "", "", "", 0, err
		}
		body, _ := decodeBody(resp)
		var out struct {
			Data []struct {
				URL   string `json:"url"`
				Level string `json:"level"`
				Type  string `json:"type"`
				Size  int64  `json:"size"`
			} `json:"data"`
			Code int `json:"code"`
		}
		if json.Unmarshal(body, &out) != nil || len(out.Data) == 0 || !strings.HasPrefix(out.Data[0].URL, "http") {
			continue
		}
		ext := out.Data[0].Type
		if ext == "" {
			ext = "flac"
		}
		return out.Data[0].URL, ext, out.Data[0].Level, out.Data[0].Size, nil
	}
	return "", "", "", 0, fmt.Errorf("所有音质均未获取到链接（需要 SVIP 且歌曲有对应音源）")
}

// netease QR 登录
func neteaseQRCreate() (any, error) {
	form := url.Values{}
	form.Set("type", "3")
	resp, err := hostCall(hostCallRequest{
		Method: "POST", Path: "https://interface.music.163.com/api/login/qrcode/unikey",
		Headers:    map[string]string{"content-type": "application/x-www-form-urlencoded", "user-agent": neteaseDesktopUA},
		BodyBase64: base64.StdEncoding.EncodeToString([]byte(form.Encode())),
	})
	if err != nil {
		return nil, err
	}
	body, _ := decodeBody(resp)
	var out struct {
		Code   int    `json:"code"`
		Unikey string `json:"unikey"`
	}
	if json.Unmarshal(body, &out) != nil || out.Code != 200 || out.Unikey == "" {
		return nil, fmt.Errorf("获取二维码失败")
	}
	return map[string]any{
		"key":        out.Unikey,
		"qr_content": "https://music.163.com/login?codekey=" + url.QueryEscape(out.Unikey),
	}, nil
}

func neteaseQRPoll(key string) (any, error) {
	form := url.Values{}
	form.Set("key", key)
	form.Set("type", "3")
	resp, err := hostCall(hostCallRequest{
		Method: "POST", Path: "https://interface.music.163.com/api/login/qrcode/client/login",
		Headers:    map[string]string{"content-type": "application/x-www-form-urlencoded", "referer": "https://music.163.com/", "user-agent": neteaseDesktopUA},
		BodyBase64: base64.StdEncoding.EncodeToString([]byte(form.Encode())),
	})
	if err != nil {
		return nil, err
	}
	body, _ := decodeBody(resp)
	var out struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Cookie  string `json:"cookie"`
	}
	json.Unmarshal(body, &out)
	status := map[int]string{800: "expired", 801: "waiting", 802: "scanned", 803: "success"}[out.Code]
	result := map[string]any{"status": status, "message": out.Message, "code": out.Code}
	if out.Code == 803 {
		cookies := map[string]string{}
		for _, pair := range strings.Split(out.Cookie, ";") {
			kv := strings.SplitN(strings.TrimSpace(pair), "=", 2)
			if len(kv) == 2 && kv[0] != "" {
				cookies[kv[0]] = kv[1]
			}
		}
		saveSessionCookies("netease", cookies)
		result["logged_in"] = true
	}
	return result, nil
}
