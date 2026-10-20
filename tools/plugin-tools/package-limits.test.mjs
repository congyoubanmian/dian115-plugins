// tools/plugin-tools/package-files.mjs 写盘前上限(package-format-v1.md)的回归测试。
//
// 覆盖: 正常通过、超成员数、超单成员、超解压总量、超 manifest/integrity/signature
// 清单大小、超 integrity 条目数、超 ZIP 最终大小。
// WASM 的 2 MiB 上限由 tools/conformance/project-check.mjs 负责, 这里不重复测试。
//
// 运行: node --test tools/plugin-tools/package-limits.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import { PACKAGE_LIMITS, assertPackageFileLimits, assertZipSize } from './package-files.mjs'

const MiB = 1024 * 1024
const file = (path, size) => ({ path, data: Buffer.alloc(size), executable: false })
const metadataFiles = () => [file('integrity.json', 512), file('signature.json', 256)]
const normalFiles = () => [
  file('manifest.json', 1024),
  file('frontend/icon.svg', 2048),
  file('runtime/plugin.wasm', 64 * 1024),
  ...metadataFiles(),
]

test('通过: 正常包内文件不触发上限', () => {
  assert.doesNotThrow(() => assertPackageFileLimits(normalFiles()))
  // 上限是闭区间: 恰好 32 MiB 的 ZIP 合法。
  assert.doesNotThrow(() => assertZipSize(Buffer.alloc(PACKAGE_LIMITS.zipBytes)))
})

test('通过: 恰好 1024 成员 / 1022 integrity 条目 / 256 KiB manifest', () => {
  const files = [
    file('manifest.json', PACKAGE_LIMITS.metadataBytes),
    ...Array.from({ length: PACKAGE_LIMITS.integrityEntries - 1 }, (_, index) =>
      file(`frontend/dist/assets/${index}.js`, 0),
    ),
    ...metadataFiles(),
  ]
  assert.equal(files.length, PACKAGE_LIMITS.members)
  assert.doesNotThrow(() => assertPackageFileLimits(files))
})

test('通过: 恰好 32 MiB 单成员 / 128 MiB 总量 / 256 KiB integrity+signature', () => {
  // 单成员与 metadata 正好触顶, 但未越界。
  assert.doesNotThrow(() =>
    assertPackageFileLimits([
      file('manifest.json', 1024),
      file('frontend/icon.svg', 2048),
      file('runtime/plugin.wasm', 64 * 1024),
      file('frontend/dist/assets/exact-member.bin', PACKAGE_LIMITS.memberBytes),
      file('integrity.json', PACKAGE_LIMITS.metadataBytes),
      file('signature.json', PACKAGE_LIMITS.metadataBytes),
    ]),
  )
  // 4 × 32 MiB 正好等于 128 MiB 解压总量上限。
  assert.doesNotThrow(() =>
    assertPackageFileLimits(
      Array.from({ length: 4 }, (_, index) =>
        file(`frontend/dist/assets/part-${index}.bin`, PACKAGE_LIMITS.memberBytes),
      ),
    ),
  )
})

test('超成员数: 1025 个成员被拒绝', () => {
  const files = Array.from({ length: PACKAGE_LIMITS.members + 1 }, (_, index) =>
    file(`frontend/dist/assets/${index}.js`, 0),
  )
  assert.throws(() => assertPackageFileLimits(files), /成员数 1025 超过上限 1024/)
})

test('超单成员: 32 MiB + 1 字节被拒绝', () => {
  const files = [...normalFiles(), file('frontend/dist/assets/huge.bin', PACKAGE_LIMITS.memberBytes + 1)]
  assert.throws(() => assertPackageFileLimits(files), /huge\.bin 大小 33554433 字节超过单成员上限 33554432 字节/)
})

test('超解压总量: 5 × 27 MiB 被拒绝', () => {
  const files = Array.from({ length: 5 }, (_, index) =>
    file(`frontend/dist/assets/part-${index}.bin`, 27 * MiB),
  )
  assert.throws(() => assertPackageFileLimits(files), /解压总量 141557760 字节超过上限 134217728 字节/)
})

test('超清单: manifest/integrity/signature 各 256 KiB 上限', () => {
  for (const path of ['manifest.json', 'integrity.json', 'signature.json']) {
    const files = [file(path, PACKAGE_LIMITS.metadataBytes + 1)]
    assert.throws(
      () => assertPackageFileLimits(files),
      new RegExp(`${path.replaceAll('.', '\\.')} 大小 262145 字节超过上限 262144 字节`),
    )
  }
})

test('超 integrity 条目: 1023 条被拒绝', () => {
  // 成员总数 1024(含 integrity.json)仍在成员上限内, 单独触发 integrity 条目上限。
  const files = [
    ...Array.from({ length: PACKAGE_LIMITS.integrityEntries + 1 }, (_, index) =>
      file(`frontend/dist/assets/${index}.js`, 0),
    ),
    file('integrity.json', 512),
  ]
  assert.throws(() => assertPackageFileLimits(files), /integrity 条目数 1023 超过上限 1022/)
})

test('超 ZIP 大小: 32 MiB + 1 字节被拒绝', () => {
  assert.throws(
    () => assertZipSize(Buffer.alloc(PACKAGE_LIMITS.zipBytes + 1)),
    /ZIP 大小 33554433 字节超过上限 33554432 字节/,
  )
})
