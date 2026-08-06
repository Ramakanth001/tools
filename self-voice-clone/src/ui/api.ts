let API_BASE = "/api/tools/self-voice-clone/v1";
let HEALTH_PATH = "/api/tools/self-voice-clone/health";

export function configureVoiceCloneRuntime(runtime?: { apiBasePath?: string; healthPath?: string }) {
  API_BASE = String(runtime?.apiBasePath || API_BASE).replace(/\/+$/, "");
  HEALTH_PATH = String(runtime?.healthPath || HEALTH_PATH);
}

function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  const fromUrl = new URLSearchParams(window.location.search).get("token") || "";
  if (fromUrl) window.localStorage.setItem("tools.authToken", fromUrl);
  return fromUrl || window.localStorage.getItem("tools.authToken") || "";
}

function withAuthQuery(url: string): string {
  if (typeof window === "undefined") return url;
  const token = getAuthToken();
  if (!token) return url;
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

function assetUrl(path: string | null | undefined): string | null | undefined {
  if (!path) return path;
  if (/^https?:\/\//i.test(path) && !path.includes("localhost:8000") && !path.includes("storage.local")) {
    return withAuthQuery(path);
  }
  const suffix = path.startsWith("/v1/") ? path.slice(3) : path;
  return withAuthQuery(`${API_BASE}/${suffix.replace(/^\/+/, "")}`);
}

type ApiError = { detail?: string; message?: string };

export type VoiceProfileSummary = {
  id: string;
  name: string;
  enrollment_id: string;
  status: string;
  engine_family: string;
  base_model_version: string;
  readiness_report: Record<string, unknown>;
};

export type VoiceProfileListResponse = {
  items: VoiceProfileSummary[];
};

export type SimpleVoiceProfileResponse = {
  voice_profile_id: string;
  status: string;
  name: string;
  readiness_report?: Record<string, unknown> | null;
};

export type UploadSessionResponse = {
  upload_id: string;
  filename: string;
  size_bytes: number;
  chunk_size: number;
  total_chunks: number;
  received_chunks: number[];
  received_bytes: number;
  status: string;
  stage?: string | null;
  srt_offset_ms: number;
  processing_percent: number;
  processing_message?: string | null;
  processing_attempt: number;
  accepted_segments: number;
  rejected_segments: number;
  current_segment_index: number;
  total_segments: number;
  created_at?: string | null;
  upload_completed_at?: string | null;
  processing_started_at?: string | null;
  processing_completed_at?: string | null;
  processing_elapsed_seconds?: number | null;
  last_updated_at?: string | null;
  error?: string | null;
  voice_profile_id?: string | null;
};

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
};

export type SynthesisJobResponse = {
  job_id: string;
  status: string;
  message?: string | null;
};

export type SmokeTestJobResponse = {
  job_id: string;
  status: string;
  message?: string | null;
};

export type SmokeTestStatusResponse = {
  job_id: string;
  status: string;
  progress: Record<string, unknown>;
  results: Record<string, unknown>[];
  error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type SynthesizedAssetInfo = {
  format: string;
  sample_rate_hz: number;
  channels: number;
  duration_ms: number;
  local_path: string;
  checksum_sha256: string;
};

export type SynthesisDownloadResponse = {
  url: string;
  expires_in_seconds: number;
  asset: SynthesizedAssetInfo;
  delivery_report: Record<string, unknown>;
  evaluation: Record<string, unknown>;
  asr_backcheck: Record<string, unknown>;
  clone_profile: Record<string, unknown>;
  candidate_plan: Record<string, unknown>[];
  qualified_candidates: Record<string, unknown>[];
  smoke_test_failures: Record<string, unknown>[];
  candidate_selections: Record<string, unknown>[];
  failed_chunks: Record<string, unknown>[];
  partial_output: boolean;
  progress_manifest_path?: string | null;
  synthesis_started_at?: string | null;
  synthesis_completed_at?: string | null;
  synthesis_elapsed_seconds?: number | null;
  engine_selection: Record<string, unknown>;
  engine_registry: Record<string, unknown>;
};

export type SystemCapabilitiesResponse = {
  status: string;
  engines: Record<string, unknown>;
  summary: Record<string, unknown>;
};

export type AdaptationExportResponse = {
  status: string;
  manifest: Record<string, unknown>;
};

export type AdaptationPrepareF5Response = {
  status: string;
  result: Record<string, unknown>;
};

export type AdaptationStatusResponse = {
  voice_profile_id: string;
  status: string;
  adapted_models: Record<string, unknown>;
  true_voice_adoption: Record<string, unknown>;
  recommended_next_steps: string[];
};

export type AdaptedCheckpointImportResponse = {
  status: string;
  voice_profile_id: string;
  model: Record<string, unknown>;
  readiness_report: Record<string, unknown>;
};

export type AdaptationBenchmarksResponse = {
  status: string;
  path?: string;
  purpose?: string;
  items: Record<string, unknown>[];
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail: string | null = null;
    try {
      const error = (await response.json()) as ApiError | null;
      detail = error?.detail ?? error?.message ?? null;
    } catch {
      detail = (await response.text().catch(() => "")).trim() || null;
    }
    throw new Error(detail ?? `${response.status} ${response.statusText || "Request failed"}`);
  }
  return response.json() as Promise<T>;
}

