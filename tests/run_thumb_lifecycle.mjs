// 跑实际建图代码再补发；不能像旧测试那样假定图片已在格子里。
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('        const img = document.createElement("img");');
const b = src.indexOf('\n      }\n      frag.appendChild(c);', a);
const f = src.indexOf('  const flushThumbs =');
const g = src.indexOf('  const scheduleFlush =', f);
assert.ok(a >= 0 && b > a && f >= 0 && g > f);
for (const scrolling of [true, false]) {
  const children = [];
  const c = {isConnected: true, prepend(img) { if (!children.includes(img)) children.unshift(img); },
    querySelector(sel) { return sel === 'img[data-src]' ? children.find(i => i.dataset.src) : null; }};
  const document = {createElement() { return {dataset: {}, decoding: '', src: ''}; }};
  const timers = [];
  let ratioFixes = 0;
  const img = new Function('document','c','scrolling','wantThumbPx','COLS','sizeIdx','it','realRoot','times','scheduleFlush','fixRatio','setTimeout',
    src.slice(a,b) + '\nreturn img;')(document,c,scrolling,()=>640,[5],0,{path:'test.png'},()=> 'input',{},()=>{},()=>{ ratioFixes++; },fn=>timers.push(fn));
  const flush = new Function('pool','placed','scroll', 'let lastFlushAt=0;\n'+src.slice(f,g)+'\nreturn flushThumbs;')(
    new Map([[0,c]]),[{y:0,h:100}],{scrollTop:0,clientHeight:500});
  flush();
  assert.ok(img.src.includes('/mediabrowser/thumb?'), '停下补发必须能找到尚未加载的图片');
  img.onload();
  assert.equal(children.filter(x=>x===img).length,1);
  assert.equal(ratioFixes, 1);
  img.onerror();
  timers.shift()();
  assert.ok(img.src.endsWith('&r=1'), '仍在视口附近的图片需要重试');
  img.onerror();
  c.isConnected = false;
  const before = img.src;
  timers.shift()();
  assert.equal(img.src, before, '回收后不能由旧重试定时器重新发请求');
  img.onload();
  assert.equal(ratioFixes, 1, '旧根格子断开后，迟到的 onload 不能污染新根尺寸并触发重排');
}
assert.ok(src.includes('clearTimeout(fixT);'), '关闭窗口必须取消比例校正的延迟重排');
const skeletonAt = src.indexOf('  const showSkeleton = () => {');
const skeletonEnd = src.indexOf('  const refreshBtn =', skeletonAt);
assert.ok(src.slice(skeletonAt, skeletonEnd).includes('releasePool()'), '切换范围时必须释放旧缩略图回调，不能只移除 DOM');
assert.equal((src.match(/pool\.clear\(\)/g) || []).length, 1, '整池重绘必须统一走 releasePool，避免在飞缩略图继续占连接');
// 执行关闭时的实际清理段：取消补发，并释放在飞图片的回调和池引用。
const closeAt = src.indexOf('  const close = () => {', src.indexOf('function openPicker('));
const cleanupAt = src.indexOf('    clearTimeout(settleT);', closeAt);
const cleanupEnd = src.indexOf('    roStop?.();', cleanupAt);
assert.ok(cleanupAt > closeAt && cleanupEnd > cleanupAt);
const closingImg = {complete: false, src: 'pending', onload(){}, onerror(){}};
const closingPool = new Map([[0, {querySelector: () => closingImg, remove(){}}]]);
const releaseAt = src.indexOf('  let fixT = null;', src.indexOf('function openPicker('));
const releaseEnd = src.indexOf('\n\n  let pop =', releaseAt);
assert.ok(releaseAt > 0 && releaseEnd > releaseAt);
const releaseCode = src.slice(releaseAt, releaseEnd).replace('let fixT = null;', 'let fixT = 99;');
const cleared = [];
new Function('pool', 'clearTimeout', 'settleT', 'BLANK_PX', releaseCode + '\n' + src.slice(cleanupAt, cleanupEnd))(
  closingPool, id => {cleared.push(id);}, 42, 'blank');
assert.deepEqual(cleared, [42, 99], '关闭时应同时取消补发和比例重排定时器');
assert.equal(closingPool.size, 0);
assert.equal(closingImg.src, 'blank');
assert.equal(closingImg.onload, null);
assert.equal(closingImg.onerror, null);
console.log('thumbnail lifecycle: passed');
