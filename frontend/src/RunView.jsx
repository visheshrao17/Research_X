import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api.js";
import { AGENT_COLORS, Empty, Gauge, Metric, catalogNo, fmt, kfmt, pct } from "./ui.jsx";

const STEPS = [
  { id: "plan", label: "Plan" },
  { id: "research", label: "Research" },
  { id: "analyze", label: "Analyze" },
  { id: "write", label: "Write" },
  { id: "critique", label: "Critique" },
  { id: "revise", label: "Revise", alias: ["gap_research"] },
  { id: "finalize", label: "Final" },
  { id: "evaluate", label: "Evaluate" },
];
const REFRESH_ON = new Set(["node", "plan", "source", "draft", "critique", "analysis", "final", "done", "error",
                            "cancelled", "evaluation", "budget"]);
const RESUMABLE = ["failed", "cancelled", "interrupted", "paused"];

export default function RunView({ runId, me, toast, onDeleted, onChange, onTokens }) {
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [live, setLive] = useState(null);
  const [tab, setTab] = useState("report");
  const [error, setError] = useState("");
  const [streamKey, setStreamKey] = useState(0);
  const lastId = useRef(0);
  const lastLeft = useRef(null);
  const refreshTimer = useRef();

  const load = () => api.run(runId).then(setRun).catch((e) => setError(e.message));
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { load(); onChange?.(); }, 300);
  };

  useEffect(() => { load(); }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let es = null;
    let cancelled = false;
    api.events(runId, lastId.current).then((source) => {
      if (cancelled) { source.close(); return; }
      es = source;
      attach(es);
    }).catch((e) => setError(e.message));
    return () => { cancelled = true; es?.close(); };
  }, [runId, streamKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function attach(es) {
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.id <= lastId.current) return;
      lastId.current = ev.id;
      setEvents((prev) => [...prev, ev]);
      if (REFRESH_ON.has(ev.type)) scheduleRefresh();
    };
    es.addEventListener("live", (m) => {
      const l = JSON.parse(m.data);
      setLive(l);
      if (l.tokens_left != null && l.tokens_left !== lastLeft.current) {
        lastLeft.current = l.tokens_left;
        onTokens?.(l.tokens_left);
      }
    });
    es.addEventListener("end", () => { es.close(); setLive(null); scheduleRefresh(); });
    // On a dropped connection EventSource reconnects by itself and sends Last-Event-ID, so nothing is lost.
    // It only gives up (readyState CLOSED) on an HTTP error such as an expired token; refresh the run then.
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) scheduleRefresh(); };
  }

  if (error) return <div className="pad error">{error}</div>;
  if (!run) return <Empty running text="Opening the vault…" />;

  const s = run.state;
  const running = run.active;
  const resumable = !running && RESUMABLE.includes(run.status);
  const report = s.final_report || s.drafts.at(-1)?.markdown;
  const visited = new Set(events.filter((e) => e.type === "node").map((e) => e.data.node));
  const restream = () => setStreamKey((k) => k + 1);

  const act = async (fn) => {
    try { await fn(); } catch (e) { toast(e.message, true); }
    load(); onChange?.();
  };

  const tabs = [
    ["report", "Report"],
    ["review", `Review${s.critiques.length ? ` · ${s.critiques.length}` : ""}`],
    ["eval", `Evaluation${s.evaluation?.overall != null ? ` · ${s.evaluation.overall}` : ""}`],
    ["ask", `Ask the vault${s.qa?.length ? ` · ${s.qa.length}` : ""}`],
    ["sources", `Sources · ${s.sources.length}`],
    ...(s.analysis ? [["analysis", "Analysis"]] : []),
    ["plan", "Plan"],
  ];

  return (
    <div className="run">
      <header className="run-head">
        <div className="run-title">
          <span className={`badge ${run.status}`}>{running ? "running" : run.status}</span>
          <span className="catalog">{catalogNo(run.id)}</span>
          <h2>{run.question}</h2>
          <div className="muted small">
            {s.options.depth} depth · max {s.options.max_revisions} revisions · {s.sources.length} sources ·{" "}
            {s.drafts.length} draft{s.drafts.length === 1 ? "" : "s"} · <span className="mono">{fmt(run.tokens_used)}</span> tokens
            {run.user_id !== me.id && " · owned by another user"}
          </div>
        </div>
        <div className="run-actions">
          {running && <button className="btn" onClick={() => act(() => api.cancel(runId))}>Stop</button>}
          {resumable && (
            <button className="btn primary" onClick={() => act(async () => { await api.resume(runId); restream(); })}>
              Resume from “{s.next_node}”
            </button>
          )}
          {s.final_report && <button className="btn" onClick={() => download(run)}>Download .md</button>}
          <button className="btn ghost" onClick={() => confirm("Delete this run from the vault?") && act(async () => { await api.remove(runId); onDeleted(); })}>
            Delete
          </button>
        </div>
      </header>

      <Pipeline state={s} visited={visited} running={running} status={run.status} live={live} />
      {s.error && <div className="error">⚠ {s.error}</div>}

      <div className="run-body">
        <section className="panel">
          <nav className="tabs">
            {tabs.map(([id, label]) => (
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
            {tab === "eval" && (
              <Evaluation e={s.evaluation} running={running} canRun={!!report}
                          onRun={() => act(async () => { await api.evaluate(runId); restream(); })} />
            )}
            {tab === "ask" && <Ask run={run} running={running} onAsked={load} toast={toast} />}
            {tab === "sources" && <Sources sources={s.sources} />}
            {tab === "analysis" && <Analysis analysis={s.analysis} runId={runId} />}
            {tab === "plan" && <Plan plan={s.plan} models={s.models_used} />}
          </div>
        </section>
        <Terminal events={events} running={running} live={live} runId={runId} me={me} runTokens={run.tokens_used} status={run.status} />
      </div>
    </div>
  );
}

function Pipeline({ state, visited, running, status, live }) {
  const current = live?.node || state.next_node;
  const loops = state.critiques.length;
  return (
    <div className="pipeline">
      {STEPS.map((step, i) => {
        const ids = [step.id, ...(step.alias || [])];
        const isCurrent = ids.includes(current) && (running || status !== "completed");
        const done = !isCurrent && ((status === "completed" && (step.id !== "evaluate" || state.evaluation)) || ids.some((x) => visited.has(x)));
        const skipped = step.id === "analyze" && !state.uploads.datasets.length;
        return (
          <div key={step.id} style={{ display: "flex", alignItems: "center" }}>
            {i > 0 && <span className="step-link" />}
            <div className={`step ${isCurrent ? (running ? "current" : "paused") : ""} ${done ? "done" : ""} ${skipped ? "skipped" : ""}`}>
              <span className="step-dot" />
              <span>{step.label}</span>
              {step.id === "critique" && loops > 0 && <span className="step-count">×{loops}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ live terminal
function useNow(active) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 500);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const dur = (s) => (s == null || s < 0 ? "—" : s < 60 ? `${Math.floor(s)}s` : `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`);

function Terminal({ events, running, live, runId, me, runTokens, status }) {
  const ref = useRef();
  const [verbose, setVerbose] = useState(true);
  const [follow, setFollow] = useState(true);
  const now = useNow(!!live);
  useEffect(() => {
    if (follow) ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [events.length, follow]);
  const shown = verbose ? events : events.filter((e) => e.type !== "llm");
  const color = (a) => AGENT_COLORS[a] || "inherit";

  return (
    <aside className="panel term" aria-label="Agent terminal">
      <div className="term-bar">
        <span className="term-lights"><i /><i /><i /></span>
        <span className="term-title">vault://{me.username}/run/{runId}</span>
        <button className={`term-toggle ${verbose ? "on" : ""}`} onClick={() => setVerbose(!verbose)} title="Show model calls">llm</button>
        {running ? <span className="term-live"><i />LIVE</span> : <span className="term-title" style={{ flex: "none" }}>{status}</span>}
      </div>

      {live && (
        <div className="now" aria-live="polite">
          <div className="now-top">
            <span className="now-stage">◆ {live.stage || "Working"}</span>
            <span className="now-timer">stage {dur(now - (live.stage_started || now))}</span>
          </div>
          <div className="now-line">
            <span className="now-agent" style={{ color: color(live.agent) }}>{live.agent}</span>
            <span className="now-action">{live.action}</span>
            <span className="now-timer" style={{ marginLeft: "auto" }}>{dur(now - (live.action_started || now))}</span>
          </div>
          {live.detail && <div className="now-detail">{live.detail}</div>}
          {(live.stream || live.waiting) && (
            <div className="stream">
              <div className="stream-head">
                <span>{live.waiting ? "waiting for first token" : "model output"} · {live.model || "…"}</span>
                <span>{live.stream_chars ? `~${kfmt(Math.round(live.stream_chars / 4))} tok` : ""}</span>
              </div>
              <div className="stream-body">
                {live.waiting && !live.stream
                  ? <span className="waiting">prompt ≈ {kfmt(live.prompt_tokens_est)} tokens sent, thinking</span>
                  : <span>{live.stream}<span className="cursor" /></span>}
              </div>
            </div>
          )}
          <div className="now-meta">
            <span>this run <b>{fmt(live.run_tokens ?? runTokens)}</b></span>
            <span className="left">tokens left <b>{fmt(live.tokens_left ?? me.tokens_left)}</b></span>
          </div>
        </div>
      )}

      <div className="log-body" ref={ref} onScroll={(e) => {
        const el = e.currentTarget;
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      }}>
        {shown.map((e) => e.type === "node" ? (
          <div key={e.id} className="log-sep">{e.data.node.replace("_", " ")}</div>
        ) : (
          <div key={e.id} className={`log-row ${e.type}`}>
            <span className="log-time">{new Date(e.ts * 1000).toLocaleTimeString([], { hour12: false })}</span>
            <span className="log-agent" style={{ color: color(e.agent) }}>{e.agent}</span>
            <span className="log-msg">{e.message}</span>
          </div>
        ))}
        {running && !live && <div className="prompt-line">$ <span className="cursor" /></div>}
        {!running && events.length === 0 && <div className="prompt-line" style={{ color: "var(--term-dim)" }}>no activity recorded</div>}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ evaluation
const RAG_METRICS = [
  ["faithfulness", "Faithfulness", "Sampled claims supported by the source they cite (partial = ½)."],
  ["context_precision", "Context precision", "Retrieved chunks the judge rated relevant to their query."],
  ["ndcg", "nDCG", "Ranking quality: are the most relevant chunks ranked first?"],
  ["mrr", "MRR", "How early the first highly relevant chunk appears."],
  ["answer_relevance", "Answer relevance", "How directly the report answers the question."],
  ["subquestion_coverage", "Sub-question coverage", "Planned sub-questions the report fully answers."],
  ["citation_precision", "Citation precision", "Citations that point at a source that exists."],
  ["citation_coverage", "Citation coverage", "Substantive paragraphs that carry a citation."],
  ["hallucination_rate", "Hallucination rate", "Claims judged unsupported or contradicted. Lower is better.", true],
  ["source_utilization", "Source utilization", "Share of collected sources the report actually cites."],
];

function Evaluation({ e, running, canRun, onRun }) {
  if (!e || e.error) {
    return (
      <Empty running={running} text={e?.error ? `Evaluation failed: ${e.error}` : running ? "The evaluator grades the run after the final report." : "This run hasn't been evaluated yet."}>
        {!running && canRun && <button className="btn primary" onClick={onRun}>Run evaluation (~8k tokens)</button>}
      </Empty>
    );
  }
  const a = e.agents;
  const agentRows = Object.entries(a.per_agent);
  const maxStage = Math.max(1, ...Object.values(a.stage_seconds));
  return (
    <div>
      <div className="eval-top">
        <Gauge value={e.overall} />
        <div>
          <span className="eyebrow">Run grade</span>
          <div className="card-title" style={{ fontSize: 26 }}>
            {e.overall >= 80 ? "Vault-worthy" : e.overall >= 65 ? "Solid, with caveats" : e.overall >= 50 ? "Use with care" : "Needs more research"}
          </div>
          <p className="muted small" style={{ margin: "4px 0 10px" }}>
            Composite of faithfulness (35%), context precision (20%), answer relevance (20%), the critic's best score (15%)
            and citation precision (10%). Judged by <span className="mono">{e.judge_models.join(", ")}</span>.
          </p>
          <div className="muted small">
            {fmt(a.total_tokens)} tokens · {a.llm_calls} model calls · {dur(a.wall_seconds)} wall time · fallback rate {pct(a.fallback_rate)}
          </div>
        </div>
      </div>

      <div className="eyebrow">Retrieval-augmented generation</div>
      <div className="metric-grid" style={{ marginTop: 8 }}>
        {RAG_METRICS.map(([k, label, help, invert]) => <Metric key={k} label={label} value={e.rag[k]} help={help} invert={invert} />)}
        <Metric label="Ranker agreement" value={e.rag.ranker_agreement} format={pct}
                help={`Overlap of BM25 and ${e.retrieval.dense_retriever} top-k. Low means the rankers find different evidence, so fusing them helps.`} />
      </div>

      <h3 className="section-h">Agents</h3>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Agent</th><th className="r">Calls</th><th className="r">Tokens in</th><th className="r">Tokens out</th><th className="r">Avg latency</th><th className="r">Fallbacks</th><th>Models</th></tr></thead>
          <tbody>
            {agentRows.map(([name, r]) => (
              <tr key={name}>
                <td style={{ color: AGENT_COLORS[name] }}><b>{name}</b></td>
                <td className="r mono">{r.calls}</td>
                <td className="r mono">{fmt(r.input_tokens)}</td>
                <td className="r mono">{fmt(r.output_tokens)}</td>
                <td className="r mono">{r.avg_latency_s}s</td>
                <td className="r mono">{r.fallbacks}</td>
                <td className="mono small muted">{r.models.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="eyebrow">Time per stage</div>
          {Object.entries(a.stage_seconds).map(([k, v]) => (
            <div key={k} className="hbar">
              <span>{k.replace("_", " ")}</span>
              <span className="track"><span className="fill" style={{ width: `${(v / maxStage) * 100}%`, display: "block" }} /></span>
              <span className="val">{dur(v)}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="eyebrow">Per-agent quality</div>
          <dl className="small" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", margin: "10px 0 0" }}>
            <dt className="muted">Planner</dt><dd style={{ margin: 0 }}>{a.planner.subquestions} sub-questions · {a.planner.queries} queries · diversity {pct(a.planner.query_diversity)}</dd>
            <dt className="muted">Researcher</dt><dd style={{ margin: 0 }}>{a.researcher.searches} searches → {a.researcher.web_sources} sources ({a.researcher.sources_per_search ?? "—"}/search) · full text {pct(e.citations.full_text_rate)}</dd>
            <dt className="muted">Retriever</dt><dd style={{ margin: 0 }}>{fmt(e.retrieval.chunks_indexed)} chunks · {e.retrieval.avg_chunks_per_source}/source · {e.retrieval.dense_retriever}</dd>
            <dt className="muted">Writer</dt><dd style={{ margin: 0 }}>{fmt(e.citations.report_words)} words · {e.citations.citations_per_100_words} citations/100 words · {e.citations.unique_domains_cited} domains</dd>
            <dt className="muted">Critic loop</dt><dd style={{ margin: 0 }}>
              scores {a.critic_loop.scores.join(" → ") || "—"} · {a.critic_loop.passed ? <span className="good-text">passed</span> : "did not pass"} ·
              high issues {a.critic_loop.high_issues_first ?? "—"} → {a.critic_loop.high_issues_last ?? "—"}
            </dd>
            {a.analyst && <><dt className="muted">Analyst</dt><dd style={{ margin: 0 }}>{a.analyst.success ? "succeeded" : "failed"} in {a.analyst.attempts} attempt(s)</dd></>}
          </dl>
        </div>
      </div>

      <h3 className="section-h">Fact-check of cited claims</h3>
      <ul className="claims">
        {e.details.claims.map((c, i) => (
          <li key={i}>
            <span className={`verdict ${c.verdict}`} style={{ justifySelf: "start" }}>{c.verdict}</span>
            <span>{c.text} <span className="mono muted small">[{c.cited.join("][")}]</span>{c.reason && <div className="fix">{c.reason}</div>}</span>
          </li>
        ))}
      </ul>

      <h3 className="section-h">Retrieval relevance by query</h3>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Query</th><th>Chunks (rank order)</th><th className="r">Precision</th><th className="r">nDCG</th></tr></thead>
          <tbody>
            {e.details.per_query.map((q) => (
              <tr key={q.query}>
                <td className="small">{q.query}</td>
                <td><span className="rel-dots" title="green = relevant, amber = partial, red = irrelevant">{q.scores.map((x, i) => <i key={i} className={`s${x}`} />)}</span></td>
                <td className="r mono">{pct(q.precision)}</td>
                <td className="r mono">{q.ndcg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {e.details.coverage.length > 0 && (
        <>
          <h3 className="section-h">Sub-question coverage</h3>
          <ul className="claims">
            {e.details.coverage.map((c, i) => (
              <li key={i}><span className={`verdict ${c.status}`} style={{ justifySelf: "start" }}>{c.status}</span><span>{c.subquestion}</span></li>
            ))}
          </ul>
          {e.details.rationale && <p className="muted small">{e.details.rationale}</p>}
        </>
      )}
      {!running && <button className="btn small" style={{ marginTop: 16 }} onClick={onRun}>Re-run evaluation</button>}
    </div>
  );
}

// ------------------------------------------------------------------ ask the vault
function Ask({ run, running, onAsked, toast }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const qa = run.state.qa || [];
  const submit = async (e) => {
    e.preventDefault();
    if (q.trim().length < 3) return;
    setBusy(true);
    try { await api.ask(run.id, q.trim()); setQ(""); await onAsked(); } catch (err) { toast(err.message, true); }
    setBusy(false);
  };
  return (
    <div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Ask follow-up questions. The Librarian searches this run's indexed sources (hybrid RAG) and answers with citations — no new web research.
      </p>
      <form className="ask-box" onSubmit={submit}>
        <input className="input" placeholder={running ? "Available when the run finishes" : "e.g. Which source has the most recent cost data?"}
               value={q} onChange={(e) => setQ(e.target.value)} disabled={running || busy || !run.state.sources.length} />
        <button className="btn primary" disabled={running || busy || q.trim().length < 3}>{busy ? "Searching…" : "Ask"}</button>
      </form>
      {busy && <Empty running text="The Librarian is searching the vault…" />}
      {[...qa].reverse().map((x, i) => (
        <div key={i} className="qa">
          <div className="qa-q">{x.question}</div>
          <Markdown text={x.answer} sources={run.state.sources} />
          <div className="muted tiny mono" style={{ marginTop: 8 }}>{x.model} · {fmt(x.tokens)} tokens · searched sources [{x.retrieved.join(", ")}]</div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ report / review / sources / plan
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
    <div className="card">
      <div className="eyebrow">Quality score across revisions</div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Critic score per draft">
        <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {critiques.map((c, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(c.overall)} r="4" fill="var(--accent)" />
            <text x={x(i)} y={y(c.overall) - 8} textAnchor="middle" fontSize="11" fill="var(--text-2)">{c.overall}</text>
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

function download(run) {
  const blob = new Blob([run.state.final_report], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `researchx-${run.id}.md`;
  a.click();
}
