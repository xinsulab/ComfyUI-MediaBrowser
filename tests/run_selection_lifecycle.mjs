// 抽出多选纯函数，锁住「全选进多选 / 清空恢复原点击 / 文件夹不进选区」。
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('// ── 多选选区 ──');
const b = src.indexOf('// ── 多选选区结束 ──', a);
assert.ok(a >= 0 && b > a, '找不到多选选区纯函数块');
const api = new Function(
  src.slice(a, b) +
    ';return {selectablePaths,selectAllState,nextSelectAll,toggleSelected,cellClickIntent,pruneSelected,batchFavIntent};',
)();

const items = [
  { type: 'dir', name: 'sub', count: 3 },
  { type: 'img', path: 'a.png' },
  { type: 'img', path: 'b.png' },
  { type: 'img', path: 'c.mp4' },
];
assert.deepEqual(api.selectablePaths(items), ['a.png', 'b.png', 'c.mp4'], '文件夹不能进选区');

const empty = new Set();
assert.equal(api.selectAllState(['a.png', 'b.png'], empty), 'none');
assert.equal(api.cellClickIntent({ isDir: false, hasSelection: false }), 'open', '没选区时点文件走原来的看大图/选中');
assert.equal(api.cellClickIntent({ isDir: true, hasSelection: true }), 'open', '有选区时点文件夹仍进入目录');

const all = api.nextSelectAll(['a.png', 'b.png'], empty);
assert.deepEqual([...all].sort(), ['a.png', 'b.png'], '点全选应选中当前列表全部文件');
assert.equal(api.selectAllState(['a.png', 'b.png'], all), 'all');
assert.equal(api.cellClickIntent({ isDir: false, hasSelection: all.size > 0 }), 'select', '有选区后点文件只加减选');

const one = api.toggleSelected(all, 'a.png');
assert.equal(one.has('a.png'), false);
assert.equal(one.has('b.png'), true);
assert.equal(api.selectAllState(['a.png', 'b.png'], one), 'some');
assert.deepEqual([...api.nextSelectAll(['a.png', 'b.png'], one)].sort(), ['a.png', 'b.png'], '半选再点全选应补齐');

const none = api.nextSelectAll(['a.png', 'b.png'], all);
assert.equal(none.size, 0, '已全选再点全选应清空');
assert.equal(api.cellClickIntent({ isDir: false, hasSelection: none.size > 0 }), 'open', '清空后恢复原来的点击');

const pruned = api.pruneSelected(new Set(['a.png', 'gone.png']), ['a.png', 'b.png']);
assert.deepEqual([...pruned], ['a.png'], '筛掉当前列表里没有的项');
assert.equal(api.pruneSelected(new Set(['gone.png']), ['a.png']).size, 0, '筛空即退出多选');

assert.equal(api.batchFavIntent(['a.png', 'b.png'], (p) => p === 'a.png'), 'fav', '未全部收藏时批量收藏');
assert.equal(api.batchFavIntent(['a.png', 'b.png'], () => true), 'unfav', '已全部收藏时批量取消');

const favStart = src.indexOf('let favCache = null;');
const favEnd = src.indexOf('const RECENT_KEY =', favStart);
assert.ok(favStart >= 0 && favEnd > favStart, '找不到收藏存储实现');
let writes = 0;
const favApi = new Function('readFav', 'save', 'FAV_KEY',
  src.slice(favStart, favEnd) + ';return {setFavsIn,favSet};',
)(() => ({output:['old.png']}), () => { writes++; }, 'fav-key');
const many = Array.from({length: 6000}, (_, i) => `p${i}.png`);
favApi.setFavsIn('output', many, true);
assert.equal(writes, 1, '批量收藏只能整体写 localStorage 一次，不能每项序列化一次');
assert.equal(favApi.favSet('output').size, 6001);
favApi.setFavsIn('output', many, false);
assert.equal(writes, 2, '批量取消收藏也只能整体写一次');
assert.deepEqual([...favApi.favSet('output')], ['old.png']);

console.log('selection lifecycle: passed');
