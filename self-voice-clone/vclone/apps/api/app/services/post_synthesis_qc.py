from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class SegmentQCResult:
    index: int
    text: str
    passed: bool
    score: float
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


class PostSynthesisQCService:
    def evaluate_chunks(self, chunks: list[str]) -> dict:
        segment_results: list[dict] = []
        all_passed = True

        for index, chunk in enumerate(chunks, start=1):
            score = 1.0
            reason = "ok"

            if len(chunk) > 240:
                score = 0.72
                reason = "chunk too long for stable narration"
            elif chunk.count(",") > 6:
                score = 0.8
                reason = "heavy clause density may reduce prosody stability"

            passed = score >= 0.78
            if not passed:
                all_passed = False

            segment_results.append(
                SegmentQCResult(index=index, text=chunk, passed=passed, score=round(score, 3), reason=reason).to_dict()
            )

        return {
            "passed": all_passed,
            "segment_results": segment_results,
            "failed_segments": [item["index"] for item in segment_results if not item["passed"]],
        }

    def regeneration_plan(self, chunks: list[str], qc_report: dict) -> dict:
        failed = qc_report.get("failed_segments", [])
        regeneration_targets = []
        for failed_index in failed:
            original = chunks[failed_index - 1]
            regeneration_targets.append(
                {
                    "index": failed_index,
                    "strategy": "split_and_regenerate" if len(original) > 160 else "alternate_seed",
                    "original_text": original,
                }
            )
        return {
            "needed": bool(regeneration_targets),
            "targets": regeneration_targets,
        }