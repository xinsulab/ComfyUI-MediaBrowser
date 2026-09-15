// 控制真实 load() 的响应顺序，验证快切目录和关闭窗口时不会回填旧列表。
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n');
const placeBlock = src.match(/\/\* PLACE_HELPERS_BEGIN \*\/([\s\S]*?)\/\* PLACE_HELPERS_END \*\//);
assert.ok(placeBlock, '找不到范围状态纯函数块');
const scopeApi = new Function(
  placeBlock[1] + `;return {
    scopeFromPlace: typeof scopeFromPlace === 'function' ? scopeFromPlace : null,
    scopeWithMode: typeof scopeWithMode === 'function' ? scopeWithMode : null,
    scopeWithRoot: typeof scopeWithRoot === 'function' ? scopeWithRoot : null,
  };`,
)();
assert.equal(typeof scopeApi.scopeFromPlace, 'function', '缺少真实目录与虚拟视图的独立状态模型');
const outputFav = scopeApi.scopeFromPlace({folder:'@fav', root:'output', cwd:''}, 'input');
assert.deepEqual(outputFav, {root:'output', mode:'@fav', cwd:''}, '收藏视图不能回退到节点默认 input');
assert.deepEqual(
  scopeApi.scopeWithMode(outputFav, '@recent'),
  {root:'output', mode:'@recent', cwd:''},
  '切换收藏/最近只能改视图，不能改真实根目录',
);
assert.deepEqual(
  scopeApi.scopeWithMode(outputFav, '@fav'),
  {root:'output', mode:'', cwd:''},
  '再次点击当前视图必须返回真实目录，键盘用户不能依赖重选同一个下拉值',
);
assert.deepEqual(
  scopeApi.scopeWithRoot(outputFav, 'temp', 'clips'),
  {root:'temp', mode:'', cwd:'clips'},
  '切换真实目录必须退出收藏视图',
);
const a = src.indexOf('  const load = async (opts) => {');
const b = src.indexOf('  let searchT =', a);
assert.ok(a >= 0 && b > a);
const sameAt = src.indexOf('const listSame =');
const sameEnd = src.indexOf('async function listDir', sameAt);
const listSame = new Function(src.slice(sameAt,sameEnd)+';return listSame;')();
const original = {files:['a','b','c'],dirs:[{name:'one',count:3,t:1}],times:{a:1},dims:{a:[10,20,0]}};
assert.equal(listSame(original, structuredClone(original)), true);
assert.equal(listSame(original, {...original, files:['a','d','c']}), false, '中间文件改名必须更新');
assert.equal(listSame(original, {...original, times:{a:2}}), false, '原地覆盖文件必须更新缩略图版本');
assert.equal(listSame(original, {...original, dims:{a:[20,10,0]}}), false, '尺寸补全必须更新布局');
assert.equal(listSame(original, {...original, dirs:[{name:'two',count:3,t:1}]}), false, '同数量目录改名必须更新');
const make = (cached = false) => {
  const requests = [], shown = [], remembered = [], crumbs = [], selectionSync = [], favRoots = [];
  const ctx = {
    loadSeq: 0, cwd: 'old', rec: {checked:true}, sortSel:{value:'time_desc'},
    root: 'input', browseRoot: 'input', realRoot: () => ctx.root, sel: {value:'input'},
    favMode: () => false, recentMode: () => false, firstLoad: true,
    listKey: (r, p) => r+'|'+p, LIST_MEM: new Map(cached ? [['input|old',{id:'cached'}]] : []),
    stat: {}, t: s => s, setRefreshBusy(){},
    applyList: j => shown.push(j.id), mask:{isConnected:true},
    listDir: (...args) => new Promise((resolve,reject) => requests.push({args,resolve,reject})),
    listRemember: (key,j) => remembered.push([key,j.id]), listSame: () => false,
    showSkeleton(){}, drawCrumb: () => crumbs.push(ctx.cwd),
    scroll:{scrollTop:300}, paint(){}, syncToTop(){},
    isMissingDirError: e => e.missing, memo: {}, memoKey:'test', savePlace(){}, flash(){},
    selected: new Set(), syncSelection: () => selectionSync.push([...ctx.selected]),
    dims: {}, favSet: root => { favRoots.push(root); return new Set(['fav.png']); }, readRecent: () => ({}),
  };
  const run = new Function('ctx', 'with(ctx){'+src.slice(a,b)+';return load;}')(ctx);
  return {ctx, run, requests, shown, remembered, crumbs, selectionSync, favRoots};
};
{
  const h=make();
  h.ctx.root = 'output';
  h.ctx.sel.value = 'input';
  h.ctx.favMode = () => true;
  await h.run();
  assert.deepEqual(h.favRoots, ['output'], '节点默认 input 时，收藏视图仍必须读取当前 output 的收藏表');
  assert.equal(h.requests.length, 0, '收藏视图只读本地名单，不应误扫真实目录');
}
{
  const h=make(); h.ctx.selected.add('old.png'); const p=h.run();
  assert.equal(h.ctx.selected.size, 0, '开始加载新范围时必须立即清空旧选区，不能让批量动作落到新的真实根');
  assert.deepEqual(h.selectionSync, [[]], '清空选区后必须同步隐藏批量操作栏');
  h.requests[0].resolve({id:'loaded'}); await p;
}
for (const cached of [false,true]) {
  const h = make(cached);
  const old = h.run();
  h.ctx.cwd = 'new';
  const fresh = h.run();
  h.requests[1].resolve({id:'new'});
  await fresh;
  h.requests[0].resolve({id:'old'});
  await old;
  await Promise.resolve();
  assert.equal(h.shown.at(-1), 'new', '旧响应不能覆盖新目录');
  if (cached) assert.equal(h.crumbs[0], 'old', '内存命中也必须更新面包屑');
}
{
  const h=make(); const p=h.run(); h.ctx.mask.isConnected=false;
  h.requests[0].resolve({id:'closed'}); await p;
  assert.deepEqual(h.shown, [], '关闭后不再渲染');
}
{
  const h=make(); const old=h.run(); h.ctx.cwd='new'; const fresh=h.run();
  h.requests[0].reject({missing:true}); await old;
  assert.equal(h.ctx.cwd, 'new', '旧目录不存在的响应不能让新目录退回根目录');
  h.requests[1].resolve({id:'new'}); await fresh;
}
{
  const h=make(); const p=h.run(); h.requests[0].reject({missing:true});
  await Promise.resolve(); await Promise.resolve();
  h.requests[1].resolve({id:'root'}); await p;
  assert.deepEqual(h.remembered, [['input|','root']], '回退结果只能缓存到根目录键');
}
{
  const h=make(true); await h.run();
  h.requests[0].reject({missing:true});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.ctx.cwd, '', '命中旧缓存后发现目录已删除，也必须回到真实根目录');
  assert.equal(h.requests.length, 2, '缓存后台核对发现目录删除后，应直接重新加载根目录');
  h.requests[1].resolve({id:'root-after-cache'});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.shown.at(-1), 'root-after-cache', '缓存失效回根后必须显示根目录结果');
}
console.log('list lifecycle: passed');
