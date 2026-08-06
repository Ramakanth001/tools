from __future__ import annotations

from dataclasses import asdict, dataclass
import re


@dataclass
class SRTSegment:
    index: int
    start_ms: int
    end_ms: int
    duration_ms: int
    text: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SRTParseResult:
    segments: list[SRTSegment]
    full_text: str
    warnings: list[str]

    def to_dict(self) -> dict:
        return {
            "segment_count": len(self.segments),
            "full_text": self.full_text,
            "warnings": self.warnings,
            "segments": [segment.to_dict() for segment in self.segments],
        }


class SRTParserService:
    TIME_RE = re.compile(
        r"(?P<sh>\d{2}):(?P<sm>\d{2}):(?P<ss>\d{2})[,.](?P<sms>\d{1,3})\s*-->\s*"
        r"(?P<eh>\d{2}):(?P<em>\d{2}):(?P<es>\d{2})[,.](?P<ems>\d{1,3})"
    )

    def parse_text(self, content: str) -> SRTParseResult:
        normalized = (content or "").replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n")
        blocks = re.split(r"\n\s*\n", normalized.strip()) if normalized.strip() else []
        segments: list[SRTSegment] = []
        warnings: list[str] = []
        previous_end = -1

        for block_number, block in enumerate(blocks, start=1):
            lines = [line.strip() for line in block.split("\n") if line.strip()]
            if not lines:
                continue

            time_line_index = next((idx for idx, line in enumerate(lines) if "-->" in line), -1)
            if time_line_index < 0:
                warnings.append(f"Block {block_number} skipped: missing timestamp line.")
                continue

            match = self.TIME_RE.search(lines[time_line_index])
            if not match:
                warnings.append(f"Block {block_number} skipped: invalid timestamp format.")
                continue

            start_ms = self._time_to_ms(match, "s")
            end_ms = self._time_to_ms(match, "e")
            if end_ms <= start_ms:
                warnings.append(f"Block {block_number} skipped: non-positive duration.")
                continue

            text = self._clean_text(" ".join(lines[time_line_index + 1 :]))
            if not text:
                warnings.append(f"Block {block_number} skipped: empty subtitle text.")
                continue

            if previous_end >= 0 and start_ms < previous_end:
                warnings.append(f"Block {block_number} overlaps previous subtitle.")
            previous_end = max(previous_end, end_ms)

            index = len(segments) + 1
            segments.append(SRTSegment(index=index, start_ms=start_ms, end_ms=end_ms, duration_ms=end_ms - start_ms, text=text))

        full_text = " ".join(segment.text for segment in segments).strip()
        return SRTParseResult(segments=segments, full_text=full_text, warnings=warnings)

    def apply_offset(self, segments: list[SRTSegment], offset_ms: int) -> list[SRTSegment]:
        if not offset_ms:
            return segments
        shifted: list[SRTSegment] = []
        for segment in segments:
            start_ms = max(0, segment.start_ms + offset_ms)
            end_ms = max(start_ms + 1, segment.end_ms + offset_ms)
            shifted.append(
                SRTSegment(
                    index=segment.index,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    duration_ms=end_ms - start_ms,
                    text=segment.text,
                )
            )
        return shifted

    def _time_to_ms(self, match: re.Match[str], prefix: str) -> int:
        hours = int(match.group(f"{prefix}h"))
        minutes = int(match.group(f"{prefix}m"))
        seconds = int(match.group(f"{prefix}s"))
        milliseconds = int(match.group(f"{prefix}ms").ljust(3, "0")[:3])
        return ((hours * 60 * 60 + minutes * 60 + seconds) * 1000) + milliseconds

    def _clean_text(self, text: str) -> str:
        cleaned = re.sub(r"<[^>]+>", " ", text or "")
        cleaned = re.sub(r"\{[^}]+\}", " ", cleaned)
        cleaned = re.sub(r"^\s*(?:speaker|narrator|host|male|female|voiceover|swami)\s*\d*\s*[:-]+\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"^\s*[A-Za-z][A-Za-z' ]{0,30}\s+(?:replies?|reply|says?|said|asks?|asked|speaks?)\s*[:-]+\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"^\s*\[[^\]]{0,30}\]\s*", "", cleaned)
        cleaned = re.sub(r"^\s*\([^\)]{0,30}\)\s*", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned