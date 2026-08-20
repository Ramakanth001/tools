\set ON_ERROR_STOP on

-- Run as a local PostgreSQL administrator. The script intentionally grants the
-- corpus account SELECT only and gives the chat account no access to the index.
SELECT 'CREATE ROLE spiritual_gpt_index_reader LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spiritual_gpt_index_reader') \gexec

SELECT 'CREATE ROLE spiritual_gpt_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spiritual_gpt_app') \gexec

ALTER ROLE spiritual_gpt_index_reader NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE spiritual_gpt_index_reader SET default_transaction_read_only = on;
ALTER ROLE spiritual_gpt_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

SELECT 'CREATE DATABASE spiritual_gpt'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'spiritual_gpt') \gexec

\connect universal_qa_index
GRANT CONNECT ON DATABASE universal_qa_index TO spiritual_gpt_index_reader;
GRANT USAGE ON SCHEMA semantic_qa TO spiritual_gpt_index_reader;
GRANT SELECT ON semantic_qa.corpus, semantic_qa.records, semantic_qa.passages TO spiritual_gpt_index_reader;

-- Preserve read access when Search Engine atomically replaces its index tables.
-- This assumes semantic_qa_indexer owns the synchronized tables in this local setup.
ALTER DEFAULT PRIVILEGES FOR ROLE semantic_qa_indexer IN SCHEMA semantic_qa
  GRANT SELECT ON TABLES TO spiritual_gpt_index_reader;

\connect spiritual_gpt
REVOKE CONNECT, TEMPORARY ON DATABASE spiritual_gpt FROM PUBLIC;
GRANT CONNECT ON DATABASE spiritual_gpt TO spiritual_gpt_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS gpt AUTHORIZATION spiritual_gpt_app;
GRANT USAGE, CREATE ON SCHEMA gpt TO spiritual_gpt_app;
