// 执行生产图层模型和编辑事务，覆盖人工修订、撤销、取消、并发失败与过期请求。
import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync(process.argv[2],'utf8').replace(/\r\n/g,'\n');
const helpers=source.match(/\/\* OVERLAY_HELPERS_BEGIN \*\/([\s\S]*?)\/\* OVERLAY_HELPERS_END \*\//)[1];
const api=new Function(helpers+';return {overlayMerge,overlayFlags,overlayClone};')();
const auto={id:'auto-0',k:'r',auto:true,label:'x',x:.2,y:.2,w:.3,h:.3,block:16};
const manual={id:'manual',k:'r',x:.1,y:.1,w:.1,h:.1,block:8};
const edited={ops:[manual],suppressed:[auto]};
const merged=api.overlayMerge(edited,[{...auto,x:.21},{...auto,id:'auto-1',label:'other'}]);
assert.deepEqual(merged.ops.map(o=>o.id),['manual','auto-1']);
assert.deepEqual(edited.ops,[manual],'合并不能修改已保存记录');
assert.deepEqual(api.overlayFlags('local',true,false,true),{showOverlay:true,fullBlur:true,peeking:true});
const a=source.indexOf('  // 编辑采用草稿事务');
const b=source.indexOf('  // 三个动作按钮',a);
assert.ok(a>0 && b>a);
function setup() {
  const controls=new Map();
  const cls={add(){},remove(){},toggle(){return false;},contains(){return false;}};
  function element(){return {value:'16',style:{},classList:cls,hidden:false,appendChild(){},remove(){},dataset:{},querySelectorAll(){return[];},querySelector(k){if(!controls.has(k))controls.set(k,element());return controls.get(k);}};}
  const bar=element(),lay=element();lay.isConnected=true;lay.querySelector=()=>bar;
  const img={naturalWidth:640,naturalHeight:480,getBoundingClientRect:()=>({left:0,top:0,width:640,height:480})};
  let canvas=null;
  const stage={classList:cls,querySelector:k=>k.startsWith('img')?img:k==='.mb-paint-layer'?canvas:null,appendChild:c=>canvas=c,setPointerCapture(){},getBoundingClientRect:()=>({left:0,top:0})};
  const initial={revision:1,sourceVersion:{size:1},exists:true,ops:[{...manual}],suppressed:[]};
  let mode='off',serial=0,failed=false,stored=null,choice='cancel',resolveLoad=null;
  const env={...api,drag:null,stage,lay,list:['a.png','b.png'],idx:0,root:'output',
    document:{createElement(){const c=element();c.getContext=()=>new Proxy({}, {get:(_,p)=>p==='canvas'?c:()=>{}});return c;}},
    detectedOps:boxes=>boxes,
    hooks:{detectForEdit:async()=>({boxes:[{...auto}]}),getMode:()=>mode,setMode:m=>mode=m,getFullBlur:()=>false,isMarked:()=>false,censorRule:()=>({}),savePaint:async(p,rec)=>{if(failed)throw Error('conflict');stored=rec;return rec;}},
    loadOverlay:async()=>initial,currentOverlay:()=>api.overlayClone(initial),canPaintFile:()=>true,
    censorWaitBlurs:()=>false,paintClampBlock:Number,paintClampBrush:Number,paintDrawOp(){},
    paintNormFromClient:(x,y)=>({x:x/640,y:y/480}),paintNormRect:(a,b)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y)}),
    paintRectTooSmall:r=>r.w<.004||r.h<.004,paintAppendDot:(pts,p)=>[...pts,p],paintStrokeOp:(pts,r)=>({k:'s',pts:pts.map(p=>[p.x,p.y]),r}),
    overlayId:()=>`new-${++serial}`,overlayLeaveChoice:async()=>choice,notify(){},resetZoom(){},syncViewerCensor(){},syncPaintPlacement(){},applyViewerCensor(){},syncActs(){},
    clearTimeout(){},setTimeout(){return 1;},AbortController,t:x=>x,
  };
  const editor=new Function('env','with(env){'+source.slice(a,b)+';return {startPaint,stopPaint,commitPaint,leavePaint,detectPaint,beginPaintDrag,movePaintDrag,endPaintDrag,viewerSnapshot,state:()=>({paintMode,paintOps,paintBusy})};}')(env);
  const event=(x,y)=>({clientX:x,clientY:y,pointerId:1,preventDefault(){},stopImmediatePropagation(){}});
  return {editor,controls,env,event,mode:()=>mode,saved:()=>stored,fail:()=>failed=true,choice:v=>choice=v};
}
{
  const h=setup();await h.editor.startPaint('rect');
  assert.equal(h.mode(),'local','编辑自动开启遮蔽');
  assert.equal(h.editor.state().paintOps.length,1,'载入原有区域');
  h.editor.beginPaintDrag(h.event(300,200));h.editor.movePaintDrag(h.event(400,300));h.editor.endPaintDrag();
  assert.equal(h.editor.state().paintOps.length,2);
  h.controls.get('.undo').onclick();assert.equal(h.editor.state().paintOps.length,1);
  h.controls.get('.redo-paint').onclick();assert.equal(h.editor.state().paintOps.length,2);
  assert.equal(await h.editor.leavePaint(),false,'继续编辑不能丢草稿');
  h.fail();assert.equal(await h.editor.commitPaint(),false);assert.equal(h.editor.state().paintMode,'rect');
  assert.equal(h.editor.state().paintOps.length,2,'保存失败保留草稿');
  h.editor.stopPaint(false);assert.equal(h.mode(),'off','取消恢复进入前开关');assert.equal(h.saved(),null);
}
{
  const h=setup();await h.editor.startPaint('select');
  h.editor.beginPaintDrag(h.event(90,70));h.editor.movePaintDrag(h.event(120,95));h.editor.endPaintDrag();
  assert.ok(h.editor.state().paintOps[0].x>.1,'已有矩形能移动');
  h.controls.get('.clear-paint').onclick();assert.equal(h.editor.state().paintOps.length,0);
  h.controls.get('.undo').onclick();assert.equal(h.editor.state().paintOps.length,1,'清空可撤销');
  assert.equal(await h.editor.commitPaint(),true);
  assert.equal(h.editor.state().paintMode,'');assert.equal(h.saved().revision,1,'保存携带原修订供服务端冲突检测');
}
{
  const h=setup();let resolve;h.env.loadOverlay=()=>new Promise(r=>resolve=r);
  const pending=h.editor.startPaint('rect');h.env.idx=1;resolve();await pending;
  assert.equal(h.editor.state().paintMode,'','旧图读取晚到不能在新图开启编辑');
}
console.log('overlay model and editor lifecycle: passed');

