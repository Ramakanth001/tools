/**
 * spiritualNormalizer.js
 * Curated Spiritual Terminology & Transliteration Normalizer
 * Handles:
 * 1. IAST diacritics stripping & canonicalization (Jñāna -> Jnana, Śrī -> Shri)
 * 2. Phonetic dialect variations (Gyana -> Jnana, Moksham -> Moksha, Brahmam -> Brahman)
 * 3. Sanskrit spelling variations (Nivrutti <-> Nivritti, Pravrutti <-> Pravritti, Sadhana <-> Saadhana)
 * 4. Controlled query expansion for high-value theological terms
 */

// Mapping of IAST and special unicode diacritics to standard Latin
const IAST_MAP = [
  [/[\u0101\u0100]/g, 'a'],  // ā, Ā
  [/[\u012b\u012a]/g, 'i'],  // ī, Ī
  [/[\u016b\u016a]/g, 'u'],  // ū, Ū
  [/[\u1e5b\u1e5a]/g, 'ri'], // ṛ, Ṛ
  [/[\u1e5d\u1e5c]/g, 'ri'], // ṝ, Ṝ
  [/[\u1e37\u1e36]/g, 'li'], // ḷ, Ḷ
  [/[\u015b\u015a]/g, 'sh'], // ś, Ś
  [/[\u1e63\u1e62]/g, 'sh'], // ṣ, Ṣ
  [/[\u00f1\u00d1]/g, 'n'],  // ñ, Ñ
  [/[\u1e45\u1e44]/g, 'n'],  // ṅ, Ṅ
  [/[\u1e47\u1e46]/g, 'n'],  // ṇ, Ṇ
  [/[\u1e6d\u1e6c]/g, 't'],  // ṭ, Ṭ
  [/[\u1e0d\u1e0c]/g, 'd'],  // ḍ, Ḍ
  [/[\u1e43\u1e42]/g, 'm'],  // ṃ, Ṃ
  [/[\u1e25\u1e24]/g, 'h'],  // ḥ, Ḥ
];

// Curated Canonical Spiritual Lexicon
// Key: canonical form used throughout Swami's discourses
// Variants: alternative spellings, phonetic forms, and regional suffixes
const SPIRITUAL_SYNONYMS = {
  'jnana': ['gyana', 'gyan', 'jnan', 'jnaana', 'jnyaana', 'dnyana', 'dnyan'],
  'moksha': ['moksham', 'mukti', 'moksh', 'salvation', 'liberation'],
  'brahman': ['brahmam', 'brahm', 'parabrahman', 'parabrahmam'],
  'sadhana': ['saadhana', 'saadhan', 'sadhan'],
  'nivrutti': ['nivritti', 'nivrutthi', 'nivrithi'],
  'pravrutti': ['pravritti', 'pravrutthi', 'pravrithi'],
  'atman': ['atma', 'aatma', 'athma', 'soul', 'jeeva', 'jiva'],
  'upadhi': ['upaadhi', 'medium', 'container'],
  'sadguru': ['satguru', 'guru', 'spiritual preacher'],
  'maya': ['maaya', 'illusion'],
  'karma': ['karmam', 'action', 'deeds'],
  'bhakti': ['bhakthi', 'devotion'],
  'seva': ['sevaa', 'service', 'sacrifice of work'],
  'datta': ['dattatreya', 'dattaswami', 'guru datta'],
  'avatara': ['avatar', 'human incarnation', 'divine incarnation'],
};

// Reverse lookup map: variant -> canonical
const VARIANT_TO_CANONICAL = new Map();
for (const [canonical, variants] of Object.entries(SPIRITUAL_SYNONYMS)) {
  VARIANT_TO_CANONICAL.set(canonical.toLowerCase(), canonical);
  for (const v of variants) {
    VARIANT_TO_CANONICAL.set(v.toLowerCase(), canonical);
  }
}

/**
 * Strips IAST diacritics into plain Latin characters.
 */
function stripIAST(text) {
  if (!text) return '';
  let res = text;
  for (const [regex, rep] of IAST_MAP) {
    res = res.replace(regex, rep);
  }
  return res;
}

/**
 * Normalizes spiritual words into canonical spelling for both query & document matching.
 */
function normalizeSpiritualText(text) {
  if (!text) return '';
  // 1. Strip IAST
  let cleaned = stripIAST(text);

  // 2. Tokenize words while preserving original structure
  return cleaned.replace(/\b[A-Za-z]+\b/g, (match) => {
    const lower = match.toLowerCase();
    const canonical = VARIANT_TO_CANONICAL.get(lower);
    if (canonical) {
      // Preserve uppercase first letter if original was capitalized
      return (match[0] === match[0].toUpperCase())
        ? canonical.charAt(0).toUpperCase() + canonical.slice(1)
        : canonical;
    }
    return match;
  });
}

/**
 * Expands a search query by appending canonical spiritual synonyms.
 * Example: "How does Gyana lead to Moksham?" -> "How does Jnana lead to Moksha? Jnana Moksha"
 */
function expandQuery(query) {
  const normalized = normalizeSpiritualText(query);
  const words = normalized.toLowerCase().split(/\W+/).filter(Boolean);
  const expansions = new Set();

  for (const w of words) {
    const canonical = VARIANT_TO_CANONICAL.get(w);
    if (canonical) {
      expansions.add(canonical);
      // Add primary synonym if helpful
      const syns = SPIRITUAL_SYNONYMS[canonical];
      if (syns && syns.length > 0) {
        expansions.add(syns[0]);
      }
    }
  }

  if (!expansions.size) return normalized;
  return `${normalized} (${Array.from(expansions).join(' OR ')})`;
}

module.exports = {
  stripIAST,
  normalizeSpiritualText,
  expandQuery,
  SPIRITUAL_SYNONYMS,
};
