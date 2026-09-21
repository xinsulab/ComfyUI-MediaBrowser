/**
 * 抽出 mediabrowser.js 里 PICKER_SESSION 段：多开上限、同节点聚焦、
 * 浮钮点击/拖动分流、级联错开、服务断开识别。这些不能只靠扫源码字符串。
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const srcPath = process.argv[2];
if (!srcPath) {
  console.error('用法: node run_picker_session.mjs <mediabrowser.js>');
  process.exit(2);
}
const src = fs.readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n');

const m = src.match(/\/\* PICKER_SESSION_BEGIN \*\/([\s\S]*?)\/\* PICKER_SESSION_END \*\//);
assert.ok(m, 'mediabrowser.js 缺少 PICKER_SESSION_BEGIN/END 段');
const api = new Function(
  m[1] +
    `;return {
      PICKER_MAX: typeof PICKER_MAX === 'undefined' ? null : PICKER_MAX,
      PICKER_Z_BASE: typeof PICKER_Z_BASE === 'undefined' ? null : PICKER_Z_BASE,
      PICKER_Z_CAP: typeof PICKER_Z_CAP === 'undefined' ? null : PICKER_Z_CAP,
      makePickerRegistry,
      restackPickerZ,
      pickerCascadePos,
      fabIsClick,
      clampFabPos,
      defaultFabPos,
      isServiceDownError,
      pickerMemoKey,
      windowResizeDelta,
      clampWindowResize,
      consumePickerEsc,
      firePickerEscHandlers,
    };`,
)();
assert.equal(api.PICKER_Z_BASE, 10000, '浏览窗 z 从遮罩基底往上排');
assert.equal(api.PICKER_Z_CAP, 10027, '浏览窗必须永远低于浮钮 10028');

{
  const one = api.restackPickerZ([{ z: 0 }], 10000, 10027);
  assert.equal(one[0].z, 10027, '只剩一扇时贴着上限，保证压过更早的窗');
  const five = api.restackPickerZ(
    [{ z: 0 }, { z: 0 }, { z: 0 }, { z: 0 }, { z: 0 }],
    10000, 10027,
  );
  const zs = five.map((s) => s.z);
  assert.equal(zs[0], 10001);
  assert.equal(zs[4], 10027);
  assert.ok(zs.every((z, i) => i === 0 || z > zs[i - 1]), 'restack 必须给出严格递增的 z');
  assert.ok(Math.max(...zs) <= 10027);
}

{
  const reg = api.makePickerRegistry(() => 5);
  const nodeA = { id: 1 };
  for (let i = 0; i < 5; i++) {
    assert.equal(reg.canOpen(), true, `第 ${i + 1} 扇应还能开`);
    const s = reg.register({ id: 'p' + i, node: i === 0 ? nodeA : null, z: 0 });
    assert.ok(s.z > 10000, '新窗 z-index 必须高于浏览窗基底');
    assert.ok(s.z <= 10027, '新窗不能压过浮钮');
  }
  assert.equal(reg.canOpen(), false, '满 5 扇后不能再开');
  assert.equal(reg.count(), 5);
  assert.equal(reg.findByNode(nodeA)?.id, 'p0', '同一节点必须找回已有选片窗');
  assert.equal(reg.findByNode({ id: 1 }), null, 'findByNode 必须按对象身份，不能只比 id 字段');
  const first = reg.list()[0];
  for (let i = 0; i < 1000; i++) reg.focus(first);
  assert.equal(reg.front().id, first.id, 'focus 必须把该窗提到最前');
  const zs = reg.list().map((s) => s.z);
  assert.equal(reg.front().z, Math.max(...zs), '最前窗的 z 必须是当前最高');
  assert.ok(Math.max(...zs) <= 10027, '反复 focus 也不能让 z 涨过浮钮');
  assert.ok(new Set(zs).size === zs.length, '同一次 restack 里 z 不能撞车');
  reg.unregister('p0');
  assert.equal(reg.count(), 4);
  assert.equal(reg.canOpen(), true, '关掉一扇后应能再开');
  assert.equal(reg.findByNode(nodeA), null);
  assert.ok(Math.max(...reg.list().map((s) => s.z)) <= 10027, '关掉一扇后剩余窗仍低于浮钮');
}

{
  const unlimited = api.makePickerRegistry(() => 0);
  for (let i = 0; i < 8; i++) unlimited.register({ id: 'u' + i, z: 0 });
  assert.equal(unlimited.canOpen(), true, 'PICKER_MAX<=0 表示不限制');
  assert.ok(Math.max(...unlimited.list().map((s) => s.z)) <= 10027,
    '不限制开窗数时 z 仍须封顶，否则会盖住浮钮和大图');
}

{
  const a = api.pickerCascadePos(0, 1920, 1080, 800, 600, 36);
  const b = api.pickerCascadePos(1, 1920, 1080, 800, 600, 36);
  assert.equal(a.x, 72);
  assert.equal(a.y, 48);
  assert.equal(b.x, a.x + 36);
  assert.equal(b.y, a.y + 36);
  const tight = api.pickerCascadePos(0, 400, 300, 500, 400, 36);
  assert.ok(tight.x >= 16 && tight.y >= 16, '窗口比视口大时仍要留边');
  assert.ok(tight.x <= 400 - 16, '不能把窗口拖出右边界的定位原点');
}

assert.equal(api.fabIsClick(0, 0, 6), true);
assert.equal(api.fabIsClick(3, 4, 6), true, '5px 内算点击');
assert.equal(api.fabIsClick(10, 0, 6), false, '拖过阈值不能再当点击开窗');

{
  const p = api.clampFabPos(-20, 9999, 800, 600, 48, 8);
  assert.equal(p.x, 8);
  assert.equal(p.y, 600 - 48 - 8);
  const d = api.defaultFabPos(800, 600, 48, 8);
  assert.equal(d.x, 16);
  assert.equal(d.y, 600 - 64);
}

assert.equal(api.isServiceDownError(new Error('Failed to fetch')), true);
assert.equal(api.isServiceDownError(new Error('NetworkError when attempting to fetch resource.')), true);
assert.equal(api.isServiceDownError(new Error('目录不存在')), false);
assert.equal(api.isServiceDownError(new Error('HTTP 404')), false);

assert.equal(api.pickerMemoKey(true, { kind: 'image' }, 'input'), 'image:input');
assert.equal(api.pickerMemoKey(false, { kind: 'image' }, 'output'), 'browse:any',
  '纯浏览不能写进节点类型那份 memo，否则两扇浏览窗会抢 cwd');

{
  const start = { x: 100, y: 50, w: 400, h: 300 };
  const west = api.windowResizeDelta('w', -10, 0, start);
  assert.deepEqual(west, { x: 90, y: 50, w: 410, h: 300 }, '左边缘向左拉应变宽并左移，不能再按居中×2');
  const east = api.windowResizeDelta('e', 10, 0, start);
  assert.deepEqual(east, { x: 100, y: 50, w: 410, h: 300 });
  const nw = api.windowResizeDelta('nw', -10, -8, start);
  assert.deepEqual(nw, { x: 90, y: 42, w: 410, h: 308 });
}

{
  const start = { x: 20, y: 30, w: 500, h: 400 };
  // 往西猛拉，未夹紧会变成宽 2000、x 变负；夹紧后右边缘必须钉住。
  const raw = api.windowResizeDelta('w', -1500, 0, start);
  const clamped = api.clampWindowResize('w', raw, start, 460, 340, 800, 600);
  assert.equal(clamped.w, Math.min(800 * 0.98, Math.max(460, raw.w)));
  assert.equal(clamped.x, start.x + start.w - clamped.w, '西向夹紧后必须钉住右边缘，不能沿用未夹紧的 x');
  const north = api.clampWindowResize(
    'n', api.windowResizeDelta('n', 0, -800, start), start, 460, 340, 800, 600,
  );
  assert.equal(north.y, start.y + start.h - north.h, '北向夹紧后必须钉住底边');
}

assert.match(src, /\.mb-fab\{/, '必须有浮钮样式');
assert.equal(src.includes('.mb-mask{position:fixed;inset:0'), false,
  '浏览窗不能再是全屏遮罩，否则第二扇会被盖住');
assert.match(src, /function mountFab\s*\(/, 'setup 必须挂可拖浮钮');
assert.match(src, /fab\.tabIndex = 0/, '浮钮必须能键盘聚焦');
assert.match(src, /e\.key === "Enter" \|\| e\.key === " "/, '浮钮 Enter/空格应开窗');
assert.match(src, /const canPick = typeof onPick === "function"/,
  '无 onPick 时必须关掉选片');
assert.match(src, /if \(canPick\) \{[\s\S]{0,180}id: "pick"/,
  '「用这张」只能在选片窗进入动作清单');
assert.match(src, /listDir\([\s\S]{0,80}panelAbort\?\.signal/,
  '关窗必须能 abort 正在飞的列表请求');
assert.match(src, /class="mb-empty"/, '服务断开时不能只留骨架格');
assert.match(src, /resetFabToDefault\(/, '恢复默认界面必须把浮钮也放回去');
assert.match(src, /if \(maximized\) return;/, '最大化时标题栏拖动不能把满屏窗拽歪');
assert.match(src, /e\.stopImmediatePropagation\(\)/,
  '多窗 Esc 必须 stopImmediate，否则后注册的监听会把下一扇也关了');
assert.match(src, /mbLayers\.drop\(close\)/, '关窗必须按引用摘自己，不能 pop 栈顶');
assert.match(src, /querySelector\("\.mb-pop"\)/, '菜单开着时浏览窗不能先把 Esc 吃掉');

{
  let front = 'B';
  const sessions = [];
  const make = (id) => ({
    id,
    mask: id,
    front: () => front,
    close() {
      const i = sessions.findIndex((s) => s.id === id);
      if (i >= 0) sessions.splice(i, 1);
      front = sessions.length ? sessions[sessions.length - 1].id : null;
    },
  });
  const a = make('A');
  const b = make('B');
  sessions.push(a, b);
  front = 'A';
  assert.deepEqual(api.firePickerEscHandlers(sessions), ['A'],
    '点后面那扇再 Esc，只能关被点到前面的那一扇');
  assert.equal(sessions.map((s) => s.id).join(','), 'B', '另一扇必须留下');
}

{
  const closed = api.firePickerEscHandlers([
    { id: 'A', mask: 'A', front: () => 'A', hasPop: true, close() { throw new Error('菜单开着不该关窗'); } },
  ]);
  assert.deepEqual(closed, [], '格子菜单开着时浏览窗必须把 Esc 让出去');
}

assert.equal(api.consumePickerEsc('A', 'A', false, true, false), false, '大图开着浏览窗不该抢 Esc');
assert.equal(api.consumePickerEsc('A', 'B', false, false, false), false, '不是最前那扇不能关');
assert.equal(api.consumePickerEsc('A', 'A', false, false, false), true);

console.log('picker session: passed');