async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const headers = new Headers(init?.headers || {});
    const token = getAuthToken();
    if (token) headers.set("x-tools-auth", token);
    return await fetch(input, { ...init, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed";
    throw new Error(
      `${message}. Could not reach the API at ${API_BASE}. Make sure the FastAPI server is running and CORS is enabled for the web app origin.`
    );
  }
}

export async function createSimpleVoiceProfile(payload: {
  name: string;
  transcript_text: string;
  audio_file: File;
  transcript_file?: File | null;
  onUploadProgress?: (progress: UploadProgress) => void;
}): Promise<SimpleVoiceProfileResponse> {
  if (!(payload.audio_file instanceof File) || payload.audio_file.size === 0) {
    throw new Error("Please choose a valid audio file before submitting.");
  }

  const formData = new FormData();
  formData.append("name", payload.name);
  formData.append("transcript_text", payload.transcript_text);
  formData.append("audio_file", payload.audio_file);
  if (payload.transcript_file) {
    formData.append("transcript_file", payload.transcript_file);
  }

  return new Promise<SimpleVoiceProfileResponse>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${API_BASE}/voice-profiles`);
    request.responseType = "json";
    const token = getAuthToken();
    if (token) request.setRequestHeader("x-tools-auth", token);

    request.upload.onprogress = (event) => {
      if (!payload.onUploadProgress || !event.lengthComputable) {
        return;
      }
      payload.onUploadProgress({
        loaded: event.loaded,
        total: event.total,
        percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
      });
    };

    request.onerror = () => {
      reject(new Error("Network error while uploading audio. Please check whether the API is reachable and try again."));
    };

    request.onload = () => {
      const status = request.status;
      const responseData = request.response ?? null;

      if (status >= 200 && status < 300) {
        payload.onUploadProgress?.({ loaded: 1, total: 1, percent: 100 });
        resolve(responseData as SimpleVoiceProfileResponse);
        return;
      }

      const error = responseData as ApiError | null;
      reject(new Error(error?.detail ?? error?.message ?? `${status} ${request.statusText || "Request failed"}`));
    };

    request.send(formData);
  });
}

export async function createUploadSession(payload: {
  name: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  transcript_text: string;
  srt_offset_ms: number;
}): Promise<UploadSessionResponse> {
  const response = await apiFetch(`${API_BASE}/uploads/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJson<UploadSessionResponse>(response);
}

export async function getUploadSession(uploadId: string): Promise<UploadSessionResponse> {
  const response = await apiFetch(`${API_BASE}/uploads/sessions/${uploadId}`, { cache: "no-store" });
  return readJson<UploadSessionResponse>(response);
}

