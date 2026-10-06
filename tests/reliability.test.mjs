import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaveCoordinator } from '../webapps/better-notebooks/modules/save-coordinator.js';
import { ExecutionQueue } from '../webapps/better-notebooks/modules/execution-queue.js';
import { SessionRegistry } from '../webapps/better-notebooks/modules/session-registry.js';
import { reduceOutput } from '../webapps/better-notebooks/modules/kernel-protocol.js';
import { safeStorage, scopedDraftKey } from '../webapps/better-notebooks/modules/browser-storage.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const turn = async () => { for (let i=0;i<15;i++) await Promise.resolve(); };
class Clock {
  now = 0; tasks = new Map(); next = 0;
  setTimeout = (fn, delay) => { const id=++this.next; this.tasks.set(id,{fn,at:this.now+delay}); return id; };
  clearTimeout = id => this.tasks.delete(id);
  async tick(ms) { const end=this.now+ms; while (true) { const next=[...this.tasks].sort((a,b)=>a[1].at-b[1].at).find(([,t])=>t.at<=end); if(!next)break; this.now=next[1].at; this.tasks.delete(next[0]); next[1].fn(); await turn(); } this.now=end; await turn(); }
}
test('per-notebook debounce and single-flight preserve newer edits/drafts', async () => {
  const clock=new Clock(), a={cells:['a'],revision:'r0'}, b={cells:['b'],revision:'r0'}, writes=[], cleared=[], states=[];
  const first=deferred();
  const saves=new SaveCoordinator({clock,snapshot:n=>({cells:n.cells}),write:async(n,doc,rev)=>{writes.push({n,doc,rev}); if(writes.length===1)await first.promise; return {notebook:doc,revision:`r${writes.length}`};},read:async()=>null,onSaved:n=>cleared.push(n),onState:(n,s)=>states.push([n,s])});
  saves.dirty(a); await clock.tick(650); a.cells=['a2']; saves.dirty(a); saves.dirty(b); await clock.tick(650);
  assert.equal(writes.filter(w=>w.n===a).length,1); assert.equal(writes.filter(w=>w.n===b).length,1); assert(!cleared.includes(a));
  first.resolve(); await saves.flush(a); assert.deepEqual(writes.filter(w=>w.n===a).map(w=>w.doc.cells),[['a'],['a2']]); assert.equal(cleared.filter(n=>n===a).length,1); assert(!saves.unresolved(a));
});
test('lost response acknowledges exact sent document before saving newer generation', async () => {
  const n={cells:[1],revision:'old'}, calls=[], readGate=deferred(), clock=new Clock();
  const saves=new SaveCoordinator({clock,snapshot:n=>({cells:n.cells}),write:async(n,doc,rev)=>{calls.push(rev); if(calls.length===1)throw new TypeError('network'); return {notebook:doc,revision:'second'};},read:()=>readGate.promise});
  saves.dirty(n); const flight=saves.flush(n); await turn(); n.cells=[2]; saves.dirty(n); readGate.resolve({notebook:{cells:[1]},revision:'first'}); await flight; assert.deepEqual(calls,['old','first']); assert.equal(n.revision,'second');
});
test('conflict freezes autosave; HTTP failures never masquerade as success', async () => {
  const clock=new Clock(), n={cells:[1],revision:'old'}; let writes=0, reads=0;
  const conflict=Object.assign(new Error('changed'),{status:409});
  const saves=new SaveCoordinator({clock,snapshot:n=>n.cells,write:async()=>{writes++;throw conflict;},read:async()=>{reads++;return null;}});
  saves.dirty(n); await assert.rejects(saves.flush(n),e=>e===conflict); saves.dirty(n); await clock.tick(5000); await assert.rejects(saves.flush(n,{retry:true})); assert.equal(writes,1); assert.equal(reads,0); assert(saves.unresolved(n));
});
test('network failure retains dirty state and explicit retry succeeds', async () => {
  const clock=new Clock(), n={cells:[1],revision:'r0'}; let fails=true, cleared=0;
  const saves=new SaveCoordinator({clock,snapshot:n=>n.cells,write:async(n,d)=>{if(fails)throw new Error('offline');return {notebook:d,revision:'r1'};},read:async()=>null,onSaved:()=>cleared++});
  saves.dirty(n); await assert.rejects(saves.flush(n)); assert.equal(cleared,0); fails=false; await saves.flush(n,{retry:true}); assert.equal(cleared,1);
});
test('execution queues isolate notebooks and cancel queued tasks without replay', async () => {
  const q=new ExecutionQueue(), gate=deferred(), calls=[];
  const a=q.enqueue('a',async cancelled=>{calls.push('a');await gate.promise;return cancelled();});
  const skipped=q.enqueue('a',async()=>calls.push('skipped')); const rejected=assert.rejects(skipped);
  await q.enqueue('b',async()=>calls.push('b')); q.cancel('a'); gate.resolve(); assert.equal(await a,true); await rejected; assert.deepEqual(calls,['a','b']);
});
function harness({ existing = true, infoDelay = 0 } = {}) {
  const clock=new Clock(), sockets=[], sent=[], states=[], native=[{id:'session-a',path:'P/A.ipynb',kernel:{id:'k-a',name:'python3'}}]; let creates=0;
  class Socket {
    readyState=0; listeners=new Map();
    constructor(url) { this.url=url; sockets.push(this); queueMicrotask(()=>{this.readyState=1;this.emit('open',{});}); }
    addEventListener(type,fn) { const list=this.listeners.get(type)||[]; list.push(fn); this.listeners.set(type,list); }
    emit(type,event) { for(const fn of this.listeners.get(type)||[])fn(event); }
    send(raw) { const m=JSON.parse(raw); sent.push(m); if(m.header.msg_type==='kernel_info_request') { const reply=()=>{this.msg(m,'kernel_info_reply',{}); this.msg(m,'status',{execution_state:'idle'});}; if(infoDelay)clock.setTimeout(reply,infoDelay);else queueMicrotask(reply); } }
    msg(parent,type,content) { this.emit('message',{data:JSON.stringify({header:{msg_type:type},parent_header:{msg_id:parent.header.msg_id},content})}); }
    close() { this.readyState=3;this.emit('close',{}); }
  }
  const registry=new SessionRegistry({clock,socketFactory:url=>new Socket(url),socketUrl:(k,s)=>`${k}/${s}`,request:async(path,options={})=>{if(options.method==='POST'&&path==='api/sessions'){creates++;return native[0];}return existing?native:[];},onState:(n,s)=>states.push(s)});
  return {registry,clock,sockets,sent,states,native,get creates(){return creates;}};
}
test('simultaneous starts share one session and respect existing compatible sessions', async () => {
  const h=harness({existing:false}), n={}; const [a,b]=await Promise.all([h.registry.connect(n,'P/A.ipynb','python3'),h.registry.connect(n,'P/A.ipynb','python3')]); assert.equal(a,b); assert.equal(h.creates,1); assert.equal(h.sockets.length,1);
});
test('execution survives 120 seconds and completes only with reply AND idle in either order', async () => {
  for(const idleFirst of [false,true]) {
    const h=harness(), n={}, s=await h.registry.connect(n,'P/A.ipynb','python3'); let done=false;
    const result=h.registry.execute(s,'long()').then(r=>{done=true;return r;}); const m=h.sent.at(-1);
    await h.clock.tick(120000); assert(!done); assert.equal(s.state,'busy');
    const first=idleFirst?'status':'execute_reply'; const second=idleFirst?'execute_reply':'status';
    h.sockets[0].msg(m,first,first==='status'?{execution_state:'idle'}:{execution_count:1,status:'ok'}); await turn(); assert(!done);
    h.sockets[0].msg(m,second,second==='status'?{execution_state:'idle'}:{execution_count:1,status:'ok'}); assert.equal((await result).executionCount,1);
  }
});
test('missing idle makes result uncertain after ten seconds', async () => {
  const h=harness(), s=await h.registry.connect({},'P/A.ipynb','python3'); const result=h.registry.execute(s,'x'); const check=assert.rejects(result,e=>e.code==='RESULT_UNCONFIRMED');
  h.sockets[0].msg(h.sent.at(-1),'execute_reply',{status:'ok',execution_count:1}); await h.clock.tick(10000); await check; assert.equal(s.state,'unknown');
});
test('disconnect rejects pending execution and reconnects without sending the code again', async () => {
  const h=harness(), n={}, s=await h.registry.connect(n,'P/A.ipynb','python3'); const result=h.registry.execute(s,'side_effect()'); const check=assert.rejects(result,e=>e.code==='RESULT_UNCONFIRMED');
  h.sockets[0].close(); await check; await h.clock.tick(1000); assert.equal(h.sockets.length,2); assert.equal(s.state,'idle'); assert.equal(h.sent.filter(m=>m.header.msg_type==='execute_request').length,1); h.registry.invalidate(n);
});
test('missing native session requires restart and never creates one on reconnect', async () => {
  const h=harness(), n={}, s=await h.registry.connect(n,'P/A.ipynb','python3'); h.native.splice(0); h.sockets[0].close(); await h.clock.tick(1000); assert.equal(s.state,'missing'); assert.equal(h.creates,0); await assert.rejects(h.registry.execute(s,'x')); h.registry.invalidate(n);
});
test('interrupt rejects running requests and confirms idle via probe', async () => {
  const h=harness(), n={}, s=await h.registry.connect(n,'P/A.ipynb','python3'); const result=h.registry.execute(s,'x'); const check=assert.rejects(result,e=>e.code==='INTERRUPTED'); await h.registry.interrupt(n); await check; assert.equal(s.state,'idle');
});
test('clear_output wait and display_id updates mutate existing output', () => {
  const r={outputs:[],displays:new Map()}; const msg=(type,content)=>({header:{msg_type:type},content});
  reduceOutput(r,msg('display_data',{data:{'text/plain':'old'},transient:{display_id:'id'}}));
  reduceOutput(r,msg('update_display_data',{data:{'text/plain':'new'},transient:{display_id:'id'}})); assert.equal(r.outputs.length,1); assert.equal(r.outputs[0].data['text/plain'],'new');
  reduceOutput(r,msg('clear_output',{wait:true})); assert.equal(r.outputs.length,1); reduceOutput(r,msg('stream',{text:'next'})); assert.equal(r.outputs.length,1); assert.equal(r.outputs[0].text,'next');
  reduceOutput(r,msg('clear_output',{wait:false})); assert.equal(r.outputs.length,0);
});
test('display updates also reach a finished cell from another request', async () => {
  const h=harness(), s=await h.registry.connect({},'P/A.ipynb','python3'); let output;
  const p=h.registry.execute(s,'display',o=>{output=structuredClone(o);}); const m=h.sent.at(-1);
  h.sockets[0].msg(m,'display_data',{data:{'text/plain':'old'},transient:{display_id:'id'}}); h.sockets[0].msg(m,'execute_reply',{status:'ok',execution_count:1}); h.sockets[0].msg(m,'status',{execution_state:'idle'}); await p;
  h.sockets[0].msg({header:{msg_id:'other'}},'update_display_data',{data:{'text/plain':'new'},transient:{display_id:'id'}}); assert.equal(output[0].data['text/plain'],'new');
});
test('storage exceptions do not prevent editing and namespaces separate projects/webapps', () => {
  let errors=0; const storage=safeStorage(()=>{throw new Error('quota');},()=>errors++); assert.equal(storage.getItem('x'),null); assert.equal(storage.setItem('x','y'),false); assert.equal(storage.removeItem('x'),false); assert.equal(errors,3);
  assert.notEqual(scopedDraftKey('n','P','w','A'),scopedDraftKey('n','Q','w','A')); assert.notEqual(scopedDraftKey('n','P','w','A'),scopedDraftKey('n','P','v','A'));
});

