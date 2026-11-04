#!/usr/bin/env node
// 根据 dist/ 里实际产出的包更新 v3 市场索引：
//   - 优先用「编译 MCP」签出的正式包（dist/official-packages.json 记录了文件名/sha256/会员昵称）：
//     delivery=protected-v4，author=签名昵称，source_url 指向正式包的 Release 下载地址。
//   - 没有正式包时回落到可读源码包（历史兼容；本机调试包不能上架）。
//   - sha256 一律用实算值。
// 输出 v3-market-index.release.json（不直接改仓库里的源文件，由发布流程决定是否回写）。
//
// 用法：TAG=v3-2026.11.02 REPO=congyoubanmian/dian115-plugins node scripts/update-v3-index.mjs

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const tag = process.env.TAG
const repo = process.env.REPO
if (!tag || !repo) {
  console.error('需要环境变量 TAG 和 REPO（如 TAG=v3-xxx REPO=owner/repo）')
  process.exit(1)
}

const indexPath = 'v3-market-index.json'
if (!existsSync(indexPath)) {
  console.error('缺少 v3-market-index.json')
  process.exit(1)
}

const index = JSON.parse(readFileSync(indexPath, 'utf8'))
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// 正式包清单（scripts/v3-compile.mjs 写出）：id → {filename, sha256, nickname, ...}
const ledgerPath = 'dist/official-packages.json'
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {}
const hasOfficial = Object.keys(ledger).length > 0
console.log(hasOfficial ? `正式包清单：${Object.keys(ledger).join(', ')}` : '没有正式包清单，回落到可读源码包（历史兼容）')

let changed = 0
for (const plugin of index.plugins ?? []) {
  const official = ledger[plugin.id]
  let pkgName
  if (official) {
    pkgName = official.filename
    plugin.delivery = 'protected-v4'
    if (official.nickname) plugin.author = official.nickname
  } else {
    const current = plugin.source_url ?? ''
    pkgName = current.split('/').pop()
    if (!pkgName || !pkgName.endsWith('.dian115p')) {
      console.warn(`- ${plugin.id}: source_url 不是 .dian115p，跳过（${current}）`)
      continue
    }
  }
  const distPath = `dist/${pkgName}`
  if (!existsSync(distPath)) {
    console.error(`- ${plugin.id}: 缺少构建产物 ${distPath}`)
    process.exit(1)
  }
  plugin.sha256 = sha256(distPath)
  plugin.source_url = `https://github.com/${repo}/releases/download/${tag}/${pkgName}`
  delete plugin.source_url_note

  // 索引的 permissions / version / declared_usage 一律以清单为准（安装/更新时按索引校验，
  // 缺权限会被拒绝：source requests permission <x> not declared by the release；
  // version 不回写会让市场一直显示旧版本 —— 之前靠手工同步，容易漏）。
  const manifestPath = `v3/${plugin.id.replace(/\./g, '-')}/plugin.json`
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (Array.isArray(manifest.permissions) && manifest.permissions.length > 0) {
      plugin.permissions = [...manifest.permissions]
    } else {
      delete plugin.permissions
    }
    if (typeof manifest.version === 'string' && manifest.version !== '') plugin.version = manifest.version
    if (manifest.declared_usage && typeof manifest.declared_usage === 'object') {
      plugin.declared_usage = manifest.declared_usage
    }
    if (typeof manifest.description === 'string' && manifest.description !== '') {
      plugin.description = manifest.description
    }
  } else {
    console.warn(`- ${plugin.id}: 缺少清单 ${manifestPath}，permissions/version 未同步`)
  }

  changed += 1
  console.log(`- ${plugin.id}: ${pkgName} sha256=${plugin.sha256} delivery=${plugin.delivery ?? '(历史)'} author=${plugin.author}`)
}

const out = 'v3-market-index.release.json'
writeFileSync(out, JSON.stringify(index, null, 2) + '\n')
console.log(`已写 ${out}（${changed} 个插件，tag=${tag}）`)
