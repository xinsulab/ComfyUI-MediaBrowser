/* 真环境冒烟测试 —— 在跑着的 ComfyUI 页面里，把常走的交互走一遍。
 *
 * 为什么需要它：
 *   前端是单文件、只能在 ComfyUI 的浏览器环境里活，所以 tests/test_mediabrowser.py
 *   那一百多条全是**拿正则扫源码**，不是真跑。扫源码抓不到三类错，而这三类都真实发生过：
 *     ① 引用了不存在的常量 —— 删掉 CELL_ACTION_COUNT 漏改一处引用，
 *        node --check 过、全部测试绿灯，点「浏览资源」才 ReferenceError；
 *     ② 事件顺序错         —— 长按的取消条件写在 pointerup 上，点一下就弹出右键菜单；
 *     ③ 状态残留           —— 滑动标记不清，下一次真正的点击被白白吃掉。
 *
 *   不用 jsdom：那要把 ComfyUI 的模块桩出来（几百行，还得跟着它升级），
 *   而且桩是虚构环境，测试可能通过一个真实 ComfyUI 里根本不成立的行为。
 *   在真页面里跑没有这个问题。
 *
 * 跑法一（手动）：开着 ComfyUI 的页面，把本文件粘进控制台，然后 await mbSmoke()
 * 跑法二（给自动化用）：把本文件拷成 web/_smoke.txt（ComfyUI 会把 web/ 静态托管，
 *   而 .txt 不会被它当扩展 import），页面里
 *     eval(await (await fetch("/extensions/ComfyUI-MediaBrowser/_smoke.txt")).text())
 *   跑完记得删掉那个临时文件。
 *
 * ⚠️ 让页面处于**前台标签**再跑：后台标签会把 setTimeout 节流到约每秒一次，
 *   整轮会从十几秒拖到一两分钟，看起来像卡住了（实测踩过）。
 *
 * 以只读为主；会临时改几个设置，跑完把 mediabrowser.* 的 localStorage 原样还原
 * （见 restore）。不会动节点的值，也不会删任何文件。
 */
