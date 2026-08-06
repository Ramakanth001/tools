import { useState } from "react";
import {
  exportAdaptationDataset,
  getAdaptationBenchmarks,
  getAdaptationStatus,
  importAdaptedCheckpoint,
  prepareF5TTSAdaptationDataset,
} from "./api";

type Props = {
  voiceProfileId: string;
};

export function AdaptationPanel({ voiceProfileId }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkpointPath, setCheckpointPath] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [datasetManifestPath, setDatasetManifestPath] = useState("");

  async function run(label: string, action: () => Promise<Record<string, unknown>>) {
    setBusy(label);
    setError(null);
    try {
      setResult(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack compact-actions">
      <div className="actions">
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => run("export", () => exportAdaptationDataset(voiceProfileId) as Promise<Record<string, unknown>>)}
        >
          Export adaptation set
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => run("prepare", () => prepareF5TTSAdaptationDataset(voiceProfileId) as Promise<Record<string, unknown>>)}
        >
          Prepare F5-TTS
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => run("status", () => getAdaptationStatus(voiceProfileId) as Promise<Record<string, unknown>>)}
        >
          Status
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => run("benchmarks", () => getAdaptationBenchmarks() as Promise<Record<string, unknown>>)}
        >
          Benchmarks
        </button>
      </div>
      <details className="helper">
        <summary><strong>Import trained F5-TTS checkpoint</strong></summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <label>
            Checkpoint path
            <input value={checkpointPath} onChange={(event) => setCheckpointPath(event.target.value)} placeholder="/path/to/model.safetensors" />
          </label>
          <label>
            Config path optional
            <input value={configPath} onChange={(event) => setConfigPath(event.target.value)} placeholder="/path/to/config.json" />
          </label>
          <label>
            Dataset manifest optional
            <input value={datasetManifestPath} onChange={(event) => setDatasetManifestPath(event.target.value)} placeholder="vclone/training-runs/.../dataset/manifest.json" />
          </label>
          <button
            type="button"
            disabled={Boolean(busy) || !checkpointPath.trim()}
            onClick={() =>
              run("import", () =>
                importAdaptedCheckpoint(voiceProfileId, {
                  checkpoint_path: checkpointPath.trim(),
                  config_path: configPath.trim() || null,
                  dataset_manifest_path: datasetManifestPath.trim() || null,
                  notes: "Imported from voices page true-adoption panel.",
                }) as Promise<Record<string, unknown>>
              )
            }
          >
            Register checkpoint
          </button>
        </div>
      </details>
      {busy ? <div className="muted">Running {busy}…</div> : null}
      {error ? <div className="helper error-box">{error}</div> : null}
      {result ? (
        <details className="result-box" open>
          <summary>Adaptation result</summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
