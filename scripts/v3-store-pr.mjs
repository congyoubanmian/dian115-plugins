#!/usr/bin/env node
// 生成「提交到官方插件市场」的索引条目（PR 素材），不提交任何包/密钥/主项目源码。
//
// 官方市场目录（madbrolab/dian115 的 plugin-market/）只接收：
//   - index.json 里的条目（id/name/version/source_url/sha256/delivery/author/…）
//   - 明确的静态资源（assets/*.svg 图标）
// 交付地址用我们自托管的 Release 正式包（protected-v4），符合
// "源码和加密 .dian115p 包由作者在自有交付地址托管"。
//
// 用法：node scripts/v3-store-pr.mjs
// 产出：store-pr/index.json（可直接替换官方市场的 index.json）、store-pr/assets/<id>.svg
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const index = JSON.parse(readFileSync(resolve(root, 'v3-market-index.json'), 'utf8'))
const outDir = resolve(root, 'store-pr')
mkdirSync(resolve(outDir, 'assets'), { recursive: true })

const entries = index.plugins.map((plugin) => ({
  id: plugin.id,
  name: plugin.name,
  version: plugin.version,
  description: plugin.description,
  author: plugin.author,
  source_url: plugin.source_url,
  sha256: plugin.sha256,
  delivery: plugin.delivery ?? 'protected-v4',
  declared_usage: plugin.declared_usage,
  homepage: plugin.homepage,
  changelog: plugin.changelog,
  icon: plugin.icon,
  repository_url: plugin.repository_url,
  keywords: plugin.keywords,
}))

const storeIndex = {
  $schema: './index.schema.json',
  schema_version: 3,
  repository: { id: 'madbrolab.dian115', name: 'DIAN115 官方市场', homepage: 'https://github.com/madbrolab/dian115' },
  plugins: entries,
}
writeFileSync(resolve(outDir, 'index.json'), JSON.stringify(storeIndex, null, 2) + '\n')

for (const plugin of index.plugins) {
  const icon = resolve(root, 'v3', plugin.id.replace('.', '-'), 'icon.svg')
  if (existsSync(icon)) copyFileSync(icon, resolve(outDir, 'assets', `${plugin.id}.svg`))
}

console.log(`已生成 ${outDir}/index.json（${entries.length} 个条目）与 assets/*.svg`)
for (const entry of entries) {
  console.log(`  ${entry.id}@${entry.version} delivery=${entry.delivery} author=${entry.author}`)
  console.log(`    ${entry.source_url}`)
}
console.log('\n提交 PR 前请确认：')
console.log('  1) 官方市场 schema 的 delivery 枚举要加上 protected-v4（文档已改，schema 还没跟上）；')
console.log('  2) 官方市场 index.json 的 plugins 数组里追加这些条目（不要提交 .dian115p 或源码）；')
console.log('  3) assets/ 下放三个图标；')
console.log('  4) 交付地址要一直可用（Release 资产），索引里的 sha256 与资产一致。')
