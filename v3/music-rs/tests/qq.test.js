// QQ 纯逻辑向量测试 —— 取链部分对齐参考项目 Lilt（mygo-qyin/internal/qqmusic）。
// 扫码登录部分对齐同一参考项目的 internal/qqmusic/auth.go + auth_response.go：
// 参数（Go url.Values.Encode 排序）、hash33 带种子、严格 ptuiCB 解析、重定向白名单、
// OAuth 授权表单与 QQLogin 响应解析。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QUALITY_LADDER, qualityStart, qualityLadder, qualityFilename, qrShowT, qrShowParams, qrLoginParams,
  wxLoginParams, wxCheckParams, searchParams, guidFromNanos, songUrlRequestBody,
  songDetailRequestBody, parseQqSongDetail, resolveStreamUrl,
  wxLoginPayload, parseJsArgs, qqStatusOf, wxStatusOf, parseWxErrcode, parseWxCode,
  extractWxUuid, loginKindOf, parseVkeyResponse, parseSearch, NO_LINK_ERROR, QR_UNAVAILABLE,
  QQ_STREAM_FALLBACK_DOMAIN,
  hash33Seed, ptqrShowParams, ptqrShowUrl, ptqrLoginParams, ptqrLoginUrl, parsePtui,
  parseQqQrStatus, trustedLoginUrl, authorizeForm, parseAuthorizeRedirect, qqLoginRequestBody,
  parseQQLoginResponse, randomHex, randomUuid, isPng, base64Bytes, QQ_QR_UNKNOWN_STATUS,
} from '../lib/qq.js'

test('quality ladder matches the reference client (F000/M800/M500)', () => {
  assert.deepEqual(QUALITY_LADDER, [
    ['F000', 'flac'], ['M800', 'mp3'], ['M500', 'mp3'],
  ])
})

test('quality ladder slices by user level; anonymous only gets 128k', () => {
  assert.equal(qualityStart('master'), 0)
  assert.equal(qualityStart('flac'), 0)
  assert.equal(qualityStart('320'), 1)
  assert.equal(qualityStart('128'), 2)
  assert.equal(qualityStart('bogus'), null)
  assert.equal(qualityLadder('master'), QUALITY_LADDER)
  assert.equal(qualityLadder('bogus'), QUALITY_LADDER)
  assert.equal(qualityLadder(''), QUALITY_LADDER)
  assert.deepEqual(qualityLadder('flac'), QUALITY_LADDER)
  assert.deepEqual(qualityLadder('320'), QUALITY_LADDER.slice(1))
  assert.deepEqual(qualityLadder('128'), [['M500', 'mp3']])
  assert.deepEqual(qualityLadder('master', false), [['M500', 'mp3']], '匿名只请求 M500')
})

test('qrShowT matches Go %.17f', () => {
  assert.equal(qrShowT(123_456_789), '0.00000000012345679')
  assert.equal(qrShowT(1_759_291_234_567_890_123n), '1.75929123456789016')
})

test('qrShowParams is the exact sorted query', () => {
  assert.equal(
    qrShowParams(1_759_291_234_567_890_123n),
    'appid=716027609&d=72&daid=383&e=2&l=M&pt_3rd_aid=100497308&s=3&t=1.75929123456789016&v=4',
  )
})

test('qrLoginParams uses ptqrtoken=hash33(qrsig)', () => {
  assert.equal(
    qrLoginParams('AbCdEf123456', 1_759_291_234_567),
    'action=0-0-1759291234567&aid=716027609&daid=383&from_ui=1&g=1&h=1&has_onekey=1&js_type=1&js_ver=21072115&login_sig=&nodirect=0&pt_3rd_aid=100497308&pt_uistyle=40&ptlang=2052&ptqrtoken=1510816170&ptredirect=100&pttype=1&service=ptqrlogin&t=1&u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump',
  )
})

