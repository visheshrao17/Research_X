"""Web search (Tavily free tier / ddgs metasearch / Wikipedia) + page fetching and clean text extraction."""
import asyncio
import io
import logging
import re
from urllib.parse import urlparse

import httpx

from . import config

log = logging.getLogger("researchx.search")

try:
    import trafilatura
except ImportError:  # pragma: no cover
    trafilatura = None

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}
_BLOCKED = ("youtube.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "pinterest.")


_DDGS_BACKENDS = ("duckduckgo", "bing", "brave", "mojeek", "yahoo")


async def _ddgs(query: str, n: int) -> list[dict]:
    """Free metasearch via the `ddgs` package; walk backends since any one may rate-limit."""
    from ddgs import DDGS

    for backend in _DDGS_BACKENDS:
        try:
            rows = await asyncio.to_thread(lambda: list(DDGS().text(query, max_results=n, backend=backend)))
        except Exception as e:  # noqa: BLE001
            log.info("ddgs/%s failed for %r: %s", backend, query, e)
            continue
        if rows:
            return [{"title": r.get("title", ""), "url": r.get("href", ""), "snippet": r.get("body", "")} for r in rows]
    return []


async def _wikipedia(query: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": "ResearchX/1.0 (local research tool)"}) as c:
        r = await c.get("https://en.wikipedia.org/w/api.php", params={
            "action": "query", "list": "search", "srsearch": query, "srlimit": n, "format": "json"})
        r.raise_for_status()
        return [{"title": x["title"], "url": "https://en.wikipedia.org/wiki/" + x["title"].replace(" ", "_"),
                 "snippet": re.sub(r"<[^>]+>", "", x.get("snippet", ""))}
                for x in r.json().get("query", {}).get("search", [])]


async def _tavily(query: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post("https://api.tavily.com/search",
                         json={"api_key": config.TAVILY_API_KEY, "query": query, "max_results": n,
                               "search_depth": "basic"})
        r.raise_for_status()
        return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": x.get("content", "")}
                for x in r.json().get("results", [])]


async def web_search(query: str, n: int | None = None) -> list[dict]:
    n = n or config.SEARCH_RESULTS_PER_QUERY
    results: list[dict] = []
    if config.TAVILY_API_KEY:
        try:
            results = await _tavily(query, n)
        except Exception as e:  # noqa: BLE001
            log.warning("Tavily failed, using DuckDuckGo: %s", e)
    if not results:
        results = await _ddgs(query, n)
    if not results:
        try:
            results = await _wikipedia(query, n)
        except Exception as e:  # noqa: BLE001
            log.warning("All search backends failed for %r: %s", query, e)
    return [r for r in results if r["url"].startswith("http") and not any(b in r["url"] for b in _BLOCKED)]


def _extract_html(html: str, url: str) -> str:
    if trafilatura:
        text = trafilatura.extract(html, url=url, include_comments=False, include_tables=True, favor_recall=True)
        if text:
            return text
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form"]):
        tag.decompose()
    return "\n".join(line.strip() for line in soup.get_text("\n").splitlines() if len(line.strip()) > 40)


def extract_pdf(data: bytes) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    return "\n".join((p.extract_text() or "") for p in reader.pages[:60])


async def fetch_page(url: str, client: httpx.AsyncClient) -> str:
    try:
        r = await client.get(url, headers=_HEADERS, follow_redirects=True, timeout=20)
        if r.status_code >= 400:
            return ""
        ctype = r.headers.get("content-type", "")
        if r.content[:5] == b"%PDF-":
            return await asyncio.to_thread(extract_pdf, r.content)
        if "pdf" in ctype or urlparse(url).path.lower().endswith(".pdf"):
            ctype = "text/html"  # mislabelled: server sent a landing page instead of the PDF
        if "html" not in ctype and "text" not in ctype:
            return ""
        return await asyncio.to_thread(_extract_html, r.text, url)
    except Exception as e:  # noqa: BLE001
        log.info("fetch failed %s: %s", url, e)
        return ""


async def fetch_many(urls: list[str], concurrency: int = 6) -> dict[str, str]:
    sem = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient() as client:
        async def one(u):
            async with sem:
                return u, await fetch_page(u, client)
        return dict(await asyncio.gather(*(one(u) for u in urls)))
