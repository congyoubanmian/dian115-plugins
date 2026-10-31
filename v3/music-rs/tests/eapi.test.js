// eapi 协议向量测试 —— 向量来自 plugins/music-rs/tests/netease.rs（openssl 独立复算）。
// AES-128-ECB 由 node:crypto 注入，与宿主 ctx.crypto 同语义（jobs/runtime.js 适配层）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import {
  EAPI_KEY, SONG_URL_API, LEVELS, LEVELS_ASCENDING,
  eapiPath, eapiParams, songUrlPayload, levelLadder, qualitiesForLevel,
} from '../lib/eapi.js'
import { cryptoAdapter } from '../jobs/runtime.js'

/** node:crypto 冒充宿主 ctx.crypto（契约同形：md5(data, output)、aesEncrypt({mode,key,data,padding,output})）。 */
const fakeHostCrypto = cryptoAdapter({
  md5: (data, output) => createHash('md5').update(data).digest(output),
  aesEncrypt: ({ key, data, padding, output }) => {
    if (padding !== 'pkcs7') throw new Error('只支持 pkcs7')
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
    return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]).toString('hex')
  },
})

test('EAPI_KEY matches Go literal', () => {
  assert.equal(EAPI_KEY, 'e82ckenh8dichen8')
})

test('eapiPath replaces first /eapi/ segment only (pathname only, 0.3.9)', () => {
  assert.equal(eapiPath('https://x/eapi/a'), '/api/a')
  assert.equal(eapiPath('https://x/eapi/a/eapi/b'), '/api/a/eapi/b')
  assert.equal(eapiPath('https://x/api/a'), '/api/a')
  assert.equal(eapiPath('/eapi/a'), '/api/a')
  assert.equal(eapiPath(''), '')
})

test('songUrlPayload matches the agent-verified JSON literal', () => {
  // 键序 = serde_json BTreeMap 字典序（encodeType/header/ids/level），header 为闭合 JSON 字符串。
  assert.equal(
    JSON.stringify(songUrlPayload('1234567', 'lossless')),
    '{"encodeType":"flac","header":"{\\"os\\":\\"pc\\",\\"appver\\":\\"\\",\\"osver\\":\\"\\",\\"deviceId\\":\\"pyncm!\\"}","ids":["1234567"],"level":"lossless"}',
  )
})

test('eapiParams matches independent openssl vectors', () => {
  const lossless = eapiParams(SONG_URL_API, songUrlPayload('1234567', 'lossless'), fakeHostCrypto)
  assert.equal(
    lossless,
    'fa90b329e9614f79e79598f37dc2edb487f00d1bc4c9b24cd57e6c318b9073567565d994ef3a89f5356c243f90d8099d485db260fa577059c3e1cfbfb3b6e9c157e2dbb5c19220c20ee55de2b6b8e0c0da6346d00362771113455a98a163207c96112551674ef2aa3cf342cbd2c6898dc9d0cef9466d31342b8410534bd998db9f2aa4909c0280a8118ce0a66739f41bc797a6fe0b212d422c65ff9455a72495b5bb081ca938d77a54f3545cf154b30c98ec9e76c2d6875c725d5ae263a612d9de7805c0dfccb1f188670bb9f39a0f2c692e1d1edb8ff6147deaf8ce756a2acab87438d666951bf2416c46f70cc794e9',
  )
  const sky = eapiParams(SONG_URL_API, songUrlPayload('42', 'sky'), fakeHostCrypto)
  assert.equal(
    sky,
    'fa90b329e9614f79e79598f37dc2edb487f00d1bc4c9b24cd57e6c318b9073567565d994ef3a89f5356c243f90d8099d485db260fa577059c3e1cfbfb3b6e9c157e2dbb5c19220c20ee55de2b6b8e0c0da6346d00362771113455a98a163207c96112551674ef2aa3cf342cbd2c6898dc9d0cef9466d31342b8410534bd998db9f2aa4909c0280a8118ce0a66739f41b5830b791208a4f12ea2872c174fac2b850d41794fdba57c36ee78ee82ab0503741b06992913ecb850787550925a650ddb02165b196d2fcdeb7fc1ebdcb5ba63d77bfe2fbbcfc5958fe7c3665b4f3839a',
  )
  assert.notEqual(
    eapiParams(SONG_URL_API, songUrlPayload('42', 'hires'), fakeHostCrypto),
    sky,
  )
})

test('level ladder follows Go/sidecar order (not reversed tables)', () => {
  assert.deepEqual(LEVELS, ['jymaster', 'jyeffect', 'sky', 'hires', 'lossless', 'dolby', 'exhigh', 'standard'])
  assert.deepEqual(LEVELS_ASCENDING, ['standard', 'exhigh', 'lossless', 'hires', 'sky', 'jyeffect', 'dolby', 'jymaster'])
  assert.deepEqual(levelLadder(''), LEVELS)
  assert.deepEqual(levelLadder('unknown'), LEVELS)
  assert.deepEqual(levelLadder('jymaster'), LEVELS)
  assert.deepEqual(levelLadder('lossless'), ['lossless', 'dolby', 'exhigh', 'standard'])
  assert.deepEqual(levelLadder('standard'), ['standard'])
})

test('qualitiesForLevel slices ascending table and reverses', () => {
  for (const [index, level] of LEVELS_ASCENDING.entries()) {
    const expected = LEVELS_ASCENDING.slice(0, index + 1).reverse()
    assert.deepEqual(qualitiesForLevel(level), expected, `level=${level}`)
  }
  assert.deepEqual(qualitiesForLevel('hires'), ['hires', 'lossless', 'exhigh', 'standard'])
  assert.deepEqual(qualitiesForLevel('jymaster'), [...LEVELS_ASCENDING].reverse())
  assert.deepEqual(qualitiesForLevel(''), [])
  assert.deepEqual(qualitiesForLevel('bogus'), [])
  assert.deepEqual(qualitiesForLevel('STANDARD'), [], '区分大小写')
})