test('nbformat serialization preserves cell ids, raw cells and custom fields without mutating its input', async () => {
  const {serializeNotebook}=await import('../webapps/better-notebooks/modules/notebook-document.js');
  const native={nbformat:4,nbformat_minor:5,unknownTop:12,metadata:{custom:{x:1}},cells:[]};
  const cells=[{id:'stable',type:'python',source:'x=2\n',dssCell:{id:'stable',metadata:{custom:9},unknown:7,outputs:[{output_type:'stream',text:'ok'}],execution_count:3}},{id:'raw',type:'raw',source:'raw text',dssCell:{cell_type:'raw',metadata:{custom:'raw'},custom:1}},{id:'md',type:'markdown',source:'# Intro',dssCell:{metadata:{},attachments:{file:{'image/png':'abc'}}}}];
  const before=structuredClone({native,cells}); const result=serializeNotebook({dssContent:native,cells},null,()=>({status:'succeeded'}));
  assert.equal(result.unknownTop,12);assert.equal(result.cells[0].id,'stable');assert.equal(result.cells[0].unknown,7);assert.equal(result.cells[0].metadata.custom,9);assert.equal(result.cells[1].cell_type,'raw');assert(!('outputs'in result.cells[1]));assert(!('execution_count'in result.cells[2]));assert.deepEqual(result.cells[2].attachments,cells[2].dssCell.attachments);assert.deepEqual({native,cells},before);
});

