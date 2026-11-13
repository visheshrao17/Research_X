import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api.js";

const STEPS = [
  { id: "plan", label: "Plan" },
  { id: "research", label: "Research" },
  { id: "analyze", label: "Analyze" },
  { id: "write", label: "Write" },
  { id: "critique", label: "Critique" },
  { id: "revise", label: "Revise", alias: ["gap_research"] },
  { id: "finalize", label: "Final" },
];
const REFRESH_ON = new Set(["node", "plan", "source", "draft", "critique", "analysis", "final", "done", "error", "cancelled"]);
const AGENT_COLORS = {
  planner: "#8b5cf6", researcher: "#0ea5e9", retriever: "#14b8a6", analyst: "#f59e0b",
  writer: "#22c55e", critic: "#ef4444", reviser: "#ec4899", orchestrator: "#94a3b8",
};

export default function RunView({ runId, onDeleted, onChange }) {
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [tab, setTab] = useState("report");
  const [error, setError] = useState("");
  const [streamKey, setStreamKey] = useState(0);
  const lastId = useRef(0);
  const refreshTimer = useRef();

  const load = () => api.run(runId).then(setRun).catch((e) => setError(e.message));
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { load(); onChange?.(); }, 300);
  };

  useEffect(() => { load(); }, [runId]);

  useEffect(() => {
    const es = api.events(runId, lastId.current);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.id <= lastId.current) return;
      lastId.current = ev.id;
      setEvents((prev) => [...prev, ev]);
      if (REFRESH_ON.has(ev.type)) scheduleRefresh();
    };
    es.addEventListener("end", () => { es.close(); scheduleRefresh(); });
    es.onerror = () => es.close();
    return () => es.close();
  }, [runId, streamKey]);

  if (error) return <div className="pad error">{error}</div>;
  if (!run) return <div className="pad muted">Loading…</div>;

  const s = run.state;
  const running = run.active;
  const resumable = !running && ["failed", "cancelled", "interrupted"].includes(run.status);
  const report = s.final_report || s.drafts.at(-1)?.markdown;
  const visited = new Set(events.filter((e) => e.type === "node").map((e) => e.data.node));

  const act = async (fn) => {
    try { await fn(); } catch (e) { alert(e.message); }
    load(); onChange?.();
  };

  return (
    <div className="run">
      <header className="run-head">
        <div className="run-title">
          <span className={`badge ${run.status}`}>{running ? "running" : run.status}</span>
          <h2>{run.question}</h2>
          <div className="muted small">
            {s.options.depth} depth · max {s.options.max_revisions} revisions · {s.sources.length} sources ·{" "}
            {s.drafts.length} draft{s.drafts.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="run-actions">
          {running && <button className="btn" onClick={() => act(() => api.cancel(runId))}>Stop</button>}
          {resumable && (
            <button className="btn primary" onClick={() => act(async () => { await api.resume(runId); setStreamKey((k) => k + 1); })}>
              Resume from “{s.next_node}”
            </button>
          )}
          {s.final_report && <button className="btn" onClick={() => download(run)}>Download .md</button>}
          <button className="btn ghost" onClick={() => confirm("Delete this run?") && act(async () => { await api.remove(runId); onDeleted(); })}>
            Delete
          </button>
        </div>
      </header>

      <Pipeline state={s} visited={visited} running={running} status={run.status} />
      {s.error && <div className="error">⚠ {s.error}</div>}

      <div className="run-body">
        <section className="panel">
          <nav className="tabs">
            {[
              ["report", "Report"],
              ["review", `Review${s.critiques.length ? ` (${s.critiques.length})` : ""}`],
              ["sources", `Sources (${s.sources.length})`],
              ...(s.analysis ? [["analysis", "Analysis"]] : []),
              ["plan", "Plan"],
            ].map(([id, label]) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === "report" && (report ? (
              <>
                {!s.final_report && <div className="note">Working draft v{s.drafts.length} — still under review</div>}
                {s.final_report && <ScoreStrip critiques={s.critiques} best={s.best_iteration} />}
                <Markdown text={report} sources={s.sources} />
              </>
            ) : <Empty running={running} text="The report will appear here once the writer finishes its first draft." />)}
            {tab === "review" && <Review state={s} />}
            {tab === "sources" && <Sources sources={s.sources} />}
            {tab === "analysis" && <Analysis analysis={s.analysis} runId={runId} />}
            {tab === "plan" && <Plan plan={s.plan} models={s.models_used} />}
          </div>
        </section>
        <ActivityLog events={events} running={running} />
      </div>
    </div>
  );
}

function Pipeline({ state, visited, running, status }) {
  const current = state.next_node;
  const loops = state.critiques.length;
  return (
    <div className="pipeline">
      {STEPS.map((step) => {
        const ids = [step.id, ...(step.alias || [])];
        const isCurrent = ids.includes(current) && status !== "completed";
        const done = status === "completed" || (ids.some((i) => visited.has(i)) && !isCurrent);
        const skipped = step.id === "analyze" && !state.uploads.datasets.length;
        return (
          <div key={step.id} className={`step ${isCurrent ? (running ? "current" : "paused") : ""} ${done ? "done" : ""} ${skipped ? "skipped" : ""}`}>
            <span className="step-dot" />
            <span>{step.label}</span>
            {step.id === "critique" && loops > 0 && <span className="step-count">×{loops}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ScoreStrip({ critiques, best }) {
  if (!critiques.length) return null;
  return (
    <div className="score-strip">
      {critiques.map((c) => (
        <div key={c.iteration} className={`score-pill ${c.iteration === best ? "best" : ""}`}>
          <span className="muted small">v{c.iteration + 1}</span>
          <b>{c.overall}</b>
          <span className={`verdict ${c.verdict}`}>{c.verdict}</span>
        </div>
      ))}
    </div>
  );
}

function Markdown({ text, sources }) {
  const byId = useMemo(() => Object.fromEntries(sources.map((s) => [s.id, s])), [sources]);
  const processed = useMemo(() => text.replace(/\[(\d+)\](?!\()/g, "[$1](#src-$1)"), [text]);
  return (
    <article className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href = "", children }) => {
            if (href.startsWith("#src-")) {
              const src = byId[href.slice(5)];
              return (
                <a className={`cite ${src ? "" : "invalid"}`} href={src?.kind === "web" ? src.url : undefined}
                   target="_blank" rel="noreferrer" title={src ? src.title : "Unknown source"}>
                  {children}
                </a>
              );
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </article>
  );
}

function Review({ state }) {
  const [open, setOpen] = useState(null);
  if (!state.critiques.length) return <Empty running text="The critic reviews each draft here." />;
  return (
    <div className="review">
      <ScoreChart critiques={state.critiques} />
      {[...state.critiques].reverse().map((c) => {
        const draft = state.drafts.find((d) => d.iteration === c.iteration);
        const next = state.drafts.find((d) => d.iteration === c.iteration + 1);
        return (
          <div key={c.iteration} className="card crit">
            <div className="crit-head">
              <h3>Draft v{c.iteration + 1}</h3>
              <span className={`verdict ${c.verdict}`}>{c.verdict}</span>
              <span className="big-score">{c.overall}<small>/10</small></span>
            </div>
            <div className="muted small">written by {draft?.model} · reviewed by {c.model}{c.penalty ? ` · −${c.penalty} for invalid citations` : ""}</div>
            <p>{c.summary}</p>
            <div className="bars">
              {Object.entries(c.scores).map(([k, v]) => (
                <div key={k} className="bar-row">
                  <span>{k.replace("_", " ")}</span>
                  <div className="bar"><div style={{ width: `${v * 10}%` }} className={v >= 8 ? "good" : v >= 6 ? "ok" : "bad"} /></div>
                  <span className="mono">{v}</span>
                </div>
              ))}
            </div>
            <div className="audit small">
              <b>Citation audit:</b> {c.audit.citations_total} citations across {c.audit.unique_sources_cited}/{c.audit.sources_available} sources ·{" "}
              <span className={c.audit.invalid_citations.length ? "bad-text" : ""}>{c.audit.invalid_citations.length} invalid</span> ·{" "}
              {c.audit.weakly_supported.length} weakly supported · {c.audit.uncited_paragraphs.length} uncited paragraphs
            </div>
            {c.issues.length > 0 && (
              <ul className="issues">
                {c.issues.map((i, n) => (
                  <li key={n}>
                    <span className={`sev ${String(i.severity).toLowerCase()}`}>{i.severity}</span>
                    <span className="muted small">{i.type}</span> {i.description}
                    {i.fix && <div className="fix">→ {i.fix}</div>}
                  </li>
                ))}
              </ul>
            )}
            {next?.changes?.length > 0 && (
              <details>
                <summary>Reviser changes in v{next.iteration + 1} ({next.changes.length})</summary>
                <ul>{next.changes.map((ch, n) => <li key={n}>{ch}</li>)}</ul>
              </details>
            )}
            {draft && (
              <button className="btn ghost small" onClick={() => setOpen(open === c.iteration ? null : c.iteration)}>
                {open === c.iteration ? "Hide" : "Show"} draft v{c.iteration + 1}
              </button>
            )}
            {open === c.iteration && <Markdown text={draft.markdown} sources={state.sources} />}
          </div>
        );
      })}
    </div>
  );
}

function ScoreChart({ critiques }) {
  if (critiques.length < 2) return null;
  const w = 320, h = 90, pad = 18;
  const x = (i) => pad + (i * (w - 2 * pad)) / (critiques.length - 1);
  const y = (v) => h - pad - ((v - 1) / 9) * (h - 2 * pad);
  const pts = critiques.map((c, i) => `${x(i)},${y(c.overall)}`).join(" ");
  return (
    <div className="card score-chart">
      <div className="muted small">Quality score across revisions</div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h}>
        <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {critiques.map((c, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(c.overall)} r="4" fill="var(--accent)" />
            <text x={x(i)} y={y(c.overall) - 8} textAnchor="middle" fontSize="11" fill="currentColor">{c.overall}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function Sources({ sources }) {
  if (!sources.length) return <Empty running text="Sources appear here as the researcher reads them." />;
  return (
    <ol className="sources">
      {sources.map((s) => (
        <li key={s.id} id={`src-${s.id}`}>
          <span className="src-num">{s.id}</span>
          <div>
            {s.kind === "web" ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : <b>{s.title}</b>}
            <div className="muted small">
              {s.kind === "web" ? new URL(s.url).hostname : "uploaded document"} · {(s.chars / 1000).toFixed(1)}k chars
              {!s.full_text && " · snippet only"}
            </div>
            {s.snippet && <div className="snippet small">{s.snippet}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Analysis({ analysis, runId }) {
  return (
    <div className="analysis">
      <div className={`note ${analysis.success ? "" : "bad"}`}>
        {analysis.success ? "Analysis succeeded" : "Analysis failed"} after {analysis.attempts} attempt(s) {analysis.model && `· ${analysis.model}`}
      </div>
      {analysis.explanation && <p>{analysis.explanation}</p>}
      <div className="charts">
        {analysis.charts.map((c) => <img key={c} src={`/api/runs/${runId}/files/${c}`} alt={c} />)}
      </div>
      <h4>Output</h4>
      <pre>{analysis.output}</pre>
      <details>
        <summary>Generated code</summary>
        <pre>{analysis.code}</pre>
      </details>
    </div>
  );
}

function Plan({ plan, models }) {
  if (!plan) return <Empty running text="The planner's decomposition appears here." />;
  return (
    <div className="plan">
      <p><b>Objective:</b> {plan.objective}</p>
      <ol>
        {plan.subquestions.map((sq, i) => (
          <li key={i}>
            {sq.question}
            <div className="chips">{(sq.search_queries || []).map((q) => <span key={q} className="chip mono">{q}</span>)}</div>
          </li>
        ))}
      </ol>
      {plan.report_outline?.length > 0 && <p><b>Outline:</b> {plan.report_outline.join(" → ")}</p>}
      <h4>Models used</h4>
      <table className="models">
        <tbody>
          {Object.entries(models || {}).map(([role, ms]) => (
            <tr key={role}><td>{role}</td><td className="mono">{ms.join(", ")}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityLog({ events, running }) {
  const ref = useRef();
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [events.length]);
  return (
    <aside className="panel log">
      <div className="log-head">
        <span>Agent activity</span>
        {running && <span className="pulse" />}
      </div>
      <div className="log-body" ref={ref}>
        {events.map((e) => (
          <div key={e.id} className={`log-row ${e.type}`}>
            <span className="log-time mono">{new Date(e.ts * 1000).toLocaleTimeString([], { hour12: false })}</span>
            <span className="log-agent" style={{ color: AGENT_COLORS[e.agent] || "inherit" }}>{e.agent}</span>
            <span className="log-msg">{e.message}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Empty({ text, running }) {
  return <div className="empty muted">{running && <span className="spinner" />}{text}</div>;
}

function download(run) {
  const blob = new Blob([run.state.final_report], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `researchx-${run.id}.md`;
  a.click();
}