export async function uploadSessionChunk(
  uploadId: string,
  chunkIndex: number,
  chunk: Blob,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadSessionResponse> {
  return new Promise<UploadSessionResponse>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", `${API_BASE}/uploads/sessions/${uploadId}/chunks/${chunkIndex}`);
    request.responseType = "json";
    request.setRequestHeader("Content-Type", "application/octet-stream");
    const token = getAuthToken();
    if (token) request.setRequestHeader("x-tools-auth", token);

    request.upload.onprogress = (event) => {
      if (!onProgress || !event.lengthComputable) return;
      onProgress({
        loaded: event.loaded,
        total: event.total,
        percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
      });
    };

    request.onerror = () => reject(new Error(`Network error while uploading chunk ${chunkIndex + 1}.`));
    request.ontimeout = () => reject(new Error(`Timed out while uploading chunk ${chunkIndex + 1}.`));
    request.onload = () => {
      const responseData = request.response ?? null;
      if (request.status >= 200 && request.status < 300) {
        onProgress?.({ loaded: chunk.size, total: chunk.size, percent: 100 });
        resolve(responseData as UploadSessionResponse);
        return;
      }

      const error = responseData as ApiError | null;
      reject(new Error(error?.detail ?? error?.message ?? `${request.status} ${request.statusText || "Chunk upload failed"}`));
    };

    request.send(chunk);
  });
}

export async function uploadSessionTranscript(uploadId: string, file: File): Promise<UploadSessionResponse> {
  const response = await apiFetch(`${API_BASE}/uploads/sessions/${uploadId}/transcript/${encodeURIComponent(file.name)}`, {
    method: "PUT",
    headers: { "Content-Type": file.type || "text/plain" },
    body: file,
  });
  return readJson<UploadSessionResponse>(response);
}

export async function completeUploadSession(uploadId: string): Promise<{ upload_id: string; status: string; message: string }> {
  const response = await apiFetch(`${API_BASE}/uploads/sessions/${uploadId}/complete`, { method: "POST" });
  return readJson(response);
}

export async function retryUploadProcessing(uploadId: string): Promise<{ upload_id: string; status: string; message: string }> {
  const response = await apiFetch(`${API_BASE}/uploads/sessions/${uploadId}/retry-processing`, { method: "POST" });
  return readJson(response);
}

export async function cancelUploadProcessing(uploadId: string): Promise<{ upload_id: string; status: string; message: string }> {
  const response = await apiFetch(`${API_BASE}/uploads/sessions/${uploadId}/cancel`, { method: "POST" });
  return readJson(response);
}

export type EnrollmentPayload = {
  locale: string;
  consent_text_version: string;
  intended_use: string;
};

