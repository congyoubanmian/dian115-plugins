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
  // 歌单 / 每日推荐 / 我喜欢
  authenticatedComm, musicuRequestBody, numberField, ownedPlaylistsParam, favoritePlaylistsParam,
  dailySongsParam, likedSongsParam, publicPlaylistSongsParam, ownedPlaylistSongsParam,
  parseMusicuResponse, checkDissDataStatus, qqHasMore, qqCodeHint, mapQqPlaylist,
  parseQqPlaylistList, mapQqSong, parseQqSongList, parseQqPlaylistInfo, qqAlbumCover,
  qqTargetKind, QQ_DIR_ID_LIKED, QQ_DIR_ID_DAILY, QQ_FAV_PAGE_SIZE,
} from '../../music-rs/lib/qq.js'

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

// ─────────────────── QQ 歌单 / 每日推荐 / 我喜欢（musicu 纯逻辑）───────────────────
// 参数与解析对齐参考实现 Lilt（mygo-qyin/internal/qqmusic）：
// library.go:23-150（我创建的 / 收藏的 / 每日推荐 / 我喜欢）、
// catalog.go:114-214（公开与自建歌单的曲目分页）、client.go:101-165（信封与状态码）。

test('authenticatedComm matches the reference comm shape', () => {
  assert.deepEqual(authenticatedComm({ uin: '012345678', musicKey: '@K', loginType: 2 }), {
    ct: 11,
    cv: 14090008,
    v: 14090008,
    chid: '10003505',
    tmeAppID: 'qqmusic',
    qq: '012345678',
    authst: '@K',
    tmeLoginType: 2,
  })
  // 缺省值也要给出可用形状（空 authst 由调用方自己判断登录态）。
  assert.equal(authenticatedComm({}).qq, '')
  assert.equal(authenticatedComm({ loginType: 0 }).tmeLoginType, 1)
})

test('musicuRequestBody builds the comm + req_0 envelope', () => {
  const body = musicuRequestBody(
    authenticatedComm({ uin: '012345678', musicKey: '@K', loginType: 2 }),
    'music.musicasset.PlaylistBaseRead',
    'GetPlaylistByUin',
    { uin: '012345678' },
  )
  assert.equal(
    body,
    '{"comm":{"authst":"@K","chid":"10003505","ct":11,"cv":14090008,"qq":"012345678",' +
    '"tmeAppID":"qqmusic","tmeLoginType":2,"v":14090008},"req_0":{"method":"GetPlaylistByUin",' +
    '"module":"music.musicasset.PlaylistBaseRead","param":{"uin":"012345678"}}}',
  )
})

test('the four library params match the reference requests', () => {
  // 我创建的歌单：uin 是账号 musicid（参考实现 library.go:29）。
  assert.deepEqual(ownedPlaylistsParam('10001'), { uin: '10001' })
  // 收藏的歌单：uin 是 encryptUin，offset 是游标，size 固定 100（参考实现 library.go:75）。
  assert.deepEqual(favoritePlaylistsParam('ENC', 0, QQ_FAV_PAGE_SIZE), { uin: 'ENC', offset: 0, size: 100 })
  assert.deepEqual(favoritePlaylistsParam('ENC', 120), { uin: 'ENC', offset: 120, size: 100 })
  // 每日推荐：dirid=202（参考实现 library.go:102）。
  assert.deepEqual(dailySongsParam(), { dirid: 202, optype: 3, tag: 1, userinfo: 0, pic_dpi: 300 })
  // 我喜欢：dirid=201 + enc_host_uin（参考实现 library.go:126）。
  assert.deepEqual(likedSongsParam('ENC', 100, 100), {
    disstid: 0,
    dirid: 201,
    tag: true,
    song_begin: 100,
    song_num: 100,
    userinfo: true,
    orderlist: true,
    enc_host_uin: 'ENC',
  })
  // 公开歌单曲目（参考实现 catalog.go:184）。
  assert.deepEqual(publicPlaylistSongsParam(8003104149, 100, 100), {
    disstid: 8003104149,
    userinfo: 1,
    tag: 1,
    orderlist: 1,
    song_begin: 100,
    song_num: 100,
    onlysonglist: 0,
    enc_host_uin: '',
  })
  // 自建歌单曲目：必须带 enc_host_uin（参考实现 catalog.go:122）。
  assert.deepEqual(ownedPlaylistSongsParam(8003104149, 'ENC', 0, 100), {
    disstid: 8003104149,
    dirid: 0,
    tag: true,
    song_begin: 0,
    song_num: 100,
    userinfo: true,
    orderlist: true,
    enc_host_uin: 'ENC',
  })
})

