<div align="center">

# 🔬 ResearchX

**A local, full-stack autonomous research platform powered by LangChain + LangGraph.**  
Runs entirely on **free LLM APIs** — plans, searches, retrieves, analyzes, writes, critiques, and revises until the report passes peer review.

[![Frontend Build](https://github.com/visheshrao17/Research_X/actions/workflows/frontend-build.yml/badge.svg)](https://github.com/visheshrao17/Research_X/actions/workflows/frontend-build.yml)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-research--agent--tau--red.vercel.app-black?logo=vercel)](https://research-agent-tau-red.vercel.app/)
![LangGraph](https://img.shields.io/badge/LangGraph-StateGraph-blue?logo=python)
![React](https://img.shields.io/badge/Frontend-React%2018%20%2B%20Vite-61DAFB?logo=react)
![FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688?logo=fastapi)
![License](https://img.shields.io/badge/License-MIT-green)

</div>

---

## 🌐 Live Demo

> **[research-agent-tau-red.vercel.app](https://research-agent-tau-red.vercel.app/)**

---

## ✨ What it does

You ask a research question. ResearchX does the rest — autonomously.

```
              ┌──────────┐   ┌────────────┐   ┌──────────┐   ┌────────┐
 question ──► │ Planner  │──►│ Researcher │──►│ Analyst  │──►│ Writer │
              └──────────┘   └────────────┘   └──────────┘   └────────┘
                                  │ Hybrid RAG                    │
                                  │ (BM25 + dense + RRF)          ▼
                                                            ┌──────────┐  pass  ┌──────────┐
                                                            │  Critic  │───────►│ Finalize │
                                                            └──────────┘        └──────────┘
                                                               │   ▲
                                                        revise │   │ re-score
                                                               ▼   │
                                                    ┌──────────────┐  ┌─────────┐
                                                    │ Gap research │─►│ Reviser │
                                                    └──────────────┘  └─────────┘
```

| Agent | What it does |
|---|---|
| **I · Planner** | Breaks your question into focused sub-questions and search queries |
| **II · Researcher** | Searches the web, reads pages & PDFs, indexes every source |
| **III · Retriever** | Hybrid RAG: BM25 + dense cosine fused with Reciprocal Rank Fusion |
| **IV · Analyst** | Writes & runs pandas/matplotlib code on your datasets; self-repairs on failure |
| **V · Writer** | Drafts a cited report — every claim carries a numbered citation |
| **VI · Critic** | A *different model family* peer-reviews the draft and audits every citation |
| **VII · Reviser** | Fills gaps the critic found, researches more, rewrites until it passes |
| **VIII · Evaluator** | Grades the run: faithfulness, context precision, relevance, agent cost |

---

## 🚀 Quick start

```bash
# 1. Clone
git clone https://github.com/visheshrao17/Research_X.git
cd Research_X

# 2. First run — creates venv, installs all deps, copies backend/.env
./start.sh

# 3. Add at least one free API key to backend/.env, then re-run
./start.sh

# 4. Open in browser
open http://localhost:5173
```

> **Free keys** — grab at least one:
> - 🟣 **Groq** → https://console.groq.com/keys
> - 🔵 **Gemini** → https://aistudio.google.com/apikey
> - ⚪ **OpenRouter** (optional, `:free` models) → https://openrouter.ai/keys
> - 🟡 **Tavily** search (optional) → https://tavily.com

### Single-process production mode

```bash
cd frontend && npm run build
cd ../backend && .venv/bin/uvicorn app.main:app
# UI + API together at http://localhost:8000
```

---

## 🖥️ UI pages

| Page | Description |
|---|---|
| **Landing** | Sign-in / sign-up with configurable auth modes (reader, writer, admin) |
| **Home** | List of all research runs; create, resume, or cancel |
| **Run View** | Live agent log over SSE, pipeline graph, the final report with clickable citations, review scores, citation audit, source list, analysis charts |
| **Evals** | Aggregate evaluation dashboard — faithfulness, nDCG, MRR, hallucination rate, coverage |
| **Account** | Personal token usage, credit balance, and profile settings |
| **Admin** | User management, credit pool, usage overview (admin role only) |

---

## ⚙️ How it works

### Orchestration
LangGraph `StateGraph` with a cyclic **critique → revise** loop, conditional routing, and an `AsyncSqliteSaver` checkpointer (`data/checkpoints.db`).  
Crashed, cancelled, or server-restarted runs **resume from the exact node** they stopped at.

### Multiple LLMs with fallbacks
Each role has a chain built with `.with_fallbacks()` — providers without a key are **skipped automatically**.  
Per-provider `InMemoryRateLimiter` keeps you inside free-tier limits.  
The critic always uses a **different model family** from the writer for a genuinely independent review.

### Web search
Tavily if a key is set, otherwise the `ddgs` metasearch:  
`DuckDuckGo → Bing → Brave → Mojeek → Yahoo → Wikipedia`  
Pages extracted with **trafilatura**; PDFs with **pypdf**.

### Hybrid RAG
`RecursiveCharacterTextSplitter` → SQLite + Gemini embeddings (`GoogleGenerativeAIEmbeddings`).  
A custom `BaseRetriever` fuses **BM25 + dense cosine** with Reciprocal Rank Fusion and caps chunks per source for diversity.  
No Gemini key? Falls back to local hashed n-gram vectors.

### Data analysis
Upload CSV / XLSX / JSON. The analyst writes pandas + matplotlib code, runs it in a subprocess with a timeout, and feeds its own traceback back for self-repair (up to 3 attempts). Charts are embedded in the report.

### Self-critique & auto-revision
The critic scores on five axes: **accuracy · evidence support · completeness · balance · clarity**.  
A deterministic **citation audit** runs alongside it — flagging missing, broken, or weakly-supported citations.  
If the draft fails, the reviser researches the gaps and rewrites. The loop runs until a draft passes `PASS_SCORE` or the revision budget runs out; the **best-scoring draft** is kept.

---

## 🔐 Configuration (`backend/.env`)

Copy `backend/.env.example` → `backend/.env` and fill in your keys.

```env
# ── Free LLM providers (set at least one) ───────────────
GROQ_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_BASE_URL=          # optional, fully local

# ── Optional search provider ─────────────────────────────
TAVILY_API_KEY=           # falls back to ddgs metasearch

# ── Role → model routing (comma-separated fallback chain) ─
MODEL_PLANNER=groq:llama-3.3-70b-versatile,gemini:gemini-2.5-flash,...
MODEL_FAST=groq:llama-3.1-8b-instant,...
MODEL_WRITER=gemini:gemini-2.5-flash,groq:llama-3.3-70b-versatile,...
MODEL_CRITIC=groq:openai/gpt-oss-120b,groq:llama-3.3-70b-versatile,...
MODEL_ANALYST=groq:llama-3.3-70b-versatile,gemini:gemini-2.5-flash
EMBEDDING_MODEL=gemini-embedding-001

# ── Orchestration ─────────────────────────────────────────
MAX_REVISIONS=2
PASS_SCORE=8.0
SEARCH_RESULTS_PER_QUERY=5
MAX_SOURCES=18

# ── Deployment (leave blank for local dev) ───────────────
FRONTEND_ORIGIN=          # e.g. https://your-app.vercel.app
```

---

## 📁 Project layout

```
Research_X/
├── start.sh                  # One-command launcher (venv + deps + both servers)
│
├── backend/
│   ├── .env.example          # Template — copy to .env and fill in keys
│   ├── requirements.txt
│   └── app/
│       ├── main.py           # FastAPI: runs CRUD, resume/cancel, SSE stream, file serving
│       ├── orchestrator.py   # LangGraph StateGraph + SQLite checkpointer
│       ├── agents.py         # planner, researcher, analyst, writer, critic, reviser, finalize
│       ├── llm.py            # LangChain chains with fallbacks + rate limiting + JSON repair
│       ├── rag.py            # Text splitting, BM25, dense vectors, RRF, HybridRetriever
│       ├── search.py         # Web search + page/PDF extraction
│       ├── analysis.py       # Dataset profiling + LLM code execution
│       ├── config.py         # Settings from env
│       └── db.py             # SQLite: runs, events, chunks
│
├── frontend/
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── main.jsx          # React entry point
│       ├── App.jsx           # Router, auth state, global layout
│       ├── Landing.jsx       # Sign-in / sign-up page
│       ├── Composer.jsx      # New-run form (question, files, model config)
│       ├── RunView.jsx       # Live run page (SSE log, report, review, sources)
│       ├── Evals.jsx         # Aggregate evaluation dashboard
│       ├── Account.jsx       # User profile, tokens, credits
│       ├── Admin.jsx         # Admin panel: users, credit pool, usage
│       ├── api.js            # Typed API client
│       ├── ui.jsx            # Shared UI primitives (Icon, Toast, Metric, …)
│       └── styles.css        # Dark-themed design system
│
└── .github/
    └── workflows/
        └── frontend-build.yml  # CI: verifies the React/Vite build on every push
```

---

## 🔄 CI — Frontend build check

Every push or pull request to `main` / `dev` that touches `frontend/` automatically triggers the **Frontend Build** workflow.

| Step | Action |
|---|---|
| ⬇️ Checkout | Clones the repository |
| 🟢 Node 20 | Sets up Node.js with npm cache |
| 📦 Install | `npm install` |
| 🔨 Build | `npm run build` (Vite) |
| ✅ Verify | Asserts `dist/` is non-empty |
| 📤 Artifact | Uploads `dist/` for 7 days |

[![Frontend Build](https://github.com/visheshrao17/Research_X/actions/workflows/frontend-build.yml/badge.svg)](https://github.com/visheshrao17/Research_X/actions/workflows/frontend-build.yml)

---

## 🛡️ Security note

> ⚠️ The analysis step runs **LLM-generated Python** on your machine. A simple filter blocks obvious dangerous calls, but this is **not** a security sandbox. Only use it locally with data you trust.

---

## 🤝 Contributing

Pull requests are welcome. For major changes please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m "feat: add my feature"`
4. Push and open a PR against `main`

---

<div align="center">

Made with ☕ and free API credits.

</div>
