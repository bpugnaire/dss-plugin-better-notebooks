export function captureScrollPositions(root) {
  const positions = [{ node: window, top: window.scrollY, left: window.scrollX }]; let node = root.parentElement;
  while (node) { if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) positions.push({ node, top: node.scrollTop, left: node.scrollLeft }); node = node.parentElement; }
  return positions;
}
export function restoreScrollPositions(positions) { positions.forEach(({ node, top, left }) => node === window ? window.scrollTo({ top, left, behavior: 'instant' }) : Object.assign(node, { scrollTop: top, scrollLeft: left })); }
