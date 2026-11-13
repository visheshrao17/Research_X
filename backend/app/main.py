import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, llm, orchestrator
from .config import OUTPUT_DIR, UPLOAD_DIR

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

DATASET_EXT = {".csv", ".tsv", ".xlsx", ".xls", ".json"}
DOCUMENT_EXT = {".pdf", ".txt", ".md"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    orchestrator.mark_interrupted()
    await orchestrator.init()
    yield
    await orchestrator.shutdown()


app = FastAPI(title="ResearchX", lifespan=lifespan)

# ---------------------------------------------------------------------------
# CORS — allow the frontend origin configured via FRONTEND_ORIGIN env var.
# In local dev the Vite proxy handles requests so CORS isn't needed, but once
# the frontend is hosted separately (e.g. Vercel / Netlify / S3) set:
#   FRONTEND_ORIGIN=https://your-frontend.example.com
# ---------------------------------------------------------------------------
_origins = [o.strip() for o in config.FRONTEND_ORIGIN.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],   # "*" only when no origin configured
    allow_credentials=bool(_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "models": llm.available_models(),
            "search": "tavily" if config.TAVILY_API_KEY else "ddgs + wikipedia",
            "embeddings": config.EMBEDDING_MODEL if config.GEMINI_API_KEY else "local-hashed"}


@app.post("/api/runs")
async def create_run(
    question: str = Form(...),
    depth: str = Form("standard"),
    max_revisions: int = Form(config.MAX_REVISIONS),
    files: list[UploadFile] = File(default=[]),
):
    question = question.strip()
    if len(question) < 5:
        raise HTTPException(400, "Question is too short")
    if depth not in ("quick", "standard", "deep"):
        raise HTTPException(400, "depth must be quick|standard|deep")
    if not any(llm.chain_for(r) for r in config.ROLE_MODELS):
        raise HTTPException(400, "No LLM provider configured. Add GROQ_API_KEY / GEMINI_API_KEY to backend/.env")

    documents, datasets = [], []
    batch_dir = UPLOAD_DIR / uuid.uuid4().hex[:12]
    for f in files:
        if not f.filename:
            continue
        ext = Path(f.filename).suffix.lower()
        if ext not in DATASET_EXT | DOCUMENT_EXT:
            raise HTTPException(400, f"Unsupported file type: {f.filename}")
        batch_dir.mkdir(parents=True, exist_ok=True)
        dest = batch_dir / Path(f.filename).name
        dest.write_bytes(await f.read())
        (datasets if ext in DATASET_EXT else documents).append({"name": dest.name, "path": str(dest)})

    state = orchestrator.new_state(question, depth, max(0, min(max_revisions, 4)), documents, datasets)
    run_id = db.create_run(question, state)
    orchestrator.start(run_id)
    return {"id": run_id}


@app.get("/api/runs")
def list_runs():
    return db.list_runs()


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    rec = db.get_run(run_id)
    if not rec:
        raise HTTPException(404, "Run not found")
    rec["active"] = orchestrator.is_active(run_id)
    return rec


@app.post("/api/runs/{run_id}/resume")
def resume_run(run_id: str):
    rec = db.get_run(run_id)
    if not rec:
        raise HTTPException(404, "Run not found")
    if rec["status"] == "completed" or orchestrator.is_active(run_id):
        raise HTTPException(400, f"Run is {rec['status']}")
    db.add_event(run_id, "resumed", "orchestrator", f"Resuming from '{rec['state']['next_node']}'")
    orchestrator.start(run_id)
    return {"ok": True}


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: str):
    return {"ok": orchestrator.cancel(run_id)}


@app.delete("/api/runs/{run_id}")
async def delete_run(run_id: str):
    await orchestrator.forget(run_id)
    db.delete_run(run_id)
    return {"ok": True}


@app.get("/api/runs/{run_id}/events")
async def stream_events(run_id: str, after: int = 0):
    if not db.get_run(run_id):
        raise HTTPException(404, "Run not found")

    async def gen():
        last = after
        idle = 0
        while True:
            events = db.get_events(run_id, last)
            for ev in events:
                last = ev["id"]
                yield f"id: {ev['id']}\ndata: {json.dumps(ev)}\n\n"
            if events:
                idle = 0
            else:
                idle += 1
                if idle % 20 == 0:
                    yield ": keepalive\n\n"
                if not orchestrator.is_active(run_id) and idle > 3:
                    yield "event: end\ndata: {}\n\n"
                    return
            await asyncio.sleep(0.6)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/runs/{run_id}/files/{name}")
def run_file(run_id: str, name: str):
    path = (OUTPUT_DIR / run_id / name).resolve()
    if not path.is_relative_to(OUTPUT_DIR.resolve()) or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


# Serve the built frontend (npm run build) when present, so one process runs everything.
_dist = config.BASE_DIR.parent / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
