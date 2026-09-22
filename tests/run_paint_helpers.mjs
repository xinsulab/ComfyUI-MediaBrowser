/**
 * 抽出 mediabrowser.js 里 PAINT_HELPERS 段：框选/涂抹坐标与笔迹抽样。
 * 跑法: node tests/run_paint_helpers.mjs web/mediabrowser.js
 */
import fs from "fs";
import vm from "vm";
import assert from "node:assert/strict";

const srcPath = process.argv[2];
if (!srcPath) {
  console.error("用法: node run_paint_helpers.mjs <mediabrowser.js>");
  process.exit(2);
}
const src = fs.readFileSync(srcPath, "utf8");
const m = src.match(/\/\* PAINT_HELPERS_BEGIN \*\/([\s\S]*?)\/\* PAINT_HELPERS_END \*\//);
if (!m) {
  console.error("mediabrowser.js 缺少 PAINT_HELPERS_BEGIN/END 段");
  process.exit(1);
}
const ctx = {};
vm.runInNewContext(m[1] + `
  this.paintClampBlock = paintClampBlock;
  this.paintClampBrush = paintClampBrush;
  this.paintNormFromClient = paintNormFromClient;
  this.paintNormRect = paintNormRect;
  this.paintRectTooSmall = paintRectTooSmall;
  this.paintAppendDot = paintAppendDot;
  this.paintStrokeOp = paintStrokeOp;
  this.paintCanSave = paintCanSave;
`, ctx);

assert.equal(ctx.paintClampBlock(3), 6);
assert.equal(ctx.paintClampBlock(99), 48);
assert.equal(ctx.paintClampBlock(16), 16);

assert.ok(ctx.paintClampBrush(0) >= 0.008);
assert.ok(ctx.paintClampBrush(1) <= 0.12);

const rect = { left: 100, top: 50, width: 200, height: 100 };
const hit = (cx, cy) => ctx.paintNormFromClient(cx, cy, rect);
assert.equal(hit(100, 50).x, 0);
assert.equal(hit(100, 50).y, 0);
assert.equal(hit(100, 50).outside, false);
assert.equal(hit(200, 100).x, 0.5);
assert.equal(hit(200, 100).y, 0.5);
assert.equal(hit(300, 150).x, 1);
assert.equal(hit(300, 150).y, 1);
assert.equal(hit(90, 50).outside, true);
assert.equal(ctx.paintNormFromClient(200, 100, null), null);

const box = ctx.paintNormRect({ x: 0.2, y: 0.8 }, { x: 0.6, y: 0.1 });
assert.equal(box.k, "r");
assert.equal(box.x, 0.2);
assert.equal(box.y, 0.1);
assert.ok(Math.abs(box.w - 0.4) < 1e-12);
assert.ok(Math.abs(box.h - 0.7) < 1e-12);
assert.equal(ctx.paintRectTooSmall({ w: 0.001, h: 0.5 }), true);
assert.equal(ctx.paintRectTooSmall(box), false);

const a = ctx.paintAppendDot([], { x: 0.1, y: 0.1 }, 0.01);
const b = ctx.paintAppendDot(a, { x: 0.101, y: 0.1 }, 0.01);
assert.equal(b.length, 1, "距离太近不应再记一个点");
const c = ctx.paintAppendDot(b, { x: 0.2, y: 0.1 }, 0.01);
assert.equal(c.length, 2);

const stroke = ctx.paintStrokeOp(c, 0.03);
assert.equal(stroke.k, "s");
assert.equal(stroke.r, 0.03);
assert.equal(JSON.stringify(stroke.pts), JSON.stringify([[0.1, 0.1], [0.2, 0.1]]));
assert.equal(ctx.paintCanSave([]), false);
assert.equal(ctx.paintCanSave([stroke]), true);

console.log("ok");

// 高强度模糊必须复制四边与四角，不能把透明边缘叠回原图。
{
  const begin=src.indexOf('const blurPatch =');
  const end=src.indexOf('\n};',begin)+3;
  const canvases=[];
  const document={createElement(){const draws=[];const context={drawImage:(...args)=>draws.push(args)};
    const canvas={width:0,height:0,draws,context,getContext:()=>context};canvases.push(canvas);return canvas;}};
  const blur=new Function('document',src.slice(begin,end)+';return blurPatch;')(document);
  const original={canvas:{width:200,height:200},drawImage(){}};
  blur(original,30,40,50,60,70);
  const [padded,result]=canvases;
  assert.equal(padded.draws.length,9,'填充中心、四边和四角');
  assert.ok(padded.width>=50+70*8,'高强度仍保留足够边缘缓冲');
  assert.equal(result.width,50);assert.equal(result.height,60);
  assert.equal(result.context.filter,'blur(70px)');
  assert.equal(result.draws[0][0],padded,'模糊完整填充画布后裁剪');
  assert.ok(result.draws[0][1]<0 && result.draws[0][2]<0);
}
