// 执行真实提示词面板：复制后反馈、关闭后响应、切换面板后的旧响应。
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src=fs.readFileSync(process.argv[2],'utf8').replace(/\r\n/g,'\n');
const a=src.indexOf('  const showMeta = async');
const b=src.indexOf('  let syncPin =',a);
assert.ok(a>=0 && b>a);
for (const action of ['copy','close','replace']) {
  let resolve, copied;
  const button={dataset:{t:encodeURIComponent('test prompt')},classList:{add(){},remove(){}}};
  const element=()=>({isConnected:true,innerHTML:'',querySelector:()=>({}),querySelectorAll:()=>[button]});
  const ctx={pop:null,popOff:[],
    teardownPopDom(){if(ctx.pop){ctx.pop.isConnected=false;ctx.pop=null;}},
    closePop(){ctx.teardownPopDom();},
    document:{createElement:element,body:{appendChild(){}}},t:s=>s,escHtml:s=>s,mbIco:()=>'',
    window:{addEventListener(){}},placePop(){},armPopDismiss(){},realRoot:()=> 'input',
    fetch:()=>new Promise(r=>{resolve=r;}),elapsed:{},duration:{},times:{},
    fmtElapsed:()=>'',fmtWhenFromName:()=>'',fmtWhen:()=>'',
    navigator:{clipboard:{writeText:async s=>{copied=s;}}},setTimeout(){},
  };
  const show=new Function('ctx','with(ctx){'+src.slice(a,b)+';return showMeta;}')(ctx);
  const pending=show('test.png');
  if(action==='close')ctx.closePop();
  if(action==='replace'){ctx.closePop();ctx.pop=element();ctx.pop.innerHTML='new panel';}
  resolve({ok:true,json:async()=>({positive:['test prompt']})});
  await pending;
  if(action==='copy') {
    await button.onclick({stopPropagation(){}});
    assert.equal(copied,'test prompt');
    assert.equal(button.textContent,'✓ 已复制');
  } else if(action==='replace') assert.equal(ctx.pop.innerHTML,'new panel');
}
console.log('metadata lifecycle: passed');
