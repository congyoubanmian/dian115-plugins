// QQ 音乐: QQ扫码 / 微信扫码 登录 + 搜索 + 取链(音质阶梯)

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const qqQRShow = "https://ssl.ptlogin2.qq.com/ptqrshow"
const qqQRCheck = "https://ssl.ptlogin2.qq.com/ptqrlogin"
const qqWXConnect = "https://open.weixin.qq.com/connect/qrconnect"
const qqWXCheck = "https://lp.open.weixin.qq.com/connect/l/qrconnect"
const qqWXAppID = "wx48db31d50e334801"
const qqWXRedirect = "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/"

func qqHash33(s string) int {
	h := 0
	for _, c := range s {
		h += (h << 5) + int(c)
	}
	return h & 0x7fffffff
}

func qqCookieHeader() string {
	st := loadState()
	if c, ok := st.Sessions["qq"]; ok {
		parts := []string{}
		for k, v := range c {
			parts = append(parts, k+"="+v)
		}
		return strings.Join(parts, "; ")
	}
	return ""
}

// qqGet 走 GET 并收集 Set-Cookie
func qqGet(apiURL string, referer string, extraCookie string) (int, string, map[string]string) {
	ck := qqCookieHeader()
	if extraCookie != "" {
		if ck != "" {
			ck += "; " + extraCookie
		} else {
			ck = extraCookie
		}
	}
	resp, err := hostCall(hostCallRequest{
		Method: "GET", Path: apiURL,
		Headers: map[string]string{"user-agent": chromeUA, "referer": referer, "cookie": ck},
	})
	if err != nil {
		return 0, "", nil
	}
	cookies := map[string]string{}
	// Set-Cookie 可能合并在一行; 按分号+name= 拆分
	if sc, ok := resp.Headers["set-cookie"]; ok {
		for _, line := range sc {
			for _, seg := range strings.Split(line, ", ") {
				kv := strings.SplitN(seg, "=", 2)
				if len(kv) == 2 && strings.HasPrefix(kv[0], "__Host-") == false {
					name := strings.TrimSpace(kv[0])
					if name == "qrsig" || name == "uin" || name == "skey" || name == "p_skey" ||
						name == "ptui_loginuin" || name == "luin" || name == "qqmusic_key" ||
						name == "musickey" || name == "wxuin" || name == "wxunionid" ||
						name == "euin" || name == "tmeLoginType" || name == "qqmusic_u" {
						val := strings.SplitN(kv[1], ";", 2)[0]
						cookies[name] = val
					}
				}
			}
		}
	}
	body, _ := decodeBody(resp)
	return resp.Status, string(body), cookies
}

func qqCreateQR() (any, error) {
	params := url.Values{}
	params.Set("appid", "716027609")
	params.Set("e", "2")
	params.Set("l", "M")
	params.Set("s", "3")
	params.Set("d", "72")
	params.Set("v", "4")
	params.Set("t", fmt.Sprintf("%.17f", float64(time.Now().UnixNano())/1e18))
	params.Set("daid", "383")
	params.Set("pt_3rd_aid", "100497308")
	status, _, cookies := qqGet(qqQRShow+"?"+params.Encode(), "https://y.qq.com/", "")
	if status != 200 {
		return nil, fmt.Errorf("QQ 二维码获取失败: HTTP %d", status)
	}
	qrsig := cookies["qrsig"]
	if qrsig == "" {
		return nil, fmt.Errorf("缺少 qrsig")
	}
	key := url.Values{}
	key.Set("qrsig", qrsig)
	// 二维码图片是 PNG 二进制, 由 UI 端单独通过 /qr-image 代理获取
	return map[string]any{
		"source":     "qq",
		"key":        key.Encode(),
		"image_mode": "fetch_png",
		"image_url":  qqQRShow + "?" + params.Encode(),
		"expires_in": 120,
	}, nil
}

