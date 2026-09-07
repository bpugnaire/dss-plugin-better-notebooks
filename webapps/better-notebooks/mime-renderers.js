import Plotly from 'plotly.js-dist-min';
import vegaEmbed from 'vega-embed';

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function encoded(value) { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))); }
function decoded(value) { return JSON.parse(decodeURIComponent(escape(atob(value)))); }

export function renderRichMime(data = {}, key) {
  if (data['application/vnd.plotly.v1+json']) return `<div class="interactive-output plotly-output" data-plotly="${encoded(data['application/vnd.plotly.v1+json'])}" data-output-key="${key}"></div>`;
  if (data['application/vnd.vegalite.v6+json'] || data['application/vnd.vegalite.v5+json'] || data['application/vnd.vegalite.v4+json'] || data['application/vnd.vega.v6+json'] || data['application/vnd.vega.v5+json']) {
    const spec = data['application/vnd.vegalite.v6+json'] || data['application/vnd.vegalite.v5+json'] || data['application/vnd.vegalite.v4+json'] || data['application/vnd.vega.v6+json'] || data['application/vnd.vega.v5+json'];
    return `<div class="interactive-output vega-output" data-vega="${encoded(spec)}" data-output-key="${key}"></div>`;
  }
  if (data['image/png']) return `<figure class="notebook-image-output"><img src="data:image/png;base64,${String(data['image/png']).replace(/[^A-Za-z0-9+/=]/g, '')}" alt="Notebook plot" /></figure>`;
  if (data['image/jpeg']) return `<figure class="notebook-image-output"><img src="data:image/jpeg;base64,${String(data['image/jpeg']).replace(/[^A-Za-z0-9+/=]/g, '')}" alt="Notebook image" /></figure>`;
  if (data['image/svg+xml']) return `<figure class="notebook-image-output"><img src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(String(data['image/svg+xml']))))}" alt="Notebook plot" /></figure>`;
  if (data['text/html']) return `<iframe class="notebook-html-output" sandbox referrerpolicy="no-referrer" srcdoc="${htmlEscape(String(data['text/html']))}" title="Notebook rich output"></iframe>`;
  if (data['application/json']) return `<pre class="runtime-output json-output">${htmlEscape(JSON.stringify(data['application/json'], null, 2))}</pre>`;
  return '';
}

export async function hydrateRichMime(root) {
  const tasks = [];
  root.querySelectorAll('[data-plotly]:not([data-hydrated])').forEach(element => {
    element.dataset.hydrated = 'true';
    try {
      const figure = decoded(element.dataset.plotly);
      tasks.push(Plotly.newPlot(element, figure.data || [], figure.layout || {}, { responsive: true, displaylogo: false }));
    } catch (error) { element.textContent = `Could not render Plotly output: ${error.message}`; }
  });
  root.querySelectorAll('[data-vega]:not([data-hydrated])').forEach(element => {
    element.dataset.hydrated = 'true';
    try { tasks.push(vegaEmbed(element, decoded(element.dataset.vega), { actions: false, renderer: 'canvas' })); }
    catch (error) { element.textContent = `Could not render Vega output: ${error.message}`; }
  });
  await Promise.allSettled(tasks);
}
