/** Local verification deliberately excludes the opt-in browser suite. */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const root = new URL('..', import.meta.url);
const checks = [
  [process.execPath, ['tests/webapp-smoke.mjs']],
  [process.execPath, ['--test', 'tests/dss-bundle.test.mjs']],
  [process.execPath, ['tests/recovery-drafts.test.mjs']],
  [process.execPath, ['tests/markdown-sections.test.mjs']],
  [process.execPath, ['tests/markdown-renderer.test.mjs']],
  [process.execPath, ['--test', 'tests/reliability.test.mjs']],
  [process.execPath, ['--test', 'tests/python-hover.test.mjs']],
  [process.execPath, ['--test', 'tests/result-model.test.mjs', 'tests/result-controller.test.mjs']],
  [process.env.BETTER_NOTEBOOKS_TEST_PYTHON || 'python3', ['tests/result-explorer.test.py']],
  [process.env.BETTER_NOTEBOOKS_TEST_PYTHON || 'python3', ['tests/backend-reliability.test.py']],
];
for (const [command,args] of checks) {
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});
  if(result.error) { console.error(result.error.message);process.exit(1); }
  if(result.status!==0)process.exit(result.status||1);
}
const expected=await build({entryPoints:['webapps/better-notebooks/app-runtime.js'],absWorkingDir:root.pathname,bundle:true,format:'iife',minifyWhitespace:true,minifySyntax:true,minifyIdentifiers:false,target:'es2020',loader:{'.py':'text'},outfile:'webapps/better-notebooks/app.js',write:false,logLevel:'silent'});
const actual=await readFile(new URL('webapps/better-notebooks/app.js',root));
if(!actual.equals(Buffer.from(expected.outputFiles[0].contents))) { console.error('Packaged app.js is stale. Run pnpm run build:webapp.');process.exit(1); }
console.log('All local checks passed; packaged bundle matches source. Browser tests were not run.');
