import { useEffect, useState } from "react";
import { api } from "./api.js";
import { AGENT_COLORS, Empty, ago, fmt, kfmt } from "./ui.jsx";

export default function Admin({ me, toast, onChange }) {
  const [ov, setOv] = useState(null);
  const [users, setUsers] = useState(null);
  const [filter, setFilter] = useState("all");
  const [creating, setCreating] = useState(false);

  const load = () => Promise.all([api.overview().then(setOv), api.users().then(setUsers)]).catch((e) => toast(e.message, true));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn, ok) => {
    try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message, true); }
    await load();
    onChange?.();
  };

  if (!ov || !users) return <Empty running text="Unlocking the Keeper's Office…" />;
  const p = ov.pool;
  const share = (n) => `${Math.max(0, Math.min(100, (n / Math.max(p.pool, 1)) * 100))}%`;
  const count = (role) => ov.users.find((u) => u.role === role)?.n || 0;
  const shown = users.filter((u) => filter === "all" || u.role === filter);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Admin</span>
          <h1>The Keeper's Office</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => run(api.purgeGuests, "Expired guest passes closed")}>Close expired guests</button>
          <button className="btn primary" onClick={() => setCreating(true)}>+ New account</button>
        </div>
      </div>

      {/* ---------------- pool ---------------- */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div className="card-title">Token pool</div>
            <div className="muted small">Everything the vault may spend. Allotments to users and guests are carved out of it.</div>
          </div>
          <PoolEditor pool={p.pool} onSave={(v) => run(() => api.saveSettings({ token_pool: v }), "Pool updated")} />
        </div>
        <div className="pool-bar" role="img" aria-label="Pool breakdown">
          <div style={{ width: share(p.consumed), background: "var(--bad)" }} title="consumed" />
          <div style={{ width: share(p.committed), background: "var(--ok)" }} title="committed" />
          <div style={{ width: share(Math.max(p.available, 0)), background: "var(--good)" }} title="available" />
        </div>
        <div className="grid g4">
          <PoolStat label="Pool size" value={p.pool} color="var(--text)" />
          <PoolStat label="Consumed" value={p.consumed} color="var(--bad)" note="spent on model calls (all time)" />
          <PoolStat label="Committed" value={p.committed} color="var(--ok)" note="still unspent in active allotments" />
          <PoolStat label="Available" value={p.available} color="var(--good)" note="free to grant (or for your own runs)" />
        </div>
      </div>

      <div className="grid g4" style={{ marginTop: 14 }}>
        <div className="stat"><div className="eyebrow">Researchers</div><div className="v">{count("user")}</div></div>
        <div className="stat"><div className="eyebrow">Active guests</div><div className="v">{count("guest")}</div></div>
        <div className="stat"><div className="eyebrow">Admins</div><div className="v">{count("admin")}</div></div>
        <div className="stat"><div className="eyebrow">Runs</div><div className="v">{ov.runs.reduce((a, r) => a + r.n, 0)}</div>
          <div className="d">{ov.runs.map((r) => `${r.n} ${r.status}`).join(" · ")}</div></div>
      </div>

      {/* ---------------- policy ---------------- */}
      <Policy settings={ov.settings} onSave={(patch) => run(() => api.saveSettings(patch), "Policy saved")} />

      {/* ---------------- usage ---------------- */}
      <div className="grid g3" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="eyebrow">Tokens per day (14 days)</div>
          <DayBars rows={ov.by_day} />
        </div>
        <div className="card">
          <div className="eyebrow">By agent</div>
          <Bars rows={ov.by_agent.map((r) => [r.agent, r.tokens, AGENT_COLORS[r.agent]])} />
        </div>
        <div className="card">
          <div className="eyebrow">By model</div>
          <Bars rows={ov.by_model.map((r) => [r.model, r.tokens])} />
        </div>
      </div>

      {/* ---------------- users ---------------- */}
      <div className="page-head" style={{ marginTop: 26, marginBottom: 10 }}>
        <h3 className="section-h" style={{ margin: 0 }}>Accounts & allotments</h3>
        <div className="seg">
          {["all", "user", "guest", "admin"].map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="tbl">
          <thead>
            <tr><th>Account</th><th>Usage</th><th className="r">Runs</th><th>Last seen</th><th>Set allotment</th><th className="r">Actions</th></tr>
          </thead>
          <tbody>
            {shown.map((u) => <UserRow key={u.id} u={u} me={me} run={run} />)}
          </tbody>
        </table>
      </div>

      {creating && <CreateUser onClose={() => setCreating(false)} onCreate={(body) => run(async () => { await api.createUser(body); setCreating(false); }, `Account ${body.username} created`)} />}
    </div>
  );
}