test('wx params are exact', () => {
  assert.equal(
    wxLoginParams('musicdl-1759291234567890123'),
    'appid=wx48db31d50e334801&href=https%3A%2F%2Fy.qq.com%2Fmediastyle%2Fmusic_v17%2Fsrc%2Fcss%2Fpopup_wechat.css%23wechat_redirect&redirect_uri=https%3A%2F%2Fy.qq.com%2Fportal%2Fwx_redirect.html%3Flogin_type%3D2%26surl%3Dhttps%3A%2F%2Fy.qq.com%2F&response_type=code&scope=snsapi_login&state=musicdl-1759291234567890123',
  )
  assert.equal(wxCheckParams('AbC-123_x', 1_759_291_234_567), '_=1759291234567&uuid=AbC-123_x')
})

test('search params encode Chinese with + for space', () => {
  assert.equal(
    searchParams('周杰伦 稻香', 2),
    'format=json&n=20&p=2&w=%E5%91%A8%E6%9D%B0%E4%BC%A6+%E7%A8%BB%E9%A6%99',
  )
  assert.equal(searchParams('', 1), 'format=json&n=20&p=1&w=')
})

test('songUrlRequestBody builds logged-in and anonymous bodies', () => {
  assert.equal(guidFromNanos(1_759_291_234_567_890_123n), '4567890123')
  assert.equal(qualityFilename('F000', 'flac', '001Qu4I30eVFYb', 'MEDIA'), 'F000001Qu4I30eVFYbMEDIA.flac')
  const auth = songUrlRequestBody({
    mid: '001Qu4I30eVFYb', mediaMid: 'MEDIA', guid: '4567890123',
    code: 'F000', ext: 'flac', uin: '012345678', musicKey: '@K', loginType: 1,
  })
  assert.equal(
    auth,
    '{"comm":{"authst":"@K","chid":"10003505","ct":11,"cv":14090008,"qq":"012345678","tmeAppID":"qqmusic","tmeLoginType":1,"v":14090008},"req_0":{"method":"UrlGetVkey","module":"music.vkey.GetVkey","param":{"ctx":0,"filename":["F000001Qu4I30eVFYbMEDIA.flac"],"guid":"4567890123","songmid":["001Qu4I30eVFYb"],"songtype":[0],"uin":"012345678"}}}',
  )
  const anon = songUrlRequestBody({
    mid: '001Qu4I30eVFYb', mediaMid: '', guid: '4567890123',
    code: 'M500', ext: 'mp3', uin: '', musicKey: '', loginType: 1,
  })
  assert.equal(
    anon,
    '{"comm":{"ct":24,"cv":0},"req_0":{"method":"CgiGetVkey","module":"vkey.GetVkeyServer","param":{"filename":["M500001Qu4I30eVFYb001Qu4I30eVFYb.mp3"],"guid":"4567890123","loginflag":1,"platform":"20","songmid":["001Qu4I30eVFYb"],"songtype":[0],"uin":"0"}}}',
  )
})

test('song detail body and parser expose media_mid and sizes', () => {
  const body = songDetailRequestBody('MID')
  assert.match(body, /"module":"music\.pf_song_detail_svr"/)
  assert.match(body, /"method":"get_song_detail_yqq"/)
  const parsed = parseQqSongDetail('{"req_0":{"data":{"track_info":{"mid":"MID","file":{"media_mid":"MM","size_flac":11,"size_320mp3":22,"size_128mp3":33}}}}}')
  assert.deepEqual(parsed.value, { media_mid: 'MM', size128: 33, size320: 22, size_flac: 11 })
  assert.equal(parseQqSongDetail('{"req_0":{"data":{}}}').error, 'QQ 歌曲详情解析失败')
  assert.equal(parseQqSongDetail('oops').error, 'QQ 歌曲详情解析失败')
})

test('wxLoginPayload matches Go shape with tmeLoginType "1"', () => {
  assert.equal(
    wxLoginPayload('CODE-1'),
    '{"comm":{"ct":24,"cv":0,"g_tk":5381,"platform":"yqq","tmeAppID":"qqmusic","tmeLoginType":"1"},"req":{"method":"Login","module":"music.login.LoginServer","param":{"code":"CODE-1","strAppid":"wx48db31d50e334801"}}}',
  )
})

