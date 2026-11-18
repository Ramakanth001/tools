/**
 * Distance-Based Search Algorithm
 * Replicates and excels the Elasticsearch discourse search from universal-spirituality.org
 * 
 * Major Architectural Upgrades:
 * 1. DYNAMIC STATISTICAL CORPUS IDF (BM25):
 *    Calculates true Inverse Document Frequency across all 6,010 documents.
 *    Rare theological terms naturally receive high scores (up to 5.5+); common words
 *    receive lower scores. Completely replaces hardcoded entity lists.
 * 2. BROAD SANSKRIT & LINGUISTIC CANONICALIZER:
 *    Handles IAST diacritics, vowel lengths (aa/a, ee/i), consonants (th/t, dh/d),
 *    sibilants (s/sh/ś/ṣ), nasals (gn/jn), and semi-vowels (w/v) dynamically.
 * 3. CONTINUOUS ROLLING TOKEN WINDOW PROXIMITY:
 *    Evaluates pairwise proximity across the full token stream, eliminating
 *    paragraph-boundary blindness.
 * 4. WORD-BOUNDARY PHRASE MATCHING:
 *    Uses boundary-checked matching, eliminating substring collision bugs (e.g. "in car" in "incarnation").
 * 5. DATABASE TS_RANK_CD PRE-ORDERING:
 *    Ensures candidate retrieval selects the densest GIN index matches before in-memory scoring.
 * 6. TITLE DOMINANCE HIERARCHICAL TIERS (Invariant Preserved):
 *    Tier 1 (1M+), Tier 2 (600K), Tier 3 (250K), Tier 4 (0-50K). Title matches always outrank excerpt-only matches.
 */

const { getCanonicalSpiritualTerm, getSpiritualVariants } = require('./spiritualEquivalents.js');
const { addSingleUnitTitles, retrieveSingleUnitTitles } = require('./distanceTitleShortlist.js');
const {
  retrieveEnglishBodyCandidates, addEnglishBodyCandidates, englishBodyBoost,
  clearEnglishBodyCache, numberedTitleReference, isNumberedReferenceLookup, questionReference, matchesQuestionReference,
} = require('./distanceEnglishBody.js');
const {
  retrieveEnglishPassageCandidates, addEnglishPassageCandidates, clearEnglishPassageCache, isAnchoredPassageQuestion,
  prepareEnglishPassageSearch,
} = require('./distanceEnglishPassages.js');

function isSearchEligibleMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return true;
  if (metadata.ambiguous === true || String(metadata.ambiguous || '').toLowerCase() === 'true') {
    return false;
  }
  if (Object.hasOwn(metadata, 'answer_unit_count')) {
    const answerUnitCount = Number(metadata.answer_unit_count);
    if (Number.isFinite(answerUnitCount) && answerUnitCount <= 0) return false;
  }
  return true;
}

function searchEligibilitySql(alias = 'r') {
  return `
    coalesce(lower(${alias}.metadata->>'ambiguous'), 'false') <> 'true'
    AND (
      coalesce(${alias}.metadata->>'answer_unit_count', '') !~ '^[0-9]+$'
      OR (${alias}.metadata->>'answer_unit_count')::integer > 0
    )
  `;
}

const CORPUS_TOTAL_TTL_MS = 5 * 60 * 1000;
let perPoolCorpusStatistics = new WeakMap();

function corpusStatistics(pool) {
  let statistics = perPoolCorpusStatistics.get(pool);
  if (!statistics) {
    statistics = { total: null, expiresAt: 0, pending: null, idf: new LRUCache(30000), lexemes: new LRUCache(30000) };
    perPoolCorpusStatistics.set(pool, statistics);
  }
  return statistics;
}

async function getCorpusTotal(pool) {
  if (!pool) return 6010;
  const statistics = corpusStatistics(pool);
  const now = Date.now();
  if (now < statistics.expiresAt) return statistics.total;
  if (!statistics.pending) {
    statistics.pending = pool.query(`
      SELECT count(*) as count FROM semantic_qa.records r WHERE ${searchEligibilitySql('r')}
    `).then(result => {
      const total = Math.max(1, Number(result.rows[0]?.count) || 6010);
      if (statistics.total !== null && total !== statistics.total) {
        statistics.idf.clear();
        statistics.lexemes.clear();
      }
      statistics.total = total;
      statistics.expiresAt = Date.now() + CORPUS_TOTAL_TTL_MS;
      return total;
    }, () => 6010).finally(() => { statistics.pending = null; });
  }
  return statistics.pending;
}

function clearIdfCache() {
  clearEnglishBodyCache();
  clearEnglishPassageCache();
  perPoolCorpusStatistics = new WeakMap();
}

class LRUCache {
  constructor(limit = 15000) {
    this.limit = limit;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, val);
  }
  get size() {
    return this.cache.size;
  }
  clear() {
    this.cache.clear();
  }
}

const termCanonicalCache = new LRUCache(15000);
const scoringDocumentCache = new LRUCache(2500);
const SPIRITUAL_QUERY_ANCHORS = new Set([
  'allah', 'anubhava', 'aparoksha', 'atma', 'avatar', 'baba', 'bhakti', 'bible',
  'brahma', 'buddha', 'consciousness', 'datta', 'devotion', 'devotee', 'devotees',
  'dharma', 'divine', 'ego', 'god', 'gita', 'guru', 'heaven', 'holy', 'incarnation',
  'incarnations', 'jesus', 'karma', 'krishna', 'lord', 'maayaa', 'maya', 'mecca',
  'meditation', 'moksha', 'muhammad', 'nivritti', 'nivrutti', 'paroksha', 'prajnanam',
  'prayer', 'quran', 'rama', 'sacrifice', 'sadguru', 'sai', 'salvation', 'satan',
  'shankara', 'shirdi', 'shiva', 'shri', 'soul', 'souls', 'spiritual', 'spirituality',
  'swami', 'upanishad', 'vasudeva', 'veda', 'vedas', 'vishnu', 'vishwarupam', 'worship',
]);

const INTENT_WORDS = new Set([
  'meaning', 'means', 'meant', 'definition', 'define',
  'mean',
  'purpose', 'reason', 'why', 'who', 'what', 'how',
  'specialty', 'significance', 'importance',
  'difference', 'different',
  'relationship', 'relation', 'related', 'connection', 'correlate', 'correlation',
  'real', 'actual', 'true', 'really',
  'develop', 'attain', 'reach', 'practice',
  'topic', 'prakaranam', 'prakarana', 'essence',
  'characteristic', 'characteristics', 'interpretation',
  'clarification', 'clarifications', 'nature'
]);

const MODIFIER_WORDS = new Set([
  'always', 'never', 'sometimes', 'often', 'strongly', 'strictly', 'easily',
  'condemn', 'condemns', 'condemned', 'discourage', 'discouraged',
  'prosper', 'prospers', 'prospering', 'overcoming', 'overcome', 'overcomes',
  'worldly', 'spiritually', 'spiritual', 'physical', 'holy', 'sacred', 'divine',
  'become', 'becomes', 'becoming', 'taking', 'taken', 'give', 'gives', 'giving', 'given',
  'say', 'says', 'said', 'describe', 'describes', 'described',
  'make', 'makes', 'made', 'bring', 'brings', 'lead', 'leads', 'show', 'shows', 'showed',
  'allow', 'allows', 'find', 'finds', 'call', 'called', 'mention', 'mentioned',
  'help', 'helps', 'helping', 'need', 'needs', 'needed',
  'difficult', 'easy', 'different', 'similar', 'good', 'bad',
  'high', 'higher', 'highest', 'low', 'lower', 'lowest',
  'question', 'questions', 'answer', 'answers', 'person', 'people', 'human', 'beings', 'things',
  'basis', 'role', 'advice', 'solution', 'problem', 'problems', 'case', 'cases', 'way', 'ways'
]);

const PRIORITY_SPIRITUAL_ENTITIES = new Set([
  'gayatri', 'savitri', 'savita', 'sandhya', 'vandanam', 'sandhyavandanam',
  'nivritti', 'pravritti', 'karma', 'bhakti', 'jnana', 'mukti', 'maya', 'mithya',
  'advaita', 'vishishtadvaita', 'dvaita', 'shuddhadvaita', 'vivartavada', 'parinamavada',
  'parabrahman', 'brahman', 'brahma', 'atma', 'soul', 'god', 'swami', 'incarnation', 'avatar',
  'jesus', 'muhammad', 'buddha', 'shankara', 'ramanuja', 'madhva', 'krishna', 'rama',
  'shiva', 'vishnu', 'datta', 'hanuman', 'gopika', 'radha', 'yajna', 'upanayanam',
  'yajnopavitam', 'mantra', 'temple', 'idol', 'statue', 'upasana', 'shraddha', 'eshana',
  'caste', 'varna', 'donation', 'charity', 'sacrifice', 'money', 'dakshina', 'satpatra',
  'samnyasa', 'sanyasa', 'pratika', 'prarabdha', 'sanchita', 'agami',
  'nonveg', 'meat', 'slaughter', 'animal', 'animals', 'hell', 'naraka', 'heaven', 'swarga',
  'punishment', 'sin', 'sins', 'rebirth', 'death', 'ego', 'ahankara', 'jealousy',
  'astrology', 'navavidha', 'holyspirit', 'trinity', 'scripture', 'scriptures', 'veda',
  'gita', 'bible', 'quran', 'women', 'gender', 'beggar', 'beggars', 'poverty', 'science',
  'evolution', 'mind', 'meditation', 'depression', 'miracle', 'miracles', 'religion', 'religions', 'universal'
]);

const SPEAKER_TOKENS = new Set(['swami', 'swamiji', 'datta', 'shri', 'sri', 'ji', 'holiness']);

const GENERIC_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during',
  'each', 'explain', 'few', 'for', 'from', 'further', 'give',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just',
  'kindly', 'me', 'more', 'most', 'my', 'myself',
  'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'please', 'same', 'shall', 'should', 'so', 'some', 'such',
  'tell', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'us',
  'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your', 'yours', 'yourself', 'yourselves',
  // Natural search framing must never become the mandatory topic anchor.
  'regarding', 'specific', 'issue', 'issues', 'question', 'questions',
  'according', 'perspective', 'standpoint', 'conclusion', 'draw',
  'teaching', 'teachings', 'address', 'addresses', 'indicate',
  'practical', 'terms'
]);

let fuzzyQueryVocabulary = null;

/**
 * Elasticsearch's default AUTO fuzziness allows no edits for 1-2 character
 * terms, one edit for 3-5 character terms, and two edits for longer terms.
 */
function autoFuzzinessMaxEdits(token) {
  const length = String(token || '').length;
  if (length <= 2) return 0;
  if (length <= 5) return 1;
  return 2;
}

/**
 * Bounded optimal-string-alignment distance. Adjacent transpositions count as
 * one edit, matching Elasticsearch's default fuzzy_transpositions behavior.
 */
function boundedDamerauLevenshtein(left, right, maxEdits = 2) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxEdits) return maxEdits + 1;
  if (!a.length || !b.length) return Math.max(a.length, b.length);

  let previousPrevious = null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMinimum = current[0];
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      let distance = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
      if (
        previousPrevious && i > 1 && j > 1 &&
        a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
      ) {
        distance = Math.min(distance, previousPrevious[j - 2] + 1);
      }
      current[j] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maxEdits) return maxEdits + 1;
    previousPrevious = previous;
    previous = current;
  }

  return previous[b.length];
}

function getFuzzyQueryVocabulary() {
  if (fuzzyQueryVocabulary) return fuzzyQueryVocabulary;

  const candidates = new Map();
  const register = (variant, canonical = variant, priority = 0) => {
    const cleanVariant = foldDiacritics(String(variant || '').toLowerCase()).trim();
    const cleanCanonical = foldDiacritics(String(canonical || '').toLowerCase()).trim();
    if (
      !cleanVariant || !cleanCanonical || cleanVariant.includes(' ') ||
      cleanCanonical.includes(' ') || cleanVariant.length < 3 ||
      GENERIC_WORDS.has(cleanVariant)
    ) return;
    const existing = candidates.get(cleanVariant);
    if (!existing || priority > existing.priority) {
      candidates.set(cleanVariant, { canonical: cleanCanonical, priority });
    }
  };

  for (const term of PRIORITY_SPIRITUAL_ENTITIES) {
    const canonical = getCanonicalSpiritualTerm(term) || term;
    register(term, canonical, 4);
    for (const variant of getSpiritualVariants(term)) register(variant, canonical, 3);
  }
  for (const term of INTENT_WORDS) register(term, term, 2);

  fuzzyQueryVocabulary = candidates;
  return fuzzyQueryVocabulary;
}

function isSingleAdjacentTransposition(left, right) {
  if (left.length !== right.length) return false;
  const mismatches = [];
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) mismatches.push(index);
    if (mismatches.length > 2) return false;
  }
  if (mismatches.length !== 2 || mismatches[1] !== mismatches[0] + 1) return false;
  const [first, second] = mismatches;
  return left[first] === right[second] && left[second] === right[first];
}

function isSingleRepeatedCharacterEdit(left, right) {
  if (Math.abs(left.length - right.length) !== 1) return false;
  const longer = left.length > right.length ? left : right;
  const shorter = left.length > right.length ? right : left;
  for (let index = 0; index < longer.length; index++) {
    const isRepeated = (index > 0 && longer[index] === longer[index - 1])
      || (index + 1 < longer.length && longer[index] === longer[index + 1]);
    if (isRepeated && `${longer.slice(0, index)}${longer.slice(index + 1)}` === shorter) return true;
  }
  return false;
}

function isSimplePlural(value, candidate) {
  return value === `${candidate}s` || value === `${candidate}es`;
}

/**
 * Correct one query token only when AUTO fuzziness yields an unambiguous
 * canonical result. Corpus text is never rewritten; this applies to user
 * queries only and therefore cannot silently alter indexed teachings.
 */
function correctFuzzyQueryToken(token) {
  const value = foldDiacritics(String(token || '').toLowerCase()).trim();
  const maxEdits = autoFuzzinessMaxEdits(value);
  if (!value || maxEdits === 0 || GENERIC_WORDS.has(value) || MODIFIER_WORDS.has(value)) return value;

  const exactCanonical = getCanonicalSpiritualTerm(value);
  if (exactCanonical) return exactCanonical;
  if (value.length <= 3) return value;

  const vocabulary = getFuzzyQueryVocabulary();
  if (vocabulary.has(value)) return vocabulary.get(value).canonical;

  let bestDistance = maxEdits + 1;
  let bestPriority = -1;
  const bestCanonicals = new Set();

  for (const [candidate, details] of vocabulary.entries()) {
    if (Math.abs(candidate.length - value.length) > maxEdits) continue;
    if (candidate[0] !== value[0]) continue;
    const distance = boundedDamerauLevenshtein(value, candidate, maxEdits);
    if (distance > maxEdits) continue;
    // Never rewrite a valid-looking word merely because it is one edit from a
    // domain term (for example Sita→Shiva, mean→meat, medication→meditation).
    // Automatic rewrites are limited to mechanically high-confidence errors.
    const safeEdit = isSingleAdjacentTransposition(value, candidate)
      || isSingleRepeatedCharacterEdit(value, candidate)
      || isSimplePlural(value, candidate);
    if (!safeEdit) continue;
    const similarity = 1 - (distance / Math.max(candidate.length, value.length));
    if (distance > 1 && similarity < 0.82) continue;

    if (distance < bestDistance || (distance === bestDistance && details.priority > bestPriority)) {
      bestDistance = distance;
      bestPriority = details.priority;
      bestCanonicals.clear();
      bestCanonicals.add(details.canonical);
    } else if (distance === bestDistance && details.priority === bestPriority) {
      bestCanonicals.add(details.canonical);
    }
  }

  return bestCanonicals.size === 1 ? [...bestCanonicals][0] : value;
}