func qqPollQR(key string) (any, error) {
	values, _ := url.ParseQuery(key)
	qrsig := values.Get("qrsig")
	if qrsig == "" {
		return nil, fmt.Errorf("缺少 qrsig")
	}
	params := url.Values{}
	params.Set("u1", "https://graph.qq.com/oauth2.0/login_jump")
	params.Set("ptqrtoken", strconv.Itoa(qqHash33(qrsig)))
	params.Set("ptredirect", "100")
	params.Set("h", "1")
	params.Set("t", "1")
	params.Set("g", "1")
	params.Set("from_ui", "1")
	params.Set("ptlang", "2052")
	params.Set("action", fmt.Sprintf("0-0-%d", time.Now().UnixMilli()))
	params.Set("js_ver", "21072115")
	params.Set("js_type", "1")
	params.Set("login_sig", "")
	params.Set("pt_uistyle", "40")
	params.Set("aid", "716027609")
	params.Set("daid", "383")
	params.Set("pt_3rd_aid", "100497308")
	params.Set("has_onekey", "1")
	params.Set("pttype", "1")
	params.Set("service", "ptqrlogin")
	params.Set("nodirect", "0")
	status, body, cookies := qqGet(qqQRCheck+"?"+params.Encode(), "https://xui.ptlogin2.qq.com/", "qrsig="+qrsig)
	if status == 0 {
		return nil, fmt.Errorf("网络错误")
	}
	// ptuiCB('0','0','https://…check_sig…','0','登录成功', '昵称')
	re := regexp.MustCompile(`'([^']*)'`)
	matches := re.FindAllStringSubmatch(body, -1)
	code, redirect := "", ""
	if len(matches) >= 3 {
		code = matches[0][1]
		redirect = matches[2][1]
	}
	statusMap := map[string]string{"0": "success", "65": "expired", "66": "waiting", "67": "scanned"}
	st := statusMap[code]
	if st == "" {
		st = "failed"
	}
	result := map[string]any{"status": st, "code": code}
	if st != "success" {
		return result, nil
	}
	// 跟随重定向链收集 QQ 域 cookie（最多 8 跳, 手动管理）
	jar := map[string]string{}
	for k, v := range cookies {
		jar[k] = v
	}
	cur := redirect
	for i := 0; i < 8 && cur != ""; i++ {
		rr, err := hostCall(hostCallRequest{
			Method: "GET", Path: cur,
			Headers: map[string]string{"user-agent": chromeUA, "referer": "https://y.qq.com/"},
		})
		if err != nil {
			break
		}
		if sc, ok := rr.Headers["set-cookie"]; ok {
			for _, line := range sc {
				for _, seg := range strings.Split(line, ", ") {
					kv := strings.SplitN(seg, "=", 2)
					if len(kv) == 2 {
						jar[strings.TrimSpace(kv[0])] = strings.SplitN(kv[1], ";", 2)[0]
					}
				}
			}
		}
		loc := ""
		if lv, ok := rr.Headers["location"]; ok && len(lv) > 0 {
			loc = lv[0]
		}
		if rr.Status < 300 || rr.Status >= 400 || loc == "" {
			break
		}
		cur = loc
	}
	// 规范化 QQ 音乐所需 cookie
	if jar["uin"] == "" {
		for _, k := range []string{"ptui_loginuin", "luin", "wxuin"} {
			if jar[k] != "" {
				jar["uin"] = jar[k]
				break
			}
		}
	}
	if jar["qqmusic_key"] == "" {
		for _, k := range []string{"p_skey", "skey", "musickey"} {
			if jar[k] != "" {
				jar["qqmusic_key"] = jar[k]
				break
			}
		}
	}
	saveSessionCookies("qq", jar)
	result["logged_in"] = true
	return result, nil
}

func qqCreateWXQR() (any, error) {
	state := fmt.Sprintf("musicdl-%d", time.Now().UnixNano())
	params := url.Values{}
	params.Set("appid", qqWXAppID)
	params.Set("redirect_uri", qqWXRedirect)
	params.Set("response_type", "code")
	params.Set("scope", "snsapi_login")
	params.Set("state", state)
	params.Set("href", "https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect")
	loginURL := qqWXConnect + "?" + params.Encode()
	status, body, _ := qqGet(loginURL, "https://y.qq.com/", "")
	if status != 200 {
		return nil, fmt.Errorf("微信二维码获取失败: HTTP %d", status)
	}
	uuid := ""
	for _, pat := range []string{`connect/l/qrconnect\?uuid=([A-Za-z0-9_-]+)`, `window\.QRLogin\.uuid\s*=\s*"([^"]+)"`, `/connect/qrcode/([A-Za-z0-9_-]+)`} {
		if m := regexp.MustCompile(pat).FindStringSubmatch(body); len(m) > 1 {
			uuid = m[1]
			break
		}
	}
	if uuid == "" {
		return nil, fmt.Errorf("微信二维码 uuid 缺失")
	}
	key := url.Values{}
	key.Set("type", "wx")
	key.Set("uuid", uuid)
	key.Set("state", state)
	return map[string]any{
		"source":     "qq",
		"login_type": "wx",
		"key":        key.Encode(),
		"image_mode": "url",
		"image_url":  "https://open.weixin.qq.com/connect/qrcode/" + uuid,
		"expires_in": 300,
	}, nil
}

