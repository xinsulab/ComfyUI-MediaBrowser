/**
 * 抽出 mediabrowser.js 里 LAYER_HELPERS 段，真跑「后退键关最上面一层」的层栈。
 * 这段全是「谁该退、谁不该退」的时序判断，光扫源码看不出对错 ——
 * 而且错了的症状很难查：要么后退键关不掉，要么一下退两格把 ComfyUI 也带走。
 */
import fs from "fs";
import vm from "vm";

const srcPath = process.argv[2];
if (!srcPath) {
  console.error("用法: node run_layer_stack.mjs <mediabrowser.js>");
  process.exit(2);
}
const src = fs.readFileSync(srcPath, "utf8");
const m = src.match(/\/\* LAYER_HELPERS_BEGIN \*\/([\s\S]*?)\/\* LAYER_HELPERS_END \*\//);
if (!m) {
  console.error("mediabrowser.js 缺少 LAYER_HELPERS_BEGIN/END 段");
  process.exit(1);
}
const ctx = {};
vm.runInNewContext(m[1] + "\nthis.makeLayerStack = makeLayerStack;", ctx);

const fail = (msg) => { console.error("  FAIL  " + msg); process.exit(1); };
const mkHist = () => {
  const calls = { push: 0, back: 0 };
  // 跟浏览器一样：push 在当前条目后面追加，back 回到上一条（上一条的 state 还在）。
  const entries = [null];
  let idx = 0;
  return {
    calls,
    get state() { return entries[idx]; },
    set state(v) { entries[idx] = v; },
    pushState(s) {
      calls.push++;
      entries.splice(idx + 1);
      entries.push(s);
      idx = entries.length - 1;
    },
    back() {
      calls.back++;
      if (idx > 0) idx--;
    },
  };
};

// ① 开一层 = 推一格历史
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  st.push(() => {});
  if (st.depth() !== 1 || h.calls.push !== 1) fail("开一层应当 depth=1 且推一格历史");
}

// ② 自己关（×/Esc）= 退一格历史；随后浏览器回传的那一发 popstate 不该再关一层。
//    必须垫一层在下面：只推一层的话「栈已经空了」会把缺失的守卫挡住，测不出来。
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  const hit = [];
  st.push(() => hit.push("下"));
  st.push(() => hit.push("上"));
  st.pop();                         // 相当于点了上面那层的 ×
  if (st.depth() !== 1 || h.calls.back !== 1) fail("自己关应当退一格历史，且下面那层还在");
  st.onPop();                       // back() 之后浏览器回传的那一发
  if (hit.length) fail(`自己关之后，回传的 popstate 不该再关一层，实际关了: ${hit.join(",")}`);
  if (st.depth() !== 1) fail("下面那层不该被顺手关掉");
}

// ⑦ 连着自己关两层：两发 popstate 都不该再关东西。
//    真实场景：连按两下 Esc，或者关掉大图之后紧跟着关浏览窗口。
//    history.back() 是异步的 —— 两次 pop() 同步发出去，两发 popstate 随后才到。
//    「有没有正在自己退」如果只用一个布尔存，第一发就把它清了，
//    第二发被当成用户按的后退键 → 多关一层。实测症状：关掉大图，
//    整个浏览窗口跟着一起没了。所以必须**计数**，不能是布尔。
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  const hit = [];
  st.push(() => hit.push("底"));
  st.push(() => hit.push("中"));
  st.push(() => hit.push("顶"));
  st.pop();                         // 关掉「顶」
  st.pop();                         // 紧接着关掉「中」
  if (st.depth() !== 1 || h.calls.back !== 2) fail("连关两层应当退两格历史，且底层还在");
  st.onPop();                       // 第一发回传
  st.onPop();                       // 第二发回传
  if (hit.length) fail(`连关两层之后，回传的两发 popstate 都不该再关东西，实际关了: ${hit.join(",")}`);
  if (st.depth() !== 1) fail(`底层被顺手关掉了，depth=${st.depth()}`);
}

// ③ 按后退键 = 关掉栈顶那层，且**不能**再退一格历史（close 里还会调 pop）。
//    同样要垫一层：只推一层时「栈已经空了」会替缺失的守卫兜底，看不出问题。
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  const hit = [];
  st.push(() => { hit.push("下"); st.pop(); });
  st.push(() => { hit.push("上"); st.pop(); });   // 真实的 close 就是这么写的
  st.onPop();
  if (hit.join(",") !== "上") fail(`后退键应当只关最上面那层，实际关了: ${hit.join(",")}`);
  if (h.calls.back !== 0) fail("后退键触发的关闭不能再退历史 —— 会一下退两格，把 ComfyUI 也带走");
  if (st.depth() !== 1) fail("下面那层应当还在");
}

// ④ 后进先出：只关最上面那一层
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  const hit = [];
  st.push(() => hit.push("下"));
  st.push(() => hit.push("上"));
  st.onPop();
  if (hit.join(",") !== "上") fail(`应当只关最上面那层，实际关了: ${hit.join(",")}`);
  if (st.depth() !== 1) fail("下面那层应当还在");
}

