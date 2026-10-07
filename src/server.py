"""
server.py - run the website on your own computer, with live answers.

Run from the project root:
    python src/server.py                 opens http://127.0.0.1:8000
    python src/server.py --port 8080     use another port
    python src/server.py --no-browser    don't open a browser tab
or double-click start.command (macOS).

It serves the static site in web/ and answers its chat with the same pipeline as
generate.py: dense + BM25 candidates, the cross-encoder reranker, the reserved
general-rule slot, then the local LLM through Ollama. Nothing leaves this
computer. Without this server (for example on GitHub Pages) the page replays a few
recorded answers instead, and labels them as recorded.

API (JSON, local only):
    GET  /api/health      -> {"ok": true, "ready": ..., "llm": ..., "retrieval": ...}
    POST /api/ask         {"question": "..."} -> a stream of JSON lines:
                          step, sources, token ..., then done (or error)
    POST /api/follow-ups  {"question", "answer", "ids"} -> {"questions": [...]}
    POST /api/feedback    {"rating", "question", "answer", "sources"} -> {"ok": true}
                          appended to data/feedback.jsonl, same format as the Streamlit app
"""

import argparse
import json
import re
import sys
import threading
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from config import CANDIDATES, LLM_MODEL, OLLAMA_URL, RESERVE_TER_SLOT, RETRIEVAL_MODE, ROOT
from generate import NOT_FOUND, SYSTEM_PROMPT, build_prompt, call_llm, scope_label
from retrieve import (_bm25, bm25_search, dense_search, merge_candidates, rerank,
                      reserve_ter_slot, retrieve)

WEB_DIR = ROOT / "web"
FEEDBACK_FILE = ROOT / "data" / "feedback.jsonl"
TOP_K = 5
MAX_QUESTION = 500          # characters
MAX_BODY = 64 * 1024        # bytes per request

MODELS = threading.Lock()   # one question at a time through the models
FEEDBACK = threading.Lock()
READY = threading.Event()   # set once the search models are loaded
WARM_ERROR: list[str] = []


def warm_up() -> None:
    """Load the embedding model, the index and the reranker before the first question."""
    try:
        with MODELS:
            retrieve("warm up", k=1)
    except Exception as e:  # e.g. the index hasn't been built yet
        WARM_ERROR.append(str(e))
    finally:
        READY.set()


# --------------------------------------------------------------------------
# The pipeline, as visible steps (same logic as app.py and retrieve.py)
# --------------------------------------------------------------------------
def scope_tag(meta: dict) -> tuple[str, str]:
    """Short, user-friendly version of the scope label the LLM sees, plus its colour class."""
    label = scope_label(meta)
    if label.startswith("General"):
        return "General rule", "general"
    if label.startswith("Course-specific"):
        return f"Course rule: {meta.get('course_name', '')}", "course"
    return "Programme overview", "overview"


def package(n: int, hit: dict) -> dict:
    title, _, body = hit["text"].partition("\n")
    tag, kind = scope_tag(hit["metadata"])
    return {"n": n, "id": hit["id"], "title": title, "body": body, "tag": tag, "kind": kind,
            "url": hit["metadata"].get("source_url", "")}


