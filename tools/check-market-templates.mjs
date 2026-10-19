#!/usr/bin/env node
// 校验每个插件的 market-entry.template.json 是否与 manifest.template.json 保持一致，
// 并按 vendored 的 tools/market-index.schema.json 校验发布时实际会生成的条目。
//
// 背景：market-entry 的版本 / runtime 披露 / permissions 曾经落后于 manifest，
// 只能靠人工发现。CI 里的 project-check 只在单个插件目录内比较，且不强制遍历
// 所有默认模板；本脚本从仓库根扫描 plugins/*/manifest.template.json，逐一配对。
//
// 版本按发版流程归一化：三个 release workflow 都会在执行 project-check 前用
// manifest.version 覆盖模板 version（模板 version 不随发版维护），所以这里同样
// 用 manifest.version 参与比较与 schema 校验，模板 version 落后只输出提示。
//
// buildMarketEntry 会把 manifest.permissions 原样复制进市场条目，而 manifest
// schema 允许 host_access/optional、apis 上限 512，市场 schema 不允许这些字段且
// 上限 128。因此这里必须校验“派生后的市场条目”，否则会出现 false green。
//
// 仅使用 Node 标准库，无第三方依赖。

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 从脚本位置推导仓库根：<repo>/tools/check-market-templates.mjs -> <repo>
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const RUNTIME_TRUST_LEVEL = 'wasm-sandbox'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// 深比较：对象按“键集合”比较（JSON 键顺序无意义），数组按顺序比较。
const deepEqual = (actual, expected) => {
  if (actual === expected) return true
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false
    return actual.every((item, index) => deepEqual(item, expected[index]))
  }
  if (isPlainObject(actual) && isPlainObject(expected)) {
    const actualKeys = Object.keys(actual)
    const expectedKeys = Object.keys(expected)
    if (actualKeys.length !== expectedKeys.length) return false
    return expectedKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(actual, key) && deepEqual(actual[key], expected[key]),
    )
  }
  return false
}

// 缺失值用可读文本表示，避免 JSON.stringify(undefined) 返回 undefined。
const show = (value) => (value === undefined ? '(缺失)' : JSON.stringify(value, null, 2))

const readJSON = (path, label, errors) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    errors.push(`${label} 无法读取或不是合法 JSON（${path}）：${error?.message || error}`)
    return undefined
  }
}

const jsonType = (value) => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

const matchesType = (value, expected) => {
  switch (expected) {
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    case 'integer':
      return Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
    case 'boolean':
      return typeof value === expected
    default:
      return true
  }
}

// 解析 schema 内部的 JSON Pointer（本仓库用到的均为 #/$defs/...）。
const resolvePointer = (root, pointer) => {
  if (!pointer.startsWith('#/')) throw new Error(`不支持的 $ref: ${pointer}`)
  return pointer
    .slice(2)
    .split('/')
    .reduce((node, token) => {
      const key = decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~')
      return isPlainObject(node) || Array.isArray(node) ? node[key] : undefined
    }, root)
}