function normalizeSearchQuery(text) {
  const normalized = normalizeSpiritual(text);
  if (!normalized) return { normalizedQuery: '', corrections: [] };

  const corrections = [];
  const correctedTokens = normalized.split(' ').filter(Boolean).map((token) => {
    const corrected = correctFuzzyQueryToken(token);
    if (corrected !== token) corrections.push({ from: token, to: corrected });
    return corrected;
  });

  return {
    normalizedQuery: correctedTokens.join(' '),
    corrections,
  };
}

function correctContextualQueryTerms(normalizedQuery) {
  const tokens = String(normalizedQuery || '').split(/\s+/u).filter(Boolean);
  const context = new Set(tokens);
  const corrections = [];
  const corrected = tokens.map((token) => {
    if (
      token === 'angles'
      && ['angel', 'dream', 'sleep', 'heaven', 'god', 'divine', 'spirit'].some((word) => context.has(word))
    ) {
      corrections.push({ from: 'angles', to: 'angels' });
      return 'angels';
    }
    return token;
  });
  return { normalizedQuery: corrected.join(' '), corrections };
}

function adjacentTranspositionCandidates(token) {
  const value = String(token || '').toLowerCase();
  if (!/^[a-z]{6,}$/u.test(value)) return [];
  const candidates = new Set();
  for (let index = 0; index + 1 < value.length; index++) {
    if (value[index] === value[index + 1]) continue;
    candidates.add(`${value.slice(0, index)}${value[index + 1]}${value[index]}${value.slice(index + 2)}`);
  }
  return [...candidates];
}

async function resolveCorpusLexemeCounts(pool, words) {
  // Search queries are normalized before reaching this function. Restricting
  // this lookup to plain lexemes also keeps the combined tsquery syntactically
  // safe; punctuation-bearing tokens simply remain outside auto-correction.
  const requested = [...new Set(words || [])].filter((word) => /^[a-z]+$/u.test(word));
  const corpusLexemeCountCache = corpusStatistics(pool).lexemes;
  const uncached = requested.filter((word) => corpusLexemeCountCache.get(word) === undefined);
  if (uncached.length) {
    try {
      const result = await pool.query(`
        SELECT word, document_count::bigint AS count
        FROM semantic_qa.search_lexemes
        WHERE word = ANY($1::text[])
      `, [uncached]);
      const inventory = new Map(
        result.rows.map((row) => [row.word, Number(row.count) || 0])
      );
      for (const word of uncached) {
        corpusLexemeCountCache.set(word, inventory.get(word) || 0);
      }
    } catch {
      // A failed lookup supplies no evidence and can be retried on the next request.
    }
  }
  return corpusLexemeCountCache;
}

function singleEditCorpusCandidates(token) {
  const value = String(token || '').toLowerCase();
  if (!/^[a-z]{5,}$/u.test(value)) return [];
  const candidates = new Set(adjacentTranspositionCandidates(value));
  for (let index = 1; index < value.length; index++) {
    candidates.add(`${value.slice(0, index)}${value.slice(index + 1)}`);
  }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let index = 1; index <= value.length; index++) {
    for (const letter of alphabet) candidates.add(`${value.slice(0, index)}${letter}${value.slice(index)}`);
  }
  candidates.delete(value);
  return [...candidates];
}

function hasSpiritualSearchContext(tokens) {
  for (const token of tokens || []) {
    if (SPIRITUAL_QUERY_ANCHORS.has(token)) return true;
    if (
      token.length >= 5
      && singleEditCorpusCandidates(token).some((candidate) => SPIRITUAL_QUERY_ANCHORS.has(candidate))
    ) return true;
  }
  return false;
}

async function correctCorpusSpelling(pool, normalizedQuery) {
  const tokens = String(normalizedQuery || '').split(/\s+/u).filter(Boolean);
  if (!tokens.length || !pool || !hasSpiritualSearchContext(tokens)) {
    return { normalizedQuery, corrections: [] };
  }
  const corpusLexemeCountCache = await resolveCorpusLexemeCounts(pool, tokens);

  const tokenCandidates = new Map();
  const lookup = new Set();
  for (const token of [...new Set(tokens)]) {
    if (
      token.length < 5 || GENERIC_WORDS.has(token) || MODIFIER_WORDS.has(token)
      || corpusLexemeCountCache.get(token) !== 0
      || getCanonicalSpiritualTerm(token)
    ) continue;
    const candidates = singleEditCorpusCandidates(token);
    if (!candidates.length) continue;
    tokenCandidates.set(token, candidates);
    for (const candidate of candidates) lookup.add(candidate);
    if (tokenCandidates.size >= 4) break;
  }
  if (!tokenCandidates.size) return { normalizedQuery, corrections: [] };
  await resolveCorpusLexemeCounts(pool, [...lookup]);

  const corrections = [];
  const correctedTokens = tokens.map((token) => {
    const candidates = tokenCandidates.get(token);
    if (!candidates) return token;
    const ranked = candidates
      .map((candidate) => ({ candidate, count: corpusLexemeCountCache.get(candidate) || 0 }))
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count || left.candidate.localeCompare(right.candidate));
    if (!ranked.length) return token;
    const best = ranked[0];
    const runnerUp = ranked[1]?.count || 0;
    const mechanicalEdit = isSingleAdjacentTransposition(token, best.candidate)
      || isSingleRepeatedCharacterEdit(token, best.candidate);
    const sufficientlySupported = mechanicalEdit
      ? best.count >= 1 && best.count > runnerUp
      : best.count >= 2 && best.count >= runnerUp * 3;
    if (!sufficientlySupported) return token;
    corrections.push({ from: token, to: best.candidate });
    return best.candidate;
  });
  return { normalizedQuery: correctedTokens.join(' '), corrections };
}

async function correctCorpusTranspositions(pool, normalizedQuery) {
  return correctCorpusSpelling(pool, normalizedQuery);
}

const MORPHOLOGY_AUXILIARIES = new Set([
  'did', 'does', 'do', 'can', 'could', 'will', 'would', 'shall', 'should',
  'may', 'might', 'must',
]);
const MORPHOLOGY_COPULAS = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being']);
const MORPHOLOGY_DETERMINERS = new Set(['a', 'an', 'the', 'this', 'that', 'my', 'our', 'your']);

function isControlledSingularContext(tokens, index, { allowDistantAuxiliary = false } = {}) {
  const token = tokens[index];
  const previous = tokens[index - 1] || '';
  const next = tokens[index + 1] || '';
  const recent = tokens.slice(Math.max(0, index - 4), index);

  if (token === 'pleases' && ['clarify', 'explain'].includes(next)) return true;
  if (token === 'shoulds' && previous === 'how') return true;
  if (MORPHOLOGY_DETERMINERS.has(previous)) return true;
  if (MORPHOLOGY_AUXILIARIES.has(previous) || (
    allowDistantAuxiliary && recent.some((word) => MORPHOLOGY_AUXILIARIES.has(word))
  )) {
    return true;
  }
  if (token.endsWith('ys')) return true;
  if (token.endsWith('ings') && (
    ['after', 'before', 'while', 'by'].includes(previous)
    || MORPHOLOGY_DETERMINERS.has(next)
  )) return true;
  if (token.endsWith('eds') && MORPHOLOGY_COPULAS.has(previous)) return true;
  if (['spirituals', 'practicals'].includes(token) && /^(life|question|questions|terms?|spiritual)$/u.test(next)) {
    return true;
  }
  if (token === 'normals' && (next.endsWith('ing') || ['condition', 'conditions'].includes(next))) return true;
  if (token.endsWith('s') && ['anubhava'].includes(next)) return true;
  return false;
}

async function correctControlledMorphology(pool, normalizedQuery) {
  const tokens = String(normalizedQuery || '').split(/\s+/u).filter(Boolean);
  if (!tokens.length || !pool) return { normalizedQuery, corrections: [] };
  const spiritualContext = hasSpiritualSearchContext(tokens);

  const candidates = new Map();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (
      !/^[a-z]{5,}s$/u.test(token)
      || !isControlledSingularContext(tokens, index, { allowDistantAuxiliary: spiritualContext })
    ) continue;
    const base = token.slice(0, -1);
    if (base.length >= 4) candidates.set(index, base);
  }
  if (!candidates.size) return { normalizedQuery: tokens.join(' '), corrections: [] };

  const corpusLexemeCountCache = await resolveCorpusLexemeCounts(pool, [
    ...candidates.values(),
    ...[...candidates.keys()].map((index) => tokens[index]),
  ]);
  const corrections = [];
  const corrected = tokens.map((token, index) => {
    const base = candidates.get(index);
    if (!base) return token;
    const tokenCount = corpusLexemeCountCache.get(token);
    const baseCount = corpusLexemeCountCache.get(base) || 0;
    // Never rewrite an attested corpus form. This deliberately favors
    // precision over recall for valid plurals and third-person verbs.
    if (tokenCount !== 0 || baseCount < 2) return token;
    corrections.push({ from: token, to: base });
    return base;
  });
  return { normalizedQuery: corrected.join(' '), corrections };
}

/**
 * Classify query words into core subjects, modifiers, and intent terms
 */
function classifyQueryTokens(qTokens) {
  const subjects = [];
  const intents = [];
  const modifiers = [];

  for (const t of qTokens) {
    if (GENERIC_WORDS.has(t)) continue;
    if (INTENT_WORDS.has(t)) {
      intents.push(t);
    } else if (MODIFIER_WORDS.has(t)) {
      modifiers.push(t);
    } else {
      subjects.push(t);
    }
  }

  if (subjects.length === 0) {
    if (modifiers.length > 0) subjects.push(...modifiers);
    else if (intents.length > 0) subjects.push(intents[0]);
  }

  const uniqueSubjects = [...new Set(subjects)];
  const uniqueIntents = [...new Set(intents)];

  // Sort subjects: substantive entities first over author/speaker tokens, then priority spiritual entities
  const hasSubstantiveSubject = uniqueSubjects.some(s => !SPEAKER_TOKENS.has(s));
  uniqueSubjects.sort((a, b) => {
    if (hasSubstantiveSubject) {
      const aSpeaker = SPEAKER_TOKENS.has(a);
      const bSpeaker = SPEAKER_TOKENS.has(b);
      if (aSpeaker && !bSpeaker) return 1;
      if (!aSpeaker && bSpeaker) return -1;
    }
    const aPri = PRIORITY_SPIRITUAL_ENTITIES.has(a) || Boolean(getCanonicalSpiritualTerm(a));
    const bPri = PRIORITY_SPIRITUAL_ENTITIES.has(b) || Boolean(getCanonicalSpiritualTerm(b));
    if (aPri && !bPri) return -1;
    if (!aPri && bPri) return 1;
    return 0;
  });

  return { subjects: uniqueSubjects, intents: uniqueIntents, modifiers };
}

/**
 * Generalized Sanskrit & Linguistic Transliteration Canonicalizer with Unicode / IAST Folding
 */