def stream_llm(system: str, user: str):
    """Yield the answer piece by piece as Ollama writes it (same settings as generate.py)."""
    payload = {
        "model": LLM_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "stream": True,
        "options": {"temperature": 0, "num_ctx": 8192},
    }
    request = urllib.request.Request(f"{OLLAMA_URL}/api/chat", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        for line in response:
            if not line.strip():
                continue
            chunk = json.loads(line)
            piece = chunk.get("message", {}).get("content", "")
            if piece:
                yield piece
            if chunk.get("done"):
                break


def step(text: str) -> dict:
    return {"type": "step", "text": text}


def ask_events(question: str):
    """Yield the events of one answer, in order, as dicts."""
    if not READY.wait(timeout=600):
        yield {"type": "error", "text": "The search models are still loading. Try again in a minute."}
        return
    if WARM_ERROR:
        yield {"type": "error", "text": f"The search index couldn't be loaded ({WARM_ERROR[0]}). "
                                        "Build it first with python src/ingest.py and python src/index.py."}
        return

    pieces: list[str] = []
    with MODELS:
        try:
            if RETRIEVAL_MODE == "rerank":
                n_chunks = len(_bm25()[0])
                yield step(f"Searching {n_chunks:,} passages by meaning and by keywords")
                candidates = merge_candidates(dense_search(question, CANDIDATES),
                                              bm25_search(question, CANDIDATES))
                yield step(f"Reranking {len(candidates)} candidates by reading each one with your question")
                ranked = rerank(question, candidates)
                top = ranked[:TOP_K]
                if RESERVE_TER_SLOT:
                    top = reserve_ter_slot(top, ranked[TOP_K:])
                n_rules = sum(1 for h in top if h["metadata"].get("doc_type") == "ter")
                yield step(f"Picked the {len(top)} best passages, including {n_rules} general "
                           f"rule{'s' if n_rules != 1 else ''}")
                summary = f"Searched {n_chunks:,} passages, reranked {len(candidates)}, used {len(top)}"
            else:
                yield step("Searching the study guide and regulations")
                top = retrieve(question, k=TOP_K)
                summary = f"Found {len(top)} relevant passages"
        except Exception as e:
            yield {"type": "error", "text": f"The search failed: {e}"}
            return

        yield {"type": "sources", "summary": summary,
               "sources": [package(n, hit) for n, hit in enumerate(top, start=1)]}

        try:
            for piece in stream_llm(SYSTEM_PROMPT, build_prompt(question, top)):
                pieces.append(piece)
                yield {"type": "token", "text": piece}
        except urllib.error.HTTPError as e:  # must come first: HTTPError is a kind of URLError
            yield {"type": "error", "text": f"The language model returned an error ({e.code}). "
                                            f"Check that it's installed: ollama pull {LLM_MODEL}"}
            return
        except (urllib.error.URLError, OSError):
            yield {"type": "error", "text": f"Can't reach the language model at {OLLAMA_URL}. "
                                            "Open the Ollama app and try again."}
            return

    text = "".join(pieces).strip()
    yield {"type": "done", "answer": text,
           "abstained": NOT_FOUND.lower().rstrip(".") in text.lower(),
           "cited": sorted({int(n) for n in re.findall(r"\[(\d+)\]", text)})}


_CHUNKS: dict = {}


def follow_ups(question: str, answer: str, ids: list[str]) -> list[str]:
    """Ask the LLM for 2 short follow-up questions that the same sources can answer."""
    if not _CHUNKS:
        _CHUNKS.update({c["id"]: c for c in _bm25()[0]})
    hits = [_CHUNKS[i] for i in ids if i in _CHUNKS][:TOP_K]
    if not hits:
        return []
    sources = "\n\n".join(h["text"][:1200] for h in hits)
    prompt = (f"Sources:\n{sources}\n\nA student asked: {question}\nThe answer was: {answer}\n\n"
              "Write 2 short follow-up questions (at most 12 words each) the student might ask next, "
              "which these sources can answer. One question per line. No numbering, no quotes.")
    try:
        text = call_llm("You suggest helpful follow-up questions for university students.", prompt)
    except SystemExit:  # call_llm exits on connection errors; a follow-up is optional
        return []
    questions = []
    for line in text.splitlines():
        line = re.sub(r"^[\s\-\*\d\.\)•]+", "", line).strip().strip('"')
        if line.endswith("?") and 3 <= len(line.split()) <= 16:
            questions.append(line)
    return questions[:2]


def log_feedback(data: dict) -> None:
    rating = data.get("rating")
    record = {
        "time": datetime.now().isoformat(timespec="seconds"),
        "rating": rating if rating in ("up", "down") else "cleared",
        "question": str(data.get("question", ""))[:2000],
        "answer": str(data.get("answer", ""))[:8000],
        "sources": [str(s) for s in data.get("sources") or []][:20],
        "llm": LLM_MODEL,
        "retrieval": RETRIEVAL_MODE,
        "reserve_ter_slot": RESERVE_TER_SLOT,
    }
    FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with FEEDBACK, open(FEEDBACK_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    server_version = "StudyAssistant/1.0"
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp",
                      ".svg": "image/svg+xml", ".woff2": "font/woff2"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, format, *args):  # keep the terminal readable
        pass

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") else "no-cache")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    # Only answer pages this server served itself: the Host must be this computer
    # (stops DNS rebinding) and a cross-site page can't post to the API.
    def _local(self) -> bool:
        host = self.headers.get("Host", "")
        name = host.rsplit(":", 1)[0] if ":" in host else host
        if name not in ("127.0.0.1", "localhost"):
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin == f"http://{host}"

    def _json(self, obj, status=HTTPStatus.OK) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return None
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            data = None
        if not isinstance(data, dict):
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected a JSON object")
            return None
        return data

    def do_GET(self):
        if not self._local():
            return self.send_error(HTTPStatus.FORBIDDEN)
        route = self.path.split("?", 1)[0]
        if route in ("/api/health", "/api/health.json"):
            return self._json({"ok": True, "live": True, "ready": READY.is_set() and not WARM_ERROR,
                               "error": WARM_ERROR[0] if WARM_ERROR else None,
                               "llm": LLM_MODEL, "retrieval": RETRIEVAL_MODE})
        if route.startswith("/api/"):
            return self.send_error(HTTPStatus.NOT_FOUND)
        return super().do_GET()

    def do_HEAD(self):
        if not self._local() or self.path.startswith("/api/"):
            return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
        return super().do_HEAD()

    def do_POST(self):
        if not self._local():
            return self.send_error(HTTPStatus.FORBIDDEN)
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return self.send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        data = self._read_json()
        if data is None:
            return
        route = self.path.split("?", 1)[0]
        if route == "/api/ask":
            return self._ask(data)
        if route == "/api/follow-ups":
            ids = [str(i) for i in data.get("ids") or []][:TOP_K]
            return self._json({"questions": follow_ups(str(data.get("question", ""))[:MAX_QUESTION],
                                                       str(data.get("answer", ""))[:4000], ids)})
        if route == "/api/feedback":
            log_feedback(data)
            return self._json({"ok": True})
        self.send_error(HTTPStatus.NOT_FOUND)

    def _ask(self, data: dict) -> None:
        question = " ".join(str(data.get("question", "")).split())[:MAX_QUESTION]
        if not question:
            return self._json({"error": "Ask a question first."}, HTTPStatus.BAD_REQUEST)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.end_headers()
        self.close_connection = True  # the stream ends when the connection closes
        try:
            for event in ask_events(question):
                self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the tab was closed mid-answer


def main():
    parser = argparse.ArgumentParser(description="Run the study assistant website on this computer.")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default 8000)")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = parser.parse_args()

    if not (WEB_DIR / "index.html").exists():
        sys.exit(f"Can't find the website at {WEB_DIR}. Run this from the project folder.")

    server = None
    for port in range(args.port, args.port + 10):  # the next free port, if this one is taken
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if server is None:
        sys.exit(f"Ports {args.port}-{args.port + 9} are all in use. Try --port with another number.")

    url = f"http://127.0.0.1:{server.server_address[1]}"
    threading.Thread(target=warm_up, daemon=True).start()
    print(f"Study assistant running at {url}")
    print("Loading the search models in the background (about a minute the first time).")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