// 极简 JSON Schema 校验器：覆盖 vendored schema 实际使用的关键字
// （type/required/properties/additionalProperties/items/oneOf/allOf/enum/const/
// pattern/minLength/maxLength/minItems/maxItems/uniqueItems/minimum/maximum/$ref）。
// format 是注解，不在这里校验。
const validateSchema = (value, schema, path, errors, root) => {
  if (schema === false) {
    errors.push(`${path}: 不允许出现该字段（schema 为 false）`)
    return
  }
  if (schema === true || schema === undefined || schema === null) return
  if (!isPlainObject(schema)) return

  if (typeof schema.$ref === 'string') {
    const target = resolvePointer(root, schema.$ref)
    if (target === undefined) {
      errors.push(`${path}: 无法解析 $ref ${schema.$ref}`)
      return
    }
    validateSchema(value, target, path, errors, root)
  }

  for (const sub of schema.allOf || []) validateSchema(value, sub, path, errors, root)

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((sub) => {
      const branchErrors = []
      validateSchema(value, sub, path, branchErrors, root)
      return branchErrors
    })
    const matched = branches.filter((branchErrors) => branchErrors.length === 0).length
    if (matched !== 1) {
      errors.push(`${path}: 必须恰好匹配 oneOf 中的一个分支（实际匹配 ${matched} 个）`)
      // 0 个分支匹配时附上最接近的分支明细，便于定位。
      if (matched === 0 && branches.length > 0) {
        const closest = branches.reduce((best, current) => (current.length < best.length ? current : best))
        for (const message of closest) errors.push(`  ${message}`)
      }
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: 类型应为 ${types.join(' 或 ')}，实际为 ${jsonType(value)}`)
      return
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(value, schema.const)) {
    errors.push(`${path}: 必须等于 ${show(schema.const)}，实际为 ${show(value)}`)
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) {
    errors.push(`${path}: 必须是 ${schema.enum.map((item) => show(item)).join(' / ')} 之一，实际为 ${show(value)}`)
  }

  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) {
      errors.push(`${path}: 长度至少 ${schema.minLength} 个字符，实际 ${length}`)
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      errors.push(`${path}: 长度最多 ${schema.maxLength} 个字符，实际 ${length}`)
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: 不匹配 pattern ${schema.pattern}`)
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: 不能小于 ${schema.minimum}，实际 ${value}`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: 不能大于 ${schema.maximum}，实际 ${value}`)
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: 至少 ${schema.minItems} 项，实际 ${value.length}`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: 最多 ${schema.maxItems} 项，实际 ${value.length}`)
    }
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index += 1) {
        for (let previous = 0; previous < index; previous += 1) {
          if (deepEqual(value[index], value[previous])) {
            errors.push(`${path}[${index}]: 与 [${previous}] 重复（uniqueItems: true）`)
          }
        }
      }
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, errors, root))
    }
  }

  if (isPlainObject(value)) {
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push(`${path}: 缺少必填字段 ${required}`)
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateSchema(value[key], sub, `${path}.${key}`, errors, root)
      }
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) continue
        if (schema.additionalProperties === false) {
          errors.push(`${path}: 不允许出现未声明的字段 ${key}（additionalProperties: false）`)
        } else if (isPlainObject(schema.additionalProperties)) {
          validateSchema(value[key], schema.additionalProperties, `${path}.${key}`, errors, root)
        }
      }
    }
  }
}

// package_url 的文件名必须与当前 manifest 版本一致；tag 命名各插件不同，不在这里约束。
const packageBaseName = (value) => {
  if (typeof value !== 'string') return ''
  try {
    return new URL(value, 'https://invalid.local/').pathname.split('/').pop() || ''
  } catch {
    return ''
  }
}

/**
 * @param {{ root?: string }} [options]
 * @returns {{ errors: string[], notes: string[], checkedPlugins: string[] }}
 */
