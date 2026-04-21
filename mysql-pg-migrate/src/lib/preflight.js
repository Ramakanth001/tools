function classifyTypeCompatibility(sourceColumn, targetColumn) {
  const sourceType = String(sourceColumn?.dataType || sourceColumn?.fullType || '').toLowerCase();
  const targetType = String(targetColumn?.dataType || targetColumn?.fullType || '').toLowerCase();
  if (!targetType) return { status: 'blocker', message: 'missing_target_column' };
  if (sourceType === targetType) return { status: 'compatible', message: 'exact_type' };
  if (/tinyint\(1\)|boolean/.test(sourceType) && /bool/.test(targetType)) {
    return { status: 'compatible_with_transform', message: 'boolean_normalization' };
  }
  if (/json/.test(sourceType) && /json/.test(targetType)) {
    return { status: 'compatible_with_transform', message: 'json_validation' };
  }
  if (/int|decimal|numeric|float|double/.test(sourceType) && /int|decimal|numeric|float|double/.test(targetType)) {
    return { status: 'risky', message: 'numeric_cast' };
  }
  if (/char|text|enum|set/.test(sourceType) && /char|text|json/.test(targetType)) {
    return { status: 'compatible_with_transform', message: 'string_cast' };
  }
  if (/date|time|timestamp|datetime/.test(sourceType) && /date|time|timestamp/.test(targetType)) {
    return { status: 'compatible_with_transform', message: 'temporal_parse' };
  }
  return { status: 'incompatible', message: `source ${sourceType} -> target ${targetType}` };
}

function collectTargetRequirements(table) {
  return (table.columns || []).filter((column) => !column.nullable && !column.defaultValue && !column.generated && !column.identity);
}

async function analyzePreflight({ project, sampleSourceRows }) {
  const sourceTables = new Map((project.sourceCatalog.tables || []).map((table) => [table.name, table]));
  const targetTables = new Map((project.targetCatalog.tables || []).map((table) => [table.name, table]));
  const tableReports = [];
  const blockers = [];
  const warnings = [];

  for (const mapping of project.tableMappings || []) {
    const sourceTable = sourceTables.get(mapping.sourceTable);
    const targetTable = mapping.targetTable ? targetTables.get(mapping.targetTable) : null;
    const tableBlockers = [];
    const tableWarnings = [];
    if (!targetTable) tableBlockers.push({ kind: 'missing_target_table', table: mapping.sourceTable, target: mapping.targetTable || null });

    const targetColumns = new Map((targetTable?.columns || []).map((column) => [column.name, column]));
    const mappedTargetColumns = new Set();
    const columnReports = [];
    for (const columnMapping of mapping.columnMappings || []) {
      const sourceColumn = (sourceTable?.columns || []).find((column) => column.name === columnMapping.sourceColumn);
      const targetColumn = columnMapping.targetColumn ? targetColumns.get(columnMapping.targetColumn) : null;
      if (!sourceColumn) {
        tableBlockers.push({ kind: 'missing_source_column', column: columnMapping.sourceColumn });
        continue;
      }
      if (!targetColumn) {
        tableBlockers.push({ kind: 'missing_target_column', column: columnMapping.targetColumn, sourceColumn: sourceColumn.name });
        continue;
      }
      mappedTargetColumns.add(targetColumn.name);
      const compatibility = classifyTypeCompatibility(sourceColumn, targetColumn);
      columnReports.push({
        sourceColumn: sourceColumn.name,
        targetColumn: targetColumn.name,
        compatibility,
      });
      if (compatibility.status === 'incompatible') tableBlockers.push({ kind: 'incompatible_type', sourceColumn: sourceColumn.name, targetColumn: targetColumn.name, message: compatibility.message });
      if (compatibility.status === 'risky') tableWarnings.push({ kind: 'risky_cast', sourceColumn: sourceColumn.name, targetColumn: targetColumn.name, message: compatibility.message });
      if (compatibility.status === 'compatible_with_transform') tableWarnings.push({ kind: 'transform_required', sourceColumn: sourceColumn.name, targetColumn: targetColumn.name, message: compatibility.message });
      if (sourceColumn.booleanish) {
        const sampleRows = await sampleSourceRows(mapping.sourceTable, 10);
        const invalidBooleanValues = sampleRows
          .map((row) => row[sourceColumn.name] ?? row.__raw)
          .filter((value) => value != null && !['0', '1', 0, 1, true, false, 'true', 'false'].includes(value));
        if (invalidBooleanValues.length) {
          tableWarnings.push({ kind: 'unexpected_boolean_values', sourceColumn: sourceColumn.name, samples: invalidBooleanValues.slice(0, 3) });
        }
      }
    }

    for (const requiredColumn of collectTargetRequirements(targetTable || { columns: [] })) {
      if (!mappedTargetColumns.has(requiredColumn.name)) {
        tableBlockers.push({ kind: 'unmapped_required_target_column', targetColumn: requiredColumn.name });
      }
    }

    tableReports.push({
      tableMappingId: mapping.id,
      sourceTable: mapping.sourceTable,
      targetTable: mapping.targetTable,
      blockers: tableBlockers,
      warnings: tableWarnings,
      columns: columnReports,
    });
    blockers.push(...tableBlockers);
    warnings.push(...tableWarnings);
  }

  return {
    generatedAt: new Date().toISOString(),
    blockers,
    warnings,
    tables: tableReports,
    summary: {
      blockerCount: blockers.length,
      warningCount: warnings.length,
      tableCount: tableReports.length,
    },
  };
}

async function buildDryRunPreview({ project, sampleSourceRows }) {
  const previews = [];
  for (const mapping of project.tableMappings || []) {
    const rows = await sampleSourceRows(mapping.sourceTable, 5);
    previews.push({
      sourceTable: mapping.sourceTable,
      targetTable: mapping.targetTable,
      columnMappings: mapping.columnMappings || [],
      sampleRows: rows,
      transformedRows: rows.map((row) => {
        const out = {};
        for (const col of mapping.columnMappings || []) {
          if (!col.targetColumn) continue;
          const value = row[col.sourceColumn] ?? row.__raw ?? null;
          out[col.targetColumn] = value;
        }
        return out;
      }),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    tables: previews,
  };
}

async function validateRunReport({ run, persistence }) {
  const checkpoints = await persistence.listCheckpoints(run.id);
  const errors = await persistence.listErrors(run.id);
  return {
    runId: run.id,
    status: run.status,
    counters: run.counters || {},
    checkpoints,
    errors,
    validation: {
      success: run.status === 'done' && !errors.length,
      partialSuccess: errors.length > 0 && (run.counters?.rowsInserted || 0) > 0,
      warnings: (run.warnings || []).length,
    },
  };
}

module.exports = { classifyTypeCompatibility, analyzePreflight, buildDryRunPreview, validateRunReport };