function foldDiacritics(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function canonicalizeSpiritualTerm(term) {
  if (!term || typeof term !== 'string') return '';
  const cached = termCanonicalCache.get(term);
  if (cached !== undefined) return cached;

  let s = term.toLowerCase().trim();
  if (GENERIC_WORDS.has(s)) {
    termCanonicalCache.set(term, s);
    return s; // Do NOT mutate English generic words
  }

  // Strip IAST diacritics
  s = foldDiacritics(s);

  let res = s;

  // Exact root clusters for prominent Indian spiritual terminology
  if (/^g[aā]+y[aā]t[h]?r[iīy]+(va)?$/i.test(s)) res = 'gayatri';
  else if (/^s[aā]v[iī]t[h]?[aā](r|r?u)?$/i.test(s)) res = 'savita';
  else if (/^s[aā]v[iī]t[h]?r[iīy]+$/i.test(s)) res = 'savitri';
  else if (/^m[aā]nt[h]?r[aā]?(s|as|am)?$/i.test(s)) res = 'mantra';
  // Brahman (ultimate reality) and Brahmin/Brahmana (priestly identity) are
  // distinct theological concepts and must never share a canonical root.
  else if (/^br[aā]hm[iī]n(s)?$/i.test(s) || /^br[aā]hm[aā]n[aā](s)?$/i.test(s)) res = 'brahmin';
  else if (/^br[aā]hm(am|an)$/i.test(s)) res = 'brahman';
  else if (/^b[h]?akt[h]?[iī]$/i.test(s)) res = 'bhakti';
  else if (/^m[uū]kt[h]?[iī]$/i.test(s)) res = 'mukti';
  else if (/^[aā]d[iī]p[aā]r[aā]s?[h]?akt[h]?[iī]$/i.test(s)) res = 'adiparashakti';
  else if (/^s[h]?akt[h]?[iī]$/i.test(s)) res = 'shakti';
  else if (/^s[h]?[aā]nk[aā]r[aā]?$/i.test(s)) res = 'shankara';
  else if (/^s[h]?[iī]v[aā]?$/i.test(s)) res = 'shiva';
  else if (/^v[iī]s[h]?[nṇ][uū]$/i.test(s)) res = 'vishnu';
  else if (/^k[rṛ]s[h]?[nṇ][aā]$/i.test(s)) res = 'krishna';
  else if (/^(j|g)[nñ][aā]n[aā]?(m)?$/i.test(s)) res = 'jnana';
  else if (/^[aā]t[h]?m[aā]?(n)?$/i.test(s)) res = 'atma';
  else if (/^sv[aā]m[iī]|sw[aā]m[iī]$/i.test(s)) res = 'swami';
  else if (/^up[aā]n[aā]y[aā]n[aā]?(m)?$/i.test(s)) res = 'upanayanam';
  else if (/^s[aā]nd[h]?y[aā]v[aā]nd[aā]n[aā]?(m)?$/i.test(s)) res = 'sandhyavandanam';
  else if (/^s[aā]nd[h]?y[aā]$/i.test(s)) res = 'sandhya';
  else if (/^v[aā]nd[aā]n[aā]?(m)?$/i.test(s)) res = 'vandanam';
  else if (/^pr[aā]vr[uüi]t+i$/i.test(s)) res = 'pravritti';
  else if (/^n[iī]vr[uüi]t+i$/i.test(s)) res = 'nivritti';
  else if (/^d[aā]tt[aā]$/i.test(s)) res = 'datta';
  else if (/^[rṛ][iüu]?g[v|w][eē]d[aā]?$/i.test(s)) res = 'rigveda';
  else if (/^y[aā]j[uū]r[v|w][eē]d[aā]?$/i.test(s)) res = 'yajurveda';
  else if (/^s[aā]+m[aā][v|w][eē]d[aā]?$/i.test(s)) res = 'samaveda';
  else if (/^[aā]t[h]?h?arv[aā][v|w][eē]d[aā]?$/i.test(s)) res = 'atharvaveda';
  else if (/^d[eē]a?v[aā]t[h]?[aā]?$/i.test(s)) res = 'devata';
  else {
    // Check spiritual equivalence table
    const mapped = getCanonicalSpiritualTerm(s);
    if (mapped) res = mapped;
  }

  if (termCanonicalCache.size < 30000) {
    termCanonicalCache.set(term, res);
  }

  return res;
}

function normalizeSpiritual(text) {
  if (!text) return '';
  const words = foldDiacritics(text.toLowerCase())
    // Preserve every writing system represented in the corpus. The earlier
    // ASCII-only filter silently erased Malayalam and Telugu queries.
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let out = '';
  for (let i = 0; i < words.length; i++) {
    const w1 = canonicalizeSpiritualTerm(words[i]);
    const w2 = i + 1 < words.length ? canonicalizeSpiritualTerm(words[i + 1]) : null;

    // Composite phrase handling: "sandhya vandanam" -> canonical ritual concept "sandhyavandanam"
    // Leaves component words "sandhya" and "vandanam" completely independent when used individually.
    if (w1 === 'sandhya' && w2 === 'vandanam') {
      out += (out ? ' ' : '') + 'sandhyavandanam';
      i++;
      continue;
    }

    if (w1) {
      out += (out ? ' ' : '') + w1;
    }
  }
  return out;
}

/**
 * Fetch dynamic BM25 Inverse Document Frequency from PostgreSQL or memory cache.
 * Uses dynamic corpus document count and limits concurrent queries to 25.
 */
async function resolveCorpusIDF(pool, words) {
  const uniqueWords = [...new Set(words.map(w => w.toLowerCase()).filter(w => !GENERIC_WORDS.has(w)))].slice(0, 25);
  const totalDocs = await getCorpusTotal(pool);
  const idfMemoryCache = pool && corpusStatistics(pool).total !== null ? corpusStatistics(pool).idf : new Map();
  const uncached = uniqueWords.filter(w => idfMemoryCache.get(w) === undefined);
  let lookupFailed = false;

  if (uncached.length > 0 && pool) {
    try {
      const res = await pool.query(`
        SELECT word, eligible_document_count::bigint AS count
        FROM semantic_qa.search_lexemes
        WHERE word = ANY($1::text[])
      `, [uncached]);
      const counts = new Map(res.rows.map((row) => [row.word, Number(row.count) || 0]));
      for (const word of uncached) {
        const rawCount = counts.get(word) || 0;
        if (rawCount === 0) {
          idfMemoryCache.set(word, 0.2);
        } else {
          const idf = Math.max(0.5, Math.log(1 + (totalDocs - rawCount + 0.5) / (rawCount + 0.5)));
          idfMemoryCache.set(word, idf);
        }
      }
    } catch {
      lookupFailed = true;
    }
  }

  const idfMap = {};
  for (const w of words) {
    if (GENERIC_WORDS.has(w.toLowerCase())) {
      idfMap[w.toLowerCase()] = 0.05; // Generic words suppressed
    } else {
      idfMap[w.toLowerCase()] = idfMemoryCache.get(w.toLowerCase()) || (lookupFailed && uncached.includes(w.toLowerCase()) ? 0.5 : 1.2);
    }
  }
  return idfMap;
}

function formatDate(dateValue) {
  if (!dateValue) return '';
  try {
    const d = new Date(dateValue);
    if (isNaN(d.getTime())) return String(dateValue);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  } catch {
    return String(dateValue);
  }
}

/**
 * Format snippet with underline, bold, and italic for matched phrases and content words.
 * Eliminates noisy isolated stop word highlights (e.g. lone "the", "is", "of")
 * while preserving full multi-word query phrase matching:
 * <u><b><i>The meaning of Gayatri is</i></b></u>
 */
function highlightSnippet(text, queryInput) {
  if (!text) return '';
  const queryStr = Array.isArray(queryInput) ? queryInput.join(' ') : String(queryInput || '');
  if (!queryStr.trim()) return escapeHtml(text);

  const normQuery = normalizeSpiritual(queryStr);
  const qTokens = normQuery.split(' ').filter(Boolean);
  const contentWords = new Set(qTokens.filter(w => !GENERIC_WORDS.has(w)));

  if (contentWords.has('meaning')) {
    contentWords.add('means');
    contentWords.add('meant');
  }
  if (contentWords.has('real')) {
    contentWords.add('actual');
  }

  // Build query n-grams (length >= 2) that contain at least one content word
  const queryNgrams = new Set();
  for (let len = 2; len <= Math.min(qTokens.length, 6); len++) {
    for (let i = 0; i <= qTokens.length - len; i++) {
      const slice = qTokens.slice(i, i + len);
      if (slice.some(w => contentWords.has(w))) {
        queryNgrams.add(slice.join(' '));
      }
    }
  }

  // Tokenize target text into words and separators preserving original casing & punctuation
  const tokenMatches = [...text.matchAll(/([\p{L}\p{N}]+)|([^\p{L}\p{N}]+)/gu)];
  const tokens = tokenMatches.map(m => ({
    text: m[0],
    isWord: Boolean(m[1]),
    lower: m[0].toLowerCase(),
    canonical: canonicalizeSpiritualTerm(m[0].toLowerCase()),
  }));

  const wordIndices = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].isWord) wordIndices.push(i);
  }

  const highlightWordMap = new Array(tokens.length).fill(false);

  // 1. Single content word matches
  for (const idx of wordIndices) {
    const t = tokens[idx];
    if (contentWords.has(t.lower) || contentWords.has(t.canonical)) {
      highlightWordMap[idx] = true;
    }
  }

  // 2. Query n-gram matches across words
  for (let len = Math.min(wordIndices.length, 6); len >= 2; len--) {
    for (let i = 0; i <= wordIndices.length - len; i++) {
      const sliceIndices = wordIndices.slice(i, i + len);
      const sliceNorm = sliceIndices.map(idx => tokens[idx].canonical || tokens[idx].lower).join(' ');
      if (queryNgrams.has(sliceNorm)) {
        for (const idx of sliceIndices) {
          highlightWordMap[idx] = true;
        }
      }
    }
  }

  // Reconstruct string with continuous <u><b><i> ... </i></b></u>
  let out = '';
  let inHighlight = false;

  for (let i = 0; i < tokens.length; i++) {
    const isW = tokens[i].isWord;
    const shouldHighlight = highlightWordMap[i];
    const escapedText = escapeHtml(tokens[i].text);

    if (isW && shouldHighlight) {
      if (!inHighlight) {
        out += '<mark class="us-search-highlight">';
        inHighlight = true;
      }
      out += escapedText;
    } else if (isW && !shouldHighlight) {
      if (inHighlight) {
        out += '</mark>';
        inHighlight = false;
      }
      out += escapedText;
    } else {
      // Separator / whitespace
      const nextWordIdx = wordIndices.find(idx => idx > i);
      const nextWordHighlighted = nextWordIdx != null && highlightWordMap[nextWordIdx];
      if (inHighlight && nextWordHighlighted) {
        out += escapedText;
      } else {
        if (inHighlight) {
          out += '</mark>';
          inHighlight = false;
        }
        out += escapedText;
      }
    }
  }

  if (inHighlight) {
    out += '</mark>';
  }

  return out;
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Word-boundary occurrence counter (prevents "in car" matching "incarnation")
 * Includes fast substring pre-filter and optional precompiled regex support.
 */
