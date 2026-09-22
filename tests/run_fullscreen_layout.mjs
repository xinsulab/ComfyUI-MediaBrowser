import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync(process.argv[2],'utf8');
const body=source.slice(source.indexOf('const clampPaintPanel='),source.indexOf('const CELL_ACTION_IDS'));
let callback,timer,requested=0,exited=0,removed=0,notice='';
const nodes=[];
const element=()=>({classList:{add(){},remove(){}},appendChild(b){this.child=b;},addEventListener(){},remove(){removed++;},setAttribute(){}});
const document={fullscreenElement:null,documentElement:{requestFullscreen:async()=>{requested++;}},exitFullscreen:async()=>{exited++;},querySelectorAll:()=>[],createElement:element,body:{appendChild:n=>nodes.push(n)},addEventListener:(name,fn)=>callback=fn};
const api=new Function('document','mbElButton','notify','t','setTimeout','clearTimeout',body+';return {clampPaintPanel,placePaintPanel,paintSideFits,toggleBrowserFullscreen};')(document,element,m=>notice=m,x=>x,fn=>{timer=fn;return 1;},()=>{});
assert.equal(api.paintSideFits(1920,1080,.56),true);
assert.equal(api.paintSideFits(800,900,.56),false);
assert.equal(api.paintSideFits(1920,1080,1.8),false);
assert.equal(api.paintSideFits(1920,500,.56),false);
await api.toggleBrowserFullscreen();assert.equal(requested,1);
document.fullscreenElement=document.documentElement;callback();
assert.equal(nodes.length,1);assert.equal(nodes[0].child.textContent,'退出全屏');
await nodes[0].child.onclick();assert.equal(exited,1);
document.fullscreenElement=null;callback();assert.equal(removed,1);
document.documentElement.requestFullscreen=undefined;
await api.toggleBrowserFullscreen();assert.equal(notice,'此浏览器不支持全屏');
console.log('fullscreen lifecycle and adaptive toolbar passed');

assert.deepEqual(api.clampPaintPanel(-20,999,190,240,800,600),{x:12,y:348});
assert.deepEqual(api.clampPaintPanel(500,400,190,240,400,300),{x:198,y:48});

// 执行生产指针处理：从侧栏拖动、限制越界、恢复自动布局。
const classes=new Set(['paint-side']);
const grip={setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
const reset={};
const bar={style:{},getBoundingClientRect:()=>({left:500,top:200,width:190,height:240}),querySelector:s=>s==='.mb-paint-grip'?grip:reset};
const lay={clientWidth:800,clientHeight:600,classList:{contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k),toggle(k,v){if(v)classes.add(k);else classes.delete(k);}}};
const dragCode=source.slice(source.indexOf('  let paintPanelPosition='),source.indexOf('  // 延至下一帧变更布局'));
new Function('env','with(env){'+dragCode+'}')( {lay,paintBar:bar,paintMode:'brush',stage:{querySelector:()=>({naturalWidth:480,naturalHeight:900,getBoundingClientRect:()=>({left:250,right:550,top:40,bottom:550})})},clampPaintPanel:api.clampPaintPanel,paintSideFits:api.paintSideFits,placePaintPanel:api.placePaintPanel,redrawPaint(){},applyViewerCensor(){}} );
const e={button:0,pointerId:1,clientX:510,clientY:210,preventDefault(){},stopPropagation(){}};
grip.onpointerdown(e);assert.equal(classes.has('paint-manual'),true);
grip.onpointermove({...e,clientX:1000,clientY:1000});assert.equal(bar.style.left,'598px');assert.equal(bar.style.top,'348px');
grip.onpointerup(e);reset.onclick();assert.equal(classes.has('paint-manual'),false);assert.ok(parseFloat(bar.style.left)>=12);

assert.deepEqual(api.placePaintPanel(1600,1000,{left:550,right:1050,top:40,bottom:920},340,460),{x:1066,y:234});
const narrow=api.placePaintPanel(400,700,{left:0,right:400,top:40,bottom:600},340,460);assert.ok(narrow.x>=12 && narrow.x+340<=388);
