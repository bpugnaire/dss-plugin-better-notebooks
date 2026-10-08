import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bundle = readFileSync(new URL('../webapps/better-notebooks/app.js', import.meta.url), 'utf8');

// DSS embedding can consume the escape dollar of `$${...}`. Identifier
// minification generated `class $${...}` in MapLibre: its declaration became
// `class ${...}`, while references to `$$` remained unchanged.
function initializeMapLibreShared(source) {
  const at = source.indexOf('"shared",["exports"]');
  assert(at >= 0, 'MapLibre shared initializer must be exercised, not skipped');
  const start = source.indexOf('(function(', at);
  const worker = source.indexOf('"worker"', start);
  const end = source.lastIndexOf('})),', worker);
  assert(start >= 0 && worker > start && end > start);
  vm.runInNewContext(`${source.slice(start, end + 2)}({})`, {
    TextDecoder, TextEncoder, setTimeout, clearTimeout, performance,
  }, { timeout: 5000 });
}

test('shipped bundle avoids escaped interpolation tokens during DSS embedding', () => {
  assert(!bundle.includes('$${'), 'Do not minify identifiers into names ending in $$ before a block');
  initializeMapLibreShared(bundle.replaceAll('$${', '${'));
});
test('the DSS embedding transformation reproduces the reported undeclared identifier', () => {
  const source = '(function(exports){class $${constructor(){}};exports.Tile=$$;})({})';
  assert.doesNotThrow(() => vm.runInNewContext(source));
  assert.throws(() => vm.runInNewContext(source.replaceAll('$${', '${')), { name: 'ReferenceError', message: '$$ is not defined' });
});
