# 行为基准归档（原生 JS 版页面）

这里是三个 v3 插件**改写前的原生 JS 版页面**，是本次 Vue 3 改写的**功能基准**。

| 插件 | 归档文件 | 来源 |
| --- | --- | --- |
| chase-rs | `chase-rs/page.js`、`chase-rs/page.native.js` | `v3/chase-rs/ui/page.js`（改写前） |
| music-rs | `music-rs/page.js`、`music-rs/page.native.js`、`music-rs/qr.js` | `v3/music-rs/ui/page.js`、`v3/music-rs/ui/qr.js`（改写前） |
| douban-rs | `douban-rs/page.js`、`douban-rs/page.native.js` | `v3/douban-rs/ui/page.js`（改写前） |

`page.native.js` 是**只读原件**；`page.js` 是对照用的副本。`scripts/v3-build-ui.sh`
每次构建前会比对两者，不一致就用原件把 `page.js` 校正回来——改写任务若把构建产物
复制进 `page.js`，基准就被盖掉了，这份自动校正正是为了防住这一点。

## 为什么留在这里

`v3/<plugin>/ui/page.js` 是构建产物，会被 `scripts/v3-build-ui.sh` 反复覆盖；
功能基准一旦被覆盖就没了。改写页面的任务需要随时对照"原来有哪些功能"，
所以把原生 JS 版单独归档在这里，**只读、不参与构建**。

注意：`v3/<plugin>/ui/page.js` 在本次改造开始前就是原生 JS 版（它本身就是可用实现、
离线测试通过）。Vue 底座跑通后它被构建产物覆盖了，原生版就是靠这份归档保住的。

## 怎么用

改写 Vue 页面时逐项对齐归档文件的功能清单：

- chase-rs：页头（状态/日报胶囊 + 动作组）、8 块指标瓦片、对齐结果卡（筛选 pill）、
  双栏（补订建议 + 追剧日历）、探测诊断折叠条、最近动作、设置抽屉。
- music-rs：四个分页（搜索 / 登录 / 队列 / 最近动作）、网易云扫码登录卡（unikey + 二维码 + 轮询）、
  手动粘贴 Cookie、CookieCloud 同步、下载队列状态与重试、歌单整单入队。
- douban-rs：榜单海报墙（含镜像回退与海报放大）、观察队列 / 我的想看双栏、
  历史日志、设置表单、订阅动作与批量到期入口。

归档里的 `music-rs/qr.js` 是原生 music 页面用的二维码编码模块（相对 import `./qr.js`），
Vue 版二维码逻辑从 `plugins/music-rs/frontend/src/qr.ts` 移植，不依赖这个文件。
