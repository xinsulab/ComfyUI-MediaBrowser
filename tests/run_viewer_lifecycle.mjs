// 抽出大图查看纯函数：预取计划、滚轮缩放、点图关掉的门槛。
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n');
// 执行真实的面板入口事件：规则改变要重绘，翻页/关闭后的回调不得回填。
{
  const begin = src.indexOf('  lay.querySelector(".act.tune").onclick =');
  const end = src.indexOf('  lay.querySelector(".redo").onclick', begin);
  const button = {};
  let changed, paints = 0, acts = 0, cleared = 0;
  const lay = { isConnected: true, querySelector: () => button };
  const stage = { classList: { remove: () => cleared++ } };
  const hooks = { openCensor: (path, anchor, callback) => {
    assert.equal(path, 'a.png');
    assert.equal(anchor, button);
    changed = callback;
  } };
  const setup = new Function('lay', 'stage', 'hooks', 'setIco', 'syncViewerCensor', 'syncActs',
    'let idx = 0; const list = ["a.png", "b.png"];' + src.slice(begin, end) +
    ';return () => { idx = 1; };');
  const next = setup(lay, stage, hooks, () => {}, () => paints++, () => acts++);
  button.onclick({ currentTarget: button });
  assert.equal(typeof changed, 'function', '单图面板必须收到大图刷新回调');
  changed();
  assert.deepEqual([paints, acts, cleared], [1, 1, 1]);
  lay.isConnected = false;
  changed();
  lay.isConnected = true;
  next();
  changed();
  assert.deepEqual([paints, acts, cleared], [1, 1, 1], '关闭或翻页后不得刷新旧图');
}
const a = src.indexOf('// ── 大图查看 ──');
const b = src.indexOf('// ── 大图查看结束 ──', a);
assert.ok(a >= 0 && b > a, '找不到大图查看纯函数块');
const api = new Function(
  src.slice(a, b) +
    ';return {viewFileUrl,viewIsStillImage,viewNeighborImages,viewPrefetchPlan,' +
    'viewZoomAfterWheel,viewZoomTranslate,viewCanPan,viewClickCloses,viewOrigReady,' +
    'rememberDecoded,VIEW_ZOOM_MIN,VIEW_ZOOM_MAX,viewPreloadPaths,viewPreloadWorkers,' +
    'viewPreloadNeedsWarn,viewPreloadSame,viewPreloadOutcome,runViewPreload,' +
    'VIEW_PRELOAD_CONCUR,VIEW_PRELOAD_WARN};',
)();

assert.equal(
  api.viewFileUrl('sub/a.png', 'output'),
  '/api/view?filename=a.png&subfolder=sub&type=output',
);
assert.equal(
  api.viewFileUrl('sub/a.png', 'output', 12.5),
  '/api/view?filename=a.png&subfolder=sub&type=output&mbv=12.5',
  '覆盖原文件后必须换查询串，否则浏览器会显示打码前的图',
);
assert.equal(api.viewIsStillImage('a.png'), true);
assert.equal(api.viewIsStillImage('a.mp4'), false);

const list = ['a.png', 'b.mp4', 'c.png', 'd.png', 'e.wav', 'f.png'];
assert.deepEqual(api.viewNeighborImages(list, 0, 1, 2), [2, 3], '中间视频要跳过，预取下一张静图');
assert.deepEqual(api.viewPrefetchPlan(list, 0, 1), [2, 3], '顺着翻：前方 2 张静图');
assert.deepEqual(api.viewPrefetchPlan(list, 3, -1), [2, 0, 5], '往回翻：前方(回) 2 张 + 反方向 1 张');

assert.ok(api.viewZoomAfterWheel(1, -100) > 1, '滚轮向上放大');
assert.ok(api.viewZoomAfterWheel(2, 100) < 2, '滚轮向下缩小');
assert.equal(api.viewZoomAfterWheel(1, 100), api.VIEW_ZOOM_MIN, '缩到 1 就停');
assert.equal(api.viewZoomAfterWheel(8, -100), api.VIEW_ZOOM_MAX, '放到上限就停');

const moved = api.viewZoomTranslate(0, 0, 1, 2, 40, 0);
assert.ok(moved.tx < 0, '对着右边的点放大，画面应左移把该点留在光标下');

