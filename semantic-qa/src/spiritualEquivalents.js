/**
 * Spiritual & Transliteration Equivalents Dictionary
 * Ingests domain-specific Sanskrit (IAST) & Telugu-English transliteration pairs
 * from `spiritual_synonyms.csv` plus core scriptural canonical roots.
 */

const fs = require('fs');
const path = require('path');

let initialized = false;
const termToCanonicalMap = new Map();
const canonicalToVariantsMap = new Map();

// Core spiritual canonical roots and known spelling variations (including IAST diacritics)
const CORE_CANONICAL_CLUSTERS = [
  { canonical: 'gayatri', variants: ['gayatri', 'gayathri', 'gayathry', 'gayatriva', 'gayatree', 'gāyatrī', 'gāyatri'] },
  { canonical: 'savitri', variants: ['savitri', 'savithri', 'savithree', 'sāvitrī'] },
  { canonical: 'mantra', variants: ['mantra', 'mantras', 'mantram', 'mantrā'] },
  { canonical: 'brahmin', variants: ['brahmin', 'brahmins', 'brahmana', 'brahmanas', 'brāhmaṇa'] },
  { canonical: 'bhakti', variants: ['bhakti', 'bhakthi'] },
  { canonical: 'mukti', variants: ['mukti', 'mukthi'] },
  { canonical: 'shakti', variants: ['shakti', 'shakthi', 'sakti', 'śakti'] },
  { canonical: 'shankara', variants: ['shankara', 'sankara', 'samkara', 'śaṅkara', 'śaṃkara'] },
  { canonical: 'shiva', variants: ['shiva', 'siva', 'sivam', 'shivam', 'śiva'] },
  { canonical: 'vishnu', variants: ['vishnu', 'visnu', 'viṣṇu'] },
  { canonical: 'krishna', variants: ['krishna', 'krsna', 'krisna', 'kṛṣṇa'] },
  { canonical: 'jnana', variants: ['jnana', 'gnana', 'jnanam', 'gnanam', 'jñāna'] },
  { canonical: 'atma', variants: ['atma', 'atman', 'athma', 'ātmā', 'ātman'] },
  { canonical: 'swami', variants: ['swami', 'svami', 'svāmī', 'swāmī'] },
  { canonical: 'upanayanam', variants: ['upanayanam', 'upanayana', 'upanayanamu'] },
  { canonical: 'sandhyavandanam', variants: ['sandhyavandanam', 'sandhyavandana', 'sandhyavandanamu', 'sandhyāvandanam', 'sandhyāvandana', 'sandhyaavandanam', 'sandhyaavandana'] },
  { canonical: 'sandhya', variants: ['sandhya', 'sandhyaa', 'saṃdhyā', 'sandhyā'] },
  { canonical: 'vandanam', variants: ['vandanam', 'vandana', 'vandanamu', 'vandanā'] },
  { canonical: 'pravritti', variants: ['pravritti', 'pravrutti', 'pravṛtti'] },
  { canonical: 'nivritti', variants: ['nivritti', 'nivrutti', 'nivṛtti'] },
  { canonical: 'datta', variants: ['datta', 'dattatreya', 'dattunaku', 'dattundu', 'dattu'] },
  { canonical: 'drishti', variants: ['drishti', 'drushti', 'dristi', 'drsti', 'drusti', 'dṛṣṭi'] },
  { canonical: 'srishti', variants: ['srishti', 'srusti', 'sristi', 'srsti', 'srustee', 'sṛṣṭi'] },
  { canonical: 'yajna', variants: ['yajna', 'yagna', 'yajnam', 'yagnam', 'yajña'] },
  { canonical: 'moksha', variants: ['moksha', 'moksham', 'moksa', 'mokṣa'] },
  { canonical: 'satsanga', variants: ['satsanga', 'satsang', 'satsangam'] },
  { canonical: 'sadguru', variants: ['sadguru', 'satguru'] },
  { canonical: 'adiparashakti', variants: ['adiparashakti', 'adiparasakthi', 'adiparasakti', 'adiparashakthi', 'adiparaashakti', 'adiparashaktee', 'ādiparāśakti', 'ādiparāśaktī', 'aadiparashakti', 'aadiparaashakti', 'adishakti', 'aadishakti'] },
  { canonical: 'savita', variants: ['savita', 'savitha', 'savitar', 'savithar', 'savitā', 'savitaa', 'savithaa', 'savitra', 'sāvitra', 'savitru', 'savitṛ'] },
  { canonical: 'devata', variants: ['devata', 'devatha', 'devataa', 'devathaa', 'deavatha', 'devatā'] },
  { canonical: 'rigveda', variants: ['rigveda', 'rgveda', 'rugveda', 'rkveda', 'ṛgveda'] },
  { canonical: 'yajurveda', variants: ['yajurveda', 'yajuveda', 'yajus'] },
  { canonical: 'samaveda', variants: ['samaveda', 'saamaveda', 'sama', 'sāmaveda'] },
  { canonical: 'atharvaveda', variants: ['atharvaveda', 'atharvanaveda', 'atharvana'] },
  { canonical: 'satpatra', variants: ['satpatra', 'satpaatra', 'satpatram', 'satpaatram', 'satpaatrunaku', 'sathpaatra', 'satpātra'] },
  { canonical: 'astrology', variants: ['astrology', 'astrological', 'astrologer', 'jyotisha', 'jyotish'] },
  { canonical: 'gemstone', variants: ['gemstone', 'gemstones'] },
  { canonical: 'remedy', variants: ['remedy', 'remedies'] },
  { canonical: 'navavidha', variants: ['navavidha', 'navavidhaa', 'navavidhabhakti', 'navavidha bhakti'] },
  { canonical: 'shravana', variants: ['shravana', 'shravanam', 'śravaṇa'] },
  { canonical: 'kirtana', variants: ['kirtana', 'kirtanam', 'keertana', 'keertanam', 'kīrtana'] },
  { canonical: 'eshana', variants: ['eshana', 'eshanas', 'eshanaa', 'eṣaṇā', 'eṣaṇa'] },
  { canonical: 'shraddha', variants: ['shraddha', 'sraddha', 'shraddham', 'śrāddha', 'sraddhaa'] },
  { canonical: 'caste', variants: ['caste', 'castes'] },
  { canonical: 'varna', variants: ['varna', 'varnas', 'varṇa'] },
  { canonical: 'kshatriya', variants: ['kshatriya', 'kshatriyas', 'kṣatriya'] },
  { canonical: 'vaishya', variants: ['vaishya', 'vysya', 'vaiśya'] },
  { canonical: 'shudra', variants: ['shudra', 'sudra', 'śūdra'] },
  { canonical: 'nonveg', variants: ['non-vegetarian', 'nonvegetarian', 'non vegetarian'] },
  { canonical: 'prophet', variants: ['prophet', 'prophets', 'prophethood'] },
  { canonical: 'muhammad', variants: ['muhammad', 'mohammed', 'mohammad', 'prophet muhammad'] },
  { canonical: 'holyspirit', variants: ['holy spirit', 'holy ghost'] },
  { canonical: 'advaita', variants: ['advaita', 'adwaita', 'advaitam'] },
  { canonical: 'vishishtadvaita', variants: ['vishishtadvaita', 'visistadvaita', 'vishistadvaita', 'viśiṣṭādvaita'] },
  { canonical: 'dvaita', variants: ['dvaita', 'dwaita', 'dvaitam'] },
];

