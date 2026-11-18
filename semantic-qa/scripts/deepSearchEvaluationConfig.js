const { indexConnection: universalIndexConnection } = require('./universalV5Config');

function evaluationIndexConnection(environment = process.env) {
  return {
    ...universalIndexConnection,
    connectionString: environment.SEMANTIC_QA_EVAL_PG_URL || '',
    host: environment.SEMANTIC_QA_EVAL_PG_HOST || universalIndexConnection.host,
    port: Number(environment.SEMANTIC_QA_EVAL_PG_PORT || universalIndexConnection.port),
    user: environment.SEMANTIC_QA_EVAL_PG_USER || universalIndexConnection.user,
    password: environment.SEMANTIC_QA_EVAL_PG_PASSWORD || universalIndexConnection.password,
    database: environment.SEMANTIC_QA_EVAL_PG_DATABASE || 'universal_qa_v2',
    sslMode: environment.SEMANTIC_QA_EVAL_PG_SSL_MODE || universalIndexConnection.sslMode,
  };
}

module.exports = { evaluationIndexConnection };
