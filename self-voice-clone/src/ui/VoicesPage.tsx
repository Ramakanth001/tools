import { useEffect, useState } from "react";
import { listVoiceProfiles } from "./api";
import { SectionCard } from "./SectionCard";
import { AdaptationPanel } from "./AdaptationPanel";

export default function VoicesPage() {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listVoiceProfiles()
      .then((response) => { if (!cancelled) setProfiles(response.items || []); })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load profiles"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="grid">
      <SectionCard title="Saved voice profiles" kicker="Step 2">
        <div className="page-header">
          <h1>Your saved voices</h1>
          <p className="muted">Every uploaded profile appears here before you generate text from it.</p>
        </div>
        <p className="muted">Confirm your saved profile exists here, then move to the Generate page.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>ID</th>
                <th>Status</th>
                <th>Engine</th>
                <th>Clone dataset</th>
                <th>Prompt</th>
                <th>True adoption</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((item: any) => {
                const cloneDataset = item.readiness_report?.clone_dataset ?? {};
                const prompt = cloneDataset.prompt ?? {};
                const adaptedModels = item.readiness_report?.adapted_models ?? {};
                const adaptedCount = Object.keys(adaptedModels).length;
                return (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td><code>{item.id}</code></td>
                    <td><span className="pill">{item.status}</span></td>
                    <td>{item.engine_family}</td>
                    <td>{cloneDataset.status ?? "not built"} {cloneDataset.curated_minutes ? `• ${cloneDataset.curated_minutes} min` : ""}</td>
                    <td>{prompt.status ?? "missing"} {prompt.prompt_seconds ? `• ${prompt.prompt_seconds}s` : ""}</td>
                    <td>
                      <div className="stack">
                        <span className="pill">{adaptedCount ? `${adaptedCount} checkpoint(s)` : "not trained"}</span>
                        <AdaptationPanel voiceProfileId={item.id} />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!profiles.length ? (
                <tr>
                  <td colSpan={7} className="muted">{loading ? "Loading profiles…" : "No profiles yet. Create one on the enrollment page first."}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {error ? <div className="helper error-box">{error}</div> : null}

      <SectionCard title="What this page tells you" kicker="Quick note">
        <div className="helper">
          <strong>If the profile is visible, your upload step worked.</strong>
          <div className="muted">Dataset/prompt readiness means the profile can be tested; it does not certify the output. Generation now certifies each take with measured ASR and 16 kHz speaker embeddings before it is downloadable.</div>
        </div>
        <div className="helper">
          <strong>For true voice adoption:</strong>
          <div className="muted">Use Export adaptation set → Prepare F5-TTS → train on free Kaggle/Colab GPU → import the checkpoint → benchmark against VoxCPM2.</div>
        </div>
      </SectionCard>
    </div>
  );
}
