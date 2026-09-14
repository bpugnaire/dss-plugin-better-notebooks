export function captureScrollPositions(root) {
  const positions = [{ node: window, top: window.scrollY, left: window.scrollX }];
  const seen = new Set([window]);
  const add = node => {
    if (!node || seen.has(node)) return;
    seen.add(node); positions.push({ node, top: node.scrollTop, left: node.scrollLeft });
  };
  // In an embedded DSS webapp the scrolling element is not always the same
  // element exposed by window.scrollY, so retain both representations.
  add(document.scrollingElement);
  let node = root.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if (/(auto|scroll|overlay)/.test(overflow)) add(node);
    node = node.parentElement;
  }
  return positions;
}
export function restoreScrollPositions(positions) {
  positions.forEach(({ node, top, left }) => {
    if (node === window) window.scrollTo({ top, left, behavior: 'auto' });
    else { node.scrollTop = top; node.scrollLeft = left; }
  });
}
