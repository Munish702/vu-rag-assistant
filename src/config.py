"""Shared settings, so every script agrees on paths and the embedding model."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHUNKS_FILE = ROOT / "data" / "processed" / "chunks.jsonl"
INDEX_DIR = ROOT / "data" / "index"
EVAL_FILE = ROOT / "data" / "eval" / "questions.jsonl"

# Small, fast, strong English embedding model (384 dimensions, ~130 MB).
EMBED_MODEL = "BAAI/bge-small-en-v1.5"

# BGE models were trained to see this prefix on *queries* (not on documents).
# Short questions and long passages look different; the prefix tells the
# model "this is a question looking for an answer".
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


def collection_name(model: str = EMBED_MODEL) -> str:
    """One collection per model, so experiments with other models don't collide."""
    return "vu_" + re.sub(r"[^a-z0-9]+", "_", model.lower()).strip("_")

# Local LLM served by Ollama (https://ollama.com). Small enough for a MacBook Air.
LLM_MODEL = "qwen2.5:7b"    
OLLAMA_URL = "http://localhost:11434"

# Retrieval: "dense" (embeddings), "bm25" (keywords) or "hybrid" (both, fused with RRF).
RETRIEVAL_MODE = "rerank"
CANDIDATES = 20   # in hybrid mode, how many results each method contributes before fusing
RRF_K = 60        # RRF smoothing constant (60 is the standard value from the original paper)
   # Cross-encoder used in "rerank" mode (~1.1 GB, downloaded on first use).
RERANK_MODEL = "BAAI/bge-reranker-base"
# In "rerank" mode: if no general rule (TER) is in the top-k, swap the last result
# for the best-ranked TER chunk. Set to True to try it.
RESERVE_TER_SLOT = True