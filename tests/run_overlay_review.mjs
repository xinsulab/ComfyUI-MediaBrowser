import fs from 'node:fs';
import assert from 'node:assert/strict';
const src=fs.readFileSync(process.argv[2],'utf8');
// 执行实际导出分支，验证绝对 video.src 能与相对 API 路径匹配。
const a=src.indexOf('  const renderShotBlob = async');
const b=src.indexOf('  const shotSingle',a);
let painted=0,drawn=null;
const video={src:'http://localhost/api/view?filename=a.mp4',videoWidth:640,videoHeight:360};
const ctx={drawImage:x=>drawn=x};
const env={pool:new Map(),realRoot:()=> 'output',overlayClone:x=>structuredClone(x),canPaintFile:()=>false,
 document:{baseURI:'http://localhost/',querySelectorAll:()=>[video],createElement:()=>({getContext:()=>ctx})},
 viewFileUrl:()=>'/api/view?filename=a.mp4',times:{},KIND_VID:/\.mp4$/,Image:class{constructor(){throw Error('must use live video');}},
 paintDrawOp:()=>painted++,blurPatch(){},canvasToBlob:async c=>c,t:x=>x,URL};
const render=new Function('env','with(env){'+src.slice(a,b)+';return renderShotBlob;}')(env);
const snapshot={root:'output',showOverlay:true,ops:[{k:'r'}]};
const result=await render('a.mp4',snapshot);
assert.equal(drawn,video);assert.equal(result.width,640);assert.equal(painted,1);
await render('a.mp4',{...snapshot,peeking:true});assert.equal(painted,1);
env.document.querySelectorAll=()=>[];
await assert.rejects(render('a.mp4',snapshot),/请先打开视频/);
// 选图必须等离开确认结果；保存中 Escape 不能丢弃草稿。
let selected=null,allow=false;
const pickBtn={};
const pickCode=src.match(/pickBtn.onclick = async .*?; };/)[0];
new Function('pickBtn','shut','onPick','list','idx',pickCode)(pickBtn,async()=>allow,p=>selected=p,['a.png'],0);
await pickBtn.onclick();assert.equal(selected,null);allow=true;await pickBtn.onclick();assert.equal(selected,'a.png');
const start=src.indexOf('  const onKey = (e) => {',src.indexOf('function openViewer'));
const end=src.indexOf('  const releasePaintPan=',start);
let discarded=0;
const keyEnv={document:{fullscreenElement:null,querySelector:()=>null},paintMode:'brush',paintSaving:true,stopPaint:()=>discarded++};
const key=new Function('env','with(env){'+src.slice(start,end)+';return onKey;}')(keyEnv);
const event={key:'Escape',preventDefault(){},stopImmediatePropagation(){}};
key(event);assert.equal(discarded,0);keyEnv.paintSaving=false;key(event);assert.equal(discarded,1);
// GIF/视频局部遮蔽保留动态媒体本身，仅创建覆盖框。
const overlayCode=src.slice(src.indexOf('const paintCensorOverlay ='),src.indexOf('const attachPeekBtn ='));
let layer;
const cell={_overlaySeq:0,querySelector:()=>null,classList:{contains:()=>false},clientWidth:100,clientHeight:100,appendChild:x=>layer=x};
const paint=new Function('canPaintFile','visibleBoxes','document','mapBoxToEl',overlayCode+';return paintCensorOverlay;')(()=>false,x=>x,{createElement:()=>({style:{},appendChild(x){this.box=x;}})},()=>({x:10,y:10,w:20,h:20}));
paint(cell,[{x:.1,y:.1,w:.2,h:.2}],null,true,{},'output','a.gif');
assert.equal(layer.className,'mb-censor-layer');assert.equal(layer.box.className,'mb-censor-box');
console.log('review regressions passed');

// 复制等待态合成图时，不得被当前 fullBlur=false 覆盖成未遮蔽原图。
let captured;
env.canPaintFile=()=>true;env.overlayBlob=async(root,path,snap)=>{captured=snap;return {};};
env.panelAbort=new AbortController();
env.pool=new Map([[1,{dataset:{path:'a.png'},querySelector:()=>({}),classList:{contains:()=>false},_visibleOverlay:{sourceVersion:{size:1},ops:[],showOverlay:true,fullBlur:true}}]]);
await render('a.png');assert.equal(captured.fullBlur,true);

// 编辑模式滚轮缩放与平移独立于绘制；点击仍不可关闭。
let wheel,zooms=0;
const wa=src.indexOf('  stage.addEventListener("wheel",');
const wb=src.indexOf('  // 触屏翻页',wa);
const zoomEnv={stage:{querySelector:()=>({getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})}),addEventListener:(name,fn)=>wheel=fn},paintMode:'brush',paintStroke:null,paintRect:null,paintMove:null,drag:null,z:1,tx:0,ty:0,VIEW_ZOOM_MIN:1,VIEW_ZOOM_MAX:5,viewZoomAfterWheel:()=>2,viewZoomTranslate:()=>({tx:2,ty:3}),applyZoom:()=>zooms++};
new Function('env','with(env){'+src.slice(wa,wb)+'}')(zoomEnv);
wheel({deltaY:-10,clientX:50,clientY:50,preventDefault(){},stopPropagation(){}});
assert.equal(zoomEnv.z,2);assert.equal(zooms,1,'编辑模式允许滚轮缩放');
zoomEnv.paintStroke={};wheel({preventDefault(){},stopPropagation(){}});assert.equal(zooms,1,'绘制过程中不改变缩放');
let click,closed=0;
const ca=src.indexOf('  stage.addEventListener("click",');
new Function('env','with(env){'+src.slice(ca,wa)+'}')({stage:{addEventListener:(name,fn)=>click=fn},paintMode:'brush',shut:()=>closed++});
click({preventDefault(){},stopPropagation(){}});assert.equal(closed,0,'编辑时点击不会关闭图片');

// 两个入口必须独立：普通识别直接保存，编辑中的识别只进入草稿。
{
  const begin=src.indexOf('  lay.querySelector(".redo").onclick = async () => {');
  const end=src.indexOf('  lay.querySelector(".shot-one").onclick',begin);
  const button={};let direct=0,draft=0,refreshed=0;
  const env={lay:{isConnected:true,querySelector:()=>button},idx:0,list:['a.png'],paintBusy:false,paintMode:'',
    hooks:{ensureLocal:async()=>{direct++;return {boxes:[{}]};},getMode:()=> 'local'},
    detectPaint:async()=>draft++,syncViewerCensor:()=>refreshed++,applyViewerCensor(){},syncActs(){},
    filterClientBoxes:x=>x,notify(){},t:x=>x};
  new Function('env','with(env){'+src.slice(begin,end)+'}')(env);
  await button.onclick();assert.equal(direct,1);assert.equal(draft,0);assert.equal(refreshed,1);
  env.paintMode='brush';await button.onclick();assert.equal(direct,1);assert.equal(draft,1);
  env.paintBusy=true;await button.onclick();assert.equal(draft,1,'忙碌期间不重复识别');
  env.paintBusy=false;env.paintMode='';env.hooks.ensureLocal=async()=>{env.idx=1;return {boxes:[{}]};};
  await button.onclick();assert.equal(refreshed,1,'翻页后不刷新旧图');
}
