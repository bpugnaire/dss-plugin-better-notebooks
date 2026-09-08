/** A provider-neutral request payload; execution remains intentionally outside this module. */
export function buildCellAssistanceContext(notebookName, cell, error = '') {
  return { scope: 'cell', notebookName, language: cell.type, source: cell.source, error };
}
