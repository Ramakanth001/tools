from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any


DEVANAGARI_TO_IAST_INDEPENDENT = {
    "अ": "a", "आ": "ā", "इ": "i", "ई": "ī", "उ": "u", "ऊ": "ū", "ऋ": "ṛ", "ॠ": "ṝ",
    "ऌ": "ḷ", "ॡ": "ḹ", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
}

DEVANAGARI_TO_IAST_CONSONANT = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ṅ",
    "च": "c", "छ": "ch", "ज": "j", "झ": "jh", "ञ": "ñ",
    "ट": "ṭ", "ठ": "ṭh", "ड": "ḍ", "ढ": "ḍh", "ण": "ṇ",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v",
    "श": "ś", "ष": "ṣ", "स": "s", "ह": "h",
    "ळ": "ḻ", "क्ष": "kṣ", "ज्ञ": "jñ",
}

DEVANAGARI_MATRAS = {
    "ा": "ā", "ि": "i", "ी": "ī", "ु": "u", "ू": "ū", "ृ": "ṛ", "ॄ": "ṝ",
    "ॢ": "ḷ", "ॣ": "ḹ", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
}

DEVANAGARI_SIGNS = {
    "ं": "ṃ", "ँ": "m̐", "ः": "ḥ", "ऽ": "'", "ॐ": "oṃ",
    "।": ".", "॥": ".",
}

IAST_TO_TTS_REPLACEMENTS: list[tuple[str, str]] = [
    ("jñ", "gyaa"), ("Jñ", "Gyaa"),
    ("kṣ", "ksh"), ("Kṣ", "Ksh"),
    ("ā", "aa"), ("ī", "ee"), ("ū", "oo"),
    ("ṛ", "ri"), ("ṝ", "ree"), ("ḷ", "lri"), ("ḹ", "lree"),
    ("ṅ", "ng"), ("ñ", "ny"),
    ("ṭ", "t"), ("ḍ", "d"), ("ṇ", "n"),
    ("ś", "sh"), ("ṣ", "sh"),
    ("ṃ", "m"), ("ṁ", "m"), ("ḥ", "h"),
    ("Ā", "Aa"), ("Ī", "Ee"), ("Ū", "Oo"),
    ("Ṛ", "Ri"), ("Ṝ", "Ree"), ("Ḷ", "Lri"), ("Ḹ", "Lree"),
    ("Ṅ", "Ng"), ("Ñ", "Ny"), ("Ṭ", "T"), ("Ḍ", "D"), ("Ṇ", "N"),
    ("Ś", "Sh"), ("Ṣ", "Sh"), ("Ṃ", "M"), ("Ṁ", "M"), ("Ḥ", "H"),
]

DEVANAGARI_PATTERN = re.compile(r"[\u0900-\u097F]")
IAST_PATTERN = re.compile(r"[āīūṛṝḷḹṅñṭḍṇśṣṃṁḥĀĪŪṚṜḶḸṄÑṬḌṆŚṢṂṀḤ]")


