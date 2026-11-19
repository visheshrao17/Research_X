import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import Account from "./Account.jsx";
import Admin from "./Admin.jsx";
import Composer from "./Composer.jsx";
import Evals from "./Evals.jsx";
import Landing, { ThemeToggle } from "./Landing.jsx";
import RunView from "./RunView.jsx";
import { Icon, VaultMark, Wallet, catalogNo, kfmt, useToast } from "./ui.jsx";

function parseRoute() {
  const legacy = new URLSearchParams(location.search).get("run");
  if (legacy) return { page: "run", id: legacy };
  const [, page = "", id] = location.hash.replace(/^#/, "").split("/");
  return { page: page || "home", id };
}

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [route, setRoute] = useState(parseRoute);
  const [runs, setRuns] = useState([]);
  const [health, setHealth] = useState(null);
  const [flash, setFlash] = useState(0);
  const [offline, setOffline] = useState(""); // set while the backend can't be reached
  const [toastNode, toast] = useToast();

  const go = useCallback((page, id) => {
    const hash = page === "home" ? "#/" : `#/${page}${id ? `/${id}` : ""}`;
    if (location.search) history.replaceState(null, "", "/" + hash);
    else location.hash = hash;
    setRoute({ page, id });
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    const onUnauth = () => setMe(null);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("rx:unauthorized", onUnauth);
    api.me().then(setMe).catch((err) => {
      setMe(null);
      if (err.status !== 401) setOffline(err.message || "Backend not reachable");
    });
    api.health().then(setHealth).catch((err) => { setHealth({ ok: false }); setOffline(err.message || "Backend not reachable"); });
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("rx:unauthorized", onUnauth); };
  }, []);

  // While offline, poll the backend and reconnect by itself once it answers (e.g. it was still starting up).
  useEffect(() => {
    if (!offline) return;
    const t = setInterval(() => {
      api.health().then((h) => {
        setHealth(h);
        setOffline("");
        api.me().then(setMe).catch(() => setMe(null));
      }).catch((err) => setOffline(err.message || "Backend not reachable"));
    }, 3000);
    return () => clearInterval(t);
  }, [offline]);

  const refreshMe = useCallback(() => api.me().then(setMe).catch(() => {}), []);
  const refreshRuns = useCallback(() => api.runs(me?.role === "admin").then(setRuns).catch(() => {}), [me?.role]);

  useEffect(() => {
    if (!me) return;
    refreshRuns();
    const t = setInterval(() => { refreshRuns(); refreshMe(); }, 8000);
    return () => clearInterval(t);
  }, [me?.id, refreshRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  // live token updates pushed from a running job's SSE stream
  const onTokens = useCallback((left) => {
    setMe((m) => (m && m.tokens_left !== left ? { ...m, tokens_left: left, tokens_used: m.tokens_used + Math.max(0, m.tokens_left - left) } : m));
    setFlash((f) => f + 1);
  }, []);

  if (me === undefined) return <div className="empty"><VaultMark size={56} className="spin-slow" /></div>;
  if (!me) return <Landing key={offline ? "offline" : "online"} offline={offline} onAuthed={(user, page) => { setMe(user); go(page); }} />;

  const logout = async () => { await api.logout().catch(() => {}); setMe(null); setRuns([]); go("home"); };
  const nav = [
    ["home", "plus", "New research"],
    ["evals", "gauge", "Evaluations"],
    ...(me.role === "admin" ? [["admin", "key", "Keeper's Office"]] : []),
    ["account", "user", me.role === "guest" ? "Guest pass" : "Account"],
  ];

  let page;
  if (route.page === "run" && route.id) {
    page = <RunView key={route.id} runId={route.id} me={me} toast={toast} onTokens={onTokens}
                    onDeleted={() => { go("home"); refreshRuns(); refreshMe(); }} onChange={() => { refreshRuns(); refreshMe(); }} />;
  } else if (route.page === "evals") {
    page = <Evals me={me} open={(id) => go("run", id)} toast={toast} />;
  } else if (route.page === "admin" && me.role === "admin") {
    page = <Admin me={me} toast={toast} onChange={refreshMe} open={(id) => go("run", id)} />;
  } else if (route.page === "account") {
    page = <Account me={me} setMe={setMe} toast={toast} />;
  } else {
    page = <Composer me={me} health={health} onCreated={(id) => { go("run", id); refreshRuns(); }} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onClick={() => go("home")}>
          <VaultMark size={32} />
          <div>
            <div className="brand-name">ResearchX</div>
            <div className="brand-sub">Intellectual Vault</div>
          </div>
        </div>
        <nav className="nav">
          {nav.map(([id, icon, label]) => (
            <button key={id} className={route.page === id ? "on" : ""} onClick={() => go(id)}>
              <Icon name={icon} /> {label}
            </button>
          ))}
        </nav>
        <div className="side-label"><span className="eyebrow">The archive</span><span className="tiny muted">{runs.length}</span></div>
        <div className="run-list">
          {runs.length === 0 && <div className="muted small pad">No research yet — ask your first question.</div>}
          {runs.map((r) => (
            <button key={r.id} className={`run-item ${route.id === r.id ? "active" : ""}`} onClick={() => go("run", r.id)} title={r.question}>
              <span className={`dot ${r.status}`} />
              <span className="run-q">{r.question}</span>
              <span className="run-meta">{catalogNo(r.id)} · {kfmt(r.tokens_used)} tok{r.username && r.username !== me.username ? ` · ${r.username}` : ""}</span>
            </button>
          ))}
        </div>
        {me.role === "guest" && (
          <div className="guest-banner">
            You're on a guest pass. <a href="#/account">Keep your research</a> by creating an account.
          </div>
        )}
        <Wallet me={me} flash={flash} />
        <div className="userbar">
          <span className="avatar">{me.username[0].toUpperCase()}</span>
          <span className="name">{me.username} <span className={`pill ${me.role}`}>{me.role}</span></span>
          <ThemeToggle />
          <button className="icon-btn" onClick={logout} title="Sign out" aria-label="Sign out"><Icon name="logout" /></button>
        </div>
      </aside>
      <main className="main">{page}</main>
      {toastNode}
    </div>
  );
}
