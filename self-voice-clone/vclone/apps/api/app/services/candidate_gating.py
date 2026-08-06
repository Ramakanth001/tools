from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import re
import subprocess
from typing import Any, Literal

from app.core.config import get_settings
from app.services.prompt_leak import PromptLeakDetector


@dataclass
class CandidateGateResult:
    passed: bool
    status: Literal["passed", "failed_quality_gate"]
    hard_reasons: list[str]
    prompt_leak: dict[str, Any]
    wer: float | None
    intelligibility_score: float | None
    similarity_score: float | None
    similarity_trusted: bool
    script_mismatch: bool
    duration_ratio: float | None
    repeated_phrase_detected: bool
    quality_score: float
    error_cost: float
    score_direction: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class CandidateGateService:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.prompt_leak_detector = PromptLeakDetector()

    def evaluate(
        self,
        *,
        mode: str,
        target_text: str,
        observed_text: str,
        prompt_text: str,
        audio_path: str,
        backcheck: dict[str, Any],
        similarity: dict[str, Any],
        similarity_trusted: bool,
    ) -> CandidateGateResult:
        leak = self.prompt_leak_detector.detect(target_text=target_text, observed_text=observed_text, prompt_text=prompt_text)
        wer = float(backcheck.get("estimated_wer")) if backcheck.get("estimated_wer") is not None else None
        intelligibility = float(backcheck.get("intelligibility_score")) if backcheck.get("intelligibility_score") is not None else None
        similarity_score = float(similarity.get("similarity_score")) if similarity.get("similarity_score") is not None else None
        similarity_passed = bool(similarity.get("passed"))
        script_mismatch = self._script_mismatch(target_text, observed_text)
        repeated = self._has_repeated_phrase(observed_text)
        duration_ratio = self._duration_ratio(audio_path, target_text)

        hard_reasons: list[str] = []
        if leak.leaked:
            hard_reasons.append("prompt_leak_detected")
        if not (observed_text or "").strip():
            hard_reasons.append("empty_asr_observed_text")
        if script_mismatch:
            hard_reasons.append("script_mismatch")
        if repeated:
            hard_reasons.append("repeated_phrase_detected")
        if duration_ratio is not None and (duration_ratio < 0.35 or duration_ratio > 3.5):
            hard_reasons.append("duration_out_of_expected_range")

        preview = (mode or "preview").lower() == "preview"
        max_wer = 0.25 if preview else 0.18
        min_intelligibility = 0.75 if preview else 0.85
        if wer is not None and wer > max_wer:
            hard_reasons.append(f"wer_above_threshold:{wer:.3f}>{max_wer:.2f}")
        if intelligibility is not None and intelligibility < min_intelligibility:
            hard_reasons.append(f"intelligibility_below_threshold:{intelligibility:.3f}<{min_intelligibility:.2f}")
        if bool(getattr(self.settings, "synthesis_similarity_hard_gate", False)) and similarity_trusted and not similarity_passed:
            hard_reasons.append("trusted_similarity_failed")

        error_cost = self._error_cost(
            wer=wer,
            intelligibility=intelligibility,
            leak_detected=leak.leaked,
            script_mismatch=script_mismatch,
            repeated=repeated,
            duration_ratio=duration_ratio,
            similarity=similarity_score,
            similarity_trusted=similarity_trusted,
        )
        quality_score = max(0.0, min(1.0, 1.0 - error_cost))
        passed = not hard_reasons
        return CandidateGateResult(
            passed=passed,
            status="passed" if passed else "failed_quality_gate",
            hard_reasons=hard_reasons,
            prompt_leak=leak.to_dict(),
            wer=wer,
            intelligibility_score=intelligibility,
            similarity_score=similarity_score,
            similarity_trusted=similarity_trusted,
            script_mismatch=script_mismatch,
            duration_ratio=duration_ratio,
            repeated_phrase_detected=repeated,
            quality_score=quality_score,
            error_cost=error_cost,
            score_direction="higher_quality_score",
        )

    def _error_cost(
        self,
        *,
        wer: float | None,
        intelligibility: float | None,
        leak_detected: bool,
        script_mismatch: bool,
        repeated: bool,
        duration_ratio: float | None,
        similarity: float | None,
        similarity_trusted: bool,
    ) -> float:
        cost = 0.0
        cost += min(1.0, wer if wer is not None else 0.35) * 0.45
        cost += max(0.0, 1.0 - (intelligibility if intelligibility is not None else 0.65)) * 0.20
        cost += 0.45 if leak_detected else 0.0
        cost += 0.25 if script_mismatch else 0.0
        cost += 0.20 if repeated else 0.0
        if duration_ratio is not None:
            cost += min(0.25, abs(1.0 - duration_ratio) * 0.08)
        if similarity_trusted and similarity is not None:
            cost += max(0.0, 0.85 - similarity) * 0.25
        return round(min(1.0, cost), 4)

    def _script_mismatch(self, target: str, observed: str) -> bool:
        return self._mostly_latin(target) and self._mostly_non_latin(observed)

    def _mostly_latin(self, text: str) -> bool:
        letters = [ch for ch in text or "" if ch.isalpha()]
        if not letters:
            return False
        latin = sum(1 for ch in letters if "A" <= ch.upper() <= "Z")
        return latin / len(letters) >= 0.7

    def _mostly_non_latin(self, text: str) -> bool:
        letters = [ch for ch in text or "" if ch.isalpha()]
        if not letters:
            return False
        latin = sum(1 for ch in letters if "A" <= ch.upper() <= "Z")
        return latin / len(letters) < 0.5

    def _has_repeated_phrase(self, text: str) -> bool:
        words = re.sub(r"[^a-z0-9\s]", " ", (text or "").lower()).split()
        if len(words) < 8:
            return False
        counts: dict[str, int] = {}
        for size in (3, 4, 5):
            for index in range(0, len(words) - size + 1):
                gram = " ".join(words[index:index + size])
                counts[gram] = counts.get(gram, 0) + 1
                if counts[gram] >= 3:
                    return True
        return False

    def _duration_ratio(self, audio_path: str, target_text: str) -> float | None:
        duration = self._duration_seconds(audio_path)
        if duration <= 0:
            return None
        words = max(1, len((target_text or "").split()))
        expected = max(1.0, words / 2.4)
        return round(duration / expected, 3)

    def _duration_seconds(self, audio_path: str) -> float:
        path = Path(audio_path)
        if not path.exists():
            return 0.0
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        try:
            return float((result.stdout or "").strip())
        except Exception:
            return 0.0