test('parseJsArgs reads ptuiCB arguments including empty strings', () => {
  assert.deepEqual(
    parseJsArgs("ptuiCB('0','0','https://graph.qq.com/oauth2.0/check_sig?uin=123&sig=abc','0','登录成功', '昵称')"),
    ['0', '0', 'https://graph.qq.com/oauth2.0/check_sig?uin=123&sig=abc', '0', '登录成功', '昵称'],
  )
  assert.deepEqual(parseJsArgs("ptuiCB('66','0','','0','','')"), ['66', '0', '', '0', '', ''])
  assert.deepEqual(parseJsArgs("ptuiCB('0','0'"), ['0', '0'])
  assert.deepEqual(parseJsArgs("ptuiCB('0','0"), ['0'])
  assert.deepEqual(parseJsArgs('no quotes here'), [])
})

test('status maps match Go', () => {
  assert.equal(qqStatusOf('0'), 'success')
  assert.equal(qqStatusOf('65'), 'expired')
  assert.equal(qqStatusOf('66'), 'waiting')
  assert.equal(qqStatusOf('67'), 'scanned')
  assert.equal(qqStatusOf('1'), 'failed')
  assert.equal(qqStatusOf(''), 'failed')
  assert.equal(wxStatusOf('405'), 'success')
  assert.equal(wxStatusOf('408'), 'waiting')
  assert.equal(wxStatusOf('404'), 'expired')
  assert.equal(wxStatusOf('402'), 'expired')
  assert.equal(wxStatusOf(''), 'failed')
})

test('wx errcode/code regex equivalents', () => {
  assert.equal(parseWxErrcode("window.wx_errcode=405;window.wx_code='CODE-1';"), '405')
  assert.equal(parseWxErrcode("wx_errcode = '408';"), '408')
  assert.equal(parseWxErrcode('wx_errcodeXX; wx_errcode=402;'), '402')
  assert.equal(parseWxErrcode('nothing here'), null)
  assert.equal(parseWxCode("window.wx_errcode=405;window.wx_code='CODE-1';"), 'CODE-1')
  assert.equal(parseWxCode('wx_code = ""'), '')
  assert.equal(parseWxCode('wx_code'), null)
})

test('wx uuid extraction tries three patterns in order', () => {
  assert.equal(
    extractWxUuid('<script src="https://open.weixin.qq.com/connect/l/qrconnect?uuid=Ab12Cd3E-"></script>'),
    'Ab12Cd3E-',
  )
  assert.equal(extractWxUuid('window.QRLogin.uuid = "UuidFromJs";'), 'UuidFromJs')
  assert.equal(extractWxUuid('img src="/connect/qrcode/UuidFromImg"'), 'UuidFromImg')
  assert.equal(extractWxUuid('<html>no uuid here</html>'), null)
})

test('loginKindOf reads type=wx', () => {
  assert.equal(loginKindOf('type=wx&uuid=U1'), 'wx')
  assert.equal(loginKindOf('qrsig=Ab12Cd3-'), 'qq')
  assert.equal(loginKindOf(''), 'qq')
})

test('parseVkeyResponse joins relative purl with sip and falls back to dl.stream', () => {
  const body = '{"req_0":{"data":{"sip":["http://isure.stream.qqmusic.qq.com/"],"midurlinfo":[{"songmid":"M","purl":"M800MIDMEDIA.mp3?vkey=1"}]}}}'
  const parsed = parseVkeyResponse(body, 'M800', 'mp3')
  assert.equal(parsed.url, 'http://isure.stream.qqmusic.qq.com/M800MIDMEDIA.mp3?vkey=1')
  assert.equal(parsed.ext, 'mp3')
  assert.equal(parsed.level, 'M800')
  // 绝对 purl 原样返回。
  const absolute = '{"req_0":{"data":{"midurlinfo":[{"purl":"https://dl.stream.qqmusic.qq.com/F000.flac?vkey=2"}]}}}'
  assert.equal(parseVkeyResponse(absolute, 'F000', 'flac').url, 'https://dl.stream.qqmusic.qq.com/F000.flac?vkey=2')
  // sip 缺失/非法 → 兜底域名。
  assert.equal(
    parseVkeyResponse('{"req_0":{"data":{"sip":["http://evil.example/"],"midurlinfo":[{"purl":"M500.mp3"}]}}}', 'M500', 'mp3').url,
    `${QQ_STREAM_FALLBACK_DOMAIN}M500.mp3`,
  )
  // 首选非 ws 域名。
  assert.equal(
    resolveStreamUrl(['http://ws.stream.qqmusic.qq.com/', 'http://isure.stream.qqmusic.qq.com/'], 'a.mp3'),
    'http://isure.stream.qqmusic.qq.com/a.mp3',
  )
  const empty = '{"req_0":{"data":{"midurlinfo":[{"purl":""}]}}}'
  assert.equal(parseVkeyResponse(empty, 'M500', 'mp3').error, NO_LINK_ERROR)
  assert.equal(parseVkeyResponse('<html>502</html>', 'M500', 'mp3').error, 'QQ 取链解析失败')
  assert.equal(NO_LINK_ERROR, '所有音质均未获取到链接（需要绿钻且歌曲有对应音源）')
  assert.equal(QR_UNAVAILABLE, 'QQ 扫码登录受宿主 broker 限制暂不可用，请使用手动粘贴 Cookie')
})