export async function createEnrollment(payload: EnrollmentPayload) {
  const response = await apiFetch(`${API_BASE}/enrollments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

export async function presignAudio(enrollmentId: string, payload: { filename: string; content_type: string; size_bytes: number }) {
  const response = await apiFetch(`${API_BASE}/enrollments/${enrollmentId}/audio:presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

export async function validateEnrollment(enrollmentId: string, payload: { audio_asset_ids: string[]; transcript_asset_ids: string[] }) {
  const response = await apiFetch(`${API_BASE}/enrollments/${enrollmentId}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

export async function createVoiceProfile(enrollmentId: string, payload: { mode: string; engine_preference: string; allow_adaptation: boolean }) {
  const response = await apiFetch(`${API_BASE}/voice-profiles/create/from-enrollment/${enrollmentId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

export async function listVoiceProfiles(): Promise<VoiceProfileListResponse> {
  const response = await apiFetch(`${API_BASE}/voice-profiles`, { cache: "no-store" });
  return readJson<VoiceProfileListResponse>(response);
}

export async function submitSynthesis(payload: {
  voice_profile_id: string;
  text: string;
  mode: string;
  format: string;
  sample_rate_hz: number;
  channels: number;
  locale: string;
  require_native_master?: boolean;
}): Promise<SynthesisJobResponse> {
  const response = await apiFetch(`${API_BASE}/synthesis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJson<SynthesisJobResponse>(response);
}

export async function getSynthesisPreview(jobId: string) {
  const response = await apiFetch(`${API_BASE}/synthesis/${jobId}/preview`, { cache: "no-store" });
  return readJson(response);
}

export async function cancelSynthesis(jobId: string): Promise<SynthesisJobResponse> {
  const response = await apiFetch(`${API_BASE}/synthesis/${jobId}/cancel`, {
    method: "POST",
  });
  return readJson<SynthesisJobResponse>(response);
}

export async function getSynthesisDownloadUrl(jobId: string): Promise<SynthesisDownloadResponse> {
  const response = await apiFetch(`${API_BASE}/synthesis/${jobId}/download-url`, {
    method: "POST",
  });
  const payload = await readJson<SynthesisDownloadResponse>(response);
  payload.url = assetUrl(`/v1/synthesis/${jobId}/file`) as string;
  return payload;
}

export async function startSmokeTest(payload: {
  voice_profile_id: string;
  mode?: string;
  engine_name?: string;
  candidate_limit?: number;
}): Promise<SmokeTestJobResponse> {
  const response = await apiFetch(`${API_BASE}/synthesis/smoke-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJson<SmokeTestJobResponse>(response);
}

export async function getSmokeTestStatus(jobId: string): Promise<SmokeTestStatusResponse> {
  const response = await apiFetch(`${API_BASE}/synthesis/smoke-test/${jobId}`, { cache: "no-store" });
  const payload = await readJson<SmokeTestStatusResponse>(response);
  payload.results = (payload.results || []).map((item) => {
    const audioUrl = typeof item.audio_url === "string" ? item.audio_url : null;
    return {
      ...item,
      audio_url: assetUrl(audioUrl),
    };
  });
  return payload;
}

export async function cancelSmokeTest(jobId: string): Promise<SmokeTestStatusResponse> {
  const response = await apiFetch(`${API_BASE}/synthesis/smoke-test/${jobId}/cancel`, { method: "POST" });
  return readJson<SmokeTestStatusResponse>(response);
}

export async function getSystemCapabilities(): Promise<SystemCapabilitiesResponse> {
  const response = await apiFetch(`${API_BASE}/system/capabilities`, { cache: "no-store" });
  return readJson<SystemCapabilitiesResponse>(response);
}

export async function getVoiceCloneHealth(): Promise<Record<string, unknown>> {
  const response = await apiFetch(HEALTH_PATH, { cache: "no-store" });
  return readJson<Record<string, unknown>>(response);
}

export async function exportAdaptationDataset(
  voiceProfileId: string,
  payload?: { output_dir?: string | null; min_seconds?: number; max_seconds?: number; speaker_id?: string | null }
): Promise<AdaptationExportResponse> {
  const response = await apiFetch(`${API_BASE}/voice-profiles/${voiceProfileId}/adaptation/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return readJson<AdaptationExportResponse>(response);
}

export async function prepareF5TTSAdaptationDataset(
  voiceProfileId: string,
  payload?: { dataset_dir?: string | null; output_dir?: string | null }
): Promise<AdaptationPrepareF5Response> {
  const response = await apiFetch(`${API_BASE}/voice-profiles/${voiceProfileId}/adaptation/prepare-f5tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return readJson<AdaptationPrepareF5Response>(response);
}

export async function getAdaptationStatus(voiceProfileId: string): Promise<AdaptationStatusResponse> {
  const response = await apiFetch(`${API_BASE}/voice-profiles/${voiceProfileId}/adaptation/status`, { cache: "no-store" });
  return readJson<AdaptationStatusResponse>(response);
}

export async function importAdaptedCheckpoint(
  voiceProfileId: string,
  payload: { engine?: string; checkpoint_path: string; config_path?: string | null; dataset_manifest_path?: string | null; notes?: string }
): Promise<AdaptedCheckpointImportResponse> {
  const response = await apiFetch(`${API_BASE}/voice-profiles/${voiceProfileId}/adaptation/import-checkpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine: "f5_finetuned", ...payload }),
  });
  return readJson<AdaptedCheckpointImportResponse>(response);
}

export async function getAdaptationBenchmarks(): Promise<AdaptationBenchmarksResponse> {
  const response = await apiFetch(`${API_BASE}/system/adaptation/benchmarks`, { cache: "no-store" });
  return readJson<AdaptationBenchmarksResponse>(response);
}
