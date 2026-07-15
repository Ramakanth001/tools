\set ON_ERROR_STOP on

SELECT 'CREATE ROLE semantic_qa_reader LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'semantic_qa_reader')
\gexec

SELECT 'CREATE ROLE semantic_qa_indexer LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'semantic_qa_indexer')
\gexec

SELECT 'CREATE DATABASE semantic_qa_source'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'semantic_qa_source')
\gexec

SELECT 'CREATE DATABASE semantic_qa_index OWNER semantic_qa_indexer'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'semantic_qa_index')
\gexec

\connect semantic_qa_source
\ir sample_source.sql

\connect semantic_qa_index
\ir index_setup.sql
