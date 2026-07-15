\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS vector;
GRANT CONNECT ON DATABASE semantic_qa_index TO semantic_qa_indexer;
GRANT CREATE ON DATABASE semantic_qa_index TO semantic_qa_indexer;

SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