test('parseSearch maps qq songs like Go', () => {
  const body = '{"code":0,"data":{"song":{"list":[{"songid":4830702,"songmid":"003aAYrm3GE0Xg","songname":"晴天","albumname":"叶惠美","interval":269,"sizeflac":0,"size320":9434136,"size128":4307652,"singer":[{"name":"周杰伦"},{"name":"杨瑞代"}]}]}}}'
  const parsed = parseSearch(body, 1)
  assert.ok(!parsed.error)
  const { songs, page } = parsed.value
  assert.equal(page, 1)
  assert.equal(songs[0].id, '003aAYrm3GE0Xg')
  assert.equal(songs[0].name, '晴天')
  assert.equal(songs[0].singers, '周杰伦/杨瑞代')
  assert.equal(songs[0].album, '叶惠美')
  assert.equal(songs[0].duration_s, 269)
  assert.equal(songs[0].source, 'qq')
  assert.equal(songs[0].quality, '320')
  assert.match(parseSearch('not json', 1).error, /^搜索解析失败: /)
})

// ─────────────────── QQ 扫码登录纯逻辑（参考实现 auth.go / auth_response.go）───────────────────

test('hash33Seed matches the reference vectors (Go hash33(s, initial))', () => {
  assert.equal(hash33Seed('AbCdEf123456', 0), 1510816170)
  assert.equal(hash33Seed('fake-pskey', 5381), 74200821)
  assert.equal(hash33Seed('fake-pskey', 0), 1321097136)
  assert.equal(hash33Seed('AbCdEf123456', 5381), 850394671)
  assert.equal(hash33Seed('AbCdEf123456'), 1510816170, '默认种子 0 与旧 hash33 同值')
})

test('ptqrshow query is the exact sorted string with u1', () => {
  assert.equal(
    ptqrShowParams('a1b2c3d4e5f60718'),
    'appid=716027609&d=72&daid=383&e=2&l=M&pt_3rd_aid=100497308&s=3&t=a1b2c3d4e5f60718&u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&v=4',
  )
  assert.equal(
    ptqrShowUrl('a1b2c3d4e5f60718'),
    `https://xui.ptlogin2.qq.com/ssl/ptqrshow?${ptqrShowParams('a1b2c3d4e5f60718')}`,
  )
})

test('ptqrlogin query carries ptqrtoken=hash33(qrsig)', () => {
  assert.equal(
    ptqrLoginParams('AbCdEf123456'),
    'aid=716027609&daid=383&from_ui=1&pt_3rd_aid=100497308&ptqrtoken=1510816170&u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump',
  )
  assert.ok(ptqrLoginUrl('AbCdEf123456').startsWith('https://xui.ptlogin2.qq.com/ssl/ptqrlogin?'))
})

