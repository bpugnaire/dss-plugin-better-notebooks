import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../webapps/better-notebooks/body.html', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../webapps/better-notebooks/app-runtime.js', import.meta.url), 'utf8');
const browserSmoke = readFileSync(new URL('../webapps/better-notebooks/browser-smoke.js', import.meta.url), 'utf8');
const requiredMarkup = ['id="cells"', 'id="notebook-tabs"', 'id="run-all"', 'id="notebook-actions-menu"', 'id="data-panel-toggle"'];
const requiredRuntime = ['loadDssWorkspace', 'cellsFromDss', 'executeInDssKernel', 'completeInDssKernel', 'exportNotebook', 'persistDraft', 'showRecoveryChoice'];
for (const selector of requiredMarkup) if (!html.includes(selector)) throw new Error(`Missing webapp markup: ${selector}`);
for (const symbol of requiredRuntime) if (!runtime.includes(symbol)) throw new Error(`Missing webapp runtime capability: ${symbol}`);
if (!browserSmoke.includes('__betterNotebooksSmoke')) throw new Error('Missing browser-executed smoke probe');
console.log('Better Notebooks browser-contract smoke check passed.');
