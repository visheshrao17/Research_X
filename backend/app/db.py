"""SQLite persistence: runs (with full orchestrator state), event log, and RAG chunks."""
import json
import sqlite3
import threading
import time
import uuid

from .config import DB_PATH

_lock = threading.Lock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")
_conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        ts REAL NOT NULL,
        type TEXT NOT NULL,
        agent TEXT,
        message TEXT,
        data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
    CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_run ON chunks(run_id);
    """
)
_conn.commit()


def _exec(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    with _lock:
        cur = _conn.execute(sql, params)
        _conn.commit()
        return cur


def _query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return _conn.execute(sql, params).fetchall()


# ---------------- runs ----------------
def create_run(question: str, state: dict) -> str:
    run_id = uuid.uuid4().hex[:12]
    now = time.time()
    _exec(
        "INSERT INTO runs (id, question, status, created_at, updated_at, state) VALUES (?,?,?,?,?,?)",
        (run_id, question, "queued", now, now, json.dumps(state)),
    )
    return run_id


def save_run(run_id: str, status: str, state: dict) -> None:
    _exec(
        "UPDATE runs SET status=?, updated_at=?, state=? WHERE id=?",
        (status, time.time(), json.dumps(state), run_id),
    )


def get_run(run_id: str) -> dict | None:
    rows = _query("SELECT * FROM runs WHERE id=?", (run_id,))
    if not rows:
        return None
    r = rows[0]
    return {**dict(r), "state": json.loads(r["state"])}


def list_runs(limit: int = 50) -> list[dict]:
    rows = _query(
        "SELECT id, question, status, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT ?",
        (limit,),
    )
    return [dict(r) for r in rows]


def delete_run(run_id: str) -> None:
    for table, col in (("runs", "id"), ("events", "run_id"), ("chunks", "run_id")):
        _exec(f"DELETE FROM {table} WHERE {col}=?", (run_id,))


def runs_with_status(*statuses: str) -> list[str]:
    marks = ",".join("?" * len(statuses))
    return [r["id"] for r in _query(f"SELECT id FROM runs WHERE status IN ({marks})", statuses)]


# ---------------- events ----------------
def add_event(run_id: str, type_: str, agent: str | None, message: str, data: dict | None = None) -> dict:
    ts = time.time()
    cur = _exec(
        "INSERT INTO events (run_id, ts, type, agent, message, data) VALUES (?,?,?,?,?,?)",
        (run_id, ts, type_, agent, message, json.dumps(data or {})),
    )
    return {"id": cur.lastrowid, "run_id": run_id, "ts": ts, "type": type_, "agent": agent,
            "message": message, "data": data or {}}


def get_events(run_id: str, after_id: int = 0) -> list[dict]:
    rows = _query("SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id", (run_id, after_id))
    return [{**dict(r), "data": json.loads(r["data"] or "{}")} for r in rows]


# ---------------- chunks ----------------
def add_chunks(run_id: str, items: list[tuple[int, str, bytes | None]]) -> None:
    with _lock:
        _conn.executemany(
            "INSERT INTO chunks (run_id, source_id, text, embedding) VALUES (?,?,?,?)",
            [(run_id, sid, text, emb) for sid, text, emb in items],
        )
        _conn.commit()


def get_chunks(run_id: str) -> list[sqlite3.Row]:
    return _query("SELECT id, source_id, text, embedding FROM chunks WHERE run_id=? ORDER BY id", (run_id,))