{
  const h=setup();await h.editor.startPaint('brush');
  await h.editor.detectPaint(false);
  assert.equal(h.editor.state().paintOps.length,2,'智能识别保留已有手工区域');
  h.controls.get('.undo').onclick();
  assert.equal(h.editor.state().paintOps.length,1,'一次撤销整个智能识别');
  h.controls.get('.redo-paint').onclick();
  assert.equal(h.editor.state().paintOps.length,2);
  await h.editor.detectPaint(true);
  assert.equal(h.editor.state().paintOps.length,1,'明确重来才清除手工区域');
  h.controls.get('.undo').onclick();
  assert.equal(h.editor.state().paintOps.length,2,'重来仍可撤销');
}

{
  const h=setup();await h.editor.startPaint('brush');
  h.editor.beginPaintDrag({...h.event(250,200),button:1});
  h.editor.endPaintDrag();assert.equal(h.editor.state().paintOps.length,1,'中键平移不能产生笔迹');
  h.env.drag={id:1};h.editor.movePaintDrag(h.event(300,220));h.editor.endPaintDrag();
  assert.equal(h.editor.state().paintOps.length,1,'平移中不能修改遮蔽记录');
}

{
  const h=setup();await h.editor.startPaint('brush');
  h.controls.get('.paint-effect').value='mosaic';
  const slider=h.controls.get('.block');
  slider.value='24';slider.oninput();
  assert.equal(h.editor.state().paintOps[0].block,24,'滑块实时修改已有马赛克');
  slider.value='32';slider.oninput();slider.onchange();
  assert.equal(h.editor.viewerSnapshot().ops[0].block,32,'复制快照使用调整后的色块');
  h.controls.get('.undo').onclick();
  assert.equal(h.editor.state().paintOps[0].block,8,'一次撤销完整滑块拖动');
  h.controls.get('.redo-paint').onclick();
  assert.equal(h.editor.state().paintOps[0].block,32);
  await h.editor.detectPaint(false);
  await h.editor.startPaint('select');
  h.editor.beginPaintDrag(h.event(90,70));h.editor.endPaintDrag();
  slider.value='40';slider.oninput();slider.onchange();
  assert.equal(h.editor.state().paintOps[0].block,40,'选中区域可单独调节');
  assert.equal(h.editor.state().paintOps[1].block,16,'未选中的区域保持原值');
}

