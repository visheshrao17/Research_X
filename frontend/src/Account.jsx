import { useEffect, useState } from "react";
import { api } from "./api.js";
import { AGENT_COLORS, Wallet, kfmt } from "./ui.jsx";

export default function Account({ me, setMe, toast }) {
  const [usage, setUsage] = useState(null);
  useEffect(() => { api.myUsage().then(setUsage).catch(() => {}); }, []);
  const guest = me.role === "guest";
  const hoursLeft = me.expires_at ? Math.max(0, Math.round((me.expires_at - Date.now() / 1000) / 3600)) : null;

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <span className="eyebrow">{guest ? "Guest pass" : "Your account"}</span>
          <h1>{me.username}</h1>
          {guest && <p className="muted small" style={{ margin: "6px 0 0" }}>This pass ends in about {hoursLeft}h. Your research disappears with it unless you create an account.</p>}
        </div>
      </div>

      <div className="grid g2">
        <div>
          <Wallet me={me} />
          <div className="card" style={{ marginTop: 14 }}>
            <div className="eyebrow">Where your tokens went</div>
            {!usage || usage.by_agent.length === 0 ? <div className="muted small pad">Nothing spent yet.</div> : (
              <div style={{ marginTop: 8 }}>
                {usage.by_agent.map((r) => {
                  const max = usage.by_agent[0].tokens || 1;
                  return (
                    <div key={r.agent} className="hbar">
                      <span style={{ color: AGENT_COLORS[r.agent] }}>{r.agent}</span>
                      <span className="track"><span className="fill" style={{ width: `${(r.tokens / max) * 100}%`, display: "block", background: AGENT_COLORS[r.agent] }} /></span>
                      <span className="val">{kfmt(r.tokens)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {guest ? <Upgrade setMe={setMe} toast={toast} /> : <Password toast={toast} />}
      </div>
    </div>
  );
}

function Upgrade({ setMe, toast }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { setMe(await api.upgrade(username, password)); toast("Welcome to the vault — your research is now kept"); }
    catch (err) { toast(err.message, true); }
    setBusy(false);
  };
  return (
    <form className="card" onSubmit={submit}>
      <div className="card-title">Keep your research</div>
      <p className="muted small">Turn this guest pass into an account. Your runs and unused tokens carry over, plus the new-account allotment if the pool allows.</p>
      <div className="auth-form">
        <label className="field"><span>Username</span><input className="input" required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
        <label className="field"><span>Password (8+ characters)</span><input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Create account"}</button>
      </div>
    </form>
  );
}

function Password({ toast }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    try { await api.changePassword(current, next); setCurrent(""); setNext(""); toast("Password changed"); }
    catch (err) { toast(err.message, true); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <div className="card-title">Change password</div>
      <div className="auth-form" style={{ marginTop: 12 }}>
        <label className="field"><span>Current password</span><input className="input" type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></label>
        <label className="field"><span>New password (8+ characters)</span><input className="input" type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
        <button className="btn primary">Update password</button>
      </div>
      <p className="muted tiny" style={{ marginBottom: 0 }}>Need more tokens? The admin can top up your allotment from the Keeper's Office.</p>
    </form>
  );
}
