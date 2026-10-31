// QQ 纯逻辑向量测试 —— 向量来自 plugins/music-rs/tests/qq.rs（Go 版逐字对拍）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QUALITY_LADDER, qualityStart, qualityLadder, qrShowT, qrShowParams, qrLoginParams,
  wxLoginParams, wxCheckParams, searchParams, guidFromNanos, songUrlRequestBody,
  wxLoginPayload, parseJsArgs, qqStatusOf, wxStatusOf, parseWxErrcode, parseWxCode,
  extractWxUuid, loginKindOf, parseVkeyResponse, parseSearch, NO_LINK_ERROR, QR_UNAVAILABLE,
} from '../lib/qq.js'

test('quality ladder matches sidecar QQ_LADDER', () => {
  assert.deepEqual(QUALITY_LADDER, [
    ['AI00', 'flac'], ['Q001', 'flac'], ['Q000', 'flac'], ['F000', 'flac'],
    ['O801', 'ogg'], ['M800', 'mp3'], ['M500', 'mp3'],
  ])
})

test('quality ladder slices by user level', () => {
  assert.equal(qualityStart('master'), 0)
  assert.equal(qualityStart('flac'), 3)
  assert.equal(qualityStart('320'), 5)
  assert.equal(qualityStart('128'), 6)
  assert.equal(qualityStart('bogus'), null)
  assert.equal(qualityLadder('master'), QUALITY_LADDER)
  assert.equal(qualityLadder('bogus'), QUALITY_LADDER)
  assert.equal(qualityLadder(''), QUALITY_LADDER)
  assert.deepEqual(qualityLadder('flac'), QUALITY_LADDER.slice(3))
  assert.deepEqual(qualityLadder('320'), QUALITY_LADDER.slice(5))
  assert.deepEqual(qualityLadder('128'), [['M500', 'mp3']])
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

test('songUrlRequestBody matches Go json.Marshal sorted shape', () => {
  assert.equal(guidFromNanos(1_759_291_234_567_890_123n), '4567890123')
  const body = songUrlRequestBody('001Qu4I30eVFYb', '1234567890', '4567890123', QUALITY_LADDER)
  assert.equal(
    body,
    '{"comm":{"ct":20,"cv":0,"format":"json","uin":"1234567890"},"req_1":{"method":"UrlGetVkey","module":"music.vkey.GetVkey","param":{"filename":["AI00001Qu4I30eVFYb001Qu4I30eVFYb.flac","Q001001Qu4I30eVFYb001Qu4I30eVFYb.flac","Q000001Qu4I30eVFYb001Qu4I30eVFYb.flac","F000001Qu4I30eVFYb001Qu4I30eVFYb.flac","O801001Qu4I30eVFYb001Qu4I30eVFYb.ogg","M800001Qu4I30eVFYb001Qu4I30eVFYb.mp3","M500001Qu4I30eVFYb001Qu4I30eVFYb.mp3"],"guid":"4567890123","loginflag":1,"platform":"20","songmid":["001Qu4I30eVFYb"],"songtype":[0],"uin":"1234567890"}}}',
  )
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

test('parseVkeyResponse picks first http purl and honors ladder index', () => {
  const body = '{"req_1":{"data":{"midurlinfo":[{"purl":""},{"purl":""},{"purl":""},{"purl":"https://dl.stream.qqmusic.qq.com/F000003aAYrm3GE0Xg003aAYrm3GE0Xg.flac?vkey=1"}]}}}'
  const parsed = parseVkeyResponse(body, QUALITY_LADDER)
  assert.equal(parsed.url, 'https://dl.stream.qqmusic.qq.com/F000003aAYrm3GE0Xg003aAYrm3GE0Xg.flac?vkey=1')
  assert.equal(parsed.ext, 'flac')
  assert.equal(parsed.level, 'F000')
  // 所有 purl 为空 → 绿钻文案；索引越界跳过。
  const empty = '{"req_1":{"data":{"midurlinfo":[{"purl":""},{"purl":""},{"purl":""},{"purl":""},{"purl":""},{"purl":""}]}}}'
  assert.equal(parseVkeyResponse(empty, QUALITY_LADDER).error, NO_LINK_ERROR)
  assert.equal(parseVkeyResponse('<html>502</html>', QUALITY_LADDER).error, 'QQ 取链解析失败')
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