test('new output for the same cell replaces display subscriptions from its previous run', async () => {
  const h=harness(), n={}, s=await h.registry.connect(n,'P/A.ipynb','python3'); const updates=[];
  const first=h.registry.execute(s,'old',o=>updates.push(o[0]?.data?.['text/plain']),{owner:'cell'}); const m=h.sent.at(-1);
  h.sockets[0].msg(m,'display_data',{data:{'text/plain':'old'},transient:{display_id:'old-id'}});h.sockets[0].msg(m,'execute_reply',{status:'ok'});h.sockets[0].msg(m,'status',{execution_state:'idle'});await first;
  const second=h.registry.execute(s,'new',()=>{}, {owner:'cell'}); const m2=h.sent.at(-1);
  h.sockets[0].msg(m2,'update_display_data',{data:{'text/plain':'stale'},transient:{display_id:'old-id'}});assert.deepEqual(updates,['old']);
  h.sockets[0].msg(m2,'execute_reply',{status:'ok'});h.sockets[0].msg(m2,'status',{execution_state:'idle'});await second;
});
test('disposing a notebook ignores an old save acknowledgement and retains its draft', async () => {
  const gate=deferred(), n={cells:[1],revision:'old'}, clock=new Clock();let cleared=0;
  const saves=new SaveCoordinator({clock,snapshot:n=>n.cells,write:()=>gate.promise,onSaved:()=>cleared++});saves.dirty(n);const p=saves.flush(n);saves.dispose(n);gate.resolve({notebook:[1],revision:'new'});await p;assert.equal(cleared,0);assert.equal(n.revision,'old');
});
test('failed reconnects use all four backoff steps, then permit a manual attempt', async () => {
  const h=harness(), n={}, s=await h.registry.connect(n,'P/A.ipynb','python3');
  const original=h.registry.open.bind(h.registry);let attempts=0;
  h.registry.open=async()=>{attempts++;throw new Error('offline');};h.sockets[0].close();
  await h.clock.tick(1000);assert.equal(attempts,1);await h.clock.tick(2000);assert.equal(attempts,2);await h.clock.tick(4000);assert.equal(attempts,3);await h.clock.tick(8000);assert.equal(attempts,4);assert.equal(s.state,'disconnected');
  h.registry.open=original;const retry=h.registry.reconnect(s,true);await h.clock.tick(0);await retry;assert.equal(s.state,'idle');h.registry.invalidate(n);
});
test('invalidation rejects pending work and stale sockets cannot update a new session', async () => {
  const h=harness(), n={}, s=await h.registry.connect(n,'P/A.ipynb','python3');const result=h.registry.execute(s,'x');const check=assert.rejects(result,e=>e.code==='RESULT_UNCONFIRMED');const old=h.sockets[0], m=h.sent.at(-1);
  h.registry.invalidate(n);await check;const newer=await h.registry.connect(n,'P/A.ipynb','python3');old.msg(m,'status',{execution_state:'busy'});assert.equal(newer.state,'idle');assert.equal(h.clock.tasks.size,0);
});


