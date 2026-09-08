import assert from 'node:assert/strict';
import { renderMarkdown } from '../webapps/better-notebooks/modules/markdown-renderer.js';

const html = renderMarkdown('# Imports\n\nUse **pandas** and `dataiku`.\n\n- first\n- second\n\n> A note\n\n```python\nprint("ok")\n```');
assert.match(html, /<h1>Imports<\/h1>/);
assert.match(html, /<strong>pandas<\/strong>/);
assert.match(html, /<code>dataiku<\/code>/);
assert.match(html, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
assert.match(html, /<blockquote>A note<\/blockquote>/);
assert.match(html, /<pre><code class="language-python">print\(&quot;ok&quot;\)<\/code><\/pre>/);
assert.doesNotMatch(renderMarkdown('[unsafe](javascript:alert(1))'), /href="javascript:/);
console.log('Markdown renderer checks passed.');
