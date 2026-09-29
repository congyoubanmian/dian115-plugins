# 测试夹具

| 文件 | 来源 | 采集时间 | 说明 |
|------|------|----------|------|
| `state_val.json` | 宿主 `plugin_kv.state` 键的原文 | 2026-09-29 | 榜单快照(5 个榜, 107 条)、观察队列(109 条)、想看列表、账号配置 |
| `wish_movie.json` | 豆瓣 `kind=mark&type=movie` 想看接口原文 | 2026-09-29 | 3 条, 全是电影 |
| `wish_tv.json` | 豆瓣 `kind=mark&type=tv` 想看接口原文 | 2026-09-29 | 4 条: 混进 1 条 book(它的 `year` 键缺失), 其余字段原样保留(压缩成单行) |
| `cookiecloud_vectors.json` | **脱敏构造**的 CookieCloud 解密回归向量(非线上抓取) | 2026-09-29 | legacy ×3 + `aes-128-cbc-fixed` ×1 + 非 JSON 明文 ×1, 外加错误口令/篡改/非法格式反例 |
| `chart_listcont2.html` | `https://movie.douban.com/chart` | 2026-09-29 | 只摘取 `<ul class="content" id="listCont2">` 一段(10 条口碑榜, 含锚点与 `</ul>` 收口) |
| `coming_showing_soon.html` | `https://movie.douban.com/cinema/later/`(302 → `/cinema/later/<城市>/`) | 2026-09-29 | 只摘取 `<div id="showing-soon">` 起的 6 个 `<div class="item mod...">` |
| `search_subjects.json` | `https://movie.douban.com/j/search_subjects?type=movie&tag=热门&sort=recommend&page_limit=30&page_start=0` | 2026-09-29 | 截取前 6 条(原文 30 条), 其余字段原样保留 |

## 脱敏

- `state_val.json` / `wish_*.json` 里的 uid、CookieCloud 地址/UUID/密钥、手动 cookie
  **已全部替换或删除**: uid 一律 `123456789`, CookieCloud 口令换成 `uuid-test`/`key-test`,
  真实豆瓣登录 cookie 整段丢弃。仓库里不允许出现任何密钥或口令。
- 三份 HTML/JSON 榜单夹具是**公开页面**, 不含登录态: 抓取用的是匿名请求(带浏览器 UA 与
  `referer: https://movie.douban.com/`), 页面里没有任何 uid/token。
- `wish_*.json` 是公开的 `kind=mark` 接口响应: 响应体里没有 uid/登录态, 只需压缩成单行,
  未删字段(与采集时的原文逐字段一致)。
- `cookiecloud_vectors.json` 的明文是**编造的** cookie 数据: uid `123456789`, 各 cookie
  值是 `fake*`, CookieCloud 口令是 `cc-test-uuid` / `cc-test-pass`。密文由
  `openssl` 按 CookieCloud 的算法现场生成, 不含任何真实凭据。

## CookieCloud 向量夹具的生成

密钥材料固定为 `md5(uuid + "-" + password)` 的 hex 前 16 个字符(本例
`md5("cc-test-uuid-cc-test-pass")` → `3da15fcde08ae670`)。生成命令(明文写进
`plain.txt`, **不带结尾换行**):

```sh
# legacy: OpenSSL Salted + EVP_BytesToKey(md5, 1 轮) + AES-256-CBC + PKCS7
openssl enc -aes-256-cbc -md md5 -S 0011223344556677 -pass pass:3da15fcde08ae670 \
  -e -a -A -in plain.txt
# aes-128-cbc-fixed: key = 密钥材料, IV = 16 字节 0, 裸 base64(没有 Salted 头)
openssl enc -aes-128-cbc -K 33646131356663646530386165363730 \
  -iv 00000000000000000000000000000000 -e -a -A -in plain.txt
# 记录 key/iv(与夹具的 key_hex/iv_hex 对照, 证明 KDF 口径)
openssl enc -aes-256-cbc -md md5 -S 0011223344556677 -pass pass:3da15fcde08ae670 -P
```

`tampered_legacy_b64` / `tampered_fixed_b64` 是对应密文的**末字节取反**副本(解垫必然失败),
`wrong_password` 是错误口令, `unknown_format_b64`(长度够但没有 `Salted__` 头)与
`nonblock_b64`(解码后 10 字节)是格式守卫的反例。改夹具时必须同步重跑
`tests/cookiecloud_vectors.rs`: 它对每条向量做"独立复算 key/iv → 解密逐字节等于明文 →
用同一 key/iv 重新加密逐字节等于密文"三环核对。

## 榜单夹具的用法

`chart_listcont2.html` 与 `coming_showing_soon.html` 都被原样喂给
`Runtime::fetch_chart` / `Runtime::fetch_coming`(见 `src/charts.rs` 的 `mod tests`),
页面第一行的 `<!-- fixture: ... -->` 注释是采集说明, 不含任何会被榜单正则命中的标签。

`src/charts.rs` 测试里硬编码的期望值(标题/排名/想看数/海报地址)是**用与 Go 正则逐字
相同的模式独立跑出来的捕获组**: 本环境没有 Go 工具链(`which go` 无输出), 因此把
`reLiClear`/`reName`/`reNo`/`reItemMod`/`reItemSubj`/`reItemImg`/`reWant` 逐条搬到
另一个独立实现上, 对同一份夹具求捕获组, 再把结果写死进用例 —— 换实现重跑时, 夹具与
期望值要一起更新。
