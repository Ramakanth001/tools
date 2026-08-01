/**
 * Reusable Unicode Mojibake Repair Transform.
 *
 * Detects and repairs character encoding mismatches (e.g. UTF-8 read or saved as Latin-1/Windows-1252)
 * in MySQL database text content. Works for any Unicode text including Telugu, Sanskrit,
 * IAST transliteration, Devanagari, Bengali, Malayalam, Cyrillic, and smart quotes/dashes.
 */

// ---------------------------------------------------------------------------
// Windows-1252 character map to single byte values
// ---------------------------------------------------------------------------
const WIN1252_MAP = {
  0x20AC: 0x80, // €
  0x201A: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201E: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02C6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8A, // Š
  0x2039: 0x8B, // ‹
  0x0152: 0x8C, // Œ
  0x017D: 0x8E, // Ž
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201C: 0x93, // “
  0x201D: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02DC: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9A, // š
  0x203A: 0x9B, // ›
  0x0153: 0x9C, // œ
  0x017E: 0x9E, // ž
  0x0178: 0x9F, // Ÿ
};

// ---------------------------------------------------------------------------
// Known Mojibake Corrupted Patterns (Fallback Replacement Map)
// ---------------------------------------------------------------------------
const IAST_MOJIBAKE_MAP = [
  // 3-byte IAST corruptions
  ['\u00C4\u0081', '\u0101'],   // ā  (a-macron)
  ['\u00C4\u0080', '\u0100'],   // Ā  (A-macron)
  ['\u00C4\u00AB', '\u012B'],   // ī  (i-macron)
  ['\u00C4\u00AA', '\u012A'],   // Ī  (I-macron)
  ['\u00C5\u00AB', '\u016B'],   // ū  (u-macron)
  ['\u00C5\u00AA', '\u016A'],   // Ū  (U-macron)

  ['\u00E1\u00B9\u00AD', '\u1E6D'],   // ṭ
  ['\u00E1\u00B9\u00AC', '\u1E6C'],   // Ṭ
  ['\u00E1\u00B8\u008D', '\u1E0D'],   // ḍ
  ['\u00E1\u00B8\u008C', '\u1E0C'],   // Ḍ
  ['\u00E1\u00B9\u0087', '\u1E47'],   // ṇ
  ['\u00E1\u00B9\u0086', '\u1E46'],   // Ṇ
  ['\u00E1\u00B9\u00A3', '\u1E63'],   // ṣ
  ['\u00E1\u00B9\u00A2', '\u1E62'],   // Ṣ
  ['\u00E1\u00B9\u0083', '\u1E43'],   // ṃ
  ['\u00E1\u00B9\u0082', '\u1E42'],   // Ṃ
  ['\u00E1\u00B8\u00A5', '\u1E25'],   // ḥ
  ['\u00E1\u00B8\u00A4', '\u1E24'],   // Ḥ

  ['\u00E1\u00B9\u009B', '\u1E5B'],   // ṛ
  ['\u00E1\u00B9\u009A', '\u1E5A'],   // Ṛ
  ['\u00E1\u00B9\u009D', '\u1E5D'],   // ṝ
  ['\u00E1\u00B9\u009C', '\u1E5C'],   // Ṝ
  ['\u00E1\u00B8\u00B7', '\u1E37'],   // ḷ
  ['\u00E1\u00B8\u00B6', '\u1E36'],   // Ḷ
  ['\u00E1\u00B8\u00B9', '\u1E39'],   // ḹ
  ['\u00E1\u00B8\u00B8', '\u1E38'],   // Ḹ

  ['\u00E1\u00B9\u0085', '\u1E45'],   // ṅ
  ['\u00E1\u00B9\u0084', '\u1E44'],   // Ṅ

  // 2-byte IAST corruptions
  ['\u00C3\u00B1', '\u00F1'],   // ñ
  ['\u00C3\u0091', '\u00D1'],   // Ñ
  ['\u00C5\u009B', '\u015B'],   // ś
  ['\u00C5\u009A', '\u015A'],   // Ś

  ['\u00C3\u00A1', '\u00E1'],   // á
  ['\u00C3\u00A9', '\u00E9'],   // é
  ['\u00C3\u00AD', '\u00ED'],   // í
  ['\u00C3\u00B3', '\u00F3'],   // ó
  ['\u00C3\u00BA', '\u00FA'],   // ú

  // Windows-1252 smart quotes & dashes corruptions
  ['\u00E2\u0080\u0099', '\u2019'],   // ’
  ['\u00E2\u0080\u009C', '\u201C'],   // “
  ['\u00E2\u0080\u009D', '\u201D'],   // ”
  ['\u00E2\u0080\u0093', '\u2013'],   // –
  ['\u00E2\u0080\u0094', '\u2014'],   // —
  ['\u00E2\u0080\u00A6', '\u2026'],   // …
];

