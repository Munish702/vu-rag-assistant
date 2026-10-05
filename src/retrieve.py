"""
retrieve.py - find the chunks most relevant to a question.

Four modes (default set in config.RETRIEVAL_MODE):
  dense  : embedding similarity (understands meaning, vague on exact names/codes)
  bm25   : keyword matching    (precise on exact words, no understanding of meaning)
  hybrid : both, combined with Reciprocal Rank Fusion (RRF)
  rerank : dense + BM25 candidates, re-ordered by a cross-encoder that reads
           the question and each chunk together

Use it from code:
    from retrieve import retrieve
    hits = retrieve("Can I resit an exam I passed?", k=5)

Or from the terminal (project root):
    python src/retrieve.py "Can I resit an exam I passed?"
    python src/retrieve.py "Can I take XM_0189?" --mode bm25
    python src/retrieve.py "When can I start my thesis?" --doc-type ter
"""

import argparse
import json
import math
import re
from collections import Counter
from functools import lru_cache

from config import (CANDIDATES, CHUNKS_FILE, EMBED_MODEL, INDEX_DIR, QUERY_PREFIX,
                    RERANK_MODEL, RESERVE_TER_SLOT, RETRIEVAL_MODE, RRF_K, collection_name)

# --------------------------------------------------------------------------
# Dense retrieval (embeddings + ChromaDB)
# --------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _model():
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer(EMBED_MODEL)


@lru_cache(maxsize=1)
def _collection():
    import chromadb
    client = chromadb.PersistentClient(path=str(INDEX_DIR))
    return client.get_collection(collection_name())


def dense_search(query: str, n: int, where: dict | None = None) -> list[dict]:
    query_vec = _model().encode([QUERY_PREFIX + query], normalize_embeddings=True)[0]
    res = _collection().query(query_embeddings=[query_vec.tolist()], n_results=n, where=where)
    return [
        {"id": i, "text": doc, "metadata": meta, "score": 1 - dist}  # cosine similarity
        for i, doc, meta, dist in zip(
            res["ids"][0], res["documents"][0], res["metadatas"][0], res["distances"][0]
        )
    ]


# --------------------------------------------------------------------------
# BM25 keyword retrieval (built in memory from chunks.jsonl - takes < 1 second)
# --------------------------------------------------------------------------
STOPWORDS = set("""a an and are as at be by can do does for from has have how i if in is it
its my of on or should the this to was what when where which who will with you your""".split())


def tokenize(text: str) -> list[str]:
    """Lowercase words; keeps course codes like 'xm_0189' and numbers like '5.5' intact."""
    return [t for t in re.findall(r"[a-z0-9_]+(?:\.[0-9]+)?", text.lower()) if t not in STOPWORDS]


