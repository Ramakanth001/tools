const crypto = require('node:crypto');

const PROJECT_ISSUE_KINDS = new Set(['no_enabled_table_mappings', 'duplicate_source_table_mapping']);
const REVIEWABLE_BLOCKER_KINDS = new Set(['target_not_null_source_nullable', 'compatibility_review_required']);
const HARD_SCHEMA_ACTIONS = new Set(['missing_target_table', 'target_name_conflict']);

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function withoutVolatileFields(value) {
  if (Array.isArray(value)) return value.map(withoutVolatileFields);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (['generatedAt', 'updatedAt', 'allowedAt', 'allowedVerificationIssues'].includes(key)) continue;
    out[key] = withoutVolatileFields(value[key]);
  }
  return out;
}

function projectFingerprint(project = {}, key) {
  return project[key] || stableHash(project[key.replace('Fingerprint', 'Catalog')] || {});
}

function findTableMapping(project = {}, table = {}, issue = {}) {
  return (project.tableMappings || []).find((mapping) => {
    if (table.tableMappingId && mapping.id === table.tableMappingId) return true;
    if (issue.tableMappingId && mapping.id === issue.tableMappingId) return true;
    if (mapping.sourceTable && mapping.sourceTable === (table.sourceTable || issue.sourceTable || issue.table)) return true;
    return false;
  }) || null;
}

function issueTables(issue = {}, table = {}) {
  const sourceTable = issue.sourceTable || table.sourceTable || issue.table || '';
  const targetTable = issue.targetTable || table.targetTable || (issue.target && issue.target !== 'project' ? issue.target : '') || '';
  return { sourceTable, targetTable };
}

function issueColumns(issue = {}) {
  return {
    sourceColumn: issue.sourceColumn || '',
    targetColumn: issue.targetColumn || issue.column || '',
  };
}

function isReviewableBlocker(issue = {}) {
  if (issue.allowability?.allowable === true) return true;
  if (issue.kind === 'target_not_null_source_nullable') return issue.nullCountKnown === false || issue.nullCount == null;
  return REVIEWABLE_BLOCKER_KINDS.has(issue.kind);
}

function nonAllowableReason(issue = {}) {
  if (issue.allowability?.allowable === false && issue.allowability.reason) return issue.allowability.reason;
  if (issue.kind === 'target_not_null_source_nullable' && issue.nullCountKnown && Number(issue.nullCount || 0) > 0) {
    return 'Exact source scan found NULL rows that would violate the target NOT NULL constraint.';
  }
  if (issue.kind === 'type_not_safely_assignable') return 'Target type cannot safely store the mapped source values.';
  if (issue.kind === 'unmapped_required_target_column') return 'Required target columns must be mapped, defaulted, nullable, or removed before loading.';
  if (issue.kind === 'missing_target_table') return 'The target table must exist or be explicitly provisioned before loading.';
  if (issue.kind === 'invalid_conflict_keys' || issue.kind === 'missing_conflict_keys') return 'Write-mode conflict keys must match the target primary key or a unique constraint.';
  return 'This blocker changes load correctness or target structure and must be fixed rather than allowed.';
}

function issueKeyFor({ project, issue, table, severity }) {
  const mapping = findTableMapping(project, table, issue);
  const { sourceTable, targetTable } = issueTables(issue, table);
  const { sourceColumn, targetColumn } = issueColumns(issue);
  return stableHash({
    kind: issue.kind || severity,
    severity,
    sourceTable,
    targetTable,
    sourceColumn,
    targetColumn,
    tableMappingId: mapping?.id || table.tableMappingId || issue.tableMappingId || '',
    mappingFingerprint: mapping ? stableHash(withoutVolatileFields(mapping)) : '',
    sourceFingerprint: projectFingerprint(project, 'sourceFingerprint'),
    targetFingerprint: projectFingerprint(project, 'targetFingerprint'),
  });
}

function normalizeIssue({ project, issue = {}, table = {}, severity }) {
  const { sourceTable, targetTable } = issueTables(issue, table);
  const { sourceColumn, targetColumn } = issueColumns(issue);
  const allowable = severity === 'blocker' && isReviewableBlocker(issue);
  return {
    issueKey: issueKeyFor({ project, issue, table, severity }),
    severity,
    status: severity === 'blocker' ? 'open' : 'warning',
    allowable,
    nonAllowableReason: allowable ? '' : nonAllowableReason(issue),
    kind: issue.kind || severity,
    sourceTable,
    targetTable,
    sourceColumn,
    targetColumn,
    tableMappingId: table.tableMappingId || issue.tableMappingId || '',
    message: issue.message || '',
    nullCountKnown: issue.nullCountKnown ?? null,
    nullCount: issue.nullCount ?? null,
    targetConstraint: issue.targetConstraint || '',
    raw: issue,
  };
}