test('recovery detects unsaved output and uncertain execution even when source is unchanged', async () => {
  const {compareCells}=await import('../webapps/better-notebooks/recovery-drafts.js');
  const a={type:'python',source:'x',execution:{status:'succeeded',order:1},dssCell:{outputs:[]}};
  const b=structuredClone(a);b.dssCell.outputs=[{output_type:'stream',text:'unsaved'}];assert.equal(compareCells([a],[b]).length,1);
  const c=structuredClone(a);c.execution.status='uncertain';assert.equal(compareCells([a],[c]).length,1);
  const d=structuredClone(c);d.execution.status='running';assert.equal(compareCells([c],[d]).length,0);
});

test('cold kernel startup stays starting and can take longer than five seconds', async () => {
  const h=harness({infoDelay:12000}), n={}; const pending=h.registry.connect(n,'P/A.ipynb','python3'); await turn();
  await h.clock.tick(10000);assert.equal(h.registry.sessions.get(n).state,'starting');await h.clock.tick(2000);const s=await pending;assert.equal(s.state,'idle');
});
test('startup failure reports the requested kernelspec and readiness deadline', async () => {
  const h=harness({infoDelay:25000}), n={};const pending=h.registry.connect(n,'P/A.ipynb','python3');const check=assert.rejects(pending,e=>/python3/.test(e.message)&&/20 seconds/.test(e.message));await turn();await h.clock.tick(20000);await check;assert.equal(h.registry.sessions.get(n).state,'disconnected');
});
test('runtime switch explicitly patches a pre-existing native session after a frontend reload', async () => {
  const h=harness(), n={}, calls=[];
  h.registry.request=async(path,options={})=>{
    calls.push([path,options.method||'GET']);
    if(options.method==='PATCH') {
      const kernelName=JSON.parse(options.body).kernel.name;
      const native={id:'session-a',path:'P/A.ipynb',kernel:{id:'new-kernel',name:kernelName}};
      h.native.splice(0,1,native);return native;
    }
    return h.native;
  };
  const s=await h.registry.replace(n,'P/A.ipynb','new-env');assert.equal(s.kernelName,'new-env');assert.equal(s.kernelId,'new-kernel');
  assert(calls.some(([path,method])=>path==='api/sessions/session-a'&&method==='PATCH'));assert(!calls.some(([,method])=>method==='DELETE'||method==='POST'));assert.equal(h.native.length,1);
});
test('wrong returned kernelspec never counts as a successful environment switch', async () => {
  const h=harness({existing:false});await assert.rejects(h.registry.connect({},'P/A.ipynb','different-env'),/instead of requested kernel/);assert.equal(h.sockets.length,0);
});