class BM25:
    """Okapi BM25: rewards query words that are rare in the corpus (IDF) and frequent
    in the chunk (TF), while stopping long chunks from winning just by being long."""

    def __init__(self, docs: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self.tfs = [Counter(d) for d in docs]
        self.lengths = [len(d) for d in docs]
        self.avg_len = sum(self.lengths) / len(docs)
        df = Counter(word for d in docs for word in set(d))  # how many chunks contain each word
        n = len(docs)
        self.idf = {w: math.log(1 + (n - f + 0.5) / (f + 0.5)) for w, f in df.items()}

    def scores(self, query: list[str]) -> list[float]:
        out = []
        for tf, length in zip(self.tfs, self.lengths):
            s = 0.0
            for w in query:
                if w in tf:
                    norm = self.k1 * (1 - self.b + self.b * length / self.avg_len)
                    s += self.idf[w] * tf[w] * (self.k1 + 1) / (tf[w] + norm)
            out.append(s)
        return out


@lru_cache(maxsize=1)
def _bm25():
    with open(CHUNKS_FILE, encoding="utf-8") as f:
        chunks = [json.loads(line) for line in f]
    return chunks, BM25([tokenize(c["text"]) for c in chunks])


def bm25_search(query: str, n: int, where: dict | None = None) -> list[dict]:
    chunks, index = _bm25()
    scored = [
        (s, c) for s, c in zip(index.scores(tokenize(query)), chunks)
        if s > 0 and (not where or all(c["metadata"].get(k) == v for k, v in where.items()))
    ]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [{"id": c["id"], "text": c["text"], "metadata": c["metadata"], "score": s}
            for s, c in scored[:n]]


# --------------------------------------------------------------------------
# Hybrid: Reciprocal Rank Fusion
# --------------------------------------------------------------------------
def rrf_fuse(rankings: list[list[dict]], k: int = RRF_K) -> list[dict]:
    """Each list votes 1/(k + rank) for each chunk; chunks ranked high in BOTH lists win.
    Uses ranks, not scores, because dense (~0.7) and BM25 (~10-30) scores aren't comparable."""
    fused, by_id = {}, {}
    for ranking in rankings:
        for rank, hit in enumerate(ranking, start=1):
            fused[hit["id"]] = fused.get(hit["id"], 0.0) + 1 / (k + rank)
            by_id.setdefault(hit["id"], hit)
    order = sorted(fused, key=fused.get, reverse=True)
    return [{**by_id[i], "score": fused[i]} for i in order]


# --------------------------------------------------------------------------
# Reranking with a cross-encoder
# --------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _reranker():
    from sentence_transformers import CrossEncoder
    return CrossEncoder(RERANK_MODEL, max_length=512)


def merge_candidates(*rankings: list[dict]) -> list[dict]:
    """Union of several result lists, without duplicates (first occurrence wins)."""
    seen, merged = set(), []
    for ranking in rankings:
        for hit in ranking:
            if hit["id"] not in seen:
                seen.add(hit["id"])
                merged.append(hit)
    return merged


def rerank(query: str, candidates: list[dict]) -> list[dict]:
    """Score every (question, chunk) pair by reading them TOGETHER, then sort.
    Slower than dense search, so it only runs on a shortlist."""
    if not candidates:
        return []
    scores = _reranker().predict([(query, c["text"]) for c in candidates], batch_size=16)
    ranked = sorted(zip(scores, candidates), key=lambda pair: float(pair[0]), reverse=True)
    return [{**c, "score": float(s)} for s, c in ranked]


def reserve_ter_slot(top: list[dict], rest: list[dict]) -> list[dict]:
    """General rules apply to every student, so make sure at least one is shown:
    if the top results contain no TER chunk, swap the last one for the best-ranked TER chunk."""
    if len(top) < 2 or any(h["metadata"].get("doc_type") == "ter" for h in top):
        return top
    best_ter = next((h for h in rest if h["metadata"].get("doc_type") == "ter"), None)
    return top[:-1] + [best_ter] if best_ter else top


def retrieve(query: str, k: int = 5, where: dict | None = None, mode: str | None = None) -> list[dict]:
    """Return the k most relevant chunks, best first.

    where: optional metadata filter, e.g. {"doc_type": "ter"}.
    mode : "dense", "bm25", "hybrid" or "rerank" (default: config.RETRIEVAL_MODE).
    Note: 'score' means something different per mode (cosine, BM25, RRF or reranker score).
    """
    mode = mode or RETRIEVAL_MODE
    if mode == "dense":
        return dense_search(query, k, where)
    if mode == "bm25":
        return bm25_search(query, k, where)
    if mode == "hybrid":
        return rrf_fuse([dense_search(query, CANDIDATES, where),
                         bm25_search(query, CANDIDATES, where)])[:k]
    if mode == "rerank":
        # BM25 only NOMINATES candidates here; it gets no vote on the final order.
        candidates = merge_candidates(dense_search(query, CANDIDATES, where),
                                      bm25_search(query, CANDIDATES, where))
        ranked = rerank(query, candidates)
        top = ranked[:k]
        if RESERVE_TER_SLOT:
            top = reserve_ter_slot(top, ranked[k:])
        return top
    raise ValueError(f"Unknown retrieval mode: {mode}")


def main():
    parser = argparse.ArgumentParser(description="Search the VU index.")
    parser.add_argument("query", help="your question, in quotes")
    parser.add_argument("--k", type=int, default=5, help="number of results")
    parser.add_argument("--mode", choices=["dense", "bm25", "hybrid", "rerank"], help="retrieval mode")
    parser.add_argument("--doc-type", choices=["ter", "study_guide"], help="only search one document type")
    args = parser.parse_args()

    where = {"doc_type": args.doc_type} if args.doc_type else None
    for rank, hit in enumerate(retrieve(args.query, k=args.k, where=where, mode=args.mode), start=1):
        header, _, body = hit["text"].partition("\n")
        preview = " ".join(body.split())[:160]
        print(f"\n#{rank}  score={hit['score']:.3f}  [{hit['id']}]")
        print(f"    {header}")
        print(f"    {preview}...")


if __name__ == "__main__":
    main()