function collectNormalizedIssues({ project, report }) {
  const items = [];
  for (const issue of report?.blockers || []) {
    if (!PROJECT_ISSUE_KINDS.has(issue.kind) && issue.target !== 'project') continue;
    items.push(normalizeIssue({ project, issue, severity: 'blocker' }));
  }
  for (const issue of report?.warnings || []) {
    if (!PROJECT_ISSUE_KINDS.has(issue.kind) && issue.target !== 'project') continue;
    items.push(normalizeIssue({ project, issue, severity: 'warning' }));
  }
  for (const table of report?.tables || []) {
    for (const issue of table.blockers || []) {
      items.push(normalizeIssue({ project, issue, table, severity: 'blocker' }));
    }
    for (const issue of table.warnings || []) {
      items.push(normalizeIssue({ project, issue, table, severity: 'warning' }));
    }
  }
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.severity}:${item.issueKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyAllowances({ project, issues }) {
  const allowedByKey = new Map((project.allowedVerificationIssues || []).map((item) => [item.issueKey, item]));
  return issues.map((issue) => {
    if (issue.severity !== 'blocker' || !issue.allowable) return issue;
    const allowance = allowedByKey.get(issue.issueKey);
    if (!allowance?.reason) return issue;
    return {
      ...issue,
      status: 'allowed',
      allowance: {
        reason: allowance.reason,
        allowedAt: allowance.allowedAt || null,
      },
    };
  });
}

function summarizeIssues(issues = []) {
  const openBlockers = issues.filter((issue) => issue.severity === 'blocker' && issue.status !== 'allowed');
  const allowedBlockers = issues.filter((issue) => issue.severity === 'blocker' && issue.status === 'allowed');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return {
    rawBlockerCount: openBlockers.length + allowedBlockers.length,
    openBlockerCount: openBlockers.length,
    allowedBlockerCount: allowedBlockers.length,
    nonAllowableBlockerCount: openBlockers.filter((issue) => !issue.allowable).length,
    warningCount: warnings.length,
  };
}

function buildTableReadiness({ report, issues }) {
  return (report?.tables || []).map((table) => {
    const tableIssues = issues.filter((issue) => issue.sourceTable === table.sourceTable || issue.targetTable === table.targetTable);
    const summary = summarizeIssues(tableIssues);
    const readinessLevel = summary.openBlockerCount ? 'blocked' : (summary.allowedBlockerCount || summary.warningCount ? 'review' : table.readiness?.level);
    return {
      sourceTable: table.sourceTable,
      targetTable: table.targetTable,
      readiness: { ...(table.readiness || {}), level: readinessLevel || table.readiness?.level },
      completeness: table.completeness,
      schemaAction: table.schemaAction,
      blockerCount: summary.openBlockerCount,
      openBlockerCount: summary.openBlockerCount,
      allowedBlockerCount: summary.allowedBlockerCount,
      warningCount: summary.warningCount,
    };
  });
}

function hardSchemaIssues(blockingSchemaIssues = []) {
  return (blockingSchemaIssues || []).filter((item) => HARD_SCHEMA_ACTIONS.has(item.action));
}

function buildVerificationFingerprint({ project, report, schemaPlan }) {
  return stableHash(withoutVolatileFields({
    report,
    schemaPlan,
    tableMappings: project.tableMappings || [],
    sourceFingerprint: projectFingerprint(project, 'sourceFingerprint'),
    targetFingerprint: projectFingerprint(project, 'targetFingerprint'),
  }));
}

function buildVerificationPayload({ project, report, schemaPlan, pendingSchemaActions = [], blockingSchemaIssues = [], executionPlan }) {
  const issues = applyAllowances({ project, issues: collectNormalizedIssues({ project, report }) });
  const summary = summarizeIssues(issues);
  const hardBlockingSchemaIssues = hardSchemaIssues(blockingSchemaIssues);
  const readyToLoad = summary.openBlockerCount === 0 && pendingSchemaActions.length === 0 && hardBlockingSchemaIssues.length === 0;
  return {
    report: {
      ...report,
      summary: {
        ...(report.summary || {}),
        blockerCount: summary.openBlockerCount,
        rawBlockerCount: summary.rawBlockerCount,
        openBlockerCount: summary.openBlockerCount,
        allowedBlockerCount: summary.allowedBlockerCount,
        nonAllowableBlockerCount: summary.nonAllowableBlockerCount,
        warningCount: summary.warningCount,
      },
    },
    schemaPlan,
    tableReadiness: buildTableReadiness({ report, issues }),
    pendingSchemaActions,
    blockingSchemaIssues,
    hardBlockingSchemaIssues,
    executionPlan,
    issues,
    openBlockerCount: summary.openBlockerCount,
    allowedBlockerCount: summary.allowedBlockerCount,
    nonAllowableBlockerCount: summary.nonAllowableBlockerCount,
    warningCount: summary.warningCount,
    readyToLoad,
    verificationFingerprint: buildVerificationFingerprint({ project, report, schemaPlan }),
  };
}

module.exports = {
  buildVerificationPayload,
  buildVerificationFingerprint,
};
