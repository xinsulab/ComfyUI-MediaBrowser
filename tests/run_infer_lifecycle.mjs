// 真正挂起检测请求，再取消或替换批次，验证旧结果不能污染当前界面。
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('  const startInfer = async');
const b = src.indexOf('  const syncCensorSeg =', a);
assert.ok(a >= 0 && b > a);
for (const replace of [false, true]) {
  let resolve;
  let paints = 0;
  const ctx = {
    censorMode: 'local', inferAbort: new AbortController(), inferBusy: false,
    inferDone: 0, inferTotal: 0,
    unhitVisible: () => [{el: {classList: {add(){}, remove(){}}}, path: 'test.png'}],
    flash(){}, updateUnhitHint(){}, syncDetectBtn(){}, syncRedoOnCell(){},
    t: s => s, hint: {}, isSkipDetect: () => false, censorConcur: () => 2,
    fetchOne: () => new Promise(r => {resolve = r;}),
    mask: {isConnected: true}, isMarked: () => false, dims: {}, masonry: true,
    realRoot: () => 'input', censorRuleFor: () => ({}),
    paintCensorOverlay: () => paints++, filterClientBoxes: () => [],
    preloadBusy: false, syncPreloadBtn() {},
  };
  const run = new Function('ctx', 'with(ctx){'+src.slice(a,b)+';return startInfer;}')(ctx);
  const pending = run();
  ctx.inferAbort.abort();
  if (replace) {
    ctx.inferAbort = new AbortController();
    ctx.inferDone = 7;
  } else ctx.censorMode = 'off';
  resolve({boxes: []});
  await pending;
  assert.equal(paints, 0, '取消后返回的结果不能继续绘制');
  assert.equal(ctx.inferDone, replace ? 7 : 0, '旧请求不能推进当前进度');
  assert.equal(ctx.inferBusy, replace, '旧批次不能清掉新批次的运行状态');
}
{
  const pendingFetches = [];
  const ctx = {
    censorMode: 'local', inferAbort: new AbortController(), inferBusy: false,
    inferDone: 0, inferTotal: 0,
    unhitVisible: () => [1, 2, 3].map((i) => ({
      el: { classList: { add() {}, remove() {} } }, path: i + '.png',
    })),
    flash() {}, updateUnhitHint() {}, syncDetectBtn() {}, syncRedoOnCell() {},
    t: (s) => s, hint: {}, isSkipDetect: () => false, censorConcur: () => 2,
    fetchOne: () => new Promise((r) => { pendingFetches.push(r); }),
    mask: { isConnected: true }, isMarked: () => false, dims: {}, masonry: true,
    realRoot: () => 'input', censorRuleFor: () => ({}),
    paintCensorOverlay() {}, filterClientBoxes: () => [], attachPeekBtn() {},
    openSettings() {},
    preloadBusy: false, syncPreloadBtn() {},
  };
  const run = new Function('ctx', 'with(ctx){' + src.slice(a, b) + ';return startInfer;}')(ctx);
  const pending = run();
  if (pendingFetches.length !== 2) {
    throw new Error('3 张、限制 2 时应当同时挂起 2 个请求，实际 ' + pendingFetches.length);
  }
  pendingFetches[0]({ boxes: [] });
  await Promise.resolve();
  if (pendingFetches.length !== 3) {
    throw new Error('空出一个工位就该接下一张，实际挂起 ' + pendingFetches.length);
  }
  ctx.inferAbort.abort();
  for (const r of pendingFetches) r(null);
  await pending;
}

console.log('inference lifecycle: passed');
