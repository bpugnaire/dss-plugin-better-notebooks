/** One debounce and one writer per notebook. Generations protect newer edits. */
export function canonicalDocument(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalDocument).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalDocument(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export class SaveCoordinator {
  constructor({ snapshot, write, read, onState = () => {}, onSaved = () => {}, clock = globalThis, delay = 650 }) {
    Object.assign(this, { snapshot, write, read, onState, onSaved, clock, delay });
    this.entries = new Map();
  }
  entry(notebook) {
    if (!this.entries.has(notebook)) this.entries.set(notebook, { generation: 0, saved: 0, timer: null, flight: null, error: null, disposed: false });
    return this.entries.get(notebook);
  }
  dirty(notebook) {
    const e = this.entry(notebook); e.generation += 1;
    this.clock.clearTimeout(e.timer);
    if (e.error || e.disposed) return;
    this.onState(notebook, 'saving');
    e.timer = this.clock.setTimeout(() => { e.timer = null; this.flush(notebook).catch(() => {}); }, this.delay);
  }
  async flush(notebook, { retry = false } = {}) {
    const e = this.entry(notebook);
    this.clock.clearTimeout(e.timer); e.timer = null;
    if (retry && e.error?.status !== 409) e.error = null;
    if (e.error) throw e.error;
    if (e.disposed) throw new Error('Notebook is no longer available.');
    if (e.flight) { await e.flight; return this.flush(notebook); }
    if (e.generation === e.saved) return;
    const generation = e.generation;
    const document = structuredClone(this.snapshot(notebook));
    const expectedRevision = notebook.revision;
    this.onState(notebook, 'saving');
    e.flight = (async () => {
      let result;
      try {
        try { result = await this.write(notebook, document, expectedRevision); }
        catch (error) {
          // An HTTP error is definitive. Only an ambiguous transport failure
          // can mean that the server saved successfully but its reply was lost.
          if (error.status) throw error;
          const current = await this.read(notebook).catch(() => null);
          if (!current || canonicalDocument(current.notebook) !== canonicalDocument(document)) throw error;
          result = current;
        }
        if (e.disposed) return;
        notebook.revision = result.revision;
        e.saved = generation;
        // Keep local cells and their sources authoritative until every edit is acknowledged.
        if (e.generation === generation) {
          notebook.dssContent = result.notebook;
          this.onSaved(notebook);
          this.onState(notebook, 'saved');
        }
      } catch (error) {
        if (!e.disposed) { e.error = error; this.onState(notebook, error.status === 409 ? 'conflict' : 'error', error); }
        throw error;
      } finally { e.flight = null; }
    })();
    await e.flight;
    if (!e.disposed && e.generation !== e.saved) await this.flush(notebook);
  }
  unresolved(notebook) { const e = this.entry(notebook); return Boolean(e.error || e.flight || e.generation !== e.saved); }
  reset(notebook) { const e = this.entry(notebook); this.clock.clearTimeout(e.timer); e.saved = e.generation; e.error = null; }
  dispose(notebook) { const e = this.entry(notebook); this.clock.clearTimeout(e.timer); e.disposed = true; }
}
