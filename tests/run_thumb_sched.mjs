// 缩略图调度的跑测：滚动时不发、停下补发、**一格都不能漏**。
//
// 为什么单独跑：漏格不会报错，表现只是「有些图半天出不来」——
// 第一版维护 pending Map 就是这么栽的（清单和渲染池不同步）。
// 这里把 flushThumbs 从源码里原样抠出来跑（不照抄，照抄会漂移）。
//
// 跑法：node tests/run_thumb_sched.mjs web/mediabrowser.js

import fs from "fs";

const file = process.argv[2];
if (!file) { console.error("用法: node run_thumb_sched.mjs <mediabrowser.js>"); process.exit(2); }
const src = fs.readFileSync(file, "utf8");

const i = src.indexOf("const flushThumbs");
if (i < 0) throw new Error("源码里找不到 flushThumbs");
const body = src.slice(i, src.indexOf("const scheduleFlush", i));
if (!body.includes("for (const [i, el] of pool)")) throw new Error("flushThumbs 没有扫渲染池");

// 最小 DOM 替身：只实现 flushThumbs 用到的那几样
const mkImg = (url) => {
  const ds = url == null ? {} : { src: url };
  return { dataset: ds, src: null,
           get pending() { return "src" in this.dataset; } };
};
const mkCell = (img) => ({ querySelector: (sel) => (sel === 'img[data-src]' && img && img.pending) ? img : null });

const run = (cells, placed, scrollTop, clientHeight) => {
  const pool = new Map(cells.map((c, n) => [n, c.el]));
  const scroll = { scrollTop, clientHeight };
  const fn = new Function("pool", "placed", "scroll", body + "\nreturn flushThumbs;")(pool, placed, scroll);
  fn();
};

let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
};

// ① 停下之后，池子里每一张挂着 data-src 的都要被发出去 —— 一格不漏
{
  const imgs = Array.from({ length: 10 }, (_, n) => mkImg(`u${n}`));
  const cells = imgs.map((im) => ({ el: mkCell(im) }));
  const placed = imgs.map((_, n) => ({ y: n * 200, h: 200 }));
  run(cells, placed, 0, 800);
  const missed = imgs.filter((im) => im.src === null);
  check("一格不漏", missed.length === 0, `漏了 ${missed.length} 格`);
  check("发完清掉 data-src", imgs.every((im) => !("src" in im.dataset)));
}

// ② 已经发过的（没有 data-src）不重复发
{
  const done = mkImg(null); done.src = "已经有了";
  const todo = mkImg("u1");
  run([{ el: mkCell(done) }, { el: mkCell(todo) }], [{ y: 0, h: 200 }, { y: 200, h: 200 }], 0, 800);
  check("发过的不重发", done.src === "已经有了");
  check("没发的补上", todo.src === "u1");
}

// ③ 从视口中心往外发：停在中间时，中间那格必须排在边缘之前
{
  const order = [];
  const imgs = Array.from({ length: 9 }, (_, n) => {
    const im = mkImg(`u${n}`);
    Object.defineProperty(im, "src", { set(v) { order.push(v); }, get() { return null; }, configurable: true });
    return im;
  });
  const placed = imgs.map((_, n) => ({ y: n * 100, h: 100 }));
  run(imgs.map((im) => ({ el: mkCell(im) })), placed, 300, 300);   // 视口 [300,600)，中心 450
  // 离中心最近的是 y=400 那格（索引 4）
  check("先发视口中心那一格", order[0] === "u4", `实际先发 ${order[0]}`);
  const idx = order.map((u) => +u.slice(1));
  const dist = idx.map((n) => Math.abs(n * 100 + 50 - 450));
  check("整体按离中心由近及远", dist.every((d, k) => k === 0 || d >= dist[k - 1]), dist.join(","));
}

// ④ placed 里没有这一格时不许抛异常（滚动中重排会短暂对不上）
{
  const im = mkImg("u0");
  let threw = null;
  try { run([{ el: mkCell(im) }], [], 0, 800); } catch (e) { threw = e; }
  check("placed 缺项不抛异常", threw === null, String(threw));
  check("缺项也照样发出去", im.src === "u0");
}

// ⑤ 长滑动不能饿死：连续滚动期间也必须周期性发一批
//    这是第一版漏掉的维度 —— 当时只测「停下能不能发」，没测「一直不停会怎样」，
//    于是惯性滑动几秒钟一张不出，用户看到的是「扫图完全坏了」，而回归全绿。
{
  const sched = src.slice(src.indexOf("const scheduleFlush"),
                          src.indexOf("};", src.indexOf("const scheduleFlush")) + 2);
  check("憋够久就先发一批", /performance\.now\(\)\s*-\s*lastFlushAt\s*>=\s*THUMB_MAX_DEFER_MS/.test(sched),
        "scheduleFlush 里没有上限判断");
  const m = src.match(/const THUMB_MAX_DEFER_MS = (\d+)/);
  check("上限存在且不超过 500ms", !!m && +m[1] <= 500, m ? `${m[1]}ms` : "没定义");
  check("flushThumbs 会记录发出时刻",
        /lastFlushAt = performance\.now\(\)/.test(src.slice(src.indexOf("const flushThumbs"),
                                                            src.indexOf("const scheduleFlush"))),
        "不记录的话上限永远不触发");
}

console.log(bad ? `\n  ${bad} 项失败` : "\n  thumb sched: all passed");
process.exit(bad ? 1 : 0);
