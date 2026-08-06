from __future__ import annotations

import re
from typing import Any

from app.services.transcription import AutoTranscriptionService


class ASRBackcheckService:
    def __init__(self) -> None:
        self.transcriber = AutoTranscriptionService()

    def evaluate(self, *, expected_text: str, chunks: list[str], audio_path: str | None = None) -> dict[str, Any]:
        if audio_path:
            transcription = self.transcriber.transcribe(audio_path)
            if transcription.get("provider") == "faster-whisper" and bool(transcription.get("is_measured", True)):
                observed_text = transcription.get("text", "")
                estimated_wer = self._word_error_rate(expected_text, observed_text)
                return {
                    "provider": "faster-whisper",
                    "is_measured": True,
                    "estimated_wer": estimated_wer,
                    "intelligibility_score": round(max(0.0, 1.0 - estimated_wer), 3),
                    "observed_text": observed_text,
                    "segments": transcription.get("segments", []),
                    "dependency_hook": None,
                    "release_blocker": None,
                }

        normalized_expected = self._normalize(expected_text)
        normalized_render = self._normalize(" ".join(chunks))

        expected_words = normalized_expected.split()
        render_words = normalized_render.split()
        length_gap = abs(len(expected_words) - len(render_words))
        base_wer = 0.02 + (length_gap / max(len(expected_words), 1))
        punctuation_penalty = min(sum(chunk.count(",") for chunk in chunks) * 0.002, 0.08)
        estimated_wer = round(min(0.6, base_wer + punctuation_penalty), 3)
        intelligibility = round(max(0.0, 1.0 - estimated_wer), 3)

        return {
            "provider": "heuristic",
            "is_measured": False,
            "estimated_wer": estimated_wer,
            "intelligibility_score": intelligibility,
            "observed_text": normalized_render,
            "dependency_hook": "Replace with Whisper/faster-whisper back-check for real WER.",
            "release_blocker": "Do not treat this heuristic WER as release-grade validation.",
        }

    def _normalize(self, text: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", (text or "").lower())).strip()

    def _word_error_rate(self, expected_text: str, observed_text: str) -> float:
        expected_words = self._normalize(expected_text).split()
        observed_words = self._normalize(observed_text).split()
        if not expected_words:
            return 0.0 if not observed_words else 1.0

        rows = len(expected_words) + 1
        cols = len(observed_words) + 1
        matrix = [[0] * cols for _ in range(rows)]
        for i in range(rows):
            matrix[i][0] = i
        for j in range(cols):
            matrix[0][j] = j

        for i in range(1, rows):
            for j in range(1, cols):
                cost = 0 if expected_words[i - 1] == observed_words[j - 1] else 1
                matrix[i][j] = min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost,
                )

        return round(matrix[-1][-1] / max(len(expected_words), 1), 3)