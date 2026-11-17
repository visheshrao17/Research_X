import { useEffect, useRef, useState } from "react";

export const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());
export const kfmt = (n) => {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(n);
};
export const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
export const ago = (ts) => {
  if (!ts) return "never";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
export const catalogNo = (id) => `№ ${parseInt(id.slice(0, 6), 16) % 10000}`.padEnd(6, " ");

export const AGENT_COLORS = {
  planner: "#b39ddb", researcher: "#7fb7d9", retriever: "#7cc6b8", analyst: "#e0b45c",
  writer: "#9fcf8f", critic: "#e08a7f", reviser: "#e2a0c4", orchestrator: "#9aa3ad",
  evaluator: "#e3c582", librarian: "#c9b48a",
};

export function VaultMark({ size = 34, className = "" }) {
  return (
    <svg className={`vault-mark ${className}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="20" cy="20" r="14.5" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth="1" />
      <g className="dial">
        {Array.from({ length: 24 }, (_, i) => (
          <line key={i} x1="20" y1="3.6" x2="20" y2={i % 6 === 0 ? 7.4 : 5.6} stroke="currentColor"
                strokeWidth={i % 6 === 0 ? 1.6 : 0.9} transform={`rotate(${i * 15} 20 20)`} />
        ))}
        <circle cx="20" cy="20" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M20 13.5v-4M20 26.5v4M13.5 20h-4M26.5 20h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="20" cy="20" r="2" fill="currentColor" />
      </g>
    </svg>
  );
}

const ICONS = {
  plus: "M12 5v14M5 12h14",
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20",
  gauge: "M12 14l4-4M3.5 17a9 9 0 1 1 17 0",
  key: "M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z",
  door: "M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17M3 21h18M15 12h.01",
  lamp: "M9 21h6M12 17v4M7 3h10l2 8H5zM12 11v6",
  sparkle: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
};

export function Icon({ name, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Wallet({ me, flash }) {
  const ref = useRef();
  useEffect(() => {
    if (!flash || !ref.current) return;
    ref.current.classList.remove("flash");
    void ref.current.offsetWidth;
    ref.current.classList.add("flash");
  }, [flash]);
  if (!me) return null;
  const left = me.tokens_left ?? 0;
  const cap = me.token_limit;
  const share = cap ? Math.max(0, Math.min(1, left / Math.max(cap, 1))) : 1;
  const low = cap ? share < 0.12 : left < 20000;
  return (
    <div className="wallet" ref={ref} title="Tokens are charged for every model call your research makes">
      <div className="wallet-top">
        <span className="eyebrow">{me.role === "admin" ? "Unallocated pool" : "Tokens left"}</span>
        <span className="pill" style={{ visibility: me.role === "guest" ? "visible" : "hidden" }}>guest</span>
      </div>
      <div className={`wallet-num num ${low ? "low" : ""}`}>{fmt(left)}</div>
      <div className={`meter ${low ? "low" : ""}`}><div style={{ width: `${share * 100}%` }} /></div>
      <div className="wallet-foot">
        <span>{fmt(me.tokens_used)} used</span>
        <span>{cap != null ? `of ${kfmt(cap)}` : "no personal cap"}</span>
      </div>
    </div>
  );
}

export function Gauge({ value, size = 160, label = "overall" }) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value || 0));
  const color = v >= 75 ? "var(--good)" : v >= 55 ? "var(--ok)" : "var(--bad)";
  return (
    <div className="gauge" style={{ width: size, height: size }} role="img" aria-label={`${label} ${v} out of 100`}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-3)" strokeWidth="9" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
                strokeDasharray={`${(v / 100) * c} ${c}`} style={{ transition: "stroke-dasharray .8s ease" }} />
      </svg>
      <div className="gauge-num"><div><b>{v}</b><span>{label}</span></div></div>
    </div>
  );
}

export const level = (v, good = 0.8, ok = 0.6, invert = false) => {
  if (v == null) return "";
  const x = invert ? 1 - v : v;
  return x >= good ? "good" : x >= ok ? "ok" : "bad";
};

export function Metric({ label, value, help, invert = false, format = pct, scale = 1 }) {
  const lv = level(value == null ? null : value / scale, 0.8, 0.6, invert);
  return (
    <div className="metric" title={help}>
      <div className="label"><span>{label}</span></div>
      <div className={`value lvl-${lv}`}>{value == null ? "—" : format(value)}</div>
      <div className="mini"><div className={`bg-${lv}`} style={{ width: `${value == null ? 0 : Math.min(100, (value / scale) * 100)}%` }} /></div>
      {help && <div className="help">{help}</div>}
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(t);
  }, [toast]);
  const node = toast ? <div className={`toast ${toast.bad ? "bad" : ""}`} role="status">{toast.text}</div> : null;
  return [node, (text, bad = false) => setToast({ text, bad })];
}

export function Empty({ text, running, children }) {
  return <div className="empty muted">{running && <span className="spinner" />}{text}{children}</div>;
}
