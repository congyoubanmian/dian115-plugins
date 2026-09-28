// CookieCloud 客户端: 拉取浏览器同步的加密 cookie 并解出豆瓣登录态。
// 协议: GET {server}/get/{uuid} → {encrypted, crypto_type}
//   legacy           → "U2FsdGVkX1"(OpenSSL Salted) + EVP_BytesToKey(md5) AES-256-CBC
//   aes-128-cbc-fixed→ base64 密文, key=md5(uuid-password)[:16], IV=16 字节 0
// 两种模式的口令/密钥都是 md5(uuid + "-" + password).hexdigest() 前 16 字符。

package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

type cookieCloudResult struct {
	Encrypted  string `json:"encrypted"`
	CryptoType string `json:"crypto_type"`
}

// cookieCloudPull 拉取并解密, 返回 cookie_data 域名表。
func (r *runtime) cookieCloudPull(server, uuid, key string) (map[string]json.RawMessage, error) {
	server = strings.TrimRight(strings.TrimSpace(server), "/")
	uuid = strings.TrimSpace(uuid)
	if server == "" || uuid == "" {
		return nil, fmt.Errorf("CookieCloud 地址或 UUID 未配置")
	}
	body, status, err := r.httpGet(server+"/get/"+url.PathEscape(uuid), "application/json")
	if err != nil {
		return nil, fmt.Errorf("CookieCloud 不可达: %w", err)
	}
	if status == 200 && strings.Contains(string(body), "Not Found") {
		return nil, fmt.Errorf("CookieCloud 无此 UUID 数据（浏览器扩展还没同步过）")
	}
	if status >= 400 {
		return nil, fmt.Errorf("CookieCloud HTTP %d: %s", status, trunc(body))
	}
	var res cookieCloudResult
	if err := json.Unmarshal(body, &res); err != nil || res.Encrypted == "" {
		return nil, fmt.Errorf("CookieCloud 响应异常（UUID 不存在或服务端版本过旧）")
	}
	plain, err := cookieCloudDecrypt(res.Encrypted, res.CryptoType, uuid, key)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		CookieData map[string]json.RawMessage `json:"cookie_data"`
	}
	if err := json.Unmarshal(plain, &parsed); err != nil {
		return nil, fmt.Errorf("CookieCloud 解密后解析失败: %v", err)
	}
	return parsed.CookieData, nil
}

func ccKeyMaterial(uuid, password string) []byte {
	sum := md5.Sum([]byte(uuid + "-" + password))
	hexKey := hex.EncodeToString(sum[:])
	return []byte(hexKey[:16])
}

func cookieCloudDecrypt(encrypted, cryptoType, uuid, password string) ([]byte, error) {
	material := ccKeyMaterial(uuid, password)
	if cryptoType == "aes-128-cbc-fixed" {
		raw, err := base64.StdEncoding.DecodeString(encrypted)
		if err != nil {
			return nil, fmt.Errorf("密文 base64 解码失败: %w", err)
		}
		return aesCBCDecrypt(raw, material, make([]byte, 16))
	}
	// legacy: OpenSSL Salted 格式
	raw, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil {
		return nil, fmt.Errorf("密文 base64 解码失败: %w", err)
	}
	if len(raw) < 32 || string(raw[:8]) != "Salted__" {
		return nil, fmt.Errorf("未知密文格式")
	}
	salt := raw[8:16]
	key, iv := evpBytesToKey(material, salt)
	return aesCBCDecrypt(raw[16:], key, iv)
}

// evpBytesToKey OpenSSL 兼容 KDF (MD5, 1 轮): 产出 32B key + 16B iv。
func evpBytesToKey(passphrase, salt []byte) (key, iv []byte) {
	var prev []byte
	var out []byte
	for len(out) < 48 {
		h := md5.New()
		h.Write(prev)
		h.Write(passphrase)
		h.Write(salt)
		prev = h.Sum(nil)
		out = append(out, prev...)
	}
	return out[:32], out[32:48]
}

func aesCBCDecrypt(data, key, iv []byte) ([]byte, error) {
	if len(key) != 16 && len(key) != 32 {
		return nil, fmt.Errorf("非法密钥长度 %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("密文长度非法 (%d)", len(data))
	}
	plain := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, data)
	// PKCS7 去填充
	pad := int(plain[len(plain)-1])
	if pad < 1 || pad > aes.BlockSize || pad > len(plain) {
		return nil, fmt.Errorf("填充校验失败（密钥不对或数据损坏）")
	}
	for _, b := range plain[len(plain)-pad:] {
		if int(b) != pad {
			return nil, fmt.Errorf("填充校验失败（密钥不对或数据损坏）")
		}
	}
	return plain[:len(plain)-pad], nil
}

// doubanCookieFromCloud 从 cookie_data 提取豆瓣 cookie 头与 uid。
// 新版格式 cookie_data[domain] 是 [{name,value,...}] 数组, 旧版是 {name:value}。
func doubanCookieFromCloud(cookieData map[string]json.RawMessage) (header, uid string, count int) {
	jar := map[string]string{}
	type ccCookie struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}
	for domain, raw := range cookieData {
		if !strings.Contains(domain, "douban.com") {
			continue
		}
		var list []ccCookie
		if err := json.Unmarshal(raw, &list); err == nil && list != nil {
			for _, c := range list {
				if c.Name != "" && c.Value != "" {
					if _, ok := jar[c.Name]; !ok {
						jar[c.Name] = c.Value
					}
				}
			}
			continue
		}
		var m map[string]string
		if err := json.Unmarshal(raw, &m); err == nil {
			for k, v := range m {
				if _, ok := jar[k]; !ok {
					jar[k] = v
				}
			}
		}
	}
	dbcl2 := jar["dbcl2"]
	if dbcl2 == "" {
		return "", "", len(jar)
	}
	// CookieCloud 保存的值可能带引号(dbcl2="123:token"), 拼 URL 前要去掉。
	uid = strings.Trim(strings.SplitN(dbcl2, ":", 2)[0], `"`)
	var parts []string
	for k, v := range jar {
		parts = append(parts, k+"="+v)
	}
	return strings.Join(parts, "; "), uid, len(jar)
}
