async function req(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  health: () => req("/api/health"),
  runs: () => req("/api/runs"),
  run: (id) => req(`/api/runs/${id}`),
  create: (form) => req("/api/runs", { method: "POST", body: form }),
  resume: (id) => req(`/api/runs/${id}/resume`, { method: "POST" }),
  cancel: (id) => req(`/api/runs/${id}/cancel`, { method: "POST" }),
  remove: (id) => req(`/api/runs/${id}`, { method: "DELETE" }),
  events: (id, after = 0) => new EventSource(`/api/runs/${id}/events?after=${after}`),
};
