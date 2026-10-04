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
