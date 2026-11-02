#!/usr/bin/env node
// 提交前密钥扫描：确认开发者凭据没有漏进 git 跟踪的文件。
//
// 查两件事：
//   1) .env.local 里的真实值（OpenAPI Key / 会员 Key 等）是否出现在任何跟踪文件里；
//   2) 跟踪文件里是否出现常见的凭据形态（长随机串赋给 key/secret/token 之类变量）。
//
// 用法：node scripts/v3-secret-scan.mjs
// 退出码：0 = 干净；1 = 发现疑似泄漏（阻止提交/发版）。
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname)

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  return out.toString('utf8').split('\0').filter(Boolean)
}

// ① 本地凭据文件的真实值
const secretValues = []
const envFile = resolve(root, '.env.local')
if (existsSync(envFile)) {
  const mode = statSync(envFile).mode & 0o777
  if (mode & 0o077) {
    console.error(`✗ .env.local 权限过宽（${mode.toString(8)}），其他人/进程可读：建议 chmod 600 .env.local`)
    process.exit(1)
  }
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const eq = text.indexOf('=')
    if (eq <= 0) continue
    const key = text.slice(0, eq).trim()
    const value = text.slice(eq + 1).trim()
    if (!value || value.length < 16) continue
    if (!/(KEY|TOKEN|SECRET|PASSWORD|COOKIE)/i.test(key)) continue
    secretValues.push({ key, value })
  }
}

// ② 跟踪文件里的常见凭据形态
const SHAPE = /(?<![A-Za-z0-9])(?:api[_-]?key|openapi[_-]?key|secret|token|password|passwd|signing[_-]?key)\s*[:=]\s*["']([A-Za-z0-9_\-]{16,})["']/gi
const ALLOW = /(?:example|placeholder|your[_-]?key|changeme|<[^>]+>|\$\{|\$\(|process\.env|GITHUB_TOKEN|secrets\.)/i

const problems = []
for (const file of trackedFiles()) {
  const path = resolve(root, file)
  if (!existsSync(path) || statSync(path).size > 2 * 1024 * 1024) continue
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    continue
  }
  for (const { key, value } of secretValues) {
    if (text.includes(value)) problems.push(`${file}：含有 .env.local 里 ${key} 的值`)
  }
  for (const match of text.matchAll(SHAPE)) {
    const value = match[1]
    if (ALLOW.test(value) || ALLOW.test(match[0])) continue
    problems.push(`${file}：疑似硬编码凭据 ${match[0].slice(0, 60)}…`)
  }
}

if (problems.length > 0) {
  console.error('✗ 发现疑似凭据泄漏：')
  for (const item of [...new Set(problems)]) console.error(`   - ${item}`)
  console.error('\n凭据只放 .env.local（已 gitignore）或 CI secret；确认后请清理并轮换该密钥。')
  process.exit(1)
}

console.log(`✓ 密钥扫描通过：${trackedFiles().length} 个跟踪文件里没有开发者凭据${secretValues.length ? `（已比对 .env.local 的 ${secretValues.length} 个敏感项）` : ''}。`)