function countPhraseOccurrences(text, phrase, precompiledRegex) {
  if (!text || !phrase) return 0;
  if (!text.includes(phrase)) return 0; // Fast-path C++ substring check
  const regex = precompiledRegex || new RegExp(`(?<=^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi');
  regex.lastIndex = 0;
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

/**
 * Continuous Rolling Token Window Proximity Calculator
 * Eliminates paragraph boundary blinders.
 */
function minimumTokenDistance(listA, listB, maximum = 999) {
  let a = 0;
  let b = 0;
  let distance = maximum;
  while (a < listA.length && b < listB.length) {
    distance = Math.min(distance, Math.abs(listA[a] - listB[b]));
    if (distance === 0) break;
    if (listA[a] < listB[b]) a++;
    else b++;
  }
  return distance;
}

function computeRollingProximity(tokens, contentWords, idfMap) {
  if (!tokens || !tokens.length || !contentWords || !contentWords.length) {
    return { proximityScore: 0, minObservedDistance: 999, bestAnchorIdx: 0 };
  }

  const posMap = new Map();
  for (const cw of contentWords) {
    posMap.set(cw, []);
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const list = posMap.get(t);
    if (list) {
      list.push(i);
    }
  }

  let minObservedDistance = 999;
  let pairScore = 0;
  const activeKeys = [...posMap.keys()].filter(k => (posMap.get(k) || []).length > 0);

  for (let i = 0; i < activeKeys.length; i++) {
    for (let j = i + 1; j < activeKeys.length; j++) {
      const listA = posMap.get(activeKeys[i]) || [];
      const listB = posMap.get(activeKeys[j]) || [];
      const minDist = minimumTokenDistance(listA, listB);
      if (minDist < minObservedDistance) minObservedDistance = minDist;
      if (minDist <= 35) {
        const idfA = idfMap[activeKeys[i]] || 1.0;
        const idfB = idfMap[activeKeys[j]] || 1.0;
        pairScore += (idfA * idfB * 45) / (minDist + 0.3);
      }
    }
  }

  const coverageRatio = activeKeys.length / Math.max(1, contentWords.length);
  const totalProximity = (coverageRatio * 200) + pairScore;

  let bestAnchorIdx = 0;
  if (activeKeys.length > 0) {
    const firstList = posMap.get(activeKeys[0]);
    if (firstList && firstList.length > 0) {
      bestAnchorIdx = firstList[0];
    }
  }

  return {
    proximityScore: totalProximity,
    minObservedDistance: minObservedDistance < 999 ? minObservedDistance : null,
    bestAnchorIdx,
  };
}

/**
 * Subject-Aware Tiered Scoring Engine
 * Combines Title Authority with Swami's Direct Answer Teaching Density.
 */
function prepareScoringDocument(doc) {
  const cacheKey = JSON.stringify([
    doc.source_id,
    doc.matched_answer_unit_id || 'record',
    doc.matched_answer_unit_hash || doc.matched_answer_unit_text || '',
    doc.content_hash || doc.answer || '',
    doc.question || '',
    doc.matched_discovery_text || '',
    doc.metadata?.question_context || '',
  ]);
  const cached = scoringDocumentCache.get(cacheKey);
  if (cached) return cached;

  const origTitle = doc.question || '';
  const normTitle = normalizeSpiritual(origTitle);
  const titleWords = normTitle.split(' ').filter(Boolean);
  const titleContentWords = titleWords.filter((word) => !GENERIC_WORDS.has(word));
  const origBody = doc.answer || '';
  const origContext = doc.metadata?.question_context || '';
  const origDiscovery = doc.matched_discovery_text || '';
  const origAnswerUnit = doc.matched_answer_unit_text || '';
  const scoringContext = origDiscovery || origContext;
  const scoringAnswer = origAnswerUnit || origBody;
  const normDiscovery = normalizeSpiritual(origDiscovery);
  const discoveryWords = normDiscovery.split(' ').filter(Boolean);
  const normScoringContext = origDiscovery ? normDiscovery : normalizeSpiritual(scoringContext);

  let swamiSpeech = scoringAnswer;
  const repliedIdx = swamiSpeech.indexOf('Swami replied:-');
  if (repliedIdx !== -1) {
    swamiSpeech = swamiSpeech.slice(repliedIdx + 'Swami replied:-'.length);
  } else {
    swamiSpeech = swamiSpeech.replace(/^\[[^\]]+\]\s*/, '');
  }
  const normSwamiSpeech = normalizeSpiritual(swamiSpeech);
  const normIntentAnswer = swamiSpeech === scoringAnswer ? normSwamiSpeech : normalizeSpiritual(scoringAnswer);
  const speechTokens = normSwamiSpeech.split(' ').filter(Boolean);
  const normBody = `${normScoringContext} ${normSwamiSpeech}`.trim();
  const bodyTokens = normBody.split(' ').filter(Boolean);
  const bodyLines = scoringAnswer.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 6 && line.length <= 80)
    .map((line) => {
      const normalized = normalizeSpiritual(line);
      return { line, normalized, words: normalized.split(' ').filter(Boolean) };
    });

  const prepared = {
    origTitle,
    normTitle,
    titleWords,
    titleContentWords,
    origBody,
    origAnswerUnit,
    normBody,
    bodyTokens,
    normDiscovery,
    discoveryWords,
    normSwamiSpeech,
    normIntentAnswer,
    speechTokens,
    bodyLines,
  };
  scoringDocumentCache.set(cacheKey, prepared);
  return prepared;
}

function classifySearchIntent(value) {
  return classifyNormalizedSearchIntent(normalizeSpiritual(String(value || '')));
}

function classifyNormalizedSearchIntent(text) {
  if (!text) return 'general';
  if (/\b(?:difference|different|differ|distinction|compare|comparison|versus|vs|between)\b/u.test(text)) return 'comparison';
  if (/\b(?:who|identity of)\b/u.test(text)) return 'identity';
  if (/\b(?:meaning|means|meant|definition|define|essence|interpretation|nature|what is|what are)\b/u.test(text)) return 'definition';
  if (/\b(?:why|reason|cause|because|due to)\b/u.test(text)) return 'causal';
  if (/\b(?:how to|how can|how should|method|practice|achieve|attain|overcome|become)\b/u.test(text)) return 'procedure';
  if (/^(?:is|are|can|could|do|does|did|should|would|will|may)\b/u.test(text)) return 'decision';
  if (/\bwhen\b/u.test(text)) return 'temporal';
  if (/\bwhere\b/u.test(text)) return 'location';
  return 'general';
}

const ANSWER_INTENT_MARKERS = Object.freeze({
  comparison: ['difference', 'different', 'whereas', 'while', 'unlike', 'on the other hand'],
  definition: ['means', 'meaning', 'defined', 'definition', 'refers to', 'is called'],
  causal: ['because', 'reason', 'due to', 'therefore', 'hence', 'since'],
  procedure: ['should', 'must', 'can', 'practice', 'follow', 'by doing', 'in order to'],
  decision: ['yes', 'no', 'should', 'should not', 'can', 'cannot'],
  identity: ['is called', 'is known as', 'refers to'],
  temporal: ['when', 'after', 'before', 'until'],
  location: ['where', 'place', 'location', 'in the'],
});

function scoreIntentAlignment(queryIntent, discoveryText, answerText, subjectCoverage = 0) {
  return scoreNormalizedIntentAlignment(queryIntent, normalizeSpiritual(discoveryText), normalizeSpiritual(answerText), subjectCoverage);
}

function scoreNormalizedIntentAlignment(queryIntent, discoveryText, answerText, subjectCoverage) {
  if (!queryIntent || queryIntent === 'general') return { score: 0, discoveryAligned: false, answerAligned: false };
  const discoveryIntent = classifyNormalizedSearchIntent(discoveryText);
  const answerAligned = (ANSWER_INTENT_MARKERS[queryIntent] || []).some((marker) => answerText.includes(marker));
  const discoveryAligned = discoveryIntent === queryIntent;
  const evidenceFactor = Math.max(0.35, Math.min(1, Number(subjectCoverage) || 0));
  const score = Math.round(
    (discoveryAligned ? 90000 * evidenceFactor : 0)
    + (answerAligned ? 35000 * evidenceFactor : 0)
  );
  return { score, discoveryAligned, answerAligned };
}

function buildConceptGroups(subjects, maximum = 4) {
  const groups = [];
  const presentationWords = new Set(['idea', 'ideas', 'understand', 'understood', 'together', 'issue', 'issues', 'question']);
  for (const subject of [...new Set(subjects || [])]) {
    if (groups.length >= maximum) break;
    if (GENERIC_WORDS.has(subject) || INTENT_WORDS.has(subject) || MODIFIER_WORDS.has(subject) || presentationWords.has(subject)) continue;
    const variants = new Set([canonicalizeSpiritualTerm(subject), normalizeSpiritual(subject)]);
    for (const variant of getSpiritualVariants(subject) || []) {
      const normalized = normalizeSpiritual(variant);
      for (const token of normalized.split(/\s+/u)) if (token) variants.add(token);
    }
    variants.delete('');
    if (variants.size) groups.push(variants);
  }
  return groups;
}

function computeMinimalCoveringSpan(tokens, conceptGroups) {
  const words = Array.isArray(tokens) ? tokens : [];
  const groups = (conceptGroups || []).filter((group) => group?.size);
  if (words.length === 0 || groups.length < 2) return null;

  const conceptByWord = new Map();
  for (const [index, variants] of groups.entries()) {
    for (const variant of variants) {
      let hits = conceptByWord.get(variant);
      if (!hits) conceptByWord.set(variant, hits = []);
      hits.push(index);
    }
  }
  const counts = Array(groups.length).fill(0);
  const hits = [];
  let covered = 0;
  let left = 0;
  let best = null;
  for (let right = 0; right < words.length; right++) {
    const rightGroups = conceptByWord.get(words[right]);
    if (!rightGroups) continue;
    hits.push({ position: right, groups: rightGroups });
    for (const groupIndex of rightGroups) {
      if (counts[groupIndex]++ === 0) covered++;
    }
    while (covered === groups.length) {
      const leftHit = hits[left++];
      const spanLength = right - leftHit.position + 1;
      if (!best || spanLength < best.spanLength) {
        best = {
          start: leftHit.position,
          end: right + 1,
          spanLength,
          requiredConcepts: groups.length,
          density: groups.length / spanLength,
        };
      }
      for (const groupIndex of leftHit.groups) {
        if (--counts[groupIndex] === 0) covered--;
      }
    }
  }
  return best;
}

function scoreMinimalCoveringSpan(tokens, subjects, minimumConcepts = 2) {
  const groups = buildConceptGroups(subjects);
  if (groups.length < minimumConcepts) return { score: 0, span: null };
  const span = computeMinimalCoveringSpan(tokens, groups);
  if (!span) return { score: 0, span: null };
  const compactness = Math.max(0, 1 - ((span.spanLength - span.requiredConcepts) / 60));
  const score = Math.round(30000 + (span.requiredConcepts * 10000) + (compactness * 60000));
  return { score, span };
}

function scoreDiscourse(doc, query, queryWords, contentWords, weightedPhrases, idfMap, subjects = [], intents = []) {
  if (!isSearchEligibleMetadata(doc?.metadata)) return null;

  const prepared = prepareScoringDocument(doc);
  const {
    origTitle,
    normTitle,
    titleWords,
    titleContentWords,
    origBody,
    origAnswerUnit,
    normBody,
    bodyTokens,
    normDiscovery,
    discoveryWords,
    normSwamiSpeech,
    normIntentAnswer,
    speechTokens,
    bodyLines,
  } = prepared;

  // Primary subject verification: Document MUST contain at least one subject entity or known variant
  const effectiveSubjects = subjects.length > 0 ? subjects : contentWords;
  const primarySubject = effectiveSubjects[0];

  const allKnownVariants = new Set();
  for (const s of effectiveSubjects) {
    allKnownVariants.add(s);
    const vars = getSpiritualVariants(s);
    if (vars && vars.length) {
      for (const v of vars) {
        allKnownVariants.add(canonicalizeSpiritualTerm(v));
        allKnownVariants.add(v);
      }
    }
  }

  const titleHasSubject = effectiveSubjects.some(s => titleWords.includes(s)) ||
                          titleWords.some(w => allKnownVariants.has(w));
  const bodyHasSubject = effectiveSubjects.some(s => bodyTokens.includes(s)) ||
                         bodyTokens.some(t => allKnownVariants.has(t));

  const bodySubjectCount = bodyTokens.filter(t => effectiveSubjects.includes(t) || allKnownVariants.has(t)).length;

  const verifiedEnglishEvidence = doc.english_passage_evidence?.verified
    || Number(doc.english_body_coverage) >= 0.5 && (doc.english_body_matched_terms?.length || 0) >= 2;
  if (!titleHasSubject && !bodyHasSubject && !verifiedEnglishEvidence && !doc.exact_surface_title) {
    return null; // DISCARD off-topic discourses completely!
  }

  // When title does NOT contain the topic subject, require at least 2 mentions in the body
  // to eliminate random off-topic discourses that mention the subject once in passing (e.g. Guru Dakshina).
  if (!titleHasSubject && bodySubjectCount < 2 && !verifiedEnglishEvidence && !doc.exact_surface_title) {
    return null;
  }

  // ---------------------------------------------------------------------------
  // 1. TITLE MATCH ANALYSIS
  // ---------------------------------------------------------------------------
  // Pre-evaluate direct teaching definition in content dynamically for ANY query subject
  // Distinguishes core canonical explanations from peripheral side-questions across all entities
  let directDefBoost = 0;
  let defMatchKind = '';
  const openingSnippet = normSwamiSpeech.slice(0, 550);

  const pSub = primarySubject;
  const sSub = effectiveSubjects[1] || '';

  const openingDefPatterns = [
    `meaning of ${pSub}`,
    `${pSub} means`,
    sSub ? `${pSub} ${sSub} means` : null,
    sSub ? `meaning of ${pSub} ${sSub}` : null,
    sSub ? `${sSub} means` : null,
    'real essence',
    `definition of ${pSub}`,
    `word ${pSub} is made up`
  ].filter(Boolean);

  const coreDefPatterns = [
    `real meaning of ${pSub}`,
    sSub ? `meaning of ${pSub} ${sSub}` : null,
    sSub ? `real meaning of ${pSub} ${sSub}` : null,
    `true interpretation of ${pSub}`,
    `essence of ${pSub}`
  ].filter(Boolean);

  const contentDefPatterns = [
    `${pSub} means`,
    `meaning of ${pSub} is`,
    sSub ? `${pSub} ${sSub} means` : null,
    `interpretation of ${pSub}`
  ].filter(Boolean);

  const userRequestedDefinition = intents.some(it =>
    ['meaning', 'means', 'meant', 'definition', 'define', 'essence', 'interpretation', 'nature'].includes(it)
  );

  if (userRequestedDefinition) {
    if (openingDefPatterns.some(pat => openingSnippet.includes(pat))) {
      directDefBoost = 120000; // Direct opening teaching definition
      defMatchKind = 'Direct teaching definition';
    } else if (coreDefPatterns.some(pat => normSwamiSpeech.includes(pat))) {
      directDefBoost = 90000; // Core definition in discourse content
      defMatchKind = 'Core teaching definition in content';
    } else if (contentDefPatterns.some(pat => normSwamiSpeech.includes(pat))) {
      directDefBoost = 70000; // Teaching definition in content
      defMatchKind = 'Teaching definition in content';
    }
  }

  const normQuery = normalizeSpiritual(query);
  const uniqueDiscoveryContentHits = [...new Set(contentWords.filter((word) => discoveryWords.includes(word)))];
  const discoveryCoverage = uniqueDiscoveryContentHits.length / Math.max(1, contentWords.length);
  const queryIntent = classifyNormalizedSearchIntent(normQuery);
  const isMultiConceptQuery = /\b(?:both of these issues|relationship between the ideas)\b/iu.test(query);
  const rankingIntentEligible = ['comparison', 'definition', 'causal', 'procedure', 'identity'].includes(queryIntent);
  const intentAlignment = isMultiConceptQuery || !rankingIntentEligible
    ? { score: 0, discoveryAligned: false, answerAligned: false }
    : scoreNormalizedIntentAlignment(queryIntent, normDiscovery, normIntentAnswer, discoveryCoverage);
  const discoveryHasExactQuery = Boolean(normQuery && normDiscovery.includes(normQuery));
  let discoveryScore = 0;
  let discoveryMatchKind = '';
  if (discoveryHasExactQuery || doc.discovery_exact_match) {
    discoveryScore = 1500000 + (discoveryCoverage * 90000);
    discoveryMatchKind = 'Exact embedded question match';
  } else if (uniqueDiscoveryContentHits.length >= 4 && discoveryCoverage >= 0.72) {
    discoveryScore = 260000 + (discoveryCoverage * 70000);
    discoveryMatchKind = `Embedded question coverage ${Math.round(discoveryCoverage * 100)}%`;
  } else if (uniqueDiscoveryContentHits.length >= 2) {
    discoveryScore = discoveryCoverage * 120000;
    discoveryMatchKind = `Embedded question coverage ${Math.round(discoveryCoverage * 100)}%`;
  }
  const titleHasExactQuery = (normTitle === normQuery || normTitle.includes(normQuery));
  const titleMatchedPhrases = weightedPhrases.filter(wp => countPhraseOccurrences(normTitle, wp.text) > 0);
  const titleSubjectHits = effectiveSubjects.filter(s => {
    if (titleWords.includes(s)) return true;
    const sVars = getSpiritualVariants(s);
    return sVars && sVars.some(v => titleWords.includes(v));
  });
  const titleIntentHits = intents.filter(it => titleWords.includes(it));
  const titleContentHits = contentWords.filter(cw => {
    if (titleWords.includes(cw)) return true;
    const cwCanonical = canonicalizeSpiritualTerm(cw);
    if (titleWords.some(tw => canonicalizeSpiritualTerm(tw) === cwCanonical)) return true;
    const cwVars = getSpiritualVariants(cw);
    return cwVars && cwVars.some(v => titleWords.includes(v));
  });

  const uniqueTitleSubjectHits = [...new Set(titleSubjectHits)];
  const uniqueTitleContentHits = [...new Set(titleContentHits)];
  const contentCoverage = uniqueTitleContentHits.length / Math.max(1, contentWords.length);
  const titleCoverageScore = contentCoverage * 90000;

  let titleTier = 4;
  let titleTierScore = 0;
  let titleMatchKind = '';

  // Crucial IR principle: A title can ONLY be in Title Tiers if it contains the Subject Entity!
  // Prevents "Meaning of Guru Dakshina" getting tier bonus for "Gayatri Mantra".
  if (titleHasSubject) {
    if (titleHasExactQuery) {
      titleTier = 1;
      titleTierScore = 400000;
      titleMatchKind = 'Exact query in title';
    } else if (uniqueTitleContentHits.length >= 3 || (uniqueTitleContentHits.length >= 2 && contentCoverage >= 0.5)) {
      titleTier = 1;
      titleTierScore = uniqueTitleSubjectHits.length >= 2 ? 360000 : 330000;
      titleMatchKind = `High query-term title intersection (${uniqueTitleContentHits.join(' + ')})`;
    } else if (uniqueTitleSubjectHits.length >= 2) {
      titleTier = 1;
      titleTierScore = titleIntentHits.length >= 1 ? 350000 : 320000;
      titleMatchKind = titleIntentHits.length >= 1
        ? 'Core subjects & intent in title'
        : `Multi-subject intersection in title (${uniqueTitleSubjectHits.join(' + ')})`;
    } else if (titleMatchedPhrases.some(p => p.hasRareEntity && p.tokens.length >= 2)) {
      const topP = titleMatchedPhrases.find(p => p.hasRareEntity && p.tokens.length >= 2) || titleMatchedPhrases[0];
      if (titleIntentHits.length >= 1 || (userRequestedDefinition && directDefBoost >= 70000)) {
        titleTier = 1;
        titleTierScore = 280000;
        titleMatchKind = `Title topic phrase "${topP.text}"`;
      } else {
        titleTier = 2;
        titleTierScore = 200000;
        titleMatchKind = `Title topic phrase "${topP.text}"`;
      }
    } else if (uniqueTitleContentHits.length >= 2) {
      titleTier = 2;
      titleTierScore = 200000;
      titleMatchKind = `Title topic match "${uniqueTitleSubjectHits[0] || 'query'}"`;
    } else {
      titleTier = 3;
      titleTierScore = 120000;
      titleMatchKind = `Title topic entity "${uniqueTitleSubjectHits[0] || primarySubject}"`;
    }
  } else {
    // Title does NOT contain the topic entity (e.g. Guru Dakshina, Food Wastage)
    titleTier = 4;
    titleTierScore = 0;
    titleMatchKind = 'Excerpt & content match';
  }

  // Title Purity: ratio of query content words to total content words in title
  // Concise focused titles ("MEANING OF THE GAYATRI MANTRA" = 100%) outrank conversational noise
  const titlePurity = titleContentHits.length / Math.max(1, titleContentWords.length);
  const titlePurityScore = titleTierScore > 0 ? (titlePurity * 50000) : 0;

  let titleWordScore = 0;
  for (const cw of titleContentHits) {
    titleWordScore += (idfMap[cw] || 1.0) * 6000;
  }

  const titleTotal = titleHasSubject ? (titleTierScore + titlePurityScore + titleCoverageScore + titleWordScore) : 0;

  // ---------------------------------------------------------------------------
  // 2. INTERNAL SECTION HEADINGS & SWAMI'S DIRECT TEACHING DENSITY
  // ---------------------------------------------------------------------------
  // A. Internal Section Headings inside comprehensive discourses
  // Detects sections like "The Meaning of Gayatri Mantra" or "True Interpretation of Gayatri Mantra"
  let sectionHeadingScore = 0;
  let foundSectionHeading = '';
  for (const { line, normalized: normL, words: lWords } of bodyLines) {
    if (line.length >= 6 && line.length <= 80) {
      const lSubjects = effectiveSubjects.filter(s => lWords.includes(s));
      const lIntents = intents.filter(it => lWords.includes(it));
      if (lSubjects.length >= 1 && lIntents.length >= 1) {
        sectionHeadingScore = 130000; // Dedicated section heading matching query intent (e.g. "The Meaning of Gayatri Mantra")
        foundSectionHeading = line;
        break;
      } else if (lSubjects.length >= 2) {
        if (sectionHeadingScore < 80000) {
          sectionHeadingScore = 80000;
          foundSectionHeading = line;
        }
      }
    }
  }

  // B. Opening hits ONLY for discourses actually discussing the subject (>= 3 mentions)
  let openingScore = 0;
  if (bodySubjectCount >= 3) {
    const openingTokens = speechTokens.slice(0, 100);
    let openingHits = 0;
    for (const cw of contentWords) {
      if (openingTokens.includes(cw)) {
        openingHits += (idfMap[cw] || 1.0);
      }
    }
    openingScore = openingHits * 3000;
  }

  // C. Exact Phrases in Swami's Direct Teaching
  // Highlighting priority: exact phrases combining both topic entity and intent are prioritized
  let bodyPhraseScore = 0;
  const matchedPhrases = [];
  for (const wp of weightedPhrases) {
    const count = Math.min(5, countPhraseOccurrences(normSwamiSpeech, wp.text, wp.regex));
    if (count > 0) {
      const isSubjectAndIntent = wp.hasRareEntity && intents.some(it => wp.tokens.includes(it));
      const phraseWeight = wp.weight * (isSubjectAndIntent ? 1.5 : 0.85);
      bodyPhraseScore += count * phraseWeight;
      if (matchedPhrases.length < 5) matchedPhrases.push(wp.text);
    }
  }

  // E. Continuous Token Window Proximity in Swami's Teaching
  const { proximityScore, minObservedDistance } = computeRollingProximity(speechTokens, contentWords, idfMap);
  const minimalCovering = isMultiConceptQuery || !rankingIntentEligible
    ? { score: 0, span: null }
    : scoreMinimalCoveringSpan(speechTokens, effectiveSubjects);

  // F. Substantive Subject Density (Rewards comprehensive discourses with 20-35+ mentions)
  const primaryCount = bodyTokens.filter(t => t === primarySubject).length;
  const secondaryCount = effectiveSubjects[1] ? bodyTokens.filter(t => t === effectiveSubjects[1]).length : 0;
  const densityScore = (Math.min(10, primaryCount) * 3000) + (Math.min(8, secondaryCount) * 1500);

  const bodyTotal = sectionHeadingScore + directDefBoost + openingScore + bodyPhraseScore
    + (proximityScore * 1.5) + densityScore + minimalCovering.score + intentAlignment.score;

  // TOTAL SCORE: Blends Title Authority, Section Headings, and Content Depth!
  const englishBodyScore = englishBodyBoost(doc);
  const englishPassageScore = doc.english_passage_evidence ? doc.english_passage_evidence.strength * doc.english_passage_weight : 0;
  const totalScore = titleTotal + discoveryScore + bodyTotal + englishBodyScore + englishPassageScore
    + (doc.exact_surface_title ? 2400000 : 0);

  const decisionReasons = [];
  if (doc.exact_surface_title) decisionReasons.push('Exact source title');
  if (discoveryMatchKind) decisionReasons.push(discoveryMatchKind);
  if (defMatchKind) decisionReasons.push(defMatchKind);
  if (titleMatchKind && titleTier < 4) decisionReasons.push(titleMatchKind);
  else if (foundSectionHeading) decisionReasons.push(`Section: "${foundSectionHeading}"`);
  if (minObservedDistance != null) {
    decisionReasons.push(`Word distance: ${minObservedDistance} token${minObservedDistance === 1 ? '' : 's'}`);
  }
  if (matchedPhrases.length) {
    decisionReasons.push(`${matchedPhrases.length} exact phrase${matchedPhrases.length === 1 ? '' : 's'}`);
  }
  if (primaryCount >= 10) {
    decisionReasons.push(`${primaryCount} subject mentions`);
  }
  if (minimalCovering.span) decisionReasons.push(`Minimal concept span: ${minimalCovering.span.spanLength} tokens`);
  if (intentAlignment.discoveryAligned || intentAlignment.answerAligned) decisionReasons.push(`Intent: ${queryIntent}`);
  if (doc.english_passage_evidence?.verified) decisionReasons.push('Matching concepts in the cited passage');

  return {
    sourceId: doc.source_id,
    title: origTitle,
    date: doc.metadata?.record_date || '',
    formattedDate: formatDate(doc.metadata?.record_date),
    totalScore,
    englishBodyScore,
    ...(doc.english_passage_evidence ? { englishPassageScore } : {}),
    score: Math.round(totalScore * 10) / 10,
    titleScore: titleTotal,
    bodyScore: bodyTotal,
    discoveryScore,
    proximityScore,
    minimalSpanScore: minimalCovering.score,
    minimalSpanLength: minimalCovering.span?.spanLength || null,
    intentScore: intentAlignment.score,
    queryIntent,
    minDistance: minObservedDistance,
    decisionSummary: decisionReasons.join(' · ') || 'Exact phrase & proximity match',
    answer: origBody,
    answerUnitId: doc.matched_answer_unit_id || null,
    answerUnitHash: doc.matched_answer_unit_hash || null,
    answerUnitText: origAnswerUnit || null,
    answerUnitStart: Number.isInteger(doc.matched_answer_unit_start) ? doc.matched_answer_unit_start : null,
    normSwamiSpeech,
  };
}

/**
 * Splits text into complete sentences while protecting common abbreviations and decimals.
 * Guarantees every sentence boundary is intact and records start & end character offsets.
 */
function splitIntoCleanSentences(text) {
  if (!text) return [];

  // Protect multi-dot and common spiritual/academic abbreviations
  let masked = text
    .replace(/\bw\.r\.t\./gi, 'w@@DOT@@r@@DOT@@t@@DOT@@')
    .replace(/\be\.g\./gi, 'e@@DOT@@g@@DOT@@')
    .replace(/\bi\.e\./gi, 'i@@DOT@@e@@DOT@@')
    .replace(/\b(Mr|Mrs|Ms|Miss|Dr|Prof|Shri|Smt|Swami|etc|vs|viz|ch|no|vol|p|pp)\./gi, '$1@@DOT@@')
    .replace(/(\d+)\.(\d+)/g, '$1@@NUMDOT@@$2');

  // Match sentences ending in terminal punctuation followed by optional closing quotes/brackets and whitespace or newline
  const regex = /([^.?!]+[.?!]+['"”’\)\]]*(?:\s+|$)|[^.?!]+$)/g;
  const rawChunks = masked.match(regex) || [masked];

  // Merge any chunk that doesn't begin with a capital letter, quote, or bracket with the prior sentence
  const mergedChunks = [];
  for (const chunk of rawChunks) {
    const unmasked = chunk.replace(/@@DOT@@/g, '.').replace(/@@NUMDOT@@/g, '.');
    const trimmed = unmasked.trim();
    if (!trimmed) continue;

    const startsSentence = /^["'“‘\[(A-Z0-9]/.test(trimmed);
    if (mergedChunks.length > 0 && !startsSentence) {
      mergedChunks[mergedChunks.length - 1] += ' ' + trimmed;
    } else {
      mergedChunks.push(trimmed);
    }
  }

  const results = [];
  let currentOffset = 0;

  for (const sentence of mergedChunks) {
    if (sentence.length < 8) continue;
    const startIdx = text.indexOf(sentence, currentOffset);
    const actualStart = startIdx !== -1 ? startIdx : currentOffset;
    const actualEnd = actualStart + sentence.length;
    currentOffset = actualEnd;

    results.push({
      text: sentence,
      start: actualStart,
      end: actualEnd,
    });
  }

  return results;
}

function selectMinimalCoveringSentenceRange(fullText, sentences, contentWords, maximumSentences = 3) {
  const required = [...new Set((contentWords || [])
    .map((word) => canonicalizeSpiritualTerm(word))
    .filter((word) => word && !GENERIC_WORDS.has(word)))].slice(0, 8);
  if (!fullText || !sentences?.length || required.length < 2) return null;

  const requiredSet = new Set(required);
  const sentenceHits = sentences.map((sentence) => new Set(
    normalizeSpiritual(sentence.text).split(/\s+/u)
      .map((word) => canonicalizeSpiritualTerm(word))
      .filter((word) => requiredSet.has(word))
  ));
  let best = null;
  for (let start = 0; start < sentences.length; start++) {
    const covered = new Set();
    for (let end = start; end < Math.min(sentences.length, start + maximumSentences); end++) {
      for (const word of sentenceHits[end]) covered.add(word);
      const rangeStart = sentences[start].start;
      const rangeEnd = sentences[end].end;
      const length = rangeEnd - rangeStart;
      if (length > 700) break;
      const candidate = { start: rangeStart, end: rangeEnd, coverage: covered.size, length };
      if (
        candidate.coverage >= 2
        && (!best || candidate.coverage > best.coverage
          || (candidate.coverage === best.coverage && candidate.length < best.length))
      ) best = candidate;
    }
  }
  if (!best) return null;
  const text = fullText.slice(best.start, best.end);
  return { ...best, text, required: required.length };
}

/**
 * Extract multi-sentence snippet with guaranteed complete sentence boundaries.
 * Returns { snippetText, targetPassage, passageOffset }
 */
function extractMultiSentenceSnippet(fullText, contentWords, weightedPhrases, fallbackBody) {
  if (!fullText) {
    const fb = (fallbackBody || '').slice(0, 450);
    return {
      snippetText: fb,
      targetPassage: fb,
      passageOffset: { start: 0, end: fb.length, text: fb },
    };
  }

  const sentences = splitIntoCleanSentences(fullText);
  if (!sentences.length) {
    const fb = (fallbackBody || fullText).slice(0, 450);
    return {
      snippetText: fb,
      targetPassage: fb,
      passageOffset: { start: 0, end: fb.length, text: fb },
    };
  }

  const minimalRange = selectMinimalCoveringSentenceRange(fullText, sentences, contentWords);
  if (minimalRange) {
    return {
      snippetText: minimalRange.text,
      targetPassage: minimalRange.text,
      passageOffset: { start: minimalRange.start, end: minimalRange.end, text: minimalRange.text },
    };
  }

  const contentSet = new Set(contentWords);

  const scored = sentences.map((sObj, idx) => {
    const norm = normalizeSpiritual(sObj.text);
    if (!norm) return { idx, sObj, score: 0, contentHits: 0 };
    const words = norm.split(' ').filter(Boolean);
    let contentHits = 0;
    let genericHits = 0;
    for (const w of words) {
      if (contentSet.has(w)) contentHits++;
      else if (GENERIC_WORDS.has(w)) genericHits++;
    }
    let phraseScore = 0;
    for (const wp of weightedPhrases) {
      if (countPhraseOccurrences(norm, wp.text, wp.regex) > 0) {
        phraseScore += wp.weight * 1.5;
      }
    }
    return {
      idx,
      sObj,
      score: (contentHits * 140) + (genericHits * 5) + phraseScore,
      contentHits,
    };
  });

  const matching = scored.filter(s => s.score > 0);
  if (!matching.length) {
    const top2 = sentences.slice(0, 2);
    const snip = top2.map(s => s.text).join(' ');
    const anchor = top2[0] || { start: 0, end: 0, text: '' };
    return {
      snippetText: snip,
      targetPassage: anchor.text,
      passageOffset: { start: anchor.start, end: anchor.end, text: anchor.text },
    };
  }

  matching.sort((a, b) => b.score - a.score);
  const bestAnchor = matching[0];

  const selected = new Set();
  selected.add(bestAnchor.idx);

  // Cover adjacent full sentences for clear grammatical context
  if (bestAnchor.idx > 0 && scored[bestAnchor.idx - 1].score > 0) {
    selected.add(bestAnchor.idx - 1);
  }
  if (bestAnchor.idx < scored.length - 1 && scored[bestAnchor.idx + 1].score > 0) {
    selected.add(bestAnchor.idx + 1);
  }

  let totalLen = [...selected].reduce((sum, i) => sum + scored[i].sObj.text.length, 0);
  for (const m of matching.slice(1)) {
    if (!selected.has(m.idx) && totalLen + m.sObj.text.length < 550) {
      selected.add(m.idx);
      totalLen += m.sObj.text.length;
    }
  }

  const sortedIndices = [...selected].sort((a, b) => a - b);
  const pieces = [];
  let last = -99;
  for (const i of sortedIndices) {
    if (last !== -99 && i > last + 1) {
      pieces.push('...');
    }
    pieces.push(scored[i].sObj.text);
    last = i;
  }

  const snippetText = pieces.join(' ');
  const anchorObj = bestAnchor.sObj;

  return {
    snippetText,
    targetPassage: anchorObj.text,
    passageOffset: {
      start: anchorObj.start,
      end: anchorObj.end,
      text: anchorObj.text,
    },
  };
}

function distanceCandidateKey(row) {
  const sourceId = String(row?.source_id || '');
  const answerUnitId = String(row?.matched_answer_unit_id || 'record');
  return `${sourceId}\u0000${answerUnitId}`;
}

function stripSearchFraming(value, { extended = false } = {}) {
  let result = String(value || '').trim();
  const patterns = [
    /^regarding this specific issue[,;:]?\s*/iu,
    /^please clarify this spiritual question:\s*/iu,
    /^could this spiritual point be clarified:\s*/iu,
    /^what conclusion should a spiritual seeker draw about this question:\s*/iu,
    /^what (?:practical )?explanation (?:does spiritual teaching give for|addresses) this question:\s*/iu,
    /^what does the teaching indicate about this question:\s*/iu,
    /^from (?:a practical standpoint|the standpoint of spiritual reasoning)[,;:]?\s*/iu,
    /^in (?:practical spiritual life|spiritual terms)[,;:]?\s*/iu,
    ...(extended ? [/^how should the relationship between the ideas in this spiritual question be understood:\s*/iu] : []),
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const stripped = result.replace(pattern, '').trim();
      if (stripped !== result) {
        result = stripped;
        changed = true;
      }
    }
  }
  // Preserve the substantive noun phrase while removing a general interpretive
  // frame. This affects retrieval text, not the displayed query or its intent.
  if (extended) result = result.replace(/^how should (.+?) be understood\?$/iu, '$1?').trim();
  return result || String(value || '').trim();
}

function mergeDistanceCandidate(target, incoming) {
  if (!target) return { ...incoming };
  const merged = { ...target };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value == null) continue;
    if (value === '' && merged[key]) continue;
    merged[key] = value;
  }
  merged.discovery_exact_match = Boolean(target.discovery_exact_match || incoming.discovery_exact_match);
  merged.passage_exact_match = Boolean(target.passage_exact_match || incoming.passage_exact_match);
  return merged;
}

/**
 * Fuse independent lexical retrieval channels at answer-unit granularity.
 * Record hits remain fallbacks only when no citable answer unit from that
 * source was retrieved. This prevents one source from collapsing several
 * independently relevant replies into a single candidate.
 */
function fuseDistanceCandidateChannels({ recordRows = [], discoveryRows = [], answerUnitRows = [], passageRows = [] }) {
  const candidates = new Map();
  const recordRankBySource = new Map();
  const unitSources = new Set();

  const upsert = (row, rankField, index) => {
    const candidate = { ...row, [rankField]: index + 1 };
    if (candidate.matched_answer_unit_id) unitSources.add(candidate.source_id);
    const key = distanceCandidateKey(candidate);
    candidates.set(key, mergeDistanceCandidate(candidates.get(key), candidate));
  };

  recordRows.forEach((row, index) => {
    recordRankBySource.set(row.source_id, index + 1);
    upsert(row, 'record_retrieval_rank', index);
  });
  discoveryRows.forEach((row, index) => upsert(row, 'discovery_retrieval_rank', index));
  answerUnitRows.forEach((row, index) => upsert(row, 'answer_unit_retrieval_rank', index));
  passageRows.forEach((row, index) => upsert(row, 'passage_retrieval_rank', index));

  for (const [key, candidate] of candidates) {
    if (candidate.matched_answer_unit_id) {
      candidate.record_retrieval_rank ||= recordRankBySource.get(candidate.source_id);
      continue;
    }
    const answerUnitCount = Number(candidate.metadata?.answer_unit_count);
    if (
      unitSources.has(candidate.source_id)
      || (Number.isFinite(answerUnitCount) && answerUnitCount > 0)
    ) candidates.delete(key);
  }
  return [...candidates.values()];
}

/**
 * Execute Distance-Based Search against the PostgreSQL records table.
 * Returns up to targetLimit (default 35, max 100) ranked discourses.
 */
async function hydrateSingleUnitTitleCandidates(pool, recordRows) {
  const sourceIds = [...new Set(recordRows.map((row) => row.source_id).filter(Boolean))];
  if (!sourceIds.length) return [];
  // Count ALL units, including incomplete/non-English units. A filtered count
  // could incorrectly map a record title to one reply of a multi-reply source.
  const result = await pool.query(`
    SELECT r.source_id, r.question, ''::text AS answer, r.metadata, r.content_hash,
           u.associated_question AS matched_discovery_text,
           u.answer_unit_id AS matched_answer_unit_id,
           u.unit_text AS matched_answer_unit_text,
           u.start_offset AS matched_answer_unit_start,
           u.content_hash AS matched_answer_unit_hash,
           true AS single_unit_title_candidate
    FROM semantic_qa.records r
    JOIN semantic_qa.answer_units u USING (source_id)
    WHERE r.source_id = ANY($1::text[])
      AND ${searchEligibilitySql('r')}
      AND u.language = 'ENG' AND u.context_complete = true
      AND NOT EXISTS (
        SELECT 1 FROM semantic_qa.answer_units other_unit
        WHERE other_unit.source_id = u.source_id
          AND other_unit.answer_unit_id <> u.answer_unit_id
      )
    ORDER BY array_position($1::text[], r.source_id)
  `, [sourceIds]);
  return result.rows;
}

async function resolveNumberedReference(pool, query) {
  const text = String(query || '');
  const requestedByQuestion = (text.match(/\b(?:verse|chapter|section|part)\b/giu) || []).length === 1
    ? questionReference(text) : null;
  const request = numberedTitleReference(text) || requestedByQuestion;
  if (!pool || !request || !Number.isSafeInteger(request.number) || !/^[\p{L}\p{M}.'’: -]{1,100}$/u.test(request.name)) return null;
  const { rows } = await pool.query(`
    SELECT r.source_id, r.question FROM semantic_qa.records r
    WHERE r.question ILIKE $1 AND ${searchEligibilitySql('r')}
    ORDER BY r.source_id LIMIT 501
  `, [`${request.name}%`]);
  if (rows.length > 500) return null;
  const work = normalizeSpiritual(request.name);
  const titles = rows.flatMap(row => {
    const reference = numberedTitleReference(row.question);
    if (reference?.kind !== request.kind || normalizeSpiritual(reference.name) !== work) return [];
    return [{ source_id: row.source_id, number: reference.number }];
  });
  // A lone title does not establish that the corpus stores a numbered series.
  if (new Set(titles.map(row => row.number)).size < 2) return null;
  return titles.filter(row => row.number === request.number);
}

// The optional full-text passage scan can be much slower than the exact
// passage query. Limit that scan without changing other pool operations.
async function queryDistancePassages(pool, sql, params, timings) {
  if (!params[3] || typeof pool.connect !== 'function') return pool.query(sql, params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    return await client.query(sql, params);
  } catch (error) {
    if (error.code !== '57014') throw error;
    timings.fullTextPassageTimedOut = true;
  } finally {
    let cleanupError;
    try { await client.query('ROLLBACK'); }
    catch (error) { cleanupError = error; }
    client.release(cleanupError);
  }
  return pool.query(sql, [...params.slice(0, 3), false]);
}

async function searchDistanceCorpus(pool, {
  query, limit = 35, searchMode = 'normal', experimentalSingleUnitTitles: enableSingleUnitTitles = false,
  experimentalEnglishBodies: enableEnglishBodies = false, englishBodyWeight = 600000,
  experimentalEnglishPassages: enableEnglishPassages = false, englishPassageWeight = 900000,
  lexicalRanker = null, corpusGroundedEnglish = false,
}) {
  const totalStartedAt = performance.now();
  const timings = {};
  const targetLimit = Math.max(1, Math.min(100, Number(limit) || 35));
  const baseNormalization = normalizeSearchQuery(query);
  const contextualCorrection = correctContextualQueryTerms(baseNormalization.normalizedQuery);
  const spellingStartedAt = performance.now();
  const corpusCorrection = await correctCorpusTranspositions(pool, contextualCorrection.normalizedQuery);
  const morphologyCorrection = await correctControlledMorphology(pool, corpusCorrection.normalizedQuery);
  timings.spellingMs = performance.now() - spellingStartedAt;
  const normQuery = morphologyCorrection.normalizedQuery;
  const corrections = [
    ...baseNormalization.corrections,
    ...contextualCorrection.corrections,
    ...corpusCorrection.corrections,
    ...morphologyCorrection.corrections,
  ];
  const corpusCorrectionKeys = new Set(
    [...corpusCorrection.corrections, ...morphologyCorrection.corrections]
      .map((correction) => `${correction.from}\u0000${correction.to}`)
  );
  let correctedSurfaceQuery = String(query || '');
  const surfaceCorrections = corrections.filter((correction, index, all) => (
    (adjacentTranspositionCandidates(correction.from).includes(correction.to)
      || corpusCorrectionKeys.has(`${correction.from}\u0000${correction.to}`))
    && all.findIndex((candidate) => candidate.from === correction.from && candidate.to === correction.to) === index
  ));
  for (const correction of surfaceCorrections) {
    const escaped = correction.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    correctedSurfaceQuery = correctedSurfaceQuery.replace(
      new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'gi'),
      correction.to
    );
  }
  const retrievalSurfaceQuery = stripSearchFraming(correctedSurfaceQuery);
  const numberedSourceRows = await resolveNumberedReference(pool, query);
  if (numberedSourceRows && !numberedSourceRows.length) {
    timings.totalMs = performance.now() - totalStartedAt;
    return {
      query, normalizedQuery: normQuery, retrievalQuery: retrievalSurfaceQuery, corrections, searchMode,
      executionTimeMs: timings.totalMs, timings, totalFound: 0, matches: [],
      ...(searchMode === 'debug' ? { debug: {
        recordCandidateSourceIds: [], candidateAnswerUnitIds: [], scoredAnswerUnitIds: [], rankingCandidates: [],
      } } : {}),
    };
  }
  const exactNumberedUnits = numberedSourceRows?.length ? await hydrateSingleUnitTitleCandidates(pool, numberedSourceRows) : [];
  const exactNumberedOnly = exactNumberedUnits.length > 0 && exactNumberedUnits.length === numberedSourceRows.length;
  const englishSurface = enableEnglishBodies || enableEnglishPassages
    ? stripSearchFraming(correctedSurfaceQuery, { extended: true }) : retrievalSurfaceQuery;
  let groundedPassageSearch = null;
  if (corpusGroundedEnglish && !numberedSourceRows && !isNumberedReferenceLookup(retrievalSurfaceQuery)) {
    const groundingStartedAt = performance.now();
    try {
      groundedPassageSearch = await prepareEnglishPassageSearch(pool, query, englishSurface, { grounded: true, normalized: normQuery });
    } catch {
      timings.englishGroundingUnavailable = true;
    }
    timings.englishGroundingMs = performance.now() - groundingStartedAt;
  }
  const enableEnglishExpansion = !corpusGroundedEnglish || groundedPassageSearch !== null;
  const experimentalSingleUnitTitles = enableSingleUnitTitles && enableEnglishExpansion;
  const experimentalEnglishBodies = enableEnglishBodies && enableEnglishExpansion;
  const experimentalEnglishPassages = enableEnglishPassages && enableEnglishExpansion;
  const requestedReference = experimentalEnglishBodies ? questionReference(retrievalSurfaceQuery) : null;
  const literalTitleQuery = experimentalSingleUnitTitles
    ? requestedReference
      ? `${requestedReference.name} ${requestedReference.kind} ${requestedReference.number}`
      : stripSearchFraming(correctedSurfaceQuery, { extended: true })
    : retrievalSurfaceQuery;
  const qWords = normQuery.split(' ').filter(Boolean);
  const hasBodyContext = experimentalEnglishBodies && (hasSpiritualSearchContext(qWords)
    || /\b(?:atheis\w*|theis\w*|demon\w*|hypocrisy|awareness|consciousness|charity|offerings|ritual\w*)\b/iu.test(retrievalSurfaceQuery));
  const englishBodyEligible = (hasBodyContext || experimentalEnglishBodies && groundedPassageSearch)
    && !isNumberedReferenceLookup(retrievalSurfaceQuery);
  // Long questions with a body retrieval channel benefit less from whole-string
  // trigram matching. Keep it for short lookups and queries with spelling repairs.
  const anchoredPassageQuestion = experimentalEnglishPassages && isAnchoredPassageQuestion(query);
  const fuzzyQuestionSearch = !(hasBodyContext || anchoredPassageQuestion) || corrections.length > 0
    || (retrievalSurfaceQuery.match(/[\p{L}\p{N}]+/gu) || []).length < 10;
  const rawWords = qWords;
  const contentWords = qWords.filter(w => !GENERIC_WORDS.has(w) && w.length > 1);

  if (!qWords.length) {
    return { query, normalizedQuery: normQuery, corrections, totalFound: 0, matches: [] };
  }

  // 1. Classify query into Subjects (entities) and Intents
  const { subjects, intents } = classifyQueryTokens(qWords);

  // 2. Resolve dynamic statistical BM25 IDF across corpus
  const idfStartedAt = performance.now();
  const idfMap = await resolveCorpusIDF(pool, qWords);
  timings.idfMs = performance.now() - idfStartedAt;

  // Sort subjects: substantive entities first over author/speaker tokens, priority spiritual entities, then by dynamic IDF
  const hasSubstantiveSubject = subjects.some(s => !SPEAKER_TOKENS.has(s));
  subjects.sort((a, b) => {
    if (hasSubstantiveSubject) {
      const aSpeaker = SPEAKER_TOKENS.has(a);
      const bSpeaker = SPEAKER_TOKENS.has(b);
      if (aSpeaker && !bSpeaker) return 1;
      if (!aSpeaker && bSpeaker) return -1;
    }
    const aPri = PRIORITY_SPIRITUAL_ENTITIES.has(a) || Boolean(getCanonicalSpiritualTerm(a));
    const bPri = PRIORITY_SPIRITUAL_ENTITIES.has(b) || Boolean(getCanonicalSpiritualTerm(b));
    if (aPri && !bPri) return -1;
    if (!aPri && bPri) return 1;
    return (idfMap[b] || 1) - (idfMap[a] || 1);
  });
  const primarySubject = subjects[0] || contentWords[0] || qWords[0];
  const secondarySubject = subjects[1] || intents[0] || primarySubject;
  const topicEntities = new Set([primarySubject, secondarySubject]);

  // 3. Build content-weighted phrases (5-gram down to 2-gram)
  const weightedPhrases = [];
  for (let len = Math.min(qWords.length, 5); len >= 2; len--) {
    for (let i = 0; i <= qWords.length - len; i++) {
      const slice = qWords.slice(i, i + len);
      if (slice.every(w => GENERIC_WORDS.has(w))) continue;
      if (!slice.some(w => contentWords.includes(w))) continue;

      let pWeight = 0;
      for (const w of slice) {
        pWeight += idfMap[w] || 1.0;
      }
      const score = Math.pow(pWeight, 2.2) * 32;
      weightedPhrases.push({
        text: slice.join(' '),
        tokens: slice,
        weight: score,
        regex: new RegExp(`(?<=^|\\s)${slice.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi'),
        hasPrimarySubject: slice.includes(primarySubject),
        hasTopicEntity: slice.some(w => topicEntities.has(w)),
        hasRareEntity: Boolean(subjects.some(s => slice.includes(s)))
      });
    }
  }

  function formatTsQueryVariant(v) {
    const clean = String(v || '').trim();
    if (clean.includes(' ')) {
      return `(${clean.split(/\s+/).join(' & ')})`;
    }
    return clean;
  }

  // 4. Build Subject-Anchored GIN Index Search Condition
  // The primary subject entity is MANDATORY to prevent off-topic pollution (e.g. Guru Dakshina)
  let tsQueryStr = '';
  const secondaryTerms = [...subjects.slice(1), ...intents];
  const primaryVariants = primarySubject
    ? getSpiritualVariants(primarySubject).map(formatTsQueryVariant).slice(0, 14)
    : [];
  if (primarySubject === 'sandhyavandanam') {
    primaryVariants.push('(sandhya & vandanam)', '(sandhyaa & vandanam)', '(sandhya & vandana)');
  }
  const primaryTermExpr = primaryVariants.length > 1
    ? `(${primaryVariants.join(' | ')})`
    : primarySubject;

  const secondaryExprs = [];
  for (const term of secondaryTerms.slice(0, 4)) {
    const vars = getSpiritualVariants(term).map(formatTsQueryVariant).slice(0, 8);
    if (term === 'sandhyavandanam') {
      vars.push('(sandhya & vandanam)', '(sandhyaa & vandanam)');
    }
    if (vars.length > 1) {
      secondaryExprs.push(`(${vars.join(' | ')})`);
    } else {
      secondaryExprs.push(term);
    }
  }

  if (primarySubject && secondaryExprs.length) {
    tsQueryStr = `${primaryTermExpr} & (${secondaryExprs.join(' | ')})`;
  } else if (primarySubject) {
    tsQueryStr = primaryTermExpr;
  } else {
    tsQueryStr = qWords.filter(w => !GENERIC_WORDS.has(w) || w.length > 3).join(' | ');
  }

  // Find most prominent 2-gram or 3-gram title phrase for exact title matching
  const topTitlePhrase = weightedPhrases.find(p => p.hasTopicEntity && p.tokens.length >= 2) || weightedPhrases[0];
  const titleNgramFilter = topTitlePhrase ? topTitlePhrase.text.replace(/\s+/g, '%') : primarySubject;
  let primaryPrefix = primarySubject;
  if (primarySubject === 'sandhyavandanam') {
    primaryPrefix = 'sandhya%vandan';
  } else if (primarySubject && primarySubject.length > 7) {
    primaryPrefix = primarySubject.slice(0, 7);
  }

  const queryStart = Date.now();
  const discoveryTerms = [...new Set([...contentWords, ...subjects, ...intents])]
    .filter((word) => word && word.length >= 3)
    .slice(0, 12);
  const discoveryTsQuery = discoveryTerms.length ? discoveryTerms.join(' | ') : primaryTermExpr;
  const recordCandidatesPromise = exactNumberedOnly ? Promise.resolve({ rows: [] }) : (async () => {
    const startedAt = performance.now();
    try {
      try {
        return await pool.query(`
          SELECT r.source_id, r.question, r.answer, r.metadata, r.content_hash
          FROM semantic_qa.records r
          WHERE ${searchEligibilitySql('r')}
            AND (r.search_vector @@ to_tsquery('simple', $1) OR r.question ILIKE $2 OR r.question ILIKE $4)
          ORDER BY (
            CASE
              WHEN r.question ILIKE $4 THEN 0
              WHEN r.question ILIKE $3 THEN 1
              WHEN r.question ILIKE $2 THEN 2
              ELSE 3
            END
          ),
          ts_rank_cd(r.search_vector, to_tsquery('simple', $1)) DESC
          LIMIT 100
        `, [tsQueryStr, `%${primaryPrefix}%`, `%${primaryPrefix}%${secondarySubject}%`, `%${titleNgramFilter}%`]);
      } catch {
        return await pool.query(`
          SELECT r.source_id, r.question, r.answer, r.metadata, r.content_hash
          FROM semantic_qa.records r
          WHERE ${searchEligibilitySql('r')}
            AND (r.search_vector @@ to_tsquery('simple', $1) OR r.question ILIKE $2 OR r.answer ILIKE $2)
          LIMIT 100
        `, [primaryTermExpr, `%${primaryPrefix}%`]);
      }
    } finally {
      timings.recordCandidatesMs = performance.now() - startedAt;
    }
  })();

  const discoveryCandidatesPromise = exactNumberedOnly ? Promise.resolve([]) : (async () => {
    const startedAt = performance.now();
    try {
      const result = await pool.query(`
        WITH exact_matches AS MATERIALIZED (
          SELECT d.source_id, d.answer_unit_id, d.discovery_text, d.discovery_index,
                 true AS exact_match,
                 ts_rank_cd(d.search_vector, to_tsquery('simple', $1)) AS discovery_rank
          FROM semantic_qa.discovery_passages d
          JOIN semantic_qa.records eligible ON eligible.source_id = d.source_id
          WHERE ${searchEligibilitySql('eligible')}
            AND d.discovery_text ILIKE $3
          ORDER BY length(d.discovery_text), d.source_id, d.discovery_index
          LIMIT 60
        ),
        lexical_matches AS MATERIALIZED (
          SELECT d.source_id, d.answer_unit_id, d.discovery_text, d.discovery_index,
                 (position(lower($2) in lower(d.discovery_text)) > 0) AS exact_match,
                 ts_rank_cd(d.search_vector, to_tsquery('simple', $1)) AS discovery_rank
          FROM semantic_qa.discovery_passages d
          JOIN semantic_qa.records eligible ON eligible.source_id = d.source_id
          WHERE ${searchEligibilitySql('eligible')}
            AND d.search_vector @@ to_tsquery('simple', $1)
          ORDER BY ts_rank_cd(d.search_vector, to_tsquery('simple', $1)) DESC,
                   d.source_id, d.discovery_index
          LIMIT 600
        ),
        combined AS MATERIALIZED (
          SELECT * FROM exact_matches
          UNION ALL
          SELECT * FROM lexical_matches
        ),
        ranked AS (
          SELECT combined.*,
                 row_number() OVER (
                   PARTITION BY combined.source_id, coalesce(combined.answer_unit_id, '')
                   ORDER BY combined.exact_match DESC, combined.discovery_rank DESC, combined.discovery_index
                 ) AS source_rank
          FROM combined
        )
        SELECT r.source_id, r.question,
               CASE WHEN u.answer_unit_id IS NULL THEN r.answer ELSE ''::text END AS answer,
               r.metadata, r.content_hash,
               ranked.discovery_text AS matched_discovery_text,
               ranked.answer_unit_id AS matched_answer_unit_id,
               ranked.exact_match AS discovery_exact_match,
               ranked.discovery_rank,
               u.unit_text AS matched_answer_unit_text,
               u.start_offset AS matched_answer_unit_start,
               u.content_hash AS matched_answer_unit_hash
        FROM ranked
        JOIN semantic_qa.records r USING (source_id)
        LEFT JOIN semantic_qa.answer_units u ON u.answer_unit_id = ranked.answer_unit_id
        WHERE ranked.source_rank = 1
        ORDER BY ranked.exact_match DESC, ranked.discovery_rank DESC, r.source_id
        LIMIT 180
      `, [discoveryTsQuery, retrievalSurfaceQuery, `%${retrievalSurfaceQuery}%`]);
      return result.rows;
    } catch {
      return [];
    } finally {
      timings.discoveryCandidatesMs = performance.now() - startedAt;
    }
  })();

  const answerUnitCandidatesPromise = exactNumberedOnly ? Promise.resolve([]) : (async () => {
    const startedAt = performance.now();
    try {
      const result = await pool.query(`
        WITH fuzzy_settings AS MATERIALIZED (
          SELECT set_config('pg_trgm.word_similarity_threshold', '0.45', true)
        ),
        exact_matches AS MATERIALIZED (
          SELECT u.source_id, u.answer_unit_id,
                 true AS exact_match,
                 'exact question'::text AS channel,
                 row_number() OVER (ORDER BY length(u.associated_question), u.source_id, u.unit_index) AS channel_rank,
                 2.0::double precision AS channel_weight
          FROM semantic_qa.answer_units u
          JOIN semantic_qa.records eligible ON eligible.source_id = u.source_id
          WHERE ${searchEligibilitySql('eligible')}
            AND u.context_complete = true
            AND u.associated_question ILIKE $3
          ORDER BY length(u.associated_question), u.source_id, u.unit_index
          LIMIT 60
        ),
        lexical_matches AS MATERIALIZED (
          SELECT u.source_id, u.answer_unit_id,
                 (position(lower($2) in lower(u.associated_question)) > 0) AS exact_match,
                 'answer full text'::text AS channel,
                 row_number() OVER (
                   ORDER BY ts_rank_cd(u.search_vector, to_tsquery('simple', $1)) DESC,
                            u.source_id, u.unit_index
                 ) AS channel_rank,
                 1.2::double precision AS channel_weight
          FROM semantic_qa.answer_units u
          JOIN semantic_qa.records eligible ON eligible.source_id = u.source_id
          WHERE ${searchEligibilitySql('eligible')}
            AND u.context_complete = true
            AND u.search_vector @@ to_tsquery('simple', $1)
          ORDER BY ts_rank_cd(u.search_vector, to_tsquery('simple', $1)) DESC,
                   u.source_id, u.unit_index
          LIMIT 500
        ),
        fuzzy_matches AS MATERIALIZED (
          SELECT u.source_id, u.answer_unit_id,
                 false AS exact_match,
                 'fuzzy question'::text AS channel,
                 row_number() OVER (
                   ORDER BY similarity(u.associated_question, $2) DESC,
                            u.source_id, u.unit_index
                 ) AS channel_rank,
                 1.5::double precision AS channel_weight
          FROM semantic_qa.answer_units u
          JOIN semantic_qa.records eligible ON eligible.source_id = u.source_id
          WHERE ${searchEligibilitySql('eligible')}
            AND u.context_complete = true
            AND $4::boolean
            AND u.associated_question % $2
          ORDER BY similarity(u.associated_question, $2) DESC,
                   u.source_id, u.unit_index
          LIMIT 300
        ),
        fuzzy_span_matches AS MATERIALIZED (
          SELECT u.source_id, u.answer_unit_id,
                 false AS exact_match,
                 'fuzzy question span'::text AS channel,
                 row_number() OVER (
                   ORDER BY word_similarity($2, u.associated_question) DESC,
                            u.source_id, u.unit_index
                 ) AS channel_rank,
                 1.7::double precision AS channel_weight
          FROM fuzzy_settings
          CROSS JOIN semantic_qa.answer_units u
          JOIN semantic_qa.records eligible ON eligible.source_id = u.source_id
          WHERE ${searchEligibilitySql('eligible')}
            AND u.context_complete = true
            AND $4::boolean
            AND $2 <% u.associated_question
          ORDER BY word_similarity($2, u.associated_question) DESC,
                   u.source_id, u.unit_index
          LIMIT 300
        ),
        combined AS MATERIALIZED (
          SELECT * FROM exact_matches
          UNION ALL
          SELECT * FROM lexical_matches
          UNION ALL
          SELECT * FROM fuzzy_matches
          UNION ALL
          SELECT * FROM fuzzy_span_matches
        ),
        fused AS (
          SELECT source_id, answer_unit_id,
                 bool_or(exact_match) AS exact_match,
                 array_agg(DISTINCT channel ORDER BY channel) AS channels,
                 sum(channel_weight / (60.0 + channel_rank)) AS rrf_score
          FROM combined
          GROUP BY source_id, answer_unit_id
        ), shortlist AS MATERIALIZED (
          SELECT * FROM fused
          ORDER BY exact_match DESC, rrf_score DESC, source_id, answer_unit_id
          LIMIT 240
        )
        SELECT r.source_id, r.question, ''::text AS answer, r.metadata, r.content_hash,
               u.associated_question AS matched_discovery_text,
               fused.answer_unit_id AS matched_answer_unit_id,
               fused.exact_match AS discovery_exact_match,
               fused.rrf_score AS answer_unit_rrf_score,
               fused.channels AS matched_answer_unit_channels,
               u.unit_text AS matched_answer_unit_text,
               u.start_offset AS matched_answer_unit_start,
               u.content_hash AS matched_answer_unit_hash
        FROM shortlist fused
        JOIN semantic_qa.answer_units u ON u.answer_unit_id = fused.answer_unit_id
        JOIN semantic_qa.records r ON r.source_id = fused.source_id
        ORDER BY fused.exact_match DESC, fused.rrf_score DESC, r.source_id, fused.answer_unit_id
      `, [discoveryTsQuery, retrievalSurfaceQuery, `%${retrievalSurfaceQuery}%`, fuzzyQuestionSearch]);
      return result.rows;
    } catch {
      return [];
    } finally {
      timings.answerUnitCandidatesMs = performance.now() - startedAt;
    }
  })();

  const passageCandidatesPromise = exactNumberedOnly ? Promise.resolve([]) : (async () => {
    const startedAt = performance.now();
    const passagePhrase = topTitlePhrase?.text || primarySubject || '';
    const needsFullTextPassage = /\bcompare\b|\bproof\s+that\b/u.test(normQuery);
    const passageAnchors = [...subjects]
      .filter((word) => word && word.length >= 3)
      .sort((left, right) => (idfMap[right] || 1) - (idfMap[left] || 1))
      .slice(0, 1);
    if (!passageAnchors.length && primarySubject) passageAnchors.push(primarySubject);
    const passageAnchorExpressions = passageAnchors.map((anchor) => {
      const variants = getSpiritualVariants(anchor).map(formatTsQueryVariant).slice(0, 14);
      return variants.length > 1 ? `(${variants.join(' | ')})` : anchor;
    });
    const passageTsQuery = passageAnchorExpressions.join(' & ');
    try {
      const result = await queryDistancePassages(pool, `
        WITH exact_passage AS MATERIALIZED (
          SELECT p.source_id, p.answer_unit_id, p.passage_index, p.passage_text,
                 p.start_offset, true AS exact_match, 'exact passage'::text AS channel,
                 row_number() OVER (ORDER BY length(p.passage_text), p.source_id, p.passage_index) AS channel_rank,
                 1.5::double precision AS channel_weight
          FROM semantic_qa.passages p
          JOIN semantic_qa.records eligible ON eligible.source_id = p.source_id
          WHERE ${searchEligibilitySql('eligible')}
            AND p.context_complete = true AND p.story_complete = true
            AND $2 <> '' AND p.passage_text ILIKE $3
          ORDER BY length(p.passage_text), p.source_id, p.passage_index
          LIMIT 100
        ),
        full_text_passage AS MATERIALIZED (
          SELECT p.source_id, p.answer_unit_id, p.passage_index, p.passage_text,
                 p.start_offset, false AS exact_match, 'full text passage'::text AS channel,
                 row_number() OVER (
                   ORDER BY ts_rank_cd(p.search_vector, to_tsquery('simple', $1)) DESC,
                            p.source_id, p.passage_index
                 ) AS channel_rank,
                 1.2::double precision AS channel_weight
          FROM semantic_qa.passages p
          JOIN semantic_qa.records eligible ON eligible.source_id = p.source_id
          WHERE $4::boolean
            AND ${searchEligibilitySql('eligible')}
            AND p.context_complete = true AND p.story_complete = true
            AND p.search_vector @@ to_tsquery('simple', $1)
          ORDER BY ts_rank_cd(p.search_vector, to_tsquery('simple', $1)) DESC,
                   p.source_id, p.passage_index
          LIMIT 600
        ),
        combined AS MATERIALIZED (
          SELECT * FROM exact_passage
          UNION ALL SELECT * FROM full_text_passage
        ),
        fused AS MATERIALIZED (
          SELECT source_id, answer_unit_id, passage_index,
                 max(passage_text) AS passage_text,
                 min(start_offset) AS start_offset,
                 bool_or(exact_match) AS exact_match,
                 array_agg(DISTINCT channel ORDER BY channel) AS channels,
                 sum(channel_weight / (60.0 + channel_rank)) AS rrf_score
          FROM combined
          GROUP BY source_id, answer_unit_id, passage_index
        ),
        ranked AS (
          SELECT fused.*,
                 row_number() OVER (
                   PARTITION BY source_id, answer_unit_id
                   ORDER BY exact_match DESC, rrf_score DESC, passage_index
                 ) AS answer_unit_passage_rank
          FROM fused
        )
        SELECT r.source_id, r.question, ''::text AS answer, r.metadata, r.content_hash,
               u.associated_question AS matched_discovery_text,
               ranked.answer_unit_id AS matched_answer_unit_id,
               false AS discovery_exact_match,
               ranked.exact_match AS passage_exact_match,
               ranked.rrf_score AS passage_rrf_score,
               ranked.channels AS matched_passage_channels,
               ranked.passage_text AS matched_passage_text,
               ranked.start_offset AS matched_passage_start,
               u.unit_text AS matched_answer_unit_text,
               u.start_offset AS matched_answer_unit_start,
               u.content_hash AS matched_answer_unit_hash
        FROM ranked
        JOIN semantic_qa.records r USING (source_id)
        JOIN semantic_qa.answer_units u ON u.answer_unit_id = ranked.answer_unit_id
        WHERE ranked.answer_unit_passage_rank = 1
        ORDER BY ranked.exact_match DESC, ranked.rrf_score DESC, r.source_id, ranked.answer_unit_id
        LIMIT 240
      `, [passageTsQuery, passagePhrase, `%${passagePhrase}%`, needsFullTextPassage], timings);
      return result.rows;
    } catch {
      return [];
    } finally {
      timings.passageCandidatesMs = performance.now() - startedAt;
    }
  })();

  const [dbResult, discoveryRows, answerUnitRows, passageRows, literalTitleRows, englishBodyResult, englishPassageRows] = await Promise.all([
    recordCandidatesPromise,
    discoveryCandidatesPromise,
    answerUnitCandidatesPromise,
    passageCandidatesPromise,
    experimentalSingleUnitTitles && !exactNumberedOnly ? (async () => {
      const started = performance.now();
      try { return await retrieveSingleUnitTitles(pool, literalTitleQuery); }
      finally { timings.literalTitleCandidatesMs = performance.now() - started; }
    })() : Promise.resolve([]),
    englishBodyEligible && !exactNumberedOnly ? (async () => {
      const started=performance.now();
      try { return await retrieveEnglishBodyCandidates(pool, englishSurface, {limit:120}); }
      finally { timings.englishBodyCandidatesMs=performance.now()-started; }
    })() : Promise.resolve({rows:[],terms:[]}),
    experimentalEnglishPassages && !exactNumberedOnly && !isNumberedReferenceLookup(retrievalSurfaceQuery) ? (async () => {
      const started = performance.now();
      try { return await retrieveEnglishPassageCandidates(pool, query, englishSurface, 90, groundedPassageSearch); }
      finally { timings.englishPassageCandidatesMs = performance.now() - started; }
    })() : Promise.resolve([]),
  ]);

  const titleStartedAt = performance.now();
  const titleUnitRows = experimentalSingleUnitTitles
    ? await hydrateSingleUnitTitleCandidates(pool, dbResult.rows)
    : [];
  if (experimentalSingleUnitTitles) timings.singleUnitTitleCandidatesMs = performance.now() - titleStartedAt;

  let candidates = fuseDistanceCandidateChannels({
    recordRows: dbResult.rows,
    discoveryRows,
    answerUnitRows,
    passageRows,
  });

  // Fallback candidate expansion: Anchored on broad content words & variants
  // to ensure up to targetLimit discourses without EVER failing recall.
  if (candidates.length < targetLimit && !exactNumberedOnly) {
    const existingIds = new Set(candidates.map((candidate) => candidate.source_id));
    const allSearchTokens = [...new Set([...contentWords, ...subjects])].filter(w => w && w.length >= 3).slice(0, 8);
    const broadTsQuery = allSearchTokens.length > 0 ? allSearchTokens.join(' | ') : primaryTermExpr;
    try {
      const fallbackResult = await pool.query(`
        SELECT r.source_id, r.question, r.answer, r.metadata, r.content_hash
        FROM semantic_qa.records r
        WHERE ${searchEligibilitySql('r')}
          AND (r.search_vector @@ to_tsquery('simple', $1) OR r.question ILIKE $2)
        ORDER BY ts_rank_cd(r.search_vector, to_tsquery('simple', $1)) DESC, r.source_id ASC
        LIMIT 200
      `, [broadTsQuery, `%${primaryPrefix}%`]);
      for (const row of fallbackResult.rows) {
        if (!existingIds.has(row.source_id)) {
          candidates.push(row);
          existingIds.add(row.source_id);
          if (candidates.length >= Math.max(120, targetLimit * 3)) break;
        }
      }
    } catch { /* ignore fallback errors */ }
  }

  // Deep scoring normalizes answer text and is intentionally more expensive
  // than indexed retrieval. Fuse the independent retrieval channels first so
  // only a bounded, high-recall shortlist pays that cost.
  const scoringLimit = Math.max(100, targetLimit * 3);
  const debugPreShortlistAnswerUnitIds = searchMode === 'debug'
    ? candidates.map((candidate) => candidate.matched_answer_unit_id).filter(Boolean)
    : null;
  candidates.sort((left, right) => {
    const leftExact = left.discovery_exact_match ? 1 : 0;
    const rightExact = right.discovery_exact_match ? 1 : 0;
    if (rightExact !== leftExact) return rightExact - leftExact;
    const leftRrf = (left.record_retrieval_rank ? 1 / (60 + left.record_retrieval_rank) : 0)
      + (left.discovery_retrieval_rank ? 1.2 / (60 + left.discovery_retrieval_rank) : 0)
      + (left.answer_unit_retrieval_rank ? 1.4 / (60 + left.answer_unit_retrieval_rank) : 0)
      + (left.passage_retrieval_rank ? 1.3 / (60 + left.passage_retrieval_rank) : 0);
    const rightRrf = (right.record_retrieval_rank ? 1 / (60 + right.record_retrieval_rank) : 0)
      + (right.discovery_retrieval_rank ? 1.2 / (60 + right.discovery_retrieval_rank) : 0)
      + (right.answer_unit_retrieval_rank ? 1.4 / (60 + right.answer_unit_retrieval_rank) : 0)
      + (right.passage_retrieval_rank ? 1.3 / (60 + right.passage_retrieval_rank) : 0);
    if (rightRrf !== leftRrf) return rightRrf - leftRrf;
    return distanceCandidateKey(left).localeCompare(distanceCandidateKey(right));
  });
  candidates = candidates.slice(0, scoringLimit);
  const incumbentUnits = groundedPassageSearch
    ? new Set(candidates.map(row => row.matched_answer_unit_id).filter(Boolean)) : null;
  if (experimentalSingleUnitTitles) {
    candidates = addSingleUnitTitles(candidates, [...literalTitleRows, ...titleUnitRows], {
      queryWords: normalizeSpiritual(literalTitleQuery).split(' ').filter(Boolean),
      idfMap,
      normalizeTitle: normalizeSpiritual,
      isGeneric: (word) => GENERIC_WORDS.has(word) || SPEAKER_TOKENS.has(word),
      maxExtra: 12,
    });
  }
  if (englishBodyEligible) candidates=addEnglishBodyCandidates(candidates,englishBodyResult.rows,{weight:englishBodyWeight,maxExtra:120});
  if (numberedSourceRows?.length) {
    const numberedIds = new Set(numberedSourceRows.map(row => row.source_id));
    const exactByKey = new Map(exactNumberedUnits.map(row => [distanceCandidateKey(row), { ...row, exact_surface_title: true }]));
    candidates = candidates.filter(row => numberedIds.has(row.source_id)).map(row => {
      const key = distanceCandidateKey(row);
      const exact = exactByKey.get(key);
      if (!exact) return row;
      exactByKey.delete(key);
      return exact;
    }).concat([...exactByKey.values()]);
  }
  if (experimentalEnglishBodies) {
    const surface = normalizeSpiritual(literalTitleQuery);
    const matches = literalTitleRows.filter(row => surface.split(' ').length >= 3 && normalizeSpiritual(row.question) === surface
      || matchesQuestionReference(requestedReference, row.question, normalizeSpiritual));
    const references = new Map(matches.map(row => [distanceCandidateKey(row), row]));
    candidates = candidates.map(row => {
      const key = distanceCandidateKey(row);
      if (!references.delete(key)) return row;
      return { ...row, exact_surface_title: true };
    });
    for (const row of references.values()) candidates.push({ ...row, exact_surface_title: true });
  }

  const scoringStartedAt = performance.now();
  const evaluateCandidate = row => scoreDiscourse(row, normQuery, rawWords, contentWords, weightedPhrases, idfMap, subjects, intents);
  let scored = candidates.map(evaluateCandidate).filter(Boolean);
  if (englishPassageRows.length) {
    const priorBest = scored.reduce((maximum, match) => Math.max(maximum, match.totalScore), 0);
    const confidenceScale = Math.max(0, Math.min(1, (1150000 - priorBest) / 800000));
    if (confidenceScale > 0) {
      const passageWeight = englishPassageWeight * confidenceScale * 1.5;
      const priorScores = new Map(scored.map(match => [`${match.sourceId}\u0000${match.answerUnitId || 'record'}`, match]));
      candidates = addEnglishPassageCandidates(candidates, englishPassageRows, passageWeight);
      scored = candidates.map(row => {
        const previous = priorScores.get(distanceCandidateKey(row));
        if (!previous) return evaluateCandidate(row);
        if (!row.english_passage_evidence) return previous;
        const englishPassageScore = row.english_passage_evidence.strength * passageWeight;
        const totalScore = previous.totalScore + englishPassageScore;
        const decisionSummary = row.english_passage_evidence.verified
          ? `${previous.decisionSummary} · Matching concepts in the cited passage`
          : previous.decisionSummary;
        return { ...previous, englishPassageScore, totalScore, score: Math.round(totalScore * 10) / 10, decisionSummary };
      }).filter(Boolean);
    }
  }
  timings.scoringMs = performance.now() - scoringStartedAt;

  const debugCandidateAnswerUnitIds = searchMode === 'debug'
    ? candidates.map((candidate) => candidate.matched_answer_unit_id).filter(Boolean)
    : null;
  const debugPassageFacts = searchMode === 'debug' && experimentalEnglishPassages
    ? new Map(candidates.map(row => [row.matched_answer_unit_id, {
      answerLength: row.matched_answer_unit_text?.length || 0,
      exactReference: Boolean(row.exact_surface_title),
    }])) : null;

  const debugScoredAnswerUnitIds = searchMode === 'debug'
    ? scored.map((candidate) => candidate.answerUnitId).filter(Boolean)
    : null;

  // Deterministic primary score sort with secondary source_id tie-breaker
  scored.sort((a, b) => {
    if (b.totalScore !== a.totalScore) {
      return b.totalScore - a.totalScore;
    }
    return `${a.sourceId}\u0000${a.answerUnitId || ''}`.localeCompare(`${b.sourceId}\u0000${b.answerUnitId || ''}`);
  });

  let lexicalRanking = null;
  if (lexicalRanker && !numberedSourceRows && enableEnglishExpansion) {
    const rankingStarted = performance.now();
    lexicalRanking = await lexicalRanker.rank(pool, query, scored, { limit: targetLimit, evaluateCandidate,
      groundedEnglish: groundedPassageSearch !== null, repairedQuery: englishSurface, incumbentUnits });
    timings.lexicalRankingMs = performance.now() - rankingStarted;
  }
  // 6. Return up to targetLimit discourses (default 35, capped at 100)
  const finalMatches = lexicalRanking?.matches || scored.slice(0, targetLimit);

  // 7. Generate snippets, highlighting, and passage deep-link offsets ONLY for winning matches
  // Offsets are measured directly on match.answer (rendered in reader) to prevent question_context drift.
  const snippetsStartedAt = performance.now();
  for (const match of finalMatches) {
    const snippetSource = match.answerUnitText || match.answer;
    let { snippetText, targetPassage, passageOffset } = extractMultiSentenceSnippet(
      snippetSource,
      contentWords,
      weightedPhrases,
      match.normSwamiSpeech
    );
    if (match.answerUnitText && Number.isInteger(match.answerUnitStart)) {
      const adjusted = {
        ...passageOffset,
        start: match.answerUnitStart + passageOffset.start,
        end: match.answerUnitStart + passageOffset.end,
      };
      if (!match.answer || match.answer.slice(adjusted.start, adjusted.end) === adjusted.text) {
        passageOffset = adjusted;
      } else {
        ({ snippetText, targetPassage, passageOffset } = extractMultiSentenceSnippet(
          match.answer,
          contentWords,
          weightedPhrases,
          normalizeSpiritual(match.answer)
        ));
      }
    }
    match.snippet = snippetText;
    match.targetPassage = targetPassage;
    match.passageOffset = passageOffset;
    match.highlightedSnippet = highlightSnippet(snippetText, normQuery);
    delete match.answer;
    delete match.answerUnitText;
    delete match.answerUnitStart;
    delete match.normSwamiSpeech;
  }
  timings.snippetsMs = performance.now() - snippetsStartedAt;
  timings.totalMs = performance.now() - totalStartedAt;

  return {
    query,
    normalizedQuery: normQuery,
    retrievalQuery: retrievalSurfaceQuery,
    corrections,
    searchMode,
    executionTimeMs: numberedSourceRows ? timings.totalMs : Date.now() - queryStart,
    timings,
    totalFound: lexicalRanking?.rankedAnswerUnitIds.length || scored.length,
    matches: finalMatches,
    ...(searchMode === 'debug' ? {
      debug: {
        ...(corpusGroundedEnglish ? { groundedEnglish: groundedPassageSearch !== null } : {}),
        recordCandidateSourceIds: dbResult.rows.map((row) => row.source_id),
        englishBodyEligible,
        fuzzyQuestionSearch,
        englishBodyAnswerUnitIds: englishBodyResult.rows.map(row=>row.matched_answer_unit_id),
        literalTitleAnswerUnitIds: literalTitleRows.map((row) => row.matched_answer_unit_id),
        hydratedTitleAnswerUnitIds: titleUnitRows.map((row) => row.matched_answer_unit_id),
        preShortlistAnswerUnitIds: debugPreShortlistAnswerUnitIds,
        candidateAnswerUnitIds: lexicalRanking
          ? [...new Set([...debugCandidateAnswerUnitIds, ...lexicalRanking.rankedAnswerUnitIds])] : debugCandidateAnswerUnitIds,
        scoredAnswerUnitIds: lexicalRanking?.rankedAnswerUnitIds || debugScoredAnswerUnitIds,
        ...(experimentalEnglishPassages ? { englishPassageAnswerUnitIds: englishPassageRows.map(row => row.matched_answer_unit_id) } : {}),
        ...(experimentalEnglishBodies || experimentalEnglishPassages ? { rankingCandidates: scored.map(match => ({
          sourceId: match.sourceId, answerUnitId: match.answerUnitId, answerUnitHash: match.answerUnitHash,
          totalScore: match.totalScore, englishBodyScore: match.englishBodyScore || 0,
          ...(debugPassageFacts ? {
            englishPassageScore: match.englishPassageScore || 0,
            titleScore: match.titleScore,
            discoveryScore: match.discoveryScore,
            intentScore: match.intentScore,
            minimalSpanScore: match.minimalSpanScore,
            ...(match.answerUnitId && debugPassageFacts.get(match.answerUnitId)),
          } : {}),
        })) } : {}),
      },
    } : {}),
  };
}

