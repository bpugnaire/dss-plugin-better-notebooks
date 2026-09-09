/** Small, dependency-free notebook state primitives. Kept separate from DOM rendering. */
export function createNotebookState(notebooks) {
  return { notebooks, activeNotebookId: null, notebookListMode: 'all', cells: [], selected: new Set(), clipboard: [], dragId: null, dragIds: [], activeCellId: null, history: [], historyIndex: -1, collapsedHeadings: new Set(), searchQuery: '', searchIndex: 0, nextExecutionOrder: 1 };
}

export function resetHistory(state) { state.history = [JSON.stringify(state.cells)]; state.historyIndex = 0; }

export function recordHistory(state) {
  const snapshot = JSON.stringify(state.cells);
  if (state.history[state.historyIndex] === snapshot) return;
  state.history.splice(state.historyIndex + 1);
  state.history.push(snapshot);
  state.historyIndex = state.history.length - 1;
}

export function restoreHistory(state) {
  if (state.historyIndex <= 0) return false;
  state.historyIndex -= 1;
  state.cells = JSON.parse(state.history[state.historyIndex]);
  state.selected.clear();
  return true;
}
