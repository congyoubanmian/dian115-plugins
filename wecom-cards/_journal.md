# 共享日志 · wecom-cards 卡片组

> 各子代理开工前先读本文件吸收基线; 收工追加一节(组名/事件数/字段取舍/speculative 判断/给后续子代理的提示, 每条一行)。

## 图文组(news_notice) — 5 事件(本次分区)
- 事件: media_library_add / media_library_update / library_organize_success / tg_auto_transfer / subscribe_landed, 输出 `图文组(news_notice).json`(JSON 数组, 元素含 event 键便于宿主索引)。
- 基线模板: `douban-center-wasm/notify-wecom-templates.json`(md 版), 占位符沿用宿主 Jinja `{{ var }}` / `{% if %}`, 变量名全部取自 md 版, 未自造。
- 字段口径: news_notice = source.desc "Dian115 媒体中心" + main_title(title/desc, desc 放 🕐 时间) + card_image + vertical_content_list(≤4: 年份/类型/大小或文件数/画质) + card_action(type=1 url); subscribe_landed 另加 jump_list(1 条 TMDB 详情, ≤3)。
- 图片: 全部用 card_image(1 图模式), url=`{% if picurl %}https://dian115.congyoubanmian.com{{ picurl }}{% endif %}`, aspect_ratio=1.78(官方区间 1.3~2.25 内); 未用 image_text_area(二选一满足)。
- speculative: picurl 缺失时 card_image.url 渲染为空串——官方 url 为必填, 需宿主保证 image_mode=auto 事件带 picurl 或降级; 此风险已记录未解决。
- speculative: `dian115_offline_finished` / `dian115_offline_task_finished` 两条卡片为前次同组子代理所造, 事件本身不在 notify-wecom-templates.json 中(宿主是否有此事件未验证), 本次保留未删。
- 校验: `python3` 断言全部 7 条 card_type=news_notice、card_image 存在、aspect_ratio∈[1.3,2.25]、vertical_content_list≤4、jump_list≤3、card_action 存在, 全通过。
- 给后续子代理: 文本组/按钮组文件已存在可对照口径; card_action.url 统一 `https://dian115.congyoubanmian.com`, TMDB 类事件用 `{% if tmdb_link %}` 回退; 缺值一律回退 "—" 避免渲染空串。

## 按钮组(button_interaction) — 5 事件(本次分区)
- 事件: library_organize_fail / library_organize_skip / dian115_self_update / strm_generate / container_update_result, 输出 `按钮组(button_interaction).json`(JSON 数组, 元素含 event 键)。
- 信封结构统一为 {"event","msgtype","template_card"}; 旧文件 {"event","payload"} 写法已废弃覆写。
- 关键 doc 事实(官方 path/94888): button_interaction **不支持 vertical_content_list**(仅 news_notice 有); sub_title_text 与 horizontal_content_list **不互斥**可同时用; button_selection 与 button_list 也不互斥; button_list 必填≤6、style 仅 1~4、type=0 回调 key 必填不重复、type=1 必填 url、文案≤10字; horizontal_content_list ≤6 且 keyname ≤5字。
- 字段口径: source.desc "Dian115 媒体中心" + main_title(desc 放 🕐 时间) + sub_title_text(错误/原因/明细等长文本) + horizontal_content_list(短字段) + card_action(1→dian115) + button_list; 每卡 ≥1 个 type=0 回调(重试/确认) + ≥1 个 type=1 跳 dian115, 媒体相关加跳 TMDB。
- 回调 key 稳定语义: library_organize_retry(fail/skip 共用) / dian115_update_retry / strm_regenerate / container_update_retry。
- 旧文件 3 个遗留事件(tg_auto_transfer_failed / dian115_wash / dian115_wash_fail)不在本次分区且不在 md 基线模板中, 旧卡片还误用了 vertical_content_list, 已整卡移除未保留; 如宿主真有这些事件请重新指派补做。
- speculative: main_title.desc / source.desc 沿用兄弟组基线, doc 中为可选字段, 宿主是否渲染未实测; Jinja 变量名全部取自 md 版未自造, 但与宿主代码未逐一核对。
- 校验: `python3` 断言 JSON 合法、事件清单与任务一致、无文档外字段、无 vertical_content_list、button/列表条数与长度、type-key/url 配对、style∈1~4、Jinja if/endif 配平, 全部 PASS。

