"""The agents — LangGraph nodes (wired up in orchestrator.py). Each takes the shared run state,
does one job with LangChain prompt templates / model chains / retriever, and returns the next node.

  plan -> research -> [analyze] -> write -> critique --pass--> finalize
                                              ^   |
                                              |   +--revise--> gap_research -> revise
                                              +---------------------------------+
"""
import asyncio
import datetime
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from langchain_core.prompts import ChatPromptTemplate

from . import analysis, config, llm, rag, search
from .config import OUTPUT_DIR

Emit = Callable[..., Awaitable[None]]


@dataclass
class Ctx:
    run_id: str
    emit: Emit  # emit(agent, message, data=None, type="log")


DEPTH = {
    "quick": {"subqs": 3, "queries": 1, "evidence_k": 5},
    "standard": {"subqs": 4, "queries": 2, "evidence_k": 6},
    "deep": {"subqs": 6, "queries": 2, "evidence_k": 8},
}
EVIDENCE_BUDGET = 24000  # chars of evidence sent to the writer (keeps Groq free-tier TPM happy)


def _track(state: dict, role: str, model: str) -> None:
    state.setdefault("models_used", {}).setdefault(role, [])
    if model not in state["models_used"][role]:
        state["models_used"][role].append(model)


# ======================================================================= PLANNER
PLANNER_PROMPT = ChatPromptTemplate.from_template("""You are the Planner agent of an autonomous research system.
Decompose the user's research question into {n} focused, non-overlapping sub-questions that together
fully answer it. For each, write {q} diverse web search queries (specific, keyword-rich, include years
when recency matters; today is {today}).

Datasets attached by the user: {datasets}
Documents attached by the user: {documents}

Return JSON:
{{
  "objective": "<one sentence restating what a great answer must deliver>",
  "subquestions": [{{"question": "...", "search_queries": ["...", "..."]}}],
  "needs_analysis": <true if attached datasets should be analyzed, else false>,
  "analysis_goals": ["<specific quantitative questions for the datasets>"],
  "report_outline": ["<section heading>", "..."]
}}

RESEARCH QUESTION: {question}""")


async def plan_node(ctx: Ctx, state: dict) -> str:
    d = DEPTH[state["options"]["depth"]]
    up = state["uploads"]
    variables = dict(
        n=d["subqs"], q=d["queries"], question=state["question"], today=datetime.date.today().isoformat(),
        datasets=", ".join(x["name"] for x in up["datasets"]) or "none",
        documents=", ".join(x["name"] for x in up["documents"]) or "none",
    )
    await ctx.emit("planner", "Decomposing the question into sub-questions")
    plan, model = await llm.chat_json("planner", PLANNER_PROMPT, variables, temperature=0.2)
    _track(state, "planner", model)
    plan["subquestions"] = [s for s in plan.get("subquestions", []) if s.get("question")][: d["subqs"] + 1]
    if not plan["subquestions"]:
        plan["subquestions"] = [{"question": state["question"], "search_queries": [state["question"]]}]
    state["plan"] = plan
    await ctx.emit("planner", f"Plan ready: {len(plan['subquestions'])} sub-questions ({model})",
                   {"plan": plan}, type="plan")
    return "research"


# ======================================================================= RESEARCHER
async def _ingest_urls(ctx: Ctx, state: dict, results: list[dict], agent: str) -> int:
    """Fetch, extract and index new web results. Returns number of new sources."""
    known = {s["url"] for s in state["sources"]}
    fresh, seen = [], set()
    for r in results:
        if r["url"] not in known and r["url"] not in seen:
            seen.add(r["url"])
            fresh.append(r)
    room = config.MAX_SOURCES + 6 * state["iteration"] - len(state["sources"])
    fresh = fresh[:max(room, 0)]
    if not fresh:
        return 0
    await ctx.emit(agent, f"Reading {len(fresh)} web pages")
    pages = await search.fetch_many([r["url"] for r in fresh])
    added = 0
    for r in fresh:
        text = pages.get(r["url"]) or ""
        if len(text) < 300:  # fall back to the search snippet when the page can't be read
            text = r.get("snippet", "")
            if len(text) < 80:
                continue
        sid = len(state["sources"]) + 1
        src = {"id": sid, "title": r["title"] or r["url"], "url": r["url"], "snippet": r.get("snippet", "")[:300],
               "kind": "web", "chars": len(text), "full_text": len(text) >= 300}
        state["sources"].append(src)
        n = await rag.index_document(ctx.run_id, sid, f"{src['title']}\n\n{text}")
        added += 1
        await ctx.emit(agent, f"[{sid}] {src['title'][:90]} — {n} chunks", {"source": src}, type="source")
    return added


