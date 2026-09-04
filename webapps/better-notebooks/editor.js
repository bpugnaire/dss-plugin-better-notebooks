import { EditorState } from '@codemirror/state';
import { EditorView, keymap, hoverTooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { acceptCompletion, autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion } from '@codemirror/autocomplete';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { linter, setDiagnostics } from '@codemirror/lint';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { markdown } from '@codemirror/lang-markdown';

const editors = new Map();
const notebookLightTheme = EditorView.theme({
  '&': { backgroundColor: '#ffffff', color: '#2d2932' },
  '.cm-content': { caretColor: '#5d42c6' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#5d42c6' },
  '.cm-gutters': { backgroundColor: '#ffffff', color: '#aaa3b0', border: 'none' },
  '.cm-activeLine': { backgroundColor: '#faf8ff' },
  '.cm-activeLineGutter': { backgroundColor: '#f5f1ff' },
  '.cm-selectionBackground, ::selection': { backgroundColor: '#dfd6ff !important' },
}, { dark: false });

const PYTHON_WORDS = [
  'abs', 'all', 'any', 'bool', 'dict', 'enumerate', 'filter', 'float', 'int', 'len', 'list', 'map', 'max', 'min',
  'print', 'range', 'set', 'sorted', 'str', 'sum', 'tuple', 'zip', 'dataiku', 'pandas', 'pd', 'True', 'False', 'None',
].map(label => ({ label, type: 'keyword' }));
const SQL_WORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'COUNT', 'AVG', 'SUM',
].map(label => ({ label, type: 'keyword' }));
const PYTHON_HOVERS = {
  len: 'len(object) → number of items',
  print: 'print(*objects) → writes a text representation',
  range: 'range(start, stop, step) → integer sequence',
  sorted: 'sorted(iterable) → new sorted list',
  dataiku: 'Dataiku Python API module',
  Dataset: 'dataiku.Dataset(name) → handle to a DSS project dataset',
  get_dataframe: 'get_dataframe(...) → pandas.DataFrame loaded from the DSS dataset',
  DataFrame: 'pandas.DataFrame(data) → labeled two-dimensional tabular data',
  head: 'head(n=5) → first n rows of a DataFrame or Series',
  describe: 'describe(...) → descriptive statistics for a DataFrame or Series',
  groupby: 'groupby(by, ...) → groups a DataFrame for aggregation',
  merge: 'merge(right, ...) → joins two DataFrames',
  read_csv: 'pandas.read_csv(path, ...) → DataFrame loaded from CSV data',
};

function completeWithTab(view) {
  if (acceptCompletion(view)) return true;
  const cursor = view.state.selection.main.head;
  const token = view.state.sliceDoc(Math.max(0, cursor - 1), cursor);
  return /[\w.]/.test(token) ? startCompletion(view) : false;
}

function completionSource(type, datasets, symbols = [], connections = []) {
  return context => {
    const word = context.matchBefore(/[\w.]*/);
    if (!context.explicit && (!word || word.from === word.to)) return null;
    const datasetOptions = datasets.flatMap(dataset => [
      { label: dataset.name, type: 'variable', detail: 'Project dataset' },
      ...(dataset.columns || []).map(column => ({ label: column.name, type: 'property', detail: `${dataset.name} · ${column.type || 'column'}` })),
    ]);
    const liveSymbols = typeof symbols === 'function' ? symbols() : symbols;
    const symbolOptions = liveSymbols.map(symbol => ({ label: symbol.name, type: symbol.kind === 'function' ? 'function' : 'variable', detail: symbol.detail || 'Defined above' }));
    const connectionOptions = connections.map(connection => ({ label: connection.name, type: 'namespace', detail: `${connection.type || 'SQL'} connection` }));
    const options = type === 'sql'
      ? [...SQL_WORDS, ...datasetOptions, ...connectionOptions]
      : [...PYTHON_WORDS, ...symbolOptions, ...datasetOptions];
    return { from: word ? word.from : context.pos, options, validFor: /[\w.]*/ };
  };
}

function hoverFor(datasets, symbols = [], connections = [], onInspect = null) {
  return hoverTooltip(async (view, pos) => {
    const word = view.state.wordAt(pos);
    if (!word) return null;
    const name = view.state.sliceDoc(word.from, word.to);
    const dataset = datasets.find(item => item.name === name);
    const column = datasets.flatMap(item => (item.columns || []).map(value => ({ dataset: item, column: value }))).find(item => item.column.name === name);
    const pythonDoc = PYTHON_HOVERS[name];
    const liveSymbols = typeof symbols === 'function' ? symbols() : symbols;
    const symbol = liveSymbols.find(item => item.name === name);
    const connection = connections.find(item => item.name === name);
    // A running Jupyter kernel can return the actual runtime docstring and
    // signature (the same notebook inspection protocol used by Jupyter UIs).
    const inspected = onInspect ? await onInspect({ code: view.state.doc.toString(), pos: word.to }) : '';
    if (!dataset && !column && !pythonDoc && !symbol && !connection && !inspected) return null;
    return {
      pos: word.from, end: word.to, above: true,
      create() {
        const dom = document.createElement('div'); dom.className = 'cm-project-hover';
        if (inspected) {
          const title = document.createElement('strong'); title.textContent = name; dom.append(title);
          const detail = document.createElement('span'); detail.textContent = inspected.slice(0, 1800); dom.append(detail);
        } else if (dataset) {
          const title = document.createElement('strong'); title.textContent = dataset.name; dom.append(title);
          const detail = document.createElement('span'); detail.textContent = `${dataset.type || 'Dataset'} · ${(dataset.columns || []).length} columns`; dom.append(detail);
        } else if (column) {
          const title = document.createElement('strong'); title.textContent = column.column.name; dom.append(title);
          const detail = document.createElement('span'); detail.textContent = `${column.dataset.name} · ${column.column.type || 'column'}`; dom.append(detail);
        } else if (symbol) {
          const title = document.createElement('strong'); title.textContent = symbol.name; dom.append(title);
          const detail = document.createElement('span'); detail.textContent = symbol.detail || 'Defined in a previous cell'; dom.append(detail);
        } else if (connection) {
          const title = document.createElement('strong'); title.textContent = connection.name; dom.append(title);
          const detail = document.createElement('span'); detail.textContent = `${connection.type || 'SQL'} connection`; dom.append(detail);
        } else {
          const title = document.createElement('strong'); title.textContent = name; dom.append(title);
          const detail = document.createElement('span'); detail.textContent = pythonDoc; dom.append(detail);
        }
        return { dom };
      },
    };
  }, { hoverTime: 150 });
}

function languageFor(type) {
  if (type === 'sql') return sql();
  if (type === 'markdown') return markdown();
  return python();
}

export function mount({ id, parent, source, type, datasets, symbols = [], connections = [], onChange, onRun, onRunAndAdvance, onInspect = null }) {
  const language = languageFor(type);
  const view = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [
        history(), language, notebookLightTheme, syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), indentOnInput(), closeBrackets(),
        autocompletion({ override: [completionSource(type, datasets, symbols, connections)], activateOnTyping: true, activateOnTypingDelay: 120 }), hoverFor(datasets, symbols, connections, onInspect),
        linter(() => []),
        keymap.of([
          { key: 'Ctrl-Space', run: startCompletion },
          { key: 'Alt-/', run: startCompletion },
          { key: 'Tab', run: completeWithTab },
          { key: 'Shift-Enter', run: () => { onRunAndAdvance(); return true; } },
          { key: 'Mod-Enter', run: () => { onRun(); return true; } },
          indentWithTab, ...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap,
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
    parent,
  });
  editors.set(id, view);
  return view;
}

export function setDiagnostic(id, diagnostic) {
  const view = editors.get(id); if (!view) return;
  // Do not dispatch an empty lint update. With the bundled editor this is not
  // needed to clear a new editor and, on DSS's browser runtime, dispatching it
  // can abort the entire render loop after the first native notebook cell.
  if (!diagnostic) return;
  const line = Math.min(Math.max(diagnostic.line || 1, 1), view.state.doc.lines);
  const from = Math.min(view.state.doc.line(line).from + Math.max((diagnostic.column || 1) - 1, 0), view.state.doc.length);
  const diagnostics = [{ from, to: Math.min(from + 1, view.state.doc.length), severity: 'error', message: diagnostic.message || 'Syntax error' }];
  view.dispatch({ effects: setDiagnostics(view.state, diagnostics) });
}

export function focus(id, preventScroll = false) {
  const view = editors.get(id); if (!view) return;
  view.focus();
  if (!preventScroll) view.dom.scrollIntoView({ block: 'nearest' });
}

export function destroyAll() {
  editors.forEach(view => view.destroy());
  editors.clear();
}
