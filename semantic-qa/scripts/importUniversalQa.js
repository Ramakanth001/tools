const path = require('node:path');
const { createRequire } = require('node:module');
const { parseAnswerUnits, sha256 } = require('../src/corpusStructure');

const mysqlRequire = createRequire(path.resolve(__dirname, '../../mysql-pg-migrate/package.json'));
const { repairMojibake } = require('../../mysql-pg-migrate/src/lib/mojibakeRepair');

const NAMED_ENTITIES = {
  Delta: 'Δ', aacute: 'á', acirc: 'â', agrave: 'à', amp: '&', apos: "'", aring: 'å', auml: 'ä',
  bull: '•', cedil: '¸', copy: '©', dagger: '†', deg: '°', delta: 'δ', divide: '÷', eacute: 'é',
  emsp: ' ', ensp: ' ', frac12: '½', frac14: '¼', frac34: '¾', gt: '>', hearts: '♥', hellip: '…',
  laquo: '«', larr: '←', ldquo: '“', lrm: '', lsquo: '‘', lt: '<', mdash: '—', middot: '·',
  nbsp: ' ', ndash: '–', not: '¬', ntilde: 'ñ', quot: '"', raquo: '»', rarr: '→', rdquo: '”',
  reg: '®', rlm: '', rsquo: '’', shy: '', sup2: '²', thinsp: ' ', times: '×', trade: '™',
  uuml: 'ü', zwj: '', zwnj: '',
};

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try { return String.fromCodePoint(codePoint); } catch { return match; }
      }
      return match;
    }
    if (Object.hasOwn(NAMED_ENTITIES, entity)) return NAMED_ENTITIES[entity];
    return Object.hasOwn(NAMED_ENTITIES, entity.toLowerCase()) ? NAMED_ENTITIES[entity.toLowerCase()] : match;
  });
}

