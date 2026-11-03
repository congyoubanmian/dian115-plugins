// ctx.storage 适配层 —— 页面与后台共用的 KV 读写。
//
// v3 的 KV 带版本号（PUT /storage/{key} 支持 expected_revision 乐观锁；GET 返回
// {value, revision}），SDK 的 storage.get 只返回 value，所以 CAS 需要的 revision
// 经 ctx.api 读原始信封（openapi-v3.json /storage/{key} GET: {value, revision}）。

/** 后台 ctx 只有 ctx.plugin.id（页面才有 ctx.id）；统一取插件 ID。 */
export function pluginIdOf(ctx) {
  const id = ctx?.id ?? ctx?.plugin?.id ?? ''
  if (id === '') throw new Error('缺少插件 ID（ctx.id / ctx.plugin.id）')
  return id
}

/** 构造 kv 适配器：{get, getMeta, set, remove}。get 对 404 返回 null（全新安装）。 */
export function createKv(ctx) {
  const base = `/api/extensions/v3/${pluginIdOf(ctx)}/storage`

  async function getMeta(key) {
    try {
      const payload = await ctx.api.get(`${base}/${encodeURIComponent(key)}`)
      if (payload && typeof payload === 'object' && 'value' in payload) {
        return { value: payload.value ?? null, revision: payload.revision }
      }
      return { value: payload ?? null, revision: undefined }
    } catch (error) {
      // 键不存在：revision 0 = 「只允许首次创建」（storage-and-lifecycle.md：首次创建传 0），
      // 两个写者同时建同一个键时后到的会冲突重读，而不是互相覆盖。
      if (error?.status === 404) return { value: null, revision: 0 }
      throw error
    }
  }

  return {
    /** 读业务值（404 → null）。 */
    async get(key) {
      try {
        return (await ctx.storage.get(key)) ?? null
      } catch (error) {
        if (error?.status === 404) return null
        throw error
      }
    },
    /** 读 {value, revision}（CAS 用）。 */
    getMeta,
    /** 写入；expectedRevision 提供时做乐观锁，冲突抛错（status 409/412）。 */
    async set(key, value, expectedRevision) {
      return ctx.storage.set(key, value, expectedRevision)
    },
    /** 删除（404 视作成功，删幂等）。 */
    async remove(key) {
      try {
        await ctx.storage.remove(key)
      } catch (error) {
        if (error?.status !== 404) throw error
      }
    },
  }
}

/** 带重试的 CAS 读改写：`plan(current)` 返回 `{next, result}`；冲突时重读重试（最多 3 次）。 */
export async function casWrite(kv, key, plan) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value: current, revision } = await kv.getMeta(key)
    const { next, result } = plan(current)
    try {
      await kv.set(key, next, revision)
      return result
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
  throw new Error(`CAS 写入失败: ${key}`)
}
