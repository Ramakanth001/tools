const path = require('node:path');
const { createRequire } = require('node:module');

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
      sourceContext: htmlToPlainText(row.briefQuestion || row.questionBk || ''),
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
    database: process.env.UNIVERSAL_MYSQL_DATABASE || 'universal_vector_source',
    charset: 'utf8mb4',
    dateStrings: true,
  };
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

async function runImport() {
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
    const [qaRows] = await source.query(`
      SELECT qaId, masterId, title, briefQuestion, questionBk, recordDate,
             multimediaFilename, answerBySwami, masterLanguage
      FROM tblQA
      WHERE activeStatus = 1
      ORDER BY qaId
    `);
    const [discourseRows] = includeDiscourse ? await source.query(`
      SELECT dcId, masterId, title, summary, textDC, recordDate,
             multimediaFilename, masterLanguage
      FROM tblDiscourse
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
    if (rejected.length) throw new Error(`Rejected source rows: ${JSON.stringify(rejected)}`);
    if (!records.length) throw new Error('No active source rows were available to import');

    await pg.connect();
    await pg.query('BEGIN');
    await pg.query('DROP TABLE IF EXISTS public.qa_records_next');
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
    for (let index = 0; index < records.length; index += 100) {
      await insertBatch(pg, records.slice(index, index + 100));
    }
    await pg.query('DROP TABLE IF EXISTS public.qa_records');
    await pg.query('ALTER TABLE public.qa_records_next RENAME TO qa_records');
    await pg.query('CREATE INDEX qa_records_source_group_idx ON public.qa_records (source_group, chunk_index)');
    await pg.query('GRANT USAGE ON SCHEMA public TO semantic_qa_reader');
    await pg.query('GRANT SELECT ON public.qa_records TO semantic_qa_reader');
    const validation = await pg.query(`
      SELECT COUNT(*)::integer AS record_count,
             COUNT(DISTINCT original_record_id) FILTER (WHERE source_type = 'qa')::integer AS source_qa_count,
             COUNT(DISTINCT original_record_id) FILTER (WHERE source_type = 'discourse')::integer AS source_discourse_count,
             COUNT(*) FILTER (WHERE source_type = 'qa')::integer AS qa_chunk_count,
             COUNT(*) FILTER (WHERE source_type = 'discourse')::integer AS discourse_chunk_count,
             MAX(length(question))::integer AS max_question_chars,
             MAX(length(answer))::integer AS max_answer_chars
      FROM public.qa_records
    `);
    await pg.query('COMMIT');
    return {
      ...validation.rows[0],
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
  runImport()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { buildDiscourseRecords, buildRecords, chunkText, decodeHtmlEntities, htmlToPlainText, runImport };