// ⑤ 栈空时按后退：不抛、不乱关
{
  const st = ctx.makeLayerStack(mkHist());
  st.onPop();
  st.pop();
  if (st.depth() !== 0) fail("空栈上操作不该把 depth 弄坏");
}

// ⑥ 历史 API 被禁用：开窗照常，只是没有后退键支持
{
  const bad = { pushState() { throw new Error("blocked"); }, back() { throw new Error("blocked"); } };
  const st = ctx.makeLayerStack(bad);
  st.push(() => {});
  if (st.depth() !== 1) fail("历史 API 不可用时也必须能开窗");
  st.pop();
  if (st.depth() !== 0) fail("历史 API 不可用时也必须能关窗");
}

// ⑧ 自己关一层时 onPop 必须回报「这发已消化」，好让窗口上的监听
//    拦住 Vue Router —— 否则 history.back() 会被当成用户按后退键，
//    画布一脏就弹出浏览器的「要离开此网站吗？」。
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  st.push(() => {});
  st.push(() => {});
  st.pop();
  const ate = st.onPop();
  if (ate !== true) fail("自己关之后回传的 popstate，onPop 必须返回 true（已消化）");
}

// ⑨ 栈空时的 popstate 是真的「离开这一页」，onPop 必须返回 false，
//    把事件交给浏览器 / Vue Router。不能把每一次后退都吞掉。
{
  const st = ctx.makeLayerStack(mkHist());
  const ate = st.onPop();
  if (ate !== false) fail("空栈上的 popstate 不该被我们吞掉，否则真的后退键会失灵");
}

// ⑩ 当前 history.state 不是我们 push 的（被 Vue Router replaceState 覆盖、
//    或 pushState 根本没成功）：pop() 绝不能再 hist.back()。
//    再退一格就会退到打开 Comfy 之前的网站，浏览器弹出「要离开此网站吗？」。
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  st.push(() => {});
  h.state = { current: "/" };          // 模拟 Vue Router 覆盖
  st.pop();
  if (h.calls.back !== 0) fail("state 里没有 mbLayer 时 pop() 仍调用了 history.back()，会把页面带走");
  if (st.depth() !== 0) fail("即便不能退历史，JS 层栈也该弹掉，否则关不掉浮层");
}

// ⑪ 点后面那扇浏览窗提到最前时，历史栈也得跟着换序。
//    否则 Esc 关的是 z-index 最前的窗，后退键关的仍是后进的那扇，两套入口对不上。
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  if (typeof st.raise !== "function") fail("层栈必须有 raise：点后面的浏览窗时后退键才能关掉它");
  const hit = [];
  const a = () => { hit.push("A"); st.pop(); };
  const b = () => { hit.push("B"); st.pop(); };
  a._mbPicker = true;
  b._mbPicker = true;
  st.push(a);
  st.push(b);
  st.raise(a);
  st.onPop();
  if (hit.join(",") !== "A") fail(`无大图时 raise 应让后退关掉被点到前面的那扇，实际: ${hit.join(",")}`);
  if (st.depth() !== 1) fail("另一扇浏览窗应当还在");
}

// ⑫ 大图压在浏览窗上：raise 一扇浏览窗只能在浏览窗之间换序，不能把它抽到大图上面。
//    否则后退键会先关掉浏览窗，大图变成无主浮层。
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  const hit = [];
  const a = () => { hit.push("A"); st.pop(); };
  const b = () => { hit.push("B"); st.pop(); };
  const viewer = () => { hit.push("view"); st.pop(); };
  a._mbPicker = true;
  b._mbPicker = true;
  st.push(a);
  st.push(b);
  st.push(viewer);
  st.raise(a);
  st.onPop();
  if (hit.join(",") !== "view") fail(`大图开着时 raise 浏览窗，后退应先关大图，实际: ${hit.join(",")}`);
  if (st.depth() !== 2) fail("关大图后两扇浏览窗都应还在");
}

// ⑬ 键盘点后面那扇的 ×：必须按引用摘自己。pop 栈顶会把前面那扇的历史弹掉，画面和后退键对不上。
{
  const h = mkHist();
  const st = ctx.makeLayerStack(h);
  if (typeof st.drop !== "function") fail("层栈必须有 drop");
  const hit = [];
  const a = () => { hit.push("A"); st.drop(a); };
  const b = () => { hit.push("B"); st.drop(b); };
  a._mbPicker = true;
  b._mbPicker = true;
  st.push(a);
  st.push(b);
  a();
  if (hit.join(",") !== "A") fail(`关后面那扇应只关它自己，实际: ${hit.join(",")}`);
  if (st.depth() !== 1) fail("前面那扇应当还在");
  const ate = st.onPop();
  if (ate !== true) fail("drop 触发的 hist.back 必须被 selfBack 消化");
  if (hit.length !== 1) fail("消化那发 popstate 不该再关剩下的窗");
  st.onPop();
  if (hit.join(",") !== "A,B") fail(`再按后退才关剩下那扇，实际: ${hit.join(",")}`);
}

console.log("layer stack: all passed");