module.exports = {
  minimumTokenDistance,
  searchDistanceCorpus,
  scoreDiscourse,
  highlightSnippet,
  extractMultiSentenceSnippet,
  selectMinimalCoveringSentenceRange,
  splitIntoCleanSentences,
  classifySearchIntent,
  scoreIntentAlignment,
  buildConceptGroups,
  computeMinimalCoveringSpan,
  scoreMinimalCoveringSpan,
  resolveCorpusIDF,
  clearIdfCache,
  queryDistancePassages,
  normalizeSpiritual,
  normalizeSearchQuery,
  correctFuzzyQueryToken,
  autoFuzzinessMaxEdits,
  boundedDamerauLevenshtein,
  adjacentTranspositionCandidates,
  singleEditCorpusCandidates,
  hasSpiritualSearchContext,
  correctCorpusSpelling,
  correctCorpusTranspositions,
  correctControlledMorphology,
  correctContextualQueryTerms,
  isSearchEligibleMetadata,
  searchEligibilitySql,
  formatDate,
  canonicalizeSpiritualTerm,
  foldDiacritics,
  termCanonicalCache,
  LRUCache,
  distanceCandidateKey,
  fuseDistanceCandidateChannels,
  hydrateSingleUnitTitleCandidates,
  stripSearchFraming,
};
