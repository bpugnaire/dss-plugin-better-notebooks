export function linkedDatasets(cells, datasets) {
  const source = cells.map(cell => cell.source || '').join('\n');
  return datasets.filter(dataset => source.includes(`"${dataset.name}"`) || source.includes(`'${dataset.name}'`) || new RegExp(`\\b${dataset.name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(source));
}

export function datasetVariableName(name) { return name.replace(/\W/g, '_'); }
