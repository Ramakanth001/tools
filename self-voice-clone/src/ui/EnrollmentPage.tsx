import { useEffect, useState } from "react";
import {
  cancelUploadProcessing,
  completeUploadSession,
  createUploadSession,
  getUploadSession,
  retryUploadProcessing,
  uploadSessionChunk,
  uploadSessionTranscript,
  type UploadSessionResponse,
} from "./api";
import { SectionCard } from "./SectionCard";

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 3;
const DEFAULT_RETRY_UPLOAD_ID = "091ea816-cc4d-4371-9807-6c628f23ff61";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(seconds?: number | null): string {
  if (seconds == null || Number.isNaN(seconds)) return "not available";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function selectedFile(value: FormDataEntryValue | null): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

export default function EnrollmentPage() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [chunkProgress, setChunkProgress] = useState(0);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [uploadDetails, setUploadDetails] = useState<string | null>(null);
  const [audioInfo, setAudioInfo] = useState<{ name: string; size: number; type: string } | null>(null);
  const [srtInfo, setSrtInfo] = useState<{ name: string; size: number } | null>(null);
  const [retryUploadId, setRetryUploadId] = useState(DEFAULT_RETRY_UPLOAD_ID);
  const [extensionWarning, setExtensionWarning] = useState<string | null>(null);

  useEffect(() => {
    function onWindowError(event: ErrorEvent) {
      const isExtensionError = event.filename?.startsWith("moz-extension://") || event.message.includes("moz-extension://");
      if (isExtensionError) {
        setExtensionWarning("A Firefox extension threw an error on this page. If file upload controls misbehave, retry with that extension disabled or use a clean browser profile.");
        event.preventDefault();
      }
    }
    window.addEventListener("error", onWindowError);
    return () => window.removeEventListener("error", onWindowError);
  }, []);

  async function uploadChunkWithRetry(uploadId: string, chunkIndex: number, chunk: Blob): Promise<UploadSessionResponse> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt += 1) {
      try {
        if (attempt > 1) setStatusText(`Retrying chunk ${chunkIndex + 1}, attempt ${attempt}/${MAX_CHUNK_RETRIES}...`);
        return await uploadSessionChunk(uploadId, chunkIndex, chunk, ({ percent }) => setChunkProgress(percent));
      } catch (caught) {
        lastError = caught;
        if (attempt < MAX_CHUNK_RETRIES) await sleep(800 * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Chunk ${chunkIndex + 1} failed after retries.`);
  }

  async function pollProcessing(uploadId: string): Promise<UploadSessionResponse> {
    for (;;) {
      const session = await getUploadSession(uploadId);
      const stage = session.stage ?? session.status;
      setProcessingProgress(session.processing_percent || (session.status === "completed" ? 100 : 40));
      setStatusText(session.processing_message || `Processing stage: ${stage}`);
      setUploadDetails(
        `Upload ID: ${session.upload_id} | Stage: ${stage} | Attempt: ${session.processing_attempt || 1}` +
          (session.total_segments ? ` | Segment ${session.current_segment_index}/${session.total_segments}` : "") +
          ` | Accepted: ${session.accepted_segments || 0}, Rejected: ${session.rejected_segments || 0}` +
          (session.processing_elapsed_seconds != null ? ` | Processing time: ${formatDuration(session.processing_elapsed_seconds)}` : "") +
          (session.last_updated_at ? ` | Updated: ${session.last_updated_at}` : "") +
          (session.voice_profile_id ? ` | Voice profile: ${session.voice_profile_id}` : "")
      );
      if (session.status === "completed") return session;
      if (["failed", "cancelled"].includes(session.status)) throw new Error(session.error ?? `Processing ${session.status}`);
      await sleep(2000);
    }
  }

  async function retryProcessing(uploadId: string) {
    const cleanUploadId = uploadId.trim();
    if (!cleanUploadId) {
      setError("Enter an upload/session ID to retry processing.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setUploadProgress(100);
    setChunkProgress(100);
    setProcessingProgress(1);
    setStatusText("Requesting retry from preserved original upload...");
    try {
      await retryUploadProcessing(cleanUploadId);
      const completed = await pollProcessing(cleanUploadId);
      setResult({
        upload_id: completed.upload_id,
        status: completed.status,
        voice_profile_id: completed.voice_profile_id,
        processing_elapsed_seconds: completed.processing_elapsed_seconds,
        processing_started_at: completed.processing_started_at,
        processing_completed_at: completed.processing_completed_at,
      });
      setStatusText("Processing complete.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Retry processing failed.");
      setStatusText("Retry processing failed.");
    } finally {
      setLoading(false);
    }
  }

  async function cancelProcessing(uploadId: string) {
    const cleanUploadId = uploadId.trim();
    if (!cleanUploadId) {
      setError("Enter an upload/session ID to cancel processing.");
      return;
    }
    try {
      await cancelUploadProcessing(cleanUploadId);
      setStatusText("Cancellation requested. Backend will stop at the next safe checkpoint.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cancel request failed.");
    }
  }

  return (
    <div className="grid two-col">
      <SectionCard title="Create your voice profile" kicker="Large-file enrollment">
        <div className="page-header">
          <h1>Upload and process your voice sample</h1>
          <p className="muted">Best-quality large-audio enrollment: chunked upload, SRT alignment, clean segment extraction, and a curated prompt bundle for VoxCPM2/Chatterbox voice cloning.</p>
        </div>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setLoading(true);
            setError(null);
            setResult(null);
            setUploadProgress(0);
            setChunkProgress(0);
            setProcessingProgress(0);
            setStatusText("Preparing upload session...");
            setUploadDetails(null);
            const data = new FormData(event.currentTarget);
            try {
              const audioFile = selectedFile(data.get("audio_file"));
              const srtFile = selectedFile(data.get("transcript_file"));
              if (!audioFile) throw new Error("Please select an audio file to upload.");
              if (audioFile.size > MAX_UPLOAD_SIZE_BYTES) throw new Error(`Selected file is ${formatBytes(audioFile.size)}. Limit is ${formatBytes(MAX_UPLOAD_SIZE_BYTES)}.`);

              const session = await createUploadSession({
                name: String(data.get("name") || "My Voice"),
                filename: audioFile.name,
                content_type: audioFile.type || "application/octet-stream",
                size_bytes: audioFile.size,
                transcript_text: String(data.get("transcript_text") || ""),
                srt_offset_ms: Number(data.get("srt_offset_ms") || 0),
              });
              setRetryUploadId(session.upload_id);

              if (srtFile) {
                setStatusText(`Uploading transcript file ${srtFile.name}...`);
                await uploadSessionTranscript(session.upload_id, srtFile);
              }

              const receivedChunks = new Set(session.received_chunks);
              const chunkSize = session.chunk_size;
              let uploadedBytes = session.received_bytes;

              for (let chunkIndex = 0; chunkIndex < session.total_chunks; chunkIndex += 1) {
                const start = chunkIndex * chunkSize;
                const end = Math.min(start + chunkSize, audioFile.size);
                if (!receivedChunks.has(chunkIndex)) {
                  setStatusText(`Uploading chunk ${chunkIndex + 1}/${session.total_chunks}...`);
                  setUploadDetails(`${formatBytes(uploadedBytes)} / ${formatBytes(audioFile.size)} uploaded`);
                  await uploadChunkWithRetry(session.upload_id, chunkIndex, audioFile.slice(start, end));
                }
                uploadedBytes = Math.max(uploadedBytes, end);
                setUploadProgress(Math.round((uploadedBytes / audioFile.size) * 100));
              }

              setStatusText("Finalizing upload on server...");
              await completeUploadSession(session.upload_id);
              const completed = await pollProcessing(session.upload_id);
              setResult({
                upload_id: completed.upload_id,
                status: completed.status,
                voice_profile_id: completed.voice_profile_id,
                processing_elapsed_seconds: completed.processing_elapsed_seconds,
                processing_started_at: completed.processing_started_at,
                processing_completed_at: completed.processing_completed_at,
              });
              setStatusText("Enrollment complete.");
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Enrollment failed.");
              setStatusText("Upload or processing failed.");
            } finally {
              setLoading(false);
            }
          }}
        >
          <label>Profile name<input name="name" defaultValue="My Voice" placeholder="Profile name" /></label>
          <label>
            Audio sample
            <input
              name="audio_file"
              type="file"
              accept="audio/*"
              required
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                setAudioInfo(file ? { name: file.name, size: file.size, type: file.type || "unknown" } : null);
                setStatusText(file ? "File selected. Ready to start chunked upload." : null);
                setUploadDetails(file ? `${file.name} • ${formatBytes(file.size)} • ${file.type || "unknown type"}` : null);
              }}
            />
          </label>
          <label>Transcript text<textarea name="transcript_text" rows={6} placeholder="Optional: paste transcript text here." /></label>
          <label>SRT timing offset in milliseconds<input name="srt_offset_ms" type="number" defaultValue={0} placeholder="0" /></label>
          <label>
            Transcript SRT file (optional)
            <input
              name="transcript_file"
              type="file"
              accept=".srt,.txt,text/plain,application/x-subrip"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                setSrtInfo(file ? { name: file.name, size: file.size } : null);
              }}
            />
          </label>
          <button type="submit" disabled={loading}>{loading ? "Working..." : "Upload and create profile"}</button>
        </form>

        {audioInfo || loading || statusText ? (
          <div className="result-box">
            <strong>{statusText ?? "Ready"}</strong>
            {extensionWarning ? <pre>{extensionWarning}</pre> : null}
            {audioInfo ? <div className="muted">Selected audio: {audioInfo.name} • {formatBytes(audioInfo.size)} • {audioInfo.type}</div> : null}
            {srtInfo ? <div className="muted">Selected SRT: {srtInfo.name} • {formatBytes(srtInfo.size)}</div> : null}
            {uploadDetails ? <div className="muted">{uploadDetails}</div> : null}
            <div className="muted">Upload progress: {uploadProgress}%</div><progress value={uploadProgress} max={100} style={{ width: "100%", height: 18 }} />
            <div className="muted">Current chunk progress: {chunkProgress}%</div><progress value={chunkProgress} max={100} style={{ width: "100%", height: 12 }} />
            <div className="muted">Processing progress: {processingProgress}%</div><progress value={processingProgress} max={100} style={{ width: "100%", height: 12 }} />
            {result?.status === "completed" && result?.processing_elapsed_seconds != null ? (
              <div className="muted">Voice enrollment processing time: {formatDuration(result.processing_elapsed_seconds)}</div>
            ) : null}
          </div>
        ) : null}
        {error ? <div className="result-box"><pre>{error}</pre></div> : null}
        {result ? <div className="result-box"><pre>{JSON.stringify(result, null, 2)}</pre></div> : null}
      </SectionCard>

      <SectionCard title="Controls and guidance" kicker="Recovery">
        <div className="helper" style={{ marginBottom: 16 }}>
          <strong>Retry/cancel processing without re-uploading</strong>
          <p className="muted">Retry always starts from preserved original audio + SRT and rebuilds the curated clone dataset, prompt pack, and derived files. It does not reuse failed partial artifacts.</p>
          <label>Upload/session ID<input value={retryUploadId} onChange={(event) => setRetryUploadId(event.currentTarget.value)} placeholder="upload/session id" /></label>
          <div className="actions">
            <button type="button" disabled={loading} onClick={() => retryProcessing(retryUploadId)}>{loading ? "Working..." : "Retry processing"}</button>
            <button type="button" disabled={loading} onClick={() => cancelProcessing(retryUploadId)}>Cancel processing</button>
          </div>
        </div>
        <div className="feature-list">
          <div className="feature-item"><div className="feature-badge">1</div><div><strong>Use SRT when available.</strong><div className="muted">The backend trims silence inside subtitle windows and extracts clean segments for a clone dataset, not just one long conditioning file.</div></div></div>
          <div className="feature-item"><div className="feature-badge">2</div><div><strong>Adjust offset if needed.</strong><div className="muted">If subtitles are shifted, enter offset milliseconds before upload. Positive moves SRT later; negative moves it earlier.</div></div></div>
          <div className="feature-item"><div className="feature-badge">3</div><div><strong>Restart after code changes.</strong><div className="muted">Restart both API and web dev server after backend/frontend reliability changes.</div></div></div>
        </div>
      </SectionCard>
    </div>
  );
}
