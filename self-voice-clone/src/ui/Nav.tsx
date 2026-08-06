import { VoiceCloneLink as Link } from "./navigation";

export function Nav({ health }: { health: "checking" | "ready" | "unavailable" }) {
  return (
    <nav className="nav">
      <Link href="/" className="nav-brand">VClone</Link>
      <div className="nav-links">
        <Link href="/">Start Here</Link>
        <Link href="/enrollment">1. Save Voice</Link>
        <Link href="/voices">2. Saved Profiles</Link>
        <Link href="/synthesis">3. Generate</Link>
        <span className={`vclone-health ${health}`}>{health === "ready" ? "API ready" : health === "unavailable" ? "API offline" : "Checking API"}</span>
      </div>
    </nav>
  );
}