@dataclass
class SanskritNormalizationResult:
    original_text: str
    detected_script: str
    iast_text: str
    tts_phonetic_text: str
    replacements: list[dict[str, str]]
    warnings: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class SanskritNormalizationService:
    """Normalizes Sanskrit text for training export and synthesis.

    The goal is not scholarly-perfect transliteration.  It is a deterministic,
    inspectable layer that preserves Sanskrit phonetic intent for engines whose
    text frontends are strongest with Latin/English-like input.
    """

    def normalize(self, text: str, *, lexicon: dict[str, str] | None = None) -> SanskritNormalizationResult:
        original = str(text or "")
        warnings: list[str] = []
        replacements: list[dict[str, str]] = []
        detected_script = self.detect_script(original)

        if detected_script == "devanagari":
            iast = self.devanagari_to_iast(original)
            replacements.append({"type": "devanagari_to_iast", "from": original, "to": iast})
        else:
            iast = original

        iast = self._normalize_iast_spacing(iast)
        tts = self.iast_to_tts_phonetic(iast)
        if tts != iast:
            replacements.append({"type": "iast_to_tts_phonetic", "from": iast, "to": tts})

        tts_after_lexicon = self.apply_lexicon(tts, lexicon or {}, replacements)
        if detected_script == "unknown" and not (IAST_PATTERN.search(original) or DEVANAGARI_PATTERN.search(original)):
            warnings.append("No Sanskrit-specific script/diacritics detected; text was treated as plain roman input.")

        return SanskritNormalizationResult(
            original_text=original,
            detected_script=detected_script,
            iast_text=iast,
            tts_phonetic_text=tts_after_lexicon,
            replacements=replacements,
            warnings=warnings,
        )

    def detect_script(self, text: str) -> str:
        if DEVANAGARI_PATTERN.search(text or ""):
            return "devanagari"
        if IAST_PATTERN.search(text or ""):
            return "iast"
        if re.search(r"\b(om|aum|dharma|karma|moksha|bhagavad|gita|geeta|atman|brahman|shiva|krishna)\b", text or "", flags=re.IGNORECASE):
            return "roman_sanskrit_hint"
        return "unknown"

    def devanagari_to_iast(self, text: str) -> str:
        output: list[str] = []
        index = 0
        while index < len(text):
            # Handle common conjuncts first.
            two = text[index : index + 2]
            if two in DEVANAGARI_TO_IAST_CONSONANT:
                base = DEVANAGARI_TO_IAST_CONSONANT[two]
                index += 2
                matra = text[index] if index < len(text) else ""
                if matra == "्":
                    output.append(base)
                    index += 1
                elif matra in DEVANAGARI_MATRAS:
                    output.append(base + DEVANAGARI_MATRAS[matra])
                    index += 1
                else:
                    output.append(base + "a")
                continue

            char = text[index]
            if char in DEVANAGARI_TO_IAST_INDEPENDENT:
                output.append(DEVANAGARI_TO_IAST_INDEPENDENT[char])
                index += 1
                continue
            if char in DEVANAGARI_TO_IAST_CONSONANT:
                base = DEVANAGARI_TO_IAST_CONSONANT[char]
                index += 1
                matra = text[index] if index < len(text) else ""
                if matra == "्":
                    output.append(base)
                    index += 1
                elif matra in DEVANAGARI_MATRAS:
                    output.append(base + DEVANAGARI_MATRAS[matra])
                    index += 1
                else:
                    output.append(base + "a")
                continue
            if char in DEVANAGARI_SIGNS:
                output.append(DEVANAGARI_SIGNS[char])
            elif char in DEVANAGARI_MATRAS or char == "्":
                # Stray matra/virama; skip rather than emitting broken text.
                pass
            else:
                output.append(char)
            index += 1
        return "".join(output)

    def iast_to_tts_phonetic(self, text: str) -> str:
        spoken = str(text or "")
        for source, target in IAST_TO_TTS_REPLACEMENTS:
            spoken = spoken.replace(source, target)
        spoken = re.sub(r"\boṃ\b", "om", spoken, flags=re.IGNORECASE)
        spoken = re.sub(r"\s+", " ", spoken)
        return spoken.strip()

    def apply_lexicon(self, text: str, lexicon: dict[str, str], replacements: list[dict[str, str]] | None = None) -> str:
        normalized = str(text or "")
        replacements = replacements if replacements is not None else []
        for written, spoken in sorted((lexicon or {}).items(), key=lambda item: len(str(item[0])), reverse=True):
            if not str(written).strip() or not str(spoken).strip():
                continue
            updated = re.sub(rf"\b{re.escape(str(written))}\b", str(spoken), normalized, flags=re.IGNORECASE)
            if updated != normalized:
                replacements.append({"type": "sanskrit_lexicon", "from": str(written), "to": str(spoken)})
                normalized = updated
        return re.sub(r"\s+", " ", normalized).strip()

    def _normalize_iast_spacing(self, text: str) -> str:
        normalized = str(text or "").replace("।", ".").replace("॥", ".")
        normalized = re.sub(r"\s+([,.;:!?])", r"\1", normalized)
        normalized = re.sub(r"([,.;:!?])(\S)", r"\1 \2", normalized)
        normalized = re.sub(r"\s+", " ", normalized)
        return normalized.strip()