function PoolStat({ label, value, color, note }) {
  return (
    <div>
      <div className="eyebrow"><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: color, marginRight: 6 }} />{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{fmt(value)}</div>
      {note && <div className="muted tiny">{note}</div>}
    </div>
  );
}

function PoolEditor({ pool, onSave }) {
  const [v, setV] = useState(pool);
  useEffect(() => setV(pool), [pool]);
  return (
    <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); onSave(Number(v)); }}>
      <input className="input mono" type="number" min={0} step={10000} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 150 }} aria-label="Pool size" />
      <button className="btn small" type="button" onClick={() => setV(Number(v) + 500000)}>+500k</button>
      <button className="btn small primary" disabled={Number(v) === pool}>Save pool</button>
    </form>
  );
}

function Policy({ settings, onSave }) {
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" ? Number(e.target.value) : e.target.value });
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div>
          <div className="card-title">Access policy</div>
          <div className="muted small">What guests and new researchers receive. Changes apply to new accounts and guest passes.</div>
        </div>
        <button className="btn primary" disabled={!dirty} onClick={() => onSave(s)}>Save policy</button>
      </div>
      <div className="settings-grid" style={{ marginTop: 14 }}>
        <div className="card" style={{ background: "var(--panel-2)", boxShadow: "none" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <b>Guest mode</b>
            <label className="switch"><input type="checkbox" checked={s.guest_enabled} onChange={set("guest_enabled")} /> {s.guest_enabled ? "on" : "off"}</label>
          </div>
          <div className="grid g2" style={{ marginTop: 12 }}>
            <label className="field"><span>Tokens per guest pass</span>
              <input className="input mono" type="number" min={0} step={5000} value={s.guest_tokens} onChange={set("guest_tokens")} /></label>
            <label className="field"><span>Max research depth</span>
              <select className="select" value={s.guest_max_depth} onChange={set("guest_max_depth")}>
                <option value="quick">quick</option><option value="standard">standard</option><option value="deep">deep</option>
              </select></label>
          </div>
          <label className="switch" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={s.guest_uploads} onChange={set("guest_uploads")} />
            <span className="small">Allow guest file uploads <span className="muted">(dataset analysis runs model-written code)</span></span>
          </label>
        </div>
        <div className="card" style={{ background: "var(--panel-2)", boxShadow: "none" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <b>Researcher sign-ups</b>
            <label className="switch"><input type="checkbox" checked={s.signup_enabled} onChange={set("signup_enabled")} /> {s.signup_enabled ? "open" : "closed"}</label>
          </div>
          <label className="field" style={{ marginTop: 12 }}><span>Tokens for each new account</span>
            <input className="input mono" type="number" min={0} step={10000} value={s.default_user_tokens} onChange={set("default_user_tokens")} /></label>
          <div className="muted small" style={{ marginTop: 10 }}>
            A quick run costs roughly 40–50k tokens, standard ~80k, deep ~130k (with one revision).
          </div>
        </div>
      </div>
    </div>
  );
}

function UserRow({ u, me, run }) {
  const [limit, setLimit] = useState(u.token_limit ?? "");
  useEffect(() => setLimit(u.token_limit ?? ""), [u.token_limit]);
  const capped = u.token_limit != null;
  const left = capped ? Math.max(0, u.token_limit - u.tokens_used) : null;
  const share = capped ? Math.min(1, u.tokens_used / Math.max(u.token_limit, 1)) : 0;
  const status = u.disabled ? (u.expired ? "expired" : "disabled") : null;
  const patch = (body, ok) => run(() => api.updateUser(u.id, body), ok);
  return (
    <tr style={{ opacity: u.disabled ? 0.55 : 1 }}>
      <td>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <b>{u.username}</b><span className={`pill ${u.role}`}>{u.role}</span>{status && <span className="pill off">{status}</span>}
        </div>
        <div className="muted tiny">
          joined {ago(u.created_at)}{u.role === "guest" && u.expires_at && !u.expired ? ` · pass ends in ${Math.max(0, Math.round((u.expires_at - Date.now() / 1000) / 3600))}h` : ""}
        </div>
      </td>
      <td className="user-meter">
        {capped ? (
          <>
            <div className="small mono">{kfmt(u.tokens_used)} / {kfmt(u.token_limit)}</div>
            <div className={`meter ${share > 0.88 ? "low" : ""}`}><div style={{ width: `${share * 100}%` }} /></div>
            <div className="tiny muted">{fmt(left)} left</div>
          </>
        ) : <div className="small mono">{kfmt(u.tokens_used)} used · pool</div>}
      </td>
      <td className="r mono">{u.runs}</td>
      <td className="small muted">{ago(u.last_seen)}</td>
      <td>
        {u.role !== "admin" ? (
          <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); patch({ token_limit: Number(limit) }, `Allotment for ${u.username} set`); }}>
            <input className="input mono" type="number" min={0} step={5000} value={limit} onChange={(e) => setLimit(e.target.value)} aria-label={`Allotment for ${u.username}`} />
            <button className="btn small" disabled={String(limit) === String(u.token_limit)}>Set</button>
            <button type="button" className="btn small" onClick={() => patch({ add_tokens: 25000 }, `+25k to ${u.username}`)}>+25k</button>
          </form>
        ) : <span className="muted small">draws from pool</span>}
      </td>
      <td>
        <div className="row-actions">
          {u.role === "guest" && !u.disabled && <button className="btn small ghost" onClick={() => patch({ extend_hours: 24 }, "Guest pass extended 24h")}>+24h</button>}
          {u.role === "user" && <button className="btn small ghost" onClick={() => {
            const pw = prompt(`New password for ${u.username} (8+ characters)`);
            if (pw) patch({ password: pw }, "Password reset");
          }}>Reset pw</button>}
          {u.id !== me.id && !u.expired && (
            <button className="btn small ghost" onClick={() => patch({ disabled: !u.disabled }, u.disabled ? "Account enabled" : "Account disabled")}>
              {u.disabled ? "Enable" : "Disable"}
            </button>
          )}
          {u.id !== me.id && (
            <button className="btn small ghost danger" onClick={() => confirm(`Delete ${u.username} and all of their runs?`) && run(() => api.deleteUser(u.id), "Account deleted")}>
              Delete
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CreateUser({ onClose, onCreate }) {
  const [f, setF] = useState({ username: "", password: "", role: "user", token_limit: 100000 });
  const set = (k) => (e) => setF({ ...f, [k]: k === "token_limit" ? Number(e.target.value) : e.target.value });
  return (
    <div className="modal-back" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onCreate(f); }}>
        <div className="card-title">New account</div>
        <div className="auth-form" style={{ marginTop: 12 }}>
          <label className="field"><span>Username</span><input className="input" required value={f.username} onChange={set("username")} autoFocus /></label>
          <label className="field"><span>Password</span><input className="input" type="text" required minLength={8} value={f.password} onChange={set("password")} /></label>
          <label className="field"><span>Role</span>
            <select className="select" value={f.role} onChange={set("role")}><option value="user">researcher</option><option value="admin">admin</option></select></label>
          {f.role === "user" && (
            <label className="field"><span>Token allotment</span><input className="input mono" type="number" min={0} step={10000} value={f.token_limit} onChange={set("token_limit")} /></label>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary">Create</button>
          </div>
        </div>
      </form>
    </div>
  );
}

function DayBars({ rows }) {
  if (!rows.length) return <div className="muted small pad">No usage yet.</div>;
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  return (
    <div className="cols-bars" role="img" aria-label="Tokens per day">
      {rows.map((r) => (
        <div key={r.day} className="col" title={`${r.day}: ${fmt(r.tokens)} tokens, ${r.calls} calls`}>
          <span>{kfmt(r.tokens)}</span>
          <div className="b" style={{ height: `${(r.tokens / max) * 100}%` }} />
          <span>{r.day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function Bars({ rows }) {
  if (!rows.length) return <div className="muted small pad">No usage yet.</div>;
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return (
    <div style={{ marginTop: 8 }}>
      {rows.slice(0, 8).map(([name, v, color]) => (
        <div key={name} className="hbar">
          <span title={name} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color }}>{name}</span>
          <span className="track"><span className="fill" style={{ width: `${(v / max) * 100}%`, display: "block", background: color || "var(--accent)" }} /></span>
          <span className="val">{kfmt(v)}</span>
        </div>
      ))}
    </div>
  );
}
