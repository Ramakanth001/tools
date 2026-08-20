import { useEffect, useState } from "react";
import {
  cancelSmokeTest,
  cancelSynthesis,
  getSmokeTestStatus,
  getSynthesisDownloadUrl,
  getSynthesisPreview,
  getSystemCapabilities,
  listVoiceProfiles,
  startSmokeTest,
  submitSynthesis,
} from "./api";
import { SectionCard } from "./SectionCard";

function formatDuration(seconds?: number | null): string {
  if (seconds == null || Number.isNaN(seconds)) return "not available";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function summarizeCloneIdentity(download: any) {
  const selections = Array.isArray(download?.candidate_selections) ? download.candidate_selections : [];
  const measured = selections.filter((item: any) => item?.similarity?.provider === "speechbrain_ecapa");
  const scores = measured
    .map((item: any) => Number(item?.similarity?.similarity_score))
    .filter((value: number) => Number.isFinite(value));
  return {
    verified: selections.length > 0 && selections.every((item: any) => item?.identity_verified === true),
    score: scores.length ? Math.min(...scores) : null,
    attempts: selections.reduce((total: number, item: any) => total + Number(item?.attempt_count || 0), 0),
    provider: measured.length ? "SpeechBrain ECAPA" : "unavailable",
  };
}

export default function SynthesisPage() {
  const [job, setJob] = useState<any>(null);
  const [download, setDownload] = useState<any>(null);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [capabilities, setCapabilities] = useState<any>(null);
  const [smokeTest, setSmokeTest] = useState<any>(null);
  const [smokeLoading, setSmokeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function waitForSynthesis(jobId: string) {
    for (;;) {
      const preview = (await getSynthesisPreview(jobId)) as any;
      setJob(preview);
      const status = String(preview.status || "").toLowerCase();
      if (status === "completed" || status === "completed_partial") {
        return preview;
      }
      if (status === "failed" || status === "cancelled") {
        const progress = preview.request?.progress;
        throw new Error(progress?.message || "Synthesis failed on the server.");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }
  }

  async function waitForSmokeTest(jobId: string) {
    for (;;) {
      const status = await getSmokeTestStatus(jobId);
      setSmokeTest(status);
      const state = String(status.status || "").toLowerCase();
      if (["completed", "failed", "cancelled"].includes(state)) return status;
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }
  }

  useEffect(() => {
    listVoiceProfiles().then((response) => setProfiles(response.items ?? [])).catch(() => setProfiles([]));
    getSystemCapabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  const cloneIdentity = summarizeCloneIdentity(download);

  return (
    <div className="grid two-col">
      <SectionCard title="Generate speech" kicker="Step 3">
        <div className="page-header">
          <h1>Turn text into output</h1>
          <p className="muted">Start with Preview mode for a verified voice test. The backend uses VoxCPM2 reference audio plus its transcript, generates up to three takes, and rejects fluent speech that does not match the enrolled speaker.</p>
        </div>
        <p className="muted">Final/master mode exports a mastered delivery file. Derived stereo/high-rate packaging is reported honestly, but no longer blocks normal personal renders.</p>
        <p className="muted">If VoxCPM2/Chatterbox dependencies are missing, generation fails clearly instead of silently returning another bad XTTS clone.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setJob(null);
            setDownload(null);
            setLoading(true);
            let activeJobId: string | null = null;
            try {
              const data = new FormData(event.currentTarget);
              const response = await submitSynthesis({
                voice_profile_id: String(data.get("voice_profile_id")),
                text: String(data.get("text")),
                mode: String(data.get("mode")),
                format: String(data.get("format")),
                sample_rate_hz: Number(data.get("sample_rate_hz")),
                channels: Number(data.get("channels")),
                locale: String(data.get("locale")),
                require_native_master: data.get("require_native_master") !== null,
              });
              activeJobId = response.job_id;
              setJob(response);
              await waitForSynthesis(response.job_id);
              const downloadResponse = await getSynthesisDownloadUrl(response.job_id);
              setDownload(downloadResponse);
            } catch (submitError) {
              if (activeJobId) {
                await cancelSynthesis(activeJobId).catch(() => null);
              }
              setError(submitError instanceof Error ? submitError.message : "Generation failed");
            } finally {
              setLoading(false);
            }
          }}
        >
          <label>
            Voice profile
            <select name="voice_profile_id" required defaultValue="">
              <option value="" disabled>Select your voice profile</option>
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>{item.name} ({item.id.slice(0, 8)})</option>
              ))}
            </select>
          </label>
          <label>
            Text to generate
            <textarea name="text" defaultValue="Hello from my personal voice model." rows={6} />
          </label>
          <label>
            Render mode
            <select name="mode" defaultValue="preview">
              <option value="preview">Preview</option>
              <option value="final">Final master candidate</option>
            </select>
          </label>
          <label>
            Output format
            <select name="format" defaultValue="wav">
              <option value="wav">WAV</option>
              <option value="flac">FLAC</option>
            </select>
          </label>
          <label>
            Sample rate
            <select name="sample_rate_hz" defaultValue="24000">
              <option value="24000">24,000 Hz</option>
              <option value="44100">44,100 Hz</option>
              <option value="48000">48,000 Hz</option>
            </select>
          </label>
          <label>
            Channels
            <select name="channels" defaultValue="1">
              <option value="1">Mono</option>
              <option value="2">Stereo</option>
            </select>
          </label>
          <label>
            Locale
            <input name="locale" defaultValue="en-IN" />
          </label>
          <label>
            <input name="require_native_master" type="checkbox" />
            Strict native master only (advanced; may warn if the local clone engine is mono/derived)
          </label>
          <button type="submit" disabled={loading}>{loading ? "Generating..." : "Generate"}</button>
        </form>
        <div className="helper" style={{ marginTop: 16 }}>
          <strong>Delivery note</strong>
          <div className="muted">Recommended first test: Preview, WAV, mono, strict native master unchecked. Use final/master only after the voice actually sounds like you.</div>
          <div className="muted">If a job becomes stale or hangs, use Cancel and retry after restarting the API. Native model crashes now get detected more cleanly.</div>
        </div>
        <div className="helper" style={{ marginTop: 16 }}>
          <strong>Voice diagnostics</strong>
          <div className="muted">Optional: compare prompt candidates before a long render. Normal synthesis now performs its own mandatory ASR and speaker-identity verification.</div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              disabled={smokeLoading || loading}
              onClick={async () => {
                const select = document.querySelector<HTMLSelectElement>('select[name="voice_profile_id"]');
                const voiceProfileId = select?.value || "";
                if (!voiceProfileId) {
                  setError("Select a voice profile before running smoke/mock diagnostics.");
                  return;
                }
                setSmokeLoading(true);
                setSmokeTest(null);
                setError(null);
                try {
                  const created = await startSmokeTest({ voice_profile_id: voiceProfileId, mode: "preview", engine_name: "voxcpm2", candidate_limit: 3 });
                  setSmokeTest(created);
                  await waitForSmokeTest(created.job_id);
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : "Smoke/mock test failed.");
                } finally {
                  setSmokeLoading(false);
                }
              }}
            >
              {smokeLoading ? "Running smoke/mock test..." : "Run smoke/mock test"}
            </button>
            {smokeTest?.job_id && ["queued", "running", "cancel_requested"].includes(String(smokeTest.status || "").toLowerCase()) ? (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const cancelled = await cancelSmokeTest(smokeTest.job_id);
                    setSmokeTest(cancelled);
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : "Failed to cancel smoke/mock test.");
                  }
                }}
              >
                Cancel smoke/mock test
              </button>
            ) : null}
          </div>
        </div>
        {capabilities ? (
          <div className="result-box" style={{ marginTop: 16 }}>
            <strong>System capabilities</strong>
            <pre>{JSON.stringify(capabilities, null, 2)}</pre>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Generation output" kicker="Result">
        <div className="stack">
          <div className="helper">
            <strong>Clone pipeline</strong>
            <div className="muted">Primary: VoxCPM2 ultimate cloning from curated prompt audio + exact prompt text. Secondary: Chatterbox prompt cloning. XTTS is legacy only and disabled as silent fallback by default.</div>
            <div className="muted">On Mac, VoxCPM2 auto mode uses CUDA if present, otherwise CPU. MPS is opt-in only because this model can crash during MPSGraph warm-up.</div>
            {capabilities?.summary?.clone_pipeline ? <div className="muted">Runtime: {String(capabilities.summary.clone_pipeline)}</div> : null}
          </div>
          {error ? <div className="result-box"><pre>{error}</pre></div> : null}
          {smokeTest ? (
            <div className="result-box">
              <strong>{String(smokeTest.progress?.message || smokeTest.message || "Smoke/mock test")}</strong>
              <div className="muted">Status: {String(smokeTest.status || "unknown")}</div>
              {smokeTest.progress ? (
                <>
                  <div className="muted">Stage: {String(smokeTest.progress.stage || "unknown")}</div>
                  <div className="muted">Progress: {Number(smokeTest.progress.percent || 0)}%</div>
                  <progress value={Number(smokeTest.progress.percent || 0)} max={100} style={{ width: "100%", height: 14 }} />
                  {smokeTest.progress.total_candidates ? (
                    <div className="muted">Candidate: {String(smokeTest.progress.current_candidate || 0)}/{String(smokeTest.progress.total_candidates)}</div>
                  ) : null}
                </>
              ) : null}
              {smokeTest.results?.length ? (
                <div className="stack" style={{ marginTop: 12 }}>
                  {smokeTest.results.map((item: any, index: number) => (
                    <div className="helper" key={`${item.label || "candidate"}-${index}`}>
                      <strong>{item.passed ? "✓" : "✕"} {String(item.label || `Candidate ${index + 1}`)}</strong>
                      <div className="muted">Engine: {String(item.engine_name || "unknown")} • Mode: {String(item.clone_mode || "unknown")}</div>
                      {item.similarity?.similarity_score != null ? (
                        <div className="muted">Speaker match: {(Number(item.similarity.similarity_score) * 100).toFixed(1)}% ({String(item.similarity.provider || "unknown")})</div>
                      ) : null}
                      {item.error ? <div className="muted">Error: {String(item.error)}</div> : null}
                      {item.audio_url ? <audio controls src={String(item.audio_url)} style={{ width: "100%", marginTop: 8 }} /> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {job?.request?.progress ? (
            <div className="result-box">
              <strong>{job.request.progress.message}</strong>
              {job.request.text_preparation?.warnings?.length ? (
                <div className="helper" style={{ marginTop: 8 }}>
                  <strong>Text prepared for stable speech</strong>
                  <ul>
                    {job.request.text_preparation.warnings.map((warning: string, index: number) => (
                      <li key={`${warning}-${index}`}>{warning}</li>
                    ))}
                  </ul>
                  {job.request.synthesis_text ? <div className="muted">Synthesis-safe text: {String(job.request.synthesis_text)}</div> : null}
                </div>
              ) : null}
              {String(job.status || "").toLowerCase() === "completed_partial" ? (
                <div className="helper" style={{ marginTop: 8 }}>
                  Partial output is available. Some chunks timed out or failed; submit the same request again to resume missing chunks if the backend kept the chunk directory.
                </div>
              ) : null}
              <div className="muted">Stage: {job.request.progress.stage}</div>
              <div className="muted">Progress: {job.request.progress.percent}%</div>
              {job.synthesis_elapsed_seconds != null ? (
                <div className="muted">Synthesis time: {formatDuration(job.synthesis_elapsed_seconds)}</div>
              ) : null}
              <progress value={job.request.progress.percent} max={100} style={{ width: "100%", height: 14 }} />
              {job.request.progress.total_chunks ? (
                <div className="muted">Chunk: {job.request.progress.current_chunk}/{job.request.progress.total_chunks}</div>
              ) : null}
              {String(job.status || "").toLowerCase() === "running" || String(job.status || "").toLowerCase() === "cancel_requested" ? (
                <button
                  type="button"
                  style={{ marginTop: 12 }}
                  onClick={async () => {
                    try {
                      await cancelSynthesis(job.job_id);
                    } catch (cancelError) {
                      setError(cancelError instanceof Error ? cancelError.message : "Failed to cancel synthesis job.");
                    }
                  }}
                >
                  Cancel synthesis
                </button>
              ) : null}
            </div>
          ) : null}
          {download ? (
            <div className="result-box">
              <strong>{cloneIdentity.verified ? "Verified voice clone ready" : download.partial_output ? "Partial audio ready" : "Audio ready"}</strong>
              <div className="muted">{download.asset.format.toUpperCase()} • {download.asset.sample_rate_hz} Hz • {download.asset.channels} channel(s) • {(download.asset.duration_ms / 1000).toFixed(2)}s</div>
              {cloneIdentity.score != null ? (
                <div className="helper" style={{ marginTop: 8 }}>
                  <strong>Speaker identity verified: {(cloneIdentity.score * 100).toFixed(1)}%</strong>
                  <div className="muted">Measured with {cloneIdentity.provider} across every generated chunk. {cloneIdentity.attempts} take(s) evaluated.</div>
                </div>
              ) : (
                <div className="helper error-box" style={{ marginTop: 8 }}>No measured speaker-identity result is attached. Treat this as historical/unverified audio, not a confirmed clone.</div>
              )}
              {download.synthesis_elapsed_seconds != null ? (
                <div className="muted">Synthesis processing time: {formatDuration(download.synthesis_elapsed_seconds)}</div>
              ) : null}
              {download.partial_output ? (
                <div className="helper" style={{ marginTop: 8 }}>
                  This is stitched from completed chunks. Failed chunks: {(download.failed_chunks || []).length}. Progress manifest: {download.progress_manifest_path || "not reported"}.
                </div>
              ) : null}
              <audio controls src={download.url} style={{ width: "100%", marginTop: 12 }} />
              <div className="actions" style={{ marginTop: 12 }}>
                <a className="link-arrow" href={download.url} download>Download audio</a>
                <a className="link-arrow" href={download.url} target="_blank" rel="noreferrer">Open audio</a>
              </div>
            </div>
          ) : null}
          {job ? (
            <details className="result-box">
              <summary>Job details</summary>
              <pre>{JSON.stringify(job, null, 2)}</pre>
            </details>
          ) : null}
          {download ? (
            <details className="result-box">
              <summary>Download and delivery details</summary>
              <pre>{JSON.stringify(download, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}
