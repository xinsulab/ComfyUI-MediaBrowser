/**
 * 抽出 mediabrowser.js 里 PLACE_HELPERS 段，真跑 sanitize / 存取 / 缺目录判断。
 * 只扫源码会漏「includes("..") 误伤 foo..bar」这种运行时行为。
 */
import fs from "fs";
import vm from "vm";

const srcPath = process.argv[2];
if (!srcPath) {
  console.error("用法: node run_place_helpers.mjs <mediabrowser.js>");
  process.exit(2);
}
const src = fs.readFileSync(srcPath, "utf8");
const m = src.match(/\/\* PLACE_HELPERS_BEGIN \*\/([\s\S]*?)\/\* PLACE_HELPERS_END \*\//);
if (!m) {
  console.error("mediabrowser.js 缺少 PLACE_HELPERS_BEGIN/END 段");
  process.exit(1);
}
const ctx = {};
vm.runInNewContext(
  m[1] + `
    this.sanitizeCwd = sanitizeCwd;
    this.placeFromStore = placeFromStore;
    this.placeIntoStore = placeIntoStore;
    this.isMissingDirError = isMissingDirError;
  `,
  ctx,
);

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (ctx.sanitizeCwd("foo..bar") !== "foo..bar") {
  fail(`目录名带 .. 应保留，实际: ${JSON.stringify(ctx.sanitizeCwd("foo..bar"))}`);
}
if (ctx.sanitizeCwd("a/../b") !== "") {
  fail("路径段 .. 必须整段丢掉");
}
if (ctx.sanitizeCwd("../secret") !== "") {
  fail("开头的 .. 必须丢掉");
}
if (ctx.sanitizeCwd("作品/原文风") !== "作品/原文风") {
  fail("正常子目录应原样留下");
}
if (ctx.sanitizeCwd("\\\\foo") !== "") {
  fail("反斜杠开头应视为绝对路径丢掉");
}
if (ctx.sanitizeCwd("https://evil") !== "") {
  fail("带 :// 的必须丢掉");
}

const key = "image:input";
const saved = ctx.placeIntoStore({}, key, "input", "foo..bar/子目录");
if (!saved[key] || saved[key].cwd !== "foo..bar/子目录") {
  fail(`save 应留下 foo..bar，实际: ${JSON.stringify(saved[key])}`);
}
const loaded = ctx.placeFromStore(saved, key);
if (loaded.folder !== "input" || loaded.cwd !== "foo..bar/子目录") {
  fail(`load 对不上: ${JSON.stringify(loaded)}`);
}

// 收藏视图和真实根目录必须分开记：用户在 output 收藏后切到收藏，不能悄悄回到节点默认 input。
const favSaved = ctx.placeIntoStore({}, key, "@fav", "", "output");
const favLoaded = ctx.placeFromStore(favSaved, key, "input");
if (favLoaded.folder !== "@fav" || favLoaded.root !== "output") {
  fail(`收藏视图应保留 output 真实根目录，实际: ${JSON.stringify(favLoaded)}`);
}
const legacyFav = ctx.placeFromStore({ [key]: { folder: "@fav", cwd: "" } }, key, "temp");
if (legacyFav.root !== "temp") {
  fail(`旧收藏状态没有 root 时应兼容回退节点根，实际: ${JSON.stringify(legacyFav)}`);
}
const badFavRoot = ctx.placeFromStore(
  { [key]: { folder: "@fav", cwd: "", root: "@recent" } },
  key,
  "input",
);
if (badFavRoot.root !== "input") {
  fail(`虚拟值不能冒充真实根目录，实际: ${JSON.stringify(badFavRoot)}`);
}
const wiped = ctx.placeIntoStore(saved, key, "input", "../x");
if (wiped[key].cwd !== "") {
  fail("非法 cwd 存进去必须变成空");
}
if (ctx.placeFromStore({ [key]: { folder: "hack", cwd: "a" } }, key).folder !== null) {
  fail("不在白名单的根必须丢掉");
}

if (!ctx.isMissingDirError(new Error("目录不存在"))) {
  fail("目录不存在 应视为缺目录");
}
if (!ctx.isMissingDirError(new Error("HTTP 404"))) {
  fail("HTTP 404 应视为缺目录");
}
if (ctx.isMissingDirError(new Error("路径越界"))) {
  fail("越界不是缺目录，不能回退到根");
}

console.log("ok");