async def _run_queries(ctx: Ctx, queries: list[str], agent: str) -> list[dict]:
    out = []
    for q in queries:  # sequential to be polite to free search endpoints
        await ctx.emit(agent, f"Searching: {q}")
        out.extend(await search.web_search(q))
        await asyncio.sleep(0.5)
    return out


async def _gather_evidence(ctx: Ctx, state: dict, questions: list[str], key_prefix: str = "") -> None:
    k = DEPTH[state["options"]["depth"]]["evidence_k"]
    retriever = rag.HybridRetriever(run_id=ctx.run_id, k=k)
    for q in questions:
        docs = await retriever.ainvoke(q)
        state["evidence"][key_prefix + q] = [{**d.metadata, "text": d.page_content} for d in docs]
    await ctx.emit("retriever", f"Hybrid retrieval (BM25 + embeddings, RRF) over {len(rag.get_index(ctx.run_id).texts)} chunks "
                                f"for {len(questions)} questions")


async def research_node(ctx: Ctx, state: dict) -> str:
    for doc in state["uploads"]["documents"]:
        if any(s["url"] == f"upload://{doc['name']}" for s in state["sources"]):
            continue
        path = Path(doc["path"])
        text = search.extract_pdf(path.read_bytes()) if path.suffix.lower() == ".pdf" else path.read_text(errors="replace")
        sid = len(state["sources"]) + 1
        src = {"id": sid, "title": doc["name"], "url": f"upload://{doc['name']}", "snippet": text[:300],
               "kind": "upload", "chars": len(text), "full_text": True}
        state["sources"].append(src)
        n = await rag.index_document(ctx.run_id, sid, text)
        await ctx.emit("researcher", f"[{sid}] Indexed uploaded document {doc['name']} — {n} chunks",
                       {"source": src}, type="source")

    queries = [q for sq in state["plan"]["subquestions"] for q in sq.get("search_queries", [])[:2]]
    results = await _run_queries(ctx, queries, "researcher")
    added = await _ingest_urls(ctx, state, results, "researcher")
    if not state["sources"]:
        raise RuntimeError("No sources could be retrieved — check your network connection or search provider.")
    await ctx.emit("researcher", f"Collected {added} web sources")
    await _gather_evidence(ctx, state, [sq["question"] for sq in state["plan"]["subquestions"]] + [state["question"]])

    if state["uploads"]["datasets"]:
        return "analyze"
    return "write"


# ======================================================================= ANALYST
async def analyze_node(ctx: Ctx, state: dict) -> str:
    plan = state["plan"]
    goals = plan.get("analysis_goals") or []
    await ctx.emit("analyst", f"Analyzing {len(state['uploads']['datasets'])} dataset(s)")

    async def emit(agent, msg, data=None):
        await ctx.emit(agent, msg, data)

    try:
        res = await analysis.run_analysis(state["question"], goals, [Path(d["path"]) for d in state["uploads"]["datasets"]],
                                          OUTPUT_DIR / ctx.run_id, emit)
        _track(state, "analyst", res.get("model", "?"))
    except Exception as e:  # noqa: BLE001 — analysis failure shouldn't kill the run
        res = {"success": False, "output": str(e), "code": "", "charts": [], "explanation": ""}
    state["analysis"] = res
    status = "succeeded" if res["success"] else "failed"
    await ctx.emit("analyst", f"Analysis {status}; {len(res['charts'])} chart(s)", {"analysis": res}, type="analysis")
    return "write"


