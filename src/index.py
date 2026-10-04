"""
index.py - embed every chunk and store it in a local ChromaDB vector store.

Input : data/processed/chunks.jsonl   (from ingest.py)
Output: data/index/                   (ChromaDB files on disk)

Run from the project root:
    python src/index.py
Re-running rebuilds the collection from scratch.
"""

import json
import time

import chromadb
from sentence_transformers import SentenceTransformer

from config import CHUNKS_FILE, EMBED_MODEL, INDEX_DIR, collection_name

BATCH = 1000  # how many chunks to hand to Chroma at once


def load_chunks() -> list[dict]:
    with open(CHUNKS_FILE, encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def main():
    chunks = load_chunks()
    print(f"Loaded {len(chunks)} chunks from {CHUNKS_FILE.name}")

    # 1) Embed: turn each chunk's text into a vector ("GPS coordinates for meaning").
    #    normalize_embeddings=True makes every vector length 1, so cosine
    #    similarity is just a dot product.
    print(f"Embedding with {EMBED_MODEL} (first run downloads the model)...")
    model = SentenceTransformer(EMBED_MODEL)
    start = time.time()
    embeddings = model.encode(
        [c["text"] for c in chunks],
        batch_size=32,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    print(f"Embedded {len(chunks)} chunks in {time.time() - start:.1f}s "
          f"-> vectors of size {embeddings.shape[1]}")

    # 2) Store: put vectors + text + metadata into a persistent Chroma collection.
    client = chromadb.PersistentClient(path=str(INDEX_DIR))
    name = collection_name()
    try:
        client.delete_collection(name)  # rebuild from scratch each run
    except Exception:
        pass
    collection = client.create_collection(name, metadata={"hnsw:space": "cosine"})

    for i in range(0, len(chunks), BATCH):
        batch = chunks[i:i + BATCH]
        collection.add(
            ids=[c["id"] for c in batch],
            embeddings=embeddings[i:i + BATCH].tolist(),
            documents=[c["text"] for c in batch],
            metadatas=[c["metadata"] for c in batch],
        )

    print(f"Stored {collection.count()} chunks in collection '{name}' at "
          f"{INDEX_DIR.relative_to(INDEX_DIR.parents[1])}/")


if __name__ == "__main__":
    main()
