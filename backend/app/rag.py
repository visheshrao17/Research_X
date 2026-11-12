"""Hybrid RAG exposed as a LangChain retriever: BM25 (sparse) + embeddings (dense), fused with Reciprocal Rank Fusion.

Chunks come from RecursiveCharacterTextSplitter; dense vectors from Gemini's free embedding API
(GoogleGenerativeAIEmbeddings). Chunks + vectors persist in SQLite. Without a Gemini key we fall back to a
local hashed n-gram vectorizer so retrieval still works with zero extra keys.
"""
import math
import re
from collections import Counter

import numpy as np
from langchain_core.callbacks import AsyncCallbackManagerForRetrieverRun, CallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from langchain_text_splitters import RecursiveCharacterTextSplitter

from . import db, llm

_TOKEN = re.compile(r"[a-z0-9]+(?:[.'-][a-z0-9]+)*")
_STOP = set(
    "a an and are as at be by for from has have in is it its of on or that the to was were will with "
    "this these those not but which who what when where how why can could would should into than then "
    "there their they them we you your our i he she his her also may more most such other over".split()
)
HASH_DIM = 2048


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN.findall(text.lower()) if t not in _STOP and len(t) > 1]


_splitter = RecursiveCharacterTextSplitter(chunk_size=900, chunk_overlap=150,
                                           separators=["\n\n", "\n", ". ", " ", ""])


def chunk_text(text: str) -> list[str]:
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return [c for c in _splitter.split_text(text) if len(c) > 80]


def hashed_vector(text: str) -> np.ndarray:
    toks = tokenize(text)
    feats = toks + [f"{a}_{b}" for a, b in zip(toks, toks[1:])]
    vec = np.zeros(HASH_DIM, dtype=np.float32)
    for f, c in Counter(feats).items():
        vec[hash(f) % HASH_DIM] += 1 + math.log(c)
    n = np.linalg.norm(vec)
    return vec / n if n else vec


class BM25:
    def __init__(self, docs: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.docs, self.k1, self.b = docs, k1, b
        self.avgdl = sum(map(len, docs)) / max(len(docs), 1)
        df = Counter(t for d in docs for t in set(d))
        n = len(docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}
        self.tfs = [Counter(d) for d in docs]

    def scores(self, query: list[str]) -> np.ndarray:
        out = np.zeros(len(self.docs), dtype=np.float32)
        for i, (tf, d) in enumerate(zip(self.tfs, self.docs)):
            norm = self.k1 * (1 - self.b + self.b * len(d) / (self.avgdl or 1))
            s = 0.0
            for q in query:
                if q in tf:
                    f = tf[q]
                    s += self.idf[q] * f * (self.k1 + 1) / (f + norm)
            out[i] = s
        return out


class RunIndex:
    """In-memory index over all chunks belonging to one research run."""

    def __init__(self, run_id: str):
        rows = db.get_chunks(run_id)
        self.ids = [r["id"] for r in rows]
        self.source_ids = [r["source_id"] for r in rows]
        self.texts = [r["text"] for r in rows]
        self.bm25 = BM25([tokenize(t) for t in self.texts])
        self.local = np.stack([hashed_vector(t) for t in self.texts]) if self.texts else np.zeros((0, HASH_DIM))
        embs = [np.frombuffer(r["embedding"], dtype=np.float32) if r["embedding"] else None for r in rows]
        self.has_dense = [e is not None for e in embs]
        dim = next((len(e) for e in embs if e is not None), 0)
        self.dense = np.stack([e if e is not None else np.zeros(dim, np.float32) for e in embs]) if dim else None

    async def search(self, query: str, k: int = 8, per_source: int = 3) -> list[dict]:
        if not self.texts:
            return []
        rankings = []
        bm = self.bm25.scores(tokenize(query))
        rankings.append([i for i in np.argsort(-bm) if bm[i] > 0])

        if self.dense is not None and any(self.has_dense):
            qv = await llm.embed([query], task="RETRIEVAL_QUERY")
            if qv:
                q = np.asarray(qv[0], dtype=np.float32)
                sims = self.dense @ q / (np.linalg.norm(self.dense, axis=1) * np.linalg.norm(q) + 1e-9)
                rankings.append([i for i in np.argsort(-sims) if self.has_dense[i]])
        if len(rankings) == 1:  # no remote embeddings -> local dense fallback
            sims = self.local @ hashed_vector(query)
            rankings.append(list(np.argsort(-sims)))

        # Reciprocal Rank Fusion
        fused: dict[int, float] = {}
        for ranking in rankings:
            for rank, idx in enumerate(ranking[:100]):
                fused[idx] = fused.get(idx, 0.0) + 1.0 / (60 + rank)
        ordered = sorted(fused, key=fused.get, reverse=True)

        results, per = [], Counter()
        for idx in ordered:  # cap chunks per source for diversity
            sid = self.source_ids[idx]
            if per[sid] >= per_source:
                continue
            per[sid] += 1
            results.append({"chunk_id": self.ids[idx], "source_id": sid, "text": self.texts[idx],
                            "score": round(fused[idx], 5)})
            if len(results) >= k:
                break
        return results


_cache: dict[str, RunIndex] = {}


async def index_document(run_id: str, source_id: int, text: str) -> int:
    chunks = chunk_text(text)[:40]
    if not chunks:
        return 0
    vecs = await llm.embed(chunks)
    items = [
        (source_id, c, np.asarray(vecs[i], dtype=np.float32).tobytes() if vecs else None)
        for i, c in enumerate(chunks)
    ]
    db.add_chunks(run_id, items)
    _cache.pop(run_id, None)
    return len(chunks)


def get_index(run_id: str) -> RunIndex:
    if run_id not in _cache:
        _cache[run_id] = RunIndex(run_id)
    return _cache[run_id]


class HybridRetriever(BaseRetriever):
    """LangChain retriever over a run's corpus: BM25 + dense embeddings fused with RRF."""

    run_id: str
    k: int = 8
    per_source: int = 3

    async def _aget_relevant_documents(self, query: str, *,
                                       run_manager: AsyncCallbackManagerForRetrieverRun) -> list[Document]:
        hits = await get_index(self.run_id).search(query, k=self.k, per_source=self.per_source)
        return [Document(page_content=h["text"], metadata={k: v for k, v in h.items() if k != "text"}) for h in hits]

    def _get_relevant_documents(self, query: str, *, run_manager: CallbackManagerForRetrieverRun) -> list[Document]:
        raise NotImplementedError("HybridRetriever is async-only; use ainvoke()")