function htmlToPlainText(value) {
  const withLayout = String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<td\b[^>]*>/gi, '\t')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');

  const cleaned = decodeHtmlEntities(withLayout)
    .replace(/\r\n?/g, '\n')
    .replace(/[\t \f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return repairMojibake(cleaned, { mode: 'auto' });
}

function splitLongPart(value, maxChars) {
  const parts = [];
  let remaining = value.trim();
  while (remaining.length > maxChars) {
    let boundary = remaining.lastIndexOf(' ', maxChars);
    if (boundary < Math.floor(maxChars * 0.6)) boundary = maxChars;
    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function trailingOverlap(value, maxChars) {
  if (!maxChars) return '';
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const roughStart = text.length - maxChars;
  const window = text.slice(roughStart);
  const boundary = window.search(/[\s.!?]\S/);
  return window.slice(boundary >= 0 ? boundary + 1 : 0).trim();
}

function chunkText(value, maxChars = 1800, overlapChars = 0) {
  if (!Number.isInteger(maxChars) || maxChars < 200) throw new Error('maxChars must be an integer of at least 200');
  const text = String(value || '').trim();
  if (!text) return [];

  const overlap = Math.max(0, Math.min(Math.floor(maxChars / 4), Number(overlapChars) || 0));
  const contentLimit = maxChars - overlap - (overlap ? 2 : 0);

  const parts = text.split(/\n{2,}/).flatMap((part) => splitLongPart(part, contentLimit));
  const chunks = [];
  let current = '';
  for (const part of parts) {
    const next = current ? `${current}\n\n${part}` : part;
    if (next.length <= contentLimit) {
      current = next;
    } else {
      if (current) chunks.push(current);
      current = part;
    }
  }
  if (current) chunks.push(current);
  if (!overlap || chunks.length < 2) return chunks;
  return chunks.map((chunk, index) => {
    if (!index) return chunk;
    const prefix = trailingOverlap(chunks[index - 1], overlap);
    return prefix ? `${prefix}\n\n${chunk}` : chunk;
  });
}

function combineSourceContext(...values) {
  const seen = new Set();
  return values
    .map((value) => htmlToPlainText(value))
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .join('\n\n');
}

function sourceDocument(row, sourceType) {
  const isQa = sourceType === 'qa';
  const originalRecordId = isQa ? row.qaId : row.dcId;
  const documentId = `${sourceType}:${originalRecordId}`;
  const rawContent = String((isQa ? row.answerBySwami : row.textDC) ?? '');
  const displayText = htmlToPlainText(rawContent);
  const title = htmlToPlainText(row.title);
  const questionContext = isQa
    ? combineSourceContext(row.briefQuestion, row.questionBk)
    : htmlToPlainText(row.summary || '');
  const parsed = parseAnswerUnits({
    sourceId: documentId,
    sourceType,
    question: combineSourceContext(title, questionContext),
    text: displayText,
    language: row.masterLanguage || '',
    author: row.author || '',
  });
  return {
    documentId,
    sourceType,
    originalRecordId,
    sourceGroup: documentId,
    masterId: row.masterId,
    title,
    questionContext,
    rawContent,
    displayText,
    rawContentHash: sha256(rawContent),
    displayTextHash: sha256(displayText),
    author: String(row.author || '').trim() || 'Swami',
    defaultUnitKind: isQa ? 'swami_reply' : 'swami_teaching',
    language: row.masterLanguage || '',
    recordDate: row.recordDate,
    multimediaFilename: row.multimediaFilename || '',
    answerUnitCount: parsed.units.length,
    ambiguous: parsed.ambiguities.length > 0,
    parserReport: {
      answerUnitIds: parsed.units.map((unit) => unit.answerUnitId),
      ignoredSpeakerSpans: parsed.ignored.map(({ role, start, end }) => ({ role, start, end })),
      ambiguities: parsed.ambiguities,
    },
  };
}

function buildDocuments(qaRows, discourseRows, legacyRecords = []) {
  const aliasesByGroup = new Map();
  for (const record of legacyRecords || []) {
    if (!aliasesByGroup.has(record.sourceGroup)) aliasesByGroup.set(record.sourceGroup, []);
    aliasesByGroup.get(record.sourceGroup).push(record.sourceId);
  }
  const documents = [
    ...(qaRows || []).map((row) => sourceDocument(row, 'qa')),
    ...(discourseRows || []).map((row) => sourceDocument(row, 'discourse')),
  ].map((document) => ({
    ...document,
    legacyAliases: aliasesByGroup.get(document.sourceGroup) || [document.documentId],
  }));
  const rejected = documents
    .filter((document) => !document.title || !document.displayText)
    .map((document) => ({
      documentId: document.documentId,
      reason: !document.title ? 'empty title' : 'empty teaching text',
    }));
  const identities = new Set();
  const duplicates = [];
  for (const document of documents) {
    if (identities.has(document.documentId)) duplicates.push(document.documentId);
    identities.add(document.documentId);
  }
  return { documents: documents.filter((document) => document.title && document.displayText), rejected, duplicates };
}

function buildRecords(rows, maxChars = 1800) {
  const records = [];
  const rejected = [];
  for (const row of rows) {
    const question = htmlToPlainText(row.title);
    const answer = htmlToPlainText(row.answerBySwami);
    if (!question || !answer) {
      rejected.push({ qaId: row.qaId, reason: !question ? 'empty title' : 'empty answer' });
      continue;
    }
    const overlapChars = Math.min(200, Math.floor(maxChars * 0.12));
    const chunks = chunkText(answer, maxChars, overlapChars);
    chunks.forEach((chunk, index) => records.push({
      sourceId: chunks.length === 1 ? `qa:${row.qaId}` : `qa:${row.qaId}:${String(index + 1).padStart(3, '0')}`,
      sourceType: 'qa',
      originalRecordId: row.qaId,
      sourceGroup: `qa:${row.qaId}`,
      masterId: row.masterId,
      question,
      answer: chunk,
      sourceContext: combineSourceContext(row.briefQuestion, row.questionBk),
      language: row.masterLanguage || '',
      recordDate: row.recordDate,
      multimediaFilename: row.multimediaFilename || '',
      chunkIndex: index + 1,
      chunkCount: chunks.length,
    }));
  }
  return { records, rejected };
}

function buildDiscourseRecords(rows, {
  englishMaxChars = 3600,
  otherMaxChars = 1400,
  englishOverlapChars = 300,
  otherOverlapChars = 140,
} = {}) {
  const records = [];
  const rejected = [];
  for (const row of rows) {
    const question = htmlToPlainText(row.title);
    const answer = htmlToPlainText(row.textDC);
    if (!question || !answer) {
      rejected.push({ discourseId: row.dcId, reason: !question ? 'empty title' : 'empty discourse text' });
      continue;
    }
    const maxChars = row.masterLanguage === 'ENG' ? englishMaxChars : otherMaxChars;
    const overlapChars = row.masterLanguage === 'ENG' ? englishOverlapChars : otherOverlapChars;
    const chunks = chunkText(answer, maxChars, overlapChars);
    chunks.forEach((chunk, index) => records.push({
      sourceId: chunks.length === 1 ? `discourse:${row.dcId}` : `discourse:${row.dcId}:${String(index + 1).padStart(3, '0')}`,
      sourceType: 'discourse',
      originalRecordId: row.dcId,
      sourceGroup: `discourse:${row.dcId}`,
      masterId: row.masterId,
      question,
      answer: chunk,
      sourceContext: htmlToPlainText(row.summary || ''),
      language: row.masterLanguage || '',
      recordDate: row.recordDate,
      multimediaFilename: row.multimediaFilename || '',
      chunkIndex: index + 1,
      chunkCount: chunks.length,
    }));
  }
  return { records, rejected };
}

function mysqlConfig() {
  return {
    host: process.env.UNIVERSAL_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.UNIVERSAL_MYSQL_PORT || 3306),
    user: process.env.UNIVERSAL_MYSQL_USER || 'root',
    password: process.env.UNIVERSAL_MYSQL_PASSWORD || '',
    charset: 'utf8mb4',
    dateStrings: true,
  };
}

function quoteMysqlIdentifier(value) {
  return `\`${String(value).replace(/`/gu, '``')}\``;
}

