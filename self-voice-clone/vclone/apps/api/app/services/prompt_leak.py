from __future__ import annotations

from dataclasses import asdict, dataclass
import re
import unicodedata


@dataclass
class PromptLeakResult:
    leaked: bool
    reasons: list[str]
    matched_phrases: list[str]
    observed_prefix: str
    prompt_suffixes: list[str]
    prompt_ngrams: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


_STOP_WORDS = {
    "a", "an", "and", "are", "as", "be", "by", "for", "from", "in", "is", "it",
    "of", "on", "or", "that", "the", "this", "to", "with",
}


class PromptLeakDetector:
    def detect(self, *, target_text: str, observed_text: str, prompt_text: str) -> PromptLeakResult:
        target = self.normalize(target_text)
        observed = self.normalize(observed_text)
        prompt = self.normalize(prompt_text)
        target_words = target.split()
        observed_words = observed.split()
        prompt_words = prompt.split()

        suffixes = self._prompt_suffixes(prompt_words)
        ngrams = self._ngrams(prompt_words, 4) + self._ngrams(prompt_words, 5)
        blocked_phrases = self._dedupe([*suffixes, *ngrams])
        matched_phrases: list[str] = []
        reasons: list[str] = []

        for phrase in blocked_phrases:
            if phrase and phrase in observed and phrase not in target:
                matched_phrases.append(phrase)
        if matched_phrases:
            reasons.append("observed_text_contains_prompt_phrase_not_in_target")

        observed_prefix = " ".join(observed_words[:8])
        prompt_content = [word for word in prompt_words if word not in _STOP_WORDS]
        target_content = set(word for word in target_words if word not in _STOP_WORDS)
        leading_prompt_words = [word for word in observed_words[:8] if word in prompt_content and word not in target_content]
        if len(leading_prompt_words) >= 3:
            reasons.append("observed_prefix_contains_three_or_more_prompt_content_words")

        first_target_index = self._first_target_word_index(observed_words, target_words)
        if first_target_index is not None and first_target_index > 2:
            inserted = [word for word in observed_words[:first_target_index] if word not in _STOP_WORDS]
            if len(inserted) > 2:
                reasons.append("observed_has_more_than_two_inserted_content_words_before_first_target_word")

        if self._prefix_overlap(observed_words, prompt_words) > self._prefix_overlap(observed_words, target_words) + 1:
            reasons.append("observed_prefix_aligns_more_strongly_to_prompt_than_target")

        if self._mostly_latin(target_text) and self._mostly_non_latin(observed_text):
            reasons.append("target_latin_but_observed_mostly_non_latin")

        return PromptLeakResult(
            leaked=bool(reasons),
            reasons=sorted(set(reasons)),
            matched_phrases=matched_phrases,
            observed_prefix=observed_prefix,
            prompt_suffixes=suffixes,
            prompt_ngrams=ngrams,
        )

    def normalize(self, text: str) -> str:
        normalized = unicodedata.normalize("NFKD", text or "")
        normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
        normalized = normalized.lower()
        replacements = {
            "krsna": "krishna",
            "krshna": "krishna",
            "bhagavadgita": "bhagavad gita",
            "sankara": "shankara",
            "ajna": "ajna",
            "kundalini": "kundalini",
        }
        for source, target in replacements.items():
            normalized = normalized.replace(source, target)
        normalized = re.sub(r"[^a-z0-9\s]", " ", normalized)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        return normalized

    def _prompt_suffixes(self, words: list[str]) -> list[str]:
        suffixes = []
        for size in (3, 4, 5, 6):
            if len(words) >= size:
                suffixes.append(" ".join(words[-size:]))
        if len(words) >= 2:
            suffixes.append(" ".join(words[-2:]))
        return self._dedupe(suffixes)

    def _ngrams(self, words: list[str], size: int) -> list[str]:
        if len(words) < size:
            return []
        return [" ".join(words[index:index + size]) for index in range(0, len(words) - size + 1)]

    def _dedupe(self, items: list[str]) -> list[str]:
        seen: set[str] = set()
        deduped = []
        for item in items:
            clean = item.strip()
            if not clean or clean in seen:
                continue
            seen.add(clean)
            deduped.append(clean)
        return deduped

    def _first_target_word_index(self, observed_words: list[str], target_words: list[str]) -> int | None:
        target_content = [word for word in target_words if word not in _STOP_WORDS]
        if not target_content:
            return None
        for index, word in enumerate(observed_words):
            if word == target_content[0]:
                return index
        for index, word in enumerate(observed_words):
            if word in target_content[:3]:
                return index
        return None

    def _prefix_overlap(self, observed_words: list[str], comparison_words: list[str]) -> int:
        comparison = set(comparison_words)
        return sum(1 for word in observed_words[:8] if word in comparison)

    def _mostly_latin(self, text: str) -> bool:
        letters = [ch for ch in text or "" if ch.isalpha()]
        if not letters:
            return False
        latin = sum(1 for ch in letters if "A" <= ch.upper() <= "Z")
        return latin / max(len(letters), 1) >= 0.7

    def _mostly_non_latin(self, text: str) -> bool:
        letters = [ch for ch in text or "" if ch.isalpha()]
        if not letters:
            return False
        latin = sum(1 for ch in letters if "A" <= ch.upper() <= "Z")
        return latin / max(len(letters), 1) < 0.5
