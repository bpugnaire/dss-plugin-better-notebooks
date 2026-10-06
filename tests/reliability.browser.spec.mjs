import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../webapps/better-notebooks/body.html',import.meta.url),'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/webapps/better-notebooks/style.css"></head><body>${body}<script src="/webapps/better-notebooks/app.js"></script></body></html>`;
function document(name) { return {nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:'python3',language:'python',display_name:'Python'},custom:'preserved'},cells:[{id:`cell-${name}`,cell_type:'code',source:[`print("${name}")`],execution_count:null,outputs:[],metadata:{}}]}; }
async function setup(page, { recovery=false, legacy=false, storageError=false } = {}) {
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
  await page.addInitScript(({recovery,legacy,storageError})=>{
    document.cookie='_xsrf=test; path=/';
    window.dataiku={getWebAppConfig:()=>({}),getWebAppBackendUrl:path=>`/backend${path}`};
    if(recovery&&!sessionStorage.getItem('seeded')) {
      const key=legacy?'better-notebooks-draft-A':'better-notebooks:draft:P:%2Fbackend%2F:A';
      localStorage.setItem(key,JSON.stringify({savedAt:Date.now(),cells:[{id:'cell-A',type:'python',source:'recovered = 42',dssCell:{id:'cell-A',cell_type:'code',metadata:{},outputs:[],execution_count:null}}]}));sessionStorage.setItem('seeded','true');
    }
    if(storageError) Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage unavailable');}});
    window.kernelRequests=[];window.fakeSockets=[];
    class Socket {
      static OPEN=1;readyState=0;listeners={};
      constructor(url){this.url=url;window.fakeSockets.push(this);setTimeout(()=>{this.readyState=1;this.emit('open',{});},0);}
      addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
      emit(type,event){for(const fn of this.listeners[type]||[])fn(event);}
      message(parent,type,content){this.emit('message',{data:JSON.stringify({header:{msg_type:type},parent_header:{msg_id:parent.header.msg_id},content})});}
      send(raw){const m=JSON.parse(raw);window.kernelRequests.push({kernel:this.url,message:m});if(m.header.msg_type==='kernel_info_request')setTimeout(()=>{this.message(m,'kernel_info_reply',{});this.message(m,'status',{execution_state:'idle'});},0);else if(m.content.silent)setTimeout(()=>this.finish(m,[]),0);else this.current=m;}
      finish(m,outputs){for(const output of outputs)this.message(m,'stream',{text:output,name:'stdout'});this.message(m,'execute_reply',{status:'ok',execution_count:1});this.message(m,'status',{execution_state:'idle'});}
      close(){this.readyState=3;this.emit('close',{});}
    }
    window.WebSocket=Socket;
  },{recovery,legacy,storageError});
  await page.goto('/reliability'); await expect(page.locator('#notebook-title')).toHaveText('A');
  return {documents,writes};
}
const editor=page=>page.locator('#cells .cm-content').first();
const select=async(page,name)=>{await page.locator(`#notebook-tree [data-notebook-id="${name}"]`).click();await expect(page.locator('#notebook-title')).toHaveText(name);};
test('hover shows function documentation before execution without starting a kernel',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await setup(page);
  await editor(page).fill('def greet(name):\n    """Say hello to the supplied name."""\n    return name\n\ngreet("Alex")');
  const line=page.locator('#cells .cm-line').filter({hasText:'greet("Alex")'});
  const bounds=await line.boundingBox();
  await page.mouse.move(bounds.x+18,bounds.y+bounds.height/2);
  await expect(page.locator('.cm-project-hover')).toContainText('greet(name)');
  await expect(page.locator('.cm-project-hover')).toContainText('Say hello to the supplied name.');
  expect(await page.evaluate(()=>window.fakeSockets.length)).toBe(0);
  expect(errors).toEqual([]);
});
test('quickly editing A then B saves both native notebooks with no cross-over',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));const {documents,writes}=await setup(page);
  await editor(page).fill('a = 1');await select(page,'B');await editor(page).fill('b = 2');
  await expect.poll(()=>documents.get('A').notebook.cells[0].source.join('')).toBe('a = 1');await expect.poll(()=>documents.get('B').notebook.cells[0].source.join('')).toBe('b = 2');
  expect(writes.some(w=>w.name==='A')).toBeTruthy();expect(errors).toEqual([]);expect(documents.get('A').notebook.cells[0].id).toBe('cell-A');expect(documents.get('A').notebook.metadata.custom).toBe('preserved');
});
test('execution finishes in A while B is active and persists only in A',async({page})=>{
  const {documents}=await setup(page);await page.locator('.run-cell').first().click();
  await expect.poll(()=>page.evaluate(()=>window.fakeSockets.some(s=>s.current))).toBeTruthy();await select(page,'B');
  await page.evaluate(()=>{const socket=window.fakeSockets.find(s=>s.current);socket.finish(socket.current,['output-A']);});
  await expect.poll(()=>documents.get('A').notebook.cells[0].outputs.some(o=>o.text==='output-A')).toBeTruthy();expect(documents.get('B').notebook.cells[0].outputs).toEqual([]);await expect(page.locator('#cells')).not.toContainText('output-A');
  await select(page,'A');await expect(page.locator('#cells')).toContainText('output-A');
});
test('conflict preserves local edits, shows diff, then explicitly loads DSS',async({page})=>{
  const {documents,writes}=await setup(page);await editor(page).fill('local = 1');documents.set('A',{notebook:{...document('A'),cells:[{...document('A').cells[0],source:['remote = 2']}]},revision:'external'});
  await expect(page.locator('#conflict-modal')).toBeVisible();await expect(page.locator('#conflict-diff')).toContainText('local = 1');await expect(page.locator('#conflict-diff')).toContainText('remote = 2');expect(writes).toEqual([]);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#conflict-load-dss').click();await expect(page.locator('#conflict-modal')).toBeHidden();await expect(editor(page)).toContainText('remote = 2');
});
test('conflict can be saved under a new name without overwriting DSS',async({page})=>{
  const {documents}=await setup(page);await editor(page).fill('local = 1');documents.set('A',{notebook:document('A'),revision:'external'});await expect(page.locator('#conflict-modal')).toBeVisible();
  page.once('dialog',dialog=>dialog.accept('Recovered A'));await page.locator('#conflict-save-copy').click();await expect(page.locator('#notebook-title')).toHaveText('Recovered A');expect(documents.get('Recovered A').notebook.cells[0].source.join('')).toBe('local = 1');expect(documents.get('A').revision).toBe('external');
});
test('recovery waits for user choice and survives reloading the page',async({page})=>{
  const {writes}=await setup(page,{recovery:true});await expect(page.locator('#recovery-modal')).toBeVisible();await page.waitForTimeout(800);expect(writes).toEqual([]);await page.reload();await expect(page.locator('#recovery-modal')).toBeVisible();
  await page.locator('#restore-recovery-draft').click();await expect(editor(page)).toContainText('recovered = 42');await expect.poll(()=>writes.length).toBe(1);
});
test('legacy recovery drafts remain available after successful migration',async({page})=>{
  await setup(page,{recovery:true,legacy:true});await expect(page.locator('#recovery-modal')).toBeVisible();await page.locator('#restore-recovery-draft').click();await expect(page.locator('#saved-state')).toContainText('Saved to DSS');expect(await page.evaluate(()=>localStorage.getItem('better-notebooks-draft-A'))).not.toBeNull();
});
test('storage failures display a warning and allow native editing/saving',async({page})=>{
  const {documents}=await setup(page,{storageError:true});await expect(page.locator('#storage-warning')).toBeVisible();await editor(page).fill('still_saved = 1');await expect.poll(()=>documents.get('A').notebook.cells[0].source.join('')).toBe('still_saved = 1');
});
