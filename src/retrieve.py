"""
retrieve.py - find the chunks most relevant to a question.

Use it from code:
    from retrieve import retrieve
    hits = retrieve("Can I resit an exam I passed?", k=5)

Or try it from the terminal (project root):
    python src/retrieve.py "Can I resit an exam I passed?"
    python src/retrieve.py "How is Deep Learning graded?" --k 3
    python src/retrieve.py "When can I start my thesis?" --doc-type ter
"""

import argparse
from functools import lru_cache

import chromadb
from sentence_transformers import SentenceTransformer

from config import EMBED_MODEL, INDEX_DIR, QUERY_PREFIX, collection_name


@lru_cache(maxsize=1)
def _model() -> SentenceTransformer:
    return SentenceTransformer(EMBED_MODEL)


@lru_cache(maxsize=1)
def _collection():
    client = chromadb.PersistentClient(path=str(INDEX_DIR))
    return client.get_collection(collection_name())


def retrieve(query: str, k: int = 5, where: dict | None = None) -> list[dict]:
    """Return the k nearest chunks, best first.

    where: optional metadata filter, e.g. {"doc_type": "ter"} or
           {"course_code": "X_400111"}.
    """
    query_vec = _model().encode([QUERY_PREFIX + query], normalize_embeddings=True)[0]
    res = _collection().query(
        query_embeddings=[query_vec.tolist()],
        n_results=k,
        where=where,
    )
    return [
        {"id": i, "text": doc, "metadata": meta, "score": 1 - dist}  # cosine similarity
        for i, doc, meta, dist in zip(
            res["ids"][0], res["documents"][0], res["metadatas"][0], res["distances"][0]
        )
    ]


def main():
    parser = argparse.ArgumentParser(description="Search the VU index.")
    parser.add_argument("query", help="your question, in quotes")
    parser.add_argument("--k", type=int, default=5, help="number of results")
    parser.add_argument("--doc-type", choices=["ter", "study_guide"], help="only search one document type")
    args = parser.parse_args()

    where = {"doc_type": args.doc_type} if args.doc_type else None
    for rank, hit in enumerate(retrieve(args.query, k=args.k, where=where), start=1):
        header, _, body = hit["text"].partition("\n")
        preview = " ".join(body.split())[:160]
        print(f"\n#{rank}  score={hit['score']:.3f}  [{hit['id']}]")
        print(f"    {header}")
        print(f"    {preview}...")


if __name__ == "__main__":
    main()
