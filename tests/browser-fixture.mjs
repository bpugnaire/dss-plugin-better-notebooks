import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../webapps/better-notebooks/body.html',import.meta.url),'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/webapps/better-notebooks/style.css"></head><body>${body}<script src="/webapps/better-notebooks/app.js"></script></body></html>`;
function document(name) { return {nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:'python3',language:'python',display_name:'Python'},custom:'preserved'},cells:[{id:`cell-${name}`,cell_type:'code',source:[`print("${name}")`],execution_count:null,outputs:[],metadata:{}}]}; }
export async function setup(page, { recovery=false, legacy=false, storageError=false, explorer=false } = {}) {
  const documents = new Map(['A','B'].map(name=>[name,{notebook:document(name),revision:`${name}-0`}])); const writes=[];
  await page.route('**/reliability',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.route('**/backend/**',async route=>{
    const path=new URL(route.request().url()).pathname.slice('/backend/'.length); const method=route.request().method(); let result;
    if(path==='project-context') result={project:{key:'P',name:'Test project'},datasets:[],connections:[]};
    else if(path==='notebooks'&&method==='GET') result={notebooks:[...documents.keys()].map(name=>({name,kernelSpec:{name:'python3'},language:'PYTHON'}))};
    else if(path==='python-runtimes') result={runtimes:[{id:'dss_builtin',label:'Python',kernelSpec:{name:'python3',language:'python',display_name:'Python'}}]};
    else if(path==='llm-models') result={models:[]};
    else if(path==='python-check') result={valid:true};
    else if(path==='notebooks'&&method==='POST') {const payload=route.request().postDataJSON();if(documents.has(payload.name))return route.fulfill({status:400,json:{error:'Already exists'}});documents.set(payload.name,{notebook:document(payload.name),revision:`${payload.name}-0`});result=documents.get(payload.name);}
    else if(path.startsWith('notebooks/')) {
      const name=decodeURIComponent(path.slice('notebooks/'.length)), current=documents.get(name);
      if(method==='PUT') {const payload=route.request().postDataJSON();if(payload.expectedRevision!==current.revision)return route.fulfill({status:409,json:{code:'NOTEBOOK_CONFLICT',error:'Changed in DSS',revision:current.revision}});result={notebook:payload.notebook,revision:`${name}-${writes.length+1}`};documents.set(name,result);writes.push({name,...payload});}
      else result=current;
    }
    else return route.fulfill({status:404,json:{error:`Unhandled ${path}`}});
    return route.fulfill({json:result});
  });
  await page.route('**/jupyter/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('kernelspecs'))return route.fulfill({json:{kernelspecs:{python3:{spec:{name:'python3',language:'python',display_name:'Python'}}}}});
    if(path.endsWith('/sessions')) {
      if(route.request().method()==='POST') {const n=route.request().postDataJSON().path.split('/').at(-1).replace('.ipynb','');return route.fulfill({json:{id:`session-${n}`,path:`P/${n}.ipynb`,kernel:{id:`kernel-${n}`,name:'python3'}}});}
      return route.fulfill({json:[]});
    }
    return route.fulfill({json:{}});
  });
  await page.addInitScript(({recovery,legacy,storageError,explorer})=>{
    document.cookie='_xsrf=test; path=/';
    window.dataiku={getWebAppConfig:()=>({}),getWebAppBackendUrl:path=>`/backend${path}`};
    if(recovery&&!sessionStorage.getItem('seeded')) {
      const key=legacy?'better-notebooks-draft-A':'better-notebooks:draft:P:%2Fbackend%2F:A';
      localStorage.setItem(key,JSON.stringify({savedAt:Date.now(),cells:[{id:'cell-A',type:'python',source:'recovered = 42',dssCell:{id:'cell-A',cell_type:'code',metadata:{},outputs:[],execution_count:null}}]}));sessionStorage.setItem('seeded','true');
    }
    if(storageError) Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage unavailable');}});
    window.kernelRequests=[];window.fakeSockets=[];window.explorerPayloads=[];window.resultSequence=0;
    const rows=Array.from({length:1000},(_,i)=>[i,i%2?'France':'Germany']);
    const mime='application/vnd.better-notebooks.table.v1+json';
    function descriptor(id){return {version:1,resultId:id,generation:'test-generation',available:true,totalRows:rows.length,columns:[{id:'c0',label:'n',type:'integer',pandasType:'int64'},{id:'c1',label:'country',type:'string',pandasType:'object'}],preview:{rows:rows.slice(0,100),index:Array.from({length:100},(_,i)=>i),truncated:true}};}
    function response(p){
      if(p.op==='release'||p.op==='exportClose')return {ok:true};
      if(window.explorerExpired)return {ok:false,code:'EXPIRED',error:'Snapshot expired. Reexecute the cell.'};
      if(p.op==='describe')return {ok:true,result:descriptor(p.resultId)};
      let view=rows.map((row,index)=>({row,index}));
      for(const f of p.filters||[])view=view.filter(({row})=>{const v=row[f.column==='c0'?0:1];return f.op==='ge'?v>=Number(f.value):f.op==='gt'?v>Number(f.value):f.op==='eq'?String(v)===String(f.value):f.op==='contains'?String(v).toLowerCase().includes(f.value.toLowerCase()):true;});
      for(const sort of [...(p.sorts||[])].reverse())view.sort((a,b)=>{const i=sort.column==='c0'?0:1;return (a.row[i]>b.row[i]?1:a.row[i]<b.row[i]?-1:0)*(sort.direction==='asc'?1:-1);});
      if(p.op==='page'){const part=view.slice(p.offset,p.offset+p.limit);return {ok:true,result:{rows:part.map(x=>x.row),index:part.map(x=>x.index),offset:p.offset,nextOffset:p.offset+part.length,totalRows:rows.length,filteredRows:view.length}};}
      if(p.op==='chart')return {ok:true,result:{rows:view.length,sampled:false,data:[{type:'bar',x:['France','Germany'],y:[view.filter(x=>x.row[1]==='France').length,view.filter(x=>x.row[1]==='Germany').length]}]}};
      if(p.op==='profile')return {ok:true,result:{rows:view.length,columns:[{id:'c0',missing:0,missingPercent:0,cardinality:view.length,supported:true,statistics:{min:view[0]?.row[0]??null,max:view.at(-1)?.row[0]??null,mean:view.reduce((n,x)=>n+x.row[0],0)/Math.max(1,view.length)},distribution:{edges:[0,500,1000],counts:[500,500]}}]}};
      if(p.op==='exportStart'){window.exportView=view;window.exportColumns=p.columns;return {ok:true,result:{token:'csv',total:view.length}};}
      if(p.op==='exportChunk'){const cols=window.exportColumns.map(x=>x==='c0'?0:1);return {ok:true,result:{text:cols.map(i=>i===0?'n':'country').join(',')+'\r\n'+window.exportView.map(x=>cols.map(i=>x.row[i]).join(',')).join('\r\n'),rows:window.exportView.length,total:window.exportView.length,done:true}};}
      return {ok:false,error:'Unknown operation'};
    }
    class Socket {
      static OPEN=1;readyState=0;listeners={};
      constructor(url){this.url=url;window.fakeSockets.push(this);setTimeout(()=>{this.readyState=1;this.emit('open',{});},0);}
      addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
      emit(type,event){for(const fn of this.listeners[type]||[])fn(event);}
      message(parent,type,content){this.emit('message',{data:JSON.stringify({header:{msg_type:type},parent_header:{msg_id:parent.header.msg_id},content})});}
      send(raw){const m=JSON.parse(raw);window.kernelRequests.push({kernel:this.url,message:m});if(m.header.msg_type==='kernel_info_request')setTimeout(()=>{this.message(m,'kernel_info_reply',{});this.message(m,'status',{execution_state:'idle'});},0);else if(m.content.user_expressions?.explorer){const p=JSON.parse(decodeURIComponent(escape(atob(m.content.user_expressions.explorer.match(/"([^"]+)"/)[1]))));window.explorerPayloads.push(p);const reply=response(p);setTimeout(()=>{this.message(m,'execute_reply',{status:'ok',user_expressions:{explorer:{status:'ok',data:{'application/json':reply}}}});this.message(m,'status',{execution_state:'idle'});},window.explorerDelay||0);}else if(m.content.silent)setTimeout(()=>this.finish(m,[]),0);else {this.current=m;if(explorer)setTimeout(()=>{this.message(m,'execute_result',{execution_count:1,data:{[mime]:descriptor('result-'+(++window.resultSequence))}});this.finish(m,[]);},0);}}
      finish(m,outputs){for(const output of outputs)this.message(m,'stream',{text:output,name:'stdout'});this.message(m,'execute_reply',{status:'ok',execution_count:1});this.message(m,'status',{execution_state:'idle'});}
      close(){this.readyState=3;this.emit('close',{});}
    }
    window.WebSocket=Socket;
  },{recovery,legacy,storageError,explorer});
  await page.goto('/reliability'); await expect(page.locator('#notebook-title')).toHaveText('A');
  return {documents,writes};
}
