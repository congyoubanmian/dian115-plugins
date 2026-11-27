import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decode, findInfoRange, readTorrentPieces, parseTorrentMeta, isValidTorrentBytes } from '../../reseed-puppy/lib/bencode.js'
import { normalizeSite, lookupRequest, downloadUrl, downloadHeaders, parseLookupHttpResponse, isSameSite, identifyTrackerSite } from '../../reseed-puppy/lib/sites.js'
import { mapToHostPath, resolveDownloaderConfigs } from '../../reseed-puppy/lib/downloaders/index.js'

function bencodeStr(s) {
  const bytes = new TextEncoder().encode(s)
  const prefix = new TextEncoder().encode(bytes.length + ':')
  const out = new Uint8Array(prefix.length + bytes.length)
  out.set(prefix, 0)
  out.set(bytes, prefix.length)
  return out
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}

function makeSampleTorrent() {
  const enc = (s) => new TextEncoder().encode(s)
  const fakePieces = new Uint8Array(20).fill(0xab)
  const piecesPrefix = enc('20:')
  const info = concatBytes(
    enc('d'),
    bencodeStr('length'), enc('i12345e'),
    bencodeStr('name'), bencodeStr('测试电影.mkv'),
    bencodeStr('piece length'), enc('i262144e'),
    bencodeStr('pieces'), piecesPrefix, fakePieces,
    enc('e')
  )
  return concatBytes(
    enc('d'),
    bencodeStr('announce'), bencodeStr('https://pt.soulvoice.club/announce.php?passkey=test'),
    bencodeStr('info'), info,
    enc('e')
  )
}

describe('bencode (pure Uint8Array, zero Buffer)', () => {
  it('parses torrent meta without global Buffer', () => {
    const sample = makeSampleTorrent()
    const origBuffer = globalThis.Buffer
    globalThis.Buffer = undefined
    try {
      assert.equal(isValidTorrentBytes(sample), true)
      assert.equal(isValidTorrentBytes(new TextEncoder().encode('<html>404</html>')), false)
      const range = findInfoRange(sample)
      assert.ok(range && range[1] > range[0])
      const p = readTorrentPieces(sample)
      assert.equal(p.pieces.length, 20)
      assert.equal(p.pieces[0], 0xab)
      const meta = parseTorrentMeta(sample)
      assert.equal(meta.name, '测试电影.mkv')
      assert.equal(meta.totalSize, 12345)
      assert.deepEqual(meta.announceHosts, ['pt.soulvoice.club'])
      assert.equal(meta.files.length, 1)
      assert.equal(decode(bencodeStr('hello')).length, 5)
    } finally {
      globalThis.Buffer = origBuffer
    }
  })
})

describe('sites dialect & matching', () => {
  it('infers NexusPHP, NexusAPI, FluxTorrent dialects and headers', () => {
    const flux = normalizeSite({ name: '青蛙', url: 'https://qingwa.example.com/', passkey: 'fxo_abc123', enabled: true })
    assert.equal(flux.dialect, 'flux')
    assert.equal(flux.apiUrl, 'https://qingwa.example.com/api/v1/crossseed/lookup')
    const req = lookupRequest(flux, ['fp1'])
    assert.equal(req.headers.Authorization, 'Token fxo_abc123')
    assert.equal(downloadUrl(flux, 99), 'https://qingwa.example.com/api/v1/crossseed/dl/99')
    assert.equal(downloadHeaders(flux).Authorization, 'Token fxo_abc123')

    const hits = parseLookupHttpResponse(flux, {
      status: 200,
      body: JSON.stringify({ code: 0, data: { results: [{ query: 'FP1', match: 'pieces_sha1', torrent_id: 99 }] } })
    })
    assert.deepEqual(hits, [{ piecesHash: 'fp1', torrentId: '99' }])

    assert.throws(() => parseLookupHttpResponse(flux, { status: 200, body: '<html><title>404</title></html>' }), /网页而非 JSON/)
  })

  it('matches same-site tracker domains and aliases', () => {
    const sv = normalizeSite({ name: '聆音', url: 'https://pt.soulvoice.club', passkey: 'pk', enabled: true })
    assert.equal(isSameSite(sv, ['tracker.soulvoice.club']), true)
    assert.equal(isSameSite(sv, ['tra1.m-team.cc']), false)
    assert.equal(identifyTrackerSite(['tra1.m-team.cc'], [sv]), '馒头 M-Team')
  })
})

describe('downloaders config & path mapping', () => {
  it('maps longest matching prefix and migrates legacy settings', () => {
    const maps = [
      { from: '/downloads', to: '/media' },
      { from: '/downloads/books', to: '/dian115AI/books' }
    ]
    assert.equal(mapToHostPath('/downloads/books/a', maps), '/dian115AI/books/a')
    assert.equal(mapToHostPath('/downloads/movies', maps), '/media/movies')
    assert.equal(mapToHostPath('/other/dir', maps), '')

    const dls = resolveDownloaderConfigs(null, { qbEnabled: true, qbUrl: 'http://127.0.0.1:8081' })
    assert.equal(dls.length, 1)
    assert.equal(dls[0].type, 'qbittorrent')
  })
})