test('numberField reads numbers and numeric strings', () => {
  assert.equal(numberField({ a: 12 }, 'a'), 12)
  assert.equal(numberField({ a: '12' }, 'a'), 12)
  assert.equal(numberField({ a: 'x' }, 'a'), 0)
  assert.equal(numberField({ a: 1.9 }, 'a'), 1)
  assert.equal(numberField({}, 'a', 'b'), 0)
  // 参考实现 client.go:282 number()：第一个能解析成整数的键就返回（0 也是有效值）。
  assert.equal(numberField({ a: 0, b: 7 }, 'a', 'b'), 0)
})

test('parseMusicuResponse checks both status levels', () => {
  const ok = parseMusicuResponse('{"code":0,"req_0":{"code":0,"data":{"v_playlist":[]}}}')
  assert.deepEqual(ok.value, { v_playlist: [] })
  // 信封层错误。
  assert.match(parseMusicuResponse('{"code":1,"req_0":{"code":0,"data":{}}}').error, /网关 1/)
  // req_0 层错误。
  const business = parseMusicuResponse('{"code":0,"req_0":{"code":80030,"data":{}}}')
  assert.match(business.error, /业务 80030/)
  assert.match(business.error, /未登录或登录态已失效/)
  // subcode 也要查。
  assert.match(parseMusicuResponse('{"code":0,"req_0":{"code":0,"subcode":80120,"data":{}}}').error, /业务 80120/)
  // 结构不对 / 没有数据都不当成功。
  assert.ok(parseMusicuResponse('not json').error)
  assert.ok(parseMusicuResponse('{"code":0}').error)
  assert.ok(parseMusicuResponse('{"code":0,"req_0":{"code":0}}').error)
  // 错误消息里只有状态码，不带任何响应尾段（响应里可能有账号信息）。
  const leaky = parseMusicuResponse('{"code":0,"req_0":{"code":80030,"data":{"msg":"secret-musickey-value"}}}')
  assert.ok(!leaky.error.includes('secret-musickey-value'))
  assert.ok(!leaky.error.includes('musickey'))
})

test('checkDissDataStatus reports the inner code of the DissInfo family', () => {
  assert.ok(!checkDissDataStatus({ code: 0 }).error)
  assert.ok(!checkDissDataStatus({ code: '0' }).error)
  assert.ok(!checkDissDataStatus({ v_playlist: [] }).error)
  assert.match(checkDissDataStatus({ code: -100008 }).error, /-100008/)
  assert.match(checkDissDataStatus({ subcode: 3 }).error, /subcode 3/)
  assert.match(checkDissDataStatus({ code: {} }).error, /不可解析/)
})

test('qqHasMore accepts the reference hasmore forms', () => {
  assert.ok(qqHasMore({ hasmore: 1 }))
  assert.ok(qqHasMore({ hasmore: '1' }))
  assert.ok(qqHasMore({ hasmore: true }))
  assert.ok(qqHasMore({ hasmore: 'true' }))
  assert.ok(!qqHasMore({ hasmore: 0 }))
  assert.ok(!qqHasMore({ hasmore: 'false' }))
  assert.ok(!qqHasMore({}))
})

test('mapQqPlaylist maps the reference fields and fallbacks', () => {
  const item = mapQqPlaylist({
    tid: 8003104149,
    dirName: '歌单名',
    bigpicUrl: 'https://cover/1.jpg',
    songNum: 110,
    nick: '创建者',
    dirId: 5,
    dirShow: 2,
  }, 'created')
  assert.equal(item.id, '8003104149')
  assert.equal(item.name, '歌单名')
  assert.equal(item.cover, 'https://cover/1.jpg')
  assert.equal(item.count, 110)
  assert.equal(item.creator, '创建者')
  assert.equal(item.kind, 'created')
  assert.equal(item.dirId, 5)
  assert.equal(item.private, true, 'dirShow=2 是私密歌单')
  // 回退顺序：dirName → dissname → title → name；封面与计数同理。
  const fallback = mapQqPlaylist({ dissid: 7, dissname: 'D', picurl: 'https://c/2.jpg', songnum: 3, nickname: 'N' }, 'fav')
  assert.equal(fallback.id, '7')
  assert.equal(fallback.name, 'D')
  assert.equal(fallback.cover, 'https://c/2.jpg')
  assert.equal(fallback.count, 3)
  assert.equal(fallback.creator, 'N')
  assert.equal(fallback.kind, 'fav')
  // 「我喜欢」伪歌单：没有可用的 tid，用 dirId 201 当标识。
  const liked = mapQqPlaylist({ tid: 12345, dirName: '我喜欢', dirId: 201, songNum: 300 }, 'created')
  assert.equal(liked.id, String(QQ_DIR_ID_LIKED))
  assert.equal(liked.kind, 'liked')
})

