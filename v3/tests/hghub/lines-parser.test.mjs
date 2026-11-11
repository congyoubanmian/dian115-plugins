// 镜像发布页解析工具单测（node 原生 TS 运行；对应 Rust 侧 lines.rs 用例）。
import { strict as assert } from "node:assert";
import { jsArray, scriptSrc, absoluteUrl, stripLineComments } from "../../hghub-ui/src/plugin/ctx.ts";

const SAMPLE = `
var subdomains = [
    'thu',  // 清华
    'pku',  // 北大
];
var urls=[
	'xxbgwypx.cc/',
];
var otherUrls = [
	'https://huangguoai.pages.dev',
];
var foreverUrls = [
	  'https://huangguoai.com',
	JumpPage,
	'https://huangguoai.ai',
];
`;

assert.deepEqual(jsArray(SAMPLE, "var urls"), ["xxbgwypx.cc/"]);
assert.deepEqual(jsArray(SAMPLE, "var subdomains"), ["thu", "pku"]);
assert.deepEqual(jsArray(SAMPLE, "var foreverUrls"), ["https://huangguoai.com", "JumpPage", "https://huangguoai.ai"]);
assert.deepEqual(jsArray(SAMPLE, "var missing"), []);

assert.equal(
  absoluteUrl("https://huangguoai.pages.dev/", "publish.js?20261103-2"),
  "https://huangguoai.pages.dev/publish.js?20261103-2",
);
assert.equal(absoluteUrl("https://huangguoai.pages.dev/", "/a/b.js"), "https://huangguoai.pages.dev/a/b.js");

const html = '<link rel="stylesheet" href="publish.css?1" /><script type="text/javascript" src="publish.js?20261103-2"></script>';
assert.equal(scriptSrc(html), "publish.js?20261103-2");
assert.equal(scriptSrc("<html></html>"), null);

// 行尾注释剥离：引号内的 // 必须保留（URL）
assert.equal(stripLineComments("'a' , // note\n'b//c'"), "'a' , \n'b//c'");

console.log("lines-parser: all tests passed");