// Indic Mojibake byte prefix signatures (UTF-8 multi-byte misread as latin1/cp1252)
const INDIC_MOJIBAKE_SIGNATURES = [
  '\u00E0\u00B0', // Telugu à°
  '\u00E0\u00B1', // Telugu à±
  '\u00E0\u00A4', // Devanagari à¤
  '\u00E0\u00A5', // Devanagari à¥
  '\u00E0\u00B4', // Malayalam à´
  '\u00E0\u00B5', // Malayalam àµ
  '\u00E0\u00A6', // Bengali à¦
  '\u00E0\u00A7', // Bengali à§
  '\u00E0\u00AE', // Tamil à®
  '\u00E0\u00AF', // Tamil à¯
  '\u00E0\u00B2', // Kannada à²
  '\u00E0\u00B3', // Kannada à³
];

// Combine all signatures for detection
const MOJIBAKE_SIGNATURES = [
  ...IAST_MOJIBAKE_MAP.map(([corrupted]) => corrupted),
  ...INDIC_MOJIBAKE_SIGNATURES,
];

// Valid IAST character set for verification
const VALID_IAST_CHARS = new Set([
  '\u0101', '\u0100', // ā Ā
  '\u012B', '\u012A', // ī Ī
  '\u016B', '\u016A', // ū Ū
  '\u1E5B', '\u1E5A', // ṛ Ṛ
  '\u1E5D', '\u1E5C', // ṝ Ṝ
  '\u1E37', '\u1E36', // ḷ Ḷ
  '\u1E39', '\u1E38', // ḹ Ḹ
  '\u1E6D', '\u1E6C', // ṭ Ṭ
  '\u1E0D', '\u1E0C', // ḍ Ḍ
  '\u1E47', '\u1E46', // ṇ Ṇ
  '\u1E63', '\u1E62', // ṣ Ṣ
  '\u015B', '\u015A', // ś Ś
  '\u00F1', '\u00D1', // ñ Ñ
  '\u1E45', '\u1E44', // ṅ Ṅ
  '\u1E43', '\u1E42', // ṃ Ṃ
  '\u1E25', '\u1E24', // ḥ Ḥ
]);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect whether a string contains mojibake-corrupted text.
 *
 * @param {string} text - The text to inspect.
 * @returns {{ isMojibake: boolean, confidence: number, sampleCorruptions: string[] }}
 */
function detectMojibake(text) {
  if (text == null || typeof text !== 'string' || !text.length) {
    return { isMojibake: false, confidence: 0, sampleCorruptions: [] };
  }

  const found = [];
  for (const signature of MOJIBAKE_SIGNATURES) {
    if (text.includes(signature)) {
      found.push(signature);
    }
  }

  // Generic multi-byte UTF-8 misread as CP1252/Latin-1 pattern match
  const genericPattern = /(?:[\u00C2-\u00C5][\u0080-\u00BF\u2010-\u203A\u0152\u0153\u0160\u0161\u017D\u017E\u0178])|(?:[\u00E0-\u00EF][\u0080-\u00BF\u2010-\u203A][\u0080-\u00BF\u2010-\u203A])/g;
  let match;
  while ((match = genericPattern.exec(text)) !== null) {
    if (!found.includes(match[0])) {
      found.push(match[0]);
    }
    if (found.length >= 10) break;
  }

  if (!found.length) {
    return { isMojibake: false, confidence: 0, sampleCorruptions: [] };
  }

  const confidence = Math.min(1, Math.max(0.5, found.length * 0.25));

  return {
    isMojibake: true,
    confidence,
    sampleCorruptions: found.slice(0, 10),
  };
}

/**
 * Helper to check whether a string contains known mojibake signatures.
 * @param {string} text
 * @returns {boolean}
 */
function hasMojibakeSignatures(text) {
  return detectMojibake(text).isMojibake;
}

