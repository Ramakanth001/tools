function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function singularize(name) {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('ses')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

function tokenSimilarity(a, b) {
  const setA = new Set(normalizeName(a).split('_').filter(Boolean));
  const setB = new Set(normalizeName(b).split('_').filter(Boolean));
  if (!setA.size && !setB.size) return 0;
  let overlap = 0;
  for (const token of setA) if (setB.has(token)) overlap += 1;
  return overlap / Math.max(setA.size, setB.size, 1);
}

function scoreTableMatch(source, target) {
  const sourceNorm = normalizeName(source.name);
  const targetNorm = normalizeName(target.name);
  const sourceSingular = singularize(sourceNorm);
  const targetSingular = singularize(targetNorm);
  const reasons = [];
  let score = 0;
  if (sourceNorm === targetNorm) {
    score += 1;
    reasons.push('exact_name');
  }
  if (sourceSingular === targetSingular) {
    score += 0.92;
    reasons.push('singular_plural_match');
  }
  const tokenScore = tokenSimilarity(source.name, target.name);
  score += tokenScore * 0.6;
  if (tokenScore > 0.5) reasons.push('token_similarity');
  if (source.kind === target.kind) score += 0.05;
  return { score: Number(score.toFixed(3)), reasons };
}

function canonicalColumnAliases(name) {
  const norm = normalizeName(name);
  const variants = new Set([norm]);
  if (norm.endsWith('_id')) variants.add('id');
  if (norm === 'createdat') variants.add('created_at');
  if (norm === 'updatedat') variants.add('updated_at');
  if (norm === 'deletedat') variants.add('deleted_at');
  return variants;
}

function scoreColumnMatch(sourceColumn, targetColumn) {
  const sourceNorm = normalizeName(sourceColumn.name);
  const targetNorm = normalizeName(targetColumn.name);
  let score = 0;
  const reasons = [];
  if (sourceNorm === targetNorm) {
    score += 1;
    reasons.push('exact_name');
  }
  const sourceAliases = canonicalColumnAliases(sourceColumn.name);
  const targetAliases = canonicalColumnAliases(targetColumn.name);
  const aliasOverlap = Array.from(sourceAliases).filter((value) => targetAliases.has(value));
  if (aliasOverlap.length) {
    score += 0.7;
    reasons.push('alias_match');
  }
  if (String(sourceColumn.dataType || '').toLowerCase() === String(targetColumn.dataType || '').toLowerCase()) {
    score += 0.25;
    reasons.push('same_type');
  }
  if (sourceColumn.booleanish && /bool/i.test(targetColumn.fullType || targetColumn.dataType || '')) {
    score += 0.25;
    reasons.push('booleanish');
  }
  score += tokenSimilarity(sourceColumn.name, targetColumn.name) * 0.35;
  return { score: Number(score.toFixed(3)), reasons };
}

function buildColumnMappings(sourceTable, targetTable) {
  const targetColumns = targetTable?.columns || [];
  return (sourceTable.columns || []).map((sourceColumn, index) => {
    let best = null;
    for (const targetColumn of targetColumns) {
      const candidate = scoreColumnMatch(sourceColumn, targetColumn);
      if (!best || candidate.score > best.score) {
        best = { targetColumn, candidate };
      }
    }
    return {
      id: `${sourceTable.name}:${sourceColumn.name}:${index}`,
      sourceColumn: sourceColumn.name,
      targetColumn: best && best.candidate.score >= 0.4 ? best.targetColumn.name : null,
      confidence: best ? best.candidate.score : 0,
      rationale: best ? best.candidate.reasons : [],
      transform: { type: 'direct', config: {} },
      enabled: true,
    };
  });
}

function inferConflictKeys(sourceTable, targetTable, columnMappings) {
  const mappedPairs = new Map((columnMappings || []).filter((item) => item.targetColumn).map((item) => [item.sourceColumn, item.targetColumn]));
  const sourcePrimaryKey = sourceTable?.primaryKey || [];
  const mappedPrimaryKey = sourcePrimaryKey.map((column) => mappedPairs.get(column)).filter(Boolean);
  if (mappedPrimaryKey.length === sourcePrimaryKey.length && mappedPrimaryKey.length) return mappedPrimaryKey;

  const targetPrimaryKey = targetTable?.primaryKey || [];
  if (targetPrimaryKey.length) {
    const sourceColumnsByTarget = new Map((columnMappings || []).filter((item) => item.targetColumn).map((item) => [item.targetColumn, item.sourceColumn]));
    const covered = targetPrimaryKey.every((column) => sourceColumnsByTarget.has(column));
    if (covered) return [...targetPrimaryKey];
  }

  for (const key of targetTable?.uniqueKeys || []) {
    const sourceColumnsByTarget = new Map((columnMappings || []).filter((item) => item.targetColumn).map((item) => [item.targetColumn, item.sourceColumn]));
    const covered = (key.columns || []).every((column) => sourceColumnsByTarget.has(column));
    if (covered && key.columns?.length) return [...key.columns];
  }

  return [];
}

function buildAutoMapping({ sourceCatalog, targetCatalog }) {
  const targetTables = targetCatalog.tables || [];
  const tableMappings = (sourceCatalog.tables || []).map((sourceTable, index) => {
    let best = null;
    for (const targetTable of targetTables) {
      const candidate = scoreTableMatch(sourceTable, targetTable);
      if (!best || candidate.score > best.score) {
        best = { targetTable, candidate };
      }
    }
    const selectedTarget = best && best.candidate.score >= 0.45 ? best.targetTable : null;
    const columnMappings = selectedTarget ? buildColumnMappings(sourceTable, selectedTarget) : [];
    const inferredConflictKeys = selectedTarget ? inferConflictKeys(sourceTable, selectedTarget, columnMappings) : [];
    return {
      id: `${sourceTable.name}:${index}`,
      sourceTable: sourceTable.name,
      targetTable: selectedTarget ? selectedTarget.name : null,
      confidence: best ? best.candidate.score : 0,
      rationale: best ? best.candidate.reasons : [],
      enabled: true,
      conflictStrategy: 'insert',
      conflictKeys: inferredConflictKeys,
      chunkSize: 500,
      writeMode: 'append',
      order: index,
      columnMappings,
    };
  });
  const matched = tableMappings.filter((mapping) => mapping.targetTable).length;
  return {
    tableMappings,
    summary: {
      sourceTables: (sourceCatalog.tables || []).length,
      targetTables: (targetCatalog.tables || []).length,
      matchedTables: matched,
      unmatchedTables: (sourceCatalog.tables || []).length - matched,
    },
  };
}

module.exports = { normalizeName, singularize, buildAutoMapping, scoreTableMatch, scoreColumnMatch, inferConflictKeys };