## 文本组(text_notice) — 9 事件(本次重写)
- 事件: account_checkin / account_migration / account_cookie_invalid / dianying_checkin / subscribe_added / subscribe_partial / daily_statistics_report / emby_library_statistics_report / proxy_health_daily_report, 全部与 notify-wecom-templates.json 键一一对应, 输出 `文本组(text_notice).json`(JSON 数组, 含 event 键)。
- 重要: 旧版 `文本组(text_notice).json` 含 subscribe_created/updated/deleted、subscribe_pool_created、air_calendar_update、strm_sync、rules_sync、rules_generate、dian115_rank(_update) 等 10 条 md 版不存在的事件(疑为更早子代理 speculative 所造), 本次按任务键集整体覆盖重写未保留; 若宿主确有这些事件需另起任务补回。
- 字段口径: source.desc "Dian115 媒体中心" + main_title(emoji+等价标题, 卡片不渲染 md 粗体故去掉 **; desc 放 🕐/📅 时间) + sub_title_text(状态/来源/统计摘要) + horizontal_content_list(≤6 关键指标) + jump_list(≤3, dian115 主页; subscribe_added/partial 另挂 TMDB) + card_action(type=1 必填)。
- 变量全部取自 md 版同事件模板, `python3` 校验通过(9 事件/card_type/horizontal≤6/jump≤3/card_action 存在/变量与 md 版一致); daily/emby 报告的 for 循环(latest_media/recent_media)沿用 md 写法。
- speculative: subscribe_added / subscribe_partial 的 tmdb_link 在 md 版对应事件中未出现(仅 subscribe_landed 用了), jump/card_action 以 `{% if tmdb_link %}` 回退 themoviedb.org / dian115, 宿主不给该变量时渲染仍安全。
- speculative: daily/emby 统计报告 sub_title_text 内含 for 循环拼全部条目, 条目多时渲染后可能超 160 字上限; 未用 `[:3]` 切片(宿主 Jinja 引擎是否支持切片未验证), 建议宿主侧截断。
- speculative: account_migration / dianying_checkin 等 title/sub_title 含 file_name/status_message/details 变量, 渲染后理论上可超 36/160 字, 与 md 版同风险, 未处理。
- proxy_health_daily_report 上传/下载沿用 md 口径 `{{ upload_bytes }} B`(原始字节数), 未做单位换算。

## 落库员 — 19 事件已落库(2026-10-06 02:03)
- 实际写入路径: 宿主 SQLite `/volume1/docker/dian115/config/dian115.db` → `settings` 表 `key='notify_config'` 的 JSON value, 单事务 `BEGIN IMMEDIATE; UPDATE ...; COMMIT` 完成; updated_at 由 DB 触发为 2026-10-05 18:03:43(UTC)。
- 宿主覆盖层结构发现: `channel_templates.wecom` 共 41 键, 每键字段仅 `title/text/image_mode/render_mode`(md 覆盖层), 无官方卡片字段; 全库 grep 宿主插件 build(douban-center/notify-bot)无 `template_card`/`card_template` 引用, 即宿主渲染端是否消费卡片字段未验证。
- 键名决定: 采用额外键 `card_template`(与 ask 的 fallback 一致), **speculative**——宿主是否渲染未实测; 内容为 `{"msgtype":"template_card","template_card":{...}}`(剥离 event 键)。
- 备份: `/volume1/homes/zhaoyuan/backups/notify_config-cards-20261006-020326.json`(写前快照, 55377 字符)。
- 写入 19 事件 = 图文 5 + 按钮 5 + 文本 9; 其中 14 键为覆盖前次 run(01:38) 已写的旧 card_template, 5 键新增(container_update_result/dianying_checkin/subscribe_added/subscribe_partial/proxy_health_daily_report); 6 键新旧 payload 深比较相同(幂等)。
- 跳过 2 事件: `dian115_offline_finished` / `dian115_offline_task_finished`(图文组文件内遗留), 宿主 41 键中不存在, 未创建新键。
- 校验(全部重读 DB 实跑): wecom 键数==41 PASS; 含 card_template 事件数==19 且集合==预期 PASS; card_type 分布 text 9/news 5/button 5 PASS; 19 键 card_template 与三组文件 payload 逐一深等 PASS; 对备份深 diff 28 个叶子路径全部位于 19 键的 card_template 子树内 PASS; templates/channel_policies/wecom 连接配置及其余渠道不变 PASS; 41 键 title/text md 覆盖保留 PASS。