test('parseQqPlaylistList skips entries without an id', () => {
  const items = parseQqPlaylistList([
    { tid: 1, dirName: 'A' },
    { dirName: '没有 tid' },
    { tid: 0, dirName: 'tid 为 0' },
  ], 'created')
  assert.equal(items.length, 1)
  assert.equal(items[0].id, '1')
  assert.deepEqual(parseQqPlaylistList(null, 'created'), [])
})

test('mapQqSong maps mid, singers, album and qualities', () => {
  const song = mapQqSong({
    id: 123,
    mid: '003aAYrm3GE0Xg',
    title: '晴天',
    interval: 269,
    singer: [{ name: '周杰伦' }, { name: '杨瑞代' }],
    album: { mid: 'ALBUMMID', name: '叶惠美' },
    file: { media_mid: 'MEDIA', size_128mp3: 4307652, size_320mp3: 9434136, size_flac: 0 },
  })
  assert.equal(song.id, '003aAYrm3GE0Xg', 'id 必须是 mid（入队后按 mid 取链）')
  assert.equal(song.name, '晴天')
  assert.equal(song.singers, '周杰伦/杨瑞代')
  assert.equal(song.album, '叶惠美')
  assert.equal(song.duration_ms, 269000)
  assert.equal(song.source, 'qq')
  assert.equal(song.cover, qqAlbumCover('ALBUMMID'))
  assert.deepEqual(song.qualities, ['320', '128'], '没有 flac 就不给 flac')
  // 没有 mid 的条目不能入队（取链要 mid）→ 直接丢掉。
  assert.equal(mapQqSong({ id: 1, title: '无 mid' }), null)
})

test('mapQqSong falls back to the top level file sizes', () => {
  // 参考实现 client.go:361-372：file 里取不到就回退顶层 size128/size320/sizeflac。
  const song = mapQqSong({
    mid: '003aAYrm3GE0Xg',
    title: '晴天',
    interval: 269,
    singer: [{ name: '周杰伦' }],
    album: { mid: 'ALBUMMID', name: '叶惠美' },
    sizeflac: 30,
    size320: 20,
    size128: 10,
  })
  assert.deepEqual(song.qualities, ['flac', '320', '128'], 'file 缺失时用顶层的文件大小')
  // file 里的尺寸优先于顶层；file 为 0 才回退顶层（档位顺序固定 flac/320/128）。
  const both = mapQqSong({
    mid: 'M', title: 'x', file: { size_flac: 0, size_320mp3: 20 }, sizeflac: 30, size320: 99,
  })
  assert.deepEqual(both.qualities, ['flac', '320'], 'file 有值就用 file 的；file 为 0 才回退顶层')
})

test('parseQqSongList reads the songlist and the total', () => {
  const parsed = parseQqSongList({
    total_song_num: 110,
    songlist: [
      { mid: 'M1', title: '一', interval: 100, singer: [{ name: 'A' }] },
      { mid: 'M2', title: '二', interval: 200, singer: [] },
    ],
  })
  assert.equal(parsed.songs.length, 2)
  assert.equal(parsed.total, 110)
  // songlist 缺失时也不能当「空歌单」：总数回退到 0（调用方负责报错）。
  assert.equal(parseQqSongList({}).songs.length, 0)
  assert.equal(parseQqSongList({ songlist: null }).total, 0)
})

test('parseQqPlaylistInfo reads dirinfo', () => {
  const info = parseQqPlaylistInfo({
    dirinfo: { title: '歌单', picurl: 'https://cover/x.jpg', host_nick: '主人', songnum: 12 },
    total_song_num: 30,
  })
  assert.equal(info.name, '歌单')
  assert.equal(info.cover, 'https://cover/x.jpg')
  assert.equal(info.creator, '主人')
  assert.equal(info.count, 12)
  const empty = parseQqPlaylistInfo({ total_song_num: 30 })
  assert.equal(empty.name, '')
  assert.equal(empty.count, 30)
})

test('qqTargetKind routes the pseudo playlists', () => {
  assert.equal(qqTargetKind('202'), 'daily')
  assert.equal(qqTargetKind('daily'), 'daily')
  assert.equal(qqTargetKind('qq-daily'), 'daily')
  assert.equal(qqTargetKind('201'), 'liked')
  assert.equal(qqTargetKind('liked'), 'liked')
  assert.equal(qqTargetKind('qq-liked'), 'liked')
  assert.equal(qqTargetKind('8003104149'), 'playlist')
})

test('qqCodeHint maps the login-related business codes', () => {
  assert.match(qqCodeHint(80030), /未登录/)
  assert.match(qqCodeHint(80120), /未登录/)
  assert.match(qqCodeHint(-100008), /账号标识/)
  assert.equal(qqCodeHint(0), '')
})
