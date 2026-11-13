import { useRef, useState } from "react";
import { api } from "./api.js";

const EXAMPLES = [
  "What are the most promising approaches to grid-scale energy storage, and how do their costs compare?",
  "How has the adoption of GLP-1 drugs affected the food and healthcare industries?",
  "Is small modular nuclear reactor deployment realistic before 2035? What are the main obstacles?",
  "What does current evidence say about the productivity effects of remote work?",
];

const DEPTHS = [
  { id: "quick", label: "Quick", hint: "3 sub-questions" },
  { id: "standard", label: "Standard", hint: "4 sub-questions" },
  { id: "deep", label: "Deep", hint: "6 sub-questions" },
];

export default function Composer({ onCreated, health }) {
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState("standard");
  const [revisions, setRevisions] = useState(2);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const inputRef = useRef();

  const addFiles = (list) => setFiles((f) => [...f, ...Array.from(list)]);

  const submit = async (e) => {
    e?.preventDefault();
    if (question.trim().length < 5 || busy) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.append("question", question.trim());
    form.append("depth", depth);
    form.append("max_revisions", revisions);
    files.forEach((f) => form.append("files", f));
    try {
      const { id } = await api.create(form);
      onCreated(id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const noKeys = health?.ok && Object.values(health.models).every((m) => m.length === 0);

  return (
    <div className="composer-wrap">
      <div className="hero">
        <h1>What do you want to research?</h1>
        <p className="muted">
          A team of agents plans the question, searches the web, analyzes your data, writes a cited report,
          critiques it, and revises it until it passes review.
        </p>
      </div>

      <form className="composer card" onSubmit={submit}>
        <textarea
          autoFocus
          rows={4}
          placeholder="Ask a complex question…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
        />

        <div
          className={`drop ${drag ? "drag" : ""}`}
          onClick={() => inputRef.current.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
        >
          <input ref={inputRef} type="file" multiple hidden accept=".csv,.tsv,.xlsx,.xls,.json,.pdf,.txt,.md"
                 onChange={(e) => addFiles(e.target.files)} />
          {files.length === 0 ? (
            <span className="muted small">Optional: drop datasets (CSV, XLSX, JSON) for analysis or documents (PDF, TXT, MD) for RAG</span>
          ) : (
            <div className="chips">
              {files.map((f, i) => (
                <span key={i} className="chip" onClick={(e) => { e.stopPropagation(); setFiles(files.filter((_, j) => j !== i)); }}>
                  {f.name} ✕
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="composer-row">
          <div className="seg">
            {DEPTHS.map((d) => (
              <button type="button" key={d.id} className={depth === d.id ? "on" : ""} onClick={() => setDepth(d.id)} title={d.hint}>
                {d.label}
              </button>
            ))}
          </div>
          <label className="rev">
            <span className="muted small">Max revisions</span>
            <input type="range" min={0} max={4} value={revisions} onChange={(e) => setRevisions(+e.target.value)} />
            <span className="mono">{revisions}</span>
          </label>
          <button className="btn primary" disabled={busy || question.trim().length < 5 || noKeys}>
            {busy ? "Starting…" : "Start research ⌘↵"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {noKeys && <div className="error">Configure at least one free LLM API key in backend/.env, then restart the backend.</div>}
      </form>

      <div className="examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} className="example" onClick={() => setQuestion(ex)}>{ex}</button>
        ))}
      </div>
    </div>
  );
}
