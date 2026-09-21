/**
 * MediaBrowser —— 给加载节点加宫格媒体浏览器。
 * 缩略图走 /mediabrowser/thumb（原生 preview 的 N 是质量不是尺寸）。
 * 虚拟滚动；列表自己递归。不要在 web/ 再加会被 Comfy 扫到的 .mjs 入口。
 */
import { app } from "../../scripts/app.js";

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
));

// 跟 Comfy 官方资源管理器同一套图标（UnoCSS / Iconify，页面里已经有这些 class）。
// 入口按钮 🔲 浏览是产品定的，不动；其余操作走这套线描。
const mbIco = (name, extra) =>
  `<i class="icon-[${name}] mb-ico${extra ? " " + extra : ""}" aria-hidden="true"></i>`;
// HTML 按钮默认 type=submit。点一下会提交祖先 form，Comfy 画布一脏就
// 弹出「要离开此网站吗？」。运行时建的钮必须走这里。
const mbElButton = (cls) => {
  const b = document.createElement("button");
  b.type = "button";
  if (cls) b.className = cls;
  return b;
};
const setIco = (el, name, extra) => { if (el) el.innerHTML = mbIco(name, extra); };
// 单张重检：自带 SVG，不走 lucide class。UnoCSS 只打进官方那套，新名字是空方块；
// 目录刷新继续用 refresh-cw，这两件事不能共用一个箭头。
const mbScanIco = () =>
  `<svg class="mb-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>` +
  `<path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>` +
  `<circle cx="12" cy="12" r="3"/></svg>`;
const fmtWhen = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
};
const fmtElapsed = (sec) => {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 600) {
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = Math.floor(n % 60);
    return h
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }
  return `${n.toFixed(2)}s`;
};
const fmtClip = (sec) => {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 60) return t("片{n}秒", { n: n % 1 ? n.toFixed(1) : Math.round(n) });
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return t("片{m}:{s}", { m, s: String(s).padStart(2, "0") });
};
// 出片命名常带 20260831_205206_…，比 mtime 更接近「生成时刻」（拷贝会改 mtime）。
const FN_TS = /^(\d{8})_(\d{6})/;
const fmtWhenFromName = (path) => {
  const m = (String(path).split("/").pop() || "").match(FN_TS);
  if (!m) return "";
  const y = +m[1].slice(0, 4), mo = +m[1].slice(4, 6), day = +m[1].slice(6, 8);
  const hh = +m[2].slice(0, 2), mm = +m[2].slice(2, 4), ss = +m[2].slice(4, 6);
  const d = new Date(y, mo - 1, day, hh, mm, ss);
  return Number.isNaN(d.getTime()) ? "" : fmtWhen(d.getTime() / 1000);
};
const cardMetaLine = (path, times, dims, extra) => {
  const bits = [];
  const run = extra?.elapsed?.[path];
  const ran = fmtElapsed(run);
  if (ran) bits.push(ran);
  const clip = fmtClip(extra?.duration?.[path]);
  if (clip) bits.push(clip);
  const when = fmtWhenFromName(path) || fmtWhen(times?.[path]);
  if (when) bits.push(when);
  const d = dims?.[path];
  if (d && d[0] >= 32 && d[1] >= 32) bits.push(`${d[0]}×${d[1]}`);
  return bits.join(" ");
};
const nmHtml = (name, path, times, dims, extra) => {
  const meta = cardMetaLine(path, times, dims, extra);
  return `<span class="nm"><span class="fn" title="${escHtml(name)}">${escHtml(name)}</span>` +
    (meta ? `<span class="meta" title="${escHtml(meta)}">${escHtml(meta)}</span>` : "") + `</span>`;
};

// 1px 透明 gif：拿来顶掉在飞的缩略图请求（换 src 才会真的取消）。
const BLANK_PX = "data:image/gif;base64,"
  + "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const GAP = 10;
const BUF = 2;

const css = `
.mb-mask{position:fixed;z-index:10000;background:transparent;display:block;
  pointer-events:none;}
.mb-box{pointer-events:auto;position:relative;width:min(1180px,92vw);height:min(820px,88vh);background:#1e1e1e;
  border:1px solid #444;border-radius:10px;display:flex;flex-direction:column;
  box-shadow:0 18px 50px rgba(0,0,0,.6);overflow:hidden;
  container:mb-picker / inline-size;
  min-width:min(var(--mb-min-w,460px),98vw);min-height:min(var(--mb-min-h,340px),96vh);
  max-width:98vw;max-height:96vh;}
.mb-fab{position:fixed;z-index:10028;width:48px;height:48px;padding:0;border:1px solid #c9a227;
  border-radius:14px;background:#161616;color:#e6c35c;font:700 15px/48px ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.04em;text-align:center;cursor:grab;box-shadow:0 8px 24px rgba(0,0,0,.45);
  user-select:none;touch-action:none;}
.mb-fab:active,.mb-fab.dragging{cursor:grabbing;}
.mb-fab:focus-visible{outline:2px solid #e6c35c;outline-offset:3px;}
:where(html:not(.mb-touch)) .mb-fab:hover{background:#1c1c1c;border-color:#e0c14a;color:#ffe08a;}
.mb-empty{padding:28px 18px;color:#bbb;font-size:13px;line-height:1.55;}
.mb-top{cursor:grab;}
.mb-top button,.mb-top input,.mb-top select,.mb-top label{cursor:pointer;}
/* 八向缩放。浮窗有 left/top，从西/北拉时要一起改位置。 */
.mb-rz{position:absolute;z-index:6;}
.mb-rz.n {top:-4px;left:10px;right:10px;height:8px;cursor:ns-resize;}
.mb-rz.s {bottom:-4px;left:10px;right:10px;height:8px;cursor:ns-resize;}
.mb-rz.w {left:-4px;top:10px;bottom:10px;width:8px;cursor:ew-resize;}
.mb-rz.e {right:-4px;top:10px;bottom:10px;width:8px;cursor:ew-resize;}
.mb-rz.nw{top:-4px;left:-4px;width:16px;height:16px;cursor:nwse-resize;}
.mb-rz.ne{top:-4px;right:-4px;width:16px;height:16px;cursor:nesw-resize;}
.mb-rz.sw{bottom:-4px;left:-4px;width:16px;height:16px;cursor:nesw-resize;}
.mb-rz.se{bottom:-4px;right:-4px;width:16px;height:16px;cursor:nwse-resize;}
/* 右下角画个小三角，告诉用户这儿能拉（其余七个把手靠鼠标形状提示就够） */
.mb-rz.se::after{content:"";position:absolute;right:3px;bottom:3px;
  width:0;height:0;border-left:7px solid transparent;border-bottom:7px solid #666;}
.mb-box.rzing{user-select:none;}
.mb-box.rzing *{pointer-events:none;}
.mb-box.rzing .mb-rz{pointer-events:auto;}
.mb-top{display:flex;flex-direction:column;align-items:stretch;gap:0;
  padding:8px 11px;border-bottom:1px solid #383838;background:#252525;flex:0 0 auto;
  position:relative;cursor:grab;}
.mb-top-head{display:flex;align-items:flex-start;gap:8px;}
.mb-top-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex:1;min-width:0;}
/* 收藏/最近是“当前真实目录的视图”，常驻在目录旁边才不会藏进下拉后失去入口。
   整组参与 flex 换行，小窗口只收文字，不靠绝对定位覆盖相邻控件。 */
.mb-scope-special{display:flex;flex:0 0 auto;border:1px solid #4a4a4a;
  border-radius:6px;overflow:hidden;}
.mb-scope-special button{display:inline-flex;align-items:center;justify-content:center;gap:5px;
  flex:0 0 auto;min-width:34px;min-height:34px;padding:6px 9px;border:0;border-radius:0;
  border-right:1px solid #4a4a4a;background:#2c2c2c;color:#aaa;white-space:nowrap;}
.mb-scope-special button:last-child{border-right:0;}
:where(html:not(.mb-touch)) .mb-scope-special button:hover{background:#3a3a3a;color:#ddd;}
.mb-scope-special button.on{background:#2e5aa0;color:#fff;}
.mb-scope-special .mb-ico{width:15px;height:15px;}
@container mb-picker (max-width:720px){
  .mb-scope-special .lab{display:none;}
  .mb-scope-special button{width:34px;padding-inline:6px;}
}
/* 全选 + 批量：钉在第二行左边，有选区才露出动作图标。 */
.mb-batch{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;min-width:164px;
  margin-right:auto;}
.mb-top .mb-selectall{width:22px;height:22px;min-width:22px;min-height:22px;padding:0;
  border-radius:5px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.92);
  color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(0,0,0,.25);}
:where(html:not(.mb-touch)) .mb-top .mb-selectall:hover{background:#fff;border-color:#8ab4f8;}
.mb-top .mb-selectall.on,.mb-top .mb-selectall.some{background:#3b82f6;border-color:#3b82f6;}
.mb-top .mb-selectall .mb-ico{width:12px;height:12px;font-size:12px;}
.mb-batch-acts{display:none;align-items:center;gap:2px;}
.mb-box.mb-selecting .mb-batch-acts{display:inline-flex;}
.mb-batch-n{font-size:12px;color:#aaa;white-space:nowrap;font-variant-numeric:tabular-nums;padding:0 4px;}
.mb-top .mb-batch-acts button{width:28px;height:28px;min-width:28px;min-height:28px;padding:0;
  background:transparent;border:none;color:#bbb;display:flex;align-items:center;justify-content:center;}
:where(html:not(.mb-touch)) .mb-top .mb-batch-acts button:hover{background:rgba(90,141,214,.16);color:#8ab4f8;}
:where(html:not(.mb-touch)) .mb-top .mb-batch-acts button.danger:hover{background:rgba(160,80,80,.2);color:#f0a0a0;}
/* 第二行：左边全选/批量，右边是「怎么看」（排版/档位/遮蔽/截图）。
   跟第一行「看什么」（搜索/范围/类型/排序）分开。批量用 margin-right:auto
   钉在左边，其余仍靠右，贴近右上角窗口控件。 */
.mb-top-ops{margin-top:8px;padding-top:8px;border-top:1px solid #333;
  justify-content:flex-end;flex:none;gap:12px;}
.mb-ops-g{display:flex;gap:6px;align-items:center;flex:0 0 auto;}
.mb-chrome{flex:0 0 auto;z-index:7;
  display:flex;gap:4px;align-items:center;flex-wrap:nowrap;}
.mb-chrome button{min-width:34px;min-height:32px;padding:6px 8px;}
.mb-chrome [data-act="close"]{background:#4a2a2a;}
:where(html:not(.mb-touch)) .mb-chrome [data-act="close"]:hover{background:#7a2e2e;border-color:#b05050;}
.mb-seg-label{color:#888;font-size:12px;margin-right:2px;user-select:none;}
.mb-seg{display:flex;border:1px solid #4a4a4a;border-radius:6px;overflow:hidden;flex:0 0 auto;}
.mb-seg button{border:none;border-radius:0;border-right:1px solid #4a4a4a;
  background:#333;color:#ddd;padding:7px 10px;cursor:pointer;font-size:12px;
  min-width:36px;min-height:34px;}
.mb-seg button:last-child{border-right:none;}
:where(html:not(.mb-touch)) .mb-seg button:hover{background:#3d3d3d;}
.mb-seg button.on{background:#2e5aa0;border-color:#5a8dd6;color:#fff;}
/* 检测入口钉在「局部」右侧：定宽图标，脸上不写字。
   切档、进度、取消都不能改它的宽高，否则顶栏一跳格子跟着抖。 */
.mb-local-hit{display:flex;}
.mb-local-hit.on .mb-detect{background:#2e5aa0;color:#fff;}
.mb-seg .mb-detect{position:relative;width:36px;min-width:36px;padding:7px 6px;
  background:#333;color:#ddd;cursor:pointer;}
:where(html:not(.mb-touch)) .mb-seg .mb-detect:hover:not(:disabled){background:#3d3d3d;}
:where(html:not(.mb-touch)) .mb-local-hit.on .mb-detect:hover:not(:disabled){background:#3a6cbd;}
.mb-seg .mb-detect:disabled{opacity:.45;cursor:default;}
.mb-seg .mb-detect .mb-ico{display:block;margin:0 auto;}
/* 跑起来只在角上漏一个点，不占布局 */
.mb-seg .mb-detect.busy::after{content:"";position:absolute;top:5px;right:4px;
  width:6px;height:6px;border-radius:50%;background:#ffcc33;
  box-shadow:0 0 0 0 rgba(255,204,51,.55);pointer-events:none;
  animation:mb-leak 1s ease-out infinite;}
@keyframes mb-leak{
  0%{transform:scale(.8);opacity:1;box-shadow:0 0 0 0 rgba(255,204,51,.5);}
  70%{transform:scale(1);opacity:.9;box-shadow:0 0 0 6px rgba(255,204,51,0);}
  100%{transform:scale(.8);opacity:1;box-shadow:0 0 0 0 rgba(255,204,51,0);}
}
/* 这一档在当前窗口宽度下算出来跟更小的档一样宽，点了看不出变化。
   标灰是为了先说明白，而不是让用户以为按钮坏了。仍可点：设置会存下来。 */
.mb-seg button.clamped{opacity:.42;}
.mb-shot{position:relative;font-size:16px;line-height:1;letter-spacing:0;}
.mb-shot.busy::after{content:"";position:absolute;top:5px;right:4px;
  width:6px;height:6px;border-radius:50%;background:#ffcc33;
  box-shadow:0 0 0 0 rgba(255,204,51,.55);pointer-events:none;
  animation:mb-leak 1s ease-out infinite;}
/* 每个格子档位单独配分辨率。一行一档，左边写清是哪一档，右边选值。 */
.mb-percell{margin-top:10px;border-top:1px solid #3a3a3a;padding-top:10px;}
.mb-percell-row{display:flex;align-items:center;justify-content:space-between;
  gap:12px;margin:6px 0;font-size:13px;color:#ccc;}
.mb-percell-row select{min-width:132px;}
.mb-percell-row span{display:flex;flex-direction:column;gap:2px;}
.mb-percell-row i{font-style:normal;font-size:11px;color:#888;}
/* 遮哪些部位：按「露出 / 隔着衣服 / 其它」分三组，勾选即时生效 */
.mb-labgrp{margin:8px 0;}
.mb-labgrp .lab{color:#888;font-size:12px;margin-bottom:4px;}
.mb-labchk{display:inline-flex;align-items:center;gap:5px;margin:3px 10px 3px 0;
  font-size:13px;color:#ddd;cursor:pointer;user-select:none;}
.mb-labchk input{margin:0;cursor:pointer;}
/* 右键某一张的遮蔽力度：三个横排大按钮，点完即走 */
/* 条目的右键菜单。通用容器：加新条目只要往 items 数组里塞一项。 */
/* 空白处可拖：给个 move 光标当提示；按钮那些保持默认光标，
   否则看着哪里都能拖、点哪里都可能拖走。 */
.mb-cellmenu{min-width:250px;cursor:move;}
.mb-cellmenu.dragging{opacity:.9;user-select:none;}
.mb-cellmenu button,.mb-cellmenu label,.mb-cellmenu summary,
.mb-cellmenu input{cursor:pointer;}
.mb-cellmenu .bd{display:flex;flex-direction:column;gap:1px;padding:5px;}
/* ── 宫格：一屏放得下，扩展也只是多一格 ──
   原来一条动作占满一行、下面还挂一句副文案，8 条就撑满一屏，小屏上要滚半天
   才够得到底下的「遮蔽」。现在 4 列，8 条压成两行；那句副文案进 tooltip，
   看久了自然记住图标 —— 但**字不能全去掉**：触屏没有悬停，只剩图标就只能猜。 */
.mb-cellmenu .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));
  gap:4px;padding:6px;}
.mb-cellmenu .tile{display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:5px;min-height:62px;padding:8px 3px;
  border-radius:7px;border:1px solid transparent;background:#2b2b2b;color:#ddd;
  font-size:11px;line-height:1.25;text-align:center;word-break:break-all;}
:where(html:not(.mb-touch)) .mb-cellmenu .tile:hover{background:#3a3a3a;border-color:#4a4a4a;}
.mb-cellmenu .tile .mb-ico{font-size:19px;color:#bbb;}
.mb-cellmenu .tile.on{background:#2c4d6e;border-color:#6fa8dc;color:#cfe4f7;}
.mb-cellmenu .tile.on .mb-ico{color:#cfe4f7;}
/* 「用这张」是唯一会关窗改值的，单独一个颜色 */
.mb-cellmenu .tile.pick .mb-ico{color:#7cd68a;}
.mb-cellmenu .tile.pick.bad .mb-ico{color:#777;}
:where(html:not(.mb-touch)) .mb-cellmenu .tile.trash:hover{background:#5a2626;border-color:#a05050;}
/* 二级入口：整行 + 右侧箭头，一眼能看出「点进去还有」 */
.mb-cellmenu .more{grid-column:1 / -1;flex-direction:row;justify-content:flex-start;
  gap:9px;min-height:0;padding:9px 10px;font-size:12px;}
.mb-cellmenu .more .arrow{margin-left:auto;color:#888;}
/* 二级面板里「这张的画法」两条滑块 */
.mb-cellmenu .tune{padding:2px 8px 6px;}
.mb-cellmenu .tune .grp{display:flex;align-items:center;gap:8px;padding:6px 0 2px;}
.mb-cellmenu .tune .reset,.mb-cellmenu .parts .preset{margin-left:auto;font-size:11px;
  color:#8ab4f8;background:none;border:none;padding:2px 4px;text-decoration:underline;}
.mb-cellmenu .parts summary{display:flex;align-items:center;gap:8px;}
.mb-cellmenu .tune .sub{font-size:11px;color:#7f7f7f;margin:8px 0 2px;}
.mb-cellmenu .tune .mb-set-field{margin:4px 0;}
.mb-cellmenu .tune .lab{display:flex;justify-content:space-between;align-items:baseline;
  font-size:12px;color:#ccc;gap:8px;}
.mb-cellmenu .tune .lab b{font-weight:400;color:#8ab4f8;font-size:11px;}
.mb-cellmenu .tune input[type=range]{width:100%;margin:3px 0 0;}
/* 二级面板的返回条 */
.mb-cellmenu .hd .back{width:22px;height:22px;flex:0 0 auto;margin-right:2px;
  border:1px solid #4a4a4a;border-radius:5px;background:#2f2f2f;color:#ccc;}
:where(html:not(.mb-touch)) .mb-cellmenu .hd .back:hover{background:#3d3d3d;color:#fff;}
.mb-cellmenu .grp{color:#888;font-size:11px;padding:4px 8px 2px;user-select:none;}
.mb-cellmenu .sep{height:1px;background:#3a3a3a;margin:4px 6px;}
/* 一行 = 图标 + 标题 + 「点了会怎样」。副文案不是装饰：这些动作里有会关窗、
   会改节点值、会把文件挪进回收站的，光看标题分不出轻重。 */
.mb-cellmenu .mi .mb-ico{flex:0 0 auto;width:1.2em;font-size:15px;color:#bbb;margin-top:1px;}
.mb-cellmenu .mi .tx{display:flex;flex-direction:column;gap:2px;min-width:0;}
.mb-cellmenu .mi .e{font-style:normal;font-size:11px;color:#8a8a8a;line-height:1.5;}
.mb-cellmenu .mi.on .e{color:#cfe0ff;}
/* 「用这张」是唯一会关窗改值的，跟别的分开 */
.mb-cellmenu .mi.pick .mb-ico{color:#7cd68a;}
.mb-cellmenu .mi.pick.bad .mb-ico{color:#888;}
.mb-cellmenu .mi{display:flex;align-items:flex-start;gap:9px;
  text-align:left;padding:7px 10px;font-size:13px;background:none;
  border:none;border-radius:4px;color:#ddd;cursor:pointer;}
:where(html:not(.mb-touch)) .mb-cellmenu .mi:hover{background:#3a3a3a;}
.mb-cellmenu .mi.on{background:#2e5aa0;color:#fff;}
.mb-cellmenu .parts summary{padding:7px 10px;font-size:13px;color:#ddd;
  cursor:pointer;border-radius:4px;list-style:none;}
.mb-cellmenu .parts summary::-webkit-details-marker{display:none;}
:where(html:not(.mb-touch)) .mb-cellmenu .parts summary:hover{background:#3a3a3a;}
.mb-cellmenu .pbox{padding:2px 10px 6px;max-height:250px;overflow:auto;}
.mb-cellmenu .pg{margin:4px 0;}
.mb-cellmenu .pg i{display:block;font-style:normal;color:#888;font-size:11px;margin-bottom:2px;}
.mb-cellmenu .pg label{display:inline-flex;align-items:center;gap:4px;
  margin:2px 8px 2px 0;font-size:12px;color:#ddd;cursor:pointer;}
.mb-cellmenu .pg input{margin:0;cursor:pointer;}
.mb-cellmenu .hint{margin:4px 0 0;font-size:11px;color:#888;}
.mb-censor-layer{position:absolute;inset:0;z-index:2;pointer-events:none;}
.mb-censor-box{position:absolute;border-radius:3px;
  backdrop-filter:blur(var(--mb-censor-blur,14px));
  -webkit-backdrop-filter:blur(var(--mb-censor-blur,14px));
  background:rgba(30,30,30,.28);}
.mb-cell.peek .mb-censor-layer,.mb-play .mb-stage.peeking .mb-censor-layer{display:none;}
.mb-play .mb-stage.peeking img{filter:none !important;}
.mb-cell.detecting::before{content:"";position:absolute;inset:0;z-index:2;
  background:rgba(0,0,0,.28);pointer-events:none;}
.mb-cell.detecting::after{content:"";position:absolute;top:50%;left:50%;z-index:3;
  width:16px;height:16px;margin:-8px;border:2px solid #888;border-top-color:#fff;
  border-radius:50%;animation:mb-spin .7s linear infinite;pointer-events:none;}
@keyframes mb-spin{to{transform:rotate(360deg);}}
.mb-settings{position:absolute;inset:0;z-index:20;background:#161616;
  display:flex;color:#ddd;font-size:13px;overflow:hidden;}
.mb-set-nav{flex:0 0 148px;padding:14px 10px;border-right:1px solid #333;
  display:flex;flex-direction:column;gap:4px;background:#1a1a1a;min-width:0;}
.mb-set-nav h3{margin:0 6px 10px;font-size:15px;font-weight:600;}
.mb-set-nav button{display:flex;align-items:center;gap:8px;width:100%;
  text-align:left;background:transparent;border:1px solid transparent;
  color:#ccc;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;}
:where(html:not(.mb-touch)) .mb-set-nav button:hover{background:#2a2a2a;}
.mb-set-nav button.on{background:#2a3f66;border-color:#3d5a8c;color:#fff;}
.mb-set-nav .mb-ico{width:1.05em;height:1.05em;}
.mb-set-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;}
.mb-set-hd{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;
  gap:12px;padding:12px 16px 10px;border-bottom:1px solid #2e2e2e;}
.mb-set-title{font-size:15px;font-weight:600;flex:1;min-width:0;}
.mb-set-hd .mb-lang{display:flex;align-items:center;gap:6px;color:#aaa;font-size:12px;white-space:nowrap;margin-left:auto;}
.mb-set-hd .mb-lang select{width:auto;min-width:138px;margin:0;}
.mb-set-card .mb-lang{display:flex;align-items:center;gap:8px;margin-top:4px;color:#bbb;}
.mb-set-card .mb-lang select{width:min(220px,100%);}
.mb-set-body{flex:1;overflow:auto;padding:14px 18px 22px;}
.mb-set-pane{display:none;}
.mb-set-pane.on{display:block;}
.mb-set-card{background:#1e1e1e;border:1px solid #333;border-radius:8px;
  padding:14px 16px;margin:0 0 12px;}
.mb-set-card h4{margin:0 0 8px;font-size:13px;font-weight:600;
  display:flex;align-items:center;gap:8px;}
.mb-set-card .hint,.mb-set-more .hint{margin:0 0 10px;color:#888;line-height:1.5;font-size:12px;}
.mb-set-card.danger{border-color:#5a3030;}
.mb-set-status{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0;}
.mb-set-status b{font-weight:600;}
.mb-set-status .ok{color:#8fd18f;}
.mb-set-status .bad{color:#e0a0a0;}
.mb-set-field{margin:12px 0 0;}
.mb-set-field .lab{display:flex;justify-content:space-between;gap:12px;
  margin-bottom:6px;color:#bbb;}
.mb-set-field .lab b{color:#eee;font-variant-numeric:tabular-nums;}
.mb-set-field input[type=range]{width:100%;}
.mb-set-more{margin:0 0 12px;border:1px solid #333;border-radius:8px;
  padding:8px 12px 12px;background:#1e1e1e;}
.mb-set-more summary{cursor:pointer;color:#bbb;padding:4px 0;}
.mb-set-more .row{margin:10px 0 0;line-height:1.5;}
.mb-settings input[type=text],.mb-settings select{width:min(420px,100%);background:#141414;
  border:1px solid #4a4a4a;color:#ddd;padding:6px 8px;border-radius:6px;}
.mb-settings select{width:min(280px,100%);}
.mb-settings a{color:#7fb3f0;}
.mb-settings .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
.mb-settings button{background:#333;border:1px solid #4a4a4a;color:#ddd;
  padding:7px 12px;border-radius:6px;cursor:pointer;font-size:13px;}
:where(html:not(.mb-touch)) .mb-settings button:hover{background:#3d3d3d;}
.mb-settings button.on{background:#2e5aa0;border-color:#5a8dd6;}
.mb-settings .dlst{margin:0 0 4px;color:#bbb;line-height:1.55;}
.mb-settings .dlst.bad{color:#e0a0a0;}
/* 缓存用量：清之前先让人看见现在多大、离自动淘汰上限多远，
   清完这里的数字当场变 —— 那是唯一能验证「真清掉了」的地方。 */
.mb-settings .mb-usage{margin:6px 0 10px;padding:8px 10px;border-radius:6px;
  background:#242424;border:1px solid #383838;}
.mb-settings .mb-usage .line{display:flex;justify-content:space-between;gap:12px;
  align-items:baseline;margin:3px 0;color:#aaa;font-size:12px;}
.mb-settings .mb-usage b{color:#ddd;font-weight:500;}
.mb-settings .mb-usage .hint{margin:6px 0 0;}
.mb-settings .purge .line{display:flex;gap:10px;align-items:flex-start;margin:8px 0;}
.mb-settings .purge button{flex:0 0 auto;min-width:132px;}
.mb-settings .purge i{font-style:normal;color:#999;line-height:1.5;}
.mb-settings .purge .go{background:#6a2a2a;border-color:#a05050;color:#fff;}
:where(html:not(.mb-touch)) .mb-settings .purge .go:hover{background:#8a3030;}
.mb-bot .mb-act{color:#7fb3f0;cursor:pointer;text-decoration:underline;margin-left:8px;}
:where(html:not(.mb-touch)) .mb-bot .mb-act:hover{color:#fff;}
.mb-toast{position:fixed;top:16%;left:50%;transform:translateX(-50%);z-index:10055;
  background:#222;border:1px solid #5a8dd6;color:#eee;padding:10px 18px;
  border-radius:8px;font-size:13px;box-shadow:0 10px 32px rgba(0,0,0,.55);
  pointer-events:none;max-width:min(520px,86vw);}
.mb-confirm{position:fixed;inset:0;z-index:10060;background:rgba(0,0,0,.55);
  display:flex;align-items:center;justify-content:center;}
.mb-confirm .card{width:min(420px,88vw);background:#1e1e1e;border:1px solid #5a4a2a;
  border-radius:10px;padding:16px 18px;color:#ddd;box-shadow:0 16px 40px rgba(0,0,0,.6);}
.mb-confirm h4{margin:0 0 8px;font-size:15px;color:#f0d78c;}
.mb-confirm p{margin:0 0 14px;font-size:13px;line-height:1.6;color:#bbb;}
.mb-confirm .fn{color:#eee;word-break:break-all;}
.mb-confirm .acts{display:flex;gap:8px;justify-content:flex-end;}
.mb-confirm button{background:#333;border:1px solid #4a4a4a;color:#ddd;
  padding:8px 14px;border-radius:6px;cursor:pointer;min-height:36px;}
:where(html:not(.mb-touch)) .mb-confirm button:hover{background:#3d3d3d;}
.mb-confirm .go{background:#6a2a2a;border-color:#a05050;color:#fff;}
:where(html:not(.mb-touch)) .mb-confirm .go:hover{background:#8a3030;}
.mb-confirm .card.wide{width:min(540px,92vw);}
.mb-confirm .acts{flex-wrap:wrap;}
.mb-confirm .do{background:#2e5aa0;border-color:#5a8dd6;color:#fff;}
:where(html:not(.mb-touch)) .mb-confirm .do:hover{background:#3a6bb8;}
.mb-confirm ol{margin:0 0 12px;padding-left:1.3em;font-size:13px;line-height:1.65;color:#bbb;}
.mb-confirm ol li{margin:6px 0;}
.mb-confirm .note{margin:0 0 12px;font-size:12px;line-height:1.6;color:#888;}
.mb-confirm .note code{color:#cfe4f7;}
.mb-confirm .prompt{display:none;width:100%;min-height:96px;margin:0 0 12px;box-sizing:border-box;
  background:#141414;border:1px solid #4a4a4a;color:#ccc;border-radius:6px;padding:8px;
  font-size:11px;line-height:1.45;font-family:ui-monospace,Consolas,monospace;}
.mb-confirm .prompt.on{display:block;}
.mb-top input[type=text]{box-sizing:border-box;flex:1 1 260px;min-width:min(220px,100%);background:#141414;border:1px solid #4a4a4a;
  color:#ddd;padding:7px 10px;border-radius:6px;font-size:13px;outline:none;}
.mb-top input[type=text]:focus{border-color:#5a8dd6;}
.mb-top select,.mb-top button{background:#333;border:1px solid #4a4a4a;color:#ddd;
  padding:7px 10px;border-radius:6px;cursor:pointer;font-size:13px;
  min-width:36px;min-height:34px;}
/* 原生箭头画在右侧 padding 里。10px 时「时间 ↓ 新→旧」这种长文案会把
   箭头挤到描边边上。自己画箭头，右边固定留 9px。 */
.mb-top select{
  appearance:none;-webkit-appearance:none;
  padding-right:28px;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path fill='%23bbb' d='M2.4 4.2h7.2L6 8.3z'/></svg>");
  background-repeat:no-repeat;
  background-position:right 9px center;
  background-size:10px 10px;
}
:where(html:not(.mb-touch)) .mb-top button:hover,:where(html:not(.mb-touch)) .mb-top select:hover{background-color:#3d3d3d;}
.mb-top button.on{background:#2e5aa0;border-color:#5a8dd6;color:#fff;}
/* 类型多选：图片+视频是最常用的组合，做成单选的话每次都要来回切 */
.mb-kinds{display:flex;gap:3px;flex:0 0 auto;flex-wrap:nowrap;}
.mb-kinds button{display:inline-flex;align-items:center;justify-content:center;gap:5px;
  background:#2c2c2c;border:1px solid #4a4a4a;color:#999;
  padding:7px 9px;border-radius:6px;cursor:pointer;font-size:12px;
  min-height:34px;white-space:nowrap;}
.mb-kinds button .mb-ico{width:15px;height:15px;}
.mb-kinds .count{min-width:4ch;text-align:right;font-variant-numeric:tabular-nums;color:#bbb;}
:where(html:not(.mb-touch)) .mb-kinds button:hover:not(:disabled){background:#3a3a3a;color:#ccc;}
.mb-kinds button.on{background:#2e5aa0;border-color:#5a8dd6;color:#fff;}
.mb-kinds button.on.alien{background:#6a4a1a;border-color:#c9a227;color:#ffe9a3;}
.mb-kinds button:disabled{opacity:.4;cursor:default;}
/* 宽度变化只改变信息密度，不增删按钮；每个按钮整块换行，避免内容刷新时跳位。 */
@container mb-picker (max-width:900px){
  .mb-kinds .count{display:none;}
}
@container mb-picker (max-width:720px){
  .mb-kinds .lab,.mb-kinds .count{display:none;}
  .mb-kinds button{width:34px;min-width:34px;padding-inline:6px;}
  /* 小窗口优先让现有 flex 规则自然换行，不为批量动作长期占一段空位。 */
  .mb-batch{min-width:0;}
}
@container mb-picker (max-width:620px){
  /* 搜索是唯一需要连续输入的控件，空间不足时独占一行，不能被压成窄条。 */
  .mb-top-row>input[type=text]{flex-basis:100%;}
}
@container mb-picker (max-width:460px){
  /* 超窄窗口把窗口按钮放到独立行右侧，主工具栏才能拿回完整宽度继续整组换行。 */
  .mb-top-head{flex-wrap:wrap;}
  .mb-chrome{order:-1;margin-left:auto;}
  .mb-top-head>.mb-top-row{flex-basis:100%;}
}
.mb-top label{display:flex;align-items:center;gap:5px;color:#bbb;font-size:12px;
  cursor:pointer;white-space:nowrap;user-select:none;}
.mb-crumbrow{display:flex;align-items:center;gap:6px;flex:0 0 auto;
  background:#1c1c1c;border-bottom:1px solid #333;padding-right:10px;}
.mb-crumb{display:flex;gap:4px;align-items:center;padding:7px 12px;
  font-size:12px;overflow-x:auto;white-space:nowrap;flex:1;}
.mb-pin{flex:0 0 auto;background:#2c2c2c;border:1px solid #4a4a4a;color:#888;
  padding:4px 9px;border-radius:6px;cursor:pointer;font-size:12px;min-height:28px;}
:where(html:not(.mb-touch)) .mb-pin:hover:not(:disabled){background:#3a3a3a;color:#ccc;}
.mb-pin.on{background:#6a5410;border-color:#ffcc33;color:#ffe9a3;}
.mb-pin:disabled{opacity:.35;cursor:default;}
.mb-crumb a{color:#7fb3f0;cursor:pointer;text-decoration:none;padding:2px 5px;border-radius:4px;}
:where(html:not(.mb-touch)) .mb-crumb a:hover{background:#2e3d4f;}
.mb-crumb span.sep{color:#555;}
.mb-crumb span.cur{color:#ddd;padding:2px 5px;}
.mb-scroll{flex:1;overflow-y:auto;overflow-x:hidden;position:relative;padding:12px;}
/* 回顶部：窗口会记住上次滚到哪，逛到几千格深处的人得有条路回去，
   不然只能一路往回滚。没滚下去时不出现 —— 那时它没有用处，只会挡图。
   position:sticky 跟着滚动容器走，不用监听 scroll 去改 top。 */
.mb-totop{position:sticky;float:right;right:0;bottom:16px;z-index:6;
  width:38px;height:38px;padding:0;border-radius:50%;
  background:rgba(30,30,30,.82);border:1px solid #4a4a4a;color:#ddd;
  cursor:pointer;display:none;place-items:center;backdrop-filter:blur(6px);}
.mb-scroll.scrolled .mb-totop{display:grid;}
:where(html:not(.mb-touch)) .mb-totop:hover{background:#2e5aa0;border-color:#5a8dd6;color:#fff;}
.mb-canvas{position:relative;width:100%;}
/* 格子尺寸/位置全由 JS 算（宫格和瀑布流两套排版共用同一套绝对定位） */
.mb-cell{position:absolute;background:#2a2a2a;border:2px solid transparent;
  border-radius:7px;overflow:hidden;cursor:pointer;box-sizing:border-box;}
/* 鼠标样式就是「点下去会发生什么」的预告，所以它必须跟着设置走：
   点一下＝看大图 → 放大镜(+)；点一下＝直接选中 → 普通手型。
   进了大图之后图片上是放大镜(−)：再点一下就缩回去，跟进来的动作对称。
   文件夹永远是手型 —— 它是「进去」，跟放大没关系。 */
.mb-box.click-view .mb-cell:not(.dir){cursor:zoom-in;}
.mb-box.click-pick .mb-cell:not(.dir){cursor:pointer;}
.mb-box.mb-selecting .mb-cell:not(.dir){cursor:pointer;}
.mb-play .mb-stage img{cursor:zoom-out;}
/* 悬停 = 蓝（鼠标在这）；已选 = 绿（节点里现在装的就是它）。
   两者权重相同、.sel 写在后面会赢 —— 结果是悬停到已选那格毫无反应，
   看起来像「跟随鼠标坏了」。所以给已选态单独写一条悬停规则。 */
:where(html:not(.mb-touch)) .mb-cell:hover{border-color:#5a8dd6;}
.mb-cell.sel{border-color:#4caf50;}
:where(html:not(.mb-touch)) .mb-cell.sel:hover{border-color:#8ce99a;}
/* 边框之外再给一个记号：格子被悬停/糊住/挤在角落时，光靠边框颜色不一定认得出 */
.mb-cell.sel:not(.detecting)::after{content:var(--mb-sel-tag,"当前");position:absolute;
  top:auto;left:3px;right:auto;bottom:calc(var(--mb-nm-fs,9px) * 3.4 + 8px);z-index:3;
  padding:1px 5px;border-radius:4px;font-size:10px;line-height:1.5;
  background:rgba(76,175,80,.9);color:#06210a;pointer-events:none;}
.mb-cell.dir{background:#2f2a20;border-color:#5a4a2a;}
:where(html:not(.mb-touch)) .mb-cell.dir:hover{border-color:#c9a227;}
.mb-cell.dir .ico{position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:4px;color:#d8b455;}
.mb-cell.dir .ico b{font-size:30px;line-height:1;font-weight:400;}
.mb-cell.dir .ico .mb-ico{color:#d8b455;}
.mb-cell.dir .ico i{font-style:normal;font-size:10px;color:#9a8548;}
.mb-cell img{width:100%;height:100%;object-fit:cover;display:block;}
/* 类型对不上的：正常显示，不做灰调/压暗。
   浏览优先，选不了的在点下去时用底栏提示说清楚，不把画面弄丑。 */
:where(html:not(.mb-touch)) .mb-cell.unusable:hover{border-color:#8a5a2a;}
.mb-cell.fit img{object-fit:contain;background:#181818;}
/* 打码：顶栏三态（原图/全幅/局部）+ 单张锁 + 临时揭开。点图片永远是选中。 */
.mb-cell.blurred img{filter:blur(15px);transform:scale(1.08);}
.mb-cell.blurred.peek img{filter:none;transform:none;}
/* 局部模式下、检测框还没回来的那一张：先按全幅糊着。
   这是**安全侧**的默认。反过来（先亮原图、检测完再打码）看着更快，但
   一屏 24 张检测要十几秒 —— 那十几秒等于遮蔽根本没开，而遮蔽存在的理由
   正是「别把原图亮出来」。先糊后精确，才是这个功能应有的顺序。
   代价接近零：糊是纯 CSS，瞬时；框到了就摘掉这个类，换成精确的局部遮蔽。
   「跳过河蟹」标过的不在此列 —— 你已经说过那张不用管了。 */
.mb-cell.censor-wait img{filter:blur(15px);transform:scale(1.08);}
.mb-cell.censor-wait.peek img{filter:none;transform:none;}
/* 左上角第一格给多选勾：闲置藏，悬停 / 已选 / 有选区才露出。
   角落四个控件共用同一份点击区：--mb-peek 跟实际格子宽度响应式变化。
   复选框真正可见的芯片在点击区内部单独收小，见下方 ::before。 */
.mb-cell .mb-check,.mb-cell .mb-peek,
.mb-cell .mb-redo,.mb-cell .mb-skip{box-sizing:border-box;
  width:var(--mb-peek,26px);height:var(--mb-peek,26px);padding:0;border-radius:6px;}
.mb-cell .mb-check{position:absolute;top:3px;left:3px;z-index:6;
  border:0;background:transparent;color:#fff;box-shadow:none;
  display:flex;align-items:center;justify-content:center;cursor:pointer;line-height:1;
  opacity:0;pointer-events:none;}
/* 参考 kb-studio 的封面对比芯片，只借它的跨图片对比方案；尺寸仍跟本项目的
   --mb-peek 走。70% 与跳过图标的实际可见占比（约 69.6%）基本一致，避免
   把整块白色点击区误看成一个巨大的图标。 */
.mb-cell .mb-check::before{content:"";position:absolute;left:50%;top:50%;z-index:0;
  width:70%;height:70%;box-sizing:border-box;transform:translate(-50%,-50%);
  border-radius:clamp(4px,calc(var(--mb-peek,26px) * .125),5px);
  border:1px solid rgba(255,255,255,.96);background:rgba(255,255,255,.92);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.8),
    0 0 0 1px rgba(15,23,42,.2),0 1px 3px rgba(2,6,23,.38);
  transition:border-color .15s ease,background .15s ease,box-shadow .15s ease;}
.mb-cell .mb-check .mb-ico{position:relative;z-index:1;width:46%;height:46%;}
:where(html:not(.mb-touch)) .mb-cell .mb-check:hover::before{border-color:#8ab4f8;}
:where(html:not(.mb-touch)) .mb-cell:hover .mb-check,
.mb-cell.touched .mb-check,
.mb-cell.checked .mb-check,
.mb-box.mb-selecting .mb-cell:not(.dir) .mb-check{opacity:1;pointer-events:auto;}
.mb-cell .mb-check.on::before{background:#3b82f6;border-color:#3b82f6;
  box-shadow:0 0 0 1.5px rgba(255,255,255,.96),
    0 0 0 2.5px rgba(15,23,42,.2),0 1px 4px rgba(59,130,246,.4);}
.mb-cell.checked{box-shadow:inset 0 0 0 2px #5a8dd6;}
/* 勾出来时眼睛让到它右边；闲置仍是 left:3px，见下面 .mb-peek 默认规则。 */
:where(html:not(.mb-touch)) .mb-cell:hover .mb-peek,
.mb-cell.touched .mb-peek,
.mb-cell.checked .mb-peek,
.mb-box.mb-selecting .mb-cell .mb-peek{left:calc(3px + var(--mb-peek,26px) + 3px);}
.mb-cell .mb-peek{position:absolute;top:3px;left:3px;z-index:5;
  display:flex;align-items:center;justify-content:center;line-height:1;
  font-size:calc(var(--mb-peek,26px) * 0.62);
  background:rgba(0,0,0,.7);border:1px solid #666;color:#ddd;cursor:pointer;
  opacity:0;pointer-events:none;transition:opacity .13s ease;}
:where(html:not(.mb-touch)) .mb-cell .mb-peek:hover{background:#2e5aa0;border-color:#5a8dd6;}
.mb-cell.peek .mb-peek{background:#2c4d6e;border-color:#6fa8dc;color:#cfe4f7;}
/* 显隐跟跳过同一套：闲置藏，hover / 触屏出；正在揭开（.peek）当「开着」常显。 */
:where(html:not(.mb-touch)) .mb-cell:hover .mb-peek,.mb-cell.touched .mb-peek,.mb-cell.peek .mb-peek{opacity:1;pointer-events:auto;}
/* 右上角默认只剩跳过 —— 重检只在上次失败时才挂（见 attachRedoBtn）。
   所以跳过坐第一格 right:3px，不要给重检常留位子。 */
.mb-cell .mb-redo,.mb-cell .mb-skip{position:absolute;top:3px;z-index:5;
  display:flex;align-items:center;justify-content:center;line-height:1;
  background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18);
  color:#c8c8c8;cursor:pointer;
  opacity:0;pointer-events:none;transition:opacity .13s ease;}
.mb-cell .mb-redo{right:3px;font-size:calc(var(--mb-peek,26px) * 0.62);}
.mb-cell .mb-skip{right:3px;
  font-size:calc(var(--mb-peek,26px) * 0.58);color:#a8a8a8;}
.mb-cell:has(.mb-redo) .mb-skip{right:calc(3px + var(--mb-peek,26px) + 3px);}
.mb-cell:hover .mb-redo,.mb-cell:hover .mb-skip,
.mb-cell.touched .mb-redo,.mb-cell.touched .mb-skip{opacity:1;pointer-events:auto;}
:where(html:not(.mb-touch)) .mb-cell .mb-redo:hover,:where(html:not(.mb-touch)) .mb-cell .mb-skip:hover{background:#2e5aa0;border-color:#5a8dd6;color:#fff;}
.mb-cell.detecting .mb-redo{opacity:.4;pointer-events:none;}
.mb-cell .mb-skip.on{opacity:1;pointer-events:auto;
  background:rgba(44,77,110,.85);border-color:#5a7a9a;color:#c5d4e4;}
/* ── 状态角标：常驻可见（收藏/视频/已打码是「信息」，得一眼扫到） ── */
.mb-cell .mb-badge{position:absolute;top:3px;left:3px;z-index:5;display:flex;gap:3px;
  pointer-events:none;
  max-width:calc(100% - (var(--mb-peek,26px) + 3px) * 2 - 8px);overflow:hidden;}
/* 没勾、只有眼睛：角标让开眼睛。勾出现时下面两条再往右推（必须写在后面才能盖过）。 */
.mb-cell.peek .mb-badge,
.mb-box.touching .mb-cell:has(.mb-peek) .mb-badge{left:calc(3px + var(--mb-peek,26px) + 3px);}
:where(html:not(.mb-touch)) .mb-cell:hover .mb-badge,
.mb-cell.touched .mb-badge,
.mb-cell.checked .mb-badge,
.mb-box.mb-selecting .mb-cell .mb-badge{left:calc(3px + var(--mb-peek,26px) + 3px);}
:where(html:not(.mb-touch)) .mb-cell:hover:has(.mb-peek) .mb-badge,
.mb-cell.touched:has(.mb-peek) .mb-badge,
.mb-cell.checked:has(.mb-peek) .mb-badge,
.mb-box.mb-selecting .mb-cell.peek .mb-badge,
.mb-box.mb-selecting.touching .mb-cell:has(.mb-peek) .mb-badge{
  left:calc(3px + var(--mb-peek,26px) + 3px + var(--mb-peek,26px) + 3px);}
.mb-cell .mb-badge span{padding:1px 5px;border-radius:4px;font-size:10px;line-height:1.5;
  background:rgba(0,0,0,.72);}
.mb-cell .mb-badge .fav{color:#ffcc33;}
.mb-cell .mb-badge .skip{color:#9ad;}
.mb-cell .mb-badge .vid{color:#ffd479;}
/* ── 操作条：hover 滑出。flex-wrap + min-width 42px：格子窄了自动折成两行，
      保证每个按钮都够手指点（触屏 ~44px 是可用下限），不会挤成一条线 ── */
/* 换行（wrap）。换行本身没错，错在按钮尺寸不跟着格子走 ——
   曾经按钮固定 42px 宽、28px 高，110px 的格子里就排成 3 行占掉 98%。
   现在按钮宽高都由 --mb-btn-w/h 按格子尺寸算（见 syncSize），
   小格子上按钮也跟着小，一两行就装完，条高自然压得住。 */
/* justify-content:center —— 按钮个数除不尽一行时，余下的那几个居中，
   剩余空间变成两侧留白。不居中的话它们会靠左，右边空一大块，像少了个按钮。 */
.mb-cell .mb-bar{position:absolute;left:0;right:0;bottom:0;z-index:4;
  display:flex;flex-wrap:wrap;gap:3px;justify-content:center;
  background:linear-gradient(transparent,rgba(0,0,0,.92) 26%);
  padding:var(--mb-bar-pad,14px) 3px 4px;transform:translateY(105%);transition:transform .13s ease;}
:where(html:not(.mb-touch)) .mb-cell:hover .mb-bar,.mb-cell.touched .mb-bar{transform:translateY(0);}
/* 宽度也跟着格子走：小格子小按钮，一行能多塞几个，就不会堆成三行。
   ⚠️ max-width 必须有：只写 flex:1 1 的话，末行只剩两个按钮时它们会各自
   撑到半个格子宽 —— 跟上一行的按钮完全不是一个尺寸，看着像坏了。
   1.6 倍是留一点自适应余地，又不至于变形。 */
/* 「用这张」是这一条里唯一会**关掉窗口并改掉节点**的动作，给它自己的颜色，
   跟旁边一排中性的操作分开 —— 不然七个一样的灰钮，点哪个都像在浏览。 */
.mb-cell .mb-bar button.pick{background:rgba(46,106,58,.85);border-color:#4caf50;color:#fff;}
:where(html:not(.mb-touch)) .mb-cell .mb-bar button.pick:hover{background:#37804a;}
/* 用不了的动作**不抽掉、只禁用**：位置固定，肌肉记忆才有意义；
   而且鼠标停上去会告诉你为什么用不了（jpg 存不下提示词之类）。 */
.mb-cell .mb-bar button.off,
.mb-cell .mb-bar button.pick.off{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.10);
  color:#666;cursor:not-allowed;}
.mb-pop .mi.off{opacity:.45;cursor:not-allowed;}
:where(html:not(.mb-touch)) .mb-pop .mi.off:hover{background:none;}
.mb-cell .mb-bar button{flex:1 1 var(--mb-btn-w,42px);min-width:var(--mb-btn-w,42px);
  max-width:calc(var(--mb-btn-w,42px) * 1.6);padding:0;
  min-height:var(--mb-btn-h,32px);font-size:var(--mb-btn-fs,14px);line-height:1;border-radius:5px;
  background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.24);
  color:#eee;cursor:pointer;}
:where(html:not(.mb-touch)) .mb-cell .mb-bar button:hover{background:#2e5aa0;border-color:#5a8dd6;}
.mb-cell .mb-bar button.on{background:#8a6d1a;border-color:#ffcc33;color:#ffe9a3;}
.mb-cell .mb-bar button.mask.on{background:#2c4d6e;border-color:#6fa8dc;color:#cfe4f7;}
/* ── 骨架屏：列表回来了但缩略图还在生成时，让「正在长出来」可见 ── */
.mb-cell .ph{position:absolute;inset:0;display:flex;align-items:center;
  justify-content:center;color:#666;font-size:11px;
  background:linear-gradient(100deg,#2a2a2a 30%,#343434 50%,#2a2a2a 70%);
  background-size:220% 100%;animation:mb-sk 1.1s linear infinite;}
@keyframes mb-sk{from{background-position:180% 0;}to{background-position:-40% 0;}}
@media (prefers-reduced-motion: reduce){
  .mb-cell .ph{animation:none;}
  .mb-cell .mb-bar{transition:none;}
}
.mb-cell .ph.err{animation:none;background:#2a2a2a;color:#a55;}
/* 骨架格：数据没到之前占位。不响应鼠标，免得点到一个还不存在的东西 */
.mb-cell.skel{cursor:default;pointer-events:none;border-color:transparent;}
:where(html:not(.mb-touch)) .mb-cell.skel:hover{border-color:transparent;}
/* 非媒体文件：不去要缩略图，直接标出扩展名 */
.mb-cell .mb-doc{position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:5px;background:#26262b;color:#8b93a5;}
.mb-cell .mb-doc b{font-size:26px;line-height:1;font-weight:400;}
.mb-cell .mb-doc i{font-style:normal;font-size:10px;letter-spacing:.5px;}
/* ⚠️ 这里**不要**给 .nm 设 max-height。
   高度已经被里面两个元素封住了：.fn 有 line-clamp:2、.meta 是 nowrap 单行，
   容器长不疯。而多一道 max-height 反而会裁掉内容 ——
   3.9em 减去 9px padding 只剩 28.8px，而「2 行名字(24.3) + gap + meta(11.3)」
   要 36.5px，于是第二行名字被拦腰切掉（实测 9.7px 字号下差 7.7px）。
   让它按内容自然高：名字一行时也不会白占地方。 */
.mb-cell .nm{position:absolute;left:0;right:0;bottom:0;z-index:4;padding:4px 6px 5px;
  background:linear-gradient(transparent,rgba(0,0,0,.9));color:#eee;
  line-height:1.25;
  font-size:var(--mb-nm-fs,9px);display:flex;flex-direction:column;justify-content:flex-end;gap:1px;}
/* 文件名最多两行，超出省略。不按字硬拆：短名一行放下，长名第二行末尾出 … */
.mb-cell .nm .fn{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;
  overflow:hidden;overflow-wrap:anywhere;word-break:normal;max-height:2.6em;}
.mb-cell .nm .meta{color:#8b93a5;font-size:max(9px,calc(var(--mb-nm-fs,9px)*0.92));
  line-height:1.25;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* ── 视频播放浮层 ──
   ⚠️ z-index 必须高于所有浏览窗和浮钮。少了这一行，
   播放器会被宫格盖住：视频照常加载、有声音，就是看不见 —— 症状不像样式问题，很难查。 */
.mb-play{position:fixed;inset:0;z-index:10040;background:rgba(0,0,0,.9);
  display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:0;}
.mb-play .mb-stage{position:relative;flex:1 1 auto;min-height:0;width:100%;
  display:flex;align-items:center;justify-content:center;
  padding:48px 72px 8px;box-sizing:border-box;overflow:hidden;}
.mb-play video,.mb-play img{max-width:100%;max-height:100%;border-radius:8px;background:#000;
  box-shadow:0 20px 60px rgba(0,0,0,.7);object-fit:contain;
  transform-origin:center center;}
.mb-play .mb-stage.zoomed img{cursor:grab;}
.mb-play .mb-stage.zoomed.panning img{cursor:grabbing;}
.mb-play .mb-censor-layer{transform-origin:center center;}
/* 左右翻页：贴在两侧边缘，不压住画面中间 */
.mb-play .mb-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:1;
  width:52px;height:88px;padding:0;font-size:28px;line-height:1;
  display:flex;align-items:center;justify-content:center;
  border-radius:10px;background:rgba(0,0,0,.5);border:1px solid #555;color:#ddd;cursor:pointer;}
:where(html:not(.mb-touch)) .mb-play .mb-nav:hover{background:rgba(46,90,160,.8);border-color:#5a8dd6;color:#fff;}
.mb-play .mb-nav:disabled{opacity:.22;cursor:default;background:rgba(0,0,0,.4);}
.mb-play .mb-nav.prev{left:12px;}
.mb-play .mb-nav.next{right:12px;}
.mb-play .idx{color:#888;font-variant-numeric:tabular-nums;}
/* 底栏的动作按钮：小格子上放不下的那几个，在这儿有的是地方 */
.mb-play .bar .act{min-width:44px;padding:8px 12px;font-size:15px;}
.mb-play .bar .act.on{background:#8a6d1a;border-color:#ffcc33;color:#ffe9a3;}
/* ✕ 钉右上角：画幅撑满时底部那排按钮可能被挤出视野，只留一个出口太险 */
.mb-play .mb-x{position:absolute;top:14px;right:16px;z-index:1;
  width:40px;height:40px;padding:0;line-height:38px;font-size:16px;
  border-radius:8px;background:rgba(0,0,0,.72);border:1px solid #666;color:#ddd;cursor:pointer;}
:where(html:not(.mb-touch)) .mb-play .mb-x:hover{background:#7a2e2e;border-color:#b05050;color:#fff;}
.mb-play .fn{max-width:46vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 音频没有画面：给个图标 + 播放条，别是一张裂图 */
.mb-play .mb-vaud{display:flex;flex-direction:column;align-items:center;gap:16px;padding:34px;
  color:#bbb;font-size:52px;}
.mb-play .mb-vaud audio{width:min(520px,72vw);font-size:14px;}
/* 「这个类型没有预览」不是报错，别用报错的红 */
.mb-play .mb-vnone{max-width:70vw;color:#aaa;padding:26px;text-align:center;line-height:1.9;
  font-size:13px;}
.mb-play .mb-verr{max-width:70vw;color:#d88;padding:26px;text-align:center;line-height:1.9;
  background:#1b1b1b;border:1px solid #4a4a4a;border-radius:9px;}
.mb-play .bar{flex:0 0 auto;margin-top:auto;width:100%;max-width:none;box-sizing:border-box;
  display:flex;gap:8px;align-items:center;color:#ccc;font-size:12px;
  flex-wrap:wrap;justify-content:center;padding:8px 16px 16px;
  background:linear-gradient(transparent,rgba(0,0,0,.45));}
.mb-play .bar button{background:#333;border:1px solid #4a4a4a;color:#ddd;
  padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;min-height:38px;}
:where(html:not(.mb-touch)) .mb-play .bar button:hover{background:#3d3d3d;}
.mb-play .bar button.pick{background:#2e6a3a;border-color:#4caf50;color:#fff;}
:where(html:not(.mb-touch)) .mb-play .bar button.pick:hover{background:#37804a;}
/* ── 触屏：操作条常显 ──
   光靠 @media (hover: none) 不够：带触摸屏的笔记本**同时**有鼠标，
   (hover: hover) 也成立，于是手指用户还是得先"悬停"——根本做不到。
   所以再加一条运行时判断：只要真的用手指点过一次，就切到常显。 */
/* ⚠️ 触屏下操作条**整条不出现**。两版之前是「整条常显」，盖住画面下半截，
   一屏扫过去全是按钮看不到图；上一版改成「点⋯就地展开」，还是盖在图上 ——
   「想看清楚」和「想动手」始终在抢同一块地方。
   现在全部走另开一层的菜单（见 .mb-more），图片这块地就完整留给图片。
   悬停也不放条：混合设备上鼠标一扫过去条就冒出来，跟这个意图打架。 */
/* ⚠️ 判据是**量这一格有多宽**，不是「这是不是手机」。
   设备型号说明不了问题：同一台电脑把窗口拖窄、或者切到「一行 6 个」，
   格子照样放不下；而平板横过来放得下。量格子才是量到了真正相关的那个量，
   而且窗口一拖、档位一换就自动跟着变，不需要给每种设备写一条规则。
   触屏会更早收起来，是因为触屏的按钮下限更大（--mb-btn-w/h），
   这条差异自然落在同一个判据里，不用单独判。 */
.mb-box:not(.bar-fits) .mb-cell .mb-bar,
.mb-box:not(.bar-fits) .mb-cell:hover .mb-bar,
.mb-box:not(.bar-fits) .mb-cell.touched .mb-bar{transform:translateY(105%);}
/* 闲置淡出：让开画面，任何触摸/滚动都会把它们叫回来（见 wakeBars）。
   操作条不在这份名单里 —— 它现在本来就只在展开的那一格上出现。 */
.mb-box.touching.bars-idle:not(.mb-selecting) .mb-cell:not(.checked) .mb-check,
.mb-box.touching.bars-idle .mb-cell .mb-redo,
.mb-box.touching.bars-idle .mb-cell .mb-skip:not(.on),
.mb-box.touching.bars-idle .mb-cell:not(.peek) .mb-peek{opacity:0;transition:opacity .35s ease;
  pointer-events:none;}
.mb-box.touching .mb-cell .mb-bar{opacity:1;}
/* 触屏用的「⋯」：开这一项的操作菜单。
   不参与闲置淡出：淡掉了就没人找得到操作入口在哪。 */
.mb-cell .mb-more{position:absolute;right:3px;bottom:3px;z-index:6;display:none;
  width:var(--mb-peek,26px);height:var(--mb-peek,26px);padding:0;
  align-items:center;justify-content:center;line-height:1;
  border-radius:6px;background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.22);
  color:#ddd;cursor:pointer;}
.mb-box:not(.bar-fits) .mb-cell .mb-more{display:flex;}
.mb-cell .mb-more:active{background:#2e5aa0;border-color:#5a8dd6;color:#fff;}
.mb-box.touching .mb-cell .mb-redo,
.mb-box.touching .mb-cell .mb-skip,
.mb-box.touching .mb-cell .mb-peek{opacity:1;pointer-events:auto;}
/* 触屏没有 hover，多选入口必须跟其它角落操作同时出现；文件夹没有选择语义。 */
.mb-box.touching .mb-cell:not(.dir) .mb-check{opacity:1;pointer-events:auto;}
.mb-box.touching .mb-cell.detecting .mb-redo{opacity:.4;pointer-events:none;}
.mb-box.touching .mb-cell .mb-bar button{min-height:max(34px,var(--mb-btn-h,32px));}
/* 一行装不下几个就藏几个。按重要性从后往前藏 —— DOM 顺序即优先级：
   锁 · 收藏 · 截图 · 查看 · 提示词 · 工作流 · 删除。
   锁在底栏，不叠在画面上 —— 叠在左上角时，点图容易误锁。
   眼睛仍只在已糊时出现。藏掉的功能换大一档格子就回来。 */
/* ── 触屏工具栏尺寸 ──
   这里**只管尺寸**，不管操作条显不显示。
   显不显示由 JS 的 .touching 一个类说了算（见下面 setTouch 的注释）——
   曾经这两件事各管一半：CSS 按「这台机器有没有鼠标」判、JS 按「你这一下用的什么」判，
   于是手机上会出现「条常显但闲置不淡出」这种半吊子状态。现在只留一个真相源。 */
@media (hover: none) {
  .mb-top select,.mb-top button{min-height:40px;min-width:42px;}
}
/* 混合输入设备可能同时有鼠标和触屏，运行时识别到触摸后也要保持同一点击下限。 */
.mb-touch .mb-top select,.mb-touch .mb-top button{min-height:40px;min-width:42px;}
/* ── 提示词浮层 ── */
.mb-pop{position:fixed;z-index:10050;width:min(540px,78vw);max-height:72vh;
  display:flex;flex-direction:column;
  background:#1b1b1b;border:1px solid #4a4a4a;border-radius:10px;
  box-shadow:0 14px 40px rgba(0,0,0,.65);font-size:12px;color:#ddd;}
/* 标题行独占一行 —— 之前 ✕ 是绝对定位压在右上角，跟「复制」按钮撞一起了 */
.mb-pop .hd{display:flex;align-items:center;gap:8px;padding:9px 12px;flex:0 0 auto;
  border-bottom:1px solid #333;background:#232323;border-radius:10px 10px 0 0;}
.mb-pop .hd .fn{flex:1;color:#aaa;font-size:11px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mb-pop .hd .x{width:22px;height:22px;flex:0 0 auto;border:1px solid #4a4a4a;
  background:#2e2e2e;color:#bbb;border-radius:5px;cursor:pointer;font-size:12px;line-height:20px;}
:where(html:not(.mb-touch)) .mb-pop .hd .x:hover{background:#7a2e2e;border-color:#b05050;color:#fff;}
.mb-pop .bd{padding:10px 12px 12px;overflow-y:auto;}
.mb-pop h4{margin:0 0 6px;font-size:11px;color:#8ab4f8;font-weight:600;
  display:flex;align-items:center;justify-content:space-between;gap:8px;}
.mb-pop h4+h4,.mb-pop .txt+h4{margin-top:11px;}
.mb-pop .txt{background:#111;border:1px solid #3a3a3a;border-radius:6px;padding:8px 9px;
  white-space:pre-wrap;word-break:break-word;line-height:1.55;max-height:170px;overflow-y:auto;
  user-select:text;cursor:text;}
.mb-pop .cp{background:#2e5aa0;border:1px solid #5a8dd6;color:#fff;border-radius:5px;
  padding:2px 9px;font-size:11px;cursor:pointer;white-space:nowrap;}
:where(html:not(.mb-touch)) .mb-pop .cp:hover{background:#3a6cbd;}
.mb-pop .cp.ok{background:#2e7d32;border-color:#4caf50;}
/* 参数排成标签块 —— 之前是「模型 x · steps 8 · cfg 1 …」一长串挤成两行，读不动 */
.mb-pop .params{display:flex;flex-wrap:wrap;gap:5px;margin-top:11px;}
.mb-pop .params .p{display:flex;align-items:baseline;gap:5px;background:#232323;
  border:1px solid #383838;border-radius:5px;padding:3px 8px;}
.mb-pop .params .p b{color:#777;font-weight:400;font-size:10px;}
.mb-pop .params .p i{color:#ccc;font-style:normal;font-size:11px;}
.mb-pop .params .p.wide{width:100%;}
.mb-pop .params .p.wide i{word-break:break-all;}
.mb-pop .warn{margin-top:10px;padding:7px 9px;border-radius:6px;line-height:1.6;
  background:rgba(191,138,12,.12);border:1px solid rgba(191,138,12,.4);color:#d3a94a;}
.mb-pop .none{color:#888;padding:8px 2px;line-height:1.7;}
.mb-bot{flex:0 0 auto;padding:8px 12px;border-top:1px solid #383838;background:#252525;
  color:#999;font-size:12px;display:flex;justify-content:space-between;align-items:center;}
/* 官方线描图标：复用 Comfy 已注入的 icon-[lucide--*] / icon-[comfy--*] */
.mb-ico{display:inline-block;width:1.15em;height:1.15em;vertical-align:-0.18em;
  pointer-events:none;flex:0 0 auto;}
.mb-ico.spin{animation:mb-spin .7s linear infinite;}
.mb-cell .mb-bar button,.mb-chrome button,.mb-top [data-act],.mb-pin,
.mb-play .bar .act,.mb-play .mb-x,.mb-pop .hd .x{
  display:inline-flex;align-items:center;justify-content:center;}
.mb-cell.dir .ico .mb-ico{width:32px;height:32px;}
.mb-cell .mb-doc .mb-ico{width:28px;height:28px;}
.mb-cell .mb-badge .mb-ico{width:11px;height:11px;vertical-align:-1px;}
`;

let styleAdded = false;
const addStyle = () => {
  if (styleAdded) return;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
  // 图标自带一份，不蹭 ComfyUI 的 UnoCSS 产物 —— 那是它的内部实现，
  // 换一次图标集我们就是满屏空方块，而且完全不报错。
  // 地址用 import.meta.url 推：/extensions/<目录名>/ 里那个目录名由 ComfyUI 决定
  // （见 nodes.py 的 EXTENSION_WEB_DIRS），硬编码猜错就是 404。
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./mb-icons.css", import.meta.url).href;
  document.head.appendChild(link);
  styleAdded = true;
};

// 搜索词 / 滚动：只留当次页面，刷新丢掉。
// 上次的根 + 子目录：进 localStorage，重启服务再开还在。
// 递归 / 类型筛 / 排序跟格子大小一样，记本机。
// ⚠️ 路径必须**按节点类型分开记**。以前是全局一份，结果从图片节点浏览过 output 之后，
// 再打开视频节点会跟着开在 output（而它的根本该是 input）—— 两个节点吃的东西
// 都不一样，共用一份浏览状态没道理。
const REC_KEY = "mediabrowser.rec";
const KINDS_KEY = "mediabrowser.kinds";
const SORT_KEY = "mediabrowser.sort";
const PLACE_KEY = "mediabrowser.place";
const recOn = () => loadStr(REC_KEY, "1") === "1";
const loadKinds = () => {
  const saved = loadJSON(KINDS_KEY, null);
  if (Array.isArray(saved)) return new Set(saved);
  return new Set(["image", "video"]);
};
/* PLACE_HELPERS_BEGIN */
var PLACE_REAL_ROOTS = new Set(["input", "output", "temp"]);
var PLACE_ROOTS = new Set([...PLACE_REAL_ROOTS, "@fav", "@recent"]);
function sanitizeCwd(p) {
  const n = typeof p === "string" ? p.replace(/\\/g, "/") : "";
  if (!n || n.startsWith("/") || n.includes("://")) return "";
  const parts = [];
  for (const seg of n.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return "";
    parts.push(seg);
  }
  return parts.join("/");
}
function placeFromStore(all, key, fallbackRoot = null) {
  const p = all && typeof all === "object" ? all[key] : null;
  const fallback = PLACE_REAL_ROOTS.has(fallbackRoot) ? fallbackRoot : null;
  if (!p || typeof p !== "object") return { folder: null, cwd: "", root: fallback };
  const folder = PLACE_ROOTS.has(p.folder) ? p.folder : null;
  // 旧版本只存 folder；普通目录可直接推回真实根，虚拟视图则兼容回退到节点默认根。
  const root = PLACE_REAL_ROOTS.has(p.root)
    ? p.root
    : (PLACE_REAL_ROOTS.has(folder) ? folder : fallback);
  return { folder, cwd: sanitizeCwd(p.cwd), root };
}
function placeIntoStore(all, key, folder, cwd, realRoot = null) {
  const next = Object.assign({}, all && typeof all === "object" ? all : {});
  const scope = PLACE_ROOTS.has(folder) ? folder : null;
  const root = PLACE_REAL_ROOTS.has(realRoot)
    ? realRoot
    : (PLACE_REAL_ROOTS.has(scope) ? scope : null);
  const sub = sanitizeCwd(cwd);
  if (!scope && !sub) delete next[key];
  else next[key] = { folder: scope, cwd: sub, root };
  return next;
}
function scopeFromPlace(place, fallbackRoot) {
  const folder = place?.folder;
  const fallback = PLACE_REAL_ROOTS.has(fallbackRoot) ? fallbackRoot : "output";
  const root = PLACE_REAL_ROOTS.has(place?.root)
    ? place.root
    : (PLACE_REAL_ROOTS.has(folder) ? folder : fallback);
  const mode = folder === "@fav" || folder === "@recent" ? folder : "";
  return { root, mode, cwd: mode ? "" : sanitizeCwd(place?.cwd) };
}
function scopeWithMode(scope, mode) {
  const root = PLACE_REAL_ROOTS.has(scope?.root) ? scope.root : "output";
  // 常驻按钮也是退出入口：再次点击当前视图要回到目录，键盘用户不必重选同一个下拉值。
  const requested = mode === "@fav" || mode === "@recent" ? mode : "";
  const nextMode = requested && requested !== scope?.mode ? requested : "";
  return { root, mode: nextMode, cwd: "" };
}
function scopeWithRoot(scope, root, cwd = "") {
  const nextRoot = PLACE_REAL_ROOTS.has(root)
    ? root
    : (PLACE_REAL_ROOTS.has(scope?.root) ? scope.root : "output");
  return { root: nextRoot, mode: "", cwd: sanitizeCwd(cwd) };
}
function isMissingDirError(err) {
  const msg = String(err && err.message != null ? err.message : err || "");
  return msg.includes("目录不存在") || /\bHTTP 404\b/.test(msg);
}
/* PLACE_HELPERS_END */

/* LAYER_HELPERS_BEGIN */
// ── 浏览器的「后退」拿来关最上面那一层 ──────────────────────────
// 不接管的话，手机上开着浏览窗口按一下后退，**整个 ComfyUI 页面就退走了** ——
// 画布上没保存的流一起没。代价太大，所以必须接管。
//
// 做法：开一层就 pushState 一个**同 URL** 的状态。URL 不变 = 不碰 ComfyUI 的
// vue-router（实测推三层再逐层退，画布和 graph 都完好，URL 全程是 "/"）。
// 后退时收到 popstate 就关掉栈顶那一层；自己按 × / Esc 关时反过来退一格历史，
// 两边始终同步。
//
// 两个方向都要防「关两次 / 退两格」：
//   selfBack —— 我们自己调的 back 会回来一发 popstate，那一发不该再关一层；
//   fromPop  —— 正在被后退键关闭时，close 里再调 pop 就会多退一格历史。
function makeLayerStack(hist) {
  const stack = [];
  // ⚠️ 必须是**计数**，不能是布尔。history.back() 是异步的：连关两层时
  //    两次 pop() 同步发出去，两发 popstate 随后才到。用布尔的话第一发就把它清了，
  //    第二发被当成用户按的后退键 → 多关一层。
  //    实测症状：点一下图片关掉大图，整个浏览窗口跟着一起没了。
  let selfBack = 0;
  let fromPop = false;
  const ours = () => {
    // Vue Router 会 replaceState 覆盖当前条目。state 里没了 mbLayer
    // 还 hist.back()，就会退到打开 Comfy 之前的网站，
    // 画布一脏就弹出「要离开此网站吗？」。
    try { return hist.state != null && hist.state.mbLayer != null; }
    catch { return false; }
  };
  return {
    depth: () => stack.length,
    push(close) {
      stack.push(close);
      // 历史 API 被禁用（某些嵌入环境）也不该挡住开窗，所以吞掉异常
      try { hist.pushState({ mbLayer: stack.length }, ""); } catch { /* 没有历史就没有后退键支持，仅此而已 */ }
    },
    /** 自己的 × / Esc 关掉一层时调。 */
    pop() {
      if (fromPop) return;
      if (!stack.length) return;
      stack.pop();
      if (!ours()) return;
      selfBack++;
      try { hist.back(); } catch { selfBack--; }
    },
    /** 挂到 window 的 popstate 上。消化了就返回 true，好拦住 Vue Router。 */
    onPop() {
      if (selfBack > 0) { selfBack--; return true; }
      const close = stack.pop();
      if (!close) return false;
      fromPop = true;
      try { close(); } finally { fromPop = false; }
      return true;
    },
    /**
     * 把一扇已经在栈里的浏览窗提到「浏览窗这一档」的最前。
     * 不能无脑 push 到栈顶：大图 / 菜单压在上面时，后退键必须仍先关它们。
     * 浏览窗用 close._mbPicker 标记；没标的就是覆盖层。
     */
    raise(close) {
      const i = stack.indexOf(close);
      if (i < 0) return;
      stack.splice(i, 1);
      let at = stack.length;
      for (let j = 0; j < stack.length; j++) {
        if (!stack[j]._mbPicker) { at = j; break; }
      }
      stack.splice(at, 0, close);
    },
    /**
     * 按函数引用摘掉自己。关后面那扇窗时绝不能 pop 栈顶 ——
     * 否则画面拆的是 A，历史弹掉的是 B，后退键会乱。
     */
    drop(close) {
      if (fromPop) return;
      const i = stack.indexOf(close);
      if (i < 0) return;
      stack.splice(i, 1);
      if (!ours()) return;
      selfBack++;
      try { hist.back(); } catch { selfBack--; }
    },
  };
}
/* LAYER_HELPERS_END */

const mbLayers = makeLayerStack(window.history);
// 捕获阶段拦住：Comfy 的 Vue Router 也听 popstate。我们自己关浮层时
// 那一格 history.back() 若漏给它，会当成「离开当前页」。
window.addEventListener("popstate", (e) => {
  if (mbLayers.onPop()) e.stopImmediatePropagation();
}, true);
const loadPlace = (key, fallbackRoot) => placeFromStore(loadJSON(PLACE_KEY, {}), key, fallbackRoot);
const savePlace = (key, folder, cwd, realRoot) => {
  save(PLACE_KEY, placeIntoStore(loadJSON(PLACE_KEY, {}) || {}, key, folder, cwd, realRoot));
};
const memos = new Map();
const memoFor = (key, fallbackRoot) => {
  if (!memos.has(key)) {
    const place = loadPlace(key, fallbackRoot);
    memos.set(key, {
      q: "", cwd: place.cwd, rec: recOn(), folder: place.folder, root: place.root, scroll: 0,
      sort: loadStr(SORT_KEY, "time_desc"), kind: null,
    });
  }
  return memos.get(key);
};

/* PICKER_SESSION_BEGIN */
// 同时开几扇窗是产品能力；5 是默认刹车，不是架构上限。
// PICKER_MAX <= 0 视为不限制。每扇窗有自己的列表请求和缩略图池。
var PICKER_MAX = 5;
// 浏览窗 z 必须封在浮钮之下。.mb-mask 基底 10000，.mb-fab 是 10028。
// 以前每次 focus 只做 z++，上限挡不住次数，开久了会盖住浮钮和大图。
var PICKER_Z_BASE = 10000;
var PICKER_Z_CAP = 10027;
function restackPickerZ(sessions, base, cap) {
  const n = sessions.length;
  if (!n) return sessions;
  const lo = (Number.isFinite(base) ? base : 10000) + 1;
  const hi = Number.isFinite(cap) ? cap : lo;
  if (hi <= lo) {
    sessions.forEach((s, i) => { s.z = lo + i; });
    return sessions;
  }
  if (n === 1) {
    sessions[0].z = hi;
    return sessions;
  }
  const span = hi - lo;
  sessions.forEach((s, i) => {
    s.z = lo + Math.round((i * span) / (n - 1));
  });
  return sessions;
}
function makePickerRegistry(maxOf) {
  const sessions = [];
  const limitOf = () => {
    const n = Number(typeof maxOf === "function" ? maxOf() : maxOf);
    if (!Number.isFinite(n) || n <= 0) return Infinity;
    return n;
  };
  const restack = () => restackPickerZ(sessions, PICKER_Z_BASE, PICKER_Z_CAP);
  return {
    list: () => sessions.slice(),
    count: () => sessions.length,
    canOpen: () => sessions.length < limitOf(),
    register(session) {
      sessions.push(session);
      restack();
      return session;
    },
    unregister(id) {
      const i = sessions.findIndex((s) => s.id === id);
      if (i >= 0) sessions.splice(i, 1);
      restack();
    },
    findByNode(node) {
      if (!node) return null;
      return sessions.find((s) => s.node === node) || null;
    },
    front() {
      return sessions.length ? sessions[sessions.length - 1] : null;
    },
    focus(session) {
      if (!session) return null;
      const i = sessions.indexOf(session);
      if (i >= 0) {
        sessions.splice(i, 1);
        sessions.push(session);
      }
      restack();
      return session;
    },
  };
}
function pickerCascadePos(index, vw, vh, boxW, boxH, step) {
  step = step || 36;
  const x = Math.max(16, Math.min(vw - boxW - 16, 72 + index * step));
  const y = Math.max(16, Math.min(vh - boxH - 16, 48 + index * step));
  return { x, y };
}
function fabIsClick(dx, dy, threshold) {
  threshold = threshold == null ? 6 : threshold;
  return Math.hypot(dx, dy) < threshold;
}
function clampFabPos(x, y, vw, vh, size, margin) {
  size = size || 48;
  margin = margin == null ? 8 : margin;
  return {
    x: Math.min(Math.max(margin, x), Math.max(margin, vw - size - margin)),
    y: Math.min(Math.max(margin, y), Math.max(margin, vh - size - margin)),
  };
}
function defaultFabPos(vw, vh, size, margin) {
  size = size || 48;
  margin = margin == null ? 8 : margin;
  return clampFabPos(16, vh - 64, vw, vh, size, margin);
}
function isServiceDownError(err) {
  const msg = String(err && err.message != null ? err.message : err || "");
  return /failed to fetch|networkerror|load failed|err_connection|econnrefused/i.test(msg);
}
function pickerMemoKey(canPick, spec, folder) {
  return canPick ? `${spec?.kind ?? "any"}:${folder}` : "browse:any";
}
function windowResizeDelta(dir, dx, dy, start) {
  let x = start.x, y = start.y, w = start.w, h = start.h;
  if (dir.includes("e")) w = start.w + dx;
  if (dir.includes("w")) { w = start.w - dx; x = start.x + dx; }
  if (dir.includes("s")) h = start.h + dy;
  if (dir.includes("n")) { h = start.h - dy; y = start.y + dy; }
  return { x, y, w, h };
}
function consumePickerEsc(frontMask, myMask, hasConfirm, hasPlay, hasPop) {
  // 确认框 / 大图 / 格子菜单都比浏览窗更前；它们自己听 Esc。
  // 浏览窗若在捕获期先 stopImmediate，菜单就永远收不到键。
  if (hasConfirm || hasPlay || hasPop) return false;
  return !!myMask && frontMask === myMask;
}
function firePickerEscHandlers(handlers) {
  // 复现「每个窗各挂一条 document keydown」：只让最前那扇 handle，
  // 并且立刻停掉后面的监听。没有 stopImmediate 时，关完 A 后 front 变成 B，
  // 同一发 Esc 会把 B 也关了。
  const closed = [];
  let stopped = false;
  for (const h of handlers.slice()) {
    if (stopped) break;
    if (!consumePickerEsc(h.front(), h.mask, !!h.hasConfirm, !!h.hasPlay, !!h.hasPop)) continue;
    h.close();
    closed.push(h.id);
    stopped = true;
  }
  return closed;
}
function clampWindowResize(edge, next, start, minW, minH, vw, vh) {
  const w = Math.min(vw * 0.98, Math.max(minW, next.w));
  const h = Math.min(vh * 0.96, Math.max(minH, next.h));
  let x = next.x, y = next.y;
  const dir = String(edge || "");
  // 西/北向先按未夹紧的宽高算了 x/y；夹紧后必须钉住对边，否则窗口会往外跳。
  if (dir.includes("w")) x = start.x + start.w - w;
  if (dir.includes("n")) y = start.y + start.h - h;
  return { x, y, w, h };
}
/* PICKER_SESSION_END */
const pickerRegistry = makePickerRegistry(() => PICKER_MAX);
const applyPickerLayer = (session) => {
  if (session?.mask) session.mask.style.zIndex = String(session.z);
};
const restackPickerLayers = () => {
  pickerRegistry.list().forEach(applyPickerLayer);
};
const focusPicker = (session) => {
  if (!session) return;
  pickerRegistry.focus(session);
  restackPickerLayers();
  // z-index 换序之后，后退键用的层栈也得换，否则 Esc 和 Back 会关掉不同的窗。
  if (session.close) mbLayers.raise(session.close);
};

// 最近用过：存 localStorage，跨会话保留。你反复用同几张参考图，这个每天省事。
// ── localStorage 小封装 ──
//    这里存的全是界面偏好（打码开关、格子大小、收藏表…）。localStorage 在
//    隐私模式、配额满、或者浏览器禁了站点数据时会抛异常 —— 存不上顶多下次
//    回到默认值，绝不该因此中断用户正在做的事，所以统一吞掉。
//    包成函数是为了让这个理由只写一遍：散在各处的 `catch {}` 看起来像偷懒，
//    而读的人没法确认是不是真的想吞。
const save = (k, v) => {
  try { localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); }
  catch { /* 见上：存不上不影响使用 */ }
};
const loadStr = (k, dflt = null) => {
  try { const s = localStorage.getItem(k); return s === null ? dflt : s; }
  catch { return dflt; }
};
const loadJSON = (k, dflt) => {
  try { return JSON.parse(localStorage.getItem(k) || "null") ?? dflt; }
  catch { return dflt; }
};

// 语言：设置里的选择优先；自动才跟 Comfy.Locale。缺词显示中文原文。
const MB_LANG_KEY = "mediabrowser.lang";
const mbLangPref = () => {
  const v = loadStr(MB_LANG_KEY, "auto");
  return (v === "zh" || v === "en" || v === "auto") ? v : "auto";
};
const comfyLocale = () => {
  try {
    const v = app?.ui?.settings?.getSettingValue?.("Comfy.Locale");
    if (v) return String(v);
  } catch { /* 旧前端没有这个设置 */ }
  for (const k of ["Comfy.Settings.Comfy.Locale", "Comfy.Locale"]) {
    try {
      const s = localStorage.getItem(k);
      if (!s) continue;
      const p = s[0] === "\"" ? JSON.parse(s) : s;
      if (p) return String(p);
    } catch { /* 解析失败就试下一个 */ }
  }
  return "zh-CN";
};
const mbLang = () => {
  const pref = mbLangPref();
  if (pref === "zh" || pref === "en") return pref;
  return /^zh/i.test(comfyLocale()) ? "zh" : "en";
};
const t = (zh, vars) => {
  if (zh == null || zh === "") return "";
  let s = mbLang() === "en" ? (MB_EN[zh] ?? zh) : zh;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(v == null ? "" : String(v));
    }
  }
  return s;
};
const applyI18n = (root) => {
  const scope = root?.querySelectorAll ? root : document;
  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.getAttribute("data-i18n-html"));
  });
  scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
  scope.querySelectorAll("[data-i18n-label]").forEach((el) => {
    el.label = t(el.getAttribute("data-i18n-label"));
  });
  try {
    document.documentElement.style.setProperty("--mb-sel-tag", JSON.stringify(t("当前")));
  } catch { /* 设不上也不挡 */ }
};
const langSelectHtml = () => {
  const cur = mbLangPref();
  const opts = [
    ["auto", t("跟随 Comfy")],
    ["zh", "中文"],
    ["en", "English"],
  ].map(([k, lab]) =>
    `<option value="${k}"${k === cur ? " selected" : ""}>${escHtml(lab)}</option>`
  ).join("");
  return `<label class="mb-lang"><span>${escHtml(t("语言"))}</span><select class="mb-lang-sel">${opts}</select></label>`;
};

// ── 多选选区 ──
// 浏览层默认能力：没选区时单击走原来的看大图/选中；有选区后单击只加减选。
// 文件夹永不进选区。顶栏全选只作用于当前列表里的文件。
const selectablePaths = (items) =>
  (items || []).filter((it) => it && it.type !== "dir" && it.path).map((it) => it.path);
const selectAllState = (paths, selected) => {
  if (!paths.length) return "none";
  let n = 0;
  for (const p of paths) if (selected.has(p)) n++;
  if (n === 0) return "none";
  if (n === paths.length) return "all";
  return "some";
};
const nextSelectAll = (paths, selected) => {
  if (selectAllState(paths, selected) === "all") return new Set();
  return new Set(paths);
};
const toggleSelected = (selected, path) => {
  const next = new Set(selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
};
const cellClickIntent = (opts) => {
  if (opts?.isDir) return "open";
  if (opts?.hasSelection) return "select";
  return "open";
};
const pruneSelected = (selected, paths) => {
  const allow = new Set(paths);
  const next = new Set();
  for (const p of selected) if (allow.has(p)) next.add(p);
  return next;
};
const batchFavIntent = (paths, isFav) =>
  paths.length && paths.every((p) => isFav(p)) ? "unfav" : "fav";
// ── 多选选区结束 ──

// ── 遮蔽：三态 + 框缓存画在 <img> 上面，不换 src ──
const CENSOR_KEY = "mediabrowser.censor";
// 局部档下，框还没检测出来的那一张先怎么显示：
//   "show"（默认）先直接显示原图，检测到框了再盖上去 —— 能正常翻页、
//           看得出哪张是哪张。日常浏览要的是这个。
//   "blur"  先按全幅糊着，只有检测确认过的才逐张露出来 —— 有人在旁边时用。
//
// 为什么不定死成 blur：检测**不跟着滚动走**（只在按「检测这一屏」时跑），
// 糊却跟着滚动走 —— 两样凑一起，往下滚就是一片永远解不开的糊，
// 而且点开之前根本不知道那一页是什么。这不是取舍，是死胡同。
// 为什么也不删掉 blur：它不是「全幅」的重复。全幅是永远不露；
// 这个是「先全遮、检测清一张露一张」的渐进揭示，全幅给不了。
const CENSOR_WAIT_KEY = "mediabrowser.censorWait";
const censorWaitBlurs = () => loadStr(CENSOR_WAIT_KEY, "show") === "blur";
const CENSOR_THR_KEY = "mediabrowser.censorThr";
const CENSOR_COVER_KEY = "mediabrowser.censorCover";
const CENSOR_BLUR_KEY = "mediabrowser.censorBlur";
const CENSOR_TITLE = {
  get off() { return t("原图：关掉全幅和局部（已锁的仍糊）"); },
  get full() { return t("全幅：眼前看得见的图整张糊掉，不跑检测"); },
  get local() { return t("局部：只遮检测出来的部位。旁边的扫描图标检测眼前这一屏，不会自动跑"); },
};
// 检测器认得 18 类部位，默认只遮「露出」的那 6 类。
// ⚠️ 过滤发生在**前端**，而后端把 0.15 分以上的框全存了 ——
//    所以改这份名单是**瞬时生效的，不用重新检测**。
//    实测本机 119 条缓存：显示 144 个框，被这份名单挡掉的高分框有 357 个
//    （FACE_FEMALE 138、ARMPITS_EXPOSED 63、FEMALE_BREAST_COVERED 57…）。
//    「怎么点重检都一样」的真正原因就在这里 —— 不是检测不到，是被过滤掉了。
const CENSOR_LABEL_GROUPS = [
  ["露出", ["BUTTOCKS_EXPOSED", "FEMALE_BREAST_EXPOSED", "FEMALE_GENITALIA_EXPOSED",
            "MALE_BREAST_EXPOSED", "ANUS_EXPOSED", "MALE_GENITALIA_EXPOSED"]],
  ["隔着衣服", ["FEMALE_BREAST_COVERED", "FEMALE_GENITALIA_COVERED",
                "BUTTOCKS_COVERED", "ANUS_COVERED", "BELLY_COVERED",
                "ARMPITS_COVERED", "FEET_COVERED"]],
  ["其它部位", ["FACE_FEMALE", "FACE_MALE", "BELLY_EXPOSED",
                "ARMPITS_EXPOSED", "FEET_EXPOSED"]],
];
const CENSOR_LABEL_NAME = {
  BUTTOCKS_EXPOSED: "臀", FEMALE_BREAST_EXPOSED: "女胸", FEMALE_GENITALIA_EXPOSED: "女下体",
  MALE_BREAST_EXPOSED: "男胸", ANUS_EXPOSED: "肛门", MALE_GENITALIA_EXPOSED: "男下体",
  FEMALE_BREAST_COVERED: "女胸", FEMALE_GENITALIA_COVERED: "女下体",
  BUTTOCKS_COVERED: "臀", ANUS_COVERED: "肛门", BELLY_COVERED: "腹部",
  ARMPITS_COVERED: "腋下", FEET_COVERED: "脚",
  FACE_FEMALE: "脸（女）", FACE_MALE: "脸（男）", BELLY_EXPOSED: "腹部",
  ARMPITS_EXPOSED: "腋下", FEET_EXPOSED: "脚",
};
// 胸部单独的打码范围。
// 模型没有「乳头」类，FEMALE_BREAST_EXPOSED 框住的是整个乳房；
// 想只盖中心（≈乳头）就得把这个框缩小。但不能用全局「打码范围」——
// 那会把下体的框一起缩掉，而下体恰恰是最该盖满的。所以单开一个。
// 1 = 跟全局一样，0.45 = 只留中心 45%。
const CENSOR_BREAST_COVER_KEY = "mediabrowser.censorBreastCover";
const BREAST_LABELS = new Set(["FEMALE_BREAST_EXPOSED", "FEMALE_BREAST_COVERED",
                               "MALE_BREAST_EXPOSED"]);
const censorBreastCover = () => {
  const n = parseFloat(loadStr(CENSOR_BREAST_COVER_KEY, "1"));
  return Number.isFinite(n) ? Math.min(1.2, Math.max(0.3, n)) : 1;
};
// 单张微调：四条滑块都能只管这一张。
// 分两类，分清楚了才知道该调哪个：
//   判定类（thr）  —— 决定**哪些框够格被遮**。「这张更严」也是动它（乘 0.6）+ 多加几类，
//                     滑块给的是同一件事的连续控制。
//   画法类（cover / breast / blur）—— 决定**每个框画多大、多糊**，不改哪些框被选中。
// 为什么胸部也要能单张调：模型的乳房框误差随姿势、角度、裁切变化，本来就逐图不同
//   —— 大部分图对得上、个别图框偏小，只能单独给那几张加大。
// 单开一个键，不动 CENSOR_ONE_KEY 已有的形态（字符串 / 数组），免得做数据迁移。
const CENSOR_TUNE_KEY = "mediabrowser.censorOneTune";
let censorTuneCache = null;
const censorTune = (folder) => {
  if (!censorTuneCache) censorTuneCache = loadJSON(CENSOR_TUNE_KEY, {}) || {};
  if (!censorTuneCache[folder]) censorTuneCache[folder] = {};
  return censorTuneCache[folder];
};
const censorTuneOf = (folder, path) => censorTune(folder)[path] || null;
/** patch 里给 null 表示这一项改回跟随全局；两项都没了就把整条删掉。 */
const setCensorTune = (folder, path, patch) => {
  censorTune(folder);
  const m = { ...(censorTuneCache[folder] || {}) };
  const cur = { ...(m[path] || {}), ...patch };
  for (const k of Object.keys(cur)) if (cur[k] == null) delete cur[k];
  if (Object.keys(cur).length) m[path] = cur; else delete m[path];
  censorTuneCache[folder] = m;
  save(CENSOR_TUNE_KEY, censorTuneCache);
};

// 这一张单独设过就用它的，否则跟全局
const coverFor = (label, rule) => {
  const pick = (k, fallback) => (rule && rule[k] != null ? rule[k] : fallback);
  return (BREAST_LABELS.has(label) ? pick("breast", censorBreastCover()) : 1)
    * pick("cover", censorCover());
};

// 单张微调的四条滑块。渲染和接线都从这张表来，加一条只改这里。
// scale=100 表示界面上是 0.45~1.20、存的是同一个数（滑块本身只能走整数）。
const CENSOR_TUNE_FIELDS = [
  { key: "thr", group: "判定", lab: "检测灵敏度", min: 15, max: 80, scale: 100,
    of: () => censorThr(), fmt: (v) => v.toFixed(2) },
  { key: "cover", group: "画法", lab: "打码范围", min: 45, max: 120, scale: 100,
    of: () => censorCover(), fmt: (v) => v.toFixed(2) },
  { key: "breast", group: "画法", lab: "胸部单独缩小", min: 30, max: 120, scale: 100,
    of: () => censorBreastCover(), fmt: (v) => v.toFixed(2) },
  { key: "blur", group: "画法", lab: "糊的程度", min: 6, max: 28, scale: 1,
    of: () => censorBlur(), fmt: (v) => String(v) },
];

const CENSOR_LABELS_KEY = "mediabrowser.censorLabels";
// 默认只遮**要害**四类：女下体 / 男下体 / 肛门 / 女胸。
// 臀和男胸不在内 —— 它们在多数图里不构成问题，遮了反而把画面糊掉一大块。
// ⚠️ 模型没有「乳头」这一类（18 类里最细的就是 FEMALE_BREAST_EXPOSED，
//    框住的是整个乳房）。想只盖中心，用「打码范围」把框缩小，见 censorCover。
const CENSOR_LABELS_DEFAULT = [
  "FEMALE_GENITALIA_EXPOSED", "MALE_GENITALIA_EXPOSED",
  "ANUS_EXPOSED", "FEMALE_BREAST_EXPOSED",
];
const ALL_CENSOR_LABELS = CENSOR_LABEL_GROUPS.flatMap(([, v]) => v);
const censorLabels = () => {
  const saved = loadJSON(CENSOR_LABELS_KEY, null);
  if (!Array.isArray(saved)) return new Set(CENSOR_LABELS_DEFAULT);
  const ok = saved.filter((x) => ALL_CENSOR_LABELS.includes(x));
  // 一个都不选等于不打码，多半是误操作 —— 退回默认，别让用户以为功能坏了
  return new Set(ok.length ? ok : CENSOR_LABELS_DEFAULT);
};
// 单张覆盖：某一张图的遮蔽力度跟全局不一样时，只改它。
// 为什么需要：全局设低了才不会到处糊成一片，但总有那么一两张检测得不够 ——
// 为一张图去改全局，其余几千张就跟着遭殃。
// 存的是「相对全局的档」，不是绝对值：全局调了，这张跟着水涨船高。
//   "more" = 阈值打六折 + 加上「隔着衣服」那组
//   "max"  = 阈值压到下限 + 全部部位
// 键跟单张锁一样按**真实根目录**分，别用 "@fav" 这种虚拟范围。
const CENSOR_ONE_KEY = "mediabrowser.censorOne";
let censorOneCache = null;
const censorOne = (folder) => {
  if (!censorOneCache) censorOneCache = loadJSON(CENSOR_ONE_KEY, {});
  return censorOneCache[folder] || {};
};
const censorOneOf = (folder, path) => censorOne(folder)[path] ?? "";
const setCensorOne = (folder, path, level) => {
  censorOne(folder);
  const m = { ...(censorOneCache[folder] || {}) };
  if (level) m[path] = level; else delete m[path];
  censorOneCache[folder] = m;
  save(CENSOR_ONE_KEY, censorOneCache);
};
// 这张图实际用的阈值和名单
// 这张图实际用的阈值和名单。存的值有两种形态：
//   字符串 "more"/"max" —— 预设档，跟着全局水涨船高
//   数组 [...labels]     —— 这张自选了部位
// 自选部位时阈值压到 CACHE_FLOOR：你明确点名要某个部位，
// 就该把检测到的都给你，而不是再被全局灵敏度挡一道 ——
// 否则「我勾了脸怎么还没遮」会是必然的困惑。
const CENSOR_MIN_THR = 0.15;      // 与后端 CACHE_FLOOR 对齐：更低也没有框了
const censorRuleFor = (folder, path) => {
  const v = censorOneOf(folder, path);
  const tune = censorTuneOf(folder, path) || {};
  // 画法三项跟档位无关：档位决定「遮哪些」，它们决定「画多大、多糊」，照样叠上去
  const base = { cover: tune.cover, breast: tune.breast, blur: tune.blur };
  let r;
  if (Array.isArray(v)) r = { ...base, thr: CENSOR_MIN_THR, labels: new Set(v) };
  else if (v === "max") r = { ...base, thr: CENSOR_MIN_THR, labels: new Set(ALL_CENSOR_LABELS) };
  else if (v === "more") {
    r = {
      ...base,
      thr: Math.max(CENSOR_MIN_THR, censorThr() * 0.6),
      labels: new Set([...censorLabels(), ...CENSOR_LABEL_GROUPS[1][1]]),
    };
  } else r = { ...base, thr: censorThr(), labels: censorLabels() };
  // 单张灵敏度**盖过**档位算出来的那个：滑块是你明确点的，比档位的推断更该算数
  if (tune.thr != null) r.thr = Math.max(CENSOR_MIN_THR, tune.thr);
  return r;
};
// 空分类不出现。导出 / 整理有内容再往数组里加。
const settingsNav = () => [
  { id: "display", title: t("显示"), icon: "lucide--image" },
  { id: "detect", title: t("检测"), icon: "lucide--eye" },
  { id: "storage", title: t("存储"), icon: "lucide--folder" },
];
const MB_EN = {
  "语言": "Language",
  "跟随 Comfy": "Follow Comfy",
  "当前": "Current",
  "显示": "Display",
  "检测": "Detect",
  "存储": "Storage",
  "设置": "Settings",
  "关闭": "Close",
  "取消": "Cancel",
  "确定": "OK",
  "复制": "Copy",
  "已复制": "Copied",
  "✓ 已复制": "Copied",
  "删除": "Delete",
  "清理": "Clean up",
  "图片": "Images",
  "视频": "Videos",
  "音频": "Audio",
  "其它": "Other",
  "原图": "Original",
  "全幅": "Full blur",
  "局部": "Local",
  "遮蔽": "Censor",
  "目录": "Folders",
  "最近": "Recent",
  "递归全部": "Recursive",
  "最小": "XS",
  "小": "S",
  "中": "M",
  "大": "L",
  "特大": "XL",
  "目录不存在": "Folder does not exist",
  "上次的「{path}」已经不在了，已回到 {root}。被删或改名就会这样，点范围或面包屑另选。": "The last folder “{path}” is gone, so this is {root}. That happens when it was deleted or renamed. Pick another from the scope list or breadcrumbs.",
  "载入中…": "Loading…",
  "读取中…": "Reading…",
  "重新扫描…": "Refreshing…",
  "正在重新扫盘…": "Scanning…",
  "发布页": "Release page",
  "片{n}秒": "{n}s clip",
  "片{m}:{s}": "{m}:{s} clip",
  "{n}秒": "{n}s",
  "生成耗时": "Job time",
  "片长": "Duration",
  "时间": "Date",
  "模型": "Model",
  "步数": "Steps",
  "采样器": "Sampler",
  "调度器": "Scheduler",
  "重绘幅度": "Denoise",
  "种子": "Seed",
  "正向提示词": "Positive",
  "负向提示词": "Negative",
  "提示词（推测）": "Prompt (guessed)",
  "这个文件里没存提示词。": "No prompt stored in this file.",
  "它带着完整工作流 —— 点格子上的工作流按钮能把整条流载进画布。": "It has a full workflow — use the workflow button on the card to load it.",
  "原图：关掉全幅和局部（已锁的仍糊）": "Original: turn off full and local blur (locked items stay blurred)",
  "全幅：眼前看得见的图整张糊掉，不跑检测": "Full blur: blur everything on screen, no detection",
  "局部：只遮检测出来的部位。旁边的扫描图标检测眼前这一屏，不会自动跑": "Local: covers detected parts only. The scan icon beside it scans this screen — it never runs on its own",
  "先点「局部」，再点这个图标检测眼前这一屏。检测不会自动跑。": "Click Local first, then this icon to scan the screen. Detection never runs on its own.",
  "检测中 {done}/{total}，点一下取消。已检完的留着，没检的还在原地。": "Scanning {done}/{total}. Click to stop. Finished results are kept; the rest stay as they are.",
  "临时看一眼（再点一下糊回去）。只影响眼前这一次，不改任何设置": "Peek (click again to blur). This view only, no settings change",
  "临时看一眼（再点糊回去）。只影响这一次": "Peek (click again to blur). This time only",
  "糊回去": "Blur again",
  "移到回收站？": "Move to Recycle Bin?",
  "确定把 {name} 移到系统回收站？": "Move {name} to the Recycle Bin?",
  "文件会从当前目录消失，可以在回收站还原。浏览里没有撤销。": "It leaves this folder. You can restore it from the Recycle Bin. Browse has no undo.",
  "移到回收站": "Move to Recycle Bin",
  "{name}接口是 {status}：必须关掉 Comfy 的 Python 窗口再启动，只刷新网页不够": "{name} API returned {status}. Quit the Comfy Python window and start it again — refreshing the page is not enough",
  "重新检测这一张：丢掉旧框，只打这一张，不影响别的": "Re-detect this file: drop old boxes, this one only",
  "重新检测这一张：丢掉旧框，只打这一张": "Re-detect this file: drop old boxes, this one only",
  "已跳过河蟹。点一下恢复；点重新检测仍会打这一张": "Skipped. Click to restore; re-detect still scans this file",
  "跳过河蟹：这一张不跑局部检测": "Skip local detection for this file",
  "搜索文件名…（当前范围内）": "Search filenames… (this scope)",
  "选择真实媒体目录。收藏和最近在旁边单独切换": "Choose a media root. Favorites and recent are separate actions beside it",
  "ComfyUI 的 input 目录": "ComfyUI input folder",
  "ComfyUI 的 output 目录": "ComfyUI output folder",
  "ComfyUI 的 temp 目录": "ComfyUI temp folder",
  "点着切换要看哪几类，可以多选": "Toggle types; multiple allowed",
  "排序方式": "Sort",
  "时间 ↓ 新→旧": "Time ↓ new→old",
  "时间 ↑ 旧→新": "Time ↑ old→new",
  "名称 ↓": "Name ↓",
  "名称 ↑": "Name ↑",
  "切换排版：宫格（等大方格，整齐）／瀑布流（按原图比例，不裁切）": "Layout: grid (equal cells) / masonry (true aspect, no crop)",
  "一行放几个。直接点档位，不用一下下轮换": "Items per row. Pick a size directly — no more clicking through them",
  "只改格子怎么排，不改名单里有哪些文件": "Changes layout only; the file list stays the same",
  "重新扫一遍当前目录（出片后点这里，不会自动盯盘）": "Rescan this folder (after new outputs; it does not watch the disk)",
  "设置：显示、检测、存储": "Settings: display, detect, storage",
  "最大化 / 窗口化": "Maximize / windowed",
  "关闭浏览，不改动节点": "Close browse; the node is unchanged",
  "三种显示，同时只能选一个。局部只遮检测出来的部位。旁边的扫描图标检测眼前这一屏，说明在图标上。": "Three views, one at a time. Local covers detected parts only. The scan icon beside it scans this screen; hover the icon for the full explanation.",
  "整窗截图：把浏览窗口当前画面拷进剪贴板。局域网 IP 下会提示改用 127.0.0.1 或 https": "Copy the browse window to the clipboard. On a LAN IP you may need 127.0.0.1 or https",
  "把当前目录钉进「范围」下拉，下次一步就能回来": "Pin this folder in the scope list",
  "这个 ComfyUI 版本没有工作流标签页，载入会替换当前画布。": "This ComfyUI has no workflow tabs; loading replaces the current graph.",
  "当前画布上没保存的改动会丢失。要继续吗？": "Unsaved changes on the canvas will be lost. Continue?",
  "关闭（Esc、点画面外，或者再点一下图片）": "Close (Esc, click outside, or click the picture again)",
  "上一个（← 键）": "Previous (←)",
  "下一个（→ 键）": "Next (→)",
  "截这张进剪贴板（按当前遮蔽）。局域网 IP 下会提示改用 127.0.0.1 或 https": "Copy this frame (current censor). On a LAN IP you may need 127.0.0.1 or https",
  "移到回收站。会先问你一次；真的会从磁盘拿走": "Move to Recycle Bin. Asks first; it leaves the disk (restorable)",
  "收藏 / 取消收藏": "Favorite / unfavorite",
  "看提示词和参数，可一键复制": "Prompts and parameters; copy with one click",
  "在新标签打开这个文件里存的工作流": "Open the embedded workflow in a new tab",
  "这张已跳过河蟹，不会检测。要检测点重新检测": "This file is skipped. Use re-detect to scan it",
  "这张检测没完成，再点一次「局部」": "Detection did not finish. Click Local again",
  "局部接口是 404：必须关掉 Comfy 的 Python 窗口再启动，只刷新网页不够": "Local API is 404. Quit the Comfy Python window and start it again — refreshing is not enough",
  "还没装检测运行时。关掉预览，打开右上角设置，在 Comfy 的 Python 里装 onnxruntime": "onnxruntime is missing. Close preview, open Settings, install it in Comfy's Python",
  "还没有检测模型。关掉预览，打开右上角设置下载或指定本机文件": "No detector weights. Close preview, open Settings to download or pick a file",
  "还没装检测运行时。打开右上角设置，在 Comfy 的 Python 环境装 onnxruntime": "onnxruntime is missing. Open Settings and install it in Comfy's Python",
  "还没有检测模型。打开右上角设置下载或指定本机文件": "No detector weights. Open Settings to download or pick a file",
  "这张没有要遮的部位（或分数低于阈值）": "Nothing to cover (or below the threshold)",
  "当前没有遮蔽，看一眼没有可揭开的": "Nothing is censored, so peek has nothing to show",
  "已重新检测这一张": "Re-detected this file",
  "重新检测过了，这张没有要遮的部位": "Re-detected; nothing to cover",
  "这个预览没有删除入口": "This preview has no delete action",
  "没能移到回收站": "Could not move to Recycle Bin",
  "全选和批量操作": "Select all and batch actions",
  "全选当前列表里的文件（文件夹不选）": "Select all files in this list (folders stay out)",
  "取消选择": "Clear selection",
  "收藏选中的": "Favourite selected",
  "把选中的移到回收站": "Move selected to Recycle Bin",
  "已选 {n}": "{n} selected",
  "勾选 / 取消勾选": "Select / deselect",
  "把选中的 {n} 项移到回收站？": "Move {n} selected items to Recycle Bin?",
  "确定把选中的 {n} 个文件移到系统回收站？": "Move the {n} selected files to the system Recycle Bin?",
  "已把 {n} 项移到回收站": "Moved {n} items to Recycle Bin",
  "回收站：成功 {ok} / 失败 {fail}{err}": "Recycle Bin: {ok} ok / {fail} failed{err}",
  "已收藏 {n} 项": "Starred {n} items",
  "已取消收藏 {n} 项": "Unstarred {n} items",
  "全选": "Select all",
  "取消全选": "Clear all",
  "打不开：{msg}": "Cannot open: {msg}",
  "浏览器播不了这个编码（多半是 AV1 或 HEVC）。<br>文件本身没问题 —— 用外部播放器打开，或者直接「用这张」也不影响出图。": "The browser cannot play this codec (often AV1 or HEVC).<br>The file is fine — use an external player, or Select it anyway.",
  "这个文件打不开预览 —— 可能格式浏览器不认，或者根本不是图片/视频。<br>「用这张」仍然可用，能不能跑得看节点认不认。": "Preview failed — the browser may not know this format.<br>Select still works if the node accepts it.",
  "关掉这个浮层": "Close this popover",
  "🔴 读不出来：{msg}": "Could not read: {msg}",
  "收藏的（点格子上的星标加/取消）": "Favorites (toggle the star on a card)",
  "最近选过的": "Recently selected",
  "  （递归全部子目录）": "  (all subfolders)",
  "已锁：这张以后打开都是糊的。点一下解锁": "Locked: this file stays blurred. Click to unlock",
  "锁上：这张以后打开也是糊的（只管这一张）": "Lock: this file stays blurred (this file only)",
  "（顶上是「全幅」，所以现在锁不锁画面都是糊的 —— 切到原图才看得出区别）": "(Full blur is on, so lock does not change the picture until you switch to Original)",
  "已锁住这一张（切到原图后才看得出）。再点锁解开": "Locked (visible after you switch to Original). Click the lock again to undo",
  "已解锁这一张（切到原图后才看得出）": "Unlocked (visible after you switch to Original)",
  "已锁：这张以后打开都是糊的。再点锁解开": "Locked: this file stays blurred. Click the lock again to undo",
  "已解锁，这张不再单独糊": "Unlocked. This file is no longer blurred on its own",
  "已跳过河蟹。批量检测会略过。要检测这一张点重新检测": "Skipped. Batch detect ignores it. Click re-detect on this card to scan it",
  "已恢复检测。点重新检测或底栏「没检测」会打这一张": "Detection restored. Re-detect or the hint will scan this file",
  "这个节点只收{kind}，选不了 {ext}。": "This node only accepts {kind}, not {ext}.",
  "指定类型": "its type",
  "要用它得换成对应的加载节点": "Use a loader node that accepts this type",
  "已把「{name}」移到回收站": "Moved “{name}” to the Recycle Bin",
  "✕ 出不了封面": "✕ No poster",
  "✕ 打不开": "✕ Cannot open",
  "试了 3 次都没出来。点放大还能看/能播，也还能选它 —— 只是这里显示不出画面": "Failed 3 times. Zoom still works, and you can still select it — only this tile has no picture",
  "已渲染 {n} 格 · 点图选中，点文件夹进入": "Showing {n} tiles · click to select, click a folder to open",
  "预加载当前列表的原图？": "Preload originals for the current list?",
  "会把当前筛选里的 {n} 张图片原文件读进浏览器缓存。之后点开大图通常直接出全图。视频和文件夹不拉。": "This reads the original files of the {n} images in the current filter into the browser cache. Opening the large view afterwards is usually instant. Videos and folders are skipped.",
  "窗口不锁：仍可滚动、筛选、看大图。磁盘和网会忙一会儿，同时只拉 2 张，避免把机器打满。再点这个按钮就取消。": "The window stays usable: you can still scroll, filter and open the large view. Disk and network will be busy for a while. Only 2 files download at once so the machine is not flooded. Click the same button again to cancel.",
  "当前有 {n} 张，可能要很久。张数太多时，先关掉「递归全部」、用搜索或类型筛小范围。": "There are {n} images; this can take a long time. If that is too many, turn off Recurse all, or narrow with search / type filters.",
  "开始预加载": "Start preloading",
  "预加载当前列表里的原图。会先问你一次。视频不拉。窗口不锁，再点一次取消。": "Preload originals for the current list. Asks first. Videos are skipped. The window stays usable; click again to cancel.",
  "正在预加载原图 {done}/{total}。再点一次取消。浏览和看大图不受影响。": "Preloading originals {done}/{total}. Click again to cancel. Browsing and the large view still work.",
  "当前筛选里没有可预加载的图片": "No images to preload in the current filter",
  "已预加载 {n} 张原图，点开大图会直接出全图": "Preloaded {n} originals. The large view should open at full size.",
  "预加载结束：成功 {ok} 张，失败 {fail} 张": "Preload finished: {ok} ok, {fail} failed",
  "预加载没做成：{n} 张都没读进来": "Preload failed: none of the {n} files could be read",
  "已取消预加载（已完成 {done}/{total}）": "Preload cancelled ({done}/{total} done)",
  "筛选或目录变了，预加载已停下（已完成 {done}/{total}）": "Filter or folder changed; preload stopped ({done}/{total} done)",
  "筛选或目录变了，预加载没开始": "Filter or folder changed; preload did not start",
  "（其中 {n} 个点下去会提示换节点）": "({n} will ask you to switch nodes if clicked)",
  "　（共 {total}，按类型筛后剩 {n}）": "  ({total} total, {n} after type filter)",
  "{n} 个": "{n} items",
  "{nd} 个文件夹 · {nf} 个文件": "{nd} folders · {nf} files",
  "眼前还有 {n} 张没检测（不是整个文件夹）": "{n} on this screen not detected yet (this screen only, not the whole folder)",
  "眼前这一屏都已检测": "This screen is fully detected",
  "眼前这一屏都已检测。滚到没检过的图，再点局部旁边的扫描图标": "This screen is done. Scroll to new images, then press the scan icon beside Local",
  "检测眼前看得见的 {n} 张，标出要遮的部位。结果存下来，同一张图不会再检第二次。不检整个文件夹。": "Scans the {n} images on screen and marks the parts to cover. Results are stored, so an image is never scanned twice. Does not scan the whole folder.",
  "眼前这一屏都检测过了。滚到没检过的图，这里会自己亮起来。": "Everything on this screen is scanned. Scroll to new images and this lights up again.",
  "文件不存在": "File not found",
  "已取消跳过河蟹，开始检测这一张": "Skip cleared; detecting this file",
  "正在加载检测模型（只打眼前这一屏）…": "Loading the detector (this screen only)…",
  "整窗已复制（含浏览外框）": "Window copied (including the chrome)",
  "截图失败": "Screenshot failed",
  "先点开一张大图，或用节点里已经选中的那张": "Open a large view, or use the file already in the node",
  "图加载失败": "Image failed to load",
  "图没生成出来": "Image was not produced",
  "单图已复制": "Image copied",
  "连不上 Comfy。确认窗口还在跑，再打开设置": "Cannot reach Comfy. Make sure it is running, then open Settings again",
  "遮蔽接口是 404：现在这个 Comfy 进程启动时还没有这条路由。只刷新网页或点前端重启不够，必须关掉 Python 窗口再启动": "Censor API is 404. This Python process started without that route. Quit the Python window and start it again",
  "遮蔽接口返回 HTTP {status}。看 Comfy 控制台里 [MediaBrowser] 那一行": "Censor API returned HTTP {status}. Check the [MediaBrowser] line in the Comfy console",
  "已有权重（点一下切换）": "Installed weights (click to switch)",
  "点一下图片": "Clicking an item",
  "选中会关掉这个窗口、改掉节点的值；看大图按 Esc 就退。默认把最容易触发的手势留给可逆的那个。": "Picking closes this window and changes the node’s value; the large view just needs Esc. The easiest gesture defaults to the reversible one.",
  "看大图（选中走图上那个绿色 ✓）": "Open the large view (pick with the green ✓ on the item)",
  "直接选中并关窗（当选片器用）": "Pick it and close (use as a file picker)",
  "点一下图片＝直接选中并关窗。想只看看，用图上的放大钮": "Clicking an item now picks it and closes. To just look, use the zoom button on the item",
  "点一下图片＝看大图。要选中，点图上那个绿色 ✓，或在大图里点「用这张」": "Clicking an item now opens the large view. To pick, use the green ✓ on the item, or “Use this” in the large view",
  "这个类型没有预览：{ext}": "No preview for this type: {ext}",
  "文件本身没问题 —— 仍然可以「用这张」，或者用外部程序打开。": "The file itself is fine — you can still pick it, or open it in another app.",
  "看大图": "Large view",
  "锁住": "Lock",
  "解锁": "Unlock",
  "截图": "Snapshot",
  "提示词": "Prompt",
  "工作流": "Workflow",
  "回收站": "Trash",
  "返回上一层": "Back",
  "这一张的遮蔽力度、跳过、整张糊都在里面": "This item's censor level, skip and full blur are in here",
  "用这张": "Use this",
  "打开媒体浏览器（再点一次会新开一扇）": "Open the media browser (click again to open another window)",
  "最多同时打开 {n} 个窗口": "At most {n} windows can be open",
  "请先关掉预览或确认框": "Close the preview or confirmation first",
  "ComfyUI 服务不可用。列表和缩略图都要后端还在。": "ComfyUI is not reachable. Listing and thumbnails need the backend.",
  "这一张的操作：看大图 / 收藏 / 遮蔽 / 删除…": "Actions for this item: large view / favourite / censor / delete…",
  "填进节点，并关掉浏览窗口": "Fills it into the node and closes the browser",
  "看大图 / 播放": "Large view / play",
  "看的是原文件；打开后可以左右翻（← →），滚轮放大缩小": "Shows the original file; use ← → to flip through, mouse wheel to zoom",
  "滚轮放大缩小。放大后拖动画面。未放大时点图片关掉": "Scroll wheel zooms. Drag when zoomed. Click the picture to close when not zoomed",
  "锁住这张": "Lock this one",
  "解锁这张": "Unlock this one",
  "收藏": "Favourite",
  "取消收藏": "Remove from favourites",
  "钉进收藏列表，不会被新的挤掉": "Pins it to the favourites list; new files will not push it out",
  "从收藏列表里移走": "Takes it out of the favourites list",
  "截进剪贴板": "Copy frame",
  "按当前遮蔽截这一张：原图 / 全幅 / 局部": "Copies this one at the current censor level: original / full / local",
  "提示词和参数": "Prompt and settings",
  "这次用的词和参数，可一键复制": "The prompt and settings used for this run; one click to copy",
  "打开工作流": "Open workflow",
  "在新标签里打开这个文件存的流，不动你当前的画布": "Opens the workflow stored in this file in a new tab, leaving your canvas alone",
  "移到回收站": "Move to recycle bin",
  "会先问你一次；真的会从磁盘拿走（可在系统回收站还原）": "Asks first; it really leaves the disk (restorable from the system recycle bin)",
  "这一张的操作：用这张 / 看大图 / 收藏 / 遮蔽 / 删除…": "Actions for this item: use it / large view / favourite / censor / delete…",
  "缩略图清晰度": "Thumbnail sharpness",
  "只影响格子里的封面。点开查看 / 播放永远是原片，跟这里无关。": "Only affects grid covers. View / play is always the original file.",
  "配多少就请求多少，不做隐式换算。右边标的是这块屏上该档格子实际占的物理像素 —— 配得比它高看不出差别，只是白等。": "What you set is what gets requested — no hidden scaling. The number on the right is the physical pixels that size actually occupies on this screen; going higher changes nothing you can see.",
  "这套设置按设备各存一份：手机和电脑各配各的，互不影响。当前屏幕像素密度 {dpr}×。": "These settings are stored per device — phone and desktop keep their own. This screen’s pixel density is {dpr}×.",
  "这块屏上约需 {need} 像素": "needs ~{need}px here",
  "一键套用": "Apply a preset",
  "选一套，就把下面每一档都填成那套数。填完还能接着逐档改。": "Pick one and it fills every size below with that set. You can still tweak each one afterwards.",
  "自定义（下面的表被改过）": "Custom (the table below was edited)",
  "省流量（加载最快）": "Light — fastest to load",
  "均衡（推荐）": "Balanced — recommended",
  "清晰（大格子更锐）": "Sharp — crisper on big cells",
  "最高（大格子用原像素，很占带宽）": "Maximum — native pixels on big cells, heavy",
  "原像素": "Native pixels",
  "一行 {n} 个改用 {px}。当前正在用的档会立刻重取封面": "{n} per row now uses {px}. The size you are viewing refreshes right away",
  "已套用「{mode}」：下面每一档都填成了这套数，还能再逐档改。已出的封面会重取": "Applied “{mode}”: every size below is now that set, and you can still tweak each one. Existing covers refetch",
  "状态": "Status",
  "运行时 已就绪": "Runtime ready",
  "运行时 未安装": "Runtime missing",
  "可检测": "Ready to detect",
  "未就绪": "Not ready",
  "检测只处理眼前看得见的图，一次一屏，按了才跑。": "Detection covers only what is on screen, one screen per press.",
  "同时检测几张": "Scan several at once",
  "一次叠几张一起检。默认 2 张：下一张读盘和这一张推理可以同时做，比一张一张快一截。": "How many files to scan in parallel. Default is 2: the next file can load while this one runs, which is a bit faster than one-by-one.",
  "1 张（机器比较吃力）": "1 at a time (lighter machines)",
  "2 张（默认）": "2 at a time (default)",
  "3 张": "3 at a time",
  "4 张（机器比较强）": "4 at a time (stronger machines)",
  "改成 1 张：检测时还要出图、机器比较吃力，选这个。3 或 4 张：机器比较强才有用；模型一次只能跑一张，多出来的工位只是提前读盘。已经检过的图不会重跑。": "Pick 1 if the machine is also generating images or feels sluggish. 3 or 4 only help on stronger machines — the model still runs one image at a time, extra slots just preload the next files. Already scanned files are not run again.",
  "已改成同时检测 {n} 张。下一轮点局部旁边的扫描图标按这个数跑。": "Now scans {n} at a time. The next press of the scan icon beside Local uses this number.",
  "运行时要装到 Comfy 那个 Python：pip install onnxruntime。": "Install in Comfy's Python: pip install onnxruntime.",
  "推荐模型 640m": "Recommended model 640m",
  "只推这一份（约 99MB，效果最好）。失败再走 {link} 手动填路径。": "This one file only (~99MB, best result). If download fails, use {link} and paste a path.",
  "下载 640m": "Download 640m",
  "重新下载": "Download again",
  "局部档下，还没检测的图": "Local mode: images not detected yet",
  "检测要按顶栏局部旁边的扫描图标，不会自动跑。这里决定按之前那些图长什么样。": "Detection runs only when you press the scan icon beside Local. This decides how those images look until then.",
  "直接显示原图（默认）": "Show the original (default)",
  "先全部遮住": "Cover everything first",
  "选「先全部遮住」：只有检测确认过的才逐张露出来，适合有人在旁边时慢慢翻。": "With Cover everything first, images appear one by one as detection clears them — handy when someone else is around.",
  "已改成：没检测过的先全部遮住，检测确认过的才逐张露出来": "Changed: undetected images stay covered until detection clears them",
  "已改成：没检测过的直接显示原图，按局部旁边的扫描图标才盖上遮蔽": "Changed: undetected images show as-is; press the scan icon beside Local to censor them",
  "回到最上面（滚下去之后才出现）": "Back to the top (appears once you scroll down)",
  "缩略图": "Thumbnails",
  "检测框": "Detection boxes",
  "{n} 个": "{n} files",
  "／上限 {cap} 个": " / cap {cap}",
  "超上限会自动删最久没看过的那批，不用手动管。下面的按钮是要立刻腾地方时用的。": "Over the cap, the least recently viewed ones are dropped automatically — no upkeep needed. The buttons below are for when you need space right now.",
  "检测效果": "Detection look",
  "遮哪些部位": "What to cover",
  "跟随全局设置": "Follow global settings",
  "遮蔽": "Cover",
  "这张单独选部位…": "Pick parts for this one…",
  "勾了就按检测到的全给你，不再受全局灵敏度限制。": "Ticked parts show everything detected, no longer gated by the global sensitivity.",
  "取消跳过并检测这一张": "Stop skipping and detect this one",
  "重试检测（上次失败了）": "Retry detection (last attempt failed)",
  "这张已单独设。其它图不受影响": "Set for this file only. Others are unaffected",
  "已重新检测这一张：{n} 处": "Re-detected: {n} spot(s)",
  "重新检测完成：还是这 {n} 处，跟上次一样。检测是确定的，同一张图同一个模型就是同样结果 —— 想遮更多请右键这张选「更严」": "Re-detected: still the same {n} spot(s). Detection is deterministic — the same image and model always give the same result. To cover more, right-click this file and pick a stricter level",
  "跳过河蟹（批量检测略过它）": "Skip this one (batch detection ignores it)",
  "整张糊（不看检测框）": "Blur the whole image (ignore boxes)",
  "取消整张糊": "Stop blurring the whole image",
  "这张更严（放宽灵敏度 + 加上「隔着衣服」）": "Stricter (looser sensitivity + through-clothing parts)",
  "这张最严（所有部位都遮）": "Strictest (cover every part)",
  "这张改回跟随全局设置": "This file follows the global settings again",
  "检测器认得这些部位，勾中的才遮。改完立刻生效 —— 框早就检测出来了，只是之前被这份名单挡掉，不用重新检测。": "The detector knows these parts; only the ticked ones get covered. Takes effect immediately — the boxes were already detected and merely filtered out by this list, so no re-detection is needed.",
  "一个都没勾等于不打码。已退回默认的「露出」那几项": "Ticking nothing means no censoring at all. Reverted to the default “Exposed” set",
  "露出": "Exposed",
  "隔着衣服": "Through clothing",
  "其它部位": "Other parts",
  "臀": "Buttocks",
  "女胸": "Breasts (F)",
  "女下体": "Genitals (F)",
  "男胸": "Chest (M)",
  "肛门": "Anus",
  "男下体": "Genitals (M)",
  "腹部": "Belly",
  "腋下": "Armpits",
  "脚": "Feet",
  "脸（女）": "Face (F)",
  "脸（男）": "Face (M)",
  "只改怎么画，不用重新检测。": "Only changes drawing. No need to re-detect.",
  "只改这一张": "This item only",
  "只调这一张的遮蔽：力度、部位、打码范围": "Adjust censoring for this item only: level, parts, coverage",
  "判定：哪些框够格被遮": "Detection: which boxes qualify",
  "画法：每个框画多大、多糊": "Drawing: how big and how blurred each box is",
  "改回跟随全局": "Follow global again",
  "（跟随全局）": " (global)",
  "打码范围": "Cover size",
  "胸部单独缩小": "Shrink chest boxes only",
  "模型没有「乳头」这一类，框住的是整个乳房。调小只盖中心 —— 只作用于胸，下体的框不受影响。": "The model has no “nipple” class — the box covers the whole breast. Lower this to cover only the centre; it affects chest boxes only, genital boxes are untouched.",
  "糊的程度": "Blur amount",
  "检测灵敏度": "Sensitivity",
  "高级：本机权重": "Advanced: local weights",
  "只认 640m，或同系列的 320n。别的架构改路径没用。": "Only 640m, or 320n of the same series. Other ONNX architectures will not work.",
  "本机 .onnx 路径": "Local .onnx path",
  "例如 D:\\models\\640m.onnx": "e.g. D:\\models\\640m.onnx",
  "使用这个文件": "Use this file",
  "缓存": "Cache",
  "检测模型不在这里。要重下到「检测」。": "Detector weights are not here. Re-download under Detect.",
  "清缩略图": "Clear thumbnails",
  "腾服务器磁盘用。浏览器自己还缓存 7 天，画面多半不变；要看重新生成得强刷（Ctrl+F5）。": "Frees server disk. Your browser still caches them for 7 days, so the grid will look the same — hard-refresh (Ctrl+F5) to watch them rebuild.",
  "清检测框": "Clear boxes",
  "局部记住的框。下次要点「局部」重检。": "Saved local boxes. Click Local again to re-detect.",
  "偏好": "Preferences",
  "恢复默认界面": "Reset interface",
  "语言、格子、递归、类型、排序、点击行为、清晰度、遮蔽档位、滑条、检测并发和浮钮位置。收藏和锁不动。": "Language, grid, recursive, types, sort, click action, thumbnail quality, censor mode, sliders, detect concurrency and FAB position. Favorites and locks stay.",
  "恢复默认界面？": "Reset the interface?",
  "语言、格子、排序、点一下图片的行为、缩略图清晰度、遮蔽档位、全部滑条、检测并发和浮钮位置都会回到默认，不能撤销。收藏、锁、标记和缓存都不动。": "Language, grid, sort, click action, thumbnail quality, censor mode, every slider, detect concurrency and FAB position go back to their defaults. This cannot be undone. Favorites, locks, marks and caches are untouched.",
  "危险": "Danger",
  "清空收藏和标记": "Clear favorites and marks",
  "收藏、最近、钉住的目录、单张锁、跳过检测。": "Favorites, recent, pins, per-file locks, skip-detect.",
  "完全重置浏览": "Reset browse completely",
  "上面全部 + 磁盘缓存。不删检测模型。": "Everything above plus disk cache. Detector weights stay.",
  "下载中 {n}%": "Downloading {n}%",
  "已取消。当前推荐模型仍可用": "Cancelled. The current recommended model still works",
  "重新下载没成功，当前模型还能用。{err} · {link}": "Redownload failed; the current model still works. {err} · {link}",
  "已安装 640m": "640m installed",
  "已取消": "Cancelled",
  "失败：{err} · {link}": "Failed: {err} · {link}",
  "还没有推荐模型": "No recommended model yet",
  "推荐模型已经在，不用再下": "Recommended model is already here",
  "重新下载 640m？": "Download 640m again?",
  "已有的推荐模型还能用。只有这次下完并通过校验才会替换。": "The current model still works. It is replaced only after this download passes the check.",
  "已切换权重。已有框按新模型重画；眼前还没检过的点局部旁边的扫描图标": "Weights switched. Existing boxes redraw; undetected ones need the scan icon beside Local",
  "保存失败": "Save failed",
  "已清缩略图 {n} 个，服务器磁盘腾出来了。画面不会变 —— 浏览器还缓存着，强刷才重新生成": "Cleared {n} thumbnails and freed server disk. The grid stays as-is — your browser still has them; hard-refresh to rebuild",
  "清缩略图失败": "Could not clear thumbnails",
  "已清检测框 {n} 个。局部要重新点一次": "Cleared {n} box caches. Click Local again",
  "清检测框失败": "Could not clear boxes",
  "界面已回默认：语言跟随 ComfyUI、图+视频、递归开、瀑布流、遮蔽关": "Interface reset: language follows ComfyUI, images+video, recursive on, masonry, censor off",
  "清空收藏和标记？": "Clear favorites and marks?",
  "收藏、最近、钉住的目录、单张锁和跳过检测都会清掉。界面习惯和封面缓存不动。": "Favorites, recent, pins, locks and skip-detect will be cleared. UI prefs and covers stay.",
  "已清空收藏、最近、钉住和单张标记": "Cleared favorites, recent, pins and per-file marks",
  "完全重置浏览？": "Reset browse completely?",
  "界面、收藏、标记、缩略图和检测框都会清掉，回到刚装插件时的状态。检测模型不删。": "Interface, favorites, marks, thumbnails and boxes will be cleared. Detector weights stay.",
  "磁盘缓存没清掉": "Disk cache was not cleared",
  "浏览已完全重置。检测模型还在": "Browse was fully reset. Detector weights remain",
  "当前：瀑布流（按原图比例排，不裁切）。点一下换回宫格": "Masonry (true aspect, no crop). Click for grid",
  "当前：宫格（等大方格，会裁掉画面边缘）。点一下换成瀑布流": "Grid (equal cells, edges cropped). Click for masonry",
  "一行 {n} 个（{size}）": "{n} per row ({size})",
  "窗口太窄，这一档现在和更小的档一样宽。最大化或拉宽窗口后生效": "Window too narrow — this size currently renders the same as a smaller one. Maximise or widen the window to see the difference",
  "取消钉住「{name}」": "Unpin “{name}”",
  "钉住「{name}」：下次从上面的范围下拉一步就能回来": "Pin “{name}”: jump here from the scope list next time",
  "已钉住「{name}」，在上面的范围下拉里": "Pinned “{name}” in the scope list",
  "已取消钉住": "Unpinned",
  "钉住的目录": "Pinned folders",
  "窗口化：缩回可拖动的尺寸": "Windowed: back to a resizable size",
  "最大化：撑满可用空间": "Maximize: fill the available space",
  "当前范围没有{label}": "No {label} in the current scope",
  "当前范围没有可钉住的目录": "There is no folder to pin in this scope",
  "{label}：这个节点用不了，勾上只是拿来浏览（点了会说明原因）": "{label}: this node cannot use it; check it only to browse (clicking explains why)",
  "只看/不看{label}。可以多选，全不选＝全都看": "Show/hide {label}. Multiple allowed; none checked = show all",
  "这个节点上找不到「{widget}」这一栏，没法把选中的填进去。": "This node has no “{widget}” widget, so the pick cannot be written.",
  "先用节点自带的下拉选。": "Use the node's own dropdown instead.",
  "没能放进剪贴板": "Could not copy to the clipboard",
  "当前地址是 {host}。浏览器只允许本机 127.0.0.1 或 https 写剪贴板。": "This page is {host}. Browsers only allow clipboard writes from 127.0.0.1 or https.",
  "这台电脑：点「复制本机地址」，新建标签粘到地址栏。从这页直接跳 127.0.0.1 会被浏览器拦（报「请求遭到拒绝」），自己粘贴就没事。": "This PC: copy the local address and paste it in a new tab. Jumping to 127.0.0.1 from this page is blocked.",
  "别的设备 / 必须用这个 IP：点「复制提示词」，发给你的 AI 开 HTTPS。": "Other devices / this IP: copy the prompt and ask your AI to enable HTTPS.",
  "本机地址：": "Local address: ",
  "复制提示词": "Copy prompt",
  "复制本机地址": "Copy local address",
  "这一页也拦了自动复制。下面框里是提示词，请手动全选复制。": "This page also blocked auto-copy. Select all in the box below.",
  "已复制 {url}。新建标签粘到地址栏打开，再截一次。": "Copied {url}. Paste it in a new tab, then screenshot again.",
  "自动复制被拦了。下面框里是本机地址，请全选复制，新建标签粘贴。": "Auto-copy was blocked. Select the local address below and paste it in a new tab.",
  "没能放进剪贴板。当前地址是 {host}，浏览器只允许本机 127.0.0.1 或 https 写剪贴板": "Could not copy. This page is {host}; browsers only allow 127.0.0.1 or https",
  "没能放进剪贴板。请换 Chrome 或 Edge 再截": "Could not copy. Try Chrome or Edge",
  "没能放进剪贴板。先点一下 Comfy 页面再截": "Could not copy. Click the Comfy page first",
  "没能放进剪贴板。点地址栏右侧允许「剪贴板」，或先点一下页面再截": "Could not copy. Allow Clipboard in the address bar, or click the page first",
  "没能放进剪贴板：{raw}": "Could not copy: {raw}",
  "没能放进剪贴板。先点一下页面再截": "Could not copy. Click the page first",
  "请给本机 ComfyUI 开 HTTPS。我现在用 http://{host} 打开（局域网 IP，不是 127.0.0.1）。": "Please enable HTTPS for this ComfyUI. I am on http://{host} (LAN IP, not 127.0.0.1).",
  "浏览器只允许 127.0.0.1 或 https 写剪贴板，浏览里截图因此失败。别的设备也要用这个地址，所以不要只让我改用 127.0.0.1。": "Browsers only allow clipboard writes from 127.0.0.1 or https, so browse screenshots fail. Other devices need this address too — do not only switch me to 127.0.0.1.",
  "自签证书即可，放到这个 Comfy 环境目录的 tls/（不要进 git）。启动参数加 --tls-keyfile 和 --tls-certfile，写进真正启动 main.py 的 bat 或 env.json extra_args。": "A self-signed cert is enough. Put it in this env's tls/ (do not commit). Add --tls-keyfile and --tls-certfile to the bat or env.json extra_args that starts main.py.",
  "不要改端口（{port}），不要拿掉 --listen。改完关掉 Python 再开，用 https://{host} 打开（自签警告点「继续访问」）。只改启动配置，不要改业务代码。": "Keep port {port} and --listen. Restart Python, open https://{host} (accept the self-signed warning). Change launch config only.",
  "缺 filename": "Missing filename",
  "路径越界": "Path escapes the root",
  "JSON 对象": "Expected a JSON object",
  "只能删文件，文件夹请在资源管理器里处理": "Only files can be deleted; handle folders in the file manager",
  "非法目录名": "Invalid folder name",
  "语言会立刻作用在浏览窗口。自动＝跟 Comfy 设置里的界面语言。": "Language applies to this browse window immediately. Auto follows Comfy's UI language.",
  "已重新扫描 · {n} 个文件": "Rescanned · {n} files",
  "已重新检测。切到「局部」才能看到框": "Re-detected. Switch to Local to see boxes",
  "{n} 张": "{n}",
  "这段不是从采样器那条线上拿的，是从流里的显示节点捞的 —— 反推类流会把现场生成的词只留在显示节点里。内容多半就是这次用的词，但位置证明不了，照抄前自己扫一眼。": "This was taken from a display node, not the sampler line. Reverse-prompt graphs often leave the live words only there. It is probably what was used — skim it before copying.",
};

const regionMem = new Map();          // `${root}|${path}` → {boxes}|{reason}
const loadCensorMode = () => {
  const v = loadStr(CENSOR_KEY);
  if (v === "off" || v === "full" || v === "local") return v;
  return loadStr("mediabrowser.blur") === "1" ? "full" : "off";
};
const CENSOR_CONCUR_KEY = "mediabrowser.censorConcur";
const CENSOR_CONCUR_MIN = 1;
const CENSOR_CONCUR_MAX = 4;
const CENSOR_CONCUR_DEFAULT = 2;
const censorConcur = () => {
  const n = parseInt(loadStr(CENSOR_CONCUR_KEY, String(CENSOR_CONCUR_DEFAULT)), 10);
  return Number.isFinite(n)
    ? Math.min(CENSOR_CONCUR_MAX, Math.max(CENSOR_CONCUR_MIN, n))
    : CENSOR_CONCUR_DEFAULT;
};
const censorThr = () => {
  const n = parseFloat(loadStr(CENSOR_THR_KEY, "0.35"));
  return Number.isFinite(n) ? Math.min(0.95, Math.max(0.05, n)) : 0.35;
};
const censorCover = () => {
  const n = parseFloat(loadStr(CENSOR_COVER_KEY, "0.75"));
  return Number.isFinite(n) ? Math.min(1.2, Math.max(0.45, n)) : 0.75;
};
const censorBlur = () => {
  const n = parseInt(loadStr(CENSOR_BLUR_KEY, "14"), 10);
  return Number.isFinite(n) ? Math.min(28, Math.max(6, n)) : 14;
};
const applyCensorBlurCss = () => {
  const px = censorBlur() + "px";
  document.querySelectorAll(".mb-box, .mb-play").forEach((el) => {
    el.style.setProperty("--mb-censor-blur", px);
  });
};
const shrinkBox = (box, cover) => {
  if (cover >= 0.999) return box;
  const w = box.w * cover, h = box.h * cover;
  return { ...box, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
};
// rule 省略时用全局设置；传了就是某一张的单张覆盖（见 censorRuleFor）
const filterClientBoxes = (boxes, rule) => {
  const thr = rule ? rule.thr : censorThr();
  const labs = rule ? rule.labels : censorLabels();
  return (boxes || []).filter((b) => b.score >= thr && labs.has(b.label));
};
const visibleBoxes = (boxes, rule) =>
  filterClientBoxes(boxes, rule).map((b) => shrinkBox(b, coverFor(b.label, rule)));
const regionKey = (root, path) => `${root}|${path}`;
const mapBoxToEl = (box, imgW, imgH, elW, elH, contain) => {
  const scale = contain ? Math.min(elW / imgW, elH / imgH) : Math.max(elW / imgW, elH / imgH);
  const dw = imgW * scale, dh = imgH * scale;
  const ox = (elW - dw) / 2, oy = (elH - dh) / 2;
  return { x: box.x * dw + ox, y: box.y * dh + oy, w: box.w * dw, h: box.h * dh };
};
const paintCensorOverlay = (cell, boxes, dim, contain, rule) => {
  cell.querySelector(".mb-censor-layer")?.remove();
  const vis = visibleBoxes(boxes, rule);
  if (!vis.length || !cell.clientWidth) return;
  const layer = document.createElement("div");
  layer.className = "mb-censor-layer";
  // 这一张单独设过糊度就盖在这一层上；没设就继承 .mb-box / .mb-play 上的全局值
  if (rule && rule.blur != null) layer.style.setProperty("--mb-censor-blur", rule.blur + "px");
  const elW = cell.clientWidth, elH = cell.clientHeight;
  const imgW = dim?.[0] || elW, imgH = dim?.[1] || elH;
  for (const b of vis) {
    const m = mapBoxToEl(b, imgW, imgH, elW, elH, contain);
    if (m.w < 2 || m.h < 2) continue;
    const d = document.createElement("div");
    d.className = "mb-censor-box";
    d.style.cssText = `left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px`;
    layer.appendChild(d);
  }
  cell.appendChild(layer);
};
const attachPeekBtn = (el) => {
  if (el.querySelector(".mb-peek")) return;
  const off = () => t("临时看一眼（再点一下糊回去）。只影响眼前这一次，不改任何设置");
  const pk = mbElButton("mb-peek");
  setIco(pk, "lucide--eye");
  pk.title = off();
  pk.onclick = (ev) => {
    ev.stopPropagation();
    const on = el.classList.toggle("peek");
    pk.title = on ? t("糊回去") : off();
    setIco(pk, on ? "lucide--eye-off" : "lucide--eye");
  };
  el.appendChild(pk);
};
const confirmTrash = (filename, count) => new Promise((resolve) => {
  document.querySelector(".mb-confirm")?.remove();
  const ov = document.createElement("div");
  ov.className = "mb-confirm";
  const n = Number(count) > 1 ? Number(count) : 1;
  const short = String(filename).split("/").pop();
  const body = n > 1
    ? `${t("确定把选中的 {n} 个文件移到系统回收站？", { n })}<br>` +
      `${escHtml(t("文件会从当前目录消失，可以在回收站还原。浏览里没有撤销。"))}`
    : `${t("确定把 {name} 移到系统回收站？", { name: `<span class="fn">${escHtml(short)}</span>` })}<br>` +
      `${escHtml(t("文件会从当前目录消失，可以在回收站还原。浏览里没有撤销。"))}`;
  ov.innerHTML =
    `<div class="card" role="dialog" aria-modal="true">` +
      `<h4>${escHtml(n > 1 ? t("把选中的 {n} 项移到回收站？", { n }) : t("移到回收站？"))}</h4>` +
      `<p>${body}</p>` +
      `<div class="acts">` +
        `<button type="button" class="no">${escHtml(t("取消"))}</button>` +
        `<button type="button" class="go">${escHtml(t("移到回收站"))}</button>` +
      `</div>` +
    `</div>`;
  const done = (ok) => {
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
    resolve(ok);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    done(false);
  };
  ov.querySelector(".no").onclick = () => done(false);
  ov.querySelector(".go").onclick = () => done(true);
  ov.onmousedown = (e) => { if (e.target === ov) done(false); };
  ov.querySelector(".card").onmousedown = (e) => e.stopPropagation();
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
  ov.querySelector(".no").focus();
});
const confirmAsk = (title, body) => new Promise((resolve) => {
  document.querySelector(".mb-confirm")?.remove();
  const ov = document.createElement("div");
  ov.className = "mb-confirm";
  ov.innerHTML =
    `<div class="card" role="dialog" aria-modal="true">` +
      `<h4>${escHtml(title)}</h4>` +
      `<p>${body}</p>` +
      `<div class="acts">` +
        `<button type="button" class="no">${escHtml(t("取消"))}</button>` +
        `<button type="button" class="go">${escHtml(t("确定"))}</button>` +
      `</div>` +
    `</div>`;
  const done = (ok) => {
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
    resolve(ok);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    done(false);
  };
  ov.querySelector(".no").onclick = () => done(false);
  ov.querySelector(".go").onclick = () => done(true);
  ov.onmousedown = (e) => { if (e.target === ov) done(false); };
  ov.querySelector(".card").onmousedown = (e) => e.stopPropagation();
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
  ov.querySelector(".no").focus();
});
const confirmPreload = (n, warn) => new Promise((resolve) => {
  document.querySelector(".mb-confirm")?.remove();
  const ov = document.createElement("div");
  ov.className = "mb-confirm";
  const extra = warn
    ? `<p class="note">${escHtml(t("当前有 {n} 张，可能要很久。张数太多时，先关掉「递归全部」、用搜索或类型筛小范围。", { n }))}</p>`
    : "";
  ov.innerHTML =
    `<div class="card wide" role="dialog" aria-modal="true">` +
      `<h4>${escHtml(t("预加载当前列表的原图？"))}</h4>` +
      `<p>${escHtml(t("会把当前筛选里的 {n} 张图片原文件读进浏览器缓存。之后点开大图通常直接出全图。视频和文件夹不拉。", { n }))}</p>` +
      `<p>${escHtml(t("窗口不锁：仍可滚动、筛选、看大图。磁盘和网会忙一会儿，同时只拉 2 张，避免把机器打满。再点这个按钮就取消。"))}</p>` +
      extra +
      `<div class="acts">` +
        `<button type="button" class="no">${escHtml(t("取消"))}</button>` +
        `<button type="button" class="do">${escHtml(t("开始预加载"))}</button>` +
      `</div>` +
    `</div>`;
  const done = (ok) => {
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
    resolve(ok);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    done(false);
  };
  ov.querySelector(".no").onclick = () => done(false);
  ov.querySelector(".do").onclick = () => done(true);
  ov.onmousedown = (e) => { if (e.target === ov) done(false); };
  ov.querySelector(".card").onmousedown = (e) => e.stopPropagation();
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
  ov.querySelector(".no").focus();
});
const staleBackend = (status, name) => {
  // 404：路径完全没有。405：静态站收了这条路径但只允许 GET ——
  // 两种都是「现在这个 Python 启动时还没有这条 POST 路由」。
  if (status === 404 || status === 405) {
    return t("{name}接口是 {status}：必须关掉 Comfy 的 Python 窗口再启动，只刷新网页不够", { name: t(name), status });
  }
  return "";
};
const postTrash = async (root, path) => {
  const r = await fetch("/mediabrowser/trash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: root, filename: path }),
  });
  const j = await r.json().catch(() => ({}));
  const stale = !j.error && staleBackend(r.status, "删除");
  if (stale) throw new Error(stale);
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
const forgetPath = (folder, path) => {
  blurMarks(folder);
  if (blurCache?.[folder]) {
    blurCache[folder] = blurCache[folder].filter((p) => p !== path);
    save(BLUR_KEY, blurCache);
  }
  skipMarks(folder);
  if (skipCache?.[folder]) {
    skipCache[folder] = skipCache[folder].filter((p) => p !== path);
    save(SKIP_KEY, skipCache);
  }
  favCache ??= readFav();
  if (favCache[folder]) {
    favCache[folder] = favCache[folder].filter((p) => p !== path);
    save(FAV_KEY, favCache);
  }
  try {
    const all = readRecent();
    if (all[folder]) {
      all[folder] = all[folder].filter((p) => p !== path);
      save(RECENT_KEY, all);
    }
  } catch { /* 最近列表不是关键 */ }
  regionMem.delete(regionKey(folder, path));
};
const attachRedoBtn = (el, fn) => {
  if (el.querySelector(".mb-redo")) return;
  const b = mbElButton("mb-redo");
  b.innerHTML = mbScanIco();
  b.title = t("重新检测这一张：丢掉旧框，只打这一张，不影响别的");
  b.onclick = (ev) => { ev.stopPropagation(); fn(); };
  el.appendChild(b);
};
const detachRedoBtn = (el) => el?.querySelector(".mb-redo")?.remove();
const skipTitleOf = (on) => on
  ? t("已跳过河蟹。点一下恢复；点重新检测仍会打这一张")
  : t("跳过河蟹：这一张不跑局部检测");
const syncSkipFace = (btn, on) => {
  if (!btn) return;
  setIco(btn, "lucide--ban");
  btn.classList.toggle("on", on);
  btn.title = skipTitleOf(on);
};
const attachSkipBtn = (el, on, fn) => {
  let b = el.querySelector(".mb-skip");
  if (!b) {
    b = mbElButton("mb-skip");
    b.onclick = (ev) => { ev.stopPropagation(); fn(b); };
    el.appendChild(b);
  }
  syncSkipFace(b, on);
  return b;
};
const canvasToBlob = (canvas) => new Promise((res, rej) => {
  canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png");
});
function fitFixedPop(pw, ph, ar, vw, vh, gap) {
  gap = gap == null ? 8 : gap;
  const pad = 8;
  pw = Math.min(pw, Math.max(16, vw - pad * 2));
  ph = Math.min(ph, Math.max(16, vh - pad * 2));
  const below = vh - pad - ar.bottom;
  const above = ar.top - pad;
  const placeAbove = below < ph && above >= below;
  let top = placeAbove ? ar.top - ph - gap : ar.bottom + gap;
  let left = ar.left;
  if (left + pw > vw - pad) left = ar.right - pw;
  if (left < pad) left = pad;
  if (left + pw > vw - pad) left = vw - pad - pw;
  top = Math.max(pad, Math.min(vh - ph - pad, top));
  left = Math.max(pad, Math.min(vw - pw - pad, left));
  return { left, top };
}
// 把浮层摆在**避开某个矩形**的位置（右→左→下→上，第一个放得下的赢）。
// 用途：右键一张图调它的遮蔽时，浮层不能压住那张图 —— 否则调完看不见效果，
// 得先关掉浮层才知道调对没有，来回好几趟。
// 跟 fitFixedPop 一样是纯函数，好脱开 DOM 测边界情况。
function placeAsidePop(pw, ph, avoid, vw, vh, gap) {
  gap = gap == null ? 10 : gap;
  const pad = 8;
  pw = Math.min(pw, Math.max(16, vw - pad * 2));
  ph = Math.min(ph, Math.max(16, vh - pad * 2));
  const clampT = (v) => Math.max(pad, Math.min(vh - ph - pad, v));
  const clampL = (v) => Math.max(pad, Math.min(vw - pw - pad, v));
  const cands = [
    { left: avoid.right + gap, top: clampT(avoid.top) },        // 右
    { left: avoid.left - gap - pw, top: clampT(avoid.top) },    // 左
    { left: clampL(avoid.left), top: avoid.bottom + gap },      // 下
    { left: clampL(avoid.left), top: avoid.top - gap - ph },    // 上
  ];
  const fits = (c) => c.left >= pad && c.left + pw <= vw - pad
                   && c.top >= pad && c.top + ph <= vh - pad;
  for (const c of cands) if (fits(c)) return { left: c.left, top: c.top };
  // 四边都放不下（浮层太大或图靠边）：夹进视口，挑跟目标重叠最少的那个
  const overlap = (c) => {
    const l = clampL(c.left), tp = clampT(c.top);
    const ox = Math.max(0, Math.min(l + pw, avoid.right) - Math.max(l, avoid.left));
    const oy = Math.max(0, Math.min(tp + ph, avoid.bottom) - Math.max(tp, avoid.top));
    return ox * oy;
  };
  const best = cands.reduce((a, b) => (overlap(b) < overlap(a) ? b : a));
  return { left: clampL(best.left), top: clampT(best.top) };
}
const placePop = (el, anchor) => {
  if (!el || !anchor || !anchor.getBoundingClientRect) return;
  const ar = anchor.getBoundingClientRect();
  const pos = fitFixedPop(el.offsetWidth, el.offsetHeight, ar, window.innerWidth, window.innerHeight);
  el.style.left = pos.left + "px";
  el.style.top = pos.top + "px";
};
const notify = (msg) => {
  document.querySelectorAll(".mb-toast").forEach((e) => e.remove());
  const t = document.createElement("div");
  t.className = "mb-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), msg.length > 28 ? 4500 : 2400);
};
const isLoopbackHost = (h = location.hostname) =>
  h === "127.0.0.1" || h === "localhost" || h === "[::1]";
const clipInsecure = () =>
  !window.isSecureContext || (location.protocol === "http:" && !isLoopbackHost());
const localComfyUrl = () => {
  const port = location.port || (location.protocol === "https:" ? "443" : "80");
  const proto = location.protocol === "https:" ? "https:" : "http:";
  // 只开根地址。hash 是这边源的工作流 ID，127.0.0.1 是另一个源，带过去对不上、页面会空。
  return `${proto}//127.0.0.1:${port}/`;
};
const copyViaExec = (text) => {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
};
const copyTextReliable = async (text) => {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 局域网 http 会进这里，改走旧接口 */ }
  }
  return copyViaExec(text);
};
const httpsFixPrompt = () => {
  const host = location.host;
  const port = location.port || "8188";
  return [
    t("请给本机 ComfyUI 开 HTTPS。我现在用 http://{host} 打开（局域网 IP，不是 127.0.0.1）。", { host }),
    t("浏览器只允许 127.0.0.1 或 https 写剪贴板，浏览里截图因此失败。别的设备也要用这个地址，所以不要只让我改用 127.0.0.1。"),
    t("自签证书即可，放到这个 Comfy 环境目录的 tls/（不要进 git）。启动参数加 --tls-keyfile 和 --tls-certfile，写进真正启动 main.py 的 bat 或 env.json extra_args。"),
    t("不要改端口（{port}），不要拿掉 --listen。改完关掉 Python 再开，用 https://{host} 打开（自签警告点「继续访问」）。只改启动配置，不要改业务代码。", { port, host }),
  ].join("\n");
};
const showClipHelp = () => {
  document.querySelector(".mb-cliphelp")?.remove();
  const ov = document.createElement("div");
  ov.className = "mb-confirm mb-cliphelp";
  const host = escHtml(location.host);
  ov.innerHTML =
    `<div class="card wide" role="dialog" aria-modal="true">` +
      `<h4>${escHtml(t("没能放进剪贴板"))}</h4>` +
      `<p>${t("当前地址是 {host}。浏览器只允许本机 127.0.0.1 或 https 写剪贴板。", { host: `<span class="fn">${host}</span>` })}</p>` +
      `<ol>` +
        `<li>${t("这台电脑：点「复制本机地址」，新建标签粘到地址栏。从这页直接跳 127.0.0.1 会被浏览器拦（报「请求遭到拒绝」），自己粘贴就没事。")}</li>` +
        `<li>${escHtml(t("别的设备 / 必须用这个 IP：点「复制提示词」，发给你的 AI 开 HTTPS。"))}</li>` +
      `</ol>` +
      `<p class="note">${escHtml(t("本机地址："))}<code class="local-url">${escHtml(localComfyUrl())}</code></p>` +
      `<textarea class="prompt" readonly></textarea>` +
      `<div class="acts">` +
        `<button type="button" class="no">${escHtml(t("关闭"))}</button>` +
        `<button type="button" class="copy">${escHtml(t("复制提示词"))}</button>` +
        `<button type="button" class="do">${escHtml(t("复制本机地址"))}</button>` +
      `</div>` +
    `</div>`;
  const note = ov.querySelector(".note");
  const ta = ov.querySelector(".prompt");
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  ov.querySelector(".no").onclick = close;
  ov.querySelector(".copy").onclick = async (ev) => {
    ev.stopPropagation();
    const text = httpsFixPrompt();
    ta.value = text;
    const ok = await copyTextReliable(text);
    if (ok) {
      ov.querySelector(".copy").textContent = t("已复制");
      setTimeout(() => { ov.querySelector(".copy").textContent = t("复制提示词"); }, 1600);
      return;
    }
    ta.classList.add("on");
    ta.focus();
    ta.select();
    note.textContent = t("这一页也拦了自动复制。下面框里是提示词，请手动全选复制。");
  };
  ov.querySelector(".do").onclick = async (ev) => {
    ev.stopPropagation();
    const url = localComfyUrl();
    ta.value = url;
    const ok = await copyTextReliable(url);
    if (ok) {
      ov.querySelector(".do").textContent = t("已复制");
      note.innerHTML = t("已复制 {url}。新建标签粘到地址栏打开，再截一次。", { url: `<code>${escHtml(url)}</code>` });
      setTimeout(() => { ov.querySelector(".do").textContent = t("复制本机地址"); }, 1600);
      return;
    }
    ta.classList.add("on");
    ta.focus();
    ta.select();
    note.textContent = t("自动复制被拦了。下面框里是本机地址，请全选复制，新建标签粘贴。");
  };
  ov.onmousedown = (e) => { if (e.target === ov) close(); };
  ov.querySelector(".card").onmousedown = (e) => e.stopPropagation();
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
  ov.querySelector(".do").focus();
};
const clipWhy = (e) => {
  const raw = String(e?.message || e || "");
  if (clipInsecure()) {
    return t("没能放进剪贴板。当前地址是 {host}，浏览器只允许本机 127.0.0.1 或 https 写剪贴板", { host: location.host });
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem !== "function") {
    return t("没能放进剪贴板。请换 Chrome 或 Edge 再截");
  }
  if (/not focused|document is not focused/i.test(raw)) {
    return t("没能放进剪贴板。先点一下 Comfy 页面再截");
  }
  if (/denied|notallowed|permission/i.test(raw)) {
    return t("没能放进剪贴板。点地址栏右侧允许「剪贴板」，或先点一下页面再截");
  }
  return raw ? t("没能放进剪贴板：{raw}", { raw }) : t("没能放进剪贴板。先点一下页面再截");
};
// 必须在点击的同一拍调用 clipboard.write。先 await 再写，手势会过期被拒。
const writePng = async (blobPromise) => {
  if (!navigator.clipboard?.write || typeof ClipboardItem !== "function") {
    throw new Error(clipWhy(new Error("no api")));
  }
  const pending = Promise.resolve(blobPromise).then((blob) => {
    if (!blob) throw new Error(t("图没生成出来"));
    return blob.type === "image/png" ? blob : blob.slice(0, blob.size, "image/png");
  });
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pending })]);
  } catch (e) {
    try {
      const blob = await pending;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (e2) {
      throw new Error(clipWhy(e2));
    }
  }
};
const drawCover = (ctx, img, dx, dy, dw, dh) => {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) return;
  const scale = Math.max(dw / iw, dh / ih);
  const sw = dw / scale, sh = dh / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, dx, dy, dw, dh);
};
const blurPatch = (ctx, x, y, w, h, r) => {
  const sx = Math.max(0, Math.floor(x)), sy = Math.max(0, Math.floor(y));
  const sw = Math.max(1, Math.min(ctx.canvas.width - sx, Math.ceil(w)));
  const sh = Math.max(1, Math.min(ctx.canvas.height - sy, Math.ceil(h)));
  if (sw < 2 || sh < 2) return;
  const tmp = document.createElement("canvas");
  tmp.width = sw; tmp.height = sh;
  const t = tmp.getContext("2d");
  t.filter = `blur(${r || 16}px)`;
  t.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.drawImage(tmp, sx, sy);
};

// 常用目录由用户钉选，保持范围下拉的内容稳定。
const PIN_KEY = "mediabrowser.pinned";
let pinCache = null;
const pins = () => {
  if (!pinCache) {
    pinCache = loadJSON(PIN_KEY, {});
  }
  return pinCache;
};
const pinList = (root) => pins()[root] || [];
const isPinned = (root, cwd) => pinList(root).includes(cwd);
const togglePin = (root, cwd) => {
  const all = pins();
  const list = all[root] || [];
  const i = list.indexOf(cwd);
  if (i >= 0) list.splice(i, 1); else list.unshift(cwd);
  all[root] = list.slice(0, 12);           // 钉太多就失去意义了，留最近钉的 12 个
  save(PIN_KEY, all);
  return i < 0;
};

// ── 收藏：主动钉住的高频素材。跟「最近」分工明确 ──
//    最近 = 被动记录，会被新的挤掉；收藏 = 主动标记，只有你自己能取消。
// ── 节点适配表 ───────────────────────────────────────────────
// 节点适配决定资源能否回填；不兼容的资源仍可浏览。
// 路径兼容 Windows 与 POSIX 分隔符。
const SEP_BS = String.fromCharCode(92);
const baseName = (p) => {
  const t = String(p == null ? "" : p);
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf(SEP_BS));
  return i < 0 ? t : t.slice(i + 1);
};

// 格子与大图的动作共用 ACTION_ORDER，按能力过滤后保持相对顺序。
// 格子布局按最大动作集合估算，避免同屏条目采用不同的菜单形态。
const CELL_ACTION_IDS = ["pick", "view", "lock", "fav", "shot", "meta", "wf", "trash"];

const ACTION_ORDER = [
  "pick",    // 用这张（主动作，永远第一）
  "view",    // 看大图（只有格子有：大图里已经在看了）
  "peek",    // 临时看一眼（只有大图有）
  "lock",    // 锁住这张
  "skip",    // 跳过河蟹（只有大图有）
  "redo",    // 重新检测（只有大图有）
  "fav",     // 收藏
  "shot",    // 截进剪贴板
  "meta",    // 提示词和参数
  "wf",      // 打开工作流
  "trash",   // 移到回收站（破坏性，永远最后）
];

/* KIND_FILTER_HELPERS_BEGIN */
const KIND_IMG = /\.(png|jpe?g|webp|gif|bmp)$/i;
const KIND_VID = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;
const KIND_AUD = /\.(wav|mp3|flac|ogg|m4a)$/i;
const KIND_DEFS = [
  { id: "image", label: "图片", icon: "lucide--image", re: KIND_IMG },
  { id: "video", label: "视频", icon: "lucide--play", re: KIND_VID },
  { id: "audio", label: "音频", icon: "lucide--music", re: KIND_AUD },
];
const kindOf = (p) => KIND_DEFS.find((k) => k.re.test(p))?.id ?? "other";
const KIND_FILTER_DEFS = [...KIND_DEFS, {
  id: "other", label: "其它", icon: "lucide--scroll-text", re: null,
}];
const kindFilterModel = (paths, preferredKind, selectedKinds) => {
  const counts = new Map(KIND_FILTER_DEFS.map(({ id }) => [id, 0]));
  for (const path of paths) {
    const id = kindOf(path);
    counts.set(id, counts.get(id) + 1);
  }
  // 节点能接收的类型固定排在最前；目录刷新只改变计数，不改变按钮集合。
  return [...KIND_FILTER_DEFS]
    .sort((a, b) => (a.id === preferredKind ? -1 : b.id === preferredKind ? 1 : 0))
    .map((def) => {
      const count = counts.get(def.id);
      return {
        ...def,
        count,
        enabled: count > 0,
        active: count > 0 && selectedKinds.has(def.id),
      };
    });
};
/* KIND_FILTER_HELPERS_END */

// 能不能遮：有画面才谈得上。音频、.md/.json 这些没有画面，
// 锁 / 跳过 / 重新检测对它们没有意义 —— 显示出来只会让人以为点了没反应。
// **宫格底栏和查看器底栏必须共用这一条。** 各写一遍就会漂：
// 之前就出过「查看器里锁得上，回到宫格找不到钮解锁」。
const canCensor = (p) => KIND_VID.test(p) || KIND_IMG.test(p);

const NODE_SPECS = {
  LoadImage:                        { widget: "image", root: "input",  accept: KIND_IMG, kind: "image", label: "图片" },
  LoadImageMask:                    { widget: "image", root: "input",  accept: KIND_IMG, kind: "image", label: "图片" },
  "Load image with metadata [Crystools]": { widget: "image", root: "input", accept: KIND_IMG, kind: "image", label: "图片" },
  LoadImageOutput:                  { widget: "image", root: "output", accept: KIND_IMG, kind: "image", label: "图片" },
  VHS_LoadVideo:                    { widget: "video", root: "input",  accept: KIND_VID, kind: "video", label: "视频" },
  VHS_LoadVideoFFmpeg:              { widget: "video", root: "input",  accept: KIND_VID, kind: "video", label: "视频" },
  LoadVideoAndSegment_:             { widget: "video", root: "input",  accept: KIND_VID, kind: "video", label: "视频" },
  VHS_LoadAudioUpload:              { widget: "audio", root: "input",  accept: KIND_AUD, kind: "audio", label: "音频" },
  LoadImageGoohai:                  { widget: "image", root: "input",  accept: KIND_IMG, kind: "image", label: "图片" },
  "LoadImage //Inspire":            { widget: "image", root: "input",  accept: KIND_IMG, kind: "image", label: "图片" },
};

// ⚠️ 值必须带来源标注，否则跑不了。
// ComfyUI 的 folder_paths.get_annotated_filepath() 没有 [output]/[temp] 后缀时
// 一律回退到 input 目录找文件 —— 从 output 选的图填裸路径，入队直接被判
// "Invalid image file"（2026-08-30 实测 400）。LoadImageOutput 和 VHS 都走这套。
// 与后端 annotate_widget_value 必须逐字同语义。
const annotate = (path, root) => (root === "input" ? path : `${path} [${root}]`);
const stripAnn = (v) => String(v || "").replace(/\s*\[(output|input|temp)\]\s*$/, "");

// 单张锁：这张以后打开也全幅糊。跟顶栏「全幅」无关——全幅关了，锁住的仍糊。
const BLUR_KEY = "mediabrowser.blurmark";
let blurCache = null;
const blurMarks = (folder) => {
  if (!blurCache) {
    blurCache = loadJSON(BLUR_KEY, {});
  }
  return new Set(blurCache[folder] || []);
};
const toggleBlurMark = (folder, path) => {
  blurMarks(folder);
  const list = blurCache[folder] || [];
  const i = list.indexOf(path);
  if (i >= 0) list.splice(i, 1); else list.unshift(path);
  blurCache[folder] = list;
  save(BLUR_KEY, blurCache);
  return i < 0;
};

// 跳过河蟹：这张不跑局部检测。视口批量会略过；点 ⟳ 仍打这一张。
const SKIP_KEY = "mediabrowser.skipdetect";
let skipCache = null;
const skipMarks = (folder) => {
  if (!skipCache) skipCache = loadJSON(SKIP_KEY, {});
  return new Set(skipCache[folder] || []);
};
const toggleSkipDetect = (folder, path) => {
  skipMarks(folder);
  const list = skipCache[folder] || [];
  const i = list.indexOf(path);
  if (i >= 0) list.splice(i, 1); else list.unshift(path);
  skipCache[folder] = list;
  save(SKIP_KEY, skipCache);
  return i < 0;
};

const FAV_KEY = "mediabrowser.fav";
const readFav = () => {
  return loadJSON(FAV_KEY, {});
};
let favCache = null;
const favSet = (folder) => {
  favCache ??= readFav();
  return new Set(favCache[folder] || []);
};
const isFavIn = (folder, path) => favSet(folder).has(path);
const toggleFavIn = (folder, path) => {
  favCache ??= readFav();
  const list = favCache[folder] || [];
  const i = list.indexOf(path);
  if (i >= 0) list.splice(i, 1); else list.unshift(path);
  favCache[folder] = list;
  save(FAV_KEY, favCache);
  return i < 0;
};
const setFavsIn = (folder, paths, want) => {
  favCache ??= readFav();
  const targets = new Set(paths);
  const current = favCache[folder] || [];
  // 批量操作必须先在内存里合并，再整体落盘一次；逐项 save 会反复序列化完整收藏表，
  // 上千张时会把主线程长时间卡住。新增项放前面，并保持界面选区的顺序。
  if (want) {
    const seen = new Set(current);
    const added = [];
    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      added.push(p);
    }
    favCache[folder] = [...added, ...current];
  } else {
    favCache[folder] = current.filter((p) => !targets.has(p));
  }
  save(FAV_KEY, favCache);
};

const RECENT_KEY = "mediabrowser.recent";
const RECENT_MAX = 40;
const readRecent = () => {
  return loadJSON(RECENT_KEY, {});
};
const pushRecent = (folder, path) => {
  try {
    const all = readRecent();
    const list = (all[folder] || []).filter((x) => x !== path);
    list.unshift(path);
    all[folder] = list.slice(0, RECENT_MAX);
    save(RECENT_KEY, all);
  } catch (e) { /* 隐私模式/存储满 —— 最近列表不是关键功能，静默降级 */ }
};

const THUMB_PX_KEY = "mediabrowser.thumbPx";
// 下拉与预设共用尺寸阶梯，并与后端 THUMB_SIZES 保持一致。
const THUMB_PX_LADDER = [256, 384, 512, 640, 768, 1024, 1536, 2048];
const THUMB_NATIVE_PX = 0;      // 原像素：不缩放，只重编码成 webp
// 「每档单独设」的下拉选项。
const THUMB_PX_VALUES = [
  ...THUMB_PX_LADDER.map((v) => [String(v), String(v)]),
  [String(THUMB_NATIVE_PX), "原像素"],
];
// 预设只保存原始尺寸，显示标签在渲染时用占位符翻译。
const THUMB_PRESETS = {
  light: { 6: 384, 5: 512, 4: 640, 3: 768, 2: 1024 },
  balanced: { 6: 512, 5: 640, 4: 768, 3: 1024, 2: 1536 },
  sharp: { 6: 640, 5: 768, 4: 1024, 3: 1536, 2: 2048 },
  max: { 6: 1024, 5: 1536, 4: 2048, 3: 2048, 2: THUMB_NATIVE_PX },
};
// 预设的显示名。
const THUMB_PRESET_LABEL = {
  light: "省流量（加载最快）",
  balanced: "均衡（推荐）",
  sharp: "清晰（大格子更锐）",
  max: "最高（大格子用原像素，很占带宽）",
};
const thumbPresetLabel = (k) => t(THUMB_PRESET_LABEL[k] || k);

// 每列档位对应一个请求长边，不额外乘 DPR；设置提示按格子宽 × DPR 提供参考。
const THUMB_PER_CELL_KEY = "mediabrowser.thumbPerCell";
// 预设负责填充逐档表，表始终可见并允许继续自定义。
const thumbPerCell = () => {
  const saved = loadJSON(THUMB_PER_CELL_KEY, null);
  // 没配过时的起点：旧版本存的是模式名（THUMB_PX_KEY），认得出就拿那套预设，
  // 老用户升上来档位不该被悄悄换掉；认不出就用均衡。
  const out = { ...(THUMB_PRESETS[loadStr(THUMB_PX_KEY, "balanced")] || THUMB_PRESETS.balanced) };
  if (saved && typeof saved === "object") {
    for (const k of Object.keys(out)) {
      const v = +saved[k];
      if (Number.isFinite(v) && THUMB_PX_VALUES.some(([o]) => +o === v)) out[k] = v;
    }
  }
  return out;
};
// 当前这张表正好等于哪套预设？都不等于就是「自定义」（返回空串）。
// 下拉靠它回显 —— 手动把某一档改回去、正好凑成另一套预设时，下拉也该跟着变。
const thumbPresetOf = (tbl) => Object.keys(THUMB_PRESETS).find((k) =>
  Object.keys(THUMB_PRESETS[k]).every((n) => THUMB_PRESETS[k][n] === tbl[n])) || "";
// 要请求多大的缩略图：查表，配多少就请求多少，不做隐式换算 ——
// 设置里看到的就是实际请求的。
const wantThumbPx = (cols) => {
  const px = thumbPerCell()[cols];
  return px === undefined ? 768 : px;      // 0 是有效的原像素档
};

// 点一下图片是「看大图」还是「直接选中」。
// 默认看大图 —— 两件事的代价差着量级：选中会**关掉窗口、改掉节点的值**，
// 误点一下要重新打开、重新找回原来那个位置；看大图按 Esc 就退，什么都没变。
// 便宜且可逆的动作配最容易触发的手势，这是取舍的依据，不是口味。
// 纯当选片器用的人可以在设置里换回「直接选中」。
const CLICK_KEY = "mediabrowser.clickAction";
const clickOpensViewer = () => loadStr(CLICK_KEY, "view") !== "pick";

const PREF_KEYS = [
  REC_KEY, KINDS_KEY, SORT_KEY, PLACE_KEY, CENSOR_KEY, CENSOR_WAIT_KEY,
  CENSOR_THR_KEY, CENSOR_COVER_KEY, CENSOR_BLUR_KEY, CENSOR_CONCUR_KEY,
  "mediabrowser.size", "mediabrowser.masonry", "mediabrowser.boxsize", "mediabrowser.touch",
  "mediabrowser.blur", "mediabrowser.fab.pos", THUMB_PX_KEY, MB_LANG_KEY,
  CENSOR_LABELS_KEY, CENSOR_BREAST_COVER_KEY, THUMB_PER_CELL_KEY, CLICK_KEY,
];
// 按**路径**存的单张标记。清「标记」时一起清。
// CENSOR_ONE_KEY（单张遮蔽覆盖）跟 BLUR/SKIP 同类：一张图一条、只增不减，
// 漏登记的话「清空标记」清不掉它，而且用户完全看不出残留在哪。
const MARK_KEYS = [FAV_KEY, RECENT_KEY, PIN_KEY, BLUR_KEY, SKIP_KEY,
                   CENSOR_ONE_KEY, CENSOR_TUNE_KEY];
const dropKeys = (keys) => {
  for (const k of keys) {
    try { localStorage.removeItem(k); } catch { /* 清不掉也不挡操作 */ }
  }
};
const forgetClientMarks = () => {
  censorTuneCache = null;
  favCache = null;
  pinCache = null;
  blurCache = null;
  skipCache = null;
  censorOneCache = null;      // 漏了它的话，清完标记本次会话仍按旧的单张覆盖画
  memos.clear();
};

// 上一次列出来的结果，按「根 | 子目录 | 递归 | 排序」各留一份。
// 为什么要：一个 6000 文件的目录，列表是 1.5MB，重开一次窗口光等它就要 0.3~2s ——
// 而绝大多数时候目录根本没变。先拿旧的画出来（秒进），同时在后台重取，
// 回来发现不一样再重画。「先画已有的，新的到了再更新」。
// 只留最近几份：1.5MB × N 堆在内存里不合适。
const LIST_MEM = new Map();
const LIST_MEM_MAX = 4;
const listKey = (folder, sub, recursive, sort) =>
  `${folder}|${sub || ""}|${recursive ? 1 : 0}|${sort || ""}`;
const listRemember = (k, got) => {
  LIST_MEM.delete(k);
  LIST_MEM.set(k, got);                       // 重新塞到末尾 = 最近用过
  while (LIST_MEM.size > LIST_MEM_MAX) LIST_MEM.delete(LIST_MEM.keys().next().value);
};
// 后台核对必须覆盖中间条目和元数据；同数量改名、原地覆盖也会改变显示。
const listSame = (a, b) => {
  if (!a || !b || a.files.length !== b.files.length || a.dirs.length !== b.dirs.length) return false;
  if (!a.files.every((f, i) => f === b.files[i])) return false;
  if (!a.dirs.every((d, i) => d.name === b.dirs[i].name && d.count === b.dirs[i].count && d.t === b.dirs[i].t)) return false;
  return ["times", "dims", "elapsed", "duration"].every((field) => {
    const left = a[field] || {}, right = b[field] || {};
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((k) =>
      Array.isArray(left[k]) ? Array.isArray(right[k]) && left[k].length === right[k].length
        && left[k].every((v, i) => v === right[k][i]) : left[k] === right[k]);
  });
};

async function listDir(folder, subfolder, recursive, sort, refresh, signal) {
  const p = new URLSearchParams({ type: folder, sort: sort || "time_desc" });
  if (subfolder) p.set("subfolder", subfolder);
  if (recursive) p.set("recursive", "1");
  if (refresh) p.set("refresh", "1");
  const r = await fetch(`/mediabrowser/list?${p}`, signal ? { signal } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return {
    dirs: j.dirs ?? [], files: j.files ?? [], dims: j.dims ?? {}, times: j.times ?? {},
    elapsed: j.elapsed ?? {}, duration: j.duration ?? {},
  };
}

// ── 把文件里内嵌的工作流开成一个新标签 ──
//    默认「新开」而不是「替换当前画布」：替换等于把正在做的东西冲掉，
//    而看别人的流本来就是并排比对的动作。
//    ComfyUI 1.5x 的 loadGraphData 自己就会新开一个标签，所以不用先建临时工作流
//    （那样会一次多出两个）。载完把标签改成源文件名，比一串「Unsaved Workflow (3)」好认。
async function openWorkflowFrom(path, root) {
  const r = await fetch(`/mediabrowser/workflow?filename=${encodeURIComponent(path)}&type=${encodeURIComponent(root)}`);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);

  const store = app.extensionManager?._p?._s?.get?.("workflow");
  const before = store?.openWorkflows?.length ?? 0;

  // 老版本没有标签概念，loadGraphData 会直接冲掉当前画布 —— 先问一句
  if (!store && !confirm(
      t("这个 ComfyUI 版本没有工作流标签页，载入会替换当前画布。") + "\n" +
      t("当前画布上没保存的改动会丢失。要继续吗？"))) {
    return { cancelled: true };
  }

  // kind=workflow 是画布图（带 nodes/links，能还原布局）；
  // kind=prompt 是 API 图（扁平字典，没有坐标）—— 两者载入函数不同，
  // 用错会得到一个空画布。API 图载进来会自动排版，照样能跑。
  const base = path.split("/").pop();
  if (j.kind === "prompt") await app.loadApiJson(j.graph, base);
  else await app.loadGraphData(j.graph);

  // 标签改成源文件名（改不了就算了，不值得为这个报错）
  try {
    const act = store?.activeWorkflow;
    if (act && store.renameWorkflow) {
      await store.renameWorkflow(act, base.replace(/\.[^.]+$/, "") + ".json");
    }
  } catch { /* 改名失败无所谓，图已经载进去了 */ }

  return { newTab: (store?.openWorkflows?.length ?? 0) > before, kind: j.kind };
}

// ── 查看：图片和视频共用一个壳，可以左右翻 ──
//    图标也统一成 🔍：本来图片是 🔍、视频是 ▶，但对用户来说是同一个动作
//    （「让我看清楚这张到底是什么」），分成两个图标只会让人以为是两回事。
//    是图是视频，格子左上角的 ▶ 角标已经标了，不必在按钮上再说一遍。
//    翻页范围 = 当前宫格里筛完排完的那批（含被灰掉的），跟你眼睛看到的顺序一致。
// ── 大图查看 ──
// 格子里是缩略图；查看器要原文件。原 PNG 往往几十 MB，第一次打开慢是下载+解码，躲不掉。
// 能做的是：先垫上已经在缓存里的缩略图、当前这张完成后再预取邻居、翻页复用已解码的图。
const VIEW_ZOOM_MIN = 1;
const VIEW_ZOOM_MAX = 8;
const VIEW_ZOOM_STEP = 1.12;
const viewFileUrl = (path, root) => {
  const i = String(path || "").lastIndexOf("/");
  const sub = i < 0 ? "" : path.slice(0, i);
  const name = i < 0 ? path : path.slice(i + 1);
  return `/api/view?filename=${encodeURIComponent(name)}` +
         `&subfolder=${encodeURIComponent(sub)}&type=${encodeURIComponent(root)}`;
};
const viewIsStillImage = (path) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(path || "");
const viewNeighborImages = (list, idx, dir, count) => {
  const out = [];
  if (!list || !dir || count < 1) return out;
  for (let n = idx + dir; n >= 0 && n < list.length && out.length < count; n += dir) {
    if (viewIsStillImage(list[n])) out.push(n);
  }
  return out;
};
const viewPrefetchPlan = (list, idx, lastDir) => {
  const fwd = lastDir < 0 ? -1 : 1;
  const seen = new Set();
  const out = [];
  for (const n of [...viewNeighborImages(list, idx, fwd, 2),
                   ...viewNeighborImages(list, idx, -fwd, 1)]) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
};
const viewZoomAfterWheel = (scale, deltaY) => {
  const steps = Math.max(-4, Math.min(4, -deltaY / 100));
  const next = scale * Math.pow(VIEW_ZOOM_STEP, steps);
  return Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, next));
};
// cx/cy = 光标相对「当前画面中心」的像素。transform 是 translate 再 scale，原点在图中心。
const viewZoomTranslate = (tx, ty, scale, next, cx, cy) => {
  if (!(scale > 0)) return { tx: 0, ty: 0 };
  const k = next / scale;
  return { tx: tx + cx * (1 - k), ty: ty + cy * (1 - k) };
};
const viewCanPan = (scale) => scale > 1.02;
const viewClickCloses = (scale, panned) => !viewCanPan(scale) && !panned;
const viewOrigReady = (src) => /\/api\/view\?/.test(src || "");
const rememberDecoded = (map, url, im, cap) => {
  if (!map || !url || !im) return map;
  map.delete(url);
  map.set(url, im);
  const max = cap > 0 ? cap : 6;
  while (map.size > max) map.delete(map.keys().next().value);
  return map;
};
// 全量预加载：当前筛选里的静图原文件，走 /api/view（和大图同一条）。
// 只 2 路同时拉，不把解码结果堆在内存里；视频不拉。
const VIEW_PRELOAD_CONCUR = 2;
const VIEW_PRELOAD_WARN = 2000;
const viewPreloadPaths = (items) =>
  (items || []).filter((it) => it && it.type !== "dir" && viewIsStillImage(it.path))
    .map((it) => it.path);
const viewPreloadWorkers = (n) => {
  const t = n | 0;
  if (t <= 0) return 0;
  return Math.min(VIEW_PRELOAD_CONCUR, t);
};
const viewPreloadNeedsWarn = (n) => n >= VIEW_PRELOAD_WARN;
const viewPreloadSame = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const viewPreloadOutcome = ({ ok, fail, cancelled }) => {
  if (cancelled) return "cancel";
  if (fail > 0 && !(ok > 0)) return "fail";
  if (fail > 0) return "partial";
  return "ok";
};
const runViewPreload = async ({ paths, root, fetchFn, signal, onProgress }) => {
  const list = paths || [];
  let next = 0, ok = 0, fail = 0;
  const tick = () => onProgress && onProgress({ ok, fail, done: ok + fail, total: list.length });
  const worker = async () => {
    while (true) {
      if (signal && signal.aborted) return;
      const i = next++;
      if (i >= list.length) return;
      try {
        const r = await fetchFn(viewFileUrl(list[i], root), {
          signal,
          priority: "low",
          cache: "force-cache",
        });
        if (signal && signal.aborted) return;
        if (!r || !r.ok) {
          fail++;
          tick();
          continue;
        }
        await r.blob();
        if (signal && signal.aborted) return;
        ok++;
      } catch (e) {
        if ((signal && signal.aborted) || (e && e.name === "AbortError")) return;
        fail++;
      }
      tick();
    }
  };
  const n = viewPreloadWorkers(list.length);
  if (n) await Promise.all(Array.from({ length: n }, () => worker()));
  return { ok, fail, cancelled: !!(signal && signal.aborted), total: list.length };
};
// ── 大图查看结束 ──

function openViewer(list, startIdx, root, onPick, hooks = {}) {
  // hooks: { isFav, toggleFav, showMeta, getMode, setMode, isMarked, dimOf,
  //          shotOne, ensureLocal, closePicker, trashOne, toggleMark, toggleSkip,
  //          lockTitle }
  // 宫格状态（收藏表、根目录、遮蔽）在外层，这里只接闭包，不复制一份。
  let idx = startIdx;

  const lay = document.createElement("div");
  lay.className = "mb-play";
  lay.innerHTML =
    // ✕ 钉右上角，跟内容分开 —— 画幅占满时底部那排按钮可能被挤出视野，
    // 那时候如果只有底下一个关闭钮，就真出不去了
    `<button type="button" class="mb-x" title="${escHtml(t("关闭（Esc、点画面外，或者再点一下图片）"))}">${mbIco("lucide--x")}</button>` +
    `<button type="button" class="mb-nav prev" title="${escHtml(t("上一个（← 键）"))}">${mbIco("lucide--chevron-left")}</button>` +
    `<button type="button" class="mb-nav next" title="${escHtml(t("下一个（→ 键）"))}">${mbIco("lucide--chevron-right")}</button>` +
    `<div class="mb-stage" title="${escHtml(t("滚轮放大缩小。放大后拖动画面。未放大时点图片关掉"))}"></div>` +
    `<div class="bar">
       <span class="fn"></span>
       <span class="idx"></span>
       <span class="mb-seg mb-censor-seg">
         <button type="button" data-censor="off" title="${escHtml(CENSOR_TITLE.off)}">${escHtml(t("原图"))}</button>
         <button type="button" data-censor="full" title="${escHtml(CENSOR_TITLE.full)}">${escHtml(t("全幅"))}</button>
         <button type="button" data-censor="local" title="${escHtml(CENSOR_TITLE.local)}">${escHtml(t("局部"))}</button>
       </span>
       <!-- 顺序 = ACTION_ORDER，跟格子那边逐个对齐。改这里请连同 ACTION_ORDER 一起改。 -->
       <button type="button" class="pick">${mbIco("lucide--check")} ${escHtml(t("用这张"))}</button>
       <button type="button" class="act peek" title="${escHtml(t("临时看一眼（再点糊回去）。只影响这一次"))}">${mbIco("lucide--eye")}</button>
       <button type="button" class="act lock" title="${escHtml(t("锁上：这张以后打开也是糊的（只管这一张）"))}">${mbIco("lucide--lock-open")}</button>
       <button type="button" class="act skip" title="${escHtml(t("跳过河蟹：这一张不跑局部检测"))}">${mbIco("lucide--ban")}</button>
       <button type="button" class="act redo" title="${escHtml(t("重新检测这一张：丢掉旧框，只打这一张"))}">${mbScanIco()}</button>
       <button type="button" class="act tune" title="${escHtml(t("只调这一张的遮蔽：力度、部位、打码范围"))}">${mbIco("lucide--sliders-horizontal")}</button>
       <button type="button" class="act fav" title="${escHtml(t("收藏 / 取消收藏"))}">${mbIco("lucide--star")}</button>
       <button type="button" class="act shot-one" title="${escHtml(t("截这张进剪贴板（按当前遮蔽）。局域网 IP 下会提示改用 127.0.0.1 或 https"))}">${mbIco("lucide--camera")}</button>
       <button type="button" class="act meta" title="${escHtml(t("看提示词和参数，可一键复制"))}">${mbIco("lucide--info")}</button>
       <button type="button" class="act wf" title="${escHtml(t("在新标签打开这个文件里存的工作流"))}">${mbIco("lucide--workflow")}</button>
       <button type="button" class="act trash" title="${escHtml(t("移到回收站。会先问你一次；真的会从磁盘拿走"))}">${mbIco("lucide--trash-2")}</button>
       <button type="button" class="cls">${escHtml(t("关闭"))}</button>
     </div>`;
  document.body.appendChild(lay);
  applyCensorBlurCss();

  const stage = lay.querySelector(".mb-stage");
  const fnEl = lay.querySelector(".fn");
  const idxEl = lay.querySelector(".idx");
  let z = 1, tx = 0, ty = 0, panned = false, drag = null, lastDir = 1;
  const decoded = new Map();
  const applyZoom = () => {
    const t = (z === 1 && !tx && !ty) ? "none" : `translate(${tx}px, ${ty}px) scale(${z})`;
    for (const el of stage.querySelectorAll("img, .mb-censor-layer")) {
      el.style.transform = t;
      el.style.transformOrigin = "center center";
    }
    stage.classList.toggle("zoomed", viewCanPan(z));
    stage.classList.toggle("panning", !!drag);
  };
  const resetZoom = () => {
    z = 1; tx = 0; ty = 0; panned = false; drag = null;
    applyZoom();
  };
  const remember = (url, im) => rememberDecoded(decoded, url, im, 6);

  // 三个动作按钮：状态随翻页刷新（换了一个文件，收藏与否/有没有工作流都变了）
  const favBtnV = lay.querySelector(".fav");
  const metaBtnV = lay.querySelector(".meta");
  const wfBtnV = lay.querySelector(".wf");
  const syncActs = () => {
    const path = list[idx];
    const faved = hooks.isFav?.(path) ?? false;
    setIco(favBtnV, faved ? "ph--star-fill" : "lucide--star");
    favBtnV.classList.toggle("on", faved);
    favBtnV.style.display = hooks.toggleFav ? "" : "none";
    // 提示词/工作流只有 PNG 和视频存得下，jpg 上给了也是点开就报错
    const canMeta = /\.png$/i.test(path) || KIND_VID.test(path);
    metaBtnV.style.display = canMeta && hooks.showMeta ? "" : "none";
    wfBtnV.style.display = canMeta ? "" : "none";
    setIco(wfBtnV, "lucide--workflow");
    wfBtnV.disabled = false;
    // 有画面才谈得上遮：锁 / 跳过 / 重检三个钮的门槛跟宫格底栏保持一致，
    // 否则会出现「在这儿锁得上、回到宫格找不到钮解锁」。
    const canHexie = canCensor(path);
    const peekBtn = lay.querySelector(".act.peek");
    peekBtn.style.display = viewerCanPeek() ? "" : "none";
    const lockBtn = lay.querySelector(".lock");
    const locked = hooks.isMarked?.(path) ?? false;
    setIco(lockBtn, locked ? "lucide--lock" : "lucide--lock-open");
    lockBtn.classList.toggle("on", locked);
    lockBtn.title = hooks.lockTitle?.(locked) ?? (locked
      ? t("已锁：这张以后打开都是糊的。点一下解锁")
      : t("锁上：这张以后打开也是糊的（只管这一张）"));
    lockBtn.style.display = canHexie && hooks.toggleMark ? "" : "none";
    const skipBtn = lay.querySelector(".skip");
    skipBtn.style.display = canHexie && hooks.toggleSkip ? "" : "none";
    syncSkipFace(skipBtn, hooks.isSkipDetect?.(path) ?? false);
    const redoBtn = lay.querySelector(".redo");
    redoBtn.style.display = canHexie ? "" : "none";
    const tuneBtn = lay.querySelector(".act.tune");
    // 没有 openCensor 这个钩子（比如以后有别的地方复用查看器）就不显示，别给个点不动的钮
    tuneBtn.style.display = canHexie && hooks.openCensor ? "" : "none";
  };
  const viewerCanPeek = () => {
    const mode = hooks.getMode?.() ?? "off";
    const path = list[idx];
    if (mode === "full" || hooks.isMarked?.(path)) return true;
    if (mode === "local" && !hooks.isSkipDetect?.(path)) {
      const rec = regionMem.get(regionKey(root, path));
      return filterClientBoxes(rec?.boxes).length > 0;
    }
    return false;
  };
  favBtnV.onclick = () => { hooks.toggleFav?.(list[idx]); syncActs(); };
  metaBtnV.onclick = () => hooks.showMeta?.(list[idx], metaBtnV);
  const syncViewerCensor = (paint = true) => {
    const mode = hooks.getMode?.() ?? "off";
    lay.querySelectorAll("[data-censor]").forEach((b) => {
      b.classList.toggle("on", b.dataset.censor === mode);
    });
    if (paint) applyViewerCensor();
  };
  const applyViewerCensor = () => {
    const media = stage.querySelector("img, video");
    const img = stage.querySelector("img");
    const mode = hooks.getMode?.() ?? "off";
    const path = list[idx];
    stage.querySelector(".mb-censor-layer")?.remove();
    if (media) media.style.filter = "";
    if (mode === "full" || hooks.isMarked?.(path)) {
      if (media && !stage.classList.contains("peeking")) media.style.filter = "blur(18px)";
      applyZoom();
      return;
    }
    if (mode === "local" && img && !stage.classList.contains("peeking") && !hooks.isSkipDetect?.(path)) {
      const rec = regionMem.get(regionKey(root, path));
      paintCensorOverlay(stage, rec?.boxes, hooks.dimOf?.(path), true, hooks.censorRule?.(path));
    }
    applyZoom();
  };
  lay.querySelectorAll("[data-censor]").forEach((b) => {
    b.onclick = async () => {
      const m = b.dataset.censor;
      const already = hooks.getMode?.() === m;
      if (!(m === "local" && already)) hooks.setMode?.(m);
      syncViewerCensor();
      syncActs();
      if (m !== "local") return;
      const rec = await hooks.ensureLocal?.(list[idx], already);
      if (!lay.isConnected || !rec) return;
      if (rec.reason === "skipped") {
        notify(t("这张已跳过河蟹，不会检测。要检测点重新检测"));
        return;
      }
      if (rec.reason === "failed") {
        notify(t("这张检测没完成，再点一次「局部」"));
        return;
      }
      if (rec?.reason === "no_backend") {
        notify(t("局部接口是 404：必须关掉 Comfy 的 Python 窗口再启动，只刷新网页不够"));
        return;
      }
      if (rec?.reason === "no_runtime") {
        notify(t("还没装检测运行时。关掉预览，打开右上角设置，在 Comfy 的 Python 里装 onnxruntime"));
        return;
      }
      if (rec?.reason === "no_weights") {
        notify(t("还没有检测模型。关掉预览，打开右上角设置下载或指定本机文件"));
        return;
      }
      applyViewerCensor();
      syncActs();
      if (!filterClientBoxes(rec?.boxes).length) {
        notify(t("这张没有要遮的部位（或分数低于阈值）"));
      }
    };
  });
  lay.querySelector(".lock").onclick = () => {
    if (!hooks.toggleMark) return;
    hooks.toggleMark(list[idx]);
    stage.classList.remove("peeking");
    setIco(lay.querySelector(".act.peek"), "lucide--eye");
    applyViewerCensor();
    syncActs();
  };
  lay.querySelector(".skip").onclick = () => {
    if (!hooks.toggleSkip) return;
    hooks.toggleSkip(list[idx]);
    stage.classList.remove("peeking");
    setIco(lay.querySelector(".act.peek"), "lucide--eye");
    applyViewerCensor();
    syncActs();
  };
  // ⚠️ 按钮一律用 .act.peek 取，舞台的状态类叫 peeking 而不是 peek —— 两者必须不同名。
  //    曾经都叫 peek，而舞台在 DOM 里排在底栏前面，querySelector(".peek") 先撞上舞台，
  //    setIco 于是把**舞台的 innerHTML** 换成了一个眼睛图标：图片当场消失，再点也回不来。
  lay.querySelector(".act.peek").onclick = () => {
    if (!viewerCanPeek()) {
      notify(t("当前没有遮蔽，看一眼没有可揭开的"));
      return;
    }
    stage.classList.toggle("peeking");
    setIco(lay.querySelector(".act.peek"), stage.classList.contains("peeking") ? "lucide--eye-off" : "lucide--eye");
    applyViewerCensor();
  };
  lay.querySelector(".act.tune").onclick = (ev) => {
    // 跟格子那边点进去的是**同一个面板**，不是另抄一份
    const path = list[idx];
    hooks.openCensor?.(path, ev.currentTarget, () => {
      // 面板异步检测可能晚于翻页或关闭；只刷新仍在查看的原文件。
      if (!lay.isConnected || list[idx] !== path) return;
      stage.classList.remove("peeking");
      setIco(lay.querySelector(".act.peek"), "lucide--eye");
      syncViewerCensor();
      syncActs();
    });
  };
  lay.querySelector(".redo").onclick = async () => {
    const rec = await hooks.ensureLocal?.(list[idx], true);
    if (!lay.isConnected || !rec) return;
    applyViewerCensor();
    syncActs();
    const n = filterClientBoxes(rec.boxes).length;
    if (hooks.getMode?.() !== "local") {
      notify(n ? t("已重新检测。切到「局部」才能看到框") : t("重新检测过了，这张没有要遮的部位"));
    } else {
      notify(n ? t("已重新检测这一张") : t("重新检测过了，这张没有要遮的部位"));
    }
  };
  lay.querySelector(".shot-one").onclick = () => hooks.shotOne?.(list[idx]);
  lay.querySelector(".trash").onclick = async () => {
    const path = list[idx];
    if (!await confirmTrash(path)) return;
    if (!hooks.trashOne) {
      notify(t("这个预览没有删除入口"));
      return;
    }
    try {
      await hooks.trashOne(path);
      list.splice(idx, 1);
      if (!list.length) { shut(); return; }
      if (idx >= list.length) idx = list.length - 1;
      show();
    } catch (e) {
      notify(t(e.message || "没能移到回收站"));
    }
  };
  wfBtnV.onclick = async () => {
    setIco(wfBtnV, "lucide--loader-circle", "spin");
    try {
      const res = await openWorkflowFrom(list[idx], root);
      if (res.cancelled) { setIco(wfBtnV, "lucide--workflow"); return; }
      shut();
      hooks.closePicker?.();
    } catch (e) {
      setIco(wfBtnV, "lucide--circle-x");
      wfBtnV.title = t("打不开：{msg}", { msg: e.message || e });
      setTimeout(() => { setIco(wfBtnV, "lucide--workflow"); }, 2600);
    }
  };

  const show = () => {
    const path = list[idx];
    const i = path.lastIndexOf("/");
    const name = i < 0 ? path : path.slice(i + 1);
    const url = viewFileUrl(path, root);
    const kind = kindOf(path);                   // image / video / audio / other
    const isVid = kind === "video";
    resetZoom();

    // 音频也要停：点一下图片改成「看大图」之后，音频文件也会进这个查看器，
    // 翻走还在响就成了找不着源头的背景音。
    stage.querySelector("video, audio")?.pause();
    stage.classList.remove("peeking");
    setIco(lay.querySelector(".act.peek"), "lucide--eye");
    fnEl.textContent = name;
    fnEl.title = path;
    idxEl.textContent = `${idx + 1} / ${list.length}`;
    syncActs();
    lay.querySelector(".prev").disabled = idx <= 0;
    lay.querySelector(".next").disabled = idx >= list.length - 1;

    const fail = () => {
      stage.innerHTML =
        `<div class="mb-verr">${isVid
          ? t("浏览器播不了这个编码（多半是 AV1 或 HEVC）。<br>文件本身没问题 —— 用外部播放器打开，或者直接「用这张」也不影响出图。")
          : t("这个文件打不开预览 —— 可能格式浏览器不认，或者根本不是图片/视频。<br>「用这张」仍然可用，能不能跑得看节点认不认。")}</div>`;
    };

    if (isVid || kind === "audio" || kind === "other") {
      stage.innerHTML =
        isVid ? `<video src="${url}" controls autoplay loop playsinline></video>`
        : kind === "audio"
          ? `<div class="mb-vaud">${mbIco("lucide--music")}` +
            `<audio src="${url}" controls autoplay></audio></div>`
          : `<div class="mb-vnone">${escHtml(t("这个类型没有预览：{ext}", {
              ext: (baseName(path).split(".").pop() || "?").toUpperCase() }))}<br>` +
            `${escHtml(t("文件本身没问题 —— 仍然可以「用这张」，或者用外部程序打开。"))}</div>`;
      const media = stage.querySelector("img, video");
      if (!media) { applyViewerCensor(); prefetch(); return; }
      if (media.tagName === "VIDEO") {
        media.onloadeddata = () => applyViewerCensor();
        media.onerror = fail;
        applyViewerCensor();
        prefetch();
        return;
      }
      return;
    }

    // 静图：上一张留着，下一张有像素再换。innerHTML 清成空 <img> 再挂 src，
    // 连点左右会连续黑屏 —— 原图来不及，缩略图也来不及。
    syncViewerCensor(false);
    const cached = decoded.get(url);
    const thumb = hooks.thumbOf?.(path);
    const adopt = (im, asOrig) => {
      if (!lay.isConnected || list[idx] !== path) return;
      if (!im || !(im.complete && im.naturalWidth)) return;
      im.alt = "";
      im.draggable = false;
      if (im.parentNode !== stage) stage.appendChild(im);
      for (const n of [...stage.children]) {
        if (n !== im && !n.classList.contains("mb-censor-layer")) n.remove();
      }
      applyViewerCensor();
      applyZoom();
      if (asOrig && viewOrigReady(im.currentSrc || im.src)) {
        remember(url, im);
        prefetch();
      }
    };
    if (cached?.complete && cached.naturalWidth) {
      cached.fetchPriority = "high";
      adopt(cached, true);
      return;
    }
    const orig = new Image();
    orig.fetchPriority = "high";
    orig.decoding = "sync";
    orig.onload = () => adopt(orig, true);
    orig.onerror = () => {
      if (!lay.isConnected || list[idx] !== path) return;
      fail();
    };
    if (thumb) {
      const tIm = new Image();
      tIm.decoding = "sync";
      tIm.onload = () => {
        if (!lay.isConnected || list[idx] !== path) return;
        const cur = stage.querySelector("img");
        if (viewOrigReady(cur?.currentSrc || cur?.src)) return;
        adopt(tIm, false);
      };
      tIm.src = thumb;
      if (!stage.querySelector("img") && tIm.complete && tIm.naturalWidth) adopt(tIm, false);
    }
    orig.src = url;
    if (orig.complete && orig.naturalWidth) adopt(orig, true);
  };

  const go = (d) => {
    const n = idx + d;
    if (n < 0 || n >= list.length) return;
    lastDir = d;
    idx = n;
    show();
  };
  // 当前这张原图就绪后再预取：顺着翻的方向多拿 2 张，反方向 1 张。
  // 只预取图片 —— 视频预取等于把整个文件拖下来，代价完全不成比例。
  // 中间夹着视频/音频就跳过，预取下一张真正的静图。
  const prefetch = () => {
    for (const n of viewPrefetchPlan(list, idx, lastDir)) {
      const path = list[n];
      const u = viewFileUrl(path, root);
      const hit = decoded.get(u);
      if (hit?.complete && hit.naturalWidth) continue;
      const im = new Image();
      im.decoding = "async";
      im.fetchPriority = "low";
      im.onload = () => remember(u, im);
      im.src = u;
    }
  };

  const shut = () => {
    stage.querySelector("video, audio")?.pause();
    lay.remove();
    document.removeEventListener("keydown", onKey, true);
    mbLayers.drop(shut);
  };
  // ⚠️ 登记必须在 shut **声明之后**：写在上面 appendChild(lay) 那儿会撞 TDZ。
  //    症状还特别阴 —— 元素已经进 DOM 了，所以「大图打开了」，但后面的接线全没跑，
  //    看着像开着，其实是个壳。实测踩过（同一个坑在浏览窗口那边也踩了一次）。
  mbLayers.push(shut);
  const onKey = (e) => {
    if (document.querySelector(".mb-confirm")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); shut(); }
    // 视频在播时方向键归播放器管（快进快退），别抢
    else if (e.key === "ArrowLeft" && e.target.tagName !== "VIDEO") { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (e.key === "ArrowRight" && e.target.tagName !== "VIDEO") { e.preventDefault(); e.stopPropagation(); go(1); }
  };
  document.addEventListener("keydown", onKey, true);
  lay.addEventListener("pointerdown", (e) => { if (e.target === lay) shut(); });
  // 点图片本身也关 —— 「点一下打开、再点一下关掉」，手不用跑去右上角找 ×。
  // 放大后点图片不再关：那是在看细节；关掉走 × / Esc / 点画面外。
  // ⚠️ 只认 <img>：视频和音频的点击归播放器管（暂停 / 拖进度条），抢了就没法控制播放。
  let swiped = false;
  stage.addEventListener("click", (e) => {
    if (swiped) { swiped = false; return; }   // 刚才那一下是滑动翻页，不是点
    if (e.target.tagName !== "IMG") return;
    if (!viewClickCloses(z, panned)) return;
    shut();
  });
  stage.addEventListener("wheel", (e) => {
    if (!stage.querySelector("img")) return;
    e.preventDefault();
    e.stopPropagation();
    const next = viewZoomAfterWheel(z, e.deltaY);
    if (next === z && (z === VIEW_ZOOM_MIN || z === VIEW_ZOOM_MAX)) return;
    const img = stage.querySelector("img");
    const r = img.getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2);
    const cy = e.clientY - (r.top + r.height / 2);
    if (next <= VIEW_ZOOM_MIN) { z = 1; tx = 0; ty = 0; }
    else {
      const p = viewZoomTranslate(tx, ty, z, next, cx, cy);
      z = next; tx = p.tx; ty = p.ty;
    }
    applyZoom();
  }, { passive: false });
  // 触屏翻页：手指上没有 ← →，滑动是唯一自然的手势。
  // 阈值 45px，且横向位移要明显大于纵向 —— 不然轻轻一蹭、或者上下滑都会被当成翻页。
  // 放大后同一套指针改成拖动画面，不再翻页。
  let swX = null, swY = null;
  stage.addEventListener("pointerdown", (e) => {
    // 每次新按下都先清掉上一次滑动的标记。不清的话：滑动之后浏览器**不一定**
    // 补一发 click（位移大了就不补），标记留着不消，下一次真正的「点一下关掉」
    // 就被白白吃掉 —— 表现成「点了没反应，要点两下」。实测踩到。
    swiped = false;
    panned = false;
    if (viewCanPan(z) && e.target.tagName === "IMG") {
      drag = { x: e.clientX, y: e.clientY, tx, ty, id: e.pointerId };
      stage.classList.add("panning");
      try { stage.setPointerCapture(e.pointerId); } catch { /* 旧环境没有 */ }
      return;
    }
    if (e.pointerType !== "touch") return;
    swX = e.clientX; swY = e.clientY;
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    tx = drag.tx + (e.clientX - drag.x);
    ty = drag.ty + (e.clientY - drag.y);
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) panned = true;
    applyZoom();
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
    stage.classList.remove("panning");
  };
  stage.addEventListener("pointerup", (e) => {
    endDrag(e);
    if (e.pointerType !== "touch" || swX == null) return;
    const dx = e.clientX - swX, dy = e.clientY - swY;
    swX = swY = null;
    if (viewCanPan(z)) return;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    swiped = true;                            // 挡掉紧跟着的那一发 click，别顺手关掉
    go(dx < 0 ? 1 : -1);                      // 往左滑 = 下一张，跟翻书一个方向
  });
  stage.addEventListener("pointercancel", endDrag);
  lay.querySelector(".mb-x").onclick = shut;
  lay.querySelector(".cls").onclick = shut;
  lay.querySelector(".prev").onclick = () => go(-1);
  lay.querySelector(".next").onclick = () => go(1);
  const pickBtn = lay.querySelector(".pick");
  if (typeof onPick === "function") {
    pickBtn.onclick = () => { shut(); onPick(list[idx]); };
  } else {
    pickBtn.hidden = true;
  }

  show();
}

function openPicker({ folder, spec, current, onPick, node } = {}) {
  // 选片窗按节点类型记路；纯浏览共用 browse:any，避免两扇对照窗抢同一份 cwd。
  const canPick = typeof onPick === "function";
  const memoKey = pickerMemoKey(canPick, spec, folder);
  const memoStore = memoFor(memoKey, folder || "output");
  const memo = Object.assign({}, memoStore);
  addStyle();
  const mask = document.createElement("div");
  mask.className = "mb-mask";
  mask.innerHTML = `
    <div class="mb-box">
      <div class="mb-top">
        <div class="mb-top-head">
          <div class="mb-top-row">
            <input type="text" data-i18n-placeholder="搜索文件名…（当前范围内）" placeholder="搜索文件名…（当前范围内）">
            <select class="mb-root" data-i18n-title="选择真实媒体目录。收藏和最近在旁边单独切换" title="选择真实媒体目录。收藏和最近在旁边单独切换">
              <optgroup data-i18n-label="目录" label="目录">
                <option value="input" data-i18n-title="ComfyUI 的 input 目录" title="ComfyUI 的 input 目录">input</option>
                <option value="output" data-i18n-title="ComfyUI 的 output 目录" title="ComfyUI 的 output 目录">output</option>
                <option value="temp" data-i18n-title="ComfyUI 的 temp 目录" title="ComfyUI 的 temp 目录">temp</option>
              </optgroup>
            </select>
            <span class="mb-scope-special" role="group">
              <button type="button" data-scope="@fav" data-i18n-title="收藏的（点格子上的星标加/取消）" title="收藏的（点格子上的星标加/取消）" aria-pressed="false"><span class="mb-scope-icon">${mbIco("lucide--star")}</span><span class="lab" data-i18n="收藏">收藏</span></button>
              <button type="button" data-scope="@recent" data-i18n-title="最近选过的" title="最近选过的" aria-pressed="false"><span class="mb-scope-icon">${mbIco("lucide--refresh-cw")}</span><span class="lab" data-i18n="最近">最近</span></button>
            </span>
            <span class="mb-kinds" data-i18n-title="点着切换要看哪几类，可以多选" title="点着切换要看哪几类，可以多选"></span>
            <select class="mb-sort" data-i18n-title="排序方式" title="排序方式">
              <option value="time_desc" data-i18n="时间 ↓ 新→旧">时间 ↓ 新→旧</option>
              <option value="time_asc" data-i18n="时间 ↑ 旧→新">时间 ↑ 旧→新</option>
              <option value="name_desc" data-i18n="名称 ↓">名称 ↓</option>
              <option value="name_asc" data-i18n="名称 ↑">名称 ↑</option>
            </select>
            <label><input type="checkbox" class="mb-rec"> <span data-i18n="递归全部">递归全部</span></label>
          </div>
          <div class="mb-chrome">
            <button type="button" data-act="refresh" data-i18n-title="重新扫一遍当前目录（出片后点这里，不会自动盯盘）" title="重新扫一遍当前目录（出片后点这里，不会自动盯盘）">${mbIco("lucide--refresh-cw")}</button>
            <button type="button" data-act="settings" data-i18n-title="设置：显示、检测、存储" title="设置：显示、检测、存储">${mbIco("lucide--settings")}</button>
            <button type="button" data-act="max" data-i18n-title="最大化 / 窗口化" title="最大化 / 窗口化">${mbIco("lucide--maximize-2")}</button>
            <button type="button" data-act="close" data-i18n-title="关闭浏览，不改动节点" title="关闭浏览，不改动节点">${mbIco("lucide--x")}</button>
          </div>
        </div>
        <div class="mb-top-row mb-top-ops">
          <span class="mb-batch" role="toolbar" data-i18n-title="全选和批量操作" title="全选和批量操作">
            <button type="button" class="mb-selectall" data-i18n-title="全选当前列表里的文件（文件夹不选）" title="全选当前列表里的文件（文件夹不选）" aria-label="全选"></button>
            <span class="mb-batch-acts" hidden>
              <span class="mb-batch-n" aria-live="polite"></span>
              <button type="button" data-batch="clear" data-i18n-title="取消选择" title="取消选择">${mbIco("lucide--x")}</button>
              <button type="button" data-batch="fav" data-i18n-title="收藏选中的" title="收藏选中的">${mbIco("lucide--star")}</button>
              <button type="button" data-batch="trash" class="danger" data-i18n-title="把选中的移到回收站" title="把选中的移到回收站">${mbIco("lucide--trash-2")}</button>
            </span>
          </span>
          <span class="mb-ops-g" data-i18n-title="只改格子怎么排，不改名单里有哪些文件" title="只改格子怎么排，不改名单里有哪些文件">
            <button type="button" data-act="mode" data-i18n-title="切换排版：宫格（等大方格，整齐）／瀑布流（按原图比例，不裁切）" title="切换排版：宫格（等大方格，整齐）／瀑布流（按原图比例，不裁切）">${mbIco("lucide--layout-grid")}</button>
            <span class="mb-seg mb-seg-size" data-i18n-title="一行放几个。直接点档位，不用一下下轮换" title="一行放几个。直接点档位，不用一下下轮换">
              ${[6, 5, 4, 3, 2].map((n) => `<button type="button" data-size="${n}">${n}</button>`).join("")}
            </span>
          </span>
          <span class="mb-ops-g mb-censor-g">
            <span class="mb-seg-label" data-i18n="遮蔽" data-i18n-title="三种显示，同时只能选一个。局部只遮检测出来的部位。旁边的扫描图标检测眼前这一屏，说明在图标上。" title="三种显示，同时只能选一个。局部只遮检测出来的部位。旁边的扫描图标检测眼前这一屏，说明在图标上。">遮蔽</span>
            <span class="mb-seg" data-i18n-title="三种显示，同时只能选一个。局部只遮检测出来的部位。旁边的扫描图标检测眼前这一屏，说明在图标上。" title="三种显示，同时只能选一个。局部只遮检测出来的部位。旁边的扫描图标检测眼前这一屏，说明在图标上。">
              <button type="button" data-censor="off" data-i18n="原图" title="${CENSOR_TITLE.off}">原图</button>
              <button type="button" data-censor="full" data-i18n="全幅" title="${CENSOR_TITLE.full}">全幅</button>
              <span class="mb-local-hit">
                <button type="button" data-censor="local" data-i18n="局部" title="${CENSOR_TITLE.local}">局部</button>
                <button type="button" class="mb-detect" title="">${mbScanIco()}</button>
              </span>
            </span>
          </span>
          <button type="button" data-act="preload" class="mb-shot" data-i18n-title="预加载当前列表里的原图。会先问你一次。视频不拉。窗口不锁，再点一次取消。" title="预加载当前列表里的原图。会先问你一次。视频不拉。窗口不锁，再点一次取消。">${mbIco("lucide--image")}</button>
          <button type="button" data-act="shot-box" class="mb-shot" data-i18n-title="整窗截图：把浏览窗口当前画面拷进剪贴板。局域网 IP 下会提示改用 127.0.0.1 或 https" title="整窗截图：把浏览窗口当前画面拷进剪贴板。局域网 IP 下会提示改用 127.0.0.1 或 https">${mbIco("lucide--camera")}</button>
        </div>
      </div>
      <div class="mb-crumbrow">
        <div class="mb-crumb"></div>
        <button type="button" class="mb-pin" data-i18n-title="把当前目录钉进「范围」下拉，下次一步就能回来" title="把当前目录钉进「范围」下拉，下次一步就能回来">${mbIco("lucide--pin")}</button>
      </div>
      <div class="mb-scroll"><div class="mb-canvas"></div>
        <button type="button" class="mb-totop" data-i18n-title="回到最上面（滚下去之后才出现）" title="回到最上面（滚下去之后才出现）">${mbIco("lucide--arrow-up")}</button>
      </div>
      <div class="mb-bot"><span class="mb-stat" data-i18n="载入中…">载入中…</span><span class="mb-hint"></span></div>
    </div>`;
  document.body.appendChild(mask);
  applyCensorBlurCss();
  applyI18n(mask);
  let applyLangLive = () => {
    applyI18n(mask);
    syncScopeButtons();
    mask.querySelectorAll("[data-censor]").forEach((b) => {
      const k = b.dataset.censor;
      if (CENSOR_TITLE[k]) b.title = CENSOR_TITLE[k];
    });
  };

  const box = mask.querySelector(".mb-box");
  try {
    const saved = loadJSON("mediabrowser.boxsize", null);
    if (saved?.w > 400 && saved?.h > 300) {
      box.style.width = saved.w + "px";
      box.style.height = saved.h + "px";
    }
  } catch { /* 记不住尺寸就用默认 */ }
  {
    const br = box.getBoundingClientRect();
    const pos = pickerCascadePos(
      pickerRegistry.count(), window.innerWidth, window.innerHeight,
      br.width || 800, br.height || 600, 36);
    mask.style.left = pos.x + "px";
    mask.style.top = pos.y + "px";
  }
  let session = null;
  // 鼠标样式跟着「点一下图片＝？」走，见上面那段 CSS
  const syncClickMode = () => {
    const view = !canPick || clickOpensViewer();
    box.classList.toggle("click-view", view);
    box.classList.toggle("click-pick", !view);
  };
  syncClickMode();
  const input = mask.querySelector("input[type=text]");
  // 用显式类名而不是 querySelector("select") —— 顶栏有两个 select，
  // 靠 DOM 顺序取第一个太脆，将来加个下拉就串了
  const sel = mask.querySelector(".mb-root");
  const rec = mask.querySelector(".mb-rec");
  const sortSel = mask.querySelector(".mb-sort");
  const crumb = mask.querySelector(".mb-crumb");
  const scroll = mask.querySelector(".mb-scroll");
  const canvas = mask.querySelector(".mb-canvas");
  const stat = mask.querySelector(".mb-stat");
  const hint = mask.querySelector(".mb-hint");

  const initialScope = scopeFromPlace(memo, folder);
  let browseRoot = initialScope.root;
  let scopeMode = initialScope.mode;
  sel.value = browseRoot;
  input.value = memo.q;
  rec.checked = memo.rec;
  sortSel.value = memo.sort;
  let cwd = initialScope.cwd;
  // 遮蔽三态跨会话保留。旧键 mediabrowser.blur=1 当成全幅。
  let censorMode = loadCensorMode();
  let inferAbort = new AbortController();
  // 面板生命周期的控制器：关面板时中止一切在飞的请求。
  // 不能跟 inferAbort 共用 —— 那个每轮检测都会被换掉，
  // 拿它当「面板还开着吗」的信号，等于随时可能被别人取消。
  const panelAbort = new AbortController();
  let inferBusy = false;
  // 进度画在顶栏那个检测按钮上，syncDetectBtn 得读得到 —— 所以不能留在 startInfer 里
  let inferDone = 0;
  let inferTotal = 0;
  let preloadAbort = null;
  let preloadBusy = false;
  let preloadDone = 0;
  let preloadTotal = 0;
  let preloadWhy = "";
  let preloadPaths = [];
  const stopPreload = (why) => {
    if (!preloadBusy) return;
    preloadWhy = why;
    preloadAbort?.abort();
  };
  let lastSettingsTab = "detect";
  let settingsPoll = null;
  // 视图和目录必须是两个状态：在 output 收藏后切到收藏，仍应读 output 的收藏表。
  // @fav 只表示展示方式，不能写进目录值，否则后续收藏、遮蔽和删除都会失去真实根。
  const favMode = () => scopeMode === "@fav";
  const recentMode = () => scopeMode === "@recent";
  const virtualScope = () => favMode() || recentMode();
  const realRoot = () => browseRoot;
  const scopeButtons = [...mask.querySelectorAll(".mb-scope-special [data-scope]")];
  const syncScopeButtons = () => {
    for (const button of scopeButtons) {
      const on = button.dataset.scope === scopeMode;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
      button.setAttribute("aria-label", button.dataset.scope === "@fav" ? t("收藏") : t("最近"));
    }
    const favButton = scopeButtons.find((button) => button.dataset.scope === "@fav");
    if (favButton) setIco(favButton.querySelector(".mb-scope-icon"), favMode() ? "ph--star-fill" : "lucide--star");
  };
  const changeScopeMode = (mode) => {
    const next = scopeWithMode({ root: browseRoot, mode: scopeMode, cwd }, mode);
    browseRoot = next.root;
    scopeMode = next.mode;
    cwd = next.cwd;
    sel.value = browseRoot;
    delete sel.dataset.resume;
    memo.scroll = 0;
    syncScopeButtons();
    load();
  };
  for (const button of scopeButtons) {
    button.onclick = () => changeScopeMode(button.dataset.scope);
  }
  syncScopeButtons();
  const isFav = (p) => isFavIn(realRoot(), p);
  const toggleFav = (p) => toggleFavIn(realRoot(), p);
  const isMarked = (p) => blurMarks(realRoot()).has(p);
  const isSkipDetect = (p) => skipMarks(realRoot()).has(p);
  const isBlurred = (p) => censorMode === "full" || isMarked(p);
  const needsPeek = (p) => {
    if (isBlurred(p)) return true;
    if (censorMode !== "local" || isSkipDetect(p)) return false;
    const rec = regionMem.get(regionKey(realRoot(), p));
    return filterClientBoxes(rec?.boxes).length > 0;
  };
  // 这个节点吃什么就只列什么 —— 把 mp4 填进 LoadImage 是跑不了的
  const accept = spec?.accept;
  // 能不能**选**：只看类型对不对，这条没有开关 —— 选了不能用的会在提交任务时被
  // ComfyUI 拒掉（"Invalid image file"），等于把坑留到后面才炸。
  const acceptable = (p) => !accept || accept.test(p);
  // 列**哪些**：由类型下拉决定，跟能不能选是两回事。
  let rawFiles = [];                           // 当前目录完整清单（未按类型筛），下拉靠它数数

  // 排版状态：都记 localStorage，下次打开保持上次的习惯
  // 档位按「一行几个」定义，不按像素。
  // 固定像素在可变宽度的弹窗里会撞车：实测 857px 宽时，280px 和 380px 两档
  // 都落到 2 列、渲染出来一模一样，等于白设一档。按列数定义则永远各不相同，
  // 而且「一行两个」本来就是人想这件事的方式。
  // 6→2 列五档。不做「一行一个」：单张撑满整个弹窗其实不好看，
  // 真要细看有查看器（🔍，还能左右翻），比把宫格拉成单列合适。
  const COLS = [6, 5, 4, 3, 2];
  const SIZE_NAME = () => [t("最小"), t("小"), t("中"), t("大"), t("特大")];
  const MIN_CELL = 176;                        // 保底：低于这个宽度，操作条就得换行占掉小半格
  let sizeIdx = Math.min(COLS.length - 1, Math.max(0, +(loadStr("mediabrowser.size", "1"))));
  let cellW = 160;                             // 真值由 recalcCellW 按容器宽算
  // 格子宽 = 容器宽按目标列数平分。容器太窄时保底 MIN_CELL，
  // 此时实际列数会少于目标 —— 由 layout() 自己按 cellW 重新算，不会错位。
  const recalcCellW = () => {
    const w = Math.max(80, scroll.clientWidth - 24);
    const n = COLS[sizeIdx];
    cellW = Math.max(MIN_CELL, Math.floor((w - GAP * (n - 1)) / n));
    return cellW;
  };
  let masonry = loadStr("mediabrowser.masonry") !== "0";
  let dims = {};                                          // 后端给的 {路径: [宽,高,工作流标记]}
  let times = {};                                         // 后端给的 {路径: unix mtime}
  let elapsed = {};                                       // 任务跑了多少秒。没有就空着，不编 0.00s
  let duration = {};                                      // 视频片长（秒）

  let roStop = null;
  let st = 0;            // 挂起的重绘帧 id（rAF 节流用，close 里要取消）
  const close = () => {
    preloadWhy = "close";
    preloadAbort?.abort();
    inferAbort?.abort();
    panelAbort.abort();          // 预取那些在飞的请求也一并断掉
    clearInterval(settingsPoll);
    settingsPoll = null;
    // 挂起的重绘帧要取消：不取消的话关面板后还会在已脱离文档的格子上跑一次 paint
    if (st) { cancelAnimationFrame(st); st = 0; }
    // 关闭后不能再补发延迟缩略图，也不能让旧图片的加载回调重新布局。
    clearTimeout(settleT);
    clearTimeout(fixT);
    fixT = null;
    releasePool();
    roStop?.();
    save(REC_KEY, rec.checked ? "1" : "0");
    save(SORT_KEY, sortSel.value);
    const savedScope = scopeMode || browseRoot;
    Object.assign(memoStore, { q: input.value, cwd: virtualScope() ? "" : cwd,
                          rec: rec.checked, sort: sortSel.value, folder: savedScope,
                          root: browseRoot, scroll: scroll.scrollTop });
    savePlace(memoKey, savedScope, virtualScope() ? "" : cwd, browseRoot);
    closePop();
    if (session) {
      pickerRegistry.unregister(session.id);
      restackPickerLayers();
    }
    mask.remove();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    mbLayers.drop(close);
  };
  // ⚠️ 必须在 close **声明之后**登记。写在上面 appendChild(mask) 那里会撞 TDZ
  //    （const 声明前访问直接抛 ReferenceError），窗口根本打不开 —— 实测踩过。
  close._mbPicker = true;
  mbLayers.push(close);       // 后退键先关浏览窗口，而不是把整个 ComfyUI 页面带走
  session = pickerRegistry.register({
    id: "mb-p-" + Date.now().toString(36) + Math.random().toString(16).slice(2),
    mode: canPick ? "pick" : "browse",
    node: node || null,
    mask, box, close,
  });
  restackPickerLayers();
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    if (!consumePickerEsc(
      pickerRegistry.front()?.mask, mask,
      !!document.querySelector(".mb-confirm"),
      !!document.querySelector(".mb-play"),
      !!document.querySelector(".mb-pop"),
    )) return;
    const set = box.querySelector(".mb-settings");
    e.preventDefault();
    e.stopImmediatePropagation();
    if (set) {
      clearInterval(settingsPoll);
      settingsPoll = null;
      set.remove();
      return;
    }
    close();
  };
  document.addEventListener("keydown", onKey, true);
  // 点窗体提到最前。没有全屏遮罩了，点外侧不再关窗。
  box.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    focusPicker(session);
  });
  // 包一层箭头：这行在 closePop 的 const 声明之前，直接传引用会撞 TDZ
  scroll.addEventListener("pointerdown", () => { if (pop) closePop(); });
  box.addEventListener("mousedown", (e) => e.stopPropagation());
  mask.querySelector('[data-act="close"]').onclick = () => {
    focusPicker(session);
    close();
  };
  box.querySelector(".mb-top").addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button, input, select, label, textarea, a, .mb-rz")) return;
    if (maximized) return;
    focusPicker(session);
    const r = mask.getBoundingClientRect();
    const x0 = ev.clientX, y0 = ev.clientY, left0 = r.left, top0 = r.top;
    const move = (e) => {
      mask.style.left = (left0 + e.clientX - x0) + "px";
      mask.style.top = (top0 + e.clientY - y0) + "px";
    };
    const up = (e) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      const cur = mask.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const x = Math.min(Math.max(cur.left, 16 - cur.width + 48), vw - 48);
      const y = Math.min(Math.max(cur.top, 8), vh - 48);
      mask.style.left = x + "px";
      mask.style.top = y + "px";
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    ev.preventDefault();
  });

  // items 是「文件夹 + 图片」的混合列表，文件夹排在前面
  let items = [];
  let show = [];
  const selected = new Set();
  const pool = new Map();
  let fixT = null;
  const releaseCell = (el) => {
    const im = el.querySelector("img");
    if (im) {
      im.onload = im.onerror = null;
      if (!im.complete) im.src = BLANK_PX;
    }
    el.remove();
  };
  const releasePool = () => {
    for (const [, el] of pool) releaseCell(el);
    pool.clear();
  };

  let pop = null;
  let popOff = [];                 // 浮层关掉时要拆的监听，逐个调
  let popLayerArmed = false;       // 浮层占着历史那一格。换面板只拆 DOM，不退这一格
  const teardownPopDom = () => {
    for (const off of popOff) {
      try { off(); } catch { /* 拆监听失败不该反过来挡住关闭 */ }
    }
    popOff = [];
    pop?.remove();
    pop = null;
  };
  const closePop = () => {
    teardownPopDom();
    if (popLayerArmed) {
      popLayerArmed = false;
      mbLayers.drop(closePop);            // 有层才退，重复调 closePop 不该把历史退多
    }
  };
  // 浮层是挂在 document.body 上的（要能摆到浏览窗口外面去），所以
  // 「点外面就关掉」不能只靠格子区那条 mousedown —— 点到窗口以外它收不到，
  // 浮层就赖在屏幕上了。Esc 同理：键鼠用户第一反应是敲 Esc，不是去找那个 ×。
  // 用 capture：格子和浮层自己都会 stopPropagation，冒泡阶段根本轮不到这里。
  const armPopDismiss = (el) => {
    if (!popLayerArmed) {
      mbLayers.push(closePop);   // 后退键先关浮层，而不是把整个浏览窗口带走
      popLayerArmed = true;
    }
    const onDown = (e) => {
      if (el.contains(e.target)) return;
      // 拦住这一下：不拦的话格子会记下 pointerdown，随后 click 当成看大图。
      e.preventDefault();
      e.stopPropagation();
      closePop();
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();          // 只关浮层，别顺手把整个浏览窗口也关了
      closePop();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    popOff.push(() => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  };

  // 选中并关窗。原来这段长在格子的 onclick 里，现在按钮和格子都要用，抽出来。
  const pickNow = (path) => {
    if (!canPick) return;
    if (!acceptable(path)) {
      // 不拦着不说明是死胡同；说清为什么、以及怎么才能用
      flash(t("这个节点只收{kind}，选不了 {ext}。", {
        kind: t(spec?.label ?? "指定类型"),
        ext: (path.split(".").pop() || "").toUpperCase(),
      }) + t("要用它得换成对应的加载节点"));
      return;
    }
    pushRecent(realRoot(), path);
    onPick(path, realRoot());
    close();
  };

  // 打开大图 / 播放。放大钮和「点一下图片」都走这里，免得两处各写一份钩子。
  const openViewerAt = (path) => {
    const files = show.filter((x) => x.type !== "dir").map((x) => x.path);
    const hooks = {
      isFav,
      toggleFav: (pp) => {
        const on = toggleFav(pp);
        // 查看器浮在宫格上方；在收藏视图取消后要立刻刷新背后的名单，关闭时不能留下幽灵条目。
        if (favMode() && !on) load();
        else {
          memo.scroll = scroll.scrollTop;
          render(true);
        }
        return on;
      },
      showMeta: (pp, anchor) => showMeta(pp, anchor),
      closePicker: close,
      getMode: () => censorMode,
      setMode: (m) => setCensorMode(m),
      isMarked,
      isSkipDetect,
      toggleMark: setLockOnPath,
      toggleSkip: setSkipOnPath,
      lockTitle: lockTitleOf,
      censorRule: (pp) => censorRuleFor(realRoot(), pp),
      // 大图里点「遮蔽」开的就是格子那边同一个面板（没有格子，所以不传 cell）
      openCensor: (pp, anchor, onChange) => openCensorPanel(pp, anchor, { onChange }),
      dimOf: (pp) => dims[pp],
      thumbOf: (pp) => `/mediabrowser/thumb?filename=${encodeURIComponent(pp)}` +
        `&type=${encodeURIComponent(realRoot())}&px=${wantThumbPx(COLS[sizeIdx])}` +
        `&t=${encodeURIComponent(times[pp] ?? 0)}`,
      shotOne: (pp) => shotSingle(pp),
      ensureLocal: (pp, force) => ensureLocal(pp, !!force),
      trashOne: (pp) => trashCurrent(pp),
    };
    openViewer(files, Math.max(0, files.indexOf(path)), realRoot(), canPick ? pickNow : null, hooks);
  };

  // ── 一项能做的事：全站只在这里列一次 ────────────────────────────
  // 键鼠的悬停操作条（图标）和触屏 / 右键的菜单（带字的行）**共用同一份**。
  // 分两处写迟早出现「条上有、菜单里没有」，而且没人会发现 —— 两边看起来都正常。
  // effect =「点了确切发生什么」：条上当 tooltip，菜单里当副文案。

  // act(btn)：btn 只有从操作条点进来才有（要就地换图标）；菜单点完就关，传 undefined。
  const cellActionsFor = (it, c) => {
    const path = it.path;
    const short = baseName(path);
    const usable = acceptable(path);
    const faved = isFav(path);
    const isVid = KIND_VID.test(path);
    const isPng = /\.png$/i.test(path);
    const favText = (on) => (on
      ? { lab: t("取消收藏"), effect: t("从收藏列表里移走") }
      : { lab: t("收藏"), effect: t("钉进收藏列表，不会被新的挤掉") });

    const A = [];
    if (canPick) {
      A.push({
      id: "pick", ico: "lucide--check", cls: "pick" + (usable ? "" : " bad"),
      lab: t("用这张"), short: t("用这张"), effect: t("填进节点，并关掉浏览窗口"),
      act: () => pickNow(path),
      });
    }
    A.push({
      id: "view", ico: "lucide--zoom-in", short: t("看大图"),
      lab: t("看大图 / 播放"), effect: t("看的是原文件；打开后可以左右翻（← →），滚轮放大缩小"),
      act: () => openViewerAt(path),
    });
    // ⚠️ 这份清单**条数固定、顺序固定**，跟文件类型无关。
    //    用不上的那几条是「禁用 + 写明原因」，不是抽掉。
    //    抽掉的代价：jpg 上「删除」会坐到 png 上「提示词」的位置 ——
    //    位置一直在动，肌肉记忆非但没用，还会点错；而且用户永远不知道
    //    「为什么这张图没有提示词按钮」。写明原因反而是在教他。
    if (canCensor(path)) {
      const on = isMarked(path);
      A.push({
        id: "lock", ico: on ? "lucide--lock" : "lucide--lock-open", on,
        data: { act: "lock" },
        lab: on ? t("解锁这张") : t("锁住这张"), short: on ? t("解锁") : t("锁住"),
        effect: lockTitleOf(on),
        act: () => setLockOnPath(path),
      });
    }
    A.push({
      id: "fav", ico: faved ? "ph--star-fill" : "lucide--star", on: faved,
      short: faved ? t("取消收藏") : t("收藏"),
      ...favText(faved),
      act: (b) => {
        const now = toggleFav(path);
        if (b) {                       // 从操作条点的：就地换图标。菜单点完已经关了，不用管
          setIco(b, now ? "ph--star-fill" : "lucide--star");
          b.classList.toggle("on", now);
          b.title = `${favText(now).lab}：${favText(now).effect}`;
        }
        let bd = c.querySelector(".mb-badge");
        if (now) {
          if (!bd) { bd = document.createElement("span"); bd.className = "mb-badge"; c.appendChild(bd); }
          if (!bd.querySelector(".fav")) {
            bd.insertAdjacentHTML("afterbegin", `<span class="fav">${mbIco("ph--star-fill")}</span>`);
          }
        } else {
          bd?.querySelector(".fav")?.remove();
          if (bd && !bd.children.length) bd.remove();
        }
        if (favMode()) load();         // 收藏夹里取消收藏 → 它该走了
      },
    }, {
      id: "shot", ico: "lucide--camera", short: t("截图"),
      lab: t("截进剪贴板"), effect: t("按当前遮蔽截这一张：原图 / 全幅 / 局部"),
      act: () => shotSingle(path),
    });
    if (isPng || isVid) {
      A.push({
        id: "meta", ico: "lucide--info", short: t("提示词"),
        lab: t("提示词和参数"), effect: t("这次用的词和参数，可一键复制"),
        act: (b) => showMeta(path, b || c),
      });
      // 只在「确定有工作流」时才给。-1 = 视频还没问过，先给上（见 wfState 的注释）。
      if (wfState(path) !== 0) {
        A.push({
          id: "wf", ico: "lucide--workflow", short: t("工作流"),
          lab: t("打开工作流"), effect: t("在新标签里打开这个文件存的流，不动你当前的画布"),
          act: async (b) => {
            if (b) setIco(b, "lucide--loader-circle", "spin");
            try {
              const res = await openWorkflowFrom(path, realRoot());
              if (res.cancelled) { if (b) setIco(b, "lucide--workflow"); return; }
              close();
            } catch (e) {
              const msg = t("打不开：{msg}", { msg: e.message || e });
              if (b) {
                setIco(b, "lucide--circle-x");
                b.title = msg;
                setTimeout(() => { setIco(b, "lucide--workflow"); }, 2600);
              } else {
                flash(msg);            // 从菜单点的没有按钮可显示状态，得说出来
              }
            }
          },
        });
      }
    }
    A.push({
      id: "trash", ico: "lucide--trash-2", short: t("回收站"),
      lab: t("移到回收站"), effect: t("会先问你一次；真的会从磁盘拿走（可在系统回收站还原）"),
      act: async () => {
        if (!await confirmTrash(path)) return;
        try {
          await trashCurrent(path);
          flash(t("已把「{name}」移到回收站", { name: short }));
        } catch (e) {
          flash(t(e.message || "没能移到回收站"));
        }
      },
    });
    // 用不上的直接不给（地方本来就紧，留个点不动的按钮是白占）。
    // 但**相对顺序**必须永远是 ACTION_ORDER 那一串：少了谁，剩下的次序不变。
    // 这样「删除永远在最后、收藏永远在锁后面」这类手感才成立。
    A.sort((a, b) => ACTION_ORDER.indexOf(a.id) - ACTION_ORDER.indexOf(b.id));
    const unknown = A.find((a) => !ACTION_ORDER.includes(a.id));
    if (unknown) console.warn("[MediaBrowser]", `动作 ${unknown.id} 不在 ACTION_ORDER 里，位置会乱`);
    return A;
  };

  const showMeta = async (path, anchor) => {
    teardownPopDom();
    const short = path.split("/").pop();
    pop = document.createElement("div");
    // 读取期间可能关闭或换开另一张图，响应只允许写回创建它的面板。
    const ownPop = pop;
    const currentPop = () => pop === ownPop && ownPop.isConnected;
    pop.className = "mb-pop";
    const shell = (inner) => `
      <div class="hd"><span class="fn" title="${escHtml(short)}">${escHtml(short)}</span>
        <button type="button" class="x" title="${escHtml(t("关掉这个浮层"))}">${mbIco("lucide--x")}</button></div>
      <div class="bd">${inner}</div>`;
    pop.innerHTML = shell(`<div class="none">${escHtml(t("读取中…"))}</div>`);
    document.body.appendChild(pop);
    const relayout = () => {
      if (!pop?.isConnected) return;
      if (anchor?.isConnected) placePop(pop, anchor);
    };
    window.addEventListener("resize", relayout);
    popOff.push(() => window.removeEventListener("resize", relayout));
    armPopDismiss(pop);
    relayout();
    const wire = () => { pop.querySelector(".x").onclick = closePop; };
    wire();
    pop.onmousedown = (e) => e.stopPropagation();

    let m;
    try {
      const rr = await fetch(`/mediabrowser/meta?filename=${encodeURIComponent(path)}&type=${encodeURIComponent(realRoot())}`);
      m = await rr.json();
      if (!currentPop()) return;
      if (!rr.ok || m.error) throw new Error(m.error || `HTTP ${rr.status}`);
    } catch (e) {
      if (!currentPop()) return;
      pop.innerHTML = shell(`<div class="none">${escHtml(t("🔴 读不出来：{msg}", { msg: t(e.message) }))}</div>`);
      wire();
      relayout();
      return;
    }

    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const block = (title, arr) => {
      if (!arr?.length) return "";
      const body = arr.join("\n\n");
      return `<h4>${title}<button type="button" class="cp" data-t="${encodeURIComponent(body)}">${escHtml(t("复制"))}</button></h4>` +
              `<div class="txt">${esc(body)}</div>`;
    };
    let html = "";
    html += block(t("正向提示词"), m.positive);
    html += block(t("负向提示词"), m.negative);
    if (m.guess?.length) {
      html += block(t("提示词（推测）"), m.guess);
      html += `<div class="warn">${escHtml(t("这段不是从采样器那条线上拿的，是从流里的显示节点捞的 —— 反推类流会把现场生成的词只留在显示节点里。内容多半就是这次用的词，但位置证明不了，照抄前自己扫一眼。"))}</div>`;
    }
    if (!m.positive?.length && !m.negative?.length && !m.guess?.length) {
      html += `<div class="none">${escHtml(t(m.note || "这个文件里没存提示词。"))}
        ${m.has_workflow ? escHtml(t("它带着完整工作流 —— 点格子上的工作流按钮能把整条流载进画布。")) : ""}</div>`;
    }
    const ps = [];
    const ran = fmtElapsed(elapsed[path]);
    if (ran) ps.push([t("生成耗时"), ran, false]);
    const clip = duration[path];
    if (clip > 0) {
      const n = Number(clip);
      ps.push([t("片长"), n < 60 ? t("{n}秒", { n: n % 1 ? n.toFixed(1) : Math.round(n) }) : fmtClip(n).replace(/^片|^clip /i, ""), false]);
    }
    const when = fmtWhenFromName(path) || fmtWhen(times[path]);
    if (when) ps.push([t("时间"), when, false]);
    if (m.model) ps.push([t("模型"), baseName(m.model), true]);
    const NAME = { steps: t("步数"), cfg: "CFG", sampler_name: t("采样器"),
                   scheduler: t("调度器"), denoise: t("重绘幅度"), seed: t("种子"), noise_seed: t("种子") };
    for (const [k, v] of Object.entries(m.params || {})) ps.push([NAME[k] || k, v, false]);
    if (ps.length) {
      html += `<div class="params">` + ps.map(([k, v, wide]) =>
        `<span class="p${wide ? " wide" : ""}"><b>${esc(k)}</b><i>${esc(v)}</i></span>`).join("") + `</div>`;
    }
    pop.innerHTML = shell(html);
    wire();
    relayout();
    pop.querySelectorAll(".cp").forEach((b) => {
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const text = decodeURIComponent(b.dataset.t);
        try { await navigator.clipboard.writeText(text); }
        catch {                                   // 非 https / 无权限时的兜底
          const ta = document.createElement("textarea");
          ta.value = text; document.body.appendChild(ta); ta.select();
          document.execCommand("copy"); ta.remove();
        }
        b.textContent = t("✓ 已复制"); b.classList.add("ok");
        setTimeout(() => { b.textContent = t("复制"); b.classList.remove("ok"); }, 1400);
      };
    });
  };

  // 提前声明：drawCrumb 里要用它，而它的实现在下面很远的地方。
  // 写成 const 会有 TDZ —— ?.() 挡得住 undefined，挡不住"声明前访问"，那是 ReferenceError。
  let syncPin = () => {};
  const drawCrumb = () => {
    syncPin();
    const parts = cwd ? cwd.split("/") : [];
    crumb.innerHTML = "";
    const mk = (label, path, isCur) => {
      if (isCur) {
        const s = document.createElement("span");
        s.className = "cur"; s.textContent = label; crumb.appendChild(s);
      } else {
        const a = document.createElement("a");
        a.textContent = label;
        a.onclick = () => { cwd = path; load(); };
        crumb.appendChild(a);
      }
    };
    if (virtualScope()) {
      const s = document.createElement("span");
      s.className = "cur";
      s.textContent = favMode() ? t("收藏的（点格子上的星标加/取消）") : t("最近选过的");
      crumb.appendChild(s);
      return;
    }
    mk(sel.value, "", parts.length === 0);
    parts.forEach((p, i) => {
      const s = document.createElement("span");
      s.className = "sep"; s.textContent = "›"; crumb.appendChild(s);
      mk(p, parts.slice(0, i + 1).join("/"), i === parts.length - 1);
    });
    if (rec.checked) {
      const s = document.createElement("span");
      s.className = "sep"; s.textContent = t("  （递归全部子目录）"); crumb.appendChild(s);
    }
  };

  // ── 排版：宫格和瀑布流共用一套「预先算好每个格子的 x/y/w/h」 ──
  //    为什么预算而不是边滚边算：瀑布流的格子高度不一，没法像等高网格那样
  //    用「行号 × 行高」反推。好在尺寸后端已经给了（一次全库扫描 0.55s，
  //    之后走索引），所以开局就能把 4000+ 个位置全算出来，滚动时只做区间筛选。
  let placed = [];        // [{x,y,w,h}]，与 show 同序
  let totalH = 0;

  // 轻提示：用在「操作生效了但画面看不出变化」的场合 ——
  // 按钮点了没反应是最容易被当成坏了的体验，得让别处动一下。
  let flashT = null;
  const flash = (msg) => {
    if (preloadBusy && !inferBusy) {
      notify(msg);
      return;
    }
    hint.textContent = msg;
    hint.style.color = "#d3a94a";
    notify(msg);
    clearTimeout(flashT);
    flashT = setTimeout(() => {
      hint.style.color = "";
      if (inferBusy || preloadBusy) return;
      if (censorMode === "local") updateUnhitHint();
      else paint();
    }, 2200);
  };

  // 「这个文件有没有内嵌工作流」：1=有 0=没有 -1=还不知道
  const wfState = (p) => {
    const d = dims[p];
    return d && d.length > 2 ? d[2] : -1;
  };
  // ⚠️ 视频的「有没有工作流」故意**不探测**，理由是交互不是性能：
  //    探一个要 40ms（可接受，答案还能缓存），但结果是**鼠标停上去之后按钮才消失** ——
  //    等于在光标底下抽走一个目标，比偶尔点到一个「这个视频里没存工作流」更难受。
  //    而 76% 的视频本来就有工作流。所以视频一律显示 ⧉，没有时给出具体原因。
  //    PNG 按实际有无决定 —— 那个标记跟读尺寸共用一次 PIL open，是真的白拿。

  // 缩略图到手后用真实比例校正瀑布流。
  // 为什么需要：视频的宽高在后端是**猜的**（一律按 16:9）——
  // 真去读要开 ffmpeg，40ms 一个、657 个要 27 秒，不值得在列目录时同步做。
  // 结果就是竖屏视频在瀑布流里被摆成横的。而缩略图本身是等比缩的，
  // 加载完 naturalWidth/Height 就是真实比例，白拿。收集一批再统一重排，
  // 避免每张图到位都触发一次布局。
  const fixRatio = (path, natW, natH) => {
    if (!natW || !natH) return;
    const d = dims[path];
    const was = d && d[1] ? d[0] / d[1] : 0;
    const now = natW / natH;
    if (Math.abs(was - now) < 0.02) return;          // 差不多就别动，省得白重排
    dims[path] = [natW, natH, d ? d[2] : -1];
    if (censorMode === "local") applyLocalCaches();  // 封面比例校正后重画框
    if (!masonry) return;                            // 宫格是等大方块，比例不影响排版
    clearTimeout(fixT);
    fixT = setTimeout(() => { layout(); paint(); }, 220);
  };

  const ratioOf = (it) => {
    if (it.type === "dir") return 1.6;                 // 文件夹卡片扁一点
    const d = dims[it.path];
    const r = d && d[1] ? d[0] / d[1] : 1;
    return Math.min(2.6, Math.max(0.38, r));           // 太极端的裁一下，免得一格占满整屏
  };

  const layout = () => {
    recalcCellW();                             // 弹窗被拖大拖小时也要跟上
    const w = Math.max(80, scroll.clientWidth - 24);
    if (masonry) {
      const cols = Math.max(1, Math.round(w / (cellW + GAP)));
      const colW = Math.floor((w - GAP * (cols - 1)) / cols);
      const colY = new Array(cols).fill(0);
      placed = show.map((it) => {
        let c = 0;
        for (let i = 1; i < cols; i++) if (colY[i] < colY[c]) c = i;
        const h = Math.round(colW / ratioOf(it));
        const p = { x: c * (colW + GAP), y: colY[c], w: colW, h };
        colY[c] += h + GAP;
        return p;
      });
      totalH = Math.max(0, Math.max(...colY, 0) - GAP);
    } else {
      const cols = Math.max(1, Math.floor((w + GAP) / (cellW + GAP)));
      const colW = Math.floor((w - GAP * (cols - 1)) / cols);
      placed = show.map((_, i) => ({
        x: (i % cols) * (colW + GAP),
        y: Math.floor(i / cols) * (colW + GAP),
        w: colW, h: colW,
      }));
      totalH = Math.max(0, Math.ceil(show.length / cols) * (colW + GAP) - GAP);
    }
    canvas.style.height = totalH + "px";
  };

  const trashCurrent = async (path) => {
    await postTrash(realRoot(), path);
    forgetPath(realRoot(), path);
    rawFiles = rawFiles.filter((p) => p !== path);
    items = items.filter((it) => it.path !== path);
    selected.delete(path);
    // render(false) 会把 scrollTop 写成 0，人在下面会整页弹回顶。
    // keepScroll 读的是上次关面板时的 memo，不是此刻位置，先写进去再还。
    // 收藏/最近也不走 load()：load 会先铺骨架，高度一缩照样跳顶。
    memo.scroll = scroll.scrollTop;
    render(true);
  };

  let clipBusy = false;
  let clipT = null;
  const patchCardMeta = () => {
    for (const el of pool.values()) {
      const path = el.dataset?.path;
      if (!path) continue;
      const meta = el.querySelector(".nm .meta");
      if (!meta) continue;
      const line = cardMetaLine(path, times, dims, { elapsed, duration });
      meta.textContent = line;
      meta.title = line;
    }
  };
  const fillClipInfo = async () => {
    if (clipBusy || !mask.isConnected) return;
    const miss = [];
    for (const i of pool.keys()) {
      if (i < 0) continue;
      const it = show[i];
      if (!it || it.type === "dir" || !KIND_VID.test(it.path)) continue;
      if (duration[it.path] > 0) continue;
      miss.push(it.path);
      if (miss.length >= 16) break;
    }
    if (!miss.length) return;
    clipBusy = true;
    try {
      const r = await fetch("/mediabrowser/clipinfo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: realRoot(), files: miss }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.duration) Object.assign(duration, j.duration);
      patchCardMeta();
    } catch { /* 片长是附加信息，失败就空着 */ }
    finally { clipBusy = false; }
  };
  const scheduleClipInfo = () => {
    clearTimeout(clipT);
    clipT = setTimeout(() => { void fillClipInfo(); }, 280);
  };

  const lockTitleOf = (locked) => {
    const base = locked
      ? t("已锁：这张以后打开都是糊的。点一下解锁")
      : t("锁上：这张以后打开也是糊的（只管这一张）");
    return censorMode === "full"
      ? `${base}\n${t("（顶上是「全幅」，所以现在锁不锁画面都是糊的 —— 切到原图才看得出区别）")}`
      : base;
  };
  const paintLockOnCell = (el, path, now) => {
    const b = el.querySelector("[data-act=lock]");
    if (b) {
      setIco(b, now ? "lucide--lock" : "lucide--lock-open");
      b.classList.toggle("on", now);
      b.title = lockTitleOf(now);
    }
    const eff = censorMode === "full" || now;
    el.classList.toggle("blurred", eff);
    if (eff) attachPeekBtn(el);
    else {
      el.classList.remove("peek");
      if (needsPeek(path)) attachPeekBtn(el);
      else el.querySelector(".mb-peek")?.remove();
    }
  };
  const syncRedoOnCell = (el, path) => {
    if (!el) return;
    if (regionMem.get(regionKey(realRoot(), path))?.reason === "failed") {
      attachRedoBtn(el, () => redoOne(path, el));
    } else {
      detachRedoBtn(el);
    }
  };
  const paintSkipOnCell = (el, path, now) => {
    syncSkipFace(el.querySelector(".mb-skip"), now);
    el.querySelector(".mb-badge .skip")?.remove();
    const leftover = el.querySelector(".mb-badge");
    if (leftover && !leftover.children.length) leftover.remove();
    if (now) {
      el.querySelector(".mb-censor-layer")?.remove();
      if (!isBlurred(path)) {
        el.classList.remove("peek");
        el.querySelector(".mb-peek")?.remove();
      }
    } else if (needsPeek(path)) attachPeekBtn(el);
  };
  const setLockOnPath = (path) => {
    const now = toggleBlurMark(realRoot(), path);
    for (const [, el] of pool) {
      if (el.dataset.path === path) paintLockOnCell(el, path, now);
    }
    notify(now
      ? (censorMode === "full"
        ? t("已锁住这一张（切到原图后才看得出）。再点锁解开")
        : t("已锁：这张以后打开都是糊的。再点锁解开"))
      : (censorMode === "full"
        ? t("已解锁这一张（切到原图后才看得出）")
        : t("已解锁，这张不再单独糊")));
    return now;
  };
  const setSkipOnPath = (path) => {
    const now = toggleSkipDetect(realRoot(), path);
    for (const [, el] of pool) {
      if (el.dataset.path === path) paintSkipOnCell(el, path, now);
    }
    flash(now
      ? t("已跳过河蟹。批量检测会略过。要检测这一张点重新检测")
      : t("已恢复检测。点重新检测或底栏「没检测」会打这一张"));
    updateUnhitHint();
    return now;
  };

  const replaceSelected = (next) => {
    selected.clear();
    for (const p of next) selected.add(p);
  };
  const attachCheckBtn = (el, path) => {
    let ck = el.querySelector(".mb-check");
    if (ck) return ck;
    ck = mbElButton("mb-check");
    ck.title = t("勾选 / 取消勾选");
    ck.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    ck.onclick = (ev) => {
      ev.stopPropagation();
      replaceSelected(toggleSelected(selected, path));
      syncSelection();
    };
    el.appendChild(ck);
    return ck;
  };
  const syncSelection = () => {
    const keep = pruneSelected(selected, selectablePaths(show));
    if (keep.size !== selected.size) replaceSelected(keep);
    const n = selected.size;
    box.classList.toggle("mb-selecting", n > 0);
    const paths = selectablePaths(show);
    const st = selectAllState(paths, selected);
    const allBtn = mask.querySelector(".mb-selectall");
    if (allBtn) {
      allBtn.classList.toggle("on", st === "all");
      allBtn.classList.toggle("some", st === "some");
      allBtn.setAttribute("aria-pressed", st === "none" ? "false" : st === "all" ? "true" : "mixed");
      allBtn.setAttribute("aria-label", st === "all" ? t("取消全选") : t("全选"));
      if (st === "all") setIco(allBtn, "lucide--check");
      else if (st === "some") setIco(allBtn, "lucide--minus");
      else allBtn.innerHTML = "";
    }
    const acts = mask.querySelector(".mb-batch-acts");
    if (acts) {
      acts.hidden = n < 1;
      const countEl = acts.querySelector(".mb-batch-n");
      if (countEl) countEl.textContent = n ? t("已选 {n}", { n }) : "";
      const favBtn = acts.querySelector("[data-batch=fav]");
      if (favBtn && n) {
        const favs = favSet(realRoot());
        const intent = batchFavIntent([...selected], (p) => favs.has(p));
        setIco(favBtn, intent === "unfav" ? "ph--star-fill" : "lucide--star");
        favBtn.title = intent === "unfav" ? t("取消收藏") : t("收藏选中的");
      }
    }
    for (const el of pool.values()) {
      if (el.classList.contains("dir") || el.classList.contains("skel")) continue;
      const path = el.dataset.path;
      if (!path) continue;
      const on = selected.has(path);
      el.classList.toggle("checked", on);
      const ck = attachCheckBtn(el, path);
      ck.classList.toggle("on", on);
      ck.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) setIco(ck, "lucide--check");
      else ck.innerHTML = "";
    }
  };
  mask.querySelector(".mb-selectall").onclick = () => {
    replaceSelected(nextSelectAll(selectablePaths(show), selected));
    syncSelection();
  };
  mask.querySelector("[data-batch=clear]").onclick = () => {
    selected.clear();
    syncSelection();
  };
  mask.querySelector("[data-batch=fav]").onclick = () => {
    const paths = [...selected];
    if (!paths.length) return;
    const favs = favSet(realRoot());
    const intent = batchFavIntent(paths, (p) => favs.has(p));
    const want = intent === "fav";
    setFavsIn(realRoot(), paths, want);
    flash(want ? t("已收藏 {n} 项", { n: paths.length }) : t("已取消收藏 {n} 项", { n: paths.length }));
    if (favMode() && !want) {
      load();
      return;
    }
    memo.scroll = scroll.scrollTop;
    render(true);
  };
  mask.querySelector("[data-batch=trash]").onclick = async () => {
    const paths = [...selected];
    if (!paths.length) return;
    const root = realRoot();
    if (!await confirmTrash(paths[0], paths.length)) return;
    const opSeq = loadSeq;
    const opMode = scopeMode;
    const opCwd = cwd;
    let okN = 0, fail = 0, lastErr = "";
    for (const p of paths) {
      try {
        await postTrash(root, p);
        forgetPath(root, p);
        // 用户可能在等待磁盘操作时切了范围；只更新发起操作时那一版列表。
        if (mask.isConnected && loadSeq === opSeq) {
          rawFiles = rawFiles.filter((x) => x !== p);
          items = items.filter((it) => it.path !== p);
          selected.delete(p);
        }
        okN++;
      } catch (e) {
        fail++;
        lastErr = e.message || "";
      }
    }
    const sameScope = mask.isConnected && realRoot() === root && scopeMode === opMode && cwd === opCwd;
    if (mask.isConnected && loadSeq === opSeq) {
      memo.scroll = scroll.scrollTop;
      render(true);
    } else if (sameScope) {
      // 中途刷新过同一范围时，重新扫盘才能避免那次刷新抢先返回旧文件列表。
      void load({ refresh: true });
    }
    if (fail) {
      flash(t("回收站：成功 {ok} / 失败 {fail}{err}", {
        ok: okN, fail, err: lastErr ? ` · ${lastErr}` : "",
      }));
    } else {
      flash(t("已把 {n} 项移到回收站", { n: okN }));
    }
  };

  const paint = () => {
    // 一屏约 30 个格子。逐个 appendChild 会让浏览器每插一个就重算一次布局；
    // 先攒进 fragment、最后一次性插入，只重算一次。
    const frag = document.createDocumentFragment();
    const top = scroll.scrollTop, vh = scroll.clientHeight;
    const y0 = top - cellW * BUF, y1 = top + vh + cellW * BUF;

    // 瀑布流里格子不是按 y 排的，所以老老实实全量筛一遍。
    // 4779 个 * 一次比较，实测 1ms 以内，比维护区间索引简单得多。
    const want = new Set();
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      if (p.y < y1 && p.y + p.h > y0) want.add(i);
    }
    // 滚出视口的格子：**先掐掉它的缩略图请求**再移除。
    // el.remove() 只是脱离文档，在飞的请求按规范不会取消 —— 快速滚动时
    // 这些「已经看不见了」的请求会一直占着浏览器对同一 host 的连接额度
    // （HTTP/1.1 约 6 个）和后端线程池，把你停下来真正想看的那一屏挤在后面排队。
    // 换成 1px 透明图即可让浏览器放弃原来那个；先摘掉回调，免得触发重试逻辑。
    for (const [i, el] of pool) {
      if (want.has(i)) continue;
      releaseCell(el);
      pool.delete(i);
    }

    for (const i of want) {
      const p = placed[i];
      if (pool.has(i)) {                                 // 已有的只要更新位置（换排版/改尺寸时）
        const el = pool.get(i);
        el.style.left = p.x + "px"; el.style.top = p.y + "px";
        el.style.width = p.w + "px"; el.style.height = p.h + "px";
        continue;
      }
      const it = show[i];
      if (!it) continue;
      const c = document.createElement("div");
      c.style.left = p.x + "px"; c.style.top = p.y + "px";
      c.style.width = p.w + "px"; c.style.height = p.h + "px";

      if (it.type === "dir") {
        c.className = "mb-cell dir";
        c.innerHTML = `<span class="ico">${mbIco("lucide--folder")}<i>${escHtml(t("{n} 张", { n: it.count }))}</i></span>` +
                       `<span class="nm">${escHtml(it.name)}</span>`;
        c.onclick = () => { cwd = cwd ? `${cwd}/${it.name}` : it.name; load(); };
      } else {
        c.className = "mb-cell" + (it.path === current ? " sel" : "");
        c.dataset.path = it.path;
        const short = it.path.split("/").pop();
        const isVid = KIND_VID.test(it.path);
        const faved = isFav(it.path);
        const blurred = isBlurred(it.path);

        // 状态角标常驻 —— 收藏/视频是「信息」，得一眼扫到，不该藏在 hover 里。
        // 锁钉在左上角，眼睛在它右边；眼睛来去锁不挪。
        const badges = [];
        if (faved) badges.push(`<span class="fav">${mbIco("ph--star-fill")}</span>`);
        if (isVid) badges.push(`<span class="vid">${mbIco("lucide--play")}</span>`);
        c.innerHTML =
          `<span class="ph">…</span>` +
          nmHtml(short, it.path, times, dims, { elapsed, duration }) +
          (badges.length ? `<span class="mb-badge">${badges.join("")}</span>` : "");
        if (blurred) c.classList.add("blurred");

        // 揭开钮：只在糊住时出现，常驻可见（触屏也点得到），**可来回切**。
        // 之所以做成独立按钮而不是「点图片揭开」：点图片必须永远等于「选中」——
        // 同一个手势在不同状态下换意思，是最容易点错的设计。
        if (needsPeek(it.path)) attachPeekBtn(c);
        if (canCensor(it.path)) {
          // 重检角标只在**上次真的失败了**时才挂。
          // 缓存键含 mtime+size+model_id+权重大小，换文件/换模型都会自动失效；
          // 其余情况重检可证明是空跑（同图同模型必然同结果）。
          // 常显一个「点了必然没变化」的钮，只会被反复点。想遮更多走右键菜单。
          if (regionMem.get(regionKey(realRoot(), it.path))?.reason === "failed") {
            attachRedoBtn(c, () => redoOne(it.path, c));
          }
          attachSkipBtn(c, isSkipDetect(it.path), () => {
            setSkipOnPath(it.path);
          });
        }

        const usable = acceptable(it.path);
        if (!usable) c.classList.add("unusable");
        let lpFired = false;                      // 长按刚开过菜单，这一发 click 不算数
        // 点一下图片：默认「看大图」，可在设置里换成「直接选中」。
        // ⚠️ 这个手势的含义**在一次会话里是固定的**，不会随图片状态变 ——
        //    同一个手势在不同状态下换意思才是最容易点错的设计。
        //    要「一击选中」的人有更好的靶子：格子上那个绿色的 ✓（见下面），
        //    小、明确、不会拿手指划过去就误触。
        // 这一格自己收到过 pointerdown 才认这次 click。
        // 触屏上点节点的「浏览资源」时，弹层就出现在手指底下，浏览器随后**合成**
        // 的那一发 click 会落到刚冒出来的格子上 —— 窗口一开就直接打开了某张图。
        // 鼠标没有这问题（不合成事件），所以只有手指用户会撞上。
        // 不用「开窗后 N 毫秒内不认」那种挡法：那是拿时间赌，机器慢一点就漏。
        // 按下和抬起必须是同一格，这条判据跟设备和时序都无关。
        let downOn = false;
        c.addEventListener("pointerdown", () => { downOn = true; }, { passive: true });
        c.onclick = () => {
          const real = downOn;
          downOn = false;
          if (!real) return;                 // 没在这一格按下过 = 幽灵点击
          if (lpFired) { lpFired = false; return; }
          if (cellClickIntent({ isDir: false, hasSelection: selected.size > 0 }) === "select") {
            replaceSelected(toggleSelected(selected, it.path));
            syncSelection();
            return;
          }
          if (clickOpensViewer()) { openViewerAt(it.path); return; }
          if (!canPick) { openViewerAt(it.path); return; }
          pickNow(it.path);
        };

        // 右键这张：单独调它的遮蔽力度。
        // 为什么不做成底栏按钮：底栏已经七个钮了，而这是**少数图才需要**的功能，
        // 常显只会挤占每一张图的空间。右键是「进阶操作」的常规位置。
        c.oncontextmenu = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openCellMenu(it, c);
        };
        // 触屏没有右键，长按 0.5s 当右键用（移动端的通行做法）。
        // 不加这一条，手指用户**完全够不到**单张遮蔽这些设置。
        // 手指挪超过 10px 就当成在滚动，不是长按。
        let lpT = null, lpXY = null;
        c.addEventListener("pointerdown", (ev) => {
          if (ev.pointerType !== "touch") return;
          lpXY = [ev.clientX, ev.clientY];
          lpT = setTimeout(() => {
            lpT = null;
            lpFired = true;        // 抬手时还会来一发 click，得挡掉，否则顺手选中并关窗
            openCellMenu(it, c);
          }, 500);
        }, { passive: true });
        const stopLp = () => { clearTimeout(lpT); lpT = null; };
        // ⚠️ 抬手（pointerup）**一定**要取消：手指离开了，这就是一次「点」，不是长按。
        //    抬手和「手指挪动」不能共用同一条判据 —— 曾经共用过，写成
        //    「挪动不到 10px 就不取消」，于是**点一下**（手指几乎不动）计时器活到底，
        //    500ms 后菜单照样弹出来：点一下变成了右键。
        //    10px 那条只对 pointermove 有意义：手指在滑动，说明你在滚列表。
        c.addEventListener("pointermove", (ev) => {
          if (!lpT || !lpXY || ev.clientX == null) return;
          if (Math.hypot(ev.clientX - lpXY[0], ev.clientY - lpXY[1]) >= 10) stopLp();
        }, { passive: true });
        for (const e2 of ["pointerup", "pointercancel", "pointerleave"]) {
          c.addEventListener(e2, stopLp, { passive: true });
        }

        const bar = document.createElement("div");
        bar.className = "mb-bar";
        for (const a of cellActionsFor(it, c)) {
          const b = mbElButton();
          setIco(b, a.ico);
          // 每个按钮都得答得上「点了会怎样」；用不了的答「为什么用不了」
          b.title = a.off ? `${a.lab}：${a.off}` : `${a.lab}：${a.effect}`;
          if (a.off) { b.disabled = true; b.classList.add("off"); }
          if (a.on) b.classList.add("on");
          if (a.cls) for (const k of a.cls.split(" ")) { if (k) b.classList.add(k); }
          if (a.data) for (const k of Object.keys(a.data)) b.dataset[k] = a.data[k];
          b.onclick = (ev) => { ev.stopPropagation(); a.act(b); };
          bar.appendChild(b);
        }
        c.appendChild(bar);

        // 触屏用的「⋯」：开这一项的操作菜单。
        // ⚠️ 之前是「就地把操作条放出来」，还是盖在图上 —— 想看清楚和想动手依然在抢
        //    同一块地方。现在菜单是**另开一层**，而且 placeAsidePop 会让它避开这张图，
        //    于是图片始终完整可见，操作也全是整行的大靶子。
        //    长按图片是同一个入口（见上面），两条路通向同一个菜单。
        const moreB = mbElButton("mb-more");
        setIco(moreB, "lucide--ellipsis");
        moreB.title = t(canPick
          ? "这一张的操作：用这张 / 看大图 / 收藏 / 遮蔽 / 删除…"
          : "这一张的操作：看大图 / 收藏 / 遮蔽 / 删除…");
        moreB.onclick = (ev) => {
          ev.stopPropagation();                   // 别落到「点图 = 看大图」上
          openCellMenu(it, c);
        };
        c.appendChild(moreB);

        // 非媒体（.md/.txt/.json…）不去要缩略图 —— 后端生不出来，
        // 白等一次 400 再显示 ✕，不如直接给个能认的文件图标
        const kind = kindOf(it.path);
        if (kind === "other" || kind === "audio") {
          const ph = c.querySelector(".ph");
          if (ph) {
            ph.classList.remove("ph");
            ph.className = "mb-doc";
            const ext = escHtml((short.split(".").pop() || "").toUpperCase());
            ph.innerHTML = kind === "audio"
              ? `${mbIco("lucide--music")}<i>${ext}</i>`
              : `${mbIco("lucide--scroll-text")}<i>${ext}</i>`;
          }
          frag.appendChild(c);
          pool.set(i, c);
          continue;
        }
        const img = document.createElement("img");
        img.decoding = "async";
        // 补发和回收都从格子查找 img，必须在请求前挂入 DOM。
        // 若等 onload 才插入，data-src 永远不可见，停下也不会发请求。
        c.prepend(img);
        // 按设置（或自动按格子）取缩略图档。后端只认固定几档，会吸附。
        const wantPx = wantThumbPx(COLS[sizeIdx]);
        // URL 里**必须**带 mtime。响应头是 max-age=604800（7 天），浏览器在这期间
        // 连问都不问 —— URL 不变它就一直给旧图。原地覆盖一张同名文件时，
        // 服务端会正确生成新缩略图（thumb_key 带 mtime），但浏览器根本不来取，
        // 你会盯着七天前的封面，而且没有任何报错。
        // 加上这一段，文件一变 URL 就变，那个长缓存才真的安全。
        const thumbUrl = `/mediabrowser/thumb?filename=${encodeURIComponent(it.path)}` +
                         `&type=${encodeURIComponent(realRoot())}&px=${wantPx}` +
                         `&t=${encodeURIComponent(times[it.path] ?? 0)}`;
        // 失败先重试两次再报错。
        // 缩略图的失败大多是**瞬时**的：滚动太快时格子被回收、请求被浏览器 abort
        // （img.onerror 照样触发）；或者一屏全是视频、后端 3 个线程排不过来。
        // 这些过几百毫秒重来就好了 —— 直接摆个 ✕ 会让人以为文件坏了，
        // 而实际上再滚回去它又好了（这个「先报错后又出现」正是用户看到的现象）。
        let tries = 0;
        img.onload = () => {
          if (!c.isConnected) return;               // 旧范围的迟到响应不能改写新范围的尺寸表
          c.querySelector(".ph")?.remove();
          c.prepend(img);
          fixRatio(it.path, img.naturalWidth, img.naturalHeight);
        };
        img.onerror = () => {
          if (!c.isConnected) return;              // 格子已经被回收，不用管了
          if (++tries <= 2) {
            // 加个变化的参数绕开浏览器对失败结果的缓存
            setTimeout(() => {
              // 等待期间可能已滚出或关闭面板，不能重新启动已回收格子的请求。
              if (c.isConnected) img.src = `${thumbUrl}&r=${tries}`;
            }, 300 * tries);
            return;
          }
          const p = c.querySelector(".ph");
          if (p) {
            p.textContent = isVid ? t("✕ 出不了封面") : t("✕ 打不开");
            p.classList.add("err");
            p.title = t("试了 3 次都没出来。点放大还能看/能播，也还能选它 —— 只是这里显示不出画面");
          }
        };
        // 滚动中只挂着不发，停下再由 flushThumbs 统一转成 src（见那段注释）。
        if (scrolling) { img.dataset.src = thumbUrl; scheduleFlush(); }
        else img.src = thumbUrl;
      }
      frag.appendChild(c);
      pool.set(i, c);
    }
    if (frag.childNodes.length) canvas.appendChild(frag);
    if (!inferBusy && !preloadBusy) {
      hint.textContent = t("已渲染 {n} 格 · 点图选中，点文件夹进入", { n: pool.size });
    }
    if (censorMode === "local") {
      applyLocalCaches();
      void hydrateCacheOnly();
    }
    scheduleClipInfo();
    syncSelection();
  };

  const render = (keepScroll) => {
    const q = input.value.trim().toLowerCase();
      show = items.filter((it) => {
        const key = (it.type === "dir" ? it.name : it.path).toLowerCase();
        if (q && !key.includes(q)) return false;
        // 空集表示不过滤；文件夹始终保留，确保仍能进入子目录。
        if (kinds.size && it.type !== "dir" && !kinds.has(kindOf(it.path))) return false;
        return true;
      });
    replaceSelected(pruneSelected(selected, selectablePaths(show)));
    releasePool();
    layout();
    scroll.scrollTop = q ? 0 : (keepScroll ? memo.scroll || 0 : 0);
    syncToTop();     // 重开窗口直接停在几千格深处时，回顶按钮得当场就在
      // 数的是 show（搜索+类型筛完的），不是 items —— 用 items 会报出跟眼前对不上的数
      const nd = show.filter((i) => i.type === "dir").length;
      const nf = show.length - nd;
      const nUnusable = show.filter((it) => it.type !== "dir" && !acceptable(it.path)).length;
      const tail = nUnusable ? t("（其中 {n} 个点下去会提示换节点）", { n: nUnusable }) : "";
      const total = items.length - items.filter((i) => i.type === "dir").length;
      const filtered = nf < total ? t("　（共 {total}，按类型筛后剩 {n}）", { total, n: nf }) : "";
      stat.textContent = virtualScope()
        ? t("{n} 个", { n: nf })
        : `${t("{nd} 个文件夹 · {nf} 个文件", { nd, nf })}${tail}${filtered}`;
    paint();
    if (preloadBusy && !viewPreloadSame(viewPreloadPaths(show), preloadPaths)) {
      stopPreload("scope");
    }
  };

  // 格子按 rAF 每帧最多重绘一次。缩略图地址先挂 data-src，
  // 停下后批量补发；长滑动受最大延迟限制。待办直接从渲染池查找，避免双份状态漂移。
  let scrolling = false;
  let settleT = null;
  let lastFlushAt = 0;
  const THUMB_SETTLE_MS = 120;
  // 限制惯性滚动期间的最长等待时间，持续输入也能逐批出图。
  const THUMB_MAX_DEFER_MS = 400;
  const flushThumbs = () => {
    const mid = scroll.scrollTop + scroll.clientHeight / 2;
    const todo = [];
    for (const [i, el] of pool) {
      const img = el.querySelector("img[data-src]");
      if (!img) continue;
      const pl = placed[i];
      todo.push({ img, y: pl ? pl.y : 0, h: pl ? pl.h : 0 });
    }
    if (!todo.length) return;
    // 从视口中心往外发：总耗时一样，但你眼睛落点处最先出图。
    // 按池子顺序发的话，停在中间时会先加载屏幕边缘那几张。
    todo.sort((a, b) => Math.abs(a.y + a.h / 2 - mid) - Math.abs(b.y + b.h / 2 - mid));
    for (const it of todo) {
      it.img.src = it.img.dataset.src;
      delete it.img.dataset.src;
    }
    lastFlushAt = performance.now();
  };
  const scheduleFlush = () => {
    // 长滑动按最大延迟补发，停下后由防抖补齐剩余图片。
    if (performance.now() - lastFlushAt >= THUMB_MAX_DEFER_MS) flushThumbs();
    clearTimeout(settleT);
    settleT = setTimeout(() => { settleT = null; scrolling = false; flushThumbs(); },
                         THUMB_SETTLE_MS);
  };

  // 回顶部：滚出一屏才出现（没滚下去时它没用处，只会挡图）。
  // 状态挂 class 由 CSS 管显隐 —— 别在滚动回调里直接改 style，那是每帧都在写。
  const TOTOP_AT = 400;
  const syncToTop = () => scroll.classList.toggle("scrolled", scroll.scrollTop > TOTOP_AT);
  mask.querySelector(".mb-totop").onclick = () => {
    // 一路滚上去的话几千格要滚很久，而且沿途每帧都在 paint()。直接跳。
    scroll.scrollTo({ top: 0, behavior: "auto" });
    syncToTop();
    paint();
  };
  scroll.addEventListener("scroll", () => {
    scrolling = true;
    scheduleFlush();       // 每次滚动都把「停下」这个计时器往后推
    if (st) return;
    st = requestAnimationFrame(() => { st = 0; paint(); syncToTop(); });
  }, { passive: true });
  const onResize = () => { layout(); releasePool(); paint(); };
  window.addEventListener("resize", onResize);

  let firstLoad = true;
  // 数据没到之前先摆一屏骨架格，别让画布空着。
  // 之前是 load() 一上来就清空，然后整屏白等 44~350ms，数据到了再一次性
  // 全画出来 —— 视觉上是"闪现"，眼睛要重新找位置，看久了累。
  // 骨架格跟真格子同尺寸同位置，所以数据到位时是**原地换内容**，布局不跳。
  // 这跟虚拟滚动不冲突：骨架本来也只画一屏。
  const showSkeleton = () => {
    releasePool();
    recalcCellW();
    const w = Math.max(80, scroll.clientWidth - 24);
    const cols = Math.max(1, Math.floor((w + GAP) / (cellW + GAP)));
    const colW = Math.floor((w - GAP * (cols - 1)) / cols);
    const rows = Math.ceil(scroll.clientHeight / (colW + GAP)) + 1;
    canvas.style.height = rows * (colW + GAP) - GAP + "px";
    const skelFrag = document.createDocumentFragment();
    for (let i = 0; i < cols * rows; i++) {
      const c = document.createElement("div");
      c.className = "mb-cell skel";
      c.style.left = (i % cols) * (colW + GAP) + "px";
      c.style.top = Math.floor(i / cols) * (colW + GAP) + "px";
      c.style.width = colW + "px";
      c.style.height = colW + "px";
      c.innerHTML = `<span class="ph"></span>`;
      skelFrag.appendChild(c);
      pool.set(-1 - i, c);          // 负键：跟真格子的索引不会撞，render 时一并清掉
    }
    canvas.appendChild(skelFrag);
  };

  const refreshBtn = mask.querySelector('[data-act="refresh"]');
  const setRefreshBusy = (on) => {
    refreshBtn.disabled = on;
    setIco(refreshBtn, "lucide--refresh-cw", on ? "spin" : "");
    refreshBtn.title = on
      ? t("正在重新扫盘…")
      : t("重新扫一遍当前目录（出片后点这里，不会自动盯盘）");
  };
  // 把「一份列表结果」摊到界面上。load 和后台刷新都走它，免得两处各写一遍。
  const applyList = (got, first) => {
    rawFiles = got.files;                   // 原样留一份，类型筛在 render 里做
    dims = got.dims || {}; times = got.times || {};
    elapsed = got.elapsed || {}; duration = got.duration || {};
    items = [
      ...got.dirs.filter((d) => d.count > 0).map((d) => ({ type: "dir", ...d })),
      ...got.files.map((f) => ({ type: "img", path: f })),
    ];
    buildKinds();
    render(first);
  };

  let loadSeq = 0;
  const load = async (opts) => {
    // 范围或目录一变，旧路径就不能继续留在批量操作栏；否则同名相对路径会落到新根上。
    selected.clear();
    syncSelection();
    // 目录、排序和后台核对共用一个序号；只有最后发起的请求能更新当前窗口。
    const seq = ++loadSeq;
    const currentLoad = () => seq === loadSeq && mask.isConnected;
    const refresh = !!opts?.refresh;
    const scoped = !favMode() && !recentMode();
    let lk = scoped ? listKey(realRoot(), cwd, rec.checked, sortSel.value) : null;
    const cached = (!refresh && lk) ? LIST_MEM.get(lk) : null;
    stat.textContent = refresh ? t("重新扫描…") : t("载入中…");
    setRefreshBusy(refresh);
    drawCrumb();
    // 有上次的结果就直接画上去，别先闪一屏骨架 —— 那正是「又要等一下」的观感来源
    if (cached) {
      applyList(cached, firstLoad);
      firstLoad = false;
      // 后台核对一遍：目录真变了才重画，没变就当无事发生
      listDir(realRoot(), cwd, rec.checked, sortSel.value, false, panelAbort?.signal).then((fresh) => {
        if (!currentLoad()) return;
        listRemember(lk, fresh);
        if (!listSame(cached, fresh)) {
          // 元数据补全可以重排格子，但不能把正在浏览的位置跳回顶部。
          const top = scroll.scrollTop;
          applyList(fresh, false);
          scroll.scrollTop = top;
          paint();
          syncToTop();
        }
      }).catch((e) => {
        if (!currentLoad()) return;
        if (e?.name === "AbortError") return;
        if (cwd && isMissingDirError(e)) {
          // 缓存只是为了先出画面，不能掩盖目录已被外部删除；直接回真实根并绕开旧缓存。
          const gone = cwd;
          cwd = "";
          memo.cwd = "";
          memo.scroll = 0;
          LIST_MEM.delete(lk);
          savePlace(memoKey, browseRoot, "", browseRoot);
          flash(t("上次的「{path}」已经不在了，已回到 {root}。被删或改名就会这样，点范围或面包屑另选。", {
            path: gone, root: sel.value,
          }));
          void load({ refresh: true });
          return;
        }
        const msg = isServiceDownError(e)
          ? t("ComfyUI 服务不可用。列表和缩略图都要后端还在。")
          : t("🔴 读不出来：{msg}", { msg: t(e.message) });
        stat.textContent = msg;
        if (isServiceDownError(e)) flash(msg);
      });
      return;
    }
    showSkeleton();
    try {
      // 收藏 / 最近是本地名单，不扫盘，所以拿不到时间和耗时 —— 清空，别显示上个目录的。
      // 但 dims 故意**留着**：瀑布流要靠宽高比排版，刚才逛过的那些正好有。
      // 名单里没见过的会落空，那时格子按缩略图的 naturalWidth 自己校正（fixRatio）。
      let result;
      if (favMode()) {
        result = { dirs: [], files: [...favSet(realRoot())],
                   dims, times: {}, elapsed: {}, duration: {} };
      } else if (recentMode()) {
        result = { dirs: [], files: (readRecent()[realRoot()] || []),
                   dims, times: {}, elapsed: {}, duration: {} };
      } else {
        let got;
        try {
          got = await listDir(realRoot(), cwd, rec.checked, sortSel.value, refresh, panelAbort?.signal);
        } catch (e) {
          if (!currentLoad()) return;
          if (!cwd || !isMissingDirError(e)) throw e;
          const gone = cwd;
          cwd = "";
          memo.cwd = "";
          memo.scroll = 0;
          savePlace(memoKey, browseRoot, "", browseRoot);
          drawCrumb();
          lk = listKey(realRoot(), "", rec.checked, sortSel.value);
          got = await listDir(realRoot(), "", rec.checked, sortSel.value, refresh, panelAbort?.signal);
          if (!currentLoad()) return;
          flash(t("上次的「{path}」已经不在了，已回到 {root}。被删或改名就会这样，点范围或面包屑另选。", {
            path: gone, root: sel.value,
          }));
        }
        if (!currentLoad()) return;
        if (lk) listRemember(lk, got);
        result = got;
      }
      if (!currentLoad()) return;
      applyList(result, firstLoad);
      firstLoad = false;
      if (refresh) flash(t("已重新扫描 · {n} 个文件", { n: result.files.length }));
    } catch (e) {
      if (!currentLoad()) return;
      if (e?.name === "AbortError") return;
      const msg = isServiceDownError(e)
        ? t("ComfyUI 服务不可用。列表和缩略图都要后端还在。")
        : t("🔴 读不出来：{msg}", { msg: t(e.message) });
      stat.textContent = msg;
      // 骨架格不是失败态。服务断了还留着会让人以为目录正在加载。
      releasePool();
      canvas.style.height = "auto";
      canvas.innerHTML = `<div class="mb-empty">${escHtml(msg)}</div>`;
    } finally {
      if (refresh && currentLoad()) setRefreshBusy(false);
    }
  };

  let searchT = null;
  input.oninput = () => { clearTimeout(searchT); searchT = setTimeout(() => render(false), 160); };
  const applyScope = () => {
    const v = sel.value;
    if (!v) return;
    // 选了钉住的目录：拆回根 + 路径。下拉仍显示那个根，所以再点 input/output/temp
    // 必须也能回到根 —— 见下面 mousedown 把当前项取消选中，同项再点才会触发 change。
    if (v.startsWith("@pin:")) {
      const rest = v.slice(5);
      const i = rest.indexOf(":");
      const next = scopeWithRoot({ root: browseRoot, mode: scopeMode, cwd }, rest.slice(0, i), rest.slice(i + 1));
      browseRoot = next.root;
      scopeMode = next.mode;
      cwd = next.cwd;
      sel.value = browseRoot;
    } else if (v === "@fav" || v === "@recent") {
      const next = scopeWithMode({ root: browseRoot, mode: scopeMode, cwd }, v);
      browseRoot = next.root;
      scopeMode = next.mode;
      cwd = next.cwd;
      // 原生下拉只负责目录；虚拟视图由旁边的常驻入口显示当前状态。
      sel.value = browseRoot;
    } else {
      const next = scopeWithRoot({ root: browseRoot, mode: scopeMode, cwd }, v);
      browseRoot = next.root;
      scopeMode = next.mode;
      cwd = next.cwd;
    }
    syncScopeButtons();
    delete sel.dataset.resume;
    memo.scroll = 0;
    load();
  };
  sel.onchange = applyScope;
  sel.addEventListener("mousedown", () => {
    if (sel.value !== "input" && sel.value !== "output" && sel.value !== "temp") return;
    sel.dataset.resume = sel.value;
    sel.selectedIndex = -1;
  });
  sel.addEventListener("blur", () => {
    if (sel.dataset.resume && !sel.value) sel.value = sel.dataset.resume;
    delete sel.dataset.resume;
  });
  rec.onchange = () => {
    save(REC_KEY, rec.checked ? "1" : "0");
    memo.scroll = 0;
    load();
  };
  sortSel.onchange = () => {
    save(SORT_KEY, sortSel.value);
    memo.scroll = 0;
    load();
  };
  refreshBtn.onclick = () => load({ refresh: true });

  const visibleMedia = () => {
    const out = [];
    for (const [, el] of pool) {
      const path = el.dataset.path;
      if (!path) continue;
      const k = kindOf(path);
      if (k === "audio" || k === "other") continue;
      out.push({ el, path, kind: k });
    }
    return out;
  };
  const applyLocalCaches = () => {
    if (censorMode !== "local") {
      // 退出局部模式：等待态必须清干净，否则原图 / 全幅下还糊着一批
      for (const el of scroll.querySelectorAll(".mb-cell.censor-wait")) {
        el.classList.remove("censor-wait");
      }
      return;
    }
    for (const { el, path } of visibleMedia()) {
      if (isMarked(path) || isSkipDetect(path)) {
        // 整张糊有自己的 .blurred；跳过河蟹是「这张不用管」——两种都不该再挂等待态
        el.classList.remove("censor-wait");
        el.querySelector(".mb-censor-layer")?.remove();
        continue;
      }
      const rec = regionMem.get(regionKey(realRoot(), path));
      if (rec?.boxes) {
        el.classList.remove("censor-wait");     // 框到了，从「先糊着」换成精确遮蔽
        paintCensorOverlay(el, rec.boxes, dims[path], masonry, censorRuleFor(realRoot(), path));
        if (filterClientBoxes(rec.boxes).length) attachPeekBtn(el);
      } else if (censorWaitBlurs()) {
        // 还没有框：先按全幅糊着，别把原图亮在那儿等检测（见 CENSOR_WAIT_KEY 的注释）
        el.classList.add("censor-wait");
        attachPeekBtn(el);                      // 想看就点眼睛，随时能揭开
      } else {
        // 设成「先显示原图」：什么都不做，框到了自然会盖上去
        el.classList.remove("censor-wait");
      }
    }
    updateUnhitHint();
  };
  // 真正在视口里的媒体，**按看到的顺序**（从上到下、同排从左到右）。
  //
  // 为什么不能直接用 visibleMedia()：
  //  ① pool 是渲染池，含视口上下各 BUF 个格子高的预加载缓冲 —— 那些图用户根本没看见，
  //     却会被算进「眼前 N 张」并真的跑一遍检测（检测是 GPU 活，不是白拿的）。
  //  ② pool 是 Map，遍历按**插入顺序**。paint() 滚动时是「删掉滚出去的、追加滚进来的」，
  //     几轮之后顺序就跟视觉位置完全对不上 —— 表现为「点了局部，但不是从我看到的
  //     第一张开始打」。
  // 画缓存框（applyLocalCaches）和预取（hydrateCacheOnly）仍然用 visibleMedia()：
  // 那两件事**就该**覆盖缓冲区，滚进来时才不会白一下。
  const mediaInView = () => {
    const top = scroll.scrollTop;
    const bot = top + scroll.clientHeight;
    const out = [];
    for (const [i, el] of pool) {
      const path = el.dataset.path;
      if (!path) continue;
      const k = kindOf(path);
      if (k === "audio" || k === "other") continue;
      const p = placed[i];
      if (!p || p.y >= bot || p.y + p.h <= top) continue;
      out.push({ el, path, kind: k, y: p.y, x: p.x });
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x);
    return out;
  };
  const unhitVisible = () => mediaInView().filter(({ path }) => {
    if (isSkipDetect(path)) return false;
    const rec = regionMem.get(regionKey(realRoot(), path));
    return !rec || rec.reason === "no_cache" || rec.reason === "failed";
  });
  // 检测入口钉在「局部」右侧，写在模板里，切档也不拆。
  // 脸上只有图标：进度和说明进 tooltip，跑起来角上漏一个点。
  // 它是检测的**唯一**入口 —— 底部提示条只做陈述，不再可点。
  const syncDetectBtn = () => {
    const btn = mask.querySelector(".mb-detect");
    if (!btn) return;
    mask.querySelector(".mb-local-hit")?.classList.toggle("on", censorMode === "local");
    btn.onclick = () => { if (inferBusy) inferAbort?.abort(); else startInfer(); };
    if (inferBusy) {
      btn.classList.add("busy");
      btn.disabled = false;
      const tip = t("检测中 {done}/{total}，点一下取消。已检完的留着，没检的还在原地。",
        { done: inferDone, total: inferTotal });
      btn.title = tip;
      btn.setAttribute("aria-label", tip);
      // 触屏没有悬停，进度不能只藏在 tooltip 里；底栏跟图标说明用同一句话。
      if (mask.isConnected) {
        hint.textContent = inferDone === 0
          ? t("正在加载检测模型（只打眼前这一屏）…")
          : tip;
      }
      return;
    }
    btn.classList.remove("busy");
    if (censorMode !== "local") {
      btn.disabled = true;
      const tip = t("先点「局部」，再点这个图标检测眼前这一屏。检测不会自动跑。");
      btn.title = tip;
      btn.setAttribute("aria-label", tip);
      return;
    }
    const n = unhitVisible().length;
    btn.disabled = n === 0;
    const tip = n
      ? t("检测眼前看得见的 {n} 张，标出要遮的部位。结果存下来，同一张图不会再检第二次。不检整个文件夹。", { n })
      : t("眼前这一屏都检测过了。滚到没检过的图，这里会自己亮起来。");
    btn.title = tip;
    btn.setAttribute("aria-label", tip);
  };
  const updateUnhitHint = () => {
    if (censorMode !== "local" || inferBusy || !mask.isConnected) return;
    syncDetectBtn();                    // 数量变了，图标说明要跟上
    if (preloadBusy) return;
    const n = unhitVisible().length;
    hint.textContent = n
      ? t("眼前还有 {n} 张没检测（不是整个文件夹）", { n })
      : t("眼前这一屏都已检测");
  };
  // signal 必须由调用方显式传进来，不能在这里读全局 inferAbort ——
  // 那个变量会被下一轮检测换掉，读它等于「用别人的取消信号」。
  const fetchOne = async (path, infer, force = false, signal = null) => {
    const k = regionKey(realRoot(), path);
    if (force) regionMem.delete(k);
    try {
      const u = `/mediabrowser/regions?filename=${encodeURIComponent(path)}` +
        `&type=${encodeURIComponent(realRoot())}&infer=${infer ? 1 : 0}` +
        (force ? "&force=1" : "");
      const r = await fetch(u, signal ? { signal } : {});
      const j = await r.json().catch(() => null);
      if (r.status === 404 && !(j && (j.error || j.reason || j.boxes !== undefined))) {
        return { boxes: null, reason: "no_backend" };
      }
      if (!j) {
        regionMem.set(k, { boxes: null, reason: "failed" });
        return regionMem.get(k);
      }
      if (!r.ok && j.boxes === undefined) {
        const rec = { boxes: null, reason: j.reason || (j.error === "文件不存在" ? "missing" : "failed") };
        regionMem.set(k, rec);
        return rec;
      }
      regionMem.set(k, j);
      return j;
    } catch (e) {
      if (e.name === "AbortError") return null;
      regionMem.set(k, { boxes: null, reason: "failed" });
      return regionMem.get(k);
    }
  };
  const hydrateCacheOnly = async () => {
    if (censorMode !== "local") return;
    const miss = visibleMedia().filter(({ path }) =>
      !isSkipDetect(path) && !regionMem.has(regionKey(realRoot(), path)));
    for (const { path } of miss) {
      if (!mask.isConnected) return;
      const rec = await fetchOne(path, false, false, panelAbort.signal);
      if (rec?.reason === "no_backend") {
        flash(t("局部接口是 404：必须关掉 Comfy 的 Python 窗口再启动，只刷新网页不够"));
        return;
      }
    }
    if (mask.isConnected) applyLocalCaches();
  };
  // 重新检测这一张。
  //
  // ⚠️ 检测是**确定性**的：同一张图 + 同一个模型 → 必然同样的框。
  //    所以「点了没变化」是常态，不是坏了。但用户点它时想的往往是
  //    「让它打得更狠」—— 那是**两件事**：
  //      重检   = 重新跑模型（换了模型 / 上次失败 / 之前跳过 才有意义）
  //      打更狠 = 改过滤（阈值和部位，都是前端的事，框早就在缓存里）
  //    所以这里必须**报出结果有没有变**，没变时把人指到真正的旋钮上，
  //    否则用户只会反复点同一个按钮等一个永远不会来的不同结果。
  const redoOne = async (path, el) => {
    const rule0 = censorRuleFor(realRoot(), path);
    const before = filterClientBoxes(
      regionMem.get(regionKey(realRoot(), path))?.boxes, rule0).length;
    const hadRec = regionMem.has(regionKey(realRoot(), path));
    if (isSkipDetect(path)) {
      toggleSkipDetect(realRoot(), path);
      if (el) paintSkipOnCell(el, path, false);
      flash(t("已取消跳过河蟹，开始检测这一张"));
    }
    el?.classList.add("detecting");
    const rec = await fetchOne(path, true, true);
    el?.classList.remove("detecting");
    if (!mask.isConnected || !rec) return;
    if (el) syncRedoOnCell(el, path);
    if (rec.reason === "no_backend") {
      flash(t("局部接口是 404：必须关掉 Comfy 的 Python 窗口再启动，只刷新网页不够"));
      return;
    }
    if (rec.reason === "no_runtime" || rec.reason === "no_weights") {
        flash(rec.reason === "no_runtime"
        ? t("还没装检测运行时。打开右上角设置，在 Comfy 的 Python 环境装 onnxruntime")
        : t("还没有检测模型。打开右上角设置下载或指定本机文件"));
      openSettings();
      return;
    }
    if (el && censorMode === "local" && !isMarked(path)) {
      if (rec.boxes) paintCensorOverlay(el, rec.boxes, dims[path], masonry, censorRuleFor(realRoot(), path));
      else el.querySelector(".mb-censor-layer")?.remove();
      if (filterClientBoxes(rec.boxes).length) attachPeekBtn(el);
    }
    const n = filterClientBoxes(rec.boxes, censorRuleFor(realRoot(), path)).length;
    if (censorMode !== "local") {
      flash(n ? t("已重新检测。切到「局部」才能看到框") : t("重新检测过了，这张没有要遮的部位"));
      return;
    }
    if (!n) {
      flash(t("重新检测过了，这张没有要遮的部位"));
      return;
    }
    if (hadRec && n === before) {
      // 说清「为什么点了跟没点一样」，并给出真正的出路 —— 否则只会被反复点
      flash(t("重新检测完成：还是这 {n} 处，跟上次一样。检测是确定的，同一张图同一个模型就是同样结果 —— 想遮更多请右键这张选「更严」", { n }));
      return;
    }
    flash(t("已重新检测这一张：{n} 处", { n }));
  };
  // 右键某一张 → 这一条目的上下文菜单。
  //
  // ⚠️ 这是**通用菜单**，不是某个功能的专用面板。右键一个条目 = 打开它的菜单，
  //    是几乎所有软件的共识；把这个位置占给单一功能，以后想加
  //    「在资源管理器中显示」「复制路径」就没地方放了，而且没人会为了找
  //    某个窄功能去右键。加新条目只要往 items 数组里塞一项。
  //
  // 眼下装的是「遮蔽」这一组：三档力度 + 重检 / 跳过 / 整张糊。
  // 后两个原来只是 hover 才出现的角标，小格子里很难点中 —— 收进菜单等于给了它们
  // 一个稳定的落点。底栏那 7 个按钮在最小档下会堆成 3 行、吃掉整格 98% 的高度
  // （见 syncSize 的注释），将来可以往这里挪。
  // 浮层外壳：标题栏、摆位、拖动。「⋯」菜单和遮蔽面板共用同一套，
  // 免得大图那边再抄一遍（抄一遍就意味着以后要改两处）。
  // anchor 决定摆在哪儿；用户自己拖过之后就不再自动摆，拖到哪算哪。
  const makePopShell = (anchor, title, onBack) => {
    pop = document.createElement("div");
    pop.className = "mb-pop mb-cellmenu";
    document.body.appendChild(pop);
    armPopDismiss(pop);
    let moved = false;
    const reposition = () => {
      if (moved || !pop?.isConnected) return;
      const r = anchor.getBoundingClientRect();
      const q = placeAsidePop(pop.offsetWidth, pop.offsetHeight, r,
                              window.innerWidth, window.innerHeight);
      pop.style.left = q.left + "px";
      pop.style.top = q.top + "px";
    };
    // 标题栏是**关掉的出口**：浮层会摆到浏览窗口外面去，
    // 少了它就只剩「点到格子区」一条路，点别处根本关不掉。
    // 它也是最好拖的地方（拖动跳过 button，所以 × 和返回不会误触发拖拽）。
    const head = (ttl, back) =>
      `<div class="hd">` +
      (back ? `<button type="button" class="back" title="${escHtml(t("返回上一层"))}">` +
              `${mbIco("lucide--chevron-left")}</button>` : "") +
      `<span class="fn" title="${escHtml(ttl)}">${escHtml(ttl)}</span>` +
      `<button type="button" class="x" title="${escHtml(t("关掉这个浮层"))}">${mbIco("lucide--x")}</button></div>`;
    const wireHead = (back) => {
      pop.querySelector(".hd .x").onclick = closePop;
      const bk = pop.querySelector(".hd .back");
      if (bk) bk.onclick = back;
    };
    // 拖动：按住空白处拖。交互元素不参与，否则点一下菜单项就被当成拖拽起手。
    // 挂在 pop 上而不是内容上：换页会重写 innerHTML，挂内容上就丢了。
    const DRAG_SKIP = "button, input, label, summary, a, select";
    pop.onmousedown = (e) => {
      e.stopPropagation();
      if (e.button !== 0 || e.target.closest(DRAG_SKIP)) return;
      const r = pop.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const onMove = (m) => {
        moved = true;
        pop.classList.add("dragging");
        // 夹在视口内：拖出屏幕就再也抓不回来了
        const l = Math.max(0, Math.min(window.innerWidth - r.width, m.clientX - dx));
        const tp = Math.max(0, Math.min(window.innerHeight - r.height, m.clientY - dy));
        pop.style.left = l + "px";
        pop.style.top = tp + "px";
      };
      const onUp = () => {
        pop.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    };
    return { head, wireHead, reposition };
  };

  // 遮蔽面板：格子的「⋯」菜单和大图底栏**共用同一份**。
  // cell 可能没有（从大图进来），凡是要动格子的地方都判空。
  // onBack 有值就显示返回键（从「⋯」菜单进来）；大图是直接进来的，没有上一层。
  const openCensorPanel = (path, anchor, { cell = null, onBack = null, onChange = null } = {}) => {
    teardownPopDom();
    const root = realRoot();
    const shell = makePopShell(anchor, t("遮蔽"), onBack);
    const customSet = () => {
      const cur = censorOneOf(root, path);
      return Array.isArray(cur) ? new Set(cur) : null;
    };
    const partsHtml = () => CENSOR_LABEL_GROUPS.map(([gname, labs]) =>
      `<div class="pg"><i>${escHtml(t(gname))}</i>` +
      labs.map((L) =>
        `<label><input type="checkbox" data-p="${L}"` +
        `${(customSet() || censorLabels()).has(L) ? " checked" : ""}>` +
        `<span>${escHtml(t(CENSOR_LABEL_NAME[L] || L))}</span></label>`).join("") +
      `</div>`).join("");
    const rec = regionMem.get(regionKey(root, path));

    // 缩略图与大图分别绘制，修改单图规则后两处都必须刷新。
    const refreshCensor = () => {
      applyLocalCaches();
      onChange?.();
    };

    const setLevel = (nv) => {
      setCensorOne(root, path, nv);
      refreshCensor();
      flash(nv ? t("这张已单独设。其它图不受影响") : t("这张改回跟随全局设置"));
    };

    // 「操作」跟悬停操作条是**同一份清单**（cellActionsFor），不是另抄一遍。
    // 触屏没有悬停，这里就是它够到全部操作的唯一入口。
    // 四条滑块都从 CENSOR_TUNE_FIELDS 生成 —— 加一条只改那张表，这里不用动。
    // 分「判定 / 画法」两小组：调错组是这里最容易犯的错 ——
    // 想让框画大一点却去动灵敏度，只会多冒出几个框，原来那个还是那么小。
    const tuneHtml = (cur) => {
      const dirty = CENSOR_TUNE_FIELDS.some((f) => cur[f.key] != null);
      let html = `<div class="tune"><div class="grp">${escHtml(t("只改这一张"))}` +
        (dirty ? `<button type="button" class="reset">${escHtml(t("改回跟随全局"))}</button>` : "") +
        `</div>`;
      let lastGroup = "";
      for (const f of CENSOR_TUNE_FIELDS) {
        if (f.group !== lastGroup) {
          lastGroup = f.group;
          html += `<div class="sub">${escHtml(f.group === "判定"
            ? t("判定：哪些框够格被遮") : t("画法：每个框画多大、多糊"))}</div>`;
        }
        const on = cur[f.key] != null;
        const val = on ? cur[f.key] : f.of();
        html += `<label class="mb-set-field"><div class="lab">` +
          `<span>${escHtml(t(f.lab))}</span>` +
          `<b data-v="${f.key}">${escHtml(f.fmt(val))}` +
          `${on ? "" : escHtml(t("（跟随全局）"))}</b></div>` +
          `<input type="range" data-tune="${f.key}" min="${f.min}" max="${f.max}" ` +
          `value="${Math.round(val * f.scale)}"></label>`;
      }
      return html + `</div>`;
    };

    function render() {
      const v2 = censorOneOf(root, path);
      const custom2 = Array.isArray(v2) ? new Set(v2) : null;
      const tuneNow = censorTuneOf(root, path) || {};
      const rows = [
        { lab: t("跟随全局设置"), on: !v2, act: () => setLevel("") },
        { lab: t("这张更严（放宽灵敏度 + 加上「隔着衣服」）"), on: v2 === "more", act: () => setLevel("more") },
        { lab: t("这张最严（所有部位都遮）"), on: v2 === "max", act: () => setLevel("max") },
      ];
      // ⚠️ 「重新检测」只在**真能做事**时才出现。缓存键含 mtime+size+model_id+权重大小，
      //    换文件、换模型都会自动失效，根本不用手点。剩下真正有用的只有两种：
      //    上次失败了、这张被跳过了。其余情况它可证明是空跑（同图同模型必然同结果），
      //    常显一个「点了必然没变化」的按钮，只会让人反复点、以为坏了。
      const tail = [];
      if (isSkipDetect(path)) {
        tail.push({ lab: t("取消跳过并检测这一张"), act: () => redoOne(path, cell) });
      } else {
        tail.push({ lab: t("跳过河蟹（批量检测略过它）"), act: () => setSkipOnPath(path) });
        if (rec && rec.reason === "failed") {
          tail.push({ lab: t("重试检测（上次失败了）"), act: () => redoOne(path, cell) });
        }
      }
      tail.push({
        lab: isMarked(path) ? t("取消整张糊") : t("整张糊（不看检测框）"),
        act: () => {
          // toggleBlurMark 返回**切换后**的状态，paintLockOnCell 靠它决定画成什么样
          const on = toggleBlurMark(root, path);
          applyLocalCaches();
          if (cell) paintLockOnCell(cell, path, on);   // 从大图进来时没有格子
        },
      });
      const all = [...rows, null, ...tail];
      pop.innerHTML = shell.head(t("遮蔽"), !!onBack) + `<div class="bd">` +
        all.map((o, i) => (o === null ? `<div class="sep"></div>`
          : `<button type="button" class="mi${o.on ? " on" : ""}" data-i="${i}">` +
            `<i class="mb-ico"></i><span class="tx"><span class="l">${escHtml(o.lab)}</span>` +
            `</span></button>`)).join("") +
        tuneHtml(tuneNow) +
        `<details class="parts"${custom2 ? " open" : ""}>` +
        `<summary>${escHtml(t("这张单独选部位…"))}` +
        (custom2 ? `<button type="button" class="preset">${escHtml(t("改回跟随全局"))}</button>` : "") +
        `</summary>` +
        `<div class="pbox">${partsHtml()}` +
        `<p class="hint">${escHtml(t("勾了就按检测到的全给你，不再受全局灵敏度限制。"))}</p>` +
        `</div></details></div>`;
      shell.wireHead(onBack);
      for (const b2 of pop.querySelectorAll(".mi[data-i]")) {
        b2.onclick = async (ev) => {
          ev.preventDefault();
          const o = all[+b2.dataset.i];
          if (!o) return;
          closePop();
          await o.act();
          refreshCensor();
        };
      }
      // 勾部位：改完立刻生效，浮层留着让你接着调 —— 每勾一下就关掉太难用
      for (const cb of pop.querySelectorAll(".pbox input")) {
        cb.onchange = () => {
          const on = [...pop.querySelectorAll(".pbox input")]
            .filter((x) => x.checked).map((x) => x.dataset.p);
          setCensorOne(root, path, on.length ? on : "");
          refreshCensor();
          for (const b3 of pop.querySelectorAll(".mi")) b3.classList.remove("on");
          // 「改回跟随全局」这个出口该出现/该消失时才重画。
          // 不能每勾一下都重画 —— 那会把展开的部位面板折回去、焦点也丢了；
          // 但完全不重画，第一次勾完就看不到退回的出口，只能关掉重开才发现有（实测踩过）。
          const need = on.length > 0;
          if (need !== !!pop.querySelector(".parts .preset")) render();
        };
      }
      // 拖的时候就生效，浮层留着接着调 —— 每动一下就关掉没法用
      for (const f of CENSOR_TUNE_FIELDS) {
        const el = pop.querySelector(`[data-tune="${f.key}"]`);
        if (!el) continue;
        el.oninput = () => {
          const val = +el.value / f.scale;
          setCensorTune(root, path, { [f.key]: val });
          const b = pop.querySelector(`[data-v="${f.key}"]`);
          if (b) b.textContent = f.fmt(val);
          refreshCensor();
          // 从「跟随全局」变成「已单独设」了，把重置钮摆出来
          if (!pop.querySelector(".tune .reset")) render();
        };
      }
      // 自选部位的退回：清掉这张的档位/名单（跟点上面那行「跟随全局设置」等价，
      // 但摆在勾选框旁边才找得到）
      const pr = pop.querySelector(".parts .preset");
      if (pr) pr.onclick = (ev) => {
        ev.preventDefault();          // 它在 <summary> 里，不拦住会顺手折叠/展开
        ev.stopPropagation();
        setCensorOne(root, path, "");
        refreshCensor();
        render();
      };
      const rst = pop.querySelector(".tune .reset");
      if (rst) rst.onclick = () => {
        const clear = {};
        for (const f of CENSOR_TUNE_FIELDS) clear[f.key] = null;
        setCensorTune(root, path, clear);
        refreshCensor();
        render();
      };
      // 展开/收起会改高度，重新摆一次，否则会长出屏幕
      pop.querySelector(".parts")?.addEventListener("toggle", shell.reposition);
      shell.reposition();
    }

    render();
  };

  // 「⋯」菜单：一级动作宫格。跟悬停操作条是**同一份清单**（cellActionsFor），
  // 不是另抄一遍 —— 触屏没有悬停，这里就是够到全部操作的唯一入口。
  // 遮蔽是「少数图才要调」的进阶项，摊在一级里会把常用动作挤下去（小屏上要滚半天），
  // 所以收成一个入口，点进去是 openCensorPanel。
  const openCellMenu = (it, cell) => {
    teardownPopDom();
    const path = it.path;
    const actions = cellActionsFor(it, cell);
    const short = baseName(path);
    const shell = makePopShell(cell, short, null);

    // 一格 = 图标 + 一行短名。完整叫法和「点了会怎样」进 tooltip ——
    // ⚠️ 短名不能省成纯图标：触屏没有悬停，看不到 tooltip，只剩图标就只能猜。
    const tileHtml = (o, i) =>
      `<button type="button" class="tile${o.on ? " on" : ""}${o.cls ? " " + o.cls : ""}" data-i="${i}"` +
      ` title="${escHtml(o.lab + (o.effect ? "：" + o.effect : ""))}">` +
      mbIco(o.ico) + `<span>${escHtml(o.short || o.lab)}</span></button>`;

    function renderMain() {
      pop.innerHTML = shell.head(short, false) +
        `<div class="grid">` +
        actions.map(tileHtml).join("") +
        (canCensor(path)
          ? `<button type="button" class="tile more" data-more="1"` +
            ` title="${escHtml(t("这一张的遮蔽力度、跳过、整张糊都在里面"))}">` +
            mbIco("lucide--ban") + `<span>${escHtml(t("遮蔽"))}</span>` +
            `<i class="arrow mb-ico">${mbIco("lucide--chevron-right")}</i></button>`
          : "") +
        `</div>`;
      shell.wireHead(null);
      for (const b2 of pop.querySelectorAll(".tile[data-i]")) {
        b2.onclick = (ev) => {
          ev.preventDefault();
          const o = actions[+b2.dataset.i];
          closePop();
          o.act();
        };
      }
      const more = pop.querySelector("[data-more]");
      if (more) {
        more.onclick = () => openCensorPanel(path, cell,
          { cell, onBack: () => openCellMenu(it, cell) });
      }
      shell.reposition();
    }

    renderMain();

  };

  const startInfer = async () => {
    if (censorMode !== "local") return;
    // 必须把控制器捕获成局部变量：循环里如果判断全局 inferAbort，
    // 那么「再点一次局部」换掉全局之后，**旧循环读到的是新控制器**，
    // 永远不为 aborted，于是两个检测循环并行跑 —— 进度条在两个计数之间跳，
    // inferBusy 被先跑完的那个置 false。
    const ac = new AbortController();
    inferAbort?.abort();
    inferAbort = ac;
    const batch = unhitVisible();
    if (!batch.length) {
      flash(t("眼前这一屏都已检测。滚到没检过的图，再点局部旁边的扫描图标"));
      updateUnhitHint();
      return;
    }
    inferBusy = true;
    inferDone = 0;
    inferTotal = batch.length;
    syncDetectBtn();            // 立刻漏点，别让人以为没反应
    // 同时开几张：解码下一张和推理这一张可以叠。session.run 后端仍然串行，
    // 所以默认 2 就够；设置里能改成 1（弱机）或 3/4。
    let next = 0;
    let fatal = false;
    const applyOne = (el, path, rec) => {
      if (el) syncRedoOnCell(el, path);
      if (!mask.isConnected) return "dead";
      if (rec?.reason === "no_backend") {
        flash(t("局部接口是 404：必须关掉 Comfy 的 Python 窗口再启动，只刷新网页不够"));
        return "fatal";
      }
      if (rec?.reason === "no_runtime" || rec?.reason === "no_weights") {
        flash(rec.reason === "no_runtime"
          ? t("还没装检测运行时。打开右上角设置，在 Comfy 的 Python 环境装 onnxruntime")
          : t("还没有检测模型。打开右上角设置下载或指定本机文件"));
        openSettings();
        return "fatal";
      }
      if (rec?.boxes && !isMarked(path)) {
        el.classList.remove("censor-wait");
        paintCensorOverlay(el, rec.boxes, dims[path], masonry, censorRuleFor(realRoot(), path));
        if (filterClientBoxes(rec.boxes).length) attachPeekBtn(el);
      } else if (rec && !rec.boxes && rec.reason !== "failed") {
        el.classList.remove("censor-wait");
      }
      return "ok";
    };
    const worker = async () => {
      while (!fatal) {
        if (ac.signal.aborted) return;
        if (inferAbort !== ac) return;
        const i = next++;
        if (i >= batch.length) return;
        const { el, path } = batch[i];
        if (isSkipDetect(path)) {
          inferDone++;
          syncDetectBtn();
          continue;
        }
        el.classList.add("detecting");
        const rec = await fetchOne(path, true, false, ac.signal);
        el.classList.remove("detecting");
        // await 期间可能切档、取消或开始新批次；旧请求不得再画框或修改新进度。
        if (inferAbort !== ac) return;
        if (ac.signal.aborted) return;
        const st = applyOne(el, path, rec);
        if (st !== "ok") {
          fatal = true;
          ac.abort();
          return;
        }
        inferDone++;
        syncDetectBtn();
      }
    };
    const n = Math.min(batch.length, censorConcur());
    await Promise.all(Array.from({ length: n }, () => worker()));
    if (inferAbort === ac) {
      inferBusy = false;
      if (mask.isConnected) {
        if (preloadBusy) syncPreloadBtn();
        else updateUnhitHint();
      }
    }
  };
  const syncCensorSeg = () => {
    mask.querySelectorAll("[data-censor]").forEach((b) => {
      b.classList.toggle("on", b.dataset.censor === censorMode);
    });
  };
  const setCensorMode = (m) => {
    if (m !== "off" && m !== "full" && m !== "local") return;
    const prev = censorMode;
    censorMode = m;
    save(CENSOR_KEY, m);
    syncCensorSeg();
    releasePool();
    paint();
    // 切进局部**不再**自动开检 —— 检测是「点一下才执行」，按钮就在旁边。
    // 切出局部要把正在跑的那轮停掉：结果已经落盘，白跑的只是电。
    if (m !== "local") { inferAbort?.abort(); inferBusy = false; }
    syncDetectBtn();
    if (m === "local") updateUnhitHint();
  };
  syncCensorSeg();
  syncDetectBtn();
  mask.querySelectorAll("[data-censor]").forEach((b) => {
    b.onclick = () => {
      setCensorMode(b.dataset.censor);   // 只切档；检测是隔壁那个按钮的事
    };
  });

  const ensureLocal = async (path, force = false) => {
    if (isSkipDetect(path) && !force) return { boxes: null, reason: "skipped" };
    if (isSkipDetect(path) && force) {
      toggleSkipDetect(realRoot(), path);
      for (const [, el] of pool) {
        if (el.dataset.path === path) paintSkipOnCell(el, path, false);
      }
    }
    const rec = await fetchOne(path, true, force);
    if (!mask.isConnected || !rec) return rec;
    if (censorMode === "local" && rec.boxes && !isMarked(path) && !isSkipDetect(path)) {
      for (const [, el] of pool) {
        if (el.dataset.path !== path) continue;
        paintCensorOverlay(el, rec.boxes, dims[path], masonry, censorRuleFor(realRoot(), path));
        if (filterClientBoxes(rec.boxes).length) attachPeekBtn(el);
      }
    }
    return rec;
  };
  const shotWindow = async () => {
    const br = box.getBoundingClientRect();
    const W = Math.max(1, Math.round(br.width));
    const H = Math.max(1, Math.round(br.height));
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const rr = (x, y, w, h, r) => {
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
      else { ctx.beginPath(); ctx.rect(x, y, w, h); }
    };
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - br.left, y: r.top - br.top, w: r.width, h: r.height };
    };
    ctx.save();
    rr(0, 0, W, H, 10);
    ctx.clip();
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, W, H);
    const paintStrip = (el, color) => {
      if (!el) return;
      const t = rel(el);
      ctx.fillStyle = color;
      ctx.fillRect(t.x, t.y, t.w, t.h);
    };
    paintStrip(mask.querySelector(".mb-top"), "#252525");
    paintStrip(mask.querySelector(".mb-crumbrow"), "#1c1c1c");
    paintStrip(mask.querySelector(".mb-bot"), "#252525");
    const drawLabel = (el) => {
      const t = rel(el);
      if (t.w < 4 || t.h < 4) return;
      const on = el.classList?.contains("on") || el.tagName === "INPUT" && el.checked;
      ctx.fillStyle = on ? "#2e5aa0" : "#333";
      rr(t.x, t.y, t.w, t.h, 5);
      ctx.fill();
      const text = (el.textContent || el.value || "").trim().replace(/\s+/g, " ").slice(0, 16);
      if (!text) {
        ctx.fillStyle = "#bbb";
        const s = Math.min(11, t.h * 0.36);
        ctx.fillRect(t.x + t.w / 2 - s / 2, t.y + t.h / 2 - s / 2, s, s);
        return;
      }
      ctx.fillStyle = "#ddd";
      ctx.font = `${Math.max(10, Math.min(13, t.h * 0.42))}px sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(text, t.x + 6, t.y + t.h / 2, t.w - 10);
    };
    mask.querySelectorAll(".mb-top input, .mb-top select, .mb-top button, .mb-seg button, .mb-chrome button").forEach(drawLabel);
    const crumbEl = mask.querySelector(".mb-crumb");
    if (crumbEl) {
      const t = rel(crumbEl);
      ctx.fillStyle = "#aaa";
      ctx.font = "12px sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText((crumbEl.innerText || "").replace(/\s+/g, " ").trim().slice(0, 72), t.x + 8, t.y + t.h / 2, t.w - 16);
    }
    const botEl = mask.querySelector(".mb-bot");
    if (botEl) {
      const t = rel(botEl);
      ctx.fillStyle = "#999";
      ctx.font = "12px sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(`${stat.textContent}  ${hint.textContent}`.replace(/\s+/g, " ").trim().slice(0, 90),
        t.x + 10, t.y + t.h / 2, t.w - 16);
    }
    for (const [, el] of pool) {
      const img = el.querySelector("img");
      const er = rel(el);
      if (er.y + er.h < 0 || er.y > H || er.x + er.w < 0 || er.x > W) continue;
      ctx.fillStyle = "#2a2a2a";
      rr(er.x, er.y, er.w, er.h, 6);
      ctx.fill();
      if (img?.naturalWidth) {
        drawCover(ctx, img, er.x, er.y, er.w, er.h);
        const path = el.dataset.path;
        if (censorMode === "full" || (path && isMarked(path))) {
          blurPatch(ctx, er.x, er.y, er.w, er.h, 16);
        } else if (censorMode === "local" && path) {
          const rec = regionMem.get(regionKey(realRoot(), path));
          const dim = dims[path];
          for (const b of visibleBoxes(rec?.boxes, censorRuleFor(realRoot(), path))) {
            const mapped = mapBoxToEl(b, dim?.[0] || img.naturalWidth, dim?.[1] || img.naturalHeight, er.w, er.h, masonry);
            blurPatch(ctx, er.x + mapped.x, er.y + mapped.y, mapped.w, mapped.h, 14);
          }
        }
      }
      const nm = el.querySelector(".nm");
      if (nm) {
        ctx.fillStyle = "rgba(0,0,0,.78)";
        ctx.fillRect(er.x, er.y + er.h - 18, er.w, 18);
        ctx.fillStyle = "#ddd";
        ctx.font = "10px sans-serif";
        ctx.textBaseline = "middle";
        const label = nm.querySelector(".fn")?.textContent || nm.textContent || "";
        ctx.fillText(label.slice(0, 28), er.x + 4, er.y + er.h - 9, er.w - 8);
      }
    }
    ctx.restore();
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1.5;
    rr(0.75, 0.75, W - 1.5, H - 1.5, 10);
    ctx.stroke();
    try {
      await writePng(canvasToBlob(canvas));
      flash(t("整窗已复制（含浏览外框）"));
    } catch (e) {
      const msg = e.message || t("截图失败");
      if (clipInsecure() && /剪贴板|clipboard/i.test(msg)) showClipHelp();
      else flash(msg);
    }
  };
  const shotSingle = async (path) => {
    const p = path || current;
    if (!p) { flash(t("先点开一张大图，或用节点里已经选中的那张")); return; }
    const isVid = KIND_VID.test(p);
    const slash = p.lastIndexOf("/");
    const sub = slash < 0 ? "" : p.slice(0, slash);
    const name = slash < 0 ? p : p.slice(slash + 1);
    const url = isVid
      // 同样要带 mtime —— 走的是同一个 7 天缓存，视频被覆盖后不带就会抓到旧帧
      ? `/mediabrowser/thumb?filename=${encodeURIComponent(p)}&type=${encodeURIComponent(realRoot())}&px=768` +
        `&t=${encodeURIComponent(times[p] ?? 0)}`
      : `/api/view?filename=${encodeURIComponent(name)}&subfolder=${encodeURIComponent(sub)}&type=${encodeURIComponent(realRoot())}`;
    try {
      await writePng((async () => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error(t("图加载失败")));
          img.src = url;
        });
        const max = 2048;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (Math.max(w, h) > max) {
          const s = max / Math.max(w, h);
          w = Math.round(w * s); h = Math.round(h * s);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        if (censorMode === "full" || isMarked(p)) {
          blurPatch(ctx, 0, 0, w, h, 22);
        } else if (censorMode === "local") {
          let rec = regionMem.get(regionKey(realRoot(), p));
          if (!rec) rec = await fetchOne(p, false);
          for (const b of visibleBoxes(rec?.boxes, censorRuleFor(realRoot(), p))) {
            blurPatch(ctx, b.x * w, b.y * h, b.w * w, b.h * h, 16);
          }
        }
        return canvasToBlob(canvas);
      })());
      flash(t("单图已复制"));
    } catch (e) {
      const msg = e.message || t("截图失败");
      if (clipInsecure() && /剪贴板|clipboard/i.test(msg)) showClipHelp();
      else flash(msg);
    }
  };
  mask.querySelector('[data-act="shot-box"]').onclick = () => shotWindow();

  const syncPreloadBtn = () => {
    const btn = mask.querySelector('[data-act="preload"]');
    if (!btn) return;
    if (preloadBusy) {
      if (!btn.classList.contains("busy")) {
        btn.classList.add("busy");
        setIco(btn, "lucide--loader-circle", "spin");
      }
      const tip = t("正在预加载原图 {done}/{total}。再点一次取消。浏览和看大图不受影响。",
        { done: preloadDone, total: preloadTotal });
      btn.title = tip;
      btn.setAttribute("aria-label", tip);
      if (!inferBusy && mask.isConnected) hint.textContent = tip;
      return;
    }
    btn.classList.remove("busy");
    setIco(btn, "lucide--image");
    const tip = t("预加载当前列表里的原图。会先问你一次。视频不拉。窗口不锁，再点一次取消。");
    btn.title = tip;
    btn.setAttribute("aria-label", tip);
  };
  const startPreload = async (paths) => {
    if (preloadBusy || !paths.length || !mask.isConnected) return;
    const ac = new AbortController();
    preloadAbort = ac;
    preloadWhy = "";
    preloadPaths = paths.slice();
    preloadBusy = true;
    preloadDone = 0;
    preloadTotal = paths.length;
    syncPreloadBtn();
    const rec = await runViewPreload({
      paths,
      root: realRoot(),
      fetchFn: fetch,
      signal: ac.signal,
      onProgress: ({ done, total }) => {
        if (preloadAbort !== ac) return;
        preloadDone = done;
        preloadTotal = total;
        syncPreloadBtn();
      },
    });
    if (preloadAbort !== ac) return;
    preloadBusy = false;
    preloadPaths = [];
    syncPreloadBtn();
    if (!mask.isConnected || preloadWhy === "close") return;
    const { ok, fail, cancelled, total } = rec;
    const kind = viewPreloadOutcome({ ok, fail, cancelled });
    const done = ok + fail;
    const msg = kind === "ok"
      ? t("已预加载 {n} 张原图，点开大图会直接出全图", { n: ok })
      : kind === "partial"
        ? t("预加载结束：成功 {ok} 张，失败 {fail} 张", { ok, fail })
        : kind === "fail"
          ? t("预加载没做成：{n} 张都没读进来", { n: fail || total })
          : preloadWhy === "scope"
            ? t("筛选或目录变了，预加载已停下（已完成 {done}/{total}）", { done, total })
            : t("已取消预加载（已完成 {done}/{total}）", { done, total });
    flash(msg);
  };
  const askAndStartPreload = async () => {
    if (preloadBusy) return;
    const paths = viewPreloadPaths(show);
    if (!paths.length) {
      flash(t("当前筛选里没有可预加载的图片"));
      return;
    }
    if (!await confirmPreload(paths.length, viewPreloadNeedsWarn(paths.length))) return;
    if (!mask.isConnected || preloadBusy) return;
    if (!viewPreloadSame(viewPreloadPaths(show), paths)) {
      flash(t("筛选或目录变了，预加载没开始"));
      return;
    }
    await startPreload(paths);
  };
  mask.querySelector('[data-act="preload"]').onclick = () => {
    if (preloadBusy) stopPreload("user");
    else void askAndStartPreload();
  };

  const openSettings = async (tab) => {
    clearInterval(settingsPoll);
    settingsPoll = null;
    box.querySelector(".mb-settings")?.remove();
    const lay = document.createElement("div");
    lay.className = "mb-settings";
    const raw = await fetch("/mediabrowser/censor/status").catch(() => null);
    if (!raw) {
      flash(t("连不上 Comfy。确认窗口还在跑，再打开设置"));
      return;
    }
    if (raw.status === 404) {
      flash(t("遮蔽接口是 404：现在这个 Comfy 进程启动时还没有这条路由。只刷新网页或点前端重启不够，必须关掉 Python 窗口再启动"));
      return;
    }
    if (!raw.ok) {
      flash(t("遮蔽接口返回 HTTP {status}。看 Comfy 控制台里 [MediaBrowser] 那一行", { status: raw.status }));
      return;
    }
    const st = await raw.json().catch(() => ({}));
    const rel = st.release_url || "https://github.com/notAI-tech/NudeNet/releases/tag/v3.4-weights";
    const relA = (u) => `<a href="${escHtml(u || rel)}" target="_blank" rel="noreferrer">${escHtml(t("发布页"))}</a>`;
    const thumbNow = thumbPresetOf(thumbPerCell());   // "" = 跟哪套预设都不一样
    const thumbOpts =
      (thumbNow ? "" : `<option value="" selected>${escHtml(t("自定义（下面的表被改过）"))}</option>`) +
      Object.keys(THUMB_PRESETS).map((k) =>
        `<option value="${k}"${k === thumbNow ? " selected" : ""}>${escHtml(thumbPresetLabel(k))}</option>`
      ).join("");
    const labelsNow = censorLabels();
    const labelGroups = CENSOR_LABEL_GROUPS.map(([gname, labs]) =>
      `<div class="mb-labgrp"><div class="lab">${escHtml(t(gname))}</div>` +
      labs.map((L) =>
        `<label class="mb-labchk"><input type="checkbox" data-label="${L}"` +
        `${labelsNow.has(L) ? " checked" : ""}>` +
        `<span>${escHtml(t(CENSOR_LABEL_NAME[L] || L))}</span></label>`
      ).join("") + `</div>`
    ).join("");
    const perCellNow = thumbPerCell();
    // 把「这一档的格子实际占多少物理像素」算出来摆在旁边。
    // 超过这个数的部分眼睛看不见，只是白下载 —— 与其我在背后偷偷封顶，
    // 不如把判断依据给你，你自己定。
    // 别直接显示 devicePixelRatio —— 1.65 倍屏上它是 1.6500000953674316
    const dprRaw = window.devicePixelRatio || 1;
    const dprNow = Math.round(dprRaw * 100) / 100;
    const availW = Math.max(80, scroll.clientWidth - 24);
    const perCellRows = COLS.map((n, i) => {
      const opts = THUMB_PX_VALUES.map(([v, lab]) =>
        `<option value="${v}"${+v === perCellNow[n] ? " selected" : ""}>${escHtml(t(lab))}</option>`
      ).join("");
      const cw = Math.max(MIN_CELL, Math.floor((availW - GAP * (n - 1)) / n));
      const need = Math.round(cw * dprRaw);
      return `<label class="mb-percell-row">` +
        `<span>${escHtml(t("一行 {n} 个（{size}）", { n, size: SIZE_NAME()[i] }))}` +
        `<i>${escHtml(t("这块屏上约需 {need} 像素", { need }))}</i></span>` +
        `<select data-cols="${n}">${opts}</select></label>`;
    }).join("");
    const navHtml = settingsNav().map((it) =>
      `<button type="button" data-tab="${it.id}">${mbIco(it.icon)} ${escHtml(it.title)}</button>`
    ).join("");
    const modelPills = (st.models && st.models.length)
      ? `<div class="row">${escHtml(t("已有权重（点一下切换）"))}<div class="acts">` +
        st.models.map((p) =>
          `<button type="button" data-pick="${escHtml(p)}"${p === st.model_path ? ' class="on"' : ""}>${escHtml((p.split(/[/\\\\]/).pop() || p))}</button>`
        ).join("") + `</div></div>`
      : "";
    const startTab = settingsNav().some((x) => x.id === tab) ? tab : lastSettingsTab;
    lay.innerHTML =
      `<aside class="mb-set-nav"><h3>${escHtml(t("设置"))}</h3>${navHtml}</aside>` +
      `<div class="mb-set-main">` +
        `<div class="mb-set-hd"><span class="mb-set-title"></span>` +
          langSelectHtml() +
          `<button type="button" data-s="close">${mbIco("lucide--x")} ${escHtml(t("关闭"))}</button></div>` +
        `<div class="mb-set-body">` +
          `<section class="mb-set-pane" data-pane="display">` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--info")} ${escHtml(t("语言"))}</h4>` +
              `<p class="hint">${escHtml(t("语言会立刻作用在浏览窗口。自动＝跟 Comfy 设置里的界面语言。"))}</p>` +
              langSelectHtml() +
            `</div>` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--zoom-in")} ${escHtml(t("点一下图片"))}</h4>` +
              `<p class="hint">${escHtml(t("选中会关掉这个窗口、改掉节点的值；看大图按 Esc 就退。默认把最容易触发的手势留给可逆的那个。"))}</p>` +
              `<select class="clickact">` +
                `<option value="view"${clickOpensViewer() ? " selected" : ""}>${escHtml(t("看大图（选中走图上那个绿色 ✓）"))}</option>` +
                `<option value="pick"${clickOpensViewer() ? "" : " selected"}>${escHtml(t("直接选中并关窗（当选片器用）"))}</option>` +
              `</select>` +
            `</div>` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--image")} ${escHtml(t("缩略图清晰度"))}</h4>` +
              `<p class="hint">${escHtml(t("只影响格子里的封面。点开查看 / 播放永远是原片，跟这里无关。"))}</p>` +
              `<div class="mb-set-field"><div class="lab"><span>${escHtml(t("一键套用"))}</span></div>` +
                `<select class="thumbpx">${thumbOpts}</select>` +
                `<p class="hint">${escHtml(t("选一套，就把下面每一档都填成那套数。填完还能接着逐档改。"))}</p></div>` +
              `<div class="mb-percell">` +
                `<p class="hint">${escHtml(t("配多少就请求多少，不做隐式换算。右边标的是这块屏上该档格子实际占的物理像素 —— 配得比它高看不出差别，只是白等。", { dpr: dprNow }))}</p>` +
                `<p class="hint">${escHtml(t("这套设置按设备各存一份：手机和电脑各配各的，互不影响。当前屏幕像素密度 {dpr}×。", { dpr: dprNow }))}</p>` +
                perCellRows +
              `</div>` +
            `</div>` +
          `</section>` +
          `<section class="mb-set-pane" data-pane="detect">` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--info")} ${escHtml(t("状态"))}</h4>` +
              `<div class="mb-set-status">` +
                `<span class="${st.ort ? "ok" : "bad"}">${escHtml(st.ort ? t("运行时 已就绪") : t("运行时 未安装"))}</span>` +
                `<span class="${st.ready ? "ok" : "bad"}">${escHtml(st.ready ? t("可检测") : t("未就绪"))}</span>` +
              `</div>` +
              `<p class="hint">${escHtml(t("检测只处理眼前看得见的图，一次一屏，按了才跑。"))}` +
                (st.ort ? "" : escHtml(t("运行时要装到 Comfy 那个 Python：pip install onnxruntime。"))) +
              `</p>` +
            `</div>` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--image")} ${escHtml(t("推荐模型 640m"))}</h4>` +
              `<p class="hint">${t("只推这一份（约 99MB，效果最好）。失败再走 {link} 手动填路径。", { link: relA(rel) })}</p>` +
              `<div class="dlst" data-dlst></div>` +
              `<div class="acts">` +
                `<button type="button" data-s="dl">${escHtml(t("下载 640m"))}</button>` +
                `<button type="button" data-s="dl-again">${escHtml(t("重新下载"))}</button>` +
                `<button type="button" data-s="dlc">${escHtml(t("取消"))}</button>` +
              `</div>` +
            `</div>` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--ban")} ${escHtml(t("遮哪些部位"))}</h4>` +
              `<p class="hint">${escHtml(t("检测器认得这些部位，勾中的才遮。改完立刻生效 —— 框早就检测出来了，只是之前被这份名单挡掉，不用重新检测。"))}</p>` +
              labelGroups +
            `</div>` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--eye-off")} ${escHtml(t("局部档下，还没检测的图"))}</h4>` +
              `<p class="hint">${escHtml(t("检测要按顶栏局部旁边的扫描图标，不会自动跑。这里决定按之前那些图长什么样。"))}</p>` +
              `<select class="censorwait">` +
                `<option value="show"${censorWaitBlurs() ? "" : " selected"}>${escHtml(t("直接显示原图（默认）"))}</option>` +
                `<option value="blur"${censorWaitBlurs() ? " selected" : ""}>${escHtml(t("先全部遮住"))}</option>` +
              `</select>` +
              `<p class="hint">${escHtml(t("选「先全部遮住」：只有检测确认过的才逐张露出来，适合有人在旁边时慢慢翻。"))}</p>` +
            `</div>` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--layout-grid")} ${escHtml(t("同时检测几张"))}</h4>` +
              `<p class="hint">${escHtml(t("一次叠几张一起检。默认 2 张：下一张读盘和这一张推理可以同时做，比一张一张快一截。"))}</p>` +
              `<select class="censorconcur">` +
                `<option value="1"${censorConcur() === 1 ? " selected" : ""}>${escHtml(t("1 张（机器比较吃力）"))}</option>` +
                `<option value="2"${censorConcur() === 2 ? " selected" : ""}>${escHtml(t("2 张（默认）"))}</option>` +
                `<option value="3"${censorConcur() === 3 ? " selected" : ""}>${escHtml(t("3 张"))}</option>` +
                `<option value="4"${censorConcur() === 4 ? " selected" : ""}>${escHtml(t("4 张（机器比较强）"))}</option>` +
              `</select>` +
              `<p class="hint">${escHtml(t("改成 1 张：检测时还要出图、机器比较吃力，选这个。3 或 4 张：机器比较强才有用；模型一次只能跑一张，多出来的工位只是提前读盘。已经检过的图不会重跑。"))}</p>` +
            `</div>` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--settings")} ${escHtml(t("检测效果"))}</h4>` +
              `<p class="hint">${escHtml(t("只改怎么画，不用重新检测。"))}</p>` +
              `<div class="mb-set-field"><div class="lab"><span>${escHtml(t("打码范围"))}</span><b class="coverv">${censorCover().toFixed(2)}</b></div>` +
                `<input type="range" class="cover" min="45" max="120" value="${Math.round(censorCover() * 100)}"></div>` +
              `<div class="mb-set-field"><div class="lab"><span>${escHtml(t("胸部单独缩小"))}</span><b class="bcv">${censorBreastCover().toFixed(2)}</b></div>` +
                `<input type="range" class="bcover" min="30" max="120" value="${Math.round(censorBreastCover() * 100)}">` +
                `<p class="hint">${escHtml(t("模型没有「乳头」这一类，框住的是整个乳房。调小只盖中心 —— 只作用于胸，下体的框不受影响。"))}</p></div>` +
              `<div class="mb-set-field"><div class="lab"><span>${escHtml(t("糊的程度"))}</span><b class="blrv">${censorBlur()}</b></div>` +
                `<input type="range" class="blr" min="6" max="28" value="${censorBlur()}"></div>` +
              `<div class="mb-set-field"><div class="lab"><span>${escHtml(t("检测灵敏度"))}</span><b class="thrv">${censorThr().toFixed(2)}</b></div>` +
                `<input type="range" class="thr" min="15" max="80" value="${Math.round(censorThr() * 100)}"></div>` +
            `</div>` +
            `<details class="mb-set-more">` +
              `<summary>${escHtml(t("高级：本机权重"))}</summary>` +
              `<p class="hint">${escHtml(t("只认 640m，或同系列的 320n。别的架构改路径没用。"))}</p>` +
              modelPills +
              `<div class="row">${escHtml(t("本机 .onnx 路径"))}<br>` +
                `<input type="text" class="onnx" value="${st.model_path ? escHtml(st.model_path) : ""}" placeholder="${escHtml(t("例如 D:\\models\\640m.onnx"))}"></div>` +
              `<div class="acts"><button type="button" data-s="save">${escHtml(t("使用这个文件"))}</button></div>` +
            `</details>` +
          `</section>` +
          `<section class="mb-set-pane" data-pane="storage">` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--image")} ${escHtml(t("缓存"))}</h4>` +
              `<p class="hint">${escHtml(t("检测模型不在这里。要重下到「检测」。"))}</p>` +
              `<div class="mb-usage"></div>` +
              `<div class="purge">` +
                `<div class="line"><button type="button" data-purge="thumbs">${escHtml(t("清缩略图"))}</button><i>${escHtml(t("腾服务器磁盘用。浏览器自己还缓存 7 天，画面多半不变；要看重新生成得强刷（Ctrl+F5）。"))}</i></div>` +
                `<div class="line"><button type="button" data-purge="regions">${escHtml(t("清检测框"))}</button><i>${escHtml(t("局部记住的框。下次要点「局部」重检。"))}</i></div>` +
              `</div>` +
            `</div>` +
            `<div class="mb-set-card">` +
              `<h4>${mbIco("lucide--layout-grid")} ${escHtml(t("偏好"))}</h4>` +
              `<div class="purge">` +
                `<div class="line"><button type="button" data-purge="prefs">${escHtml(t("恢复默认界面"))}</button><i>${escHtml(t("语言、格子、递归、类型、排序、点击行为、清晰度、遮蔽档位、滑条、检测并发和浮钮位置。收藏和锁不动。"))}</i></div>` +
              `</div>` +
            `</div>` +
            `<div class="mb-set-card danger">` +
              `<h4>${mbIco("lucide--trash-2")} ${escHtml(t("危险"))}</h4>` +
              `<div class="purge">` +
                `<div class="line"><button type="button" data-purge="marks">${escHtml(t("清空收藏和标记"))}</button><i>${escHtml(t("收藏、最近、钉住的目录、单张锁、跳过检测。"))}</i></div>` +
                `<div class="line"><button type="button" data-purge="all" class="go">${escHtml(t("完全重置浏览"))}</button><i>${escHtml(t("上面全部 + 磁盘缓存。不删检测模型。"))}</i></div>` +
              `</div>` +
            `</div>` +
          `</section>` +
        `</div>` +
      `</div>`;
    box.appendChild(lay);
    const showTab = (id) => {
      const hit = settingsNav().some((x) => x.id === id) ? id : "detect";
      lastSettingsTab = hit;
      lay.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === hit));
      lay.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("on", p.dataset.pane === hit));
      const title = lay.querySelector(".mb-set-title");
      const item = settingsNav().find((x) => x.id === hit);
      if (title && item) title.textContent = item.title;
    };
    lay.querySelectorAll("[data-tab]").forEach((b) => {
      b.onclick = () => showTab(b.dataset.tab);
    });
    showTab(startTab);
    lay.querySelectorAll(".mb-lang-sel").forEach((el) => {
      el.onchange = () => {
        const v = el.value;
        if (v !== "auto" && v !== "zh" && v !== "en") return;
        save(MB_LANG_KEY, v);
        applyLangLive();
        openSettings(lastSettingsTab);
      };
    });
    const repaintThumbs = () => {
      releasePool();
      paint();
    };
    const clickSel = lay.querySelector(".clickact");
    if (clickSel) {
      clickSel.onchange = () => {
        save(CLICK_KEY, clickSel.value);
        syncClickMode();          // 鼠标样式立刻跟上，不用重开窗口

        flash(clickSel.value === "pick"
          ? t("点一下图片＝直接选中并关窗。想只看看，用图上的放大钮")
          : t("点一下图片＝看大图。要选中，点图上那个绿色 ✓，或在大图里点「用这张」"));
      };
    }
    const waitSel = lay.querySelector(".censorwait");
    if (waitSel) {
      waitSel.onchange = () => {
        save(CENSOR_WAIT_KEY, waitSel.value);
        applyLocalCaches();       // 当场重画：要求切档或重开窗口才生效的话，用户会以为开关坏了
        flash(waitSel.value === "blur"
          ? t("已改成：没检测过的先全部遮住，检测确认过的才逐张露出来")
          : t("已改成：没检测过的直接显示原图，按局部旁边的扫描图标才盖上遮蔽"));
      };
    }
    const concurSel = lay.querySelector(".censorconcur");
    if (concurSel) {
      concurSel.onchange = () => {
        const want = parseInt(concurSel.value, 10);
        const v = Number.isFinite(want)
          ? Math.min(CENSOR_CONCUR_MAX, Math.max(CENSOR_CONCUR_MIN, want))
          : CENSOR_CONCUR_DEFAULT;
        save(CENSOR_CONCUR_KEY, String(v));
        flash(t("已改成同时检测 {n} 张。下一轮点局部旁边的扫描图标按这个数跑。", { n: v }));
      };
    }
    const thumbSel = lay.querySelector(".thumbpx");
    // 表被改动之后，「一键套用」那个下拉要跟着回显：正好凑成某套预设就选中它，
    // 否则多出一项「自定义」并选中 —— 下拉显示的必须是表的真实状态，
    // 否则它写着「均衡」而表里根本不是均衡的数，看设置的人会被直接骗到。
    const syncPresetSel = () => {
      if (!thumbSel) return;
      const k = thumbPresetOf(thumbPerCell());
      let custom = thumbSel.querySelector('option[value=""]');
      if (!k && !custom) {
        custom = new Option(t("自定义（下面的表被改过）"), "");
        thumbSel.insertBefore(custom, thumbSel.firstChild);
      }
      if (k && custom) custom.remove();
      thumbSel.value = k;
    };
    for (const sel2 of lay.querySelectorAll(".mb-percell select")) {
      sel2.onchange = () => {
        const cur = thumbPerCell();
        cur[+sel2.dataset.cols] = +sel2.value;
        save(THUMB_PER_CELL_KEY, cur);
        syncPresetSel();
        repaintThumbs();
        const lab = THUMB_PX_VALUES.find(([v]) => +v === +sel2.value)?.[1] ?? sel2.value;
        flash(t("一行 {n} 个改用 {px}。当前正在用的档会立刻重取封面", {
          n: sel2.dataset.cols, px: t(lab),
        }));
      };
    }
    if (thumbSel) {
      thumbSel.onchange = () => {
        const preset = THUMB_PRESETS[thumbSel.value];
        // 「自定义」只是状态回显，不是能选的动作：选中它什么都不该发生
        if (!preset) { syncPresetSel(); return; }
        save(THUMB_PER_CELL_KEY, { ...preset });
        for (const s2 of lay.querySelectorAll(".mb-percell select")) {
          s2.value = String(preset[+s2.dataset.cols]);   // 表要立刻显示被填成了什么
        }
        syncPresetSel();
        releasePool();
        paint();
        flash(t("已套用「{mode}」：下面每一档都填成了这套数，还能再逐档改。已出的封面会重取", {
          mode: thumbPresetLabel(thumbSel.value),
        }));
      };
    }
    const hasRecOf = (s) => ("has_recommended" in s)
      ? !!s.has_recommended
      : !!(s.model_path && /640m\.onnx$/i.test(String(s.model_path)));
    const wasCancel = (s) => !!(s.cancelled || s.error === "已取消");
    let watchDl = !!st.downloading;
    const paintDl = (s) => {
      const boxEl = lay.querySelector("[data-dlst]");
      const btnDl = lay.querySelector("[data-s=dl]");
      const btnAgain = lay.querySelector("[data-s=dl-again]");
      const btnC = lay.querySelector("[data-s=dlc]");
      if (!boxEl || !btnDl || !btnAgain || !btnC) return;
      const has = hasRecOf(s);
      if (s.downloading) {
        boxEl.className = "dlst";
        boxEl.textContent = t("下载中 {n}%", { n: Math.round((s.progress || 0) * 100) });
        btnDl.hidden = true;
        btnAgain.hidden = true;
        btnC.hidden = false;
        return;
      }
      btnC.hidden = true;
      if (has) {
        btnDl.hidden = true;
        btnAgain.hidden = false;
        if (watchDl && wasCancel(s)) {
          boxEl.className = "dlst";
          boxEl.textContent = t("已取消。当前推荐模型仍可用");
        } else if (watchDl && s.error) {
          boxEl.className = "dlst bad";
          boxEl.innerHTML = t("重新下载没成功，当前模型还能用。{err} · {link}", { err: escHtml(s.error), link: relA(s.release_url) });
        } else {
          boxEl.className = "dlst";
          boxEl.textContent = t("已安装 640m");
        }
        return;
      }
      btnDl.hidden = false;
      btnAgain.hidden = true;
      if (watchDl && wasCancel(s)) {
        boxEl.className = "dlst";
        boxEl.textContent = t("已取消");
      } else if (watchDl && s.error) {
        boxEl.className = "dlst bad";
        boxEl.innerHTML = t("失败：{err} · {link}", { err: escHtml(s.error), link: relA(s.release_url) });
      } else {
        boxEl.className = "dlst";
        boxEl.textContent = t("还没有推荐模型");
      }
    };
    const tick = async () => {
      const s = await fetch("/mediabrowser/censor/status").then((r) => r.json()).catch(() => ({}));
      if (!("downloading" in s)) return;
      paintDl(s);
      if (!s.downloading) {
        clearInterval(settingsPoll);
        settingsPoll = null;
      }
    };
    paintDl(st);
    if (st.downloading) settingsPoll = setInterval(tick, 600);
    const startDl = async (force) => {
      watchDl = true;
      const r = await fetch("/mediabrowser/censor/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: !!force }),
      }).then((x) => x.json()).catch(() => ({}));
      if (r.has_recommended && !r.started) {
        paintDl({ ...st, has_recommended: true, downloading: false, error: null, cancelled: false });
        flash(t("推荐模型已经在，不用再下"));
        return;
      }
      clearInterval(settingsPoll);
      settingsPoll = setInterval(tick, 600);
      tick();
    };
    lay.querySelector("[data-s=dl]").onclick = () => startDl(false);
    lay.querySelector("[data-s=dl-again]").onclick = async () => {
      if (!await confirmAsk(t("重新下载 640m？"), t("已有的推荐模型还能用。只有这次下完并通过校验才会替换。"))) return;
      startDl(true);
    };
    lay.querySelector("[data-s=dlc]").onclick = () => {
      watchDl = true;
      fetch("/mediabrowser/censor/download/cancel", { method: "POST" });
    };
    const applyOnnx = async (onnx) => {
      const r = await fetch("/mediabrowser/censor/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onnx }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        regionMem.clear();
        applyLocalCaches();
        flash(t("已切换权重。已有框按新模型重画；眼前还没检过的点局部旁边的扫描图标"));
      } else {
        flash(t(j.error || "保存失败"));
      }
    };
    lay.querySelector("[data-s=save]").onclick = () => applyOnnx(lay.querySelector(".onnx").value.trim());
    lay.querySelectorAll("[data-pick]").forEach((b) => {
      b.onclick = () => applyOnnx(b.dataset.pick);
    });
    const cover = lay.querySelector(".cover");
    cover.oninput = () => {
      const v = (+cover.value) / 100;
      save(CENSOR_COVER_KEY, String(v));
      lay.querySelector(".coverv").textContent = v.toFixed(2);
      applyLocalCaches();
    };
    const blr = lay.querySelector(".blr");
    blr.oninput = () => {
      save(CENSOR_BLUR_KEY, String(+blr.value));
      lay.querySelector(".blrv").textContent = blr.value;
      applyCensorBlurCss();
    };
    for (const box of lay.querySelectorAll(".mb-labchk input")) {
      box.onchange = () => {
        const on = [...lay.querySelectorAll(".mb-labchk input")]
          .filter((b) => b.checked).map((b) => b.dataset.label);
        save(CENSOR_LABELS_KEY, on);
        applyLocalCaches();          // 框已在缓存里，改名单是瞬时的
        if (!on.length) {
          flash(t("一个都没勾等于不打码。已退回默认的「露出」那几项"));
          for (const b of lay.querySelectorAll(".mb-labchk input")) {
            b.checked = CENSOR_LABELS_DEFAULT.includes(b.dataset.label);
          }
          save(CENSOR_LABELS_KEY, [...CENSOR_LABELS_DEFAULT]);
          applyLocalCaches();
        }
      };
    }
    const bcover = lay.querySelector(".bcover");
    if (bcover) {
      bcover.oninput = () => {
        const v = (+bcover.value) / 100;
        save(CENSOR_BREAST_COVER_KEY, String(v));
        lay.querySelector(".bcv").textContent = v.toFixed(2);
        applyLocalCaches();
      };
    }
    const thr = lay.querySelector(".thr");
    thr.oninput = () => {
      const v = (+thr.value) / 100;
      save(CENSOR_THR_KEY, String(v));
      lay.querySelector(".thrv").textContent = v.toFixed(2);
      applyLocalCaches();
    };
    const postPurge = async (what) => {
      const r = await fetch("/mediabrowser/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ what }),
      });
      const j = await r.json().catch(() => ({}));
      const stale = !j.error && staleBackend(r.status, "清理");
      if (stale) throw new Error(stale);
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    };
    const applyPrefsLive = () => {
      rec.checked = recOn();
      sortSel.value = loadStr(SORT_KEY, "time_desc");
      // PLACE_KEY 也在偏好清单里；清掉后同步回节点默认根，不能只清存储却保留当前虚拟视图。
      const restoredScope = scopeWithRoot({ root: browseRoot, mode: scopeMode, cwd }, folder);
      browseRoot = restoredScope.root;
      scopeMode = restoredScope.mode;
      cwd = restoredScope.cwd;
      sel.value = browseRoot;
      syncScopeButtons();
      kinds = loadKinds();
      sizeIdx = Math.min(COLS.length - 1, Math.max(0, +(loadStr("mediabrowser.size", "1"))));
      masonry = loadStr("mediabrowser.masonry") !== "0";
      setCensorMode(loadCensorMode());
      applyCensorBlurCss();
      syncClickMode();          // 光标样式：清了 CLICK_KEY，样式也得当场跟着回默认
      syncMode();
      syncSize();
      rebuildScope();
      syncPin();
      // 下面两样只在建窗时读一次，键清了它们不会自己回去。按钮叫「恢复默认界面」，
      // 就不该留下"其实没恢复、得关掉重开才生效"的部分。
      if (loadJSON("mediabrowser.boxsize", null) == null) {
        box.style.width = "";
        box.style.height = "";
      }
      if (loadStr("mediabrowser.touch") === null) {
        // 回到「问浏览器这机器有没有鼠标」的那个初值。
        const auto = window.matchMedia?.("(hover: none)").matches ?? false;
        // 第二个参数禁止重建刚清掉的偏好键，但仍复用同一套面板/html/计时器同步。
        setTouch(auto, false);
      }
      if (loadJSON("mediabrowser.fab.pos", null) == null) {
        resetFabToDefault();
      }
    };
    // 缓存用量。清完当场刷新这里的数字 —— 那是用户唯一能验证「真清掉了」的地方，
    // 所以清理**不关弹窗**：关掉等于把人赶离唯一能确认结果的界面，只剩一句 toast。
    const fmtMB = (b) => (b >= 1048576 ? (b / 1048576).toFixed(0) + " MB"
      : Math.max(1, Math.round(b / 1024)) + " KB");
    const paintUsage = (u) => {
      const box = lay.querySelector(".mb-usage");
      if (!box || !u) return;
      const row = (lab, r) => {
        if (!r) return "";
        // cap 为 0 = 后端也不知道上限（检测模块没加载），那就别编一个数出来
        const cap = r.cap ? t("／上限 {cap} 个", { cap: r.cap }) : "";
        return `<div class="line"><span>${escHtml(lab)}</span>` +
          `<b>${escHtml(t("{n} 个", { n: r.n }))}${escHtml(cap)} · ${escHtml(fmtMB(r.bytes))}</b></div>`;
      };
      box.innerHTML = row(t("缩略图"), u.thumbs) + row(t("检测框"), u.regions) +
        `<p class="hint">${escHtml(t("超上限会自动删最久没看过的那批，不用手动管。下面的按钮是要立刻腾地方时用的。"))}</p>`;
    };
    const refreshUsage = async () => {
      const u = await fetch("/mediabrowser/usage").then((r) => r.json()).catch(() => null);
      if (lay.isConnected) paintUsage(u);
    };
    void refreshUsage();
    lay.querySelector("[data-purge=thumbs]").onclick = async () => {
      try {
        const j = await postPurge("thumbs");
        dims = {};
        load();
        paintUsage(j.usage);
        flash(t("已清缩略图 {n} 个，服务器磁盘腾出来了。画面不会变 —— 浏览器还缓存着，强刷才重新生成", { n: j.thumbs ?? 0 }));
      } catch (e) { flash(t(e.message || "清缩略图失败")); }
    };
    lay.querySelector("[data-purge=regions]").onclick = async () => {
      try {
        const j = await postPurge("regions");
        regionMem.clear();
        applyLocalCaches();
        paintUsage(j.usage);
        flash(t("已清检测框 {n} 个。局部要重新点一次", { n: j.regions ?? 0 }));
      } catch (e) { flash(t(e.message || "清检测框失败")); }
    };
    lay.querySelector("[data-purge=prefs]").onclick = async () => {
      if (!await confirmAsk(
        t("恢复默认界面？"),
        t("语言、格子、排序、点一下图片的行为、缩略图清晰度、遮蔽档位、全部滑条、检测并发和浮钮位置都会回到默认，不能撤销。收藏、锁、标记和缓存都不动。"),
      )) return;
      dropKeys(PREF_KEYS);
      applyPrefsLive();
      applyLangLive();
      buildKinds();
      load();
      flash(t("界面已回默认：语言跟随 ComfyUI、图+视频、递归开、瀑布流、遮蔽关"));
      openSettings(lastSettingsTab);
    };
    lay.querySelector("[data-purge=marks]").onclick = async () => {
      if (!await confirmAsk(t("清空收藏和标记？"), t("收藏、最近、钉住的目录、单张锁和跳过检测都会清掉。界面习惯和封面缓存不动。"))) return;
      dropKeys(MARK_KEYS);
      forgetClientMarks();
      rebuildScope();
      syncPin();
      load();
      flash(t("已清空收藏、最近、钉住和单张标记"));
    };
    lay.querySelector("[data-purge=all]").onclick = async () => {
      if (!await confirmAsk(t("完全重置浏览？"), t("界面、收藏、标记、缩略图和检测框都会清掉，回到刚装插件时的状态。检测模型不删。"))) return;
      dropKeys([...PREF_KEYS, ...MARK_KEYS]);
      forgetClientMarks();
      regionMem.clear();
      try { await postPurge("disk"); }
      catch (e) { flash(t(e.message || "磁盘缓存没清掉")); return; }
      applyPrefsLive();
      applyLangLive();
      buildKinds();
      load();
      flash(t("浏览已完全重置。检测模型还在"));
      openSettings(lastSettingsTab);      // 界面回默认了，面板要按新值重画一遍
      void refreshUsage();                // 重画后的面板要拿到清完的数字
    };
    lay.querySelector("[data-s=close]").onclick = () => {
      clearInterval(settingsPoll);
      settingsPoll = null;
      lay.remove();
    };
  };
  mask.querySelector('[data-act="settings"]').onclick = () => openSettings();

  // ── 触屏：按钮闲一会儿自己让开 ──
  //    常显解决了「够得着」，但按钮盖住画面底部，看不全图。
  //    所以：一有动作就现身，闲置 2.6 秒淡出。任何触摸/滚动都会把它们叫回来。
  //    不改「点图=选中」的语义 —— 按钮藏起来时点图还是选中，
  //    要用按钮就先碰一下屏（滚动、点空白都算），它们就回来了。
  let idleT = null;
  const wakeBars = () => {
    if (!box.classList.contains("touching")) return;
    box.classList.remove("bars-idle");
    clearTimeout(idleT);
    idleT = setTimeout(() => box.classList.add("bars-idle"), 2600);
  };
  for (const ev of ["pointerdown", "pointermove", "scroll"]) {
    mask.addEventListener(ev, wakeBars, { capture: true, passive: true });
  }
  // 混合输入设备按 pointerType 切换操作条显隐，CSS hover 能力不足以判断本次输入。
  const setTouch = (on, persist = true) => {
    const changed = box.classList.contains("touching") !== on;
    box.classList.toggle("touching", on);
    // 标记打在 <html> 上，不是浏览窗上：设置面板、确认框、单张菜单这些浮层
    // 大多 appendChild 到 document.body，在 .mb-box 之外 —— 只标浏览窗的话，
    // 那些浮层的按钮照样会在触屏点完之后一直粘着 hover。
    // CSS 那边用 :where(html:not(.mb-touch)) 挡，:where() 特异性为 0，
    // 不会打乱既有优先级（比如 .mb-skip.on 仍然盖得住 hover）。
    document.documentElement.classList.toggle("mb-touch", on);
    // 即使面板状态没变，也先修复 html 上可能由旧窗口留下的全局标记。
    if (!changed) return;
    if (persist) save("mediabrowser.touch", on ? "1" : "0");
    if (on) wakeBars(); else { clearTimeout(idleT); box.classList.remove("bars-idle"); }
    syncSize();          // 触屏的按钮下限更大，能放几个会变
  };
  // 初值：用户之前定过就听他的；没定过就问浏览器「这机器有没有鼠标」。
  // 之后任何一次真实的 pointerdown 都会按 pointerType 校正 —— 混合设备
  // （带触摸屏的笔记本）两样都有，只有真按下的那一下才说明你在用哪个。
  const saved = loadStr("mediabrowser.touch");
  const startTouch = saved !== null
    ? saved === "1"
    : (window.matchMedia?.("(hover: none)").matches ?? false);
  // 切模式：pointerdown 和 pointermove 都认，手指和鼠标一视同仁。
  //   手指划过屏幕就是最明显的「我在用触屏」——宫格里最常见的触摸操作本来就是
  //   滑动浏览，不是点按；只认按下的话，滑半天界面还停在鼠标样式。
  //   鼠标同理：手搭上去一动，就说明不用手指了。
  // 唯一的例外是 700ms 保险：手指刚碰过的 700ms 内忽略鼠标信号 ——
  // 个别浏览器会在触摸后补发合成鼠标事件，不挡住的话手指点一下就被弹回鼠标模式。
  let lastTouchAt = 0;
  const onPointer = (e) => {
    if (e.pointerType === "touch" || e.pointerType === "pen") {
      lastTouchAt = Date.now();
      setTouch(true);
    } else if (e.pointerType === "mouse" && Date.now() - lastTouchAt > 700) {
      setTouch(false);
    }
  };
  mask.addEventListener("pointerdown", onPointer, true);
  mask.addEventListener("pointermove", onPointer, { capture: true, passive: true });

  // ── 排版切换 ──
  const modeBtn = mask.querySelector('[data-act="mode"]');
  const sizeSeg = mask.querySelector('.mb-seg-size');
  // 按钮不藏。放不下就换行，靠图标尺寸自适应把条高压住 ——
  // 藏起来等于功能消失，用户找不到只会以为坏了；看不清就自己调大格子，
  // 尺寸切换本来就是一键的事。

  const reflow = () => {                                  // 只重排，不重新拉列表
    layout();
    releasePool();
    paint();
  };
  const syncMode = () => {
    setIco(modeBtn, masonry ? "lucide--layout-template" : "lucide--layout-grid");
    modeBtn.classList.toggle("on", masonry);
    modeBtn.title = masonry
      ? t("当前：瀑布流（按原图比例排，不裁切）。点一下换回宫格")
      : t("当前：宫格（等大方格，会裁掉画面边缘）。点一下换成瀑布流");
    scroll.classList.toggle("masonry", masonry);
  };
  const syncSize = () => {
    // 档位做成分段控件：五个档一眼看全、想要哪档直接点。
    // 原来是一个按钮轮换 —— 从 6 调到 2 要点四下，而且点之前不知道下一档是什么。
    // 窗口窄的时候，格子宽会被 MIN_CELL 保底顶住，好几档算出来是同一个宽度 ——
    // 点了看不出变化。与其让用户以为坏了，不如把「这一档现在没效果」摆出来：
    // 标灰 + 说清为什么、怎么才能生效。仍然可点（设置会存下来，窗口放大就生效）。
    const availW = Math.max(80, scroll.clientWidth - 24);
    for (const b of sizeSeg.querySelectorAll("button")) {
      const n = +b.dataset.size;
      const i = COLS.indexOf(n);
      const raw = Math.floor((availW - GAP * (n - 1)) / n);
      const clamped = raw < MIN_CELL;
      b.classList.toggle("on", i === sizeIdx);
      b.classList.toggle("clamped", clamped && i !== sizeIdx);
      b.title = clamped
        ? t("窗口太窄，这一档现在和更小的档一样宽。最大化或拉宽窗口后生效", { n })
        : t("一行 {n} 个（{size}）", { n, size: SIZE_NAME()[i] });
    }
    const w = recalcCellW();               // 按钮尺寸跟着**实际**格子宽走，不是档位名义值
    // 按钮的宽和高都跟着格子走。关键是**宽度也要跟**：
    // 宽度不跟的话，小格子里一行只塞得下两个，5 个按钮堆成 3 行，
    // 条高能占掉整格的 98%（实测 110px 格子）。宽度跟着缩，一行多塞几个，
    // 一两行就装完，条高自然压得住 —— 不用靠藏按钮。
    // 0.17 这个系数是量出来的：格子实际渲染宽约为档位值的 1.05~1.1 倍
    // （layout 会把剩余宽度平分给各列）。取 0.17 时，最小档下 5 个按钮
    // 正好一行装完 —— 一行和两行的差别就是条高 23% 和 41%。
    const bw = Math.round(Math.min(48, Math.max(26, w * 0.17)));
    const bh = Math.round(Math.min(46, Math.max(24, w * 0.17)));
    box.style.setProperty("--mb-btn-w", bw + "px");
    box.style.setProperty("--mb-btn-h", bh + "px");
    box.style.setProperty("--mb-btn-fs", Math.min(20, Math.max(11, w * 0.082)).toFixed(1) + "px");
    // 当前格子实际动作数能不能在这一格里排成**一行**（选片窗含「用这张」，浏览窗少一枚）。
    // 排得下就直接摆在图上；排不下就只留一个「⋯」，点开是同样这批、同样的顺序。
    // 只认「一行」这一个门槛，不搞两行的中间态 —— 两行既盖住半张图，
    // 又比菜单难点，两头不讨好。
    const need = CELL_ACTION_IDS.length * bw + (CELL_ACTION_IDS.length - 1) * 3 + 6;
    box.classList.toggle("bar-fits", w >= need);
    box.style.setProperty("--mb-peek", Math.round(Math.min(40, Math.max(22, w * 0.17))) + "px");
    box.style.setProperty("--mb-nm-fs", Math.min(14, Math.max(9, w * 0.055)).toFixed(1) + "px");
    // 小格子把渐变留白也收一收，14px 在 150px 的格子里就是 9% 的高度
    box.style.setProperty("--mb-bar-pad", (w < 200 ? 8 : 14) + "px");
  };
  syncMode(); syncSize();
  setTouch(startTouch, false);              // 初始化不回写偏好，但要主动清理旧窗口留下的全局类
  modeBtn.onclick = () => {
    masonry = !masonry;
    save("mediabrowser.masonry", masonry ? "1" : "0");
    syncMode(); reflow();
  };
  sizeSeg.onclick = (e) => {
    const b = e.target.closest("button[data-size]");
    if (!b) return;
    const i = COLS.indexOf(+b.dataset.size);
    if (i < 0 || i === sizeIdx) return;
    sizeIdx = i;
    recalcCellW();
    save("mediabrowser.size", String(sizeIdx));
    syncSize(); reflow();
  };

  // ── 钉目录：按钮 + 把钉住的塞进「范围」下拉 ──
  const pinBtn = mask.querySelector(".mb-pin");
  syncPin = () => {
    // 虚拟范围（★/🕒）下没有「当前目录」这回事，钉了也无处可回
    const canPin = !virtualScope();
    // 保留按钮占位，避免收藏/最近和真实目录之间切换时面包屑横向跳动。
    pinBtn.disabled = !canPin;
    if (!canPin) {
      pinBtn.classList.remove("on");
      setIco(pinBtn, "lucide--pin-off");
      pinBtn.title = t("当前范围没有可钉住的目录");
      pinBtn.setAttribute("aria-label", pinBtn.title);
      return;
    }
    const on = isPinned(sel.value, cwd);
    pinBtn.classList.toggle("on", on);
    setIco(pinBtn, on ? "lucide--pin" : "lucide--pin-off");
    pinBtn.title = on
      ? t("取消钉住「{name}」", { name: cwd || sel.value })
      : t("钉住「{name}」：下次从上面的范围下拉一步就能回来", { name: cwd || sel.value });
    pinBtn.setAttribute("aria-label", pinBtn.title);
  };
  pinBtn.onclick = () => {
    const now = togglePin(sel.value, cwd);
    syncPin();
    rebuildScope();
    flash(now
      ? t("已钉住「{name}」，在上面的范围下拉里", { name: cwd || sel.value })
      : t("已取消钉住"));
  };

  // 钉住的目录做成下拉里的一组。值编码成 @pin:根:路径，跟真目录区分开。
  const rebuildScope = () => {
    const keep = sel.value;
    sel.querySelectorAll("optgroup").forEach((g) => {
      if (g.dataset.mbPins === "1") g.remove();
    });
    const items = [];
    for (const root of ["input", "output", "temp"]) {
      for (const p of pinList(root)) items.push([root, p]);
    }
    if (items.length) {
      const g = document.createElement("optgroup");
      g.dataset.mbPins = "1";
      g.label = t("钉住的目录");
      for (const [root, p] of items) {
        const o = document.createElement("option");
        o.value = `@pin:${root}:${p}`;
        // 路径长了只留尾部两段 —— 前面那串在下拉里挤不下，也不是辨认的关键
        const parts = p.split("/");
        o.textContent = "📌 " + (parts.length > 2 ? "…/" + parts.slice(-2).join("/") : (p || root));
        o.title = `${root} / ${p}`;
        g.appendChild(o);
      }
      sel.appendChild(g);
    }
    // 重建后把选中项放回去（选项对象换了，值还在就还原得回来）
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  };
  rebuildScope();

  // ── 最大化 / 窗口化 ──
  //    只做这两个，不做最小化：关掉已经有 ✕ 和 Esc。
  const maxBtn = mask.querySelector('[data-act="max"]');
  // 窗口化时的默认尺寸。还原时如果"原来的尺寸"本身就接近满屏，
  // 还原了也看不出变化 —— 那就退到这个默认值，让「窗口化」名副其实。
  const WIN_W = () => Math.min(1180, Math.round(window.innerWidth * 0.92));
  const WIN_H = () => Math.min(820, Math.round(window.innerHeight * 0.88));
  let restoreSize = null;
  let restorePos = null;
  let maximized = false;
  const syncMax = () => {
    setIco(maxBtn, maximized ? "lucide--minimize-2" : "lucide--maximize-2");
    maxBtn.classList.toggle("on", maximized);
    maxBtn.title = maximized ? t("窗口化：缩回可拖动的尺寸") : t("最大化：撑满可用空间");
  };
  maxBtn.onclick = () => {
    if (maximized) {
      const nearFull = !restoreSize ||
        restoreSize.w >= window.innerWidth * 0.93 ||
        restoreSize.h >= window.innerHeight * 0.91;
      box.style.width = (nearFull ? WIN_W() : restoreSize.w) + "px";
      box.style.height = (nearFull ? WIN_H() : restoreSize.h) + "px";
      if (restorePos) {
        mask.style.left = restorePos.x + "px";
        mask.style.top = restorePos.y + "px";
      }
      maximized = false;
      restoreSize = null;
      restorePos = null;
    } else {
      restoreSize = { w: box.offsetWidth, h: box.offsetHeight };
      const r = mask.getBoundingClientRect();
      restorePos = { x: r.left, y: r.top };
      mask.style.left = "8px";
      mask.style.top = "8px";
      box.style.width = "98vw";
      box.style.height = "96vh";
      maximized = true;
    }
    syncMax();
    reflow();
  };
  syncMax();


  // ── 类型多选 ──
  //    从单选下拉改成一排可切换的按钮：最常用的组合就是「图片 + 视频」，
  //    所以默认勾这两类（不是只勾这个节点吃得下的那一类）。
  //    勾了它吃不下的（黄色高亮），那些格子会正常显示但选不了 ——
  //    这时面板就是个纯浏览器，这是有人要的用法。
  const kindsBox = mask.querySelector(".mb-kinds");
  let kinds = loadKinds();   // 空集 = 不筛，全看
  const kindButtons = new Map();
  for (const item of kindFilterModel([], spec?.kind, kinds)) {
    const b = mbElButton();
    b.dataset.kind = item.id;
    b.innerHTML = `${mbIco(item.icon)}<span class="lab"></span><span class="count"></span>`;
    b.onclick = () => {
      kinds.has(item.id) ? kinds.delete(item.id) : kinds.add(item.id);
      save(KINDS_KEY, [...kinds]);
      memo.scroll = 0;
      buildKinds();
      render(false);
    };
    kindButtons.set(item.id, b);
    kindsBox.appendChild(b);
  }
  const buildKinds = () => {
    // 只剩这个节点吃不下的类型时，别让筛选把屏幕清空 —— 那样看着像坏了
    const initial = kindFilterModel(rawFiles, spec?.kind, kinds);
    // 首次请求返回前 rawFiles 也是空数组；这时只能初始化禁用态，不能误清用户偏好。
    if (rawFiles.length && kinds.size && !initial.some((item) => item.active)) kinds = new Set();

    for (const item of kindFilterModel(rawFiles, spec?.kind, kinds)) {
      const b = kindButtons.get(item.id);
      const label = t(item.label);
      const alien = accept && item.id !== spec?.kind;
      b.querySelector(".lab").textContent = label;
      b.querySelector(".count").textContent = item.count;
      b.disabled = !item.enabled;
      b.classList.toggle("on", item.active);
      b.classList.toggle("alien", item.enabled && alien);
      b.setAttribute("aria-pressed", String(item.active));
      b.title = !item.enabled
        ? t("当前范围没有{label}", { label })
        : alien
        ? t("{label}：这个节点用不了，勾上只是拿来浏览（点了会说明原因）", { label })
        : t("只看/不看{label}。可以多选，全不选＝全都看", { label });
      b.setAttribute("aria-label", `${label} ${item.count}. ${b.title}`);
    }
  };
  buildKinds();
  applyLangLive = () => {
    applyI18n(mask);
    syncScopeButtons();
    mask.querySelectorAll("[data-censor]").forEach((b) => {
      const k = b.dataset.censor;
      if (CENSOR_TITLE[k]) b.title = CENSOR_TITLE[k];
    });
    syncMode();
    syncSize();
    syncMax();
    setRefreshBusy(refreshBtn.disabled);
    buildKinds();
    rebuildScope();
    drawCrumb();
    syncPreloadBtn();
    render(true);
  };


  // ── 八向缩放的拖拽逻辑 ──
  //    最小尺寸不是随手定的，是按「面板还能正常用」倒推：
  //    宽 = 最小档一行 2 个格子（2×150 + 间距 + 内边距）+ 工具栏不至于挤成三行；
  //    高 = 工具栏 + 面包屑 + 至少一行格子 + 底部状态条。
  //    这是可用性的首选下限；若设备 viewport 本身更小，则必须让 viewport 上限优先，
  //    避免手机横向溢出。此时格子会自然退成单列，顶栏继续换行。
  const MIN_W = 2 * MIN_CELL + GAP + 24 + 32;      // ≈ 460
  const MIN_H = 340;
  box.style.setProperty("--mb-min-w", MIN_W + "px");
  box.style.setProperty("--mb-min-h", MIN_H + "px");

  for (const dir of ["n", "s", "w", "e", "nw", "ne", "sw", "se"]) {
    const h = document.createElement("div");
    h.className = "mb-rz " + dir;
    h.addEventListener("pointerdown", (ev) => {
      if (maximized) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = box.getBoundingClientRect();
      const x0 = ev.clientX, y0 = ev.clientY;
      const w0 = r.width, h0 = r.height;
      box.classList.add("rzing");
      h.setPointerCapture(ev.pointerId);

      const move = (e) => {
        const dx = e.clientX - x0, dy = e.clientY - y0;
        const next = windowResizeDelta(dir, dx, dy, { x: r.left, y: r.top, w: w0, h: h0 });
        let w = next.w, ht = next.h;
        w = Math.min(window.innerWidth * 0.98, Math.max(MIN_W, w));
        ht = Math.min(window.innerHeight * 0.96, Math.max(MIN_H, ht));
        const clamped = clampWindowResize(
          dir, next, { x: r.left, y: r.top, w: w0, h: h0 },
          MIN_W, MIN_H, window.innerWidth, window.innerHeight,
        );
        box.style.width = w + "px";
        box.style.height = ht + "px";
        mask.style.left = clamped.x + "px";
        mask.style.top = clamped.y + "px";
      };
      const up = () => {
        box.classList.remove("rzing");
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        try { h.releasePointerCapture(ev.pointerId); } catch {}
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
    });
    box.appendChild(h);
  }

  // ── 弹窗大小：拖动后记下来，下次打开沿用 ──
  if (window.ResizeObserver) {
    let rt = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        // 关弹窗时 ResizeObserver 还会再响一次，此时元素已脱离文档、尺寸是 0，
        // 直接写进去会存下 {w:0,h:0} 污染下次打开。先确认它还在文档里再记。
        if (!box.isConnected || box.offsetWidth < 100 || box.offsetHeight < 100) return;
        // 拖窗改变了实际格子宽度；先刷新 --mb-peek 等响应式变量，再重排格子，
        // 否则卡片变大/变小了，角落按钮仍停在拖动前的尺寸。
        syncSize();
        // 最大化时别记 —— 记了下次一打开就是满屏，而且"窗口化"要还原的
        // 那个尺寸也丢了。只记你自己拖出来的大小。
        if (maximized) { reflow(); return; }
        save("mediabrowser.boxsize", { w: box.offsetWidth, h: box.offsetHeight });
        reflow();                                        // 拖大拖小都要重排
      }, 160);
    });
    ro.observe(box);
    roStop = () => { clearTimeout(rt); ro.disconnect(); };
  }

  load();
  setTimeout(() => input.focus(), 50);
}

// 装按钮。抽出来是因为要挂两个时机：
//   nodeCreated     —— 用户新拖一个节点
//   loadedGraphNode —— 从已存的流里载入节点
// 只挂前者不够：VHS 系节点在 configure 阶段会按 widgets_values 重建 widgets，
// 早加的按钮被整个换掉（实测 VHS_LoadVideo 按钮消失）。后者在 configure 之后跑。
// 标题改过的加载器（【输入】首帧原图）class 仍可能不在表里；Browse gallery
// 是按 image_upload 控件挂的，我们也认这个，否则只见别人的按钮。
const uploadFlagOf = (w) =>
  w?.options?._origUploadFlag
  || (w?.options?.image_upload && "image_upload")
  || (w?.options?.video_upload && "video_upload")
  || (w?.options?.audio_upload && "audio_upload")
  || "";
const specFor = (node) => {
  const cls = node.comfyClass || node.type;
  if (NODE_SPECS[cls]) return NODE_SPECS[cls];
  for (const w of node.widgets || []) {
    const flag = uploadFlagOf(w);
    if (flag === "image_upload") {
      return { widget: w.name, root: "input", accept: KIND_IMG, kind: "image", label: "图片" };
    }
    if (flag === "video_upload") {
      return { widget: w.name, root: "input", accept: KIND_VID, kind: "video", label: "视频" };
    }
    if (flag === "audio_upload") {
      return { widget: w.name, root: "input", accept: KIND_AUD, kind: "audio", label: "音频" };
    }
  }
  return null;
};
// VHS 的预览部件认不得 `xx.mp4 [output]` 这种标注，得我们替它算对。
//
// 它对上传版节点（VHS_LoadVideo / VHS_LoadVideoFFmpeg）是这么解析的
// （ComfyUI-VideoHelperSuite/web/js/VHS.core.js:1949）：
//
//     let parts = ["input", value];                          // type 写死成 input
//     let extension = parts[1].slice(lastIndexOf(".") + 1);  // 从**整串**取扩展名
//
// 于是 `_实验/2026-08/a.mp4 [output]` 被解析成
//   type = "input"（错，该是 output）
//   format = "video/mp4 [output]"（标注漏进了 MIME 类型）
// 预览便去 input 里找这个文件 → 404 → 用户看到的就是「没法选视频」。
//
// 后端其实是通的：VHS 声明了 VALIDATE_INPUTS(s, video)，ComfyUI 因此跳过
// 「值必须在下拉选项里」的内置检查（execution.py:1019），它自己走
// exists_annotated_filepath，是认标注的。所以只需要把**预览**扶正。
//
// 只在节点确实有 updateParameters 时才动（那是 VHS 挂上去的）——
// 别的加载器没有这个方法，静默跳过就行。
const VHS_IMAGE_EXT = ["gif", "webp", "avif"];      // 跟 VHS.core.js 里那份保持一致
function fixVhsPreview(node, name, root) {
  if (typeof node.updateParameters !== "function") return;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const kind = VHS_IMAGE_EXT.includes(ext) ? "image" : "video";
  try {
    node.updateParameters({ filename: name, type: root, format: `${kind}/${ext}` }, true);
  } catch (e) {
    console.warn("[MediaBrowser] 修正 VHS 预览参数失败", e);
  }
}

function resetFabToDefault() {
  const fab = document.querySelector(".mb-fab");
  if (!fab) return;
  const pos = defaultFabPos(window.innerWidth, window.innerHeight, 48, 8);
  fab.style.left = pos.x + "px";
  fab.style.top = pos.y + "px";
  fab.style.right = "auto";
  fab.style.bottom = "auto";
}

function tryOpenBrowseFromFab() {
  if (document.querySelector(".mb-play") || document.querySelector(".mb-confirm")) {
    notify(t("请先关掉预览或确认框"));
    return;
  }
  if (!pickerRegistry.canOpen()) {
    notify(t("最多同时打开 {n} 个窗口", { n: PICKER_MAX }));
    focusPicker(pickerRegistry.front());
    return;
  }
  const stored = memoFor("browse:any", "output");
  openPicker({
    folder: PLACE_REAL_ROOTS.has(stored.root) ? stored.root : "output",
    spec: { kind: "any" },
    current: "",
    onPick: null,
  });
}

function mountFab() {
  if (document.querySelector(".mb-fab")) return;
  addStyle();
  const fab = mbElButton("mb-fab");
  fab.textContent = "MB";
  fab.tabIndex = 0;
  const titleOf = () => t("打开媒体浏览器（再点一次会新开一扇）");
  fab.title = titleOf();
  fab.setAttribute("aria-label", fab.title);
  const applyPos = (pos) => {
    fab.style.left = pos.x + "px";
    fab.style.top = pos.y + "px";
    fab.style.right = "auto";
    fab.style.bottom = "auto";
  };
  const saved = loadJSON("mediabrowser.fab.pos", null);
  const vw = () => window.innerWidth, vh = () => window.innerHeight;
  applyPos(saved && Number.isFinite(saved.x)
    ? clampFabPos(saved.x, saved.y, vw(), vh(), 48, 8)
    : defaultFabPos(vw(), vh(), 48, 8));
  let drag = null;
  fab.addEventListener("pointerdown", (ev) => {
    const r = fab.getBoundingClientRect();
    drag = { x: ev.clientX, y: ev.clientY, left: r.left, top: r.top, moved: false };
    fab.classList.add("dragging");
    try { fab.setPointerCapture(ev.pointerId); } catch { /* 旧环境没有 */ }
    ev.preventDefault();
  });
  fab.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!fabIsClick(dx, dy, 6)) drag.moved = true;
    if (!drag.moved) return;
    applyPos(clampFabPos(drag.left + dx, drag.top + dy, vw(), vh(), 48, 8));
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    const wasClick = !drag.moved && fabIsClick(dx, dy, 6);
    fab.classList.remove("dragging");
    const r = fab.getBoundingClientRect();
    const pos = clampFabPos(r.left, r.top, vw(), vh(), 48, 8);
    applyPos(pos);
    save("mediabrowser.fab.pos", pos);
    drag = null;
    if (!wasClick) return;
    fab.title = titleOf();
    fab.setAttribute("aria-label", fab.title);
    tryOpenBrowseFromFab();
  };
  fab.addEventListener("pointerup", endDrag);
  fab.addEventListener("pointercancel", endDrag);
  fab.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fab.title = titleOf();
      fab.setAttribute("aria-label", fab.title);
      tryOpenBrowseFromFab();
    }
  });
  window.addEventListener("resize", () => {
    const r = fab.getBoundingClientRect();
    applyPos(clampFabPos(r.left, r.top, vw(), vh(), 48, 8));
  });
  document.body.appendChild(fab);
}

function attachButton(node) {
  if (!node._mbCfgHook) {
    node._mbCfgHook = true;
    const origCfg = node.onConfigure;
    node.onConfigure = function () {
      const r = origCfg?.apply(this, arguments);
      queueMicrotask(() => attachButton(this));
      return r;
    };
  }
  const spec = specFor(node);
  if (!spec) return;
  if (node.widgets) {
    for (let i = node.widgets.length - 1; i >= 0; i--) {
      const n = String(node.widgets[i].name);
      if (n.startsWith("🔲 宫格选") || n.startsWith("🔲 选片")) {
        node.widgets.splice(i, 1);
      }
    }
  }
  if (node.widgets?.some((w) => String(w.name).startsWith("🔲 浏览"))) return;

  const btn = node.addWidget("button", "🔲 浏览资源", null, () => {
    // 部件到这时才找：VHS 的 video 部件是它自己稍后补的
    const w = node.widgets?.find((x) => x.name === spec.widget);
    if (!w) {
      alert(t("这个节点上找不到「{widget}」这一栏，没法把选中的填进去。", { widget: spec.widget }) +
            "\n" + t("先用节点自带的下拉选。"));
      return;
    }
    const existing = pickerRegistry.findByNode(node);
    if (existing) { focusPicker(existing); return; }
    if (!pickerRegistry.canOpen()) {
      notify(t("最多同时打开 {n} 个窗口", { n: PICKER_MAX }));
      focusPicker(pickerRegistry.front());
      return;
    }
    openPicker({
      folder: spec.root,
      spec,
      current: stripAnn(w.value),
      node,
      onPick: (name, root) => {
        w.value = annotate(name, root);
        try { w.callback?.(w.value, app.canvas, node); }
        catch (e) { console.warn("[MediaBrowser]", e); }
        fixVhsPreview(node, name, root);
        node.setDirtyCanvas(true, true);
      },
    });
  }, { serialize: false });
  if (btn) btn.serialize = false;
  placeBrowseButton(node, btn, spec);
  node.setDirtyCanvas(true, true);
}

// addWidget 默认追加到末尾；LoadImage 末尾常是预览，按钮会被绿底吃掉。
// 插到 combo / 上传后面、预览前面，和 Browse gallery 同一排可见区。
function placeBrowseButton(node, btn, spec) {
  const widgets = node.widgets;
  if (!widgets || !btn) return;
  const cur = widgets.indexOf(btn);
  if (cur >= 0) widgets.splice(cur, 1);
  let at = widgets.findIndex((w) => w.name === spec.widget);
  at = at >= 0 ? at + 1 : widgets.length;
  while (at < widgets.length) {
    const n = String(widgets[at]?.name || "");
    const tp = widgets[at]?.type;
    if (tp === "image") break;
    if (n === "upload" || n === "选择文件上传") {
      at += 1;
      continue;
    }
    break;
  }
  for (let i = at; i < widgets.length; i++) {
    if (widgets[i]?.type === "image") {
      at = i;
      break;
    }
  }
  widgets.splice(at, 0, btn);
}

const nodeDataLooksLikeLoader = (nodeData) => {
  if (NODE_SPECS[nodeData?.name]) return true;
  const inputs = nodeData?.input || {};
  for (const group of ["required", "optional"]) {
    const block = inputs[group] || {};
    for (const entry of Object.values(block)) {
      const opts = Array.isArray(entry) ? entry[1] : entry;
      if (opts && typeof opts === "object" &&
          (opts.image_upload || opts.video_upload || opts.audio_upload ||
           opts._origUploadFlag)) {
        return true;
      }
    }
  }
  return false;
};

app.registerExtension({
  name: "MediaBrowser",
  // 挂 onAdded：LiteGraph 在节点进图时必调，不管它是用户拖的、载流来的、
  // 还是脚本 createNode 出来的。而且它在 configure 之后 —— VHS 系节点会在
  // configure 阶段按 widgets_values 重建 widgets，挂早了按钮会被冲掉。
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_SPECS[nodeData.name] && !nodeDataLooksLikeLoader(nodeData)) return;
    const orig = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function (graph) {
      const r = orig?.apply(this, arguments);
      attachButton(this);
      return r;
    };
  },
  // 图已经摊在画布上时再扫一遍。gallery-loader 靠这个挂上 Browse gallery；
  // 只靠 loadedGraphNode 会在部分载流顺序里漏掉，看起来像「入口没了」。
  setup() {
    const scan = () => {
      for (const n of app.graph?._nodes || []) attachButton(n);
    };
    scan();
    queueMicrotask(scan);
    mountFab();
  },
  // 兜底：万一哪个节点的 onAdded 被别的插件覆盖掉没链上
  nodeCreated(node) { attachButton(node); },
  loadedGraphNode(node) { attachButton(node); },
});