assert.equal(api.viewClickCloses(1, false), true, '未放大且没拖过，点图关掉');
assert.equal(api.viewClickCloses(2, false), false, '放大后点图不关');
assert.equal(api.viewClickCloses(1, true), false, '拖过之后那一发 click 不关');
assert.equal(api.viewCanPan(1), false);
assert.equal(api.viewCanPan(2), true);

assert.equal(api.viewOrigReady('/api/view?filename=a.png'), true);
assert.equal(api.viewOrigReady('/mediabrowser/thumb?filename=a.png'), false);

const m = new Map();
api.rememberDecoded(m, 'u1', { n: 1 }, 2);
api.rememberDecoded(m, 'u2', { n: 2 }, 2);
api.rememberDecoded(m, 'u3', { n: 3 }, 2);
assert.equal(m.size, 2, '解码缓存有上限');
assert.equal(m.has('u1'), false, '最老的先丢掉');

assert.deepEqual(
  api.viewPreloadPaths([
    { type: 'dir', path: 'sub', name: 'sub' },
    { type: 'img', path: 'a.png' },
    { type: 'img', path: 'b.mp4' },
    { type: 'img', path: 'c.jpg' },
    { type: 'img', path: 'd.webp' },
  ]),
  ['a.png', 'c.jpg', 'd.webp'],
  '全量预加载只收当前列表里的静图，跳过文件夹和视频',
);
assert.equal(api.viewPreloadWorkers(0), 0);
assert.equal(api.viewPreloadWorkers(1), 1);
assert.equal(api.viewPreloadWorkers(9), api.VIEW_PRELOAD_CONCUR);
assert.equal(api.VIEW_PRELOAD_CONCUR, 2);
assert.equal(api.viewPreloadNeedsWarn(api.VIEW_PRELOAD_WARN - 1), false);
assert.equal(api.viewPreloadNeedsWarn(api.VIEW_PRELOAD_WARN), true);
assert.equal(api.viewPreloadSame(['a'], ['a']), true);
assert.equal(api.viewPreloadSame(['a'], ['b']), false);
assert.equal(api.viewPreloadOutcome({ ok: 3, fail: 0, cancelled: false }), 'ok');
assert.equal(api.viewPreloadOutcome({ ok: 2, fail: 1, cancelled: false }), 'partial');
assert.equal(api.viewPreloadOutcome({ ok: 0, fail: 3, cancelled: false }), 'fail');
assert.equal(api.viewPreloadOutcome({ ok: 2, fail: 0, cancelled: true }), 'cancel');

{
  const pending = [];
  const fetchFn = (url, opts) => new Promise((resolve, reject) => {
    pending.push({ url, opts, resolve, reject });
    opts.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const ac = new AbortController();
  const job = api.runViewPreload({
    paths: ['a.png', 'b.png', 'c.png'],
    root: 'output',
    fetchFn,
    signal: ac.signal,
  });
  await Promise.resolve();
  assert.equal(pending.length, 2, '3 张、限制 2 时应当同时挂起 2 个请求');
  assert.ok(pending[0].url.includes('/api/view?'), '必须走和大图同一条 /api/view');
  assert.ok(!pending[0].url.includes('/mediabrowser/thumb'), '不能去拉缩略图充数');
  assert.equal(pending[0].opts.priority, 'low', '不能跟当前大图抢优先级');
  pending[0].resolve({ ok: true, blob: async () => new Uint8Array([1]) });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(pending.length, 3, '空出一个工位就该接下张');
  ac.abort();
  const rec = await job;
  assert.equal(rec.cancelled, true);
  assert.equal(rec.ok, 1);
  assert.equal(rec.fail, 0, '中止不能算失败');
}

{
  const rec = await api.runViewPreload({
    paths: ['a.png', 'b.png'],
    root: 'output',
    fetchFn: async (url) => {
      if (url.includes('filename=a.png')) return { ok: true, blob: async () => new Uint8Array([1]) };
      return { ok: false, blob: async () => new Uint8Array(0) };
    },
  });
  assert.equal(rec.ok, 1);
  assert.equal(rec.fail, 1);
  assert.equal(rec.cancelled, false);
  assert.equal(api.viewPreloadOutcome(rec), 'partial');
}

console.log('viewer lifecycle: passed');
