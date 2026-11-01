// cookie 处理向量测试 —— 向量来自 plugins/music-rs/tests/{netease,qq}.rs 与 cookiecloud.rs。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COOKIE_BASE, parseCookieString, parseSetCookie, neteaseCookieHeader, qqCookieHeader,
  mergeJars, uinFromCookies, normalizeCookies, cleanNeteaseCookieString, cleanQqCookieString,
  isNeteaseCloudDomain, isQqCloudDomain, extractCookiesFromSnapshot,
  neteaseLoginInfo, qqLoginInfo, QQ_COOKIE_NAMES,
} from '../lib/cookies.js'
import { NETEASE_COOKIE_NAMES } from '../lib/eapi.js'

test('parseCookieString matches Go SplitN("=", 2) semantics', () => {
  const cookies = parseCookieString('MUSIC_U=abc=def; __csrf_token=xyz; NMTID=; broken; =nokey; key=; a=b;c=d')
  assert.equal(cookies.MUSIC_U, 'abc=def', '值里的 = 保留')
  assert.equal(cookies.__csrf_token, 'xyz')
  assert.equal(cookies.NMTID, '', '空值也算命中')
  assert.equal(cookies.key, '')
  assert.equal(cookies.a, 'b')
  assert.equal(cookies.c, 'd')
  assert.ok(!('broken' in cookies), '没有 = 的段忽略')
  assert.ok(!('' in cookies), '名字为空的段忽略')
  assert.equal(Object.keys(cookies).length, 6)

  const spaced = parseCookieString('  spaced = v  ')
  assert.equal(spaced['spaced '], ' v', '键内部空白原样保留（Go SplitN 语义）')

  const fullWidth = parseCookieString('\u3000MUSIC_U=x\u3000')
  assert.equal(fullWidth.MUSIC_U, 'x')

  const duplicated = parseCookieString('k=1; k=2')
  assert.equal(duplicated.k, '2', '同名后者覆盖前者')

  assert.deepEqual(parseCookieString(''), {})
  assert.deepEqual(parseCookieString(';;;'), {})
})

test('neteaseCookieHeader echoes only fixed keys', () => {
  assert.equal(COOKIE_BASE, 'os=pc; appver=; osver=; deviceId=pyncm!')
  assert.equal(neteaseCookieHeader({}), COOKIE_BASE)
  assert.equal(
    neteaseCookieHeader({ MUSIC_U: 'u1', __csrf_token: 't2', NMTID: 'n3' }),
    'os=pc; appver=; osver=; deviceId=pyncm!; MUSIC_U=u1; __csrf_token=t2',
  )
  assert.equal(
    neteaseCookieHeader({ MUSIC_U: '' }),
    'os=pc; appver=; osver=; deviceId=pyncm!; MUSIC_U=',
    '键存在就回显（Go 的 map 命中判定）',
  )
})

test('qqCookieHeader sorts keys like BTreeMap', () => {
  assert.equal(qqCookieHeader({ uin: 'o1', qqmusic_key: '@K' }), 'qqmusic_key=@K; uin=o1')
  assert.equal(qqCookieHeader({}), '')
})

test('qqCookieHeader only sends the four credential fields', () => {
  // 参考实现 client.go:128 只发 uin / qqmusic_uin / qm_keyst / qqmusic_key。
  // encryptUin（账号标识）、encryptUinFor（插件自用簿记）、tmeLoginType 都不是
  // QQ 协议的凭据，不该整表出网。
  assert.equal(
    qqCookieHeader({
      uin: 'o1',
      qqmusic_uin: '1',
      qm_keyst: '@Q',
      qqmusic_key: '@K',
      encryptUin: 'ENC',
      encryptUinFor: '1',
      tmeLoginType: '2',
      p_skey: '@PS',
    }),
    'qm_keyst=@Q; qqmusic_key=@K; qqmusic_uin=1; uin=o1',
  )
})

test('parseSetCookie takes first pair', () => {
  assert.deepEqual(parseSetCookie('MUSIC_U=abc; Path=/; HttpOnly'), ['MUSIC_U', 'abc'])
  assert.deepEqual(parseSetCookie('__csrf_token=a=b; Path=/'), ['__csrf_token', 'a=b'])
  assert.equal(parseSetCookie(' no-equals '), null)
  assert.equal(parseSetCookie('=v'), null)
})

test('mergeJars keeps old fields (sidecar merge semantics)', () => {
  assert.deepEqual(mergeJars({ MUSIC_U: 'old' }, { __csrf_token: 'new' }), { MUSIC_U: 'old', __csrf_token: 'new' })
  assert.deepEqual(mergeJars({ MUSIC_U: 'old' }, { MUSIC_U: 'new' }), { MUSIC_U: 'new' })
})

test('uinFromCookies strips one o then one 0 prefix', () => {
  assert.equal(uinFromCookies({}), '0', '键不存在 → "0"')
  assert.equal(uinFromCookies({ uin: '' }), '', '键存在但空 → 空串')
  assert.equal(uinFromCookies({ uin: 'o0012345678' }), '012345678', 'o → 一层 0')
  assert.equal(uinFromCookies({ uin: '123456789' }), '123456789')
})

test('normalizeCookies fills uin and qqmusic_key', () => {
  const jar = normalizeCookies({ ptui_loginuin: '123456789', p_skey: '@PS' })
  assert.equal(jar.uin, '123456789')
  assert.equal(jar.qqmusic_key, '@PS')
  const wx = normalizeCookies({ wxuin: 'wx1', skey: '@S' }, 'wx')
  assert.equal(wx.uin, 'wx1')
  assert.equal(wx.qqmusic_key, '@S')
  const intact = normalizeCookies({ uin: 'u1', qqmusic_key: '@K' })
  assert.equal(intact.uin, 'u1')
  assert.equal(intact.qqmusic_key, '@K')
})

