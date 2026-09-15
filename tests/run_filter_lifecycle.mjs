// 锁住类型筛选的稳定结构：目录内容变化只能更新计数/状态，不能让按钮忽隐忽现。
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n');
const block = src.match(/\/\* KIND_FILTER_HELPERS_BEGIN \*\/([\s\S]*?)\/\* KIND_FILTER_HELPERS_END \*\//);
assert.ok(block, '找不到类型筛选纯函数块');

const api = new Function(
  block[1] + ';return {kindFilterModel};',
)();

const oneKind = api.kindFilterModel(['cover.png'], 'image', new Set(['image', 'video']));
assert.deepEqual(oneKind.map((item) => item.id), ['image', 'video', 'audio', 'other']);
assert.deepEqual(oneKind.map((item) => item.count), [1, 0, 0, 0]);
assert.deepEqual(oneKind.map((item) => item.enabled), [true, false, false, false]);
assert.equal(oneKind[0].active, true);
assert.equal(oneKind[1].active, false, '当前范围没有的类型不能显示成可用的已选状态');

const mixed = api.kindFilterModel(
  ['clip.mp4', 'sound.wav', 'notes.json', 'poster.webp', 'still.jpg'],
  'video',
  new Set(['video', 'audio']),
);
assert.deepEqual(mixed.map((item) => item.id), ['video', 'image', 'audio', 'other'], '节点支持的类型固定排在最前');
assert.deepEqual(mixed.map((item) => item.count), [1, 2, 1, 1]);
assert.deepEqual(mixed.map((item) => item.active), [true, false, true, false]);

const empty = api.kindFilterModel([], 'image', new Set());
assert.equal(empty.length, 4, '空目录也必须保留固定筛选入口，避免工具栏跳变');
assert.equal(empty.every((item) => !item.enabled), true);

const kindStart = src.indexOf('  const kindsBox = mask.querySelector(".mb-kinds")');
const kindEnd = src.indexOf('  applyLangLive = () =>', kindStart);
assert.ok(kindStart >= 0 && kindEnd > kindStart, '找不到类型筛选界面实现');
const ui = src.slice(kindStart, kindEnd);
assert.ok(ui.includes('const kindButtons = new Map()'), '类型按钮应只创建一次并保留引用');
assert.equal((ui.match(/appendChild\(b\)/g) || []).length, 1, '类型按钮只能在初始化时追加一次');
assert.ok(!ui.includes('kindsBox.innerHTML = ""'), '刷新列表不能销毁重建类型按钮');
assert.ok(
  ui.includes('if (rawFiles.length && kinds.size && !initial.some((item) => item.active))'),
  '空目录/首次加载不能清掉用户已经保存的筛选偏好',
);
assert.ok(
  /\n  };\n  buildKinds\(\);\n/.test(ui),
  '首次列表返回前也必须用空模型初始化并禁用按钮，不能留下可点击的空白状态',
);

console.log('filter lifecycle: passed');