async function resolveMysqlDatabase(source) {
  const configured = String(process.env.UNIVERSAL_MYSQL_DATABASE || '').trim();
  const values = configured
    ? [configured, 'tblQA', 'tblDiscourse']
    : ['tblQA', 'tblDiscourse'];
  const where = configured ? 'TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?)' : 'TABLE_NAME IN (?, ?)';
  const [rows] = await source.query(`
    SELECT TABLE_SCHEMA AS schema_name, COUNT(DISTINCT TABLE_NAME) AS table_count
    FROM information_schema.TABLES
    WHERE ${where}
    GROUP BY TABLE_SCHEMA
    HAVING COUNT(DISTINCT TABLE_NAME) = 2
    ORDER BY TABLE_SCHEMA
  `, values);
  if (configured && rows.length !== 1) {
    throw new Error(`Configured MySQL database ${configured} does not contain both tblQA and tblDiscourse`);
  }
  if (!configured && rows.length === 0) {
    throw new Error('No MySQL database contains both tblQA and tblDiscourse. Start MySQL or set UNIVERSAL_MYSQL_DATABASE explicitly.');
  }
  if (!configured && rows.length > 1) {
    throw new Error(`Multiple MySQL databases contain tblQA and tblDiscourse (${rows.map((row) => row.schema_name).join(', ')}). Set UNIVERSAL_MYSQL_DATABASE explicitly.`);
  }
  return rows[0].schema_name;
}

function postgresConfig() {
  return {
    host: process.env.UNIVERSAL_PG_HOST || '127.0.0.1',
    port: Number(process.env.UNIVERSAL_PG_PORT || 5433),
    user: process.env.UNIVERSAL_PG_USER || process.env.USER,
    password: process.env.UNIVERSAL_PG_PASSWORD || '',
    database: process.env.UNIVERSAL_PG_DATABASE || 'universal_qa_source',
    ssl: false,
  };
}

