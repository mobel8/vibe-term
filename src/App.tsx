import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AppInfo {
  name: string;
  version: string;
  targetOs: string;
  targetArch: string;
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ping, setPing] = useState<string>("…");

  useEffect(() => {
    invoke<AppInfo>("app_info")
      .then(setInfo)
      .catch((err) => console.error("app_info failed", err));
    invoke<string>("ping")
      .then(setPing)
      .catch((err) => console.error("ping failed", err));
  }, []);

  return (
    <main className="flex h-full w-full flex-col items-center justify-center gap-6 bg-bg text-zinc-100">
      <header className="flex flex-col items-center gap-2">
        <h1 className="font-mono text-3xl font-semibold tracking-tight text-accent">
          vibe-term
        </h1>
        <p className="text-sm text-zinc-400">
          A modern cross-platform terminal — bootstrap phase
        </p>
      </header>

      <section className="rounded-xl border border-border bg-bg-subtle px-6 py-4 font-mono text-xs leading-6 text-zinc-300">
        {info ? (
          <>
            <div>
              <span className="text-zinc-500">name:</span> {info.name}
            </div>
            <div>
              <span className="text-zinc-500">version:</span> {info.version}
            </div>
            <div>
              <span className="text-zinc-500">target:</span> {info.targetOs}/{info.targetArch}
            </div>
            <div>
              <span className="text-zinc-500">ipc:</span> ping → {ping}
            </div>
          </>
        ) : (
          <div className="text-zinc-500">loading runtime info…</div>
        )}
      </section>

      <footer className="text-xs text-zinc-600">
        Terminal core, image pipeline and AI panel are wired up in later phases.
      </footer>
    </main>
  );
}