function cleanToken(token) {
  if (!token || typeof token !== 'string') return '';
  return token
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/[^a-z0-9]/g, '')      // keep alphanumeric
    .trim();
}

function registerCluster(canonical, variants) {
  const cleanCan = cleanToken(canonical);
  if (!cleanCan || cleanCan.length < 2) return;

  if (!canonicalToVariantsMap.has(cleanCan)) {
    canonicalToVariantsMap.set(cleanCan, new Set());
  }
  const set = canonicalToVariantsMap.get(cleanCan);
  set.add(cleanCan);

  for (const v of variants) {
    if (!v || typeof v !== 'string') continue;
    const cleanV = cleanToken(v);
    if (!cleanV || cleanV.length < 2) continue;
    set.add(cleanV);
    termToCanonicalMap.set(cleanV, cleanCan);

    // Also preserve raw lowercase string with IAST diacritics for database tsquery matching
    const rawV = v.toLowerCase().trim();
    if (rawV.length >= 2 && rawV !== cleanV) {
      set.add(rawV);
      termToCanonicalMap.set(rawV, cleanCan);
    }
  }
}

function initSpiritualEquivalents() {
  if (initialized) return;

  // 1. Seed with core canonical clusters first
  for (const cluster of CORE_CANONICAL_CLUSTERS) {
    registerCluster(cluster.canonical, cluster.variants);
  }

  // 2. Ingest domain CSV
  const csvPath = path.join(__dirname, '..', 'data', 'spiritual_synonyms.csv');
  if (!fs.existsSync(csvPath)) {
    initialized = true;
    return;
  }

  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^"([^"]*)","([^"]*)","([^"]*)"$/);
    if (!match) continue;

    const rawIast = match[1];
    const rawEn = match[2];

    const enVariants = rawEn.split(',').map(s => cleanToken(s)).filter(Boolean);
    if (!enVariants.length) continue;

    // Use first clean English variant as the canonical representative
    const canonical = enVariants[0];
    if (canonical.length < 2) continue;

    const cleanIast = cleanToken(rawIast);

    const allVariants = new Set();
    if (cleanIast && cleanIast.length >= 2) allVariants.add(cleanIast);
    const rawTrimmedIast = rawIast.toLowerCase().trim();
    if (rawTrimmedIast && rawTrimmedIast.length >= 2) allVariants.add(rawTrimmedIast);
    for (const v of enVariants) {
      if (v.length >= 2) allVariants.add(v);
    }

    if (!canonicalToVariantsMap.has(canonical)) {
      canonicalToVariantsMap.set(canonical, new Set());
    }

    const set = canonicalToVariantsMap.get(canonical);
    for (const v of allVariants) {
      set.add(v);
      if (!termToCanonicalMap.has(v)) {
        termToCanonicalMap.set(v, canonical);
      }
    }
  }

  initialized = true;
}

// Ensure loaded at startup
initSpiritualEquivalents();

/**
 * Returns the canonical spiritual term for a word, or null if not mapped.
 */
function getCanonicalSpiritualTerm(word) {
  if (!word || typeof word !== 'string') return null;
  const clean = cleanToken(word);
  if (!clean) return null;
  return termToCanonicalMap.get(clean) || null;
}

/**
 * Returns all equivalent variants for a word (including itself and transliterations).
 */
function getSpiritualVariants(word) {
  if (!word || typeof word !== 'string') return [word];
  const clean = cleanToken(word);
  const canonical = termToCanonicalMap.get(clean) || clean;
  const set = canonicalToVariantsMap.get(canonical);
  if (set && set.size > 0) {
    return Array.from(set);
  }
  return [clean];
}

module.exports = {
  initSpiritualEquivalents,
  getCanonicalSpiritualTerm,
  getSpiritualVariants,
  termToCanonicalMap,
  canonicalToVariantsMap,
};