test('parsePtui accepts the reference status strings', () => {
  assert.deepEqual(
    parsePtui("ptuiCB('66','0','','0','二维码未失效。', '')").values,
    ['66', '0', '', '0', '二维码未失效。', ''],
  )
  assert.deepEqual(
    parsePtui("ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')").values,
    ['0', '0', 'https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake', '0', 'ok', 'nick'],
  )
  assert.equal(parsePtui("ptuiCB('0','0','u','0','m','n','o')").values.length, 7, '7 个参数也接受')
  // 转义：\' \\ \n \r \t \xNN \uNNNN
  assert.deepEqual(
    parsePtui("ptuiCB('67','0','','0','it\\'s scanned','\\u4f60\\x21');").values,
    ['67', '0', '', '0', "it's scanned", '你!'],
  )
})

test('parsePtui rejects malformed or injected responses', () => {
  const bad = [
    'alert(1)',
    "ptuiCB('66')",
    "ptuiCB('66','0','','0','waiting','');alert(1)",
    "ptuiCB('66','0','','0','waiting','',)",
    "ptuiCB('66','0','','0','waiting','','x','y')",
    'ptuiCB(66)',
    '',
    '   ',
  ]
  for (const body of bad) {
    assert.equal(parsePtui(body).error, QQ_QR_UNKNOWN_STATUS, body)
  }
})

test('parseQqQrStatus maps the QQ status codes', () => {
  assert.equal(parseQqQrStatus("ptuiCB('66','0','','0','二维码未失效。','')").status, 'waiting')
  const scanned = parseQqQrStatus("ptuiCB('67','0','','0','x','')")
  assert.equal(scanned.status, 'scanned')
  assert.match(scanned.message, /手机 QQ/)
  assert.equal(parseQqQrStatus("ptuiCB('65','0','','0','x','')").status, 'expired')
  const ok = parseQqQrStatus("ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake','0','ok','nick')")
  assert.equal(ok.status, 'success')
  assert.equal(ok.check_sig, 'https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=fake')
  const failed = parseQqQrStatus("ptuiCB('1','0','','0','二维码错误','')")
  assert.equal(failed.status, 'failed')
  assert.equal(failed.message, '二维码错误', '服务端文案原样带回')
  assert.ok(parseQqQrStatus('').error, '空响应单独归类，不退化成等待中')
})

test('trustedLoginUrl only accepts the whitelisted host and path', () => {
  assert.ok(trustedLoginUrl('https://ssl.ptlogin2.graph.qq.com/check_sig?ptsigx=1', 'ssl.ptlogin2.graph.qq.com', '/check_sig'))
  const bad = [
    'https://evil.test/check_sig',
    'http://ssl.ptlogin2.graph.qq.com/check_sig',
    'https://ssl.ptlogin2.graph.qq.com:443/check_sig',
    'https://ssl.ptlogin2.graph.qq.com/check_sig/other',
    'https://u:p@ssl.ptlogin2.graph.qq.com/check_sig',
    'https://ssl.ptlogin2.graph.qq.com/check_sig#frag',
    'https://graph.qq.com/check_sig',
    'not a url',
    '',
  ]
  for (const raw of bad) {
    assert.equal(trustedLoginUrl(raw, 'ssl.ptlogin2.graph.qq.com', '/check_sig'), null, raw)
  }
})

test('authorizeForm is the exact sorted form body', () => {
  assert.equal(
    authorizeForm({
      state: '0123456789abcdef0123456789abcdef',
      ui: '01234567-89ab-cdef-0123-456789abcdef',
      gTk: 74200821,
      authTime: 1759291234567,
    }),
    'auth_time=1759291234567&client_id=100497308&from_ptlogin=1&g_tk=74200821&openapi=1010_1030&redirect_uri=https%3A%2F%2Fy.qq.com%2Fportal%2Fwx_redirect.html%3Flogin_type%3D1%26surl%3Dhttps%3A%2F%2Fy.qq.com%2F&response_type=code&scope=get_user_info%2Cget_app_friends&src=1&state=0123456789abcdef0123456789abcdef&switch=&ui=01234567-89ab-cdef-0123-456789abcdef&update_auth=1',
  )
})