async function insertBatch(pg, records) {
  const columns = [
    'source_id', 'source_type', 'original_record_id', 'source_group', 'master_id', 'question',
    'answer', 'source_context', 'language', 'record_date', 'multimedia_filename', 'chunk_index', 'chunk_count',
  ];
  const values = [];
  const placeholders = records.map((record) => {
    const row = [
      record.sourceId, record.sourceType, record.originalRecordId, record.sourceGroup, record.masterId,
      record.question, record.answer, record.sourceContext, record.language, record.recordDate,
      record.multimediaFilename, record.chunkIndex, record.chunkCount,
    ];
    const offset = values.length;
    values.push(...row);
    return `(${row.map((_, index) => `$${offset + index + 1}`).join(',')})`;
  });
  await pg.query(`INSERT INTO public.qa_records_next (${columns.join(',')}) VALUES ${placeholders.join(',')}`, values);
}

async function insertDocumentBatch(pg, documents) {
  const columns = [
    'document_id', 'source_type', 'original_record_id', 'source_group', 'master_id', 'title',
    'question_context', 'raw_content', 'display_text', 'raw_content_hash', 'display_text_hash',
    'author', 'default_unit_kind', 'language', 'record_date', 'multimedia_filename',
    'answer_unit_count', 'ambiguous', 'parser_report',
    'legacy_aliases',
  ];
  const values = [];
  const placeholders = documents.map((document) => {
    const row = [
      document.documentId, document.sourceType, document.originalRecordId, document.sourceGroup,
      document.masterId, document.title, document.questionContext, document.rawContent,
      document.displayText, document.rawContentHash, document.displayTextHash, document.author,
      document.defaultUnitKind, document.language, document.recordDate, document.multimediaFilename,
      document.answerUnitCount, document.ambiguous, JSON.stringify(document.parserReport),
      document.legacyAliases,
    ];
    const offset = values.length;
    values.push(...row);
    return `(${row.map((_, index) => `$${offset + index + 1}`).join(',')})`;
  });
  await pg.query(`INSERT INTO public.corpus_documents_next (${columns.join(',')}) VALUES ${placeholders.join(',')}`, values);
}

