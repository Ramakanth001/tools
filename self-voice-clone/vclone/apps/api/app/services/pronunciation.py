from __future__ import annotations

import re
from collections import Counter
from typing import Any


class PronunciationService:
    LEXICON = {
        "aatman": "aat man",
        "atman": "aat man",
        "brahman": "bruh mun",
        "spotify": "spot if eye",
        "ramakanth": "raa maa kanth",
        "coqui": "co kee",
        "xtts": "X T T S",
        "dharma": "dhar ma",
        "karma": "kar ma",
        "krishna": "krish na",
        "gyaana": "gyaa na",
        "jnana": "gyaa na",
        "samsaara": "sum saa ra",
        "samsara": "sum saa ra",
        "shiva": "shi va",
        "vishnu": "vish noo",
        "upanishad": "oo pun ni shud",
        "vedanta": "vay daan ta",
    }

    IAST_PRONUNCIATION_OVERRIDES = {
        "ātman": "aat man",
        "ātmā": "aat maa",
        "brahman": "bruh mun",
        "brāhmaṇa": "braah ma na",
        "dharma": "dhar ma",
        "karma": "kar ma",
        "kṛṣṇa": "krish na",
        "jñāna": "gyaa na",
        "saṃsāra": "sum saa ra",
        "samsāra": "sum saa ra",
        "śrī": "shree",
        "śiva": "shi va",
        "viṣṇu": "vish noo",
        "upaniṣad": "oo pun ni shud",
        "vedānta": "vay daan ta",
    }

    def normalize_for_speech(
        self,
        text: str,
        pronunciation_profile: dict[str, Any] | None = None,
        *,
        apply_context_lexicon: bool = True,
    ) -> tuple[str, list[str]]:
        notes: list[str] = []
        normalized = (text or "").strip()

        normalized = re.sub(r"\bUSD\b", "U S dollars", normalized, flags=re.IGNORECASE)
        normalized = re.sub(r"\bAI\b", "A I", normalized)
        normalized = re.sub(r"\bML\b", "M L", normalized)
        normalized = re.sub(r"\bTTS\b", "T T S", normalized)
        normalized = re.sub(r"\bETA\b", "E T A", normalized)

        if apply_context_lexicon:
            combined_lexicon = dict(self.IAST_PRONUNCIATION_OVERRIDES)
            combined_lexicon.update(self.LEXICON)
            combined_lexicon.update(self._profile_lexicon(pronunciation_profile))

            for word, spoken in sorted(combined_lexicon.items(), key=lambda item: len(item[0]), reverse=True):
                updated = re.sub(rf"\b{re.escape(word)}\b", spoken, normalized, flags=re.IGNORECASE)
                if updated != normalized:
                    notes.append(f"Applied pronunciation lexicon override for '{word}'.")
                    normalized = updated

        normalized = re.sub(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b", r"\1 slash \2 slash \3", normalized)
        normalized = re.sub(r"\b(\d{1,2}):(\d{2})\b", r"\1 \2", normalized)
        normalized = re.sub(r"\bRs\.?\s*(\d+(?:\.\d+)?)\b", r"\1 rupees", normalized, flags=re.IGNORECASE)

        def replace_currency(match: re.Match[str]) -> str:
            notes.append("Expanded currency token for speech clarity.")
            return f"{match.group(1)} rupees"

        normalized = re.sub(r"₹\s*(\d+(?:\.\d+)?)", replace_currency, normalized)

        def replace_number(match: re.Match[str]) -> str:
            value = match.group(0)
            if len(value) <= 2:
                return value
            notes.append("Expanded long numeric token into grouped speech form.")
            return " ".join(value[i : i + 2] for i in range(0, len(value), 2))

        normalized = re.sub(r"\b\d{3,}\b", replace_number, normalized)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        return normalized, notes

    def build_profile_from_transcript(self, transcript_text: str, *, max_terms: int = 80) -> dict[str, Any]:
        """Build an advisory pronunciation context from the whole profile transcript.

        This does not fail enrollment and does not claim to fine-tune the model. It
        simply remembers domain words seen in the user's full audio/SRT so synthesis
        can rewrite future text into a more speakable form before calling TTS.
        """
        text = transcript_text or ""
        lexicon: dict[str, str] = {}
        sources: dict[str, str] = {}

        for written, spoken in self.IAST_PRONUNCIATION_OVERRIDES.items():
            if re.search(rf"\b{re.escape(written)}\b", text, flags=re.IGNORECASE):
                lexicon[written] = spoken
                sources[written] = "iast_context_from_profile_transcript"

        token_pattern = re.compile(r"\b[\wāīūṛṝḷḹṅñṭḍṇśṣṃṁḥĀĪŪṚṜḶḸṄÑṬḌṆŚṢṂṀḤ-]*[āīūṛṝḷḹṅñṭḍṇśṣṃṁḥĀĪŪṚṜḶḸṄÑṬḌṆŚṢṂṀḤ][\wāīūṛṝḷḹṅñṭḍṇśṣṃṁḥĀĪŪṚṜḶḸṄÑṬḌṆŚṢṂṀḤ-]*\b")
        for token in token_pattern.findall(text):
            if token not in lexicon:
                lexicon[token] = self._basic_iast_spoken_form(token)
                sources[token] = "iast_transliterated_from_profile_transcript"

        words = re.findall(r"\b[A-Z][A-Za-z]{2,}\b", text)
        for word, count in Counter(words).most_common(max_terms):
            lower = word.lower()
            if lower in self.LEXICON and word not in lexicon:
                lexicon[word] = self.LEXICON[lower]
                sources[word] = f"known_term_seen_{count}_times_in_profile_transcript"

        return {
            "status": "ready" if lexicon else "empty",
            "source": "full_profile_transcript_or_srt",
            "description": "Advisory pronunciation context extracted from the whole enrolled transcript. It rewrites future synthesis text but never blocks synthesis.",
            "lexicon": dict(list(lexicon.items())[:max_terms]),
            "sources": sources,
        }

    def _profile_lexicon(self, pronunciation_profile: dict[str, Any] | None) -> dict[str, str]:
        if not pronunciation_profile:
            return {}
        raw = pronunciation_profile.get("lexicon") if isinstance(pronunciation_profile, dict) else None
        if not isinstance(raw, dict):
            return {}
        return {str(key): str(value) for key, value in raw.items() if str(key).strip() and str(value).strip()}

    def _basic_iast_spoken_form(self, token: str) -> str:
        replacements = [
            ("jñ", "gyaa"), ("Jñ", "Gyaa"), ("ā", "aa"), ("ī", "ee"), ("ū", "oo"),
            ("ṛ", "ri"), ("ṝ", "ree"), ("ḷ", "lri"), ("ṅ", "ng"), ("ñ", "ny"),
            ("ṭ", "t"), ("ḍ", "d"), ("ṇ", "n"), ("ś", "sh"), ("ṣ", "sh"),
            ("ṃ", "m"), ("ṁ", "m"), ("ḥ", "h"),
            ("Ā", "Aa"), ("Ī", "Ee"), ("Ū", "Oo"), ("Ṛ", "Ri"), ("Ṅ", "Ng"),
            ("Ñ", "Ny"), ("Ṭ", "T"), ("Ḍ", "D"), ("Ṇ", "N"), ("Ś", "Sh"),
            ("Ṣ", "Sh"), ("Ṃ", "M"), ("Ṁ", "M"), ("Ḥ", "H"),
        ]
        spoken = token
        for source, target in replacements:
            spoken = spoken.replace(source, target)
        return spoken