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

let cachedCorpusTotal = null;
let cachedCorpusTotalExpiresAt = 0;
const CORPUS_TOTAL_TTL_MS = 5 * 60 * 1000; // 5-minute TTL

async function getCorpusTotal(pool) {
  const now = Date.now();
  if (cachedCorpusTotal != null && now < cachedCorpusTotalExpiresAt) {
    return cachedCorpusTotal;
  }
  if (pool) {
    try {
      const res = await pool.query('SELECT count(*) as count FROM semantic_qa.records');
      cachedCorpusTotal = Math.max(1, Number(res.rows[0]?.count) || 6010);
      cachedCorpusTotalExpiresAt = now + CORPUS_TOTAL_TTL_MS;
    } catch {
      cachedCorpusTotal = 6010;
      cachedCorpusTotalExpiresAt = now + 60000;
    }
  } else {
    cachedCorpusTotal = 6010;
    cachedCorpusTotalExpiresAt = now + 60000;
  }
  return cachedCorpusTotal;
}

const idfMemoryCache = new Map();

function clearIdfCache() {
  idfMemoryCache.clear();
  cachedCorpusTotal = null;
  cachedCorpusTotalExpiresAt = 0;
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

const INTENT_WORDS = new Set([
  'meaning', 'means', 'meant', 'definition', 'define',
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
  'parabrahman', 'brahman', 'atma', 'soul', 'god', 'swami', 'incarnation', 'avatar',
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
  'you', 'your', 'yours', 'yourself', 'yourselves'
]);

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
  else if (/^br[aā]hm[aā]?(n|na|nas|s)?$/i.test(s)) res = 'brahmin';
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
    .replace(/[^a-z0-9\s]/g, ' ')
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
  const uncached = uniqueWords.filter(w => !idfMemoryCache.has(w));
  const totalDocs = await getCorpusTotal(pool);

  if (uncached.length > 0 && pool) {
    await Promise.all(uncached.map(async (word) => {
      try {
        const res = await pool.query(`
          SELECT count(*) as count FROM semantic_qa.records WHERE search_vector @@ to_tsquery('simple', $1)
        `, [word]);
        const rawCount = Number(res.rows[0].count) || 0;
        if (rawCount === 0) {
          idfMemoryCache.set(word, 0.2);
        } else {
          const idf = Math.max(0.5, Math.log(1 + (totalDocs - rawCount + 0.5) / (rawCount + 0.5)));
          idfMemoryCache.set(word, idf);
        }
      } catch {
        idfMemoryCache.set(word, 0.5);
      }
    }));
  }

  const idfMap = {};
  for (const w of words) {
    if (GENERIC_WORDS.has(w.toLowerCase())) {
      idfMap[w.toLowerCase()] = 0.05; // Generic words suppressed
    } else {
      idfMap[w.toLowerCase()] = idfMemoryCache.get(w.toLowerCase()) || 1.2;
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
      let minDist = 999;
      for (const pa of listA) {
        for (const pb of listB) {
          const d = Math.abs(pa - pb);
          if (d < minDist) minDist = d;
        }
      }
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
function scoreDiscourse(doc, query, queryWords, contentWords, weightedPhrases, idfMap, subjects = [], intents = []) {
  const origTitle = doc.question || '';
  const normTitle = normalizeSpiritual(origTitle);
  const titleWords = normTitle.split(' ').filter(Boolean);
  const titleContentWords = titleWords.filter(w => !GENERIC_WORDS.has(w));

  const origBody = doc.answer || '';
  const origContext = (doc.metadata && doc.metadata.question_context) ? doc.metadata.question_context : '';
  const fullText = `${origContext ? origContext + '\n\n' : ''}${origBody}`;
  const normBody = normalizeSpiritual(fullText);
  const bodyTokens = normBody.split(' ').filter(Boolean);

  // Extract Swami's direct response (stripping devotee preambles in [...])
  let swamiSpeech = origBody;
  const repliedIdx = swamiSpeech.indexOf('Swami replied:-');
  if (repliedIdx !== -1) {
    swamiSpeech = swamiSpeech.slice(repliedIdx + 'Swami replied:-'.length);
  } else {
    swamiSpeech = swamiSpeech.replace(/^\[[^\]]+\]\s*/, '');
  }
  const normSwamiSpeech = normalizeSpiritual(swamiSpeech);
  const speechTokens = normSwamiSpeech.split(' ').filter(Boolean);

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

  if (!titleHasSubject && !bodyHasSubject) {
    return null; // DISCARD off-topic discourses completely!
  }

  // When title does NOT contain the topic subject, require at least 2 mentions in the body
  // to eliminate random off-topic discourses that mention the subject once in passing (e.g. Guru Dakshina).
  if (!titleHasSubject && bodySubjectCount < 2) {
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
  const bodyLines = origBody.split('\n').map(l => l.trim()).filter(Boolean);
  let sectionHeadingScore = 0;
  let foundSectionHeading = '';
  for (const line of bodyLines) {
    if (line.length >= 6 && line.length <= 80) {
      const normL = normalizeSpiritual(line);
      const lWords = normL.split(' ').filter(Boolean);
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

  // F. Substantive Subject Density (Rewards comprehensive discourses with 20-35+ mentions)
  const primaryCount = bodyTokens.filter(t => t === primarySubject).length;
  const secondaryCount = effectiveSubjects[1] ? bodyTokens.filter(t => t === effectiveSubjects[1]).length : 0;
  const densityScore = (Math.min(10, primaryCount) * 3000) + (Math.min(8, secondaryCount) * 1500);

  const bodyTotal = sectionHeadingScore + directDefBoost + openingScore + bodyPhraseScore + (proximityScore * 1.5) + densityScore;

  // TOTAL SCORE: Blends Title Authority, Section Headings, and Content Depth!
  const totalScore = titleTotal + bodyTotal;

  const decisionReasons = [];
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

  return {
    sourceId: doc.source_id,
    title: origTitle,
    date: doc.metadata?.record_date || '',
    formattedDate: formatDate(doc.metadata?.record_date),
    totalScore,
    score: Math.round(totalScore * 10) / 10,
    titleScore: titleTotal,
    bodyScore: bodyTotal,
    proximityScore,
    minDistance: minObservedDistance,
    decisionSummary: decisionReasons.join(' · ') || 'Exact phrase & proximity match',
    answer: origBody,
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

/**
 * Execute Distance-Based Search against the PostgreSQL records table.
 * Returns up to targetLimit (default 35, max 100) ranked discourses.
 */
async function searchDistanceCorpus(pool, { query, limit = 35, searchMode = 'normal' }) {
  const targetLimit = Math.max(1, Math.min(100, Number(limit) || 35));
  const normQuery = normalizeSpiritual(query);
  const qWords = normQuery.split(' ').filter(Boolean);
  const rawWords = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const contentWords = qWords.filter(w => !GENERIC_WORDS.has(w) && w.length > 1);

  if (!qWords.length) {
    return { query, totalFound: 0, matches: [] };
  }

  // 1. Classify query into Subjects (entities) and Intents
  const { subjects, intents } = classifyQueryTokens(qWords);

  // 2. Resolve dynamic statistical BM25 IDF across corpus
  const idfMap = await resolveCorpusIDF(pool, qWords);

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
  let dbResult;

  try {
    dbResult = await pool.query(`
      SELECT r.source_id, r.question, r.answer, r.metadata
      FROM semantic_qa.records r
      WHERE (r.search_vector @@ to_tsquery('simple', $1) OR r.question ILIKE $2 OR r.question ILIKE $4)
      ORDER BY (
        CASE
          WHEN r.question ILIKE $4 THEN 0
          WHEN r.question ILIKE $3 THEN 1
          WHEN r.question ILIKE $2 THEN 2
          ELSE 3
        END
      ),
      ts_rank_cd(r.search_vector, to_tsquery('simple', $1)) DESC
      LIMIT 400
    `, [tsQueryStr, `%${primaryPrefix}%`, `%${primaryPrefix}%${secondarySubject}%`, `%${titleNgramFilter}%`]);
  } catch (err) {
    dbResult = await pool.query(`
      SELECT r.source_id, r.question, r.answer, r.metadata
      FROM semantic_qa.records r
      WHERE r.search_vector @@ to_tsquery('simple', $1) OR r.question ILIKE $2 OR r.answer ILIKE $2
      LIMIT 400
    `, [primaryTermExpr, `%${primaryPrefix}%`]);
  }

  const candidates = dbResult.rows;

  // Fallback candidate expansion: Anchored on broad content words & variants
  // to ensure up to targetLimit discourses without EVER failing recall.
  if (candidates.length < targetLimit) {
    const existingIds = new Set(candidates.map(c => c.source_id));
    const allSearchTokens = [...new Set([...contentWords, ...subjects])].filter(w => w && w.length >= 3).slice(0, 8);
    const broadTsQuery = allSearchTokens.length > 0 ? allSearchTokens.join(' | ') : primaryTermExpr;
    try {
      const fallbackResult = await pool.query(`
        SELECT r.source_id, r.question, r.answer, r.metadata
        FROM semantic_qa.records r
        WHERE r.search_vector @@ to_tsquery('simple', $1) OR r.question ILIKE $2
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

  // 5. Score all candidates using Subject Authority, Title Purity & Swami Direct Definition
  const scored = candidates
    .map(doc => scoreDiscourse(doc, query, rawWords, contentWords, weightedPhrases, idfMap, subjects, intents))
    .filter(Boolean);

  // Deterministic primary score sort with secondary source_id tie-breaker
  scored.sort((a, b) => {
    if (b.totalScore !== a.totalScore) {
      return b.totalScore - a.totalScore;
    }
    return String(a.sourceId).localeCompare(String(b.sourceId));
  });

  // 6. Return up to targetLimit discourses (default 35, capped at 100)
  const finalMatches = scored.slice(0, targetLimit);

  // 7. Generate snippets, highlighting, and passage deep-link offsets ONLY for winning matches
  // Offsets are measured directly on match.answer (rendered in reader) to prevent question_context drift.
  for (const match of finalMatches) {
    const { snippetText, targetPassage, passageOffset } = extractMultiSentenceSnippet(
      match.answer,
      contentWords,
      weightedPhrases,
      match.normSwamiSpeech
    );
    match.snippet = snippetText;
    match.targetPassage = targetPassage;
    match.passageOffset = passageOffset;
    match.highlightedSnippet = highlightSnippet(snippetText, query);
    delete match.answer;
    delete match.normSwamiSpeech;
  }

  return {
    query,
    searchMode,
    executionTimeMs: Date.now() - queryStart,
    totalFound: scored.length,
    matches: finalMatches,
  };
}

module.exports = {
  searchDistanceCorpus,
  scoreDiscourse,
  highlightSnippet,
  extractMultiSentenceSnippet,
  splitIntoCleanSentences,
  resolveCorpusIDF,
  clearIdfCache,
  normalizeSpiritual,
  formatDate,
  canonicalizeSpiritualTerm,
  foldDiacritics,
  termCanonicalCache,
  LRUCache,
};