async function runImport({ dryRun = false } = {}) {
  const mysql = mysqlRequire('mysql2/promise');
  const { Client } = require('pg');
  const source = await mysql.createConnection(mysqlConfig());
  const pg = new Client(postgresConfig());
  const qaMaxChars = Number(process.env.UNIVERSAL_QA_CHUNK_CHARS || process.env.UNIVERSAL_EMBED_CHUNK_CHARS || 1800);
  const discourseEnglishMaxChars = Number(process.env.UNIVERSAL_DISCOURSE_EN_CHUNK_CHARS || 3600);
  const discourseOtherMaxChars = Number(process.env.UNIVERSAL_DISCOURSE_OTHER_CHUNK_CHARS || 1400);
  const discourseEnglishOverlapChars = Number(process.env.UNIVERSAL_DISCOURSE_EN_OVERLAP_CHARS || 300);
  const discourseOtherOverlapChars = Number(process.env.UNIVERSAL_DISCOURSE_OTHER_OVERLAP_CHARS || 140);
  const includeDiscourse = process.env.UNIVERSAL_INCLUDE_DISCOURSE !== 'false';
  try {
    const sourceMysqlDatabase = await resolveMysqlDatabase(source);
    const sourceSchema = quoteMysqlIdentifier(sourceMysqlDatabase);
    const [qaRows] = await source.query(`
      SELECT qaId, masterId, title, briefQuestion, questionBk, recordDate,
             multimediaFilename, answerBySwami, masterLanguage
      FROM ${sourceSchema}.tblQA
      WHERE activeStatus = 1
      ORDER BY qaId
    `);
    const [discourseRows] = includeDiscourse ? await source.query(`
      SELECT dcId, masterId, title, summary, textDC, recordDate,
             multimediaFilename, masterLanguage
      FROM ${sourceSchema}.tblDiscourse
      WHERE activeStatus = 1
      ORDER BY dcId
    `) : [[]];
    const qaResult = buildRecords(qaRows, qaMaxChars);
    const discourseResult = buildDiscourseRecords(discourseRows, {
      englishMaxChars: discourseEnglishMaxChars,
      otherMaxChars: discourseOtherMaxChars,
      englishOverlapChars: discourseEnglishOverlapChars,
      otherOverlapChars: discourseOtherOverlapChars,
    });
    const records = [...qaResult.records, ...discourseResult.records];
    const rejected = [...qaResult.rejected, ...discourseResult.rejected];
    const documentResult = buildDocuments(qaRows, discourseRows, records);
    const ambiguousDocuments = documentResult.documents
      .filter((document) => document.ambiguous)
      .map((document) => ({ documentId: document.documentId, ...document.parserReport }));
    const validationReport = {
      mode: dryRun ? 'validation' : 'import',
      sourceMysqlDatabase,
      proposedDocumentCount: documentResult.documents.length,
      proposedQaCount: qaRows.length,
      proposedDiscourseCount: discourseRows.length,
      proposedLegacyChunkCount: records.length,
      emptyFields: [...rejected, ...documentResult.rejected],
      duplicateIdentities: documentResult.duplicates,
      ambiguousSpeakerBoundaries: ambiguousDocuments,
      citableAnswerUnits: documentResult.documents.reduce((total, document) => total + document.answerUnitCount, 0),
      rawHashes: documentResult.documents.length,
    };
    if (rejected.length) throw new Error(`Rejected source rows: ${JSON.stringify(rejected)}`);
    if (documentResult.rejected.length) throw new Error(`Rejected source documents: ${JSON.stringify(documentResult.rejected)}`);
    if (documentResult.duplicates.length) throw new Error(`Duplicate source identities: ${JSON.stringify(documentResult.duplicates)}`);
    if (!records.length) throw new Error('No active source rows were available to import');
    if (dryRun) return validationReport;

    await pg.connect();
    await pg.query('BEGIN');
    await pg.query('DROP TABLE IF EXISTS public.qa_records_next');
    await pg.query('DROP TABLE IF EXISTS public.corpus_documents_next');
    await pg.query(`
      CREATE TABLE public.qa_records_next (
        source_id text PRIMARY KEY,
        source_type text NOT NULL CHECK (source_type IN ('qa', 'discourse')),
        original_record_id bigint NOT NULL,
        source_group text NOT NULL,
        master_id bigint NOT NULL,
        question text NOT NULL,
        answer text NOT NULL,
        source_context text NOT NULL DEFAULT '',
        language text NOT NULL DEFAULT '',
        record_date timestamp without time zone,
        multimedia_filename text NOT NULL DEFAULT '',
        chunk_index integer NOT NULL,
        chunk_count integer NOT NULL,
        CHECK (question <> ''),
        CHECK (answer <> ''),
        CHECK (chunk_index > 0 AND chunk_count >= chunk_index)
      )
    `);
    await pg.query(`
      CREATE TABLE public.corpus_documents_next (
        document_id text PRIMARY KEY,
        source_type text NOT NULL CHECK (source_type IN ('qa', 'discourse')),
        original_record_id bigint NOT NULL,
        source_group text NOT NULL UNIQUE,
        master_id bigint,
        title text NOT NULL,
        question_context text NOT NULL DEFAULT '',
        raw_content text NOT NULL,
        display_text text NOT NULL,
        raw_content_hash text NOT NULL CHECK (raw_content_hash ~ '^[0-9a-f]{64}$'),
        display_text_hash text NOT NULL CHECK (display_text_hash ~ '^[0-9a-f]{64}$'),
        author text NOT NULL DEFAULT 'Swami',
        default_unit_kind text NOT NULL CHECK (default_unit_kind IN ('swami_reply', 'swami_teaching')),
        language text NOT NULL DEFAULT '',
        record_date timestamp without time zone,
        multimedia_filename text NOT NULL DEFAULT '',
        answer_unit_count integer NOT NULL DEFAULT 0 CHECK (answer_unit_count >= 0),
        ambiguous boolean NOT NULL DEFAULT false,
        parser_report jsonb NOT NULL DEFAULT '{}'::jsonb,
        legacy_aliases text[] NOT NULL DEFAULT '{}'::text[],
        imported_at timestamptz NOT NULL DEFAULT now(),
        CHECK (title <> ''),
        CHECK (display_text <> ''),
        CHECK (author <> '')
      )
    `);
    for (let index = 0; index < records.length; index += 100) {
      await insertBatch(pg, records.slice(index, index + 100));
    }
    for (let index = 0; index < documentResult.documents.length; index += 50) {
      await insertDocumentBatch(pg, documentResult.documents.slice(index, index + 50));
    }
    await pg.query('DROP TABLE IF EXISTS public.qa_records');
    await pg.query('ALTER TABLE public.qa_records_next RENAME TO qa_records');
    await pg.query('DROP TABLE IF EXISTS public.corpus_documents');
    await pg.query('ALTER TABLE public.corpus_documents_next RENAME TO corpus_documents');
    await pg.query('CREATE INDEX qa_records_source_group_idx ON public.qa_records (source_group, chunk_index)');
    await pg.query('CREATE INDEX corpus_documents_source_type_idx ON public.corpus_documents (source_type, original_record_id)');
    await pg.query('CREATE INDEX corpus_documents_raw_hash_idx ON public.corpus_documents (raw_content_hash)');
    await pg.query('GRANT USAGE ON SCHEMA public TO semantic_qa_reader');
    await pg.query('GRANT SELECT ON public.qa_records TO semantic_qa_reader');
    await pg.query('GRANT SELECT ON public.corpus_documents TO semantic_qa_reader');
    const validation = await pg.query(`
      SELECT COUNT(*)::integer AS document_count,
             COUNT(DISTINCT original_record_id) FILTER (WHERE source_type = 'qa')::integer AS source_qa_count,
             COUNT(DISTINCT original_record_id) FILTER (WHERE source_type = 'discourse')::integer AS source_discourse_count,
             SUM(answer_unit_count)::integer AS answer_unit_count,
             COUNT(*) FILTER (WHERE ambiguous)::integer AS ambiguous_document_count,
             MAX(length(title))::integer AS max_title_chars,
             MAX(length(display_text))::integer AS max_display_chars,
             bool_and(raw_content_hash ~ '^[0-9a-f]{64}$') AS raw_hashes_valid
      FROM public.corpus_documents
    `);
    const chunkValidation = await pg.query(`
      SELECT COUNT(*)::integer AS record_count,
             COUNT(*) FILTER (WHERE source_type = 'qa')::integer AS qa_chunk_count,
             COUNT(*) FILTER (WHERE source_type = 'discourse')::integer AS discourse_chunk_count
      FROM public.qa_records
    `);
    await pg.query('COMMIT');
    return {
      ...validationReport,
      ...validation.rows[0],
      ...chunkValidation.rows[0],
      qaMaxChunkChars: qaMaxChars,
      discourseEnglishMaxChunkChars: discourseEnglishMaxChars,
      discourseOtherMaxChunkChars: discourseOtherMaxChars,
      discourseEnglishOverlapChars,
      discourseOtherOverlapChars,
      rejected: rejected.length,
    };
  } catch (error) {
    if (pg._connected) await pg.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await source.end().catch(() => {});
    await pg.end().catch(() => {});
  }
}

if (require.main === module) {
  runImport({ dryRun: process.argv.includes('--check') || process.argv.includes('--validate') })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildDocuments,
  buildDiscourseRecords,
  buildRecords,
  chunkText,
  combineSourceContext,
  decodeHtmlEntities,
  htmlToPlainText,
  mysqlConfig,
  quoteMysqlIdentifier,
  resolveMysqlDatabase,
  runImport,
};