export function checkMarketTemplates({ root = repoRoot } = {}) {
  const pluginsRoot = join(root, 'plugins')
  const errors = []
  const notes = []
  const checkedPlugins = []

  if (!existsSync(pluginsRoot)) {
    errors.push(`找不到插件目录 ${pluginsRoot}`)
    return { errors, notes, checkedPlugins }
  }

  const schemaPath = join(root, 'tools', 'market-index.schema.json')
  const marketSchema = readJSON(schemaPath, 'market-index.schema.json', errors)
  const pluginSchema = isPlainObject(marketSchema) ? marketSchema.$defs?.plugin : undefined
  if (isPlainObject(marketSchema) && !isPlainObject(pluginSchema)) {
    errors.push('market-index.schema.json 缺少 $defs.plugin，无法校验市场条目')
  }

  const pluginDirs = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const plugin of pluginDirs) {
    const pluginDir = join(pluginsRoot, plugin)
    const manifestPath = join(pluginDir, 'manifest.template.json')
    if (!existsSync(manifestPath)) continue // 只检查带有 manifest 模板的插件目录

    checkedPlugins.push(plugin)
    const marketPath = join(pluginDir, 'market-entry.template.json')
    const prefix = `插件 ${plugin}（${relative(root, pluginDir)}）`

    if (!existsSync(marketPath)) {
      errors.push(`${prefix}：缺少同目录的 market-entry.template.json（${relative(root, marketPath)}）`)
      continue
    }

    const pluginErrors = []
    const manifest = readJSON(manifestPath, 'manifest.template.json', pluginErrors)
    const market = readJSON(marketPath, 'market-entry.template.json', pluginErrors)

    if (isPlainObject(manifest) && isPlainObject(market)) {
      if (market.id !== manifest.id) {
        pluginErrors.push(`id 不一致：\n  期望（manifest）: ${show(manifest.id)}\n  实际（market-entry）: ${show(market.id)}`)
      }

      // 发版流程会用 manifest.version 覆盖模板 version；这里按同一规则归一化，
      // 不要求手工维护模板版本，只提示差异。
      if (market.version !== manifest.version) {
        notes.push(
          `${prefix}：market-entry.version 为 ${show(market.version)}，发布时按 manifest.version ${show(manifest.version)} 归一化后校验`,
        )
      }

      let expectedRuntime
      if (!isPlainObject(manifest.runtime)) {
        pluginErrors.push('manifest.runtime 缺失或不是对象，无法推导 market-entry.runtime')
      } else if (typeof manifest.runtime.kind !== 'string' || typeof manifest.runtime.protocol !== 'string') {
        pluginErrors.push('manifest.runtime.kind 或 manifest.runtime.protocol 缺失')
      } else {
        expectedRuntime = {
          kind: manifest.runtime.kind,
          protocol: manifest.runtime.protocol,
          autostart: true,
          trust_level: RUNTIME_TRUST_LEVEL,
        }
        if (!deepEqual(market.runtime, expectedRuntime)) {
          pluginErrors.push(
            `runtime 披露不一致：\n  期望（由 manifest 推导）: ${show(expectedRuntime)}\n  实际（market-entry.runtime）: ${show(market.runtime)}`,
          )
        }
      }

      if (!isPlainObject(manifest.permissions)) {
        pluginErrors.push('manifest.permissions 缺失或不是对象，无法与 market-entry.permissions 比较')
      } else if (!deepEqual(market.permissions, manifest.permissions)) {
        pluginErrors.push(
          `permissions 不一致：\n  期望（manifest.permissions）: ${show(manifest.permissions)}\n  实际（market-entry.permissions）: ${show(market.permissions)}`,
        )
      }

      // 模板里的 package_url 会原样进入 releases/market-entry.generated.json，
      // 直到 build-market-index 才按 tag 重写；先保证文件名与版本一致。
      const packageName = `${manifest.id}-${manifest.version}.d115p`
      if (packageBaseName(market.package_url) !== packageName) {
        pluginErrors.push(
          `package_url 文件名应为 ${packageName}（当前 ${show(market.package_url)}），避免模板/生成物引用旧版本包`,
        )
      }

      // 本地有发布包时顺带核对 sha256（CI checkout 不含 releases/，会自动跳过）。
      const artifactPath = join(pluginDir, 'releases', packageName)
      if (existsSync(artifactPath)) {
        const digest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
        if (market.sha256 !== digest) {
          pluginErrors.push(
            `sha256 与本地发布包不一致：\n  期望（${relative(root, artifactPath)}）: ${digest}\n  实际（market-entry.sha256）: ${show(market.sha256)}`,
          )
        }
      }

      // 校验 buildMarketEntry 实际会写进市场索引的条目：版本、id、runtime、
      // permissions、tags 都按 manifest 覆盖。manifest 权限一旦含有市场 schema
      // 不允许的字段（host_access/optional）或超过 128 条 apis，这里必须失败。
      if (isPlainObject(pluginSchema)) {
        const derived = {
          ...market,
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.publisher?.name,
          homepage: manifest.homepage,
          permissions: manifest.permissions,
          tags: manifest.tags || [],
        }
        if (expectedRuntime) derived.runtime = expectedRuntime
        // JSON.stringify 会丢弃 undefined；这里同步丢弃，避免把“缺失”误报成类型错误。
        for (const key of Object.keys(derived)) {
          if (derived[key] === undefined) delete derived[key]
        }
        const schemaErrors = []
        validateSchema(derived, pluginSchema, '$', schemaErrors, marketSchema)
        for (const message of schemaErrors) {
          pluginErrors.push(`不符合 market-index.schema.json：${message}`)
        }
      }
    } else if (manifest !== undefined && !isPlainObject(manifest)) {
      pluginErrors.push('manifest.template.json 的顶层必须是 JSON 对象')
    } else if (market !== undefined && !isPlainObject(market)) {
      pluginErrors.push('market-entry.template.json 的顶层必须是 JSON 对象')
    }

    for (const message of pluginErrors) errors.push(`${prefix}：${message}`)
  }

  return { errors, notes, checkedPlugins }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const { errors, notes, checkedPlugins } = checkMarketTemplates()
  for (const note of notes) process.stdout.write(`提示：${note}\n`)
  if (errors.length > 0) {
    process.stderr.write(`市场模板检查失败：发现 ${errors.length} 处问题\n\n`)
    process.stderr.write(`${errors.join('\n\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`市场模板检查通过：${checkedPlugins.length} 个插件（${checkedPlugins.join(', ')}）\n`)
}
