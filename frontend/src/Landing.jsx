import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Icon, VaultMark, fmt } from "./ui.jsx";

const AGENTS = [
  ["I", "Planner", "Breaks your question into sub-questions and search queries."],
  ["II", "Researcher", "Searches the web, reads pages and PDFs, indexes every source."],
  ["III", "Retriever", "Hybrid RAG: BM25 + dense embeddings fused with Reciprocal Rank Fusion."],
  ["IV", "Analyst", "Writes and runs pandas code on your datasets, repairing its own errors."],
  ["V", "Writer", "Drafts a report where every claim carries a numbered citation."],
  ["VI", "Critic", "A different model family peer-reviews the draft and audits each citation."],
  ["VII", "Reviser", "Fills the gaps the critic found and rewrites until the draft passes."],
  ["VIII", "Evaluator", "Grades the run: faithfulness, context precision, relevance, agent cost."],
];

const METRICS = [
  ["Faithfulness", "Sampled claims fact-checked against the exact source they cite."],
  ["Context precision · nDCG · MRR", "How relevant the retrieved chunks are, and how well they are ranked."],
  ["Answer relevance & coverage", "Does the report answer the question and every planned sub-question?"],
  ["Citation precision", "Citations that point at a real source, and paragraphs that carry one."],
  ["Ranker agreement", "Overlap between sparse and dense retrieval — why the hybrid pays off."],
  ["Agent telemetry", "Calls, tokens, latency and model fallbacks for every agent."],
];

export default function Landing({ onAuthed, offline }) {
  const [door, setDoor] = useState("reader");
  const [cfg, setCfg] = useState(null);
  useEffect(() => { api.authConfig().then(setCfg).catch(() => setCfg(null)); }, []);

  return (
    <div className="landing">
      {offline && (
        <div className="offline-banner" role="alert">
          <b>Can't reach the backend.</b> {offline} <span className="muted">Retrying every few seconds…</span>
        </div>
      )}
      <header className="l-top">
        <div className="brand">
          <VaultMark size={36} />
          <div>
            <div className="brand-name">ResearchX</div>
            <div className="brand-sub">The Intellectual Vault</div>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <section className="l-hero">
        <div>
          <span className="eyebrow">Autonomous research · cited · self-critiquing</span>
          <h1>Every question deserves a <em>vault</em> of evidence.</h1>
          <p className="lead">
            Ask something hard. A team of agents plans it, reads the web, retrieves the strongest evidence,
            writes a cited report, argues with itself until the draft holds up — then grades its own work.
          </p>
          <div className="l-stats">
            <div className="l-stat"><b>8</b><span>specialist agents</span></div>
            <div className="l-stat"><b>11</b><span>quality metrics per run</span></div>
            <div className="l-stat"><b>Live</b><span>view of every step</span></div>
          </div>
        </div>

        <div className="doors">
          <button className={`door ${door === "reader" ? "on" : ""}`} onClick={() => setDoor("reader")}>
            <span className="door-icon"><Icon name="lamp" size={22} /></span>
            <span>
              <h3>The Reading Room</h3>
              <p>For researchers and guests — ask questions, read reports, see the agents at work.</p>
            </span>
            <span className="door-arrow">→</span>
          </button>
          <button className={`door ${door === "keeper" ? "on" : ""}`} onClick={() => setDoor("keeper")}>
            <span className="door-icon"><Icon name="key" size={22} /></span>
            <span>
              <h3>The Keeper's Office</h3>
              <p>For the admin — manage the token pool, allotments, guests and evaluations.</p>
            </span>
            <span className="door-arrow">→</span>
          </button>
          <AuthCard key={door} keeper={door === "keeper"} cfg={cfg} offline={!!offline} onAuthed={onAuthed} />
        </div>
      </section>

      <section className="l-section">
        <span className="eyebrow">The agents</span>
        <h2>Eight minds, one vault.</h2>
        <div className="agents-row">
          {AGENTS.map(([n, name, text]) => (
            <div key={name} className="agent-cell">
              <div className="roman">{n}</div>
              <h4>{name}</h4>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="l-section">
        <span className="eyebrow">Measured, not assumed</span>
        <h2>Every run is graded.</h2>
        <div className="metric-cloud">
          {METRICS.map(([t, d]) => (
            <div key={t} className="metric-card"><b>{t}</b><p>{d}</p></div>
          ))}
        </div>
      </section>

      <footer className="l-foot">
        <span>ResearchX — runs on free LLM tiers (Groq · Gemini · OpenRouter) with LangGraph.</span>
        <span>Reports cite their sources. Check the ones that matter.</span>
      </footer>
    </div>
  );
}

function AuthCard({ keeper, cfg, offline, onAuthed }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Sign-up and guest entry are always visible in the Reading Room; the server decides if they're open.
  const signupClosed = cfg?.signup_enabled === false;
  const guestClosed = cfg?.guest_enabled === false;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const me = mode === "signup" ? await api.signup(username, password) : await api.login(username, password);
      if (keeper && me.role !== "admin") {
        setError("This account isn't an admin — use the Reading Room instead.");
        await api.logout();
        setBusy(false);
        return;
      }
      onAuthed(me, keeper ? "admin" : "home");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const guest = async () => {
    setBusy(true);
    setError("");
    try { onAuthed(await api.guest(), "home"); } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="card auth-card">
      {!keeper ? (
        <div className="auth-tabs">
          <button className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>Sign in</button>
          <button className={mode === "signup" ? "on" : ""} onClick={() => setMode("signup")}>Create account</button>
        </div>
      ) : (
        <div className="eyebrow" style={{ marginBottom: 12 }}>{keeper ? "Admin sign in" : "Sign in"}</div>
      )}
      <form className="auth-form" onSubmit={submit}>
        <label className="field">
          <span>Username</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)}
                 placeholder={keeper ? "admin" : "your-name"} required />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"}
                 value={password} onChange={(e) => setPassword(e.target.value)} minLength={mode === "signup" ? 8 : undefined} required />
        </label>
        {mode === "signup" && cfg && !signupClosed && (
          <div className="muted small">New accounts start with {fmt(cfg.default_user_tokens)} tokens.</div>
        )}
        {mode === "signup" && signupClosed && (
          <div className="error">Sign-ups are closed right now — ask the admin to create an account for you, or continue as a guest.</div>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn primary block" disabled={busy || offline || (mode === "signup" && signupClosed)}>
          {busy ? "Opening…" : mode === "signup" ? "Create account & enter" : keeper ? "Enter the Keeper's Office" : "Enter the Reading Room"}
        </button>
      </form>
      {!keeper && (
        <>
          <div className="or">or</div>
          <button className="btn block guest-btn" onClick={guest} disabled={busy || offline || guestClosed}>
            <span>{guestClosed ? "Guest mode is turned off" : "Continue as guest"}</span>
            {cfg && !guestClosed && <span className="muted small mono">{fmt(cfg.guest_tokens)} tokens · {cfg.guest_hours}h</span>}
          </button>
        </>
      )}
    </div>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "dark");
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("rx-theme", next); } catch {}
    setTheme(next);
  };
  return (
    <button className="icon-btn" onClick={flip} title={theme === "dark" ? "Parchment theme" : "Vault theme"}
            aria-label="Toggle theme">
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
