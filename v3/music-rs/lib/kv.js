// ctx.storage 适配层 —— 页面与后台共用的 KV 读写。
//
// v3 的 KV 带版本号（PUT /storage/{key} 支持 expected_revision 乐观锁；GET 返回
// {value, revision}），SDK 的 storage.get 只返回 value，所以 CAS 需要的 revision
// 经 ctx.api 读原始信封（openapi-v3.json /storage/{key} GET: {value, revision}）。

/** 构造 kv 适配器：{get, getMeta, set, remove}。get 对 404 返回 null（全新安装）。 */
export function createKv(ctx) {
  const base = `/api/extensions/v3/${ctx.id}/storage`

  async function getMeta(key) {
    try {
      const payload = await ctx.api.get(`${base}/${encodeURIComponent(key)}`)
      if (payload && typeof payload === 'object' && 'value' in payload) {
        return { value: payload.value ?? null, revision: payload.revision }
      }
      return { value: payload ?? null, revision: undefined }
    } catch (error) {
      if (error?.status === 404) return { value: null, revision: undefined }
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
