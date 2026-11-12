import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import Composer from "./Composer.jsx";
import RunView from "./RunView.jsx";

export default function App() {
  const [runs, setRuns] = useState([]);
  const [health, setHealth] = useState(null);
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get("run"));

  const refreshRuns = useCallback(() => api.runs().then(setRuns).catch(() => {}), []);

  useEffect(() => {
    refreshRuns();
    api.health().then(setHealth).catch(() => setHealth({ ok: false }));
    const t = setInterval(refreshRuns, 5000);
    return () => clearInterval(t);
  }, [refreshRuns]);

  const select = (id) => {
    setSelected(id);
    history.replaceState(null, "", id ? `?run=${id}` : "/");
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onClick={() => select(null)}>
          <span className="logo">R<sup>x</sup></span>
          <div>
            <div className="brand-name">ResearchX</div>
            <div className="brand-sub">autonomous research</div>
          </div>
        </div>
        <button className="btn primary block" onClick={() => select(null)}>+ New research</button>
        <div className="side-label">History</div>
        <div className="run-list">
          {runs.length === 0 && <div className="muted small pad">No runs yet</div>}
          {runs.map((r) => (
            <button key={r.id} className={`run-item ${selected === r.id ? "active" : ""}`} onClick={() => select(r.id)}>
              <span className={`dot ${r.status}`} />
              <span className="run-q">{r.question}</span>
            </button>
          ))}
        </div>
        <HealthPanel health={health} />
      </aside>
      <main className="main">
        {selected ? (
          <RunView key={selected} runId={selected} onDeleted={() => { select(null); refreshRuns(); }} onChange={refreshRuns} />
        ) : (
          <Composer health={health} onCreated={(id) => { select(id); refreshRuns(); }} />
        )}
      </main>
    </div>
  );
}

function HealthPanel({ health }) {
  if (!health) return null;
  if (!health.ok) return <div className="health bad">Backend unreachable</div>;
  const roles = Object.entries(health.models);
  const none = roles.every(([, m]) => m.length === 0);
  return (
    <div className={`health ${none ? "bad" : ""}`}>
      {none ? (
        <div>No LLM keys configured. Add <code>GROQ_API_KEY</code> / <code>GEMINI_API_KEY</code> to <code>backend/.env</code>.</div>
      ) : (
        roles.map(([role, models]) => (
          <div key={role} className="health-row">
            <span>{role}</span>
            <span className="mono" title={models.join(" → ")}>{models[0]?.split(":").slice(1).join(":") || "—"}</span>
          </div>
        ))
      )}
      <div className="health-row"><span>search</span><span className="mono">{health.search}</span></div>
      <div className="health-row"><span>embed</span><span className="mono">{health.embeddings}</span></div>
    </div>
  );
}
