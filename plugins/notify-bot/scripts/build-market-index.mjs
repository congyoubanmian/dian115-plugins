import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 生成 DIAN115 插件市场索引 plugin-market/index.json。
// 格式见 docs/plugin-platform/market-index.schema.json:
//   { schema_version, repository{id,name,homepage}, plugins:[市场条目] }
// 市场条目里的 runtime/permissions/sha256 必须与签名包一致，因此这里直接复用
// 打包器产出的 releases/market-entry.generated.json。
//
// 用法:
//   node scripts/build-market-index.mjs --repo=https://github.com/<owner>/<repo>
//   或设置环境变量 DIAN115_MARKET_REPO
// 可选的 --tag 覆盖 GitHub Release 标签（默认 notify-bot-v<version>）。

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entryPath = join(root, 'releases', 'market-entry.generated.json')
if (!existsSync(entryPath)) {
  throw new Error('缺少 releases/market-entry.generated.json，先运行 npm run package')
}

const args = process.argv.slice(2)
const argValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const repoUrl = (argValue('repo') || process.env.DIAN115_MARKET_REPO || '').trim().replace(/\/+$/, '')
if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+$/.test(repoUrl)) {
  throw new Error('需要 GitHub 仓库地址，例如 --repo=https://github.com/owner/repo')
}

const entry = JSON.parse(readFileSync(entryPath, 'utf8'))
const tag = argValue('tag') || `notify-bot-v${entry.version}`
const packageName = `${entry.id}-${entry.version}.d115p`
const packageUrl = `${repoUrl}/releases/download/${tag}/${encodeURIComponent(packageName)}`

const repoParts = repoUrl.split('/')
const owner = repoParts[repoParts.length - 2]
const repoName = repoParts[repoParts.length - 1]

const newEntry = {
  ...entry,
  package_url: packageUrl,
  // 相对路径以索引最终 URL 为基准解析: 索引在 plugin-market/index.json,
  // 图标放 plugin-market/icons/<插件id>.svg。
  icon_url: `icons/${entry.id}.svg`,
}

const indexPath = join(join(root, '..', '..', 'plugin-market'), 'index.json')
let existing = null
try {
  existing = JSON.parse(readFileSync(indexPath, 'utf8'))
} catch {
  existing = null
}

// 市场可收录多个插件: 按 id 增量更新, 保留其它插件的条目。
const plugins = Array.isArray(existing?.plugins) ? existing.plugins.filter((p) => p.id !== newEntry.id) : []
plugins.push(newEntry)
plugins.sort((a, b) => String(a.id).localeCompare(String(b.id)))

const index = {
  schema_version: 1,
  repository: {
    id: `${owner}-${repoName}`.toLowerCase(),
    name: `${repoName} 插件仓库`,
    homepage: repoUrl,
  },
  plugins,
}

// 市场索引属于整个仓库（可收录多个插件），默认写到仓库根目录的 plugin-market/；
// 若插件被单独克隆（没有 plugin-market/ 兄弟目录），退回插件目录内。
const marketRoot = existsSync(join(root, '..', '..', 'plugin-market')) ? join(root, '..', '..', 'plugin-market') : join(root, 'plugin-market')
const outDir = marketRoot
mkdirSync(join(outDir, 'icons'), { recursive: true })
mkdirSync(outDir, { recursive: true })
cpSync(join(root, 'frontend', 'icon.svg'), join(outDir, 'icons', `${entry.id}.svg`))
const outPath = join(outDir, 'index.json')
writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`)

// 顺带产出可复制的安装信息（不参与仓库提交，只用于人工核对）。
writeFileSync(
  join(root, 'releases', 'market-index.local.json'),
  `${JSON.stringify({ market_repo: repoUrl, package_url: packageUrl, sha256: entry.sha256 }, null, 2)}\n`,
)

process.stdout.write(`Market index: ${outPath}\n`)
process.stdout.write(`Package URL: ${packageUrl}\n`)
process.stdout.write(`SHA-256: ${entry.sha256}\n`)
process.stdout.write(`在 DIAN115 插件中心添加仓库时填: ${repoUrl}\n`)