func qqPollWXQR(key string) (any, error) {
	values, _ := url.ParseQuery(key)
	uuid := values.Get("uuid")
	if uuid == "" {
		return nil, fmt.Errorf("缺少 uuid")
	}
	params := url.Values{}
	params.Set("uuid", uuid)
	params.Set("_", strconv.FormatInt(time.Now().UnixMilli(), 10))
	status, body, _ := qqGet(qqWXCheck+"?"+params.Encode(), qqWXConnect, "")
	if status == 0 {
		return nil, fmt.Errorf("网络错误")
	}
	code, wxCode := "", ""
	if m := regexp.MustCompile(`wx_errcode\s*=\s*'?([0-9]+)'?`).FindStringSubmatch(body); len(m) > 1 {
		code = m[1]
	}
	if m := regexp.MustCompile(`wx_code\s*=\s*["']([^"']*)["']`).FindStringSubmatch(body); len(m) > 1 {
		wxCode = m[1]
	}
	stMap := map[string]string{"405": "success", "408": "waiting", "404": "expired", "402": "expired"}
	st := stMap[code]
	if st == "" {
		st = "failed"
	}
	result := map[string]any{"status": st, "code": code, "login_type": "wx"}
	if st != "success" {
		return result, nil
	}
	if wxCode == "" {
		result["status"] = "failed"
		result["message"] = "微信授权码缺失"
		return result, nil
	}
	// 用 wx_code 换 QQ 音乐 cookie
	payload := map[string]any{
		"comm": map[string]any{"tmeAppID": "qqmusic", "tmeLoginType": "1", "g_tk": 5381, "platform": "yqq", "ct": 24, "cv": 0},
		"req": map[string]any{
			"module": "music.login.LoginServer", "method": "Login",
			"param": map[string]string{"strAppid": qqWXAppID, "code": wxCode},
		},
	}
	pj, _ := json.Marshal(payload)
	resp, err := hostCall(hostCallRequest{
		Method: "POST", Path: "https://u.y.qq.com/cgi-bin/musicu.fcg",
		Headers:    map[string]string{"content-type": "application/json", "user-agent": chromeUA, "referer": "https://y.qq.com/"},
		BodyBase64: base64.StdEncoding.EncodeToString(pj),
	})
	if err != nil {
		result["status"] = "failed"
		result["message"] = err.Error()
		return result, nil
	}
	jar := map[string]string{}
	if sc, ok := resp.Headers["set-cookie"]; ok {
		for _, line := range sc {
			for _, seg := range strings.Split(line, ", ") {
				kv := strings.SplitN(seg, "=", 2)
				if len(kv) == 2 {
					jar[strings.TrimSpace(kv[0])] = strings.SplitN(kv[1], ";", 2)[0]
				}
			}
		}
	}
	if jar["uin"] == "" {
		if jar["wxuin"] != "" {
			jar["uin"] = jar["wxuin"]
		}
	}
	if jar["qqmusic_key"] == "" {
		for _, k := range []string{"p_skey", "skey", "musickey"} {
			if jar[k] != "" {
				jar["qqmusic_key"] = jar[k]
				break
			}
		}
	}
	saveSessionCookies("qq", jar)
	result["logged_in"] = true
	return result, nil
}

