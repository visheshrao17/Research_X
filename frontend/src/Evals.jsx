import { useEffect, useState } from "react";
import { api } from "./api.js";
import { AGENT_COLORS, Empty, Metric, fmt, kfmt, pct } from "./ui.jsx";

const TILES = [
  ["overall", "Overall grade", "Composite 0–100 across all evaluated runs.", (v) => Math.round(v), 100],
  ["faithfulness", "Faithfulness", "Cited claims supported by their source."],
  ["context_precision", "Context precision", "Retrieved chunks judged relevant."],
  ["answer_relevance", "Answer relevance", "Reports that answer the question asked."],
  ["ndcg", "nDCG", "Ranking quality of retrieval."],
  ["subquestion_coverage", "Coverage", "Planned sub-questions answered."],
  ["citation_precision", "Citation precision", "Citations pointing at real sources."],
  ["hallucination_rate", "Hallucination rate", "Unsupported or contradicted claims (lower is better).", pct, 1, true],
];

export default function Evals({ me, open, toast }) {
  const [all, setAll] = useState(me.role === "admin");
  const [data, setData] = useState(null);
  const load = () => api.evals(all).then(setData).catch((e) => toast(e.message, true));
  useEffect(() => { setData(null); load(); }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  const evaluate = async (id) => {
    try { await api.evaluate(id); toast("Evaluation started — open the run to watch it live"); open(id); } catch (e) { toast(e.message, true); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Measured, not assumed</span>
          <h1>Evaluations</h1>
          <p className="muted small" style={{ margin: "6px 0 0", maxWidth: 640 }}>
            Every finished run is graded by an independent judge model: RAG quality (faithfulness, context precision, nDCG, MRR,
            answer relevance) and agent telemetry (tokens, latency, fallbacks). Averages below cover {data ? data.runs.length : "…"} evaluated runs.
          </p>
        </div>
        {me.role === "admin" && (
          <div className="seg">
            <button className={all ? "on" : ""} onClick={() => setAll(true)}>All users</button>
            <button className={!all ? "on" : ""} onClick={() => setAll(false)}>Mine</button>
          </div>
        )}
      </div>

      {!data ? <Empty running text="Loading evaluations…" /> : (
        <>
          <div className="metric-grid">
            {TILES.map(([k, label, help, format = pct, scale = 1, invert = false]) => (
              <Metric key={k} label={label} value={data.averages[k]} help={help} format={format} scale={scale} invert={invert} />
            ))}
          </div>

          <div className="grid g3" style={{ marginTop: 14 }}>
            <div className="stat"><div className="eyebrow">Avg tokens / run</div><div className="v">{kfmt(data.averages.tokens)}</div></div>
            <div className="stat"><div className="eyebrow">Avg wall time</div><div className="v">{data.averages.wall_seconds ? `${Math.round(data.averages.wall_seconds)}s` : "—"}</div></div>
            <div className="stat"><div className="eyebrow">Avg critic score</div><div className="v">{data.averages.best_critic ?? "—"}<small>/10</small></div></div>
          </div>

          {data.runs.length > 1 && <Trend runs={data.runs} />}

          <h3 className="section-h">Runs</h3>
          {data.runs.length === 0 ? (
            <Empty text="No evaluated runs yet. New runs are evaluated automatically when they finish." />
          ) : (
            <div className="card table-wrap" style={{ padding: 0 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Question</th>{all && <th>User</th>}<th className="r">Grade</th><th className="r">Faith.</th><th className="r">Ctx prec.</th>
                    <th className="r">Relevance</th><th className="r">nDCG</th><th className="r">Critic</th><th className="r">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                      <td style={{ maxWidth: 380 }}><div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.question}</div></td>
                      {all && <td className="small muted">{r.username}</td>}
                      <td className="r mono"><b>{r.overall}</b></td>
                      <td className="r mono">{pct(r.faithfulness)}</td>
                      <td className="r mono">{pct(r.context_precision)}</td>
                      <td className="r mono">{pct(r.answer_relevance)}</td>
                      <td className="r mono">{r.ndcg ?? "—"}</td>
                      <td className="r mono">{r.best_critic ?? "—"}</td>
                      <td className="r mono">{kfmt(r.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {Object.keys(data.agents).length > 0 && (
            <>
              <h3 className="section-h">Agents across all runs</h3>
              <div className="card table-wrap" style={{ padding: 0 }}>
                <table className="tbl">
                  <thead><tr><th>Agent</th><th className="r">Calls</th><th className="r">Tokens</th><th className="r">Avg latency</th><th className="r">Fallback rate</th></tr></thead>
                  <tbody>
                    {Object.entries(data.agents).sort((a, b) => b[1].tokens - a[1].tokens).map(([name, a]) => (
                      <tr key={name}>
                        <td style={{ color: AGENT_COLORS[name] }}><b>{name}</b></td>
                        <td className="r mono">{a.calls}</td>
                        <td className="r mono">{fmt(a.tokens)}</td>
                        <td className="r mono">{a.avg_latency_s}s</td>
                        <td className="r mono">{pct(a.fallback_rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {data.unevaluated.length > 0 && (
            <>
              <h3 className="section-h">Finished but not evaluated</h3>
              <div className="card">
                {data.unevaluated.map((r) => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", padding: "6px 0" }}>
                    <span className="small">{r.question}</span>
                    <button className="btn small" onClick={() => evaluate(r.id)}>Evaluate</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Trend({ runs }) {
  const pts = [...runs].reverse().slice(-30);
  const w = 760, h = 150, px = 30, py = 18;
  const x = (i) => px + (i * (w - 2 * px)) / Math.max(1, pts.length - 1);
  const y = (v) => h - py - (v / 100) * (h - 2 * py);
  const line = (key, scale = 1) => pts.map((r, i) => (r[key] == null ? null : `${x(i)},${y(r[key] * scale)}`)).filter(Boolean).join(" ");
  return (
    <div className="card trend" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <span className="eyebrow">Quality over time (last {pts.length} runs)</span>
        <span className="legend">
          <span><i style={{ background: "var(--accent)" }} />overall</span>
          <span><i style={{ background: "var(--good)" }} />faithfulness</span>
          <span><i style={{ background: "var(--info)" }} />context precision</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Evaluation scores over time">
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line x1={px} x2={w - px} y1={y(g)} y2={y(g)} stroke="var(--border)" strokeDasharray={g ? "3 4" : ""} />
            <text x={px - 6} y={y(g) + 4} fontSize="10" textAnchor="end" fill="var(--muted)">{g}</text>
          </g>
        ))}
        <polyline points={line("context_precision", 100)} fill="none" stroke="var(--info)" strokeWidth="1.5" opacity=".8" />
        <polyline points={line("faithfulness", 100)} fill="none" stroke="var(--good)" strokeWidth="1.5" opacity=".8" />
        <polyline points={line("overall")} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {pts.map((r, i) => <circle key={r.id} cx={x(i)} cy={y(r.overall)} r="3.5" fill="var(--accent)"><title>{r.question}: {r.overall}</title></circle>)}
      </svg>
    </div>
  );
}
