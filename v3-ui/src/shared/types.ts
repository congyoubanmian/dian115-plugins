// 宿主 v3 页面上下文（ctx）的最小类型声明。
//
// 只声明页面真正会用到的那部分，字段形状以 v3-kit/docs/api-reference.md 第 2 节
// 「页面 ctx」为准：api / storage / settings / tasks / http / files / cd2 / watch /
// notifications / cookiecloud / theme / signal。宿主把同一个 ctx 对象交给 mount(el, ctx)，
// 页面所有数据与能力都只能从这里走（不要直接 fetch 宿主业务接口）。
//
// 完整 SDK 类型在 v3-kit/docs/sdk/index.d.ts（官方开发套件镜像，不随本仓库入库），
// 需要更细的类型时可以照着它补。

/** 宿主明暗主题。 */
export interface HostTheme {
  readonly mode: 'light' | 'dark'
  /** 立即回调当前值，返回取消订阅函数。 */
  subscribe(fn: (mode: 'light' | 'dark') => void): () => void
}

/** 页面可用的宿主能力（子集）。 */
export interface HostContext {
  id: string
  api: {
    get<T = unknown>(path: string): Promise<T>
    post<T = unknown>(path: string, body?: unknown): Promise<T>
    put<T = unknown>(path: string, body?: unknown): Promise<T>
    patch<T = unknown>(path: string, body?: unknown): Promise<T>
    delete<T = unknown>(path: string): Promise<T>
    head<T = unknown>(path: string): Promise<T>
  }
  storage: {
    get<T = unknown>(key: string): Promise<T | null>
    set<T = unknown>(key: string, value: T, expectedRevision?: number): Promise<{ revision: number }>
    remove(key: string): Promise<unknown>
    list(limit?: number, offset?: number): Promise<Array<{ key: string; value: unknown }>>
  }
  settings: {
    get<T = Record<string, unknown>>(): Promise<T>
    set(value: Record<string, unknown>): Promise<{ revision: number }>
  }
  tasks: {
    run(job: string, businessKey: string, input?: unknown): Promise<{ id: string; [k: string]: unknown }>
    list(limit?: number, offset?: number): Promise<Array<{ id: string; [k: string]: unknown }>>
    get(id: string): Promise<{ id: string; [k: string]: unknown }>
    cancel(id: string): Promise<unknown>
    retry(id: string): Promise<{ id: string; [k: string]: unknown }>
  }
  http: {
    request(options: Record<string, unknown>): Promise<{ status?: number; body?: unknown; [k: string]: unknown }>
    cookies?(): Promise<unknown>
    importCookies?(options: Record<string, unknown>): Promise<unknown>
  }
  files: {
    call(options: Record<string, unknown>): Promise<{ task_id: string; result?: unknown }>
    start(options: Record<string, unknown>): Promise<{ task_id: string }>
    downloadURL(path: string, options?: { inline?: boolean }): string
    upload(path: string, file: Blob): Promise<unknown>
  }
  cd2: {
    call(method: string, options: Record<string, unknown>): Promise<unknown>
  }
  watch: {
    list(): Promise<unknown>
    add(options: Record<string, unknown>): Promise<unknown>
    remove(id: string): Promise<unknown>
  }
  notifications: {
    send(options: Record<string, unknown>): Promise<unknown>
    channels(): Promise<Array<{ id: string; [k: string]: unknown }>>
  }
  notify?(options: Record<string, unknown>): Promise<unknown>
  cookiecloud(operation: string, options?: Record<string, unknown>): Promise<unknown>
  events?: { catalog(): Promise<Array<{ type: string; [k: string]: unknown }>> }
  usage?(): Promise<Record<string, number>>
  /** 页面关闭/卸载时中止的信号；长请求都要带上它。 */
  signal?: AbortSignal
  /** 宿主明暗主题（老宿主可能没有这���，按可选处理）。 */
  theme?: HostTheme
  [key: string]: unknown
}
