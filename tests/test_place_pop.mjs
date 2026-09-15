/** 从 mediabrowser.js 抽出 fitFixedPop，验浮层不会贴死角落。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "web", "mediabrowser.js"), "utf8");
const start = src.indexOf("function fitFixedPop(");
if (start < 0) {
  console.error("RED: fitFixedPop 还没写进 mediabrowser.js");
  process.exit(1);
}
let depth = 0, end = -1;
for (let i = start; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") {
    depth--;
    if (depth === 0) { end = i + 1; break; }
  }
}
if (end < 0) throw new Error("无法截取 fitFixedPop");
const fn = src.slice(start, end);
const fitFixedPop = new Function(`${fn}; return fitFixedPop;`)();

// 再抽一个：按名字截出函数体，脱开 DOM 直接测
const grab = (name) => {
  const a = src.indexOf(`function ${name}(`);
  if (a < 0) { console.error(`RED: mediabrowser.js 里找不到 ${name}`); process.exit(1); }
  let d = 0, b = -1;
  for (let i = a; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}" && --d === 0) { b = i + 1; break; }
  }
  return new Function(`${src.slice(a, b)}; return ${name};`)();
};
const placeAsidePop = grab("placeAsidePop");

const rect = (l, t, w, h) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h });

const inView = (p, pw, ph, vw, vh, pad = 8) =>
  p.left >= pad - 0.5 && p.top >= pad - 0.5 &&
  p.left + pw <= vw - pad + 0.5 && p.top + ph <= vh - pad + 0.5;

let failed = 0;
const check = (name, ok, extra = "") => {
  if (ok) console.log(`  ok  ${name}`);
  else { failed++; console.error(`  FAIL ${name} ${extra}`); }
};

{
  // 全屏查看器：信息钮在底栏偏右（图2复现）
  const ar = rect(1400, 1000, 44, 38);
  const pw = 540, ph = 400, vw = 1920, vh = 1080;
  const p = fitFixedPop(pw, ph, ar, vw, vh);
  check("viewer: 在视口内", inView(p, pw, ph, vw, vh), JSON.stringify(p));
  check("viewer: 在按钮上方", p.top + ph <= ar.top + 1, `top=${p.top}`);
  check("viewer: 不贴右下角", !(p.left > vw - pw - 20 && p.top > vh - ph - 20), JSON.stringify(p));
  check("viewer: 水平靠近按钮", p.left <= ar.right && p.left + pw >= ar.left, JSON.stringify(p));
}

{
  // 格子靠左
  const ar = rect(20, 80, 200, 200);
  const pw = 540, ph = 200, vw = 1180, vh = 800;
  const p = fitFixedPop(pw, ph, ar, vw, vh);
  check("grid-left: 在视口内", inView(p, pw, ph, vw, vh), JSON.stringify(p));
}

{
  // 格子贴右
  const ar = rect(900, 80, 200, 200);
  const pw = 540, ph = 200, vw = 1180, vh = 800;
  const p = fitFixedPop(pw, ph, ar, vw, vh);
  check("grid-right: 在视口内", inView(p, pw, ph, vw, vh), JSON.stringify(p));
}

{
  // 锚点在顶上：应该在下方
  const ar = rect(100, 10, 40, 32);
  const pw = 300, ph = 180, vw = 800, vh = 600;
  const p = fitFixedPop(pw, ph, ar, vw, vh);
  check("top-anchor: 在视口内", inView(p, pw, ph, vw, vh), JSON.stringify(p));
  check("top-anchor: 在按钮下方", p.top >= ar.bottom - 1, `top=${p.top}`);
}

{
  // 弹层比视口矮一截：仍夹在 pad 内
  const ar = rect(10, 10, 40, 32);
  const pw = 900, ph = 700, vw = 800, vh = 600;
  const p = fitFixedPop(pw, ph, ar, vw, vh);
  const useW = Math.min(pw, vw - 16), useH = Math.min(ph, vh - 16);
  check("huge: 夹在视口内", inView(p, useW, useH, vw, vh), JSON.stringify(p));
}

{
  // 右键一张图调遮蔽：浮层不能压住那张图 —— 压住了就得关掉才知道调对没有
  const cellR = rect(300, 200, 260, 260);
  const pw = 280, ph = 420, vw = 1920, vh = 1080;
  const p = placeAsidePop(pw, ph, cellR, vw, vh);
  const ox = Math.max(0, Math.min(p.left + pw, cellR.right) - Math.max(p.left, cellR.left));
  const oy = Math.max(0, Math.min(p.top + ph, cellR.bottom) - Math.max(p.top, cellR.top));
  check("aside: 不压住目标格子", ox * oy === 0, `重叠 ${ox}x${oy}`);
  check("aside: 仍在视口内", inView(p, pw, ph, vw, vh), JSON.stringify(p));
}

{
  // 图贴在右边缘：右侧放不下，应当翻到左边
  const cellR = rect(1600, 300, 260, 260);
  const pw = 280, ph = 420, vw = 1920, vh = 1080;
  const p = placeAsidePop(pw, ph, cellR, vw, vh);
  check("aside: 右边放不下就翻左边", p.left + pw <= cellR.left, JSON.stringify(p));
  check("aside: 靠右时仍在视口内", inView(p, pw, ph, vw, vh), JSON.stringify(p));
}

{
  // 极端：视口很小，四边都放不下 —— 也必须夹在视口内，不能跑出屏幕
  const cellR = rect(20, 20, 300, 300);
  const pw = 280, ph = 420, vw = 360, vh = 500;
  const p = placeAsidePop(pw, ph, cellR, vw, vh);
  check("aside: 放不下时也夹在视口内", inView(p, pw, ph, vw, vh), JSON.stringify(p));
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");

