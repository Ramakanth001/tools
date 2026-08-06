import re
from dataclasses import asdict, dataclass
from typing import Any

from app.services.pronunciation import PronunciationService


_pronunciation = PronunciationService()
_ABBREVIATION_EXPANSIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bfor\s+e\.g\.\s*:?", flags=re.IGNORECASE), "for example "),
    (re.compile(r"(?<!\w)e\.g\.(?!\w)", flags=re.IGNORECASE), "for example"),
    (re.compile(r"(?<!\w)i\.e\.(?!\w)", flags=re.IGNORECASE), "that is"),
]
_PROTECTED_ABBREVIATIONS = {
    "Mr.": "Mr§",
    "Mrs.": "Mrs§",
    "Ms.": "Ms§",
    "Dr.": "Dr§",
    "Prof.": "Prof§",
    "Sr.": "Sr§",
    "Jr.": "Jr§",
    "vs.": "vs§",
    "etc.": "etc§",
    "St.": "St§",
}

_IAST_REPLACEMENTS: list[tuple[str, str]] = [
    ("jñ", "gy"),
    ("Jñ", "Gy"),
    ("JÑ", "Gy"),
    ("ai", "ai"),
    ("au", "au"),
    ("ā", "aa"),
    ("ī", "ee"),
    ("ū", "oo"),
    ("ṛ", "ri"),
    ("ṝ", "ree"),
    ("ḷ", "lri"),
    ("ḹ", "lree"),
    ("ṅ", "ng"),
    ("ñ", "ny"),
    ("ṭ", "t"),
    ("ḍ", "d"),
    ("ṇ", "n"),
    ("ś", "sh"),
    ("ṣ", "sh"),
    ("ṃ", "m"),
    ("ṁ", "m"),
    ("ḥ", "h"),
    ("Ā", "Aa"),
    ("Ī", "Ee"),
    ("Ū", "Oo"),
    ("Ṛ", "Ri"),
    ("Ṝ", "Ree"),
    ("Ḷ", "Lri"),
    ("Ḹ", "Lree"),
    ("Ṅ", "Ng"),
    ("Ñ", "Ny"),
    ("Ṭ", "T"),
    ("Ḍ", "D"),
    ("Ṇ", "N"),
    ("Ś", "Sh"),
    ("Ṣ", "Sh"),
    ("Ṃ", "M"),
    ("Ṁ", "M"),
    ("Ḥ", "H"),
]
_IAST_PATTERN = re.compile(r"[āīūṛṝḷḹṅñṭḍṇśṣṃṁḥĀĪŪṚṜḶḸṄÑṬḌṆŚṢṂṀḤ]")


@dataclass
class TTSPreparedText:
    original_text: str
    normalized_text: str
    synthesis_text: str
    warnings: list[str]
    replacements: list[dict[str, str]]
    prosody_plan: list[dict[str, str]]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def split_paragraphs(text: str) -> list[str]:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = [segment.strip() for segment in re.split(r"\n\s*\n+", raw) if segment.strip()]
    return paragraphs


def normalize_text(text: str, pronunciation_profile: dict[str, Any] | None = None) -> str:
    paragraphs = [_normalize_paragraph(paragraph, pronunciation_profile=pronunciation_profile) for paragraph in split_paragraphs(text)]
    normalized = "\n\n".join(paragraph for paragraph in paragraphs if paragraph)
    return normalized.strip()


def prepare_text_for_tts(text: str, pronunciation_profile: dict[str, Any] | None = None) -> TTSPreparedText:
    original = str(text or "")
    normalized = normalize_text(original, pronunciation_profile=pronunciation_profile)
    synthesis_text, warnings, replacements = _make_tts_safe(normalized, pronunciation_profile=pronunciation_profile)
    return TTSPreparedText(
        original_text=original,
        normalized_text=normalized,
        synthesis_text=synthesis_text,
        warnings=warnings,
        replacements=replacements,
        prosody_plan=_build_prosody_plan(synthesis_text, replacements),
    )


def chunk_text_plan(text: str, max_chars: int = 220) -> list[dict[str, Any]]:
    return _chunk_plan(text, max_chars=max_chars, target_word_limit=26, min_word_limit=12)


