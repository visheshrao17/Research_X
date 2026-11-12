"""Data analysis: profile uploaded datasets, have an LLM write pandas code, run it in a
subprocess with a timeout, and self-repair on errors.

NOTE: generated code runs locally as your user. This is a convenience guard, not a security
sandbox — only analyze data you trust on a machine you control.
"""
import asyncio
import json
import re
import sys
from pathlib import Path

import pandas as pd

from . import llm

_FORBIDDEN = re.compile(
    r"\b(subprocess|shutil\.rmtree|os\.system|os\.remove|os\.unlink|os\.rmdir|socket|requests|httpx|urllib|"
    r"__import__|eval\(|exec\(|open\([^)]*['\"][wa])"
)


def load_frame(path: Path) -> pd.DataFrame:
    if path.suffix.lower() in (".xlsx", ".xls"):
        return pd.read_excel(path)
    if path.suffix.lower() == ".json":
        return pd.read_json(path)
    return pd.read_csv(path, sep=None, engine="python")


def profile(path: Path) -> str:
    df = load_frame(path)
    with pd.option_context("display.max_columns", 50, "display.width", 200):
        return (
            f"File: {path.name}  shape={df.shape}\n"
            f"Columns/dtypes:\n{df.dtypes.to_string()}\n\n"
            f"Head:\n{df.head(5).to_string()}\n\n"
            f"Describe:\n{df.describe(include='all').T.head(30).to_string()}"
        )


ANALYST_PROMPT = """You are a senior data analyst writing Python (pandas, numpy, matplotlib).
Write ONE self-contained script that answers the analysis goals using the datasets below.

Rules:
- Load files with the exact paths given in DATASETS (use pd.read_csv(path, sep=None, engine="python") for CSV, pd.read_excel for xlsx).
- Print clear, labelled findings with print(). Print numeric results rounded sensibly. Keep stdout under ~4000 chars.
- Save 1-3 informative charts with matplotlib to OUTPUT_DIR (variable already defined) as PNG,
  e.g. plt.savefig(f"{{OUTPUT_DIR}}/chart_1.png", dpi=120, bbox_inches="tight"); plt.close(). Always label axes and titles.
- Use matplotlib's "Agg" backend. No network access, no file writes outside OUTPUT_DIR, no input().
- Handle missing values defensively.

Return JSON: {{"code": "<python source>", "explanation": "<one paragraph on the approach>"}}

QUESTION: {question}
ANALYSIS GOALS: {goals}

DATASETS:
{profiles}
"""


async def _execute(code: str, out_dir: Path, timeout: int = 60) -> tuple[bool, str]:
    if m := _FORBIDDEN.search(code):
        return False, f"Refused to run: forbidden construct '{m.group(0)}'"
    script = out_dir / "analysis.py"
    prelude = ("import matplotlib\nmatplotlib.use('Agg')\n"
               f"OUTPUT_DIR = {str(out_dir)!r}\n")
    script.write_text(prelude + code)
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-I", str(script), cwd=str(out_dir),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return False, f"Timed out after {timeout}s"
    out = stdout.decode(errors="replace")[-6000:]
    if proc.returncode != 0:
        return False, out + "\n" + stderr.decode(errors="replace")[-3000:]
    return True, out


async def run_analysis(question: str, goals: list[str], datasets: list[Path], out_dir: Path,
                       emit) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    profiles = "\n\n".join(f"PATH: {p}\n{profile(p)}" for p in datasets)
    messages = [{"role": "user", "content": ANALYST_PROMPT.format(
        question=question, goals="; ".join(goals) or "Exploratory analysis relevant to the question",
        profiles=profiles)}]
    result = {"code": "", "output": "", "charts": [], "explanation": "", "success": False, "attempts": 0}
    for attempt in range(3):
        data, model = await llm.chat_json("analyst", messages, temperature=0.1, max_tokens=4096)
        code = data.get("code", "")
        result.update(code=code, explanation=data.get("explanation", ""), attempts=attempt + 1, model=model)
        await emit("analyst", f"Executing analysis script (attempt {attempt + 1}) written by {model}")
        ok, output = await _execute(code, out_dir)
        result["output"] = output
        if ok:
            result["success"] = True
            break
        await emit("analyst", "Script failed — asking the model to repair it", {"error": output[-800:]})
        messages += [
            {"role": "assistant", "content": json.dumps(data)},
            {"role": "user", "content": f"The script failed with:\n{output[-2500:]}\nFix it. Return the same JSON format."},
        ]
    result["charts"] = sorted(p.name for p in out_dir.glob("*.png"))
    return result
