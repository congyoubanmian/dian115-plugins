// chase-rs 的界面构建配置：产物写到 ../v3/chase-rs/ui/page.js。
// 具体规则见 vite.base.config.mjs（三个插件共用同一套输出约定）。

import { createConfig } from './vite.base.config.mjs'

export default createConfig('chase-rs')