test('failed environment startup cleans its newly created native session', async () => {
  const h=harness({infoDelay:25000}), n={}, deleted=[];h.native.splice(0);
  h.registry.request=async(path,options={})=>{
    if(options.method==='DELETE'){deleted.push(path);h.native.splice(0);return {};}
    if(options.method==='POST'){const native={id:'failed-new',path:'P/A.ipynb',kernel:{id:'new-kernel',name:'new-env'}};h.native.push(native);return native;}
    return h.native;
  };
  const pending=h.registry.replace(n,'P/A.ipynb','new-env');const rejected=assert.rejects(pending,/readiness timed out/);await turn();await h.clock.tick(20000);await rejected;assert(deleted.includes('api/sessions/failed-new'));assert(!h.registry.sessions.has(n));assert.equal(h.native.length,0);
});

test('DSS returning demo_python_env on POST is corrected by PATCH to dss_env', async () => {
  const h=harness(), n={}, calls=[];
  // Discovery did not recognize the path, but Jupyter POST reuses its session.
  const old={id:'session-old',path:'different-path',kernel:{id:'old-kernel',name:'py-dku-venv-demo_python_env'}};
  h.registry.request=async(path,options={})=>{
    calls.push([path,options.method||'GET']);
    if(options.method==='POST')return old;
    if(options.method==='PATCH') {assert.deepEqual(JSON.parse(options.body),{kernel:{name:'py-dku-venv-dss_env'}});return {...old,kernel:{id:'selected-kernel',name:'py-dku-venv-dss_env'}};}
    return [old];
  };
  const s=await h.registry.replace(n,'P/A.ipynb','py-dku-venv-dss_env');assert.equal(s.kernelId,'selected-kernel');assert.equal(s.state,'idle');assert(calls.some(([path,method])=>path==='api/sessions/session-old'&&method==='PATCH'));assert(h.sockets[0].url.startsWith('selected-kernel/'));
});
test('failed PATCH preserves a pre-existing native kernel and never opens its socket', async () => {
  const h=harness(), n={}, calls=[];
  h.registry.request=async(path,options={})=>{calls.push(options.method||'GET');if(options.method==='PATCH')throw new Error('permission denied');return h.native;};
  await assert.rejects(h.registry.replace(n,'P/A.ipynb','new-env'),/Could not switch.*permission denied/);assert(!calls.includes('DELETE'));assert.equal(h.native[0].kernel.name,'python3');assert.equal(h.sockets.length,0);
});
test('PATCH returning the old environment is rejected before any execution', async () => {
  const h=harness(), n={};h.registry.request=async(path,options={})=>options.method==='PATCH'?h.native[0]:h.native;
  await assert.rejects(h.registry.replace(n,'P/A.ipynb','new-env'),/instead of requested kernel/);assert.equal(h.sockets.length,0);assert.equal(h.sent.filter(m=>m.header.msg_type==='execute_request').length,0);
});
