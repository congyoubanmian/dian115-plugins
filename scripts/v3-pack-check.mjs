// 校验打好的 .dian115p 包：
//
// 1. 包里不能出现 node_modules —— 依赖只装在开发机（v3-ui/node_modules），
//    不该、也不允许进包（宿主装的是源码包，不是 node 工程）。
// 2. 包里必须有清单 plugin.json，以及它声明的入口（ui.entry / jobs[].entry /
//    http.entry）—— 少一个宿主装上就起不来。
//
// 只读 zip 的中央目录拿文件名，不解压、不依赖外部命令（unzip 可能没装）。
//
// 用法：
//   node scripts/v3-pack-check.mjs dist/chase-rs-0.1.11.dian115p [插件源码目录]

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

/** 在 zip 尾部找中央目录结束记录（EOCD）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - (0xffff + 22))
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  throw new Error('不是有效的 zip：找不到中央目录结束记录')
}

/** 列出 zip 里的全部条目名（不解压内容）。 */
export function listEntries(buf) {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('包用了 ZIP64 扩展，本检查脚本不支持')
  }
  if (cdOffset + cdSize > buf.length) throw new Error('中央目录越界，包已损坏')
  const names = []
  let offset = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) throw new Error('中央目录记录损坏')
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/** 源码目录里有没有 node_modules（连子目录一起看）。 */
function findNodeModules(dir) {
  const found = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const info = statSync(full)
      if (info.isDirectory()) {
        if (name === 'node_modules') found.push(relative(dir, full).split(sep).join('/'))
        else walk(full)
      }
    }
  }
  walk(dir)
  return found
}

function main(argv) {
  const [packagePath, sourceDir] = argv
  if (!packagePath) {
    console.error('用法：node scripts/v3-pack-check.mjs <包.dian115p> [插件源码目录]')
    process.exitCode = 1
    return
  }
  const errors = []
  const entries = listEntries(readFileSync(resolve(packagePath)))

  // 1) 包里不能有 node_modules
  const offenders = entries.filter(name => name.split('/').includes('node_modules'))
  if (offenders.length) {
    errors.push('包里混进了 node_modules：' + offenders.join('、'))
  }

  // 2) 源码目录里也不该有 node_modules（pack.mjs 会跳过它，但留着容易误打包）
  if (sourceDir) {
    const dir = resolve(sourceDir)
    if (!existsSync(dir)) {
      errors.push('插件源码目录不存在：' + dir)
    } else {
      const dirty = findNodeModules(dir)
      if (dirty.length) errors.push('插件源码目录里有 node_modules：' + dirty.join('、'))
      const manifestPath = join(dir, 'plugin.json')
      if (!existsSync(manifestPath)) {
        errors.push('插件源码目录里没有 plugin.json：' + manifestPath)
      } else {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const required = [
          manifest.ui?.entry,
          ...(manifest.jobs || []).map(job => job.entry),
          manifest.http?.entry,
        ].filter(Boolean)
        const present = new Set(entries)
        for (const entry of required) {
          if (!present.has(entry)) errors.push('包里缺少清单声明的入口：' + entry)
        }
      }
    }
  }

  if (!present(entries, 'plugin.json')) errors.push('包里缺少 plugin.json')

  if (errors.length) {
    console.error('包检查失败：\n- ' + errors.join('\n- '))
    process.exitCode = 1
    return
  }
  console.log(`通过：${packagePath}（${entries.length} 个条目，无 node_modules，清单入口齐全）`)
}

function present(entries, name) {
  return entries.includes(name)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
}