test('cleanNeteaseCookieString whitelists and validates', () => {
  // Rust 版语义：白名单内但值为空的段同样丢弃（!value.is_empty()）。
  const ok = cleanNeteaseCookieString('MUSIC_U=abc; NMTID=; other=x; MUSIC_A=')
  assert.deepEqual(ok.jar, { MUSIC_U: 'abc' })
  const bad = cleanNeteaseCookieString('NMTID=; other=x')
  assert.match(bad.error, /MUSIC_U/)
  const byA = cleanNeteaseCookieString('MUSIC_A=tok')
  assert.deepEqual(byA.jar, { MUSIC_A: 'tok' })
})

test('cleanQqCookieString whitelists, trims and requires key', () => {
  const ok = cleanQqCookieString('other=x; uin=o0012345678; qqmusic_key=@K; Path=/; Domain=y.qq.com; skey=@S')
  assert.deepEqual(ok.jar, { uin: 'o0012345678', qqmusic_key: '@K', skey: '@S' })
  const filled = cleanQqCookieString('ptui_loginuin=123456789; p_skey=@PS')
  assert.equal(filled.jar.uin, '123456789')
  assert.equal(filled.jar.qqmusic_key, '@PS')
  assert.ok(cleanQqCookieString('Path=/; Domain=y.qq.com').error)
  assert.ok(cleanQqCookieString('').error)
  // 白名单里多一项 encryptUin：QQLogin 响应里的账号标识（收藏歌单 / 我喜欢接口的
  // uin 参数要用它），它和凭据一起存在 cookies.qq 这张表里。
  assert.deepEqual(QQ_COOKIE_NAMES.length, 14)
  assert.ok(QQ_COOKIE_NAMES.includes('encryptUin'))
})

test('cookiecloud domain filters are suffix-exact', () => {
  assert.ok(isNeteaseCloudDomain('music.163.com'))
  assert.ok(isNeteaseCloudDomain('interface.music.163.com'))
  assert.ok(isNeteaseCloudDomain('.music.163.com'))
  assert.ok(!isNeteaseCloudDomain('xmusic.163.com'), 'contains 会误判，必须后缀精确')
  assert.ok(!isNeteaseCloudDomain('163.com'))
  assert.ok(isQqCloudDomain('qq.com'))
  assert.ok(isQqCloudDomain('y.qq.com'))
  assert.ok(isQqCloudDomain('music.qq.com'))
  assert.ok(!isQqCloudDomain('xqq.com'))
  assert.ok(!isQqCloudDomain('weixin.qq.com.evil.com'))
})

test('extractCookiesFromSnapshot reads v3 Cookie[] and legacy doc shapes', () => {
  const whitelist = ['MUSIC_U', '__csrf_token']
  const snapshot = {
    revision: 'r1',
    cookies: [
      { name: 'MUSIC_U', value: 'tok', domain: 'music.163.com' },
      { name: '__csrf_token', value: 'csrf', domain: '.music.163.com' },
      { name: 'MUSIC_U', value: 'second', domain: 'interface.music.163.com' },
      { name: 'NMTID', value: 'n', domain: 'music.163.com' },
      { name: 'MUSIC_U', value: '', domain: 'music.163.com' },
      { name: 'uin', value: 'o1', domain: 'y.qq.com' },
    ],
  }
  const netease = extractCookiesFromSnapshot(snapshot, isNeteaseCloudDomain, whitelist)
  assert.deepEqual(netease, { MUSIC_U: 'tok', __csrf_token: 'csrf' }, '同名先见先得，白名单外跳过，空值跳过')
  const qq = extractCookiesFromSnapshot(snapshot, isQqCloudDomain, ['uin'])
  assert.deepEqual(qq, { uin: 'o1' })

  // 旧版 {域: [{name,value}]} 形态。
  const legacy = { cookie_data: { 'music.163.com': [{ name: 'MUSIC_U', value: 'legacy' }] } }
  assert.deepEqual(extractCookiesFromSnapshot(legacy, isNeteaseCloudDomain, whitelist), { MUSIC_U: 'legacy' })
  // 旧版 {域: {name:value}} 形态。
  const legacyObj = { cookie_data: { '.music.163.com': { MUSIC_U: 'obj', NMTID: 'x' } } }
  assert.deepEqual(
    extractCookiesFromSnapshot(legacyObj, isNeteaseCloudDomain, whitelist),
    { MUSIC_U: 'obj' },
  )
})

test('login info never echoes cookie values', () => {
  const netease = neteaseLoginInfo({ MUSIC_U: 'secret' })
  assert.deepEqual(netease, { logged_in: true, has_music_u: true })
  assert.deepEqual(neteaseLoginInfo({}), { logged_in: false, has_music_u: false })
  const qq = qqLoginInfo({ uin: 'o1', qqmusic_key: '@K' })
  assert.deepEqual(qq, { source: 'qq', logged_in: true, has_key: true, uin: '1' })
  assert.deepEqual(qqLoginInfo({ uin: 'o1' }).logged_in, false)
  assert.ok(!JSON.stringify(netease).includes('secret'))
})

test('whitelists keep the legacy constants', () => {
  assert.deepEqual(NETEASE_COOKIE_NAMES, ['MUSIC_U', 'MUSIC_A', 'MUSIC_A_T', 'MUSIC_R_T', 'MUSIC_SNS', 'NMTID', '__csrf', '__csrf_token', '_ntes_nuid', '_ntes_nnid'])
})