# ======================================================================= WRITER
def format_evidence(state: dict, budget: int = EVIDENCE_BUDGET) -> str:
    """Group retrieved chunks by source, round-robin across questions until the budget is spent."""
    by_source: dict[int, list[str]] = defaultdict(list)
    seen, used = set(), 0
    lists = list(state["evidence"].values())
    for rank in range(max((len(x) for x in lists), default=0)):
        for hits in lists:
            if rank < len(hits):
                h = hits[rank]
                if h["chunk_id"] in seen:
                    continue
                if used + len(h["text"]) > budget:
                    continue
                seen.add(h["chunk_id"])
                used += len(h["text"])
                by_source[h["source_id"]].append(h["text"])
    srcs = {s["id"]: s for s in state["sources"]}
    parts = []
    for sid in sorted(by_source):
        s = srcs.get(sid, {"title": "?", "url": ""})
        body = "\n...\n".join(by_source[sid])
        parts.append(f"### SOURCE [{sid}] {s['title']} ({s['url']})\n{body}")
    return "\n\n".join(parts)


def format_analysis(state: dict) -> str:
    a = state.get("analysis")
    if not a:
        return "No dataset analysis was performed."
    charts = ", ".join(f"chart:{c}" for c in a["charts"]) or "none"
    return (f"Analysis {'succeeded' if a['success'] else 'FAILED'}.\nApproach: {a.get('explanation', '')}\n"
            f"Output:\n{a['output'][:5000]}\nCharts available (embed as ![caption](chart:<file>)): {charts}")


WRITER_PROMPT = ChatPromptTemplate.from_template("""You are the Writer agent of an autonomous research system. Write an evidence-backed
research report in Markdown answering the question below.

STRICT RULES
- Use ONLY the evidence provided. Cite every factual claim inline with source numbers like [3] or [2][5].
- Citation numbers must match the SOURCE numbers in the evidence. Never invent sources, figures, or quotes.
- When sources disagree, say so and cite both. When evidence is thin, say what is uncertain.
- If dataset analysis results are provided, include a "Data Analysis" section that reports its actual numbers
  (cite as [analysis]) and embed its charts with ![caption](chart:<file>).
- Do NOT write a references/sources list at the end — the system appends one.

STRUCTURE
# <Informative title>
**TL;DR** — 3-5 bullet key takeaways.
Then sections following this outline: {outline}
## Limitations & Open Questions

OBJECTIVE: {objective}
QUESTION: {question}

DATASET ANALYSIS:
{analysis}

EVIDENCE:
{evidence}""")


def _strip_refs(md: str) -> str:
    return re.split(r"\n#{1,3}\s*(references|sources|bibliography|works cited)\b.*", md, flags=re.I)[0].strip()


async def write_node(ctx: Ctx, state: dict) -> str:
    plan = state["plan"]
    variables = dict(
        outline=" | ".join(plan.get("report_outline", [])) or "logical sections covering each sub-question",
        objective=plan.get("objective", ""), question=state["question"],
        analysis=format_analysis(state), evidence=format_evidence(state),
    )
    await ctx.emit("writer", "Drafting the report from retrieved evidence")
    res = await llm.chat("writer", WRITER_PROMPT, variables, temperature=0.3, max_tokens=6000)
    _track(state, "writer", res.model)
    draft = {"iteration": state["iteration"], "markdown": _strip_refs(res.text), "model": res.model, "changes": []}
    state["drafts"].append(draft)
    await ctx.emit("writer", f"Draft v{state['iteration'] + 1} written by {res.model} "
                             f"({len(draft['markdown'].split())} words)", {"iteration": state["iteration"]}, type="draft")
    return "critique"


# ======================================================================= CRITIC
def citation_audit(markdown: str, state: dict) -> dict:
    """Deterministic checks: invalid citation ids, uncited paragraphs, and low-overlap (likely unsupported) citations."""
    valid = {s["id"] for s in state["sources"]}
    cited = [int(n) for n in re.findall(r"\[(\d+)\]", markdown)]
    invalid = sorted({n for n in cited if n not in valid})

    src_text: dict[int, set] = defaultdict(set)
    for hits in state["evidence"].values():
        for h in hits:
            src_text[h["source_id"]].update(rag.tokenize(h["text"]))

    paras = [p for p in markdown.split("\n\n") if len(p) > 220 and not p.lstrip().startswith(("#", "!", "|"))]
    uncited = [p[:160] for p in paras if not re.search(r"\[(\d+|analysis)\]", p)]

    weak = []
    for sent in re.split(r"(?<=[.!?])\s+", markdown):
        ids = [int(n) for n in re.findall(r"\[(\d+)\]", sent)]
        if not ids:
            continue
        toks = set(rag.tokenize(re.sub(r"\[\d+\]", "", sent)))
        if len(toks) < 5:
            continue
        support = max(len(toks & src_text.get(i, set())) / len(toks) for i in ids)
        if support < 0.35:
            weak.append({"sentence": sent.strip()[:240], "cited": ids, "overlap": round(support, 2)})

    return {
        "citations_total": len(cited), "unique_sources_cited": len(set(cited)),
        "sources_available": len(valid), "invalid_citations": invalid,
        "uncited_paragraphs": uncited[:6], "weakly_supported": weak[:8],
    }


