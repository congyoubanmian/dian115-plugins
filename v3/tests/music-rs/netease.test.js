// 网易云映射向量测试 —— 向量来自 plugins/music-rs/tests/{netease_playlists.rs, download.rs}。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mapSearchSong, playlistSongFromValue, parsePlaylistDetail, slicePlaylistPage,
  songDetailForm, parseSongDetail, playlistPage,
} from '../../music-rs/lib/netease.js'

test('search song mapping matches Go map[string]any shape', () => {
  const mapped = mapSearchSong({
    id: 186016,
    name: '晴天',
    ar: [{ id: 6452, name: '周杰伦' }, { id: 9999, name: 'Kay Tse' }],
    al: { id: 19061, name: '叶惠美', picUrl: 'https://p1.music.126.net/cover/19061.jpg' },
    dt: 269413,
  })
  assert.deepEqual(mapped, {
    id: 186016,
    name: '晴天',
    singers: '周杰伦/Kay Tse',
    album: '叶惠美',
    cover: 'https://p1.music.126.net/cover/19061.jpg',
    duration_ms: 269413,
    source: 'netease',
  })
  const empty = mapSearchSong({})
  assert.equal(empty.singers, '')
  assert.equal(empty.id, 0)
})

test('playlist_song_from_value maps the full fixture (netease_playlists.rs)', () => {
  const mapped = playlistSongFromValue({
    id: 186016,
    name: '晴天',
    ar: [{ id: 6452, name: '周杰伦' }, { id: 9999, name: 'Kay Tse' }],
    al: { id: 19061, name: '叶惠美', picUrl: 'https://p1.music.126.net/cover/19061.jpg' },
    dt: 269413,
    privilege: { id: 186016, maxBrLevel: 'lossless', downloadMaxBrLevel: 'hires' },
  })
  assert.deepEqual(mapped, {
    id: '186016',
    name: '晴天',
    singers: '周杰伦/Kay Tse',
    album: '叶惠美',
    cover: 'https://p1.music.126.net/cover/19061.jpg',
    duration_ms: 269413,
    source: 'netease',
    max_level: 'lossless',
    qualities: ['lossless', 'exhigh', 'standard'],
  })
})

test('playlist_song_from_value falls back like sidecar || chains', () => {
  // ar/al 缺失 → artists/album; dt=0（JS 假值）→ duration; maxBrLevel 缺失 → downloadMaxBrLevel。
  const mapped = playlistSongFromValue({
    id: 42,
    name: '回退',
    artists: [{ name: 'A' }, { name: 'B' }],
    album: { name: 'B面', picUrl: 'https://p1.music.126.net/x/42.jpg' },
    dt: 0,
    duration: 1000,
    privilege: { downloadMaxBrLevel: 'hires' },
  })
  assert.equal(mapped.singers, 'A/B')
  assert.equal(mapped.album, 'B面')
  assert.equal(mapped.cover, 'https://p1.music.126.net/x/42.jpg')
  assert.equal(mapped.duration_ms, 1000)
  assert.equal(mapped.max_level, 'hires')
  assert.deepEqual(mapped.qualities, ['hires', 'lossless', 'exhigh', 'standard'])
  // id 字符串原样保留；全空输入不抛错。
  assert.equal(playlistSongFromValue({ id: 'abc' }).id, 'abc')
  const empty = playlistSongFromValue({})
  assert.equal(empty.id, '')
  assert.deepEqual(empty.qualities, [])
})

test('parsePlaylistDetail reads playlist or result containers', () => {
  const parsed = parsePlaylistDetail(JSON.stringify({
    playlist: { name: '大歌单', trackCount: 1000, trackIds: Array.from({ length: 1000 }, (_, id) => ({ id })) },
  }))
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.index.name, '大歌单')
  assert.equal(parsed.index.total, 1000)
  assert.equal(parsed.index.ids.length, 1000)
  // result 容器与 trackCount 缺省（?? 只认 null/undefined，0 也是值）。
  const alt = parsePlaylistDetail(JSON.stringify({ result: { name: 'B', trackCount: 0, trackIds: [{ id: 1 }, { id: 2 }] } }))
  assert.equal(alt.index.total, 0)
  assert.equal(alt.index.ids.length, 2)
  const broken = parsePlaylistDetail('not json')
  assert.match(broken.error, /^歌单详情解析失败: /)
})

test('playlist index slices pages locally like the Rust PlaylistIndex test', () => {
  const index = { name: '大歌单', total: 1000, ids: Array.from({ length: 1000 }, (_, id) => id) }
  for (let page = 1; page <= 10; page++) {
    const slice = slicePlaylistPage(index, page, 100)
    assert.equal(slice.length, 100, `第 ${page} 页 100 首`)
    assert.equal(slice[0], (page - 1) * 100)
    assert.equal(slice[99], page * 100 - 1)
  }
  assert.deepEqual(slicePlaylistPage(index, 11, 100), [], '越界页为空')
  assert.deepEqual(slicePlaylistPage(index, 0, 100), [], 'page=0 起点为负 → 空页')
})

test('songDetailForm matches sidecar c=&ids=[..] form', () => {
  // Go QueryEscape（Rust query_escape）：[ → %5B、{ → %7B、" → %22、: → %3A、, → %2C、} → %7D、] → %5D。
  assert.equal(
    songDetailForm([347230, 347231]),
    'c=%5B%7B%22id%22%3A347230%7D%2C%7B%22id%22%3A347231%7D%5D&ids=[347230,347231]',
  )
})

test('parseSongDetail maps v3 song/detail rows', () => {
  const parsed = parseSongDetail(JSON.stringify({
    songs: [{ id: 900, name: '歌900', ar: [{ name: '歌手' }] }],
  }))
  assert.equal(parsed.songs.length, 1)
  assert.equal(parsed.songs[0].id, '900')
  assert.equal(parsed.songs[0].singers, '歌手')
  assert.match(parseSongDetail('nope').error, /^歌曲详情解析失败: /)
})

test('playlistPage keeps the underscore page_size contract', () => {
  assert.deepEqual(playlistPage('n', 10, 2, 100, []), { name: 'n', total: 10, page: 2, page_size: 100, songs: [] })
})
