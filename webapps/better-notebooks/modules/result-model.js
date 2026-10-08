export const TABLE_MIME = 'application/vnd.better-notebooks.table.v1+json';
const numeric = column => ['integer', 'number', 'decimal'].includes(column.type);
export function valueText(value) {
  if (value === null) return 'NULL';
  if (value && typeof value === 'object') return value.type === 'tuple' ? value.value.map(valueText).join(' / ') : String(value.value);
  return String(value);
}
export function validTable(value) {
  return value?.version === 1 && Array.isArray(value.columns) && value.columns.length <= 2000
    && value.columns.every(c => typeof c?.id === 'string' && typeof c.label === 'string')
    && new Set(value.columns.map(c => c.id)).size === value.columns.length
    && Number.isSafeInteger(value.totalRows) && value.totalRows >= 0
    && Array.isArray(value.preview?.rows) && value.preview.rows.length <= 100
    && value.preview.rows.every(row => Array.isArray(row) && row.length === value.columns.length)
    && (!value.available || typeof value.resultId === 'string' && typeof value.generation === 'string');
}
export function validSettings(settings) {
  return settings?.version === 1 && ['table', 'chart', 'profile'].includes(settings.tab) && [50, 100, 500].includes(settings.pageSize)
    && Array.isArray(settings.schema) && settings.schema.every(c => typeof c?.id === 'string' && typeof c.label === 'string')
    && Array.isArray(settings.filters) && settings.filters.every(f => typeof f?.column === 'string' && typeof f.op === 'string')
    && Array.isArray(settings.sorts) && settings.sorts.every(s => typeof s?.column === 'string' && ['asc', 'desc'].includes(s.direction))
    && Array.isArray(settings.hidden) && settings.hidden.every(id => typeof id === 'string')
    && ['bar', 'line', 'scatter', 'histogram'].includes(settings.chart?.kind)
    && ['count', 'sum', 'mean', 'min', 'max'].includes(settings.chart?.aggregate);
}
export function initialSettings(table) {
  const x = table.columns[0]?.id || '';
  return { version: 1, schema: table.columns.map(c => ({ id: c.id, label: c.label, type: c.type })), tab: 'table', pageSize: 100,
    filters: [], sorts: [], hidden: [], chart: { kind: 'bar', x, y: table.columns.find(numeric)?.id || '', series: '', aggregate: 'count', title: '' } };
}
export function compatibleSettings(settings, table) {
  if (!validSettings(settings)) return false;
  const referenced = new Set([...settings.filters.map(f => f.column), ...settings.sorts.map(s => s.column), ...settings.hidden,
    ...['x', 'y', 'series'].map(key => settings.chart?.[key]).filter(Boolean)]);
  return [...referenced].every(id => {
    const old = settings.schema.find(c => c.id === id), current = table.columns.find(c => c.id === id);
    return old && current && old.label === current.label && old.type === current.type;
  });
}