window.mbSmoke = async function mbSmoke() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // ⚠️ 别用固定 sleep 攒时间。浏览器对**不可见**的标签页会节流 setTimeout
  //    （实测 setTimeout(100) 真等了 986ms，约 10 倍），一串固定等待会把整轮
  //    从十几秒拖到好几分钟，看着像卡死 —— 连超时看门狗自己也一起被节流，救不了场。
  //    所以一律「等到条件成立为止，最多等 N 毫秒」：条件一成立立刻往下走。
  const until = async (cond, ms = 8000) => {
    const end = performance.now() + ms;
    for (;;) {
      let v = false;
      try { v = cond(); } catch { v = false; }
      if (v) return true;
      if (performance.now() > end) return false;
      await wait(50);
    }
  };
  const gone = (q, ms) => until(() => !document.querySelector(q), ms);
  const shows = (q, ms) => until(() => !!document.querySelector(q), ms);
  const pass = [];
  const fail = [];
  const errs = [];
  let step = "起步";
  // 挂到 window 上：卡住时从外面一眼看得到停在哪，不用靠猜
  const at = (s2) => { step = s2; window.__mbSmokeStep = s2; };
  at("起步");
  const ok = (name, cond, detail) => {
    if (cond) pass.push(name);
    else fail.push(detail ? name + " —— " + detail : name);
  };

  // 整场任何未捕获异常 / console.error 都记下来
  const onErr = (e) => errs.push("onerror: " + (e.message || e));
  const onRej = (e) => errs.push("unhandledrejection: " + (e.reason && e.reason.message || e.reason));
  const realErr = console.error;
  console.error = (...a) => { errs.push("console.error: " + a.map(String).join(" ").slice(0, 200)); realErr(...a); };
  window.addEventListener("error", onErr);
  window.addEventListener("unhandledrejection", onRej);

  // 存档，跑完原样放回去
  const snap = {};
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("mediabrowser.")) snap[k] = localStorage.getItem(k);
  }
  const esc = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const restore = () => {
    for (let i = 0; i < 4; i++) esc();
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("mediabrowser.")) localStorage.removeItem(k);
    }
    for (const k of Object.keys(snap)) localStorage.setItem(k, snap[k]);
    console.error = realErr;
    window.removeEventListener("error", onErr);
    window.removeEventListener("unhandledrejection", onRej);
  };

  // 总超时。没有它的话，任何一步卡住都表现成「还在跑」，
  // 分不清是慢还是死 —— 这次就被这个坑了一轮。
  let timedOut = false;
  const guard = setTimeout(() => { timedOut = true; }, 300000);
  const stepGuard = async (label, fn) => {
    if (timedOut) return;
    at(label);
    await fn();
  };

  try {
    // ── 开窗 ──
    const app = window.app;
    let node = app && app.graph && app.graph._nodes.find((n) => n.type === "LoadImage");
    if (!node) {
      node = window.LiteGraph.createNode("LoadImage");
      app.graph.add(node);
      node.pos = [60, 60];
      await wait(600);
    }
    const btn = (node.widgets || []).find((w) => String(w.name).indexOf("浏览") >= 0);
    ok("加载节点上挂着「浏览资源」按钮", !!btn);
    if (!btn) throw new Error("没有入口按钮，后面没法测");

    // 只关**真的开着的那一层**，并等它真没了。
    // 别一把梭连按几下 Esc —— Esc 也会关浏览窗口本身，后面几节就全跑在
    // 「窗口早没了」的前提上，报出来的失败全是假的（这一条实测坑了两轮）。
    const closeIf = async (q) => {
      if (!document.querySelector(q)) return;
      esc();
      await until(() => !document.querySelector(q), 5000);
    };
    // 保证浏览窗口开着（虚拟滚动会换掉 DOM 节点，格子要重新取）
    const ensureOpen = async () => {
      if (document.querySelector(".mb-mask")) return;
      btn.callback();
      await shows(".mb-mask", 15000);
      await until(() => document.querySelectorAll(".mb-cell[data-path]").length > 0, 20000);
    };
    at("开窗");
    btn.callback();
    ok("浏览窗口打开了", await shows(".mb-mask", 15000));
    await until(() => document.querySelectorAll(".mb-cell[data-path]").length > 0, 20000);

    const cells = [...document.querySelectorAll(".mb-cell[data-path]")];
    ok("列表出了格子", cells.length > 0, "一个都没有");
    if (!cells.length) throw new Error("没有格子，后面没法测");
    const isMedia = (p) => /[.](png|jpe?g|webp|gif|bmp|mp4|webm|mkv|mov|avi|m4v)$/i.test(p);
    const cell = cells.find((c) => isMedia(c.dataset.path)) || cells[0];
    const canCensorHere = isMedia(cell.dataset.path);

    // ── 动作顺序：三个界面都必须是同一串的子序列 ──
    const ORDER = ["pick", "view", "peek", "lock", "skip", "redo", "fav", "shot", "copyimage", "plain", "brush", "meta", "wf", "trash"];
    const ICO2ID = {
      "check": "pick", "zoom-in": "view", "eye": "peek", "lock": "lock", "lock-open": "lock",
      "ban": "skip", "star": "fav", "star-fill": "fav", "camera": "shot", "image": "plain",
      "image-workflow": "copyimage", "paintbrush": "brush", "info": "meta",
      "workflow": "wf", "trash-2": "trash",
    };
    const idOf = (b) => {
      const cls = (b.querySelector("i") || {}).className || "";
      const hit = Object.keys(ICO2ID).find((k) => cls.indexOf("--" + k + "]") >= 0);
      if (hit) return ICO2ID[hit];
      return cls.indexOf("scan") >= 0 || b.className.indexOf("redo") >= 0 ? "redo" : null;
    };
    const sorted = (a) => a.join() === [...a].sort((x, y) => x - y).join();
    at("动作条顺序");
    const barIds = [...cell.querySelectorAll(".mb-bar button")].map(idOf).filter(Boolean);
    const barPos = barIds.map((x) => ORDER.indexOf(x));
    ok("格子操作条按统一顺序排", barPos.every((x) => x >= 0) && sorted(barPos),
       "实际是 " + barIds.join(" · "));
    ok("「用这张」排第一、而且是那个绿的",
       barIds[0] === "pick" && !!cell.querySelector(".mb-bar button.pick"),
       "第一个是 " + barIds[0]);

    // ── 右键菜单：能开，三条关法都好使 ──
    const rclick = () => cell.dispatchEvent(new MouseEvent("contextmenu",
      { bubbles: true, clientX: 300, clientY: 240 }));
    at("右键菜单");
    rclick();
    ok("右键能开出菜单", await shows(".mb-cellmenu", 6000));
    const menu = document.querySelector(".mb-cellmenu");
    if (menu) {
      const menuIds = [...menu.querySelectorAll(".grid .tile[data-i]")].map(idOf).filter(Boolean);
      ok("菜单顺序跟操作条一致", sorted(menuIds.map((x) => ORDER.indexOf(x))),
         "菜单是 " + menuIds.join(" · "));
      ok("菜单是宫格（不是一条一行的长列表）", menuIds.length >= 4 && !!menu.querySelector(".grid"),
         "只解析到 " + menuIds.length + " 格");
      ok("菜单有标题栏和 ×", !!menu.querySelector(".hd .x"));
      // 二级：遮蔽应当是「点进去」而不是摊在一级里
      const moreBtn = menu.querySelector("[data-more]");
      // 只有图片/视频才有遮蔽这一节；.sqlite / .py 这种本来就不该有入口
      ok("遮蔽收成了二级入口", canCensorHere ? !!moreBtn : !moreBtn,
         canCensorHere ? "图片上没有入口" : "非媒体文件不该有遮蔽入口");
      if (moreBtn) {
        moreBtn.click();
        await until(() => document.querySelector(".mb-cellmenu .parts"), 6000);
        // ⚠️ 重新取：遮蔽面板是**另开的一个浮层**（跟大图底栏共用同一份），
        //    不是在原来那个上换页，旧引用已经脱离文档了。
        const panel = document.querySelector(".mb-cellmenu");
        ok("点进去出现了遮蔽面板", !!panel && !!panel.querySelector(".parts")
           && !!panel.querySelector(".hd .back"), "没有返回键或没有部位面板");
        ok("面板里有四条单张滑块",
           panel && panel.querySelectorAll("[data-tune]").length === 4,
           "只有 " + (panel ? panel.querySelectorAll("[data-tune]").length : 0) + " 条");
        const back = panel && panel.querySelector(".hd .back");
        if (back) back.click();
        await until(() => document.querySelector(".mb-cellmenu .grid .tile[data-i]"), 6000);
        ok("返回键能回到一级宫格", !!document.querySelector(".mb-cellmenu .grid .tile[data-i]"));
      }
      esc();
      ok("Esc 关得掉菜单", await gone(".mb-cellmenu", 5000));
      ok("Esc 只关菜单，没把浏览窗口一起带走", !!document.querySelector(".mb-mask"));
      rclick();
      await shows(".mb-cellmenu", 6000);
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 3, clientY: 3 }));
      ok("点外面关得掉菜单", await gone(".mb-cellmenu", 5000));
    }

    // ── 触屏点一下：**不能**弹出右键菜单 ──
    const tap = (type, x, y) => cell.dispatchEvent(new PointerEvent(type,
      { bubbles: true, pointerType: "touch", clientX: x, clientY: y, isPrimary: true }));
    tap("pointerdown", 200, 200);
    await wait(120);
    tap("pointerup", 201, 200);
    await wait(720);
    ok("触屏点一下不会弹出右键菜单", !document.querySelector(".mb-cellmenu"),
       "长按的取消条件又写回 pointerup 上了");
    await closeIf(".mb-cellmenu");

    // ── 大图：点开 / 翻页 / 滑动 / 再点一下关掉 ──
    at("大图");
    await ensureOpen();
    cell.click();
    ok("点格子打开了大图", await shows(".mb-play", 12000));
    const play = document.querySelector(".mb-play");
    if (play) {
      const stage = play.querySelector(".mb-stage");
      const idxEl = play.querySelector(".idx");
      const pickTxt = (play.querySelector(".pick") || {}).textContent || "";
      ok("大图的主按钮叫「用这张」（跟格子同名）", pickTxt.indexOf("用这张") >= 0, "叫的是 " + pickTxt.trim());
      const barIds2 = [...play.querySelectorAll(".bar button")].map(idOf).filter(Boolean);
      ok("大图底栏也按同一串排", sorted(barIds2.map((x) => ORDER.indexOf(x))),
         "大图是 " + barIds2.join(" · "));
      for (const must of ["pick", "lock", "fav", "shot", "copyimage", "plain", "brush", "meta", "wf", "trash"]) {
        ok("大图底栏有「" + must + "」", barIds2.indexOf(must) >= 0, "格子里有、点进去反而没有");
      }
      // ① 先在**确定是图片**的这一张上测「再点一下关掉」。
      //    必须放在翻页之前：翻过去可能是视频，而视频**故意**不响应点击关闭
      //    （那一下要留给播放器暂停/拖进度条）—— 拿视频测等于自己造假失败。
      const im0 = stage.querySelector("img");
      ok("大图里当前是图片（下面这条才有意义）", !!im0);
      if (im0) {
        im0.click();
        ok("再点一下图片能关掉大图", await gone(".mb-play", 6000));
        ok("关掉大图之后浏览窗口还在", !!document.querySelector(".mb-mask"));
      }

      // ② 翻页 / 滑动：重新打开一次再测
      cell.click();
      await shows(".mb-play", 12000);
      const play2 = document.querySelector(".mb-play");
      const idx2 = play2 && play2.querySelector(".idx");
      const stage2 = play2 && play2.querySelector(".mb-stage");
      if (play2 && idx2 && stage2) {
        const before = idx2.textContent;
        const nx = play2.querySelector(".next");
        if (nx) nx.click();
        await wait(260);
        ok("能翻到下一张", idx2.textContent !== before, "还停在 " + before);
        const rr = stage2.getBoundingClientRect();
        const sw = (type, x) => stage2.dispatchEvent(new PointerEvent(type,
          { bubbles: true, pointerType: "touch", clientX: x, clientY: rr.y + rr.height / 2, isPrimary: true }));
        const beforeSwipe = idx2.textContent;
        sw("pointerdown", rr.x + rr.width * 0.75);
        sw("pointerup", rr.x + rr.width * 0.75 - 170);
        await wait(260);
        ok("触屏左右滑能翻页", idx2.textContent !== beforeSwipe, "还停在 " + beforeSwipe);
        ok("滑完之后大图还开着（那一发 click 被挡掉了）", !!document.querySelector(".mb-play"));
      }
    }
    await closeIf(".mb-play");
    await ensureOpen();
    await wait(420);

    // ── 设置：预设是「一键填表」，表一直看得见 ──
    const gear = [...document.querySelectorAll(".mb-root button, .mb-top button")]
      .find((b) => (b.title || "").indexOf("设置") === 0);
    if (gear) gear.click();
    await shows("select.thumbpx", 10000);
    at("设置");
    const sel = document.querySelector("select.thumbpx");
    ok("设置里有「一键套用」", !!sel);
    const box = document.querySelector(".mb-percell");
    const rows = [...document.querySelectorAll(".mb-percell select")];
    ok("逐档表一直看得见", rows.length === 5 && box && !box.hidden, rows.length + " 行");
    if (sel && rows.length === 5) {
      sel.value = "sharp";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(520);
      const now = [...document.querySelectorAll(".mb-percell select")].map((s) => s.value).join(",");
      ok("选预设会把表填成那套数", now === "640,768,1024,1536,2048", "表里是 " + now);
      rows[2].value = "2048";
      rows[2].dispatchEvent(new Event("change", { bubbles: true }));
      await wait(420);
      ok("手改一档后下拉回显成「自定义」", sel.value === "", "下拉是 " + (sel.value || "(自定义)"));
    }
    const cls = document.querySelector("[data-s=close]");
    if (cls) cls.click();
    await wait(420);
  } catch (e) {
    fail.push("跑崩了（停在「" + step + "」）：" + (e && e.message || e));
  } finally {
    clearTimeout(guard);
    if (timedOut) fail.push("超时：卡在「" + step + "」超过 150 秒");
    try { restore(); } catch (e2) { fail.push("还原时出错：" + e2); }
    await wait(320);
  }

  const bad = fail.length + errs.length;
  const out = {
    结论: bad ? bad + " 项有问题" : "全部通过（" + pass.length + " 项）",
    通过: pass.length,
    失败: fail,
    控制台报错: errs,
  };
  console.log(bad ? "冒烟失败" : "冒烟通过", out);
  return out;
};
