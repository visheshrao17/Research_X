import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
DB_PATH = DATA_DIR / "researchx.db"
for d in (DATA_DIR, UPLOAD_DIR, OUTPUT_DIR):
    d.mkdir(parents=True, exist_ok=True)


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


FRONTEND_ORIGIN = env("FRONTEND_ORIGIN")   # e.g. https://your-app.vercel.app

GROQ_API_KEY = env("GROQ_API_KEY")
GEMINI_API_KEY = env("GEMINI_API_KEY")
OPENROUTER_API_KEY = env("OPENROUTER_API_KEY")
OLLAMA_BASE_URL = env("OLLAMA_BASE_URL")
TAVILY_API_KEY = env("TAVILY_API_KEY")

ROLE_MODELS = {
    "planner": env("MODEL_PLANNER", "groq:llama-3.3-70b-versatile,gemini:gemini-2.5-flash"),
    "fast": env("MODEL_FAST", "groq:llama-3.1-8b-instant,gemini:gemini-2.5-flash-lite"),
    "writer": env("MODEL_WRITER", "gemini:gemini-2.5-flash,groq:llama-3.3-70b-versatile"),
    "critic": env("MODEL_CRITIC", "groq:openai/gpt-oss-120b,groq:llama-3.3-70b-versatile,gemini:gemini-2.5-flash"),
    "analyst": env("MODEL_ANALYST", "groq:llama-3.3-70b-versatile,gemini:gemini-2.5-flash"),
}
EMBEDDING_MODEL = env("EMBEDDING_MODEL", "gemini-embedding-001")

MAX_REVISIONS = int(env("MAX_REVISIONS", "2"))
PASS_SCORE = float(env("PASS_SCORE", "8.0"))
SEARCH_RESULTS_PER_QUERY = int(env("SEARCH_RESULTS_PER_QUERY", "5"))
MAX_SOURCES = int(env("MAX_SOURCES", "18"))
