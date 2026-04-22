function buildRunAuditReport(report) {
  const anomalies = report?.anomalies || [];
  const summary = report?.summary || {};
  const validation = report?.validation || {};
  const confidenceScore = Math.max(0, 100
    - (Number(summary.tablesErrored || 0) * 25)
    - (Number(summary.tablesPartial || 0) * 10)
    - (Number(validation.rowCountMismatches || 0) * 15)
    - (Number(summary.totalErrors || 0) * 2)
    - (Number(validation.aggregateMismatches || 0) * 10)
    - (Number(validation.keyCoverageMismatches || 0) * 10));

  const trustLevel = confidenceScore >= 90 ? 'verified' : confidenceScore >= 70 ? 'verified_with_warnings' : 'needs_manual_review';

  return {
    generatedAt: new Date().toISOString(),
    runId: report?.runId,
    status: report?.status,
    confidenceScore,
    trustLevel,
    summary,
    validation,
    anomalyCount: anomalies.length,
    anomalies,
    recommendations: [
      anomalies.length ? 'Review anomaly list before cutover.' : 'No major anomalies were detected in current report.',
      validation.rowCountMismatches ? 'Investigate row-count mismatches.' : 'Row-count reconciliation did not detect mismatches.',
      validation.aggregateMismatches ? 'Investigate aggregate mismatches for key numeric columns.' : 'Aggregate reconciliation did not detect mismatches.',
      validation.keyCoverageMismatches ? 'Investigate primary-key or unique-key coverage mismatches.' : 'Key coverage checks did not detect mismatches.',
      summary.tablesErrored ? 'Resolve errored tables before production cutover.' : 'No errored tables recorded.',
    ],
  };
}

function buildCutoverReadinessReport({ verification, runReport, project }) {
  const blockerCount = verification?.report?.summary?.blockerCount || 0;
  const warningCount = verification?.report?.summary?.warningCount || 0;
  const rowCountMismatches = runReport?.validation?.rowCountMismatches || 0;
  const aggregateMismatches = runReport?.validation?.aggregateMismatches || 0;
  const keyCoverageMismatches = runReport?.validation?.keyCoverageMismatches || 0;
  const replayableErrors = runReport?.summary?.replayableErrors || 0;
  const consistencyMode = runReport?.summary?.consistencyMode || runReport?.executionProfile?.consistencyMode || 'best-effort';
  const cdcMode = runReport?.summary?.cdcMode || runReport?.executionProfile?.cdcMode || 'off';
  const pendingSchemaActions = verification?.pendingSchemaActions?.length || 0;

  const readiness = blockerCount > 0 || rowCountMismatches > 0 || aggregateMismatches > 0 || keyCoverageMismatches > 0
    ? 'not_ready'
    : (warningCount > 0 || replayableErrors > 0 || pendingSchemaActions > 0 ? 'ready_with_exceptions' : 'ready');

  return {
    generatedAt: new Date().toISOString(),
    projectId: project?.id || null,
    runId: runReport?.runId || null,
    readiness,
    consistencyMode,
    cdcMode,
    pendingSchemaActions,
    blockerCount,
    warningCount,
    replayableErrors,
    mismatches: {
      rowCountMismatches,
      aggregateMismatches,
      keyCoverageMismatches,
    },
    recommendations: [
      readiness === 'ready' ? 'Cutover checks look healthy based on current verification/report inputs.' : 'Do not cut over until blockers and mismatches are reviewed.',
      consistencyMode === 'table-snapshot' ? 'Consistent table-scoped reads were used.' : 'Run used best-effort consistency; validate source churn risk before cutover.',
      cdcMode === 'watermark' ? 'Incremental watermark mode is active; verify lag and unsupported delete/update semantics manually.' : 'Full/in-place execution mode was used.',
    ],
  };
}

module.exports = { buildRunAuditReport, buildCutoverReadinessReport };