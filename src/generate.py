"""
generate.py - answer a question using retrieved chunks and a local LLM (Ollama).

Pipeline:  question -> retrieve top-k chunks -> build prompt -> LLM -> answer with [n] citations

Use it from code:
    from generate import answer
    result = answer("Can I resit an exam I already passed?")
    print(result["answer"])

Or from the terminal (project root):
    python src/generate.py "Can I resit an exam I already passed?"
    python src/generate.py "How is Deep Learning graded?" --show-prompt
"""

import argparse
import json
import urllib.error
import urllib.request

from config import LLM_MODEL, OLLAMA_URL
from retrieve import retrieve

NOT_FOUND = "I couldn't find this in the VU documents."

SYSTEM_PROMPT = f"""You are a study adviser assistant for the MSc Artificial Intelligence at Vrije Universiteit Amsterdam.
Answer the student's question using ONLY the numbered sources provided.

Each source is labelled with its scope:
- "General programme rule" sources apply to every student and every course.
- "Course-specific" sources apply ONLY to the course named. Use them only when the question is about that course.

Rules:
- Include any condition or consequence that changes what the student should do (e.g. which grade counts).
- Use only facts stated in the sources. Never guess. Ignore irrelevant sources silently.
- Cite the source number after every claim, e.g. [1] or [2][3].
- If the sources do not contain the answer, reply exactly: "{NOT_FOUND}"
- Be concise: 1-4 sentences, addressed to the student ("you")."""


def scope_label(meta: dict) -> str:
    """Tell the model how widely a source applies - it can't know this from the text alone."""
    if meta.get("doc_type") == "ter":
        return "General programme rule: applies to all courses"
    if meta.get("course_name"):
        return f"Course-specific: applies only to {meta['course_name']}"
    return "Programme overview"


def build_prompt(question: str, hits: list[dict]) -> str:
    """Number each chunk so the model can cite it as [1], [2], ..., and label its scope."""
    sources = "\n\n".join(
        f"[{n}] ({scope_label(hit['metadata'])})\n{hit['text']}"
        for n, hit in enumerate(hits, start=1)
    )
    return f"Sources:\n\n{sources}\n\nQuestion: {question}\nAnswer:"


def call_llm(system: str, user: str, model: str = LLM_MODEL) -> str:
    """Send one chat request to the local Ollama server (no extra libraries needed)."""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "options": {"temperature": 0},  # no creativity: same question -> same answer
    }
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read())["message"]["content"].strip()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Ollama error {e.code}: {e.read().decode()}\n"
                         f"Did you run: ollama pull {model} ?")
    except urllib.error.URLError:
        raise SystemExit(f"Can't reach Ollama at {OLLAMA_URL}. Is the Ollama app running?")


def answer(question: str, k: int = 5) -> dict:
    hits = retrieve(question, k=k)
    prompt = build_prompt(question, hits)
    text = call_llm(SYSTEM_PROMPT, prompt)
    return {
        "question": question,
        "answer": text,
        "abstained": NOT_FOUND.lower().rstrip(".") in text.lower(),
        "prompt": prompt,
        "sources": [
            {
                "n": n,
                "id": hit["id"],
                "title": hit["text"].split("\n", 1)[0],
                "score": round(hit["score"], 3),
                "url": hit["metadata"].get("source_url", ""),
            }
            for n, hit in enumerate(hits, start=1)
        ],
    }


def main():
    parser = argparse.ArgumentParser(description="Ask the VU assistant a question.")
    parser.add_argument("question", help="your question, in quotes")
    parser.add_argument("--k", type=int, default=5, help="number of chunks to give the LLM")
    parser.add_argument("--show-prompt", action="store_true", help="print the full prompt sent to the LLM")
    args = parser.parse_args()

    result = answer(args.question, k=args.k)
    if args.show_prompt:
        print("=" * 70 + "\nPROMPT\n" + "=" * 70)
        print(SYSTEM_PROMPT + "\n\n" + result["prompt"] + "\n")
    print("\n" + result["answer"] + "\n")
    print("Sources:")
    for s in result["sources"]:
        print(f"  [{s['n']}] {s['title']}  (score {s['score']})")


if __name__ == "__main__":
    main()
