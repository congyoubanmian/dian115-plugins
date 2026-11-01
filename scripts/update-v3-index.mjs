#!/usr/bin/env node
// 根据 dist/ 里实际产出的 .dian115p 更新 v3 市场索引：
//   - sha256 用实算值；
//   - source_url 指向本 tag 的 Release 下载地址（v3 索引 schema 要求 https 绝对地址）。
// 输出 v3-market-index.release.json（不直接改仓库里的源文件，由 CI 决定是否回写）。
//
// 用法：TAG=v3-2026.11.01 REPO=congyoubanmian/dian115-plugins node scripts/update-v3-index.mjs

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const tag = process.env.TAG;
const repo = process.env.REPO;
if (!tag || !repo) {
  console.error("需要环境变量 TAG 和 REPO（如 TAG=v3-xxx REPO=owner/repo）");
  process.exit(1);
}

const indexPath = "v3-market-index.json";
if (!existsSync(indexPath)) {
  console.error("缺少 v3-market-index.json");
  process.exit(1);
}

const index = JSON.parse(readFileSync(indexPath, "utf8"));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

let changed = 0;
for (const plugin of index.plugins ?? []) {
  const current = plugin.source_url ?? "";
  const pkgName = current.split("/").pop();
  if (!pkgName || !pkgName.endsWith(".dian115p")) {
    console.warn(`- ${plugin.id}: source_url 不是 .dian115p，跳过（${current}）`);
    continue;
  }
  const distPath = `dist/${pkgName}`;
  if (!existsSync(distPath)) {
    console.error(`- ${plugin.id}: 缺少构建产物 ${distPath}`);
    process.exit(1);
  }
  plugin.sha256 = sha256(distPath);
  plugin.source_url = `https://github.com/${repo}/releases/download/${tag}/${pkgName}`;
  delete plugin.source_url_note;
  changed += 1;
  console.log(`- ${plugin.id}: ${pkgName} sha256=${plugin.sha256}`);
}

const out = "v3-market-index.release.json";
writeFileSync(out, JSON.stringify(index, null, 2) + "\n");
console.log(`已写 ${out}（${changed} 个插件，tag=${tag}）`);