func qqSearch(query string, page int) (any, error) {
	params := url.Values{}
	params.Set("w", query)
	params.Set("format", "json")
	params.Set("p", strconv.Itoa(page))
	params.Set("n", "20")
	resp, err := hostCall(hostCallRequest{
		Method:  "GET",
		Path:    "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?" + params.Encode(),
		Headers: map[string]string{"user-agent": chromeUA, "referer": "https://y.qq.com/", "cookie": qqCookieHeader()},
	})
	if err != nil {
		return nil, err
	}
	body, _ := decodeBody(resp)
	var out struct {
		Data struct {
			Song struct {
				List []struct {
					SongID   int64  `json:"songid"`
					SongMID  string `json:"songmid"`
					SongName string `json:"songname"`
					Album    string `json:"albumname"`
					Interval int    `json:"interval"`
					SizeFLAC int64  `json:"sizeflac"`
					Size320  int64  `json:"size320"`
					Size128  int64  `json:"size128"`
					Singer   []struct {
						Name string `json:"name"`
					} `json:"singer"`
				} `json:"list"`
			} `json:"song"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("搜索解析失败: %w", err)
	}
	songs := []map[string]any{}
	for _, s := range out.Data.Song.List {
		artists := []string{}
		for _, a := range s.Singer {
			artists = append(artists, a.Name)
		}
		quality := "128"
		if s.SizeFLAC > 0 {
			quality = "flac"
		} else if s.Size320 > 0 {
			quality = "320"
		}
		songs = append(songs, map[string]any{
			"id": s.SongMID, "name": s.SongName, "singers": strings.Join(artists, "/"),
			"album": s.Album, "duration_s": s.Interval, "source": "qq", "quality": quality,
		})
	}
	return map[string]any{"songs": songs, "page": page}, nil
}

// qqSongURL 音质阶梯: VIP 母带→…→128; 文件名 = 前缀+mid+mid+扩展名
func qqSongURL(mid string) (url string, ext string, prefix string, err error) {
	type pref struct {
		code string
		ext  string
	}
	ladder := []pref{{"AI00", "flac"}, {"Q001", "flac"}, {"Q000", "flac"}, {"F000", "flac"}, {"M800", "mp3"}, {"M500", "mp3"}}
	guid := fmt.Sprintf("%d", time.Now().UnixNano()%1e10)
	var filenames []string
	for _, p := range ladder {
		filenames = append(filenames, p.code+mid+mid+"."+p.ext)
	}
	req := map[string]any{
		"comm": map[string]any{"uin": qqCookieUin(), "format": "json", "ct": 20, "cv": 0},
		"req_1": map[string]any{
			"module": "music.vkey.GetVkey", "method": "UrlGetVkey",
			"param": map[string]any{
				"guid": guid, "songmid": []string{mid}, "songtype": []int{0},
				"uin": qqCookieUin(), "loginflag": 1, "platform": "20", "filename": filenames,
			},
		},
	}
	rj, _ := json.Marshal(req)
	resp, err := hostCall(hostCallRequest{
		Method: "POST", Path: "https://u.y.qq.com/cgi-bin/musicu.fcg",
		Headers: map[string]string{
			"content-type": "application/json", "user-agent": chromeUA,
			"referer": "https://y.qq.com/", "cookie": qqCookieHeader(),
		},
		BodyBase64: base64.StdEncoding.EncodeToString(rj),
	})
	if err != nil {
		return "", "", "", err
	}
	body, _ := decodeBody(resp)
	var out struct {
		Req1 struct {
			Data struct {
				MidUrlInfo []struct {
					PURL string `json:"purl"`
					VKey string `json:"vkey"`
				} `json:"midurlinfo"`
			} `json:"data"`
		} `json:"req_1"`
	}
	if json.Unmarshal(body, &out) != nil {
		return "", "", "", fmt.Errorf("QQ 取链解析失败")
	}
	for i, info := range out.Req1.Data.MidUrlInfo {
		if strings.HasPrefix(info.PURL, "http") {
			return info.PURL, ladder[i].ext, ladder[i].code, nil
		}
	}
	return "", "", "", fmt.Errorf("所有音质均未获取到链接（需要绿钻且歌曲有对应音源）")
}

func qqCookieUin() string {
	st := loadState()
	if c, ok := st.Sessions["qq"]; ok {
		if u, ok := c["uin"]; ok {
			return strings.TrimPrefix(strings.TrimPrefix(u, "o"), "0")
		}
	}
	return "0"
}