def chunk_text_for_clone_plan(text: str, *, mode: str, max_chars: int = 140) -> list[dict[str, Any]]:
    normalized_mode = (mode or "preview").lower()
    target_word_limit = 28 if normalized_mode == "preview" else 45
    min_word_limit = 10 if normalized_mode == "preview" else 14
    return _chunk_plan(text, max_chars=max_chars, target_word_limit=target_word_limit, min_word_limit=min_word_limit)


def chunk_text(text: str, max_chars: int = 220) -> list[str]:
    return [item["text"] for item in chunk_text_plan(text, max_chars=max_chars)]


def chunk_text_for_clone(text: str, *, mode: str, max_chars: int = 140) -> list[str]:
    return [item["text"] for item in chunk_text_for_clone_plan(text, mode=mode, max_chars=max_chars)]


def split_for_regeneration(text: str, max_chars: int = 140) -> list[str]:
    return [item["text"] for item in _chunk_plan(text, max_chars=max_chars, target_word_limit=12, min_word_limit=6)]


def _normalize_paragraph(text: str, pronunciation_profile: dict[str, Any] | None = None) -> str:
    normalized = (text or "").strip()
    normalized = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1-\2", normalized)
    normalized = normalized.replace("&", " and ")
    normalized = normalized.replace("@", " at ")
    normalized = normalized.replace("%", " percent")
    normalized = normalized.replace("“", '"').replace("”", '"').replace("’", "'")
    normalized = normalized.replace("—", "-").replace("–", "-")
    for pattern, replacement in _ABBREVIATION_EXPANSIONS:
        normalized = pattern.sub(replacement, normalized)
    normalized = re.sub(r"\b(\d+)km\b", r"\1 kilometers", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\b(\d+)kg\b", r"\1 kilograms", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\s+([,.;:!?])", r"\1", normalized)
    normalized = re.sub(r"([,.;:!?]){2,}", lambda match: match.group(0)[0], normalized)
    normalized = re.sub(r":\s*(?=[,.;:!?])", " ", normalized)
    normalized = re.sub(r"\s+([,.;:!?])", r"\1", normalized)
    normalized = re.sub(r"([,.;:!?])(\S)", r"\1 \2", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    normalized, _ = _pronunciation.normalize_for_speech(
        normalized,
        pronunciation_profile=pronunciation_profile,
        apply_context_lexicon=False,
    )
    return normalized.strip()


def _make_tts_safe(text: str, pronunciation_profile: dict[str, Any] | None = None) -> tuple[str, list[str], list[dict[str, str]]]:
    warnings: list[str] = []
    replacements: list[dict[str, str]] = []
    safe = text or ""

    safe, quote_replacements = _remove_quote_marks(safe)
    if quote_replacements:
        warnings.append("Quotation marks were removed to avoid TTS mode-switching or shouted quoted spans.")
        replacements.extend(quote_replacements)

    safe, bracket_replacements = _rewrite_bracketed_asides(safe)
    if bracket_replacements:
        warnings.append("Bracketed or parenthetical phrases were rewritten as spoken asides.")
        replacements.extend(bracket_replacements)

    safe, iast_replacements = _transliterate_iast(safe)
    if iast_replacements:
        warnings.append("IAST/Sanskrit diacritics were transliterated for stable English TTS pronunciation.")
        replacements.extend(iast_replacements)

    spoken_safe, pronunciation_notes = _pronunciation.normalize_for_speech(safe, pronunciation_profile=pronunciation_profile)
    if spoken_safe != safe:
        warnings.append("Pronunciation lexicon/context was applied to reduce common mispronunciations.")
        for note in pronunciation_notes:
            replacements.append({"type": "pronunciation_lexicon", "from": note, "to": "spoken_form"})
        safe = spoken_safe

    safe = re.sub(r"\s+([,.;:!?])", r"\1", safe)
    safe = re.sub(r"([,.;:!?]){2,}", lambda match: match.group(0)[0], safe)
    safe = re.sub(r"([,.;:!?])(\S)", r"\1 \2", safe)
    safe = re.sub(r"\s+", " ", safe).strip()
    return safe, warnings, replacements


def _remove_quote_marks(text: str) -> tuple[str, list[dict[str, str]]]:
    replacements: list[dict[str, str]] = []
    safe = text
    # Remove quotation marks that can trigger model mode-switching, but preserve
    # apostrophes inside contractions such as "can't" and possessives.
    quote_chars = ['"', "“", "”"]
    for char in quote_chars:
        if char in safe:
            safe = safe.replace(char, "")
            replacements.append({"type": "quote_removed", "from": char, "to": ""})
    return safe, replacements


def _rewrite_bracketed_asides(text: str) -> tuple[str, list[dict[str, str]]]:
    replacements: list[dict[str, str]] = []

    def replace_parenthetical(match: re.Match[str]) -> str:
        inner = re.sub(r"\s+", " ", match.group(1)).strip(" ,;:-")
        if not inner:
            return " "
        replacement = f", namely {inner},"
        replacements.append({"type": "parenthetical_aside", "from": match.group(0), "to": replacement})
        return replacement

    def replace_square(match: re.Match[str]) -> str:
        inner = re.sub(r"\s+", " ", match.group(1)).strip(" ,;:-")
        if not inner:
            return " "
        replacement = f", {inner},"
        replacements.append({"type": "bracketed_aside", "from": match.group(0), "to": replacement})
        return replacement

    safe = re.sub(r"\(([^()]{1,240})\)", replace_parenthetical, text)
    safe = re.sub(r"\[([^\[\]]{1,240})\]", replace_square, safe)
    safe = re.sub(r"\s+,", ",", safe)
    safe = re.sub(r",\s*,", ",", safe)
    return safe, replacements


def _transliterate_iast(text: str) -> tuple[str, list[dict[str, str]]]:
    if not _IAST_PATTERN.search(text or ""):
        return text, []
    replacements: list[dict[str, str]] = []
    safe = text
    token_pattern = re.compile(r"\b[\wāīūṛṝḷḹṅñṭḍṇśṣṃṁḥĀĪŪṚṜḶḸṄÑṬḌṆŚṢṂṀḤ-]*[āīūṛṝḷḹṅñṭḍṇśṣṃṁḥĀĪŪṚṜḶḸṄÑṬḌṆŚṢṂṀḤ][\wāīūṛṝḷḹṅñṭḍṇśṣṃṁḥĀĪŪṚṜḶḸṄÑṬḌṆŚṢṂṀḤ-]*\b")

    def replace_token(match: re.Match[str]) -> str:
        original = match.group(0)
        transliterated = original
        for source, target in _IAST_REPLACEMENTS:
            transliterated = transliterated.replace(source, target)
        replacements.append({"type": "iast_transliteration", "from": original, "to": transliterated})
        return transliterated

    safe = token_pattern.sub(replace_token, safe)
    return safe, replacements


def _build_prosody_plan(text: str, replacements: list[dict[str, str]]) -> list[dict[str, str]]:
    plan: list[dict[str, str]] = []
    replacement_types = {str(item.get("type") or "") for item in replacements}
    if "parenthetical_aside" in replacement_types or "bracketed_aside" in replacement_types:
        plan.append(
            {
                "feature": "aside",
                "guidance": "Bracketed material was rewritten as an explanatory aside; speak it calmly, not with emphasis.",
            }
        )
    if "quote_removed" in replacement_types:
        plan.append(
            {
                "feature": "quotation",
                "guidance": "Quotation marks were removed to avoid an unstable quoted-voice mode; keep narration continuous.",
            }
        )
    if "iast_transliteration" in replacement_types or "pronunciation_lexicon" in replacement_types:
        plan.append(
            {
                "feature": "sanskrit_iast",
                "guidance": "IAST/Sanskrit/profile terms were rewritten into a pronunciation-friendly spoken form.",
            }
        )
    if re.search(r"\b(God|Atman|Brahman|Krishna|Shiva|Vishnu|dharma|dhar ma|sum saa ra|gyaa na|krish na)\b", text, flags=re.IGNORECASE):
        plan.append(
            {
                "feature": "devotional_explanatory",
                "guidance": "Use a steady devotional/explanatory tone; avoid shouting or dramatic emphasis.",
            }
        )
    return plan


def _chunk_plan(text: str, *, max_chars: int, target_word_limit: int, min_word_limit: int) -> list[dict[str, Any]]:
    normalized = normalize_text(text)
    if not normalized:
        return []

    units: list[dict[str, str]] = []
    paragraphs = split_paragraphs(normalized)
    for paragraph_index, paragraph in enumerate(paragraphs):
        sentences = _split_sentences(paragraph)
        if not sentences:
            continue
        for sentence_index, sentence in enumerate(sentences):
            is_last_sentence = sentence_index == len(sentences) - 1
            boundary = "paragraph" if is_last_sentence and paragraph_index < len(paragraphs) - 1 else "sentence"
            oversized_units = _split_oversized_sentence(sentence, max_chars=max_chars)
            for oversize_index, unit in enumerate(oversized_units):
                unit_boundary = boundary if oversize_index == len(oversized_units) - 1 else "clause"
                units.append({"text": unit, "break_after": unit_boundary})

    chunks: list[dict[str, Any]] = []
    current_text = ""
    current_word_count = 0
    current_boundary = "soft"

    for unit in units:
        unit_text = str(unit["text"]).strip()
        if not unit_text:
            continue
        unit_word_count = len(unit_text.split())
        candidate = f"{current_text} {unit_text}".strip() if current_text else unit_text
        candidate_word_count = current_word_count + unit_word_count
        if current_text and (len(candidate) > max_chars or candidate_word_count > target_word_limit):
            chunks.append({"text": current_text, "break_after": current_boundary})
            current_text = unit_text
            current_word_count = unit_word_count
            current_boundary = str(unit.get("break_after") or "soft")
            continue
        current_text = candidate
        current_word_count = candidate_word_count
        current_boundary = str(unit.get("break_after") or current_boundary)
        if current_word_count >= min_word_limit and current_boundary in {"sentence", "paragraph"}:
            chunks.append({"text": current_text, "break_after": current_boundary})
            current_text = ""
            current_word_count = 0
            current_boundary = "soft"

    if current_text:
        if chunks and current_word_count < min_word_limit:
            merged = f"{chunks[-1]['text']} {current_text}".strip()
            if len(merged) <= int(max_chars * 1.2):
                chunks[-1]["text"] = merged
                chunks[-1]["break_after"] = current_boundary
            else:
                chunks.append({"text": current_text, "break_after": current_boundary})
        else:
            chunks.append({"text": current_text, "break_after": current_boundary})
    return chunks


def _split_sentences(paragraph: str) -> list[str]:
    protected = paragraph
    for original, token in _PROTECTED_ABBREVIATIONS.items():
        protected = re.sub(re.escape(original), token, protected, flags=re.IGNORECASE)
    protected = re.sub(r"(?<=\d)\.(?=\d)", "§", protected)
    sentences = [segment.strip() for segment in re.split(r"(?<=[.!?])\s+", protected) if segment.strip()]
    restored: list[str] = []
    for sentence in sentences:
        sentence = sentence.replace("§", ".")
        for original, token in _PROTECTED_ABBREVIATIONS.items():
            sentence = re.sub(re.escape(token), original, sentence, flags=re.IGNORECASE)
        restored.append(sentence.strip())
    return restored


def _split_oversized_sentence(sentence: str, *, max_chars: int) -> list[str]:
    if len(sentence) <= max_chars:
        return [sentence]

    clauses = [segment.strip() for segment in re.split(r"(?<=[,;:])\s+", sentence) if segment.strip()]
    if len(clauses) > 1:
        grouped: list[str] = []
        current = ""
        for clause in clauses:
            candidate = f"{current} {clause}".strip() if current else clause
            if len(candidate) <= max_chars:
                current = candidate
            else:
                if current:
                    grouped.append(current)
                current = clause
        if current:
            grouped.append(current)
        if all(len(group) <= max_chars for group in grouped):
            return grouped

    words = sentence.split()
    grouped_words: list[str] = []
    current_words: list[str] = []
    for word in words:
        candidate = " ".join(current_words + [word]).strip()
        if len(candidate) > max_chars and current_words:
            grouped_words.append(" ".join(current_words))
            current_words = [word]
        else:
            current_words.append(word)

    if current_words:
        grouped_words.append(" ".join(current_words))
    return grouped_words
