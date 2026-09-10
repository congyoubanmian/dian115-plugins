# DIAN115 插件仓库

这是 DIAN115 的**自定义插件市场仓库**，同时收录插件源码。插件中心添加本仓库地址后，
宿主会自动读取主分支的 `plugin-market/index.json`（也可以直接填该 JSON 的 HTTPS 地址）。

## 结构

```
plugin-market/
├── index.json              # 市场索引：DIAN115 插件中心读取这里
└── icons/<插件id>.svg      # 插件图标（索引里用相对路径引用）
plugins/
└── douban-center/          # 豆瓣中心插件源码（构建与打包见该目录的 README）
```

## 在 DIAN115 里使用

插件中心 → 添加插件仓库 → 填：

```
https://github.com/congyoubanmian/dian115-plugins
```

## 收录的插件

| 插件 id | 名称 | 版本 | 说明 |
| --- | --- | --- | --- |
| `douban.center` | 豆瓣中心 | 0.2.8 | 周期抓取豆瓣榜单，经观察队列自动创建聚合订阅 |

## 新增一个插件

1. 把源码放到 `plugins/<插件目录>/`，按该目录的 README 构建
2. 把生成的 `.d115p` 传到公开的 HTTPS 地址（建议用对应仓库的 GitHub Release 附件；
   包不要提交进仓库）
3. 在插件目录里执行，把条目写进市场索引（按 `id` 增量更新，不影响其它插件）：

   ```bash
   npm run market -- --repo=<本仓库地址>
   ```

4. 在 DIAN115 插件中心重新添加/刷新本仓库

## 发布边界

本仓库只提交插件索引、图标和插件源码；**不提交**签名私钥、构建产物和 `.d115p` 包
（见 `.gitignore`）。插件包通过 HTTPS 分发地址提供，宿主安装时会校验包的完整性、
签名、Manifest、权限与运行时披露，且要求市场条目与包内清单逐项一致。
