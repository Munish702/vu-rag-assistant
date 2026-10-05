"""
evaluate_generation.py - grade the assistant's ANSWERS (not just retrieval).

For every question in the eval set it runs the full pipeline (retrieve -> LLM)
and checks three things automatically:

  1. Abstention   : unanswerable questions should get "I couldn't find this...",
                    answerable ones should NOT.
  2. Key facts    : does the answer contain the facts listed in "must_include"?
                    Each item may list alternatives separated by "|",
                    e.g. "most recent|latest" passes if either word appears.
  3. Citations    : does the answer cite a source number that holds a gold chunk?

Run from the project root (takes a few minutes - one LLM call per question):
    python src/evaluate_generation.py
    python src/evaluate_generation.py --name qwen7b-scope-labels
"""

import argparse
import json
import re
import statistics
import time
from datetime import datetime

from config import EVAL_FILE, LLM_MODEL, ROOT
from evaluate import matches
from generate import NOT_FOUND, SYSTEM_PROMPT, build_prompt, call_llm
from retrieve import retrieve


def contains(text: str, item: str) -> bool:
    """True if any '|'-separated alternative appears as a whole word/phrase."""
    return any(re.search(rf"(?<!\w){re.escape(alt.strip())}(?!\w)", text, re.IGNORECASE)
               for alt in item.split("|"))


def cited_numbers(text: str) -> set[int]:
    """All [n] citations in the answer, e.g. '[1][3]' -> {1, 3}."""
    return {int(n) for n in re.findall(r"\[(\d+)\]", text)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--k", type=int, default=5, help="chunks given to the LLM")
    parser.add_argument("--name", default="generation", help="experiment name")
    args = parser.parse_args()

    with open(EVAL_FILE, encoding="utf-8") as f:
        questions = [json.loads(line) for line in f if line.strip()]

    rows = []
    for i, q in enumerate(questions, start=1):
        print(f"[{i}/{len(questions)}] {q['question']}", flush=True)
        start = time.time()
        hits = retrieve(q["question"], k=args.k)
        text = call_llm(SYSTEM_PROMPT, build_prompt(q["question"], hits))

        answerable = bool(q["gold"])
        abstained = NOT_FOUND.lower().rstrip(".") in text.lower()
        gold_numbers = {n for n, h in enumerate(hits, start=1)
                        if answerable and matches(h["metadata"], q["gold"])}
        cited = cited_numbers(text)
        facts = q.get("must_include", [])
        found = [f for f in facts if contains(text, f)]

        rows.append({
            "id": q["id"],
            "type": q["type"],
            "question": q["question"],
            "answer": text,
            "answerable": answerable,
            "abstained": abstained,
            "abstention_correct": abstained != answerable,
            "gold_retrieved": bool(gold_numbers),
            "gold_cited": bool(cited & gold_numbers),
            "invalid_citations": sorted(n for n in cited if n < 1 or n > len(hits)),
            "facts_total": len(facts),
            "facts_found": len(found),
            "facts_missing": [f for f in facts if f not in found],
            "seconds": round(time.time() - start, 1),
        })

    # ---- metrics --------------------------------------------------------
    ans = [r for r in rows if r["answerable"]]
    unans = [r for r in rows if not r["answerable"]]
    with_facts = [r for r in ans if r["facts_total"] and not r["abstained"]]
    citable = [r for r in ans if r["gold_retrieved"] and not r["abstained"]]
    pct = lambda part, whole: (len(part) / len(whole)) if whole else float("nan")

    metrics = {
        "abstain_when_unanswerable": round(pct([r for r in unans if r["abstained"]], unans), 3),
        "false_abstain_when_answerable": round(pct([r for r in ans if r["abstained"]], ans), 3),
        "key_fact_coverage": round(statistics.mean(r["facts_found"] / r["facts_total"]
                                                   for r in with_facts), 3) if with_facts else None,
        "fully_correct_facts": round(pct([r for r in with_facts if r["facts_found"] == r["facts_total"]],
                                         with_facts), 3),
        "gold_citation_rate": round(pct([r for r in citable if r["gold_cited"]], citable), 3),
        "avg_seconds_per_answer": round(statistics.mean(r["seconds"] for r in rows), 1),
    }

    # ---- report ---------------------------------------------------------
    print(f"\nModel: {LLM_MODEL}   questions: {len(rows)} "
          f"({len(ans)} answerable, {len(unans)} unanswerable)\n")
    print(f"  Abstains on unanswerable        {metrics['abstain_when_unanswerable']:.2f}   (higher is better)")
    print(f"  Wrongly abstains on answerable  {metrics['false_abstain_when_answerable']:.2f}   (lower is better)")
    if metrics["key_fact_coverage"] is not None:
        print(f"  Key-fact coverage               {metrics['key_fact_coverage']:.2f}")
        print(f"  Answers with ALL key facts      {metrics['fully_correct_facts']:.2f}")
    print(f"  Cites the gold source           {metrics['gold_citation_rate']:.2f}   "
          f"(of {len(citable)} answers where the gold chunk was retrieved)")
    print(f"  Avg seconds per answer          {metrics['avg_seconds_per_answer']}")

    problems = [r for r in rows if not r["abstention_correct"] or r["facts_missing"]
                or (r["gold_retrieved"] and not r["gold_cited"] and not r["abstained"])]
    if problems:
        print(f"\nAnswers to review ({len(problems)}):")
        for r in problems:
            issues = []
            if not r["abstention_correct"]:
                issues.append("wrongly abstained" if r["answerable"] else "should have abstained")
            if r["facts_missing"] and not r["abstained"]:
                issues.append(f"missing: {', '.join(r['facts_missing'])}")
            if r["gold_retrieved"] and not r["gold_cited"] and not r["abstained"]:
                issues.append("did not cite gold source")
            if not r["gold_retrieved"] and r["answerable"]:
                issues.append("(gold chunk not retrieved)")
            print(f"  {r['id']}: {'; '.join(issues)}")
            print(f"       {' '.join(r['answer'].split())[:180]}")

    out_dir = ROOT / "experiments"
    out_dir.mkdir(exist_ok=True)
    out_file = out_dir / f"{datetime.now():%Y%m%d-%H%M}_{args.name}.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump({"name": args.name, "llm": LLM_MODEL, "k": args.k,
                   "metrics": metrics, "rows": rows}, f, indent=2, ensure_ascii=False)
    print(f"\nSaved {out_file.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
