import { python } from '@codemirror/lang-python';

const parser = python().language.parser;
const docs = {
  len: 'len(object) → number of items',
  print: 'print(*objects) → writes a text representation',
  range: 'range(start, stop, step) → integer sequence',
  sorted: 'sorted(iterable) → new sorted list',
  dataiku: 'Dataiku Python API module',
  'dataiku.Dataset': 'dataiku.Dataset(name) → handle to a DSS project dataset',
  'dataiku.Dataset.get_dataframe': 'get_dataframe(...) → pandas.DataFrame loaded from the DSS dataset',
  'pandas.DataFrame': 'pandas.DataFrame(data) → labeled two-dimensional tabular data',
  'pandas.DataFrame.head': 'head(n=5) → first n rows of a DataFrame or Series',
  'pandas.DataFrame.describe': 'describe(...) → descriptive statistics for a DataFrame or Series',
  'pandas.DataFrame.groupby': 'groupby(by, ...) → groups a DataFrame for aggregation',
  'pandas.DataFrame.merge': 'merge(right, ...) → joins two DataFrames',
  'pandas.read_csv': 'pandas.read_csv(path, ...) → DataFrame loaded from CSV data',
};
const returnTypes = {
  'pandas.DataFrame': 'pandas.DataFrame',
  'pandas.read_csv': 'pandas.DataFrame',
  'dataiku.Dataset': 'dataiku.Dataset',
  'dataiku.Dataset.get_dataframe': 'pandas.DataFrame',
};

function docstring(node, source) {
  const statement = node.getChild('Body')?.firstChild?.nextSibling;
  if (statement?.name !== 'ExpressionStatement') return '';
  const literal = statement.getChild('String');
  if (!literal) return '';
  const match = source.slice(literal.from, literal.to).match(/^[rRuU]?("""|'''|"|')([\s\S]*)\1$/);
  return match ? match[2].replace(/\\n/g, '\n').replace(/\s+/g, ' ').trim().slice(0, 700) : '';
}

function collect(source, bindings) {
  const text = node => source.slice(node.from, node.to);
  const resolve = name => {
    const [root, ...members] = name.split('.');
    const binding = bindings.get(root);
    return [binding?.target || binding?.type || root, ...members].join('.');
  };
  for (let node = parser.parse(source).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === 'ImportStatement') {
      const statement = text(node).replace(/\\\n/g, ' ').replace(/[()\n]/g, ' ');
      const from = statement.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
      const imports = from ? from[2] : statement.replace(/^import\s+/, '');
      for (const part of imports.split(',')) {
        const match = part.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
        if (!match) continue;
        const target = from ? `${from[1]}.${match[1]}` : match[1];
        const name = match[2] || (from ? match[1] : match[1].split('.')[0]);
        bindings.set(name, { target: !from && !match[2] ? name : target, detail: `${target}\nImported in this notebook` });
      }
    } else if (node.name === 'FunctionDefinition' || node.name === 'ClassDefinition') {
      const identifier = node.getChild('VariableName');
      if (!identifier) continue;
      const name = text(identifier);
      const parameters = node.getChild('ParamList') || node.getChild('ArgList');
      const annotation = node.getChild('TypeDef');
      const signature = `${name}${parameters ? text(parameters).replace(/\s+/g, ' ') : ''}${annotation ? ` → ${text(annotation)}` : ''}`;
      bindings.set(name, { detail: [signature, docstring(node, source) || 'Defined in this notebook'].join('\n\n') });
    } else if (node.name === 'AssignStatement') {
      const identifier = node.firstChild;
      if (identifier?.name !== 'VariableName') continue;
      const name = text(identifier);
      const call = node.getChild('CallExpression');
      const annotation = node.getChild('TypeDef');
      const type = annotation ? resolve(text(annotation).replace(/^:\s*/, '')) : call ? returnTypes[resolve(text(call.firstChild))] : null;
      bindings.set(name, { type, detail: `${name}${type ? ` · ${type}` : ''}\nDefined in this notebook` });
    }
  }
}

/** Inspect source only. No imports, evaluation, or kernel startup. */
export function pythonSourceHelp(code, pos, precedingSources = []) {
  const node = parser.parse(code).resolveInner(Math.max(0, pos - 1), -1);
  if (!['VariableName', 'PropertyName'].includes(node.name)) return '';
  const expression = node.parent?.name === 'MemberExpression' && node.parent.to === node.to ? node.parent : node;
  const name = code.slice(expression.from, expression.to);
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) return '';
  const bindings = new Map();
  for (const source of [...precedingSources, code]) collect(source, bindings);
  const [root, ...members] = name.split('.');
  const binding = bindings.get(root);
  const qualified = [binding?.target || binding?.type || root, ...members].join('.');
  if ((!binding || binding.target || binding.type) && docs[qualified]) return docs[qualified];
  if (!members.length) return binding?.detail || '';
  return binding?.target ? `${qualified}\nReferenced through an import in this notebook` : '';
}