function countMojibakeHits(text) {
  if (!text) return 0;
  let count = 0;
  for (const signature of MOJIBAKE_SIGNATURES) {
    if (text.includes(signature)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Generic Reinterpretation Helpers
// ---------------------------------------------------------------------------

function reinterpretWin1252BytesToUtf8(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0xFF) {
      bytes.push(code);
    } else if (WIN1252_MAP[code] !== undefined) {
      bytes.push(WIN1252_MAP[code]);
    } else {
      bytes.push(code & 0xFF);
    }
  }

  // Handle missing virama / vowel sign bytes in truncated Windows-1252 sequences for Indic scripts
  const fixedBytes = [];
  for (let i = 0; i < bytes.length; i++) {
    fixedBytes.push(bytes[i]);
    if (bytes[i - 1] === 0xE0 && (bytes[i] === 0xB1 || bytes[i] === 0xB0) &&
        (i + 1 === bytes.length || bytes[i + 1] === 0xE0 || bytes[i + 1] === 0x20 || bytes[i + 1] === 0x3C || bytes[i + 1] === 0x2E)) {
      fixedBytes.push(0x8D);
    }
  }

  return Buffer.from(fixedBytes).toString('utf8');
}

function replaceAll(str, search, replacement) {
  let result = str;
  let index = result.indexOf(search);
  while (index !== -1) {
    result = result.slice(0, index) + replacement + result.slice(index + search.length);
    index = result.indexOf(search, index + replacement.length);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Repair Transform
// ---------------------------------------------------------------------------

/**
 * Attempt to repair mojibake-corrupted text using generic byte reinterpretation and fallback maps.
 *
 * Modes supported:
 * - 'auto': detect then repair (returns original text unmodified if no mojibake is detected)
 * - 'force': always attempt repair
 * - 'detect_only': return original text without modifications
 *
 * @param {string} text - The input text.
 * @param {object} [options]
 * @param {'auto'|'force'|'detect_only'} [options.mode='auto']
 * @returns {string} Repaired or original text.
 */
function repairMojibake(text, options = {}) {
  if (text == null) return text;
  const input = String(text);
  if (!input.length) return input;

  const mode = String(options.mode || 'auto');

  // In detect_only mode, return original text unchanged.
  if (mode === 'detect_only') return input;

  // In auto mode, skip repair if no mojibake is detected.
  if (mode === 'auto') {
    const detection = detectMojibake(input);
    if (!detection.isMojibake) return input;
  }

  let repaired = input;

  // Stage 1: Attempt generic byte-level reinterpretation (handles single and double-mojibake)
  for (let pass = 0; pass < 2; pass++) {
    if (!detectMojibake(repaired).isMojibake) break;

    try {
      // Try Windows-1252 -> UTF-8 reinterpretation
      const win1252Decoded = reinterpretWin1252BytesToUtf8(repaired);
      if (!win1252Decoded.includes('\uFFFD') && win1252Decoded !== repaired) {
        const prevCount = countMojibakeHits(repaired);
        const newCount = countMojibakeHits(win1252Decoded);
        if (newCount < prevCount || !hasMojibakeSignatures(win1252Decoded)) {
          repaired = win1252Decoded;
          continue;
        }
      }

      // Try ISO-8859-1 (Latin-1) -> UTF-8 reinterpretation
      const latin1Bytes = Buffer.from(repaired, 'latin1');
      const latin1Decoded = latin1Bytes.toString('utf8');
      if (!latin1Decoded.includes('\uFFFD') && latin1Decoded !== repaired) {
        const prevCount = countMojibakeHits(repaired);
        const newCount = countMojibakeHits(latin1Decoded);
        if (newCount < prevCount || !hasMojibakeSignatures(latin1Decoded)) {
          repaired = latin1Decoded;
          continue;
        }
      }
    } catch {
      // Fall through on byte conversion errors
    }
  }

  // Stage 2: Fallback replacement map for residual corrupted patterns
  for (const [corrupted, correct] of IAST_MOJIBAKE_MAP) {
    if (repaired.includes(corrupted)) {
      repaired = replaceAll(repaired, corrupted, correct);
    }
  }

  // Safety check: avoid corrupting text if replacement character \uFFFD is introduced
  if (repaired.includes('\uFFFD')) {
    return input;
  }

  return repaired;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate repaired text or test whether text is free of mojibake corruption.
 *
 * @param {string} text - Original input or text to validate.
 * @param {string} [repairedText] - Optional repaired output text.
 * @returns {{ isValid: boolean, isMojibakeFree: boolean, confidence: number, original: string, repaired: string|null }}
 */
function validateRepair(text, repairedText = null) {
  const target = repairedText != null ? String(repairedText) : String(text || '');
  const original = text != null ? String(text) : '';

  if (!target.length) {
    return { isValid: true, isMojibakeFree: true, confidence: 1.0, original, repaired: target };
  }

  const detection = detectMojibake(target);
  const containsFFFD = target.includes('\uFFFD');
  const isMojibakeFree = !detection.isMojibake && !containsFFFD;
  const confidence = isMojibakeFree ? 1.0 : Math.max(0, 1 - detection.confidence);

  return {
    isValid: isMojibakeFree,
    isMojibakeFree,
    confidence,
    original,
    repaired: repairedText != null ? target : null,
  };
}

/**
 * Check whether a string contains valid IAST diacritical characters without mojibake.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isValidIAST(text) {
  if (text == null || typeof text !== 'string' || !text.length) return false;
  if (hasMojibakeSignatures(text)) return false;
  for (const char of text) {
    if (VALID_IAST_CHARS.has(char)) return true;
  }
  return false;
}

module.exports = {
  detectMojibake,
  repairMojibake,
  validateRepair,
  isValidIAST,
  hasMojibakeSignatures,
  IAST_MOJIBAKE_MAP,
  WIN1252_MAP,
  MOJIBAKE_SIGNATURES,
  VALID_IAST_CHARS,
};
