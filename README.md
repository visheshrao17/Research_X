# ResearchX

A local, full-stack autonomous research platform built on **LangChain + LangGraph**. It runs entirely on
**free LLM APIs** (Groq, Gemini, OpenRouter `:free` models, or local Ollama). It plans a research question,
searches the web, builds a hybrid RAG index, analyzes your datasets, writes a cited report, critiques
that report, and revises it until it passes review.

```
           ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌────────┐   ┌──────────┐  pass   ┌──────────┐
question → │ Planner  │ → │ Researcher│ → │ Analyst  │ → │ Writer │ → │  Critic  │ ──────→ │ Finalize │
           └──────────┘   └───────────┘   └──────────┘   └────────┘   └──────────┘         └──────────┘
                                                          (if data)      │    ▲
                                                                  revise │    │ re-score
                                                                         ▼    │
                                                              ┌──────────────┐ ┌─────────┐
                                                              │ Gap research │→│ Reviser │
                                                              └──────────────┘ └─────────┘
```

## Quick start

```bash
./start.sh            # first run creates venv, installs deps, copies backend/.env
# add at least one key to backend/.env, then re-run ./start.sh
open http://localhost:5173
```

Free keys: **Groq** → https://console.groq.com/keys · **Gemini** → https://aistudio.google.com/apikey ·
(optional) **OpenRouter** → https://openrouter.ai/keys · (optional) **Tavily** search → https://tavily.com

Single-process mode: `cd frontend && npm run build`, then `cd backend && .venv/bin/uvicorn app.main:app`
serves the UI and the API together at http://localhost:8000.

## How it works

| Piece | Implementation |
|---|---|
| **Orchestration** | LangGraph `StateGraph` with a cyclic critique→revise loop, conditional routing, and an `AsyncSqliteSaver` checkpointer (`data/checkpoints.db`). Crashed, cancelled or server-restarted runs **resume from the exact node** they stopped at. |
| **Multiple LLMs** | Each role (planner / writer / critic / analyst / fast) has a fallback chain built with `ChatGroq`, `ChatGoogleGenerativeAI` or `ChatOpenAI` (OpenRouter/Ollama) `.with_fallbacks()`. Each model has `max_retries` and a per-provider `InMemoryRateLimiter` so it stays within free-tier limits. By default the critic is a **different model family** from the writer, for an independent review. |
| **Web search** | Tavily (if a key is set), otherwise the `ddgs` metasearch, which tries DuckDuckGo → Bing → Brave → Mojeek → Yahoo, then Wikipedia. Pages are extracted with trafilatura; PDFs with pypdf. |
| **Hybrid RAG** | `RecursiveCharacterTextSplitter` chunks → stored in SQLite with Gemini embeddings (`GoogleGenerativeAIEmbeddings`). A custom LangChain `BaseRetriever` fuses **BM25 + dense cosine** rankings with Reciprocal Rank Fusion and caps chunks per source for diversity. Without a Gemini key it falls back to local hashed n-gram vectors. |
| **Data analysis** | Upload CSV/XLSX/JSON. The analyst LLM writes pandas/matplotlib code, which runs in a subprocess with a timeout. If the code fails, the traceback goes back to the model to repair it (up to 3 attempts). The charts are embedded in the report. |
| **Self-critique** | The critic scores accuracy, evidence support, completeness, balance and clarity, and lists issues with fixes. A deterministic **citation audit** runs alongside it: it flags citations that point to sources that don't exist (these cost points), paragraphs with no citation, and sentences that share few words with the source they cite. |
| **Auto-revision** | If a draft fails review, the critic's follow-up queries trigger more research. The reviser then rewrites the draft against the new evidence, and the critic scores it again. The loop ends when a draft passes or the revision budget runs out; the **best-scoring draft** is kept. |
| **UI** | React + Vite. A live agent log over SSE, a pipeline view, the report with clickable citations, a review tab with score bars, the audit and the reviser's changes, plus sources, analysis code/output/charts, the plan and the models used. |

## Configuration (`backend/.env`)

- `MODEL_<ROLE>`: comma-separated fallback chain of `provider:model`. Providers without a key are skipped.
  Free model names change over time; update these if a provider retires a model.
- `MAX_REVISIONS`, `PASS_SCORE` (default 8.0/10), `SEARCH_RESULTS_PER_QUERY`, `MAX_SOURCES`.

## Project layout

```
backend/app/
  main.py          FastAPI: runs CRUD, resume/cancel, SSE event stream, file serving
  orchestrator.py  LangGraph StateGraph + SQLite checkpointer
  agents.py        planner, researcher, analyst, writer, critic, gap-research, reviser, finalize
  llm.py           LangChain model chains with fallbacks + rate limiting, JSON repair, embeddings
  rag.py           text splitting, BM25, dense vectors, RRF, HybridRetriever
  search.py        web search + page/PDF extraction
  analysis.py      dataset profiling + LLM-written code execution
  db.py            SQLite: runs, events, chunks
frontend/src/      React UI
```

> ⚠️ The analysis step runs LLM-generated Python on your machine. A simple filter blocks obvious dangerous
> calls, but this is **not** a security sandbox. Only use it locally with data you trust.
