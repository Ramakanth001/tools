import React, { useEffect, useMemo, useState } from "react";
import { configureVoiceCloneRuntime, getVoiceCloneHealth } from "./api";
import { VoiceCloneNavigationContext } from "./navigation";
import { Nav } from "./Nav";
import StartPage from "./StartPage";
import EnrollmentPage from "./EnrollmentPage";
import VoicesPage from "./VoicesPage";
import SynthesisPage from "./SynthesisPage";
import "./selfVoiceClone.css";

type Runtime = {
  toolId?: string;
  apiBasePath?: string;
  healthPath?: string;
  homePath?: string;
  storagePrefix?: string;
};

const DEFAULT_RUNTIME: Runtime = {
  toolId: "self-voice-clone",
  apiBasePath: "/api/tools/self-voice-clone/v1",
  healthPath: "/api/tools/self-voice-clone/health",
  homePath: "/tools/self-voice-clone",
  storagePrefix: "tools.self-voice-clone",
};

export default function SelfVoiceCloneTool({ runtime: runtimeProp }: { runtime?: Runtime }) {
  const runtime = useMemo(() => ({ ...DEFAULT_RUNTIME, ...(runtimeProp || {}) }), [runtimeProp]);
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [health, setHealth] = useState<"checking" | "ready" | "unavailable">("checking");
  configureVoiceCloneRuntime(runtime);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getVoiceCloneHealth()
      .then(() => { if (!cancelled) setHealth("ready"); })
      .catch(() => { if (!cancelled) setHealth("unavailable"); });
    return () => { cancelled = true; };
  }, [runtime]);

  const navigate = (to: string) => {
    if (window.location.pathname !== to) window.history.pushState({}, "", to);
    setPathname(to);
  };
  const homePath = String(runtime.homePath || DEFAULT_RUNTIME.homePath).replace(/\/+$/, "");
  const section = pathname.slice(homePath.length).replace(/^\/+|\/+$/g, "").split("/")[0];
  const Page = section === "enrollment"
    ? EnrollmentPage
    : section === "voices"
      ? VoicesPage
      : section === "synthesis"
        ? SynthesisPage
        : StartPage;

  return (
    <VoiceCloneNavigationContext.Provider value={{ homePath, navigate }}>
      <div className="self-voice-clone-tool">
        <Nav health={health} />
        {health === "unavailable" ? (
          <div className="vclone-runtime-alert" role="alert">
            Voice API unavailable. Run <code>npm run setup:self-voice-clone</code>, then restart the workspace.
          </div>
        ) : null}
        <main className="self-voice-clone-main">
          <Page />
        </main>
      </div>
    </VoiceCloneNavigationContext.Provider>
  );
}
