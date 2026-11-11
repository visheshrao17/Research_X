"""LangChain model layer over free APIs (Groq, Gemini, OpenRouter, Ollama).

Each agent role maps to a fallback chain of "provider:model" specs, built as
`primary.with_fallbacks([...])`. Every model retries rate limits itself (max_retries) and is
paced by a per-provider InMemoryRateLimiter, so a free-tier 429 on one provider just falls
through to the next model instead of stopping the run.
"""
import json
import logging
import re
from dataclasses import dataclass
from functools import lru_cache

from langchain_core.embeddings import Embeddings
from langchain_core.language_models import BaseChatModel
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.rate_limiters import InMemoryRateLimiter
from langchain_core.runnables import Runnable

from . import config

log = logging.getLogger("researchx.llm")

# Requests/second per provider, conservative for free-tier RPM limits.
_RATES = {"groq": 0.45, "gemini": 0.2, "openrouter": 0.3, "ollama": 10.0}
_limiters = {p: InMemoryRateLimiter(requests_per_second=r, check_every_n_seconds=0.1, max_bucket_size=1)
             for p, r in _RATES.items()}


class LLMError(Exception):
    pass


@dataclass
class LLMResult:
    text: str
    model: str


def provider_available(provider: str) -> bool:
    return {
        "groq": bool(config.GROQ_API_KEY),
        "gemini": bool(config.GEMINI_API_KEY),
        "openrouter": bool(config.OPENROUTER_API_KEY),
        "ollama": bool(config.OLLAMA_BASE_URL),
    }.get(provider, False)


def chain_for(role: str) -> list[tuple[str, str]]:
    specs = [s.strip() for s in config.ROLE_MODELS.get(role, config.ROLE_MODELS["planner"]).split(",") if s.strip()]
    out = []
    for spec in specs:
        provider, _, model = spec.partition(":")
        if model and provider_available(provider):
            out.append((provider, model))
    return out


def available_models() -> dict:
    return {role: [f"{p}:{m}" for p, m in chain_for(role)] for role in config.ROLE_MODELS}


def _make_model(provider: str, model: str, temperature: float, max_tokens: int, json_mode: bool) -> Runnable:
    common = {"temperature": temperature, "max_retries": 2, "rate_limiter": _limiters[provider]}
    if provider == "groq":
        from langchain_groq import ChatGroq
        llm: BaseChatModel = ChatGroq(model=model, api_key=config.GROQ_API_KEY, max_tokens=max_tokens,
                                      timeout=120, **common)
    elif provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(
            model=model, google_api_key=config.GEMINI_API_KEY, max_output_tokens=max_tokens, timeout=180,
            response_mime_type="application/json" if json_mode else None, **common,
        )
    else:  # OpenAI-compatible: OpenRouter / Ollama
        from langchain_openai import ChatOpenAI
        base = "https://openrouter.ai/api/v1" if provider == "openrouter" else config.OLLAMA_BASE_URL.rstrip("/") + "/v1"
        key = config.OPENROUTER_API_KEY if provider == "openrouter" else "ollama"
        llm = ChatOpenAI(model=model, base_url=base, api_key=key, max_tokens=max_tokens, timeout=180,
                         default_headers={"HTTP-Referer": "http://localhost", "X-Title": "ResearchX"}, **common)
    return llm.bind(response_format={"type": "json_object"}) if json_mode else llm


@lru_cache(maxsize=64)
def model_for(role: str, temperature: float = 0.3, max_tokens: int = 4096, json_mode: bool = False) -> Runnable:
    chain = chain_for(role)
    if not chain:
        raise LLMError("No LLM provider configured. Set GROQ_API_KEY and/or GEMINI_API_KEY in backend/.env")
    models = [_make_model(p, m, temperature, max_tokens, json_mode) for p, m in chain]
    return models[0].with_fallbacks(models[1:]) if len(models) > 1 else models[0]


async def chat(role: str, prompt: ChatPromptTemplate | list[dict], variables: dict | None = None, *,
               temperature: float = 0.3, max_tokens: int = 4096, json_mode: bool = False) -> LLMResult:
    """Run a prompt template (with variables) or a raw message list through the role's model chain."""
    model = model_for(role, temperature, max_tokens, json_mode)
    runnable = prompt | model if isinstance(prompt, ChatPromptTemplate) else model
    try:
        msg = await runnable.ainvoke(variables if isinstance(prompt, ChatPromptTemplate) else prompt)
    except Exception as e:  # noqa: BLE001 — the whole fallback chain failed
        raise LLMError(f"All models failed for role '{role}': {e}") from e
    text = msg.text
    if not text.strip():
        raise LLMError(f"Empty response for role '{role}'")
    meta = msg.response_metadata or {}
    name = meta.get("model_name") or meta.get("model") or "unknown"
    return LLMResult(text=text, model=name)


def parse_json(text: str) -> dict | list:
    """Robustly pull a JSON object/array out of an LLM response."""
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for open_c, close_c in (("{", "}"), ("[", "]")):
        start, end = text.find(open_c), text.rfind(close_c)
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                continue
    raise LLMError(f"Could not parse JSON from model output: {text[:300]}")


async def chat_json(role: str, prompt: ChatPromptTemplate | list[dict], variables: dict | None = None,
                    **kw) -> tuple[dict | list, str]:
    """chat() in JSON mode + parsing, with one repair round-trip if the model emits invalid JSON."""
    res = await chat(role, prompt, variables, json_mode=True, **kw)
    try:
        return parse_json(res.text), res.model
    except LLMError:
        messages = (prompt.format_messages(**variables) if isinstance(prompt, ChatPromptTemplate) else list(prompt))
        messages = [m if isinstance(m, dict) else {"role": {"human": "user", "ai": "assistant"}.get(m.type, m.type), "content": m.text}
                    for m in messages]
        messages += [{"role": "assistant", "content": res.text},
                     {"role": "user", "content": "That was not valid JSON. Reply with ONLY the corrected JSON object."}]
        res = await chat(role, messages, json_mode=True, **kw)
        return parse_json(res.text), res.model


# ---------------- embeddings ----------------
@lru_cache(maxsize=1)
def embedder() -> Embeddings | None:
    """Gemini embeddings (free tier) via LangChain, or None so callers fall back to local vectors."""
    if not config.GEMINI_API_KEY:
        return None
    from langchain_google_genai import GoogleGenerativeAIEmbeddings
    return GoogleGenerativeAIEmbeddings(model=f"models/{config.EMBEDDING_MODEL}",
                                        google_api_key=config.GEMINI_API_KEY, output_dimensionality=768)


async def embed(texts: list[str], task: str = "RETRIEVAL_DOCUMENT") -> list[list[float]] | None:
    emb = embedder()
    if emb is None or not texts:
        return None
    try:
        if task == "RETRIEVAL_QUERY":
            return [await emb.aembed_query(texts[0], task_type=task)]
        return await emb.aembed_documents([t[:8000] for t in texts], batch_size=90, task_type=task)
    except Exception as e:  # noqa: BLE001
        log.warning("Embedding failed, falling back to local vectors: %s", e)
        return None
