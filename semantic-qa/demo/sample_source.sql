\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.qa_records (
  id bigint PRIMARY KEY,
  question text NOT NULL,
  answer text NOT NULL,
  category text NOT NULL,
  source_name text NOT NULL,
  source_order integer NOT NULL
);

INSERT INTO public.qa_records (id, question, answer, category, source_name, source_order) VALUES
  (1, 'What is semantic-qa?', 'semantic-qa is a retrieval-only question-answer search tool. It searches an indexed PostgreSQL Q&A corpus and returns matching stored answers.', 'overview', 'semantic-qa demo guide', 1),
  (2, 'Does semantic-qa generate its own answers?', 'No. Answer text is returned exactly as stored in the source corpus. The tool does not use a chat model to summarize, rewrite, or add interpretation.', 'overview', 'semantic-qa demo guide', 2),
  (3, 'What services does semantic-qa require?', 'The tool requires a source PostgreSQL database, a separate writable PostgreSQL database with pgvector, and a running Ollama embedding service.', 'setup', 'semantic-qa demo guide', 3),
  (4, 'How do I install and start Ollama on macOS?', 'Install Ollama with Homebrew, start the Ollama service, and pull the configured embedding model. The default local endpoint is http://127.0.0.1:11434.', 'setup', 'semantic-qa demo guide', 4),
  (5, 'Which embedding model is used by default?', 'The default embedding model is embeddinggemma. Indexing and searching must use the same embedding model and vector dimension.', 'setup', 'semantic-qa demo guide', 5),
  (6, 'How do I create the first semantic index?', 'Configure both database connections and the corpus column mapping, initialize the index database, and then run Full rebuild.', 'indexing', 'semantic-qa demo guide', 6),
  (7, 'What does incremental sync do?', 'Incremental sync hashes source records, embeds new or changed records, and removes index records whose source IDs no longer exist.', 'indexing', 'semantic-qa demo guide', 7),
  (8, 'What happens if synchronization fails?', 'A failed or cancelled synchronization leaves the previous live index intact. Staged changes are committed only after a complete successful source scan.', 'indexing', 'semantic-qa demo guide', 8),
  (9, 'What happens when no answer is a strong match?', 'The tool says: I could not find a clear answer in the existing data. It then returns the closest indexed records instead of guessing.', 'search', 'semantic-qa demo guide', 9),
  (10, 'How is semantic relevance calculated?', 'The user question and stored Q&A records are embedded with Ollama. PostgreSQL pgvector ranks records with cosine similarity.', 'search', 'semantic-qa demo guide', 10),
  (11, 'What is the default clear-match threshold?', 'The default clear-match threshold is 0.60. It can be changed in Settings to fit the corpus and embedding model.', 'search', 'semantic-qa demo guide', 11),
  (12, 'How many search results are returned?', 'The default result count is five. Settings accepts a result count from one through twenty.', 'search', 'semantic-qa demo guide', 12),
  (13, 'Which source columns are required?', 'The source mapping requires one non-null unique ID column, one non-empty question column, and one non-empty answer column.', 'source data', 'semantic-qa demo guide', 13),
  (14, 'Can source metadata be returned with answers?', 'Yes. Selected metadata columns are copied into the index snapshot and returned with each matching answer.', 'source data', 'semantic-qa demo guide', 14),
  (15, 'How are multiple related source records ordered?', 'Records are selected by semantic relevance. When source group and order columns are configured, related records are displayed in source order while retaining relevance ranks.', 'source data', 'semantic-qa demo guide', 15),
  (16, 'Are database passwords saved in the browser?', 'No. Passwords and complete connection strings remain in memory and are removed from persisted browser settings.', 'security', 'semantic-qa demo guide', 16),
  (17, 'What permissions does the source database account need?', 'The source account needs CONNECT, schema USAGE, and SELECT on the selected Q&A table. It does not need write privileges.', 'security', 'semantic-qa demo guide', 17),
  (18, 'What permissions does the index account need?', 'The index account must be able to create and update the semantic_qa schema and its tables. The vector extension must already exist or the account must be allowed to create it.', 'security', 'semantic-qa demo guide', 18),
  (19, 'Which SSL mode should I use for a local PostgreSQL server?', 'Use SSL mode disable for a local PostgreSQL server that does not provide TLS. The tool also treats prefer as non-SSL for loopback hosts.', 'troubleshooting', 'semantic-qa demo guide', 19),
  (20, 'What should I do after changing the embedding model?', 'Run a Full rebuild. Vectors made by a different model or dimension cannot be mixed with the existing index.', 'troubleshooting', 'semantic-qa demo guide', 20)
ON CONFLICT (id) DO UPDATE SET
  question = EXCLUDED.question,
  answer = EXCLUDED.answer,
  category = EXCLUDED.category,
  source_name = EXCLUDED.source_name,
  source_order = EXCLUDED.source_order;

GRANT CONNECT ON DATABASE semantic_qa_source TO semantic_qa_reader;
GRANT USAGE ON SCHEMA public TO semantic_qa_reader;
GRANT SELECT ON TABLE public.qa_records TO semantic_qa_reader;

SELECT COUNT(*) AS sample_record_count FROM public.qa_records;
