const sourceConnection = {
  connectionString: '', host: '127.0.0.1', port: 5433,
  user: 'semantic_qa_reader', password: '', database: 'universal_qa_source', sslMode: 'disable',
};
const indexConnection = {
  connectionString: '', host: '127.0.0.1', port: 5433,
  user: 'semantic_qa_indexer', password: '', database: 'universal_qa_index', sslMode: 'disable',
};
const mapping = {
  schema: 'public',
  table: 'corpus_documents',
  idColumn: 'document_id',
  questionColumn: 'title',
  answerColumn: 'display_text',
  metadataColumns: [
    'source_type', 'original_record_id', 'master_id', 'question_context',
    'raw_content_hash', 'display_text_hash', 'author', 'default_unit_kind',
    'language', 'record_date', 'multimedia_filename', 'answer_unit_count',
    'ambiguous', 'parser_report', 'legacy_aliases',
  ],
  groupColumn: 'source_group',
  orderColumn: '',
};

module.exports = { indexConnection, mapping, sourceConnection };
