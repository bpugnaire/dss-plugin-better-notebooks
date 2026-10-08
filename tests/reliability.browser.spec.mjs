import { test, expect } from '@playwright/test';
import { setup } from './browser-fixture.mjs';
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
test('a stopped kernel reconnects automatically without replaying the running cell',async({page})=>{
  await setup(page);let native=null;let created=0;
  await page.route('**/jupyter/api/sessions*',route=>{
    if(route.request().method()==='POST') {
      created+=1;const payload=route.request().postDataJSON();
      native={id:`session-${created}`,path:payload.path,kernel:{id:`kernel-${created}`,name:payload.kernel.name}};
      return route.fulfill({json:native});
    }
    return route.fulfill({json:native?[native]:[]});
  });
  await page.locator('.run-cell').first().click();
  await expect.poll(()=>page.evaluate(()=>window.fakeSockets.some(socket=>socket.current))).toBeTruthy();
  native=null;
  await page.evaluate(()=>window.fakeSockets.find(socket=>socket.current).close());
  await expect(page.locator('#kernel-status')).toHaveText('● Connected — kernel restarted',{timeout:10000});
  await expect(page.locator('#kernel-status')).toHaveAttribute('title',/variables were reset/);
  await expect(page.locator('#cells .cell').first()).toHaveAttribute('data-execution-status','uncertain');
  expect(created).toBe(2);
  expect(await page.evaluate(()=>window.kernelRequests.filter(({message})=>message.header.msg_type==='execute_request'&&!message.content.silent).length)).toBe(1);
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
