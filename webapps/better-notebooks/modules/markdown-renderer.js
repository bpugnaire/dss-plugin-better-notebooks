function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function safeHref(value) {
  const href = String(value || '').trim();
  if (/^(?:https?:|mailto:|#|\/)/i.test(href)) return href;
  return '#';
}

function inlineMarkdown(value) {
  const protectedParts = [];
  const protect = html => `\u0000${protectedParts.push(html) - 1}\u0000`;
  let html = escapeHTML(value)
    .replace(/`([^`]+)`/g, (_, code) => protect(`<code>${code}</code>`))
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => protect(`<img src="${escapeHTML(safeHref(src))}" alt="${alt}" loading="lazy" />`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => protect(`<a href="${escapeHTML(safeHref(href))}" target="_blank" rel="noopener noreferrer">${label}</a>`))
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, boldA, boldB) => `<strong>${boldA || boldB}</strong>`)
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)/g, (_, italicA, italicB) => `<em>${italicA || italicB}</em>`);
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => protectedParts[Number(index)]);
}

export function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let index = 0;
  const paragraph = () => {
    const linesInParagraph = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s+|^```|^(?:[-*+]\s+|\d+[.)]\s+|>\s?|[-*_]{3,}\s*$)/.test(lines[index])) linesInParagraph.push(lines[index++]);
    if (linesInParagraph.length) output.push(`<p>${inlineMarkdown(linesInParagraph.join('\n')).replace(/\n/g, '<br />')}</p>`);
  };
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); index += 1; continue; }
    if (/^```/.test(line)) {
      const language = line.slice(3).trim(); const code = []; index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      output.push(`<pre><code${language ? ` class="language-${escapeHTML(language)}"` : ''}>${escapeHTML(code.join('\n'))}</code></pre>`); continue;
    }
    if (/^[-*_]{3,}\s*$/.test(line)) { output.push('<hr />'); index += 1; continue; }
    const list = line.match(/^([-*+]|\d+[.)])\s+(.+)$/);
    if (list) {
      const ordered = /^\d/.test(list[1]); const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^([-*+]|\d+[.)])\s+(.+)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(`<li>${inlineMarkdown(item[2])}</li>`); index += 1;
      }
      output.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      output.push(`<blockquote>${inlineMarkdown(quote.join('\n')).replace(/\n/g, '<br />')}</blockquote>`); continue;
    }
    paragraph();
  }
  return output.join('');
}
