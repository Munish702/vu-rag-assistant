"""
evaluate.py - score retrieval against the eval set.

For every question, retrieve the top-k chunks and find the rank of the first
chunk that matches one of the question's "gold" locations
(e.g. {"article": "Article 3.5"} or {"course_code": "X_400111", "section": "Method of Assessment"}).

Metrics (over answerable questions):
  Recall@1, Recall@5 : how often a gold chunk is ranked 1st / in the top 5
  MRR                : mean of 1/rank (rank 1 -> 1.0, rank 2 -> 0.5, miss -> 0)

It also compares the top-1 score of answerable vs unanswerable questions,
to show whether a score threshold could detect "no answer".

Run from the project root:
    python src/evaluate.py                    # saves experiments/<time>_baseline.json
    python src/evaluate.py --name chunk512    # name your experiment
"""

import argparse
import json
import statistics
from collections import defaultdict
from datetime import datetime

from config import EMBED_MODEL, EVAL_FILE, RERANK_MODEL, RESERVE_TER_SLOT, RETRIEVAL_MODE, ROOT
from retrieve import retrieve


def matches(meta: dict, gold: list[dict]) -> bool:
    """A chunk matches if ALL fields of ANY gold location agree with its metadata."""
    return any(all(meta.get(k) == v for k, v in g.items()) for g in gold)


def first_gold_rank(hits: list[dict], gold: list[dict]) -> int | None:
    for rank, hit in enumerate(hits, start=1):
        if matches(hit["metadata"], gold):
            return rank
    return None


def metrics(rows: list[dict]) -> dict:
    n = len(rows)
    if n == 0:
        return {"n": 0}
    hit_at = lambda k: sum(1 for r in rows if r["rank"] and r["rank"] <= k) / n
    return {
        "n": n,
        "recall@1": round(hit_at(1), 3),
        "recall@5": round(hit_at(5), 3),
        "mrr": round(sum(1 / r["rank"] for r in rows if r["rank"]) / n, 3),
    }


def retrieval_settings() -> dict:
    """Every setting that changes retrieval results - printed and saved with each run,
    so a forgotten config change can't silently produce a misleading result."""
    s = {"mode": RETRIEVAL_MODE}
    if RETRIEVAL_MODE == "rerank":
        s.update(rerank_model=RERANK_MODEL, reserve_ter_slot=RESERVE_TER_SLOT)
    return s


def settings_line() -> str:
    return ", ".join(f"{k}={v}" for k, v in retrieval_settings().items())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--k", type=int, default=10, help="how deep to search for the gold chunk")
    parser.add_argument("--name", default="baseline", help="experiment name for the results file")
    args = parser.parse_args()

    with open(EVAL_FILE, encoding="utf-8") as f:
        questions = [json.loads(line) for line in f if line.strip()]

    rows = []
    for q in questions:
        hits = retrieve(q["question"], k=args.k)
        rows.append({
            "id": q["id"],
            "type": q["type"],
            "question": q["question"],
            "answerable": bool(q["gold"]),
            "rank": first_gold_rank(hits, q["gold"]) if q["gold"] else None,
            "top1_score": round(hits[0]["score"], 3),
            "top5_ids": [h["id"] for h in hits[:5]],
        })

    answerable = [r for r in rows if r["answerable"]]
    unanswerable = [r for r in rows if not r["answerable"]]
    overall = metrics(answerable)

    # ---- report ---------------------------------------------------------
    print(f"\nModel: {EMBED_MODEL}   questions: {len(rows)} "
          f"({len(answerable)} answerable, {len(unanswerable)} unanswerable)")
    print(f"Retrieval: {settings_line()}\n")
    print(f"{'':<16}{'n':>4}{'R@1':>8}{'R@5':>8}{'MRR':>8}")
    print(f"{'ALL':<16}{overall['n']:>4}{overall['recall@1']:>8.2f}{overall['recall@5']:>8.2f}{overall['mrr']:>8.2f}")
    by_type = defaultdict(list)
    for r in answerable:
        by_type[r["type"]].append(r)
    for t, group in sorted(by_type.items()):
        m = metrics(group)
        print(f"  {t:<14}{m['n']:>4}{m['recall@1']:>8.2f}{m['recall@5']:>8.2f}{m['mrr']:>8.2f}")

    misses = [r for r in answerable if not r["rank"] or r["rank"] > 5]
    if misses:
        print(f"\nNot in top 5 ({len(misses)}):")
        for r in misses:
            where = f"rank {r['rank']}" if r["rank"] else f"not in top {args.k}"
            print(f"  {r['id']} [{where}] {r['question']}")
            print(f"       got: {', '.join(r['top5_ids'][:3])}")

    if unanswerable:
        a = statistics.mean(r["top1_score"] for r in answerable)
        u = statistics.mean(r["top1_score"] for r in unanswerable)
        print(f"\nTop-1 score, answerable vs unanswerable: {a:.3f} vs {u:.3f}"
              f"  (a small gap means a score threshold can't detect 'no answer')")

    # ---- save -----------------------------------------------------------
    out_dir = ROOT / "experiments"
    out_dir.mkdir(exist_ok=True)
    out_file = out_dir / f"{datetime.now():%Y%m%d-%H%M}_{args.name}.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump({
            "name": args.name,
            "model": EMBED_MODEL,
            "retrieval": retrieval_settings(),
            "k": args.k,
            "metrics": {"overall": overall, **{t: metrics(g) for t, g in by_type.items()}},
            "rows": rows,
        }, f, indent=2, ensure_ascii=False)
    print(f"\nSaved {out_file.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