{
  const h=setup();await h.editor.startPaint('brush');
  h.editor.beginPaintDrag(h.event(300,200));h.editor.endPaintDrag();
  assert.equal(h.editor.state().paintOps[1].effect,'blur','新笔迹默认模糊');
  await h.editor.detectPaint(false);
  const effect=h.controls.get('.paint-effect');effect.value='mosaic';effect.onchange();
  assert.ok(h.editor.state().paintOps.every(op=>op.effect==='mosaic'||!op.effect),'自动和手工均可切换');
  h.controls.get('.undo').onclick();
  assert.equal(h.editor.state().paintOps[1].effect,'blur','效果切换可撤销');
  effect.value='blur';effect.onchange();
  const slider=h.controls.get('.block');slider.value='60';slider.oninput();slider.onchange();
  assert.ok(h.editor.viewerSnapshot().ops.every(op=>op.strength===60),'模糊强度进入复制快照');
}

// 清空后主动识别应恢复区域；后台检测不应撤销用户的删除决定。
{
  const cleared={ops:[],suppressed:[auto]};
  assert.equal(api.overlayMerge(cleared,[auto]).ops.length,0);
  const restored=api.overlayMerge(cleared,[auto],true);
  assert.equal(restored.ops.length,1);
  assert.deepEqual(restored.suppressed,[]);
  assert.equal(cleared.suppressed.length,1,'合并不修改原记录');
  const adjusted={...auto,id:'adjusted',auto:false,effect:'mosaic',block:32};
  assert.deepEqual(api.overlayMerge({ops:[adjusted],suppressed:[auto]},[auto],true).ops,[adjusted],'保留人工效果且不重复叠加');
  const h=setup();await h.editor.startPaint('brush');await h.editor.detectPaint(false);
  h.controls.get('.clear-paint').onclick();assert.equal(h.editor.state().paintOps.length,0);
  await h.editor.detectPaint(false);assert.equal(h.editor.state().paintOps.length,1,'编辑中清空再识别可恢复');
  h.controls.get('.undo').onclick();assert.equal(h.editor.state().paintOps.length,0,'恢复识别仍支持撤销');
}

// 长按滑块期间即使停顿，也不排入后端预览；释放后只请求最后的状态。
{
  const h=setup();await h.editor.startPaint('brush');
  h.controls.get('.paint-effect').value='mosaic';
  let scheduled=0;h.env.setTimeout=()=>++scheduled;
  const slider=h.controls.get('.block');slider.onpointerdown({pointerId:1});
  slider.value='24';slider.oninput();slider.value='32';slider.oninput();
  assert.equal(scheduled,0,'拖动不切换后端预览');
  slider.onchange();assert.equal(scheduled,0,'指针尚未释放时 change 不提前结束');
  slider.onpointerup();assert.equal(scheduled,1,'松手只合成最终强度');
  slider.onlostpointercapture();slider.onblur();assert.equal(scheduled,1,'多种结束事件不重复合成');
  h.controls.get('.undo').onclick();assert.equal(h.editor.state().paintOps[0].block,8);
}
