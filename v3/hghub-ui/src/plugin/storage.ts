/**
 * 插件 KV 持久化适配：把应用原先的 localStorage 持久层换成 ctx.storage（加密 KV）。
 * 页面里 localStorage 在 srcdoc（about:srcdoc 不透明源）下不可用，必须走宿主 KV。
 */
import { pluginCtx } from "./ctx";

const PERSIST_KEY = "persist";

/** 首屏渲染前同步加载（mount 阶段 await）。 */
export async function loadPersist<T>(fallback: T): Promise<T> {
  try {
    const c = pluginCtx();
    if (!c) return fallback;
    const raw = await c.storage.get(PERSIST_KEY);
    if (raw === undefined || raw === null) return fallback;
    return { ...fallback, ...(raw as T) } as T;
  } catch {
    return fallback;
  }
}

/** 防抖保存；页面卸载时尽量落盘一次。 */
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pending: unknown = null;

export function schedulePersistSave(value: unknown): void {
  pending = value;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    const v = pending;
    pending = null;
    const c = pluginCtx();
    if (!c) return;
    c.storage.set(PERSIST_KEY, v).catch(() => {});
  }, 400);
}

export async function flushPersistSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  const v = pending;
  pending = null;
  if (v === null) return;
  const c = pluginCtx();
  if (!c) return;
  await c.storage.set(PERSIST_KEY, v).catch(() => {});
}