test('parseAuthorizeRedirect validates host, path, code and state', () => {
  const state = '0123456789abcdef0123456789abcdef'
  const code = 'A'.repeat(32)
  assert.equal(parseAuthorizeRedirect(`https://y.qq.com/portal/wx_redirect.html?code=${code}&state=${state}`, state).code, code)
  assert.ok(parseAuthorizeRedirect(`https://y.qq.com/portal/wx_redirect.html?code=${code}&state=wrong`, state).error)
  assert.ok(parseAuthorizeRedirect(`https://y.qq.com/portal/wx_redirect.html?code=short&state=${state}`, state).error)
  assert.ok(parseAuthorizeRedirect('https://evil.test/portal/wx_redirect.html?code=X&state=' + state, state).error)
  assert.ok(parseAuthorizeRedirect('https://y.qq.com/other?code=X&state=' + state, state).error)
  assert.ok(parseAuthorizeRedirect('http://y.qq.com/portal/wx_redirect.html?code=X&state=' + state, state).error)
  assert.ok(parseAuthorizeRedirect('https://y.qq.com/portal/wx_redirect.html?code=X&code=Y&state=' + state, state).error)
})

test('qqLoginRequestBody matches the reference JSON shape', () => {
  assert.equal(
    qqLoginRequestBody('ABCDEF0123456789ABCDEF0123456789'),
    '{"comm":{"ct":24,"cv":0,"g_tk":5381,"platform":"yqq"},"req":{"method":"QQLogin","module":"QQConnectLogin.LoginServer","param":{"code":"ABCDEF0123456789ABCDEF0123456789"}}}',
  )
})

test('parseQQLoginResponse accepts the reference payload', () => {
  const body = '{"code":0,"req":{"code":0,"data":{"musicid":10001,"musickey":"fake-musickey","loginType":2,"nick":"Listener","logo":"https://example.test/avatar"}}}'
  const parsed = parseQQLoginResponse(body)
  assert.equal(parsed.value.musicid, '10001')
  assert.equal(parsed.value.musickey, 'fake-musickey')
  assert.equal(parsed.value.loginType, 2)
  assert.equal(parsed.value.nick, 'Listener')
  // 数字字符串形态的 musicid / loginType 也接受。
  const text = parseQQLoginResponse('{"code":0,"req":{"code":0,"data":{"musicid":"10001","musickey":"k","loginType":"2"}}}')
  assert.equal(text.value.musicid, '10001')
  assert.equal(text.value.loginType, 2)
})

test('parseQQLoginResponse rejects incomplete or wrong payloads', () => {
  assert.match(parseQQLoginResponse('not json').error, /L201/)
  assert.match(parseQQLoginResponse('{"code":0}').error, /L202/)
  assert.match(parseQQLoginResponse('{"code":0,"req":{"code":1,"data":{}}}').error, /拒绝登录/)
  assert.match(parseQQLoginResponse('{"code":1,"req":{"code":0,"data":{}}}').error, /拒绝登录/)
  assert.match(parseQQLoginResponse('{"code":0,"req":{"code":0}}').error, /L203/)
  assert.match(parseQQLoginResponse('{"code":0,"req":{"code":0,"data":{"musickey":"k","loginType":2}}}').error, /L204/)
  assert.match(parseQQLoginResponse('{"code":0,"req":{"code":0,"data":{"musicid":0,"musickey":"k","loginType":2}}}').error, /L204/)
  assert.match(parseQQLoginResponse('{"code":0,"req":{"code":0,"data":{"musicid":10001,"loginType":2}}}').error, /L205/)
  assert.match(parseQQLoginResponse('{"code":0,"req":{"code":0,"data":{"musicid":10001,"musickey":"k","loginType":1}}}').error, /登录类型/)
})

test('random values have the expected shape', () => {
  assert.match(randomHex(8), /^[0-9a-f]{16}$/)
  assert.match(randomHex(16), /^[0-9a-f]{32}$/)
  assert.match(randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(randomHex(16), randomHex(16))
})

test('isPng checks the PNG magic', () => {
  assert.ok(isPng(base64Bytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64'))))
  assert.ok(!isPng(base64Bytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'))), 'JPEG 不是 PNG')
  assert.ok(!isPng(base64Bytes('')))
  assert.ok(!isPng(base64Bytes('not-base64!!')))
})
