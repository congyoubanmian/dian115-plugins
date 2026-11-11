#!/usr/bin/env node
// 发版前的官方审查闸门 —— 结构检查 + 恶意特征扫描（宿主官方 conformance/audit.mjs）。
//
// 用法：node scripts/v3-check-official.mjs [插件目录名 ...]
//
// 规则：
//   1. 结构检查有错 → 直接失败（与官方 check.mjs 一致）；
//   2. 扫描出的 critical/high 必须在 scripts/v3-audit-allowlist.json 里登记过
//      （逐条写了误报理由与复核方式），未登记 → 失败，避免"绕过闸门"；
//   3. medium/info 只提示不拦截。
//
// 与官方 scripts/check.mjs 的差别：官方在 do-not-install 时拒绝打包；这里把已复核的
// 误报显式登记成白名单，其余照旧拦截。宿主侧若启用了 MCP 签发流程，这条闸门仍然有效。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkProject } from '../v3-kit/conformance/project-check.mjs'
import { auditPlugin } from '../v3-kit/conformance/audit.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const allowlist = JSON.parse(readFileSync(resolve(root, 'scripts/v3-audit-allowlist.json'), 'utf8'))
const entries = allowlist.entries ?? []
const plugins = process.argv.slice(2)
const targets = plugins.length > 0 ? plugins : ['chase-rs', 'music-rs', 'douban-rs', 'huanggu-drama']

const key = (plugin, rule, file) => `${plugin}|${rule}|${file}`
const allowed = new Set(entries.map((item) => key(item.plugin, item.rule, item.file)))
const reasonOf = new Map(entries.map((item) => [key(item.plugin, item.rule, item.file), item.reason ?? '']))

let failed = false
for (const plugin of targets) {
  const directory = resolve(root, 'v3', plugin)
  const project = checkProject(directory)
  if (project.errors.length > 0) {
    failed = true
    console.error(`✗ ${plugin}：结构检查失败`)
    for (const error of project.errors) console.error(`   - ${error}`)
    continue
  }
  console.log(`✓ ${plugin}：结构检查通过（${project.manifest.id} ${project.manifest.version}）`)

  const report = auditPlugin(directory)
  const blocking = report.findings.filter((item) => item.severity === 'critical' || item.severity === 'high')
  const dismissed = []
  const unmatched = []
  for (const item of blocking) {
    const id = key(plugin, item.rule, item.file)
    if (allowed.has(id)) dismissed.push({ item, reason: reasonOf.get(id) })
    else unmatched.push(item)
  }
  console.log(`  扫描结论：${report.verdict} —— ${report.summary}`)
  for (const { item, reason } of dismissed) {
    console.log(`  · [已复核误报] ${item.severity} ${item.rule} ${item.file}${item.line ? ':' + item.line : ''}`)
    console.log(`      ${reason}`)
  }
  for (const item of unmatched) {
    console.error(`  ✗ [未登记] ${item.severity} ${item.rule} ${item.file}${item.line ? ':' + item.line : ''}`)
    console.error(`      ${item.title} —— ${item.why}`)
    console.error('      若是误报，请登记到 scripts/v3-audit-allowlist.json 并写明理由。')
  }
  if (unmatched.length > 0) failed = true
}

if (failed) {
  console.error('\n审查未通过：先修问题，或把确认过的误报登记进白名单。')
  process.exit(1)
}
console.log('\n审查通过：结构检查无误，critical/high 全部为已登记的误报。')