CRITIC_PROMPT = ChatPromptTemplate.from_template("""You are the Critic agent: a rigorous, skeptical reviewer (think peer reviewer + fact-checker).
Evaluate the DRAFT REPORT against the QUESTION and the EVIDENCE it was supposed to be built from.

Check: factual accuracy vs evidence, claims not supported by the cited source, missing key aspects of the
question, outdated info, one-sided coverage, logical errors, misuse of statistics, and clarity.
An automated citation audit is also provided — weigh it, but use judgment (low token overlap can be a false alarm).

Score each criterion 1-10 (10 = publishable expert quality; be strict, 8 means genuinely good):
accuracy, evidence_support, completeness, balance, clarity.

Return JSON:
{{
  "scores": {{"accuracy": n, "evidence_support": n, "completeness": n, "balance": n, "clarity": n}},
  "overall": n,
  "summary": "<2-3 sentence assessment>",
  "issues": [{{"severity": "high|medium|low", "type": "unsupported_claim|missing_topic|inaccuracy|bias|clarity|citation",
               "description": "...", "fix": "<concrete instruction for the reviser>"}}],
  "missing_topics": ["..."],
  "followup_queries": ["<web search queries that would fill the gaps; [] if none needed>"]
}}

QUESTION: {question}

AUTOMATED CITATION AUDIT:
{audit}

DRAFT REPORT:
{draft}

EVIDENCE (abridged):
{evidence}""")


async def critique_node(ctx: Ctx, state: dict) -> str:
    draft = state["drafts"][-1]
    audit = citation_audit(draft["markdown"], state)
    await ctx.emit("critic", f"Auditing citations: {audit['citations_total']} citations, "
                             f"{len(audit['invalid_citations'])} invalid, {len(audit['weakly_supported'])} weakly supported")
    variables = dict(question=state["question"], audit=json.dumps(audit, indent=1),
                                  draft=draft["markdown"], evidence=format_evidence(state, budget=14000))
    crit, model = await llm.chat_json("critic", CRITIC_PROMPT, variables, temperature=0.1, max_tokens=3000)
    _track(state, "critic", model)

    scores = {k: float(v) for k, v in (crit.get("scores") or {}).items() if isinstance(v, (int, float))}
    overall = float(crit.get("overall") or (sum(scores.values()) / len(scores) if scores else 5))
    penalty = min(2.0, 0.5 * len(audit["invalid_citations"]))  # hard evidence of fabrication
    overall = round(max(1.0, overall - penalty), 2)
    issues = crit.get("issues") or []
    high = [i for i in issues if str(i.get("severity", "")).lower() == "high"]
    passed = overall >= config.PASS_SCORE and not high and not audit["invalid_citations"]

    critique = {
        "iteration": state["iteration"], "model": model, "scores": scores, "overall": overall,
        "penalty": penalty, "summary": crit.get("summary", ""), "issues": issues,
        "missing_topics": crit.get("missing_topics") or [], "followup_queries": crit.get("followup_queries") or [],
        "audit": audit, "verdict": "pass" if passed else "revise",
    }
    state["critiques"].append(critique)
    draft["score"] = overall
    await ctx.emit("critic", f"Score {overall}/10 — {len(issues)} issues ({len(high)} high) → {critique['verdict'].upper()} "
                             f"[{model}]", {"critique": critique}, type="critique")

    if passed:
        return "finalize"
    if state["iteration"] >= state["options"]["max_revisions"]:
        await ctx.emit("orchestrator", "Revision budget exhausted — finalizing the best-scoring draft")
        return "finalize"
    return "gap_research"


