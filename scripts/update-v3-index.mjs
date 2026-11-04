#!/usr/bin/env node
// 根据 dist/ 里实际产出的包更新 v3 市场索引：
//   - 优先用「编译 MCP」签出的正式包（dist/official-packages.json 记录了文件名/sha256/会员昵称）：
//     delivery=protected-v4，author=签名昵称，source_url 指向正式包的 Release 下载地址。
//   - 没有正式包时回落到可读源码包（历史兼容；本机调试包不能上架）。
//   - sha256 一律用实算值。
// 输出 v3-market-index.release.json（不直接改仓库里的源文件，由发布流程决定是否回写）。
//
// 条目按 (id, version) upsert（market.md：「每个版本是一条记录」「同一 id 下不可重复」）：
//   - 同 id 同 version 已存在 → 更新那条（同版本重发）；
//   - 只有旧 version → 复制旧条目改成新 version 追加（历史版本保留在货架上）；
//   - 索引里没有这个 id → 按清单造一条新条目（首次上架）。
// 历史版本下架就是把对应条目从 plugins[] 里删掉。
//
// changelog 按条目 version 当期写（不是累计历史）：传 CHANGELOG 环境变量（JSON，
// {"music.rs": "1.3.10：…"}）按 id 覆盖；不传则新条目沿用被复制条目的文案。
//
// 用法：
//   TAG=v3-2026.11.02 REPO=congyoubanmian/dian115-plugins node scripts/update-v3-index.mjs
//   CHANGELOG='{"music.rs":"1.3.10：新增 X"}' TAG=… REPO=… node scripts/update-v3-index.mjs

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const tag = process.env.TAG
const repo = process.env.REPO
if (!tag || !repo) {
  console.error('需要环境变量 TAG 和 REPO（如 TAG=v3-xxx REPO=owner/repo）')
  process.exit(1)
}

const changelogs = (() => {
  try {
    return process.env.CHANGELOG ? JSON.parse(process.env.CHANGELOG) : {}
  } catch {
    console.error('CHANGELOG 环境变量不是合法 JSON')
    process.exit(1)
  }
})()

const indexPath = 'v3-market-index.json'
if (!existsSync(indexPath)) {
  console.error('缺少 v3-market-index.json')
  process.exit(1)
}

const index = JSON.parse(readFileSync(indexPath, 'utf8'))
const plugins = Array.isArray(index.plugins) ? index.plugins : (index.plugins = [])
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// 正式包清单（scripts/v3-compile.mjs 写出）：id → {filename, sha256, nickname, version, ...}
const ledgerPath = 'dist/official-packages.json'
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {}
const hasOfficial = Object.keys(ledger).length > 0
console.log(hasOfficial ? `正式包清单：${Object.keys(ledger).join(', ')}` : '没有正式包清单，回落到可读源码包（历史兼容）')

/** 本次发版要更新的插件 id：有正式包的就按清单；否则按索引里已有的 id（历史回落路径）。 */
const ids = hasOfficial ? Object.keys(ledger) : plugins.map((entry) => entry.id)

let upserted = 0
for (const id of ids) {
  const official = ledger[id]
  const manifestPath = `v3/${String(id).replace(/\./g, '-')}/plugin.json`
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
  const version = String(manifest.version ?? official?.version ?? '')
  if (!version) {
    console.error(`- ${id}: 读不到版本号（清单 ${manifestPath} 缺失或没有 version），跳过`)
    continue
  }

  let pkgName
  let delivery
  let author
  if (official) {
    pkgName = official.filename
    delivery = 'protected-v4'
    author = official.nickname || ''
  } else {
    // 回落：复用索引里同 id 最新一条的 source_url 形态（可读源码包历史兼容）。
    const prev = [...plugins].reverse().find((entry) => entry.id === id)
    const current = prev?.source_url ?? ''
    pkgName = current.split('/').pop()
    if (!pkgName || !pkgName.endsWith('.dian115p')) {
      console.warn(`- ${id}: 没有正式包且索引里没有可用的 source_url，跳过（${current}）`)
      continue
    }
    delivery = prev?.delivery ?? 'source'
    author = prev?.author ?? ''
  }

  const distPath = `dist/${pkgName}`
  if (!existsSync(distPath)) {
    console.error(`- ${id}: 缺少构建产物 ${distPath}`)
    process.exit(1)
  }
  const sum = sha256(distPath)
  const url = `https://github.com/${repo}/releases/download/${tag}/${pkgName}`

  // 同 id 同 version → 就地更新；否则找同 id 最新条目克隆一条新的（历史版本保留）。
  let entry = plugins.find((item) => item.id === id && item.version === version)
  let isNew = false
  if (!entry) {
    const prev = [...plugins].reverse().find((item) => item.id === id)
    entry = prev
      ? { ...prev }
      : {
          id,
          name: manifest.name ?? id,
          description: manifest.description ?? '',
          homepage: manifest.homepage ?? `https://github.com/${repo}`,
        }
    entry.version = version
    isNew = true
    plugins.push(entry)
  }

  entry.source_url = url
  entry.sha256 = sum
  entry.delivery = delivery
  if (author) entry.author = author
  delete entry.source_url_note

  // 索引的 permissions / declared_usage / description / name 一律以清单为准
  // （安装/更新时按索引校验，缺权限会被拒绝：source requests permission <x>
  // not declared by the release）。
  if (Array.isArray(manifest.permissions) && manifest.permissions.length > 0) {
    entry.permissions = [...manifest.permissions]
  } else {
    delete entry.permissions
  }
  if (manifest.declared_usage && typeof manifest.declared_usage === 'object') {
    entry.declared_usage = manifest.declared_usage
  }
  if (typeof manifest.description === 'string' && manifest.description !== '') {
    entry.description = manifest.description
  }
  if (typeof manifest.name === 'string' && manifest.name !== '') entry.name = manifest.name

  // changelog 按条目 version 当期写；CHANGELOG 环境变量按 id 覆盖。
  if (typeof changelogs[id] === 'string' && changelogs[id] !== '') {
    entry.changelog = changelogs[id]
  } else if (!entry.changelog) {
    entry.changelog = `${version}：发布`
  }

  upserted += 1
  console.log(`- ${id}@${version}: ${isNew ? '新增条目' : '更新'} ${pkgName} sha256=${sum} delivery=${delivery} author=${entry.author}`)
}

const out = 'v3-market-index.release.json'
writeFileSync(out, JSON.stringify(index, null, 2) + '\n')
console.log(`已写 ${out}（${upserted} 个条目，索引共 ${plugins.length} 条，tag=${tag}）`)
