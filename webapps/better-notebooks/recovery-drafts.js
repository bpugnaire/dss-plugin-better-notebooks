/** Browser recovery drafts and deterministic notebook comparison. */
export function saveDraft(storage, key, cells) {
  storage.setItem(key, JSON.stringify({ savedAt: Date.now(), cells }));
}
export function loadDraft(storage, key) {
  try { const draft = JSON.parse(storage.getItem(key) || 'null'); return Array.isArray(draft?.cells) ? draft : null; }
  catch { return null; }
}
export function removeDraft(storage, key) { storage.removeItem(key); }
export function compareCells(draftCells = [], dssCells = []) {
  const max = Math.max(draftCells.length, dssCells.length); const changes = [];
  for (let index = 0; index < max; index += 1) {
    const draft = draftCells[index]; const dss = dssCells[index];
    if (!draft) changes.push({ index, kind: 'added-in-dss', summary: `Cell ${index + 1} exists only in DSS` });
    else if (!dss) changes.push({ index, kind: 'local-only', summary: `Cell ${index + 1} exists only in the recovery draft` });
    else if (draft.type !== dss.type || draft.source !== dss.source) changes.push({ index, kind: 'changed', summary: `Cell ${index + 1} differs`, draft, dss });
  }
  return changes;
}