# ======================================================================= GAP RESEARCH + REVISER
async def gap_research_node(ctx: Ctx, state: dict) -> str:
    crit = state["critiques"][-1]
    queries = [q for q in crit["followup_queries"] if isinstance(q, str)][:4]
    if queries:
        await ctx.emit("researcher", f"Filling {len(queries)} gaps flagged by the critic")
        results = await _run_queries(ctx, queries, "researcher")
        await _ingest_urls(ctx, state, results, "researcher")
    targets = queries + [t for t in crit["missing_topics"] if isinstance(t, str)][:4]
    targets += [i["description"] for i in crit["issues"] if i.get("type") in ("unsupported_claim", "inaccuracy")][:4]
    if targets:
        await _gather_evidence(ctx, state, targets, key_prefix=f"gap{state['iteration'] + 1}: ")
    return "revise"


REVISER_PROMPT = ChatPromptTemplate.from_template("""You are the Reviser agent. Produce an improved version of the DRAFT REPORT that fixes every
problem raised by the CRITIC, using the EVIDENCE (which now includes newly gathered sources).

Rules:
- Address each issue. Remove or explicitly qualify claims the evidence does not support.
- Fix invalid citations; cite only SOURCE numbers present in the evidence (or [analysis]).
- Add content for missing topics where evidence allows; otherwise note the gap under Limitations.
- Keep the same Markdown structure and keep chart embeds. Do not add a references list.

Output the full revised report in Markdown, then a line containing exactly <<<CHANGES>>> followed by
a bullet list of the changes you made.

QUESTION: {question}

CRITIC FEEDBACK:
{critique}

DATASET ANALYSIS:
{analysis}

DRAFT REPORT:
{draft}

EVIDENCE:
{evidence}""")


async def revise_node(ctx: Ctx, state: dict) -> str:
    crit = state["critiques"][-1]
    feedback = json.dumps({k: crit[k] for k in ("summary", "issues", "missing_topics")} |
                          {"invalid_citations": crit["audit"]["invalid_citations"],
                           "weakly_supported": crit["audit"]["weakly_supported"]}, indent=1)
    variables = dict(question=state["question"], critique=feedback, analysis=format_analysis(state),
                                   draft=state["drafts"][-1]["markdown"], evidence=format_evidence(state))
    await ctx.emit("reviser", f"Revising draft to address {len(crit['issues'])} issues")
    res = await llm.chat("writer", REVISER_PROMPT, variables, temperature=0.25, max_tokens=6500)
    _track(state, "reviser", res.model)
    body, _, changes = res.text.partition("<<<CHANGES>>>")
    state["iteration"] += 1
    change_list = [c.strip(" -*\t") for c in changes.strip().splitlines() if c.strip(" -*\t")]
    state["drafts"].append({"iteration": state["iteration"], "markdown": _strip_refs(body), "model": res.model,
                            "changes": change_list})
    await ctx.emit("reviser", f"Draft v{state['iteration'] + 1} produced by {res.model} ({len(change_list)} changes)",
                   {"iteration": state["iteration"], "changes": change_list}, type="draft")
    return "critique"


# ======================================================================= FINALIZE
async def finalize_node(ctx: Ctx, state: dict) -> str:
    best = max(state["drafts"], key=lambda d: (d.get("score", 0), d["iteration"]))
    md = best["markdown"]
    md = re.sub(r"\]\(chart:([\w.\-]+)\)", lambda m: f"](/api/runs/{ctx.run_id}/files/{m.group(1)})", md)
    cited = {int(n) for n in re.findall(r"\[(\d+)\]", md)}
    refs = [f"{s['id']}. [{s['title']}]({s['url']})" if s["kind"] == "web" else f"{s['id']}. {s['title']} (uploaded)"
            for s in state["sources"] if s["id"] in cited]
    if refs:
        md += "\n\n## Sources\n\n" + "\n".join(refs)
    state["final_report"] = md
    state["best_iteration"] = best["iteration"]
    await ctx.emit("orchestrator", f"Final report = draft v{best['iteration'] + 1} (score {best.get('score', '?')}/10)",
                   {"best_iteration": best["iteration"]}, type="final")
    return "done"


NODES = {
    "plan": plan_node, "research": research_node, "analyze": analyze_node, "write": write_node,
    "critique": critique_node, "gap_research": gap_research_node, "revise": revise_node,
    "finalize": finalize_node,
}
