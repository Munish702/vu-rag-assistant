"""
app.py - a web interface for the VU study assistant (Streamlit).

Run from the project root:
    streamlit run src/app.py
or double-click start.command (macOS).

Visual design lives in src/app_style.css. Optional background photo: assets/background.jpg.
Thumbs up/down feedback is logged to data/feedback.jsonl.
"""

import base64
import html
import json
import re
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

from config import (CANDIDATES, LLM_MODEL, OLLAMA_URL, RERANK_MODEL, RESERVE_TER_SLOT,
                    RETRIEVAL_MODE, ROOT)
from generate import NOT_FOUND, SYSTEM_PROMPT, build_prompt, call_llm, scope_label
from retrieve import (_bm25, bm25_search, dense_search, merge_candidates, rerank,
                      reserve_ter_slot, retrieve)

# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
# Switch heavier effects on or off.
EFFECTS = {
    "follow_ups": True,          # suggest 2 follow-up questions after each answer (one extra LLM call)
    "background_zoom": True,     # very slow zoom on the background photo
    "travelling_border": True,   # light beam that travels around cards on hover
}

EXAMPLES = {
    ":material/edit_note: Exams": [
        "Can I resit an exam I already passed?",
        "How quickly do I get my exam results?",
    ],
    ":material/how_to_reg: Admission": [
        "What IELTS score do I need?",
        "Can I get in with a Computer Science bachelor?",
    ],
    ":material/menu_book: Courses": [
        "How is Deep Learning graded?",
        "When can I start my master project?",
    ],
}

STYLE_FILE = Path(__file__).with_name("app_style.css")
FEEDBACK_FILE = ROOT / "data" / "feedback.jsonl"
BACKGROUND = ROOT / "assets" / "background.jpg"
BACKGROUND_OPACITY = 0.45  # how visible the campus photo is behind the glass (0-1)
BACKGROUND_CREDIT = (
    'Background: <a href="https://commons.wikimedia.org/wiki/File:Amsterdam_VU_-_panoramio_-_Rokus_Cornelis_(2).jpg">'
    'Amsterdam VU</a> by Rokus Cornelis, '
    '<a href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</a>, '
    'via Wikimedia Commons (darkened and blurred)'
)
USER_AVATAR = ":material/person:"
ASSISTANT_AVATAR = ":material/school:"
TOP_K = 5

# Small inline icons (original, simple outlines) for the source tags.
ICONS = {
    "general": '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
               'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
               '<path d="M2 6 8 2.5 14 6"/><path d="M3.5 7v5M6.5 7v5M9.5 7v5M12.5 7v5"/>'
               '<path d="M2 13.5h12"/></svg>',
    "course": '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
              'stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 3h4.2c.7 0 1.3.6 1.3 1.3V13'
              'c0-.6-.5-1-1.1-1H2.5z"/><path d="M13.5 3H9.3C8.6 3 8 3.6 8 4.3V13c0-.6.5-1 1.1-1h4.4z"/></svg>',
    "overview": '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
                'stroke-width="1.4" stroke-linecap="round"><path d="M3 4h10M3 8h10M3 12h6"/></svg>',
    "check": '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
             'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
}

st.set_page_config(page_title="VU AI master study assistant", page_icon="🎓", layout="centered")


# --------------------------------------------------------------------------
# Styling
# --------------------------------------------------------------------------
def page_css() -> str:
    css = STYLE_FILE.read_text(encoding="utf-8")
    if BACKGROUND.exists():
        data = base64.b64encode(BACKGROUND.read_bytes()).decode()
        css += f"""
.stApp::before {{
  content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background: url("data:image/jpeg;base64,{data}") center / cover no-repeat;
  opacity: {BACKGROUND_OPACITY}; filter: blur(3px) saturate(0.45) brightness(0.6);
}}
[data-testid="stAppViewContainer"] {{ position: relative; z-index: 1; background: transparent; }}
"""
        if EFFECTS["background_zoom"]:
            css += """
@media (prefers-reduced-motion: no-preference) {
  .stApp::before { animation: vu-zoom 40s ease-in-out infinite alternate; }
}
"""
    if not EFFECTS["travelling_border"]:
        css += '\n[data-testid="stChatMessage"]::before, .stButton > button::before { display: none; }\n'
    return f"<style>{css}</style>"


st.markdown(page_css(), unsafe_allow_html=True)


# --------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------
def md_safe(text: str) -> str:
    """For plain markdown: stop '$' becoming maths and single newlines collapsing."""
    return text.replace("$", "\\$").replace("\n", "  \n")


def html_safe(text: str) -> str:
    """For text placed inside our own HTML: escape it, keep '$' literal, keep line breaks."""
    return html.escape(text, quote=False).replace("$", "\\$").replace("\n", "  \n")


def answer_html(text: str, sources: list[dict], mid: str) -> str:
    """Turn [1], [2] in the answer into glowing chips that jump to their source card."""
    titles = {s["n"]: s["title"] for s in sources}

    def chip(match):
        n = int(match.group(1))
        if n not in titles:
            return match.group(0)
        return (f'<a class="vu-cite" href="#src-{mid}-{n}" '
                f'title="{html.escape(titles[n])}">{n}</a>')

    return re.sub(r"\[(\d+)\]", chip, html_safe(text))


def scope_tag(meta: dict) -> tuple[str, str]:
    """Short, user-friendly version of the scope label the LLM sees, plus its colour class."""
    label = scope_label(meta)
    if label.startswith("General"):
        return "General rule", "general"
    if label.startswith("Course-specific"):
        return f"Course rule: {meta.get('course_name', '')}", "course"
    return "Programme overview", "overview"


def tag_html(s: dict) -> str:
    return f'<span class="vu-tag {s["kind"]}">{ICONS[s["kind"]]}{html.escape(s["tag"])}</span>'


def body_html(s: dict) -> str:
    paragraphs = "".join(f"<p>{html.escape(p)}</p>" for p in s["body"].split("\n") if p.strip())
    link = (f'<a class="vu-doc-link" href="{html.escape(s["url"])}" target="_blank" rel="noopener">'
            "Open the original document</a>") if s["url"] else ""
    return f"{tag_html(s)}{paragraphs}{link}"


# --------------------------------------------------------------------------
# Pipeline (same logic as retrieve.py's rerank mode, split into visible steps)
# --------------------------------------------------------------------------
@st.cache_resource(show_spinner="Loading the search models. The first start takes about a minute...")
def warm_up() -> bool:
    retrieve("warm up", k=1)
    return True


def retrieve_with_steps(question: str, status) -> tuple[list[dict], str]:
    """Run retrieval while narrating each stage in the status box. Returns (hits, summary)."""
    if RETRIEVAL_MODE != "rerank":
        status.write("Searching the study guide and regulations")
        hits = retrieve(question, k=TOP_K)
        return hits, f"Found {len(hits)} relevant passages"

    n_chunks = len(_bm25()[0])
    status.write(f"Searching {n_chunks:,} passages by meaning and by keywords")
    candidates = merge_candidates(dense_search(question, CANDIDATES), bm25_search(question, CANDIDATES))
    status.write(f"Reranking {len(candidates)} candidates by reading each one with your question")
    ranked = rerank(question, candidates)
    top = ranked[:TOP_K]
    if RESERVE_TER_SLOT:
        top = reserve_ter_slot(top, ranked[TOP_K:])
    n_rules = sum(1 for h in top if h["metadata"].get("doc_type") == "ter")
    status.write(f"Picked the {len(top)} best passages, including {n_rules} general "
                 f"rule{'s' if n_rules != 1 else ''}")
    return top, f"Searched {n_chunks:,} passages, reranked {len(candidates)}, used {len(top)}"


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


def suggest_follow_ups(question: str, answer: str, hits: list[dict]) -> list[str]:
    """Ask the LLM for 2 short follow-up questions that the retrieved sources can answer."""
    sources = "\n\n".join(h["text"][:1200] for h in hits)
    prompt = (f"Sources:\n{sources}\n\nA student asked: {question}\nThe answer was: {answer}\n\n"
              "Write 2 short follow-up questions (at most 12 words each) the student might ask next, "
              "which these sources can answer. One question per line. No numbering, no quotes.")
    try:
        text = call_llm("You suggest helpful follow-up questions for university students.", prompt)
    except SystemExit:
        return []
    questions = []
    for line in text.splitlines():
        line = re.sub(r"^[\s\-\*\d\.\)•]+", "", line).strip().strip('"')
        if line.endswith("?") and 3 <= len(line.split()) <= 16:
            questions.append(line)
    return questions[:2]


def package_sources(hits: list[dict], answer: str) -> list[dict]:
    cited = {int(n) for n in re.findall(r"\[(\d+)\]", answer)}
    sources = []
    for n, hit in enumerate(hits, start=1):
        title, _, body = hit["text"].partition("\n")
        tag, kind = scope_tag(hit["metadata"])
        sources.append({"n": n, "id": hit["id"], "title": title, "body": body, "tag": tag, "kind": kind,
                        "url": hit["metadata"].get("source_url", ""), "cited": n in cited})
    return sources


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------
def sources_html(sources: list[dict], mid: str) -> str:
    """The receipts: cited sources as cards that cascade in, the rest folded away."""
    used = [s for s in sources if s["cited"]]
    other = [s for s in sources if not s["cited"]]
    parts = []
    if used:
        parts.append('<div class="vu-label">Sources used in this answer</div>')
        for i, s in enumerate(used):
            parts.append(
                f'<div class="vu-src-wrap" style="animation-delay:{i * 80}ms">'
                f'<details class="vu-src" id="src-{mid}-{s["n"]}">'
                f'<summary><span class="vu-src-n">{s["n"]}</span><span>{html.escape(s["title"])}</span></summary>'
                f'<div class="vu-src-body">{body_html(s)}</div></details></div>'
            )
    if other:
        items = "".join(
            f'<div class="vu-other-item"><strong>[{s["n"]}] {html.escape(s["title"])}</strong>'
            f'<div style="margin-top:0.5rem">{body_html(s)}</div></div>'
            for s in other
        )
        parts.append(
            f'<div class="vu-src-wrap" style="animation-delay:{len(used) * 80}ms">'
            f'<details class="vu-src"><summary>Other passages that were searched ({len(other)})</summary>'
            f'<div class="vu-src-body">{items}</div></details></div>'
        )
    return "".join(parts)


def copy_button(text: str) -> None:
    """A small 'Copy answer' button. Runs in its own frame because copying needs JavaScript."""
    components.html(
        f"""
<button id="b" aria-label="Copy answer">Copy answer</button>
<style>
  body {{ margin: 0; background: transparent; }}
  #b {{ font: 14px system-ui, -apple-system, sans-serif; color: #A9CBEB; background: rgba(14, 28, 42, 0.55);
        border: 1px solid rgba(142, 187, 230, 0.55); border-radius: 10px; padding: 6px 12px; cursor: pointer;
        transition: background 0.25s, color 0.25s, box-shadow 0.25s; }}
  #b:hover {{ background: #3375AE; color: #fff; box-shadow: 0 0 12px rgba(91, 155, 213, 0.7); }}
</style>
<script>
  const text = {json.dumps(text)};
  const b = document.getElementById("b");
  function done() {{ b.textContent = "Copied ✓"; setTimeout(() => b.textContent = "Copy answer", 1500); }}
  function fallback() {{
    const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t);
    t.select(); document.execCommand("copy"); t.remove(); done();
  }}
  b.onclick = () => navigator.clipboard ? navigator.clipboard.writeText(text).then(done, fallback) : fallback();
</script>
""",
        height=40,
    )


def log_feedback(idx: int) -> None:
    """Called when a thumb is clicked: append the rating and full context to data/feedback.jsonl."""
    rating = st.session_state.get(f"fb-{idx}")
    msg = st.session_state.messages[idx]
    record = {
        "time": datetime.now().isoformat(timespec="seconds"),
        "rating": {0: "down", 1: "up"}.get(rating, "cleared"),
        "question": msg.get("question", ""),
        "answer": msg["content"],
        "sources": [s["id"] for s in msg.get("sources", [])],
        "llm": LLM_MODEL,
        "retrieval": RETRIEVAL_MODE,
        "reserve_ter_slot": RESERVE_TER_SLOT,
    }
    FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(FEEDBACK_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def set_pending(question: str) -> None:
    st.session_state.pending = question


def show_actions(msg: dict, idx: int) -> None:
    """Thumbs up/down + copy button under an answer."""
    left, right, _ = st.columns([1.1, 1.6, 4], vertical_alignment="center")
    with left:
        st.feedback("thumbs", key=f"fb-{idx}", on_change=log_feedback, args=(idx,))
    with right:
        copy_button(msg["content"])


def show_follow_ups(questions: list[str], idx: int) -> None:
    if questions:
        st.markdown('<div class="vu-label">You could also ask</div>', unsafe_allow_html=True)
        for j, q in enumerate(questions):
            st.button(q, key=f"fu-{idx}-{j}", icon=":material/subdirectory_arrow_right:",
                      on_click=set_pending, args=(q,))


def show_assistant_extras(msg: dict, idx: int, latest: bool) -> None:
    if msg.get("abstained"):
        st.caption("Try rephrasing your question, or ask your academic adviser. "
                   "This assistant only knows the 2026-2027 study guide and exam regulations.")
    st.markdown(sources_html(msg["sources"], f"m{idx}"), unsafe_allow_html=True)
    show_actions(msg, idx)
    if latest:
        show_follow_ups(msg.get("follow_ups", []), idx)


def show_message(msg: dict, idx: int, latest: bool) -> None:
    """Re-draw a message from the history."""
    avatar = USER_AVATAR if msg["role"] == "user" else ASSISTANT_AVATAR
    with st.chat_message(msg["role"], avatar=avatar):
        if msg["role"] == "user":
            st.markdown(md_safe(msg["content"]))
            return
        if msg.get("steps"):
            st.markdown(f'<div class="vu-steps">{ICONS["check"]}{html.escape(msg["steps"])}</div>',
                        unsafe_allow_html=True)
        st.markdown(answer_html(msg["content"], msg["sources"], f"m{idx}"), unsafe_allow_html=True)
        show_assistant_extras(msg, idx, latest)


def answer_live(question: str, idx: int) -> dict | None:
    """Answer a new question: narrated retrieval, streamed answer with a caret, then the extras."""
    with st.chat_message("assistant", avatar=ASSISTANT_AVATAR):
        with st.status("Searching the study guide and regulations...", expanded=True) as status:
            hits, steps = retrieve_with_steps(question, status)
            status.update(label=steps, state="complete", expanded=False)

        placeholder = st.empty()
        pieces: list[str] = []
        try:
            for piece in stream_llm(SYSTEM_PROMPT, build_prompt(question, hits)):
                pieces.append(piece)
                placeholder.markdown(html_safe("".join(pieces)) + '<span class="vu-caret"></span>',
                                     unsafe_allow_html=True)
        except urllib.error.HTTPError as e:  # must come first: HTTPError is a kind of URLError
            placeholder.error(f"The language model returned an error ({e.code}). "
                              f"Check that it's installed: ollama pull {LLM_MODEL}")
            return None
        except urllib.error.URLError:
            placeholder.error(f"Can't reach the language model at {OLLAMA_URL}. "
                              "Open the Ollama app and try again.")
            return None

        text = "".join(pieces).strip()
        sources = package_sources(hits, text)
        placeholder.markdown(answer_html(text, sources, f"m{idx}"), unsafe_allow_html=True)
        msg = {"role": "assistant", "question": question, "content": text, "steps": steps,
               "abstained": NOT_FOUND.lower().rstrip(".") in text.lower(),
               "sources": sources, "follow_ups": []}
        st.session_state.messages.append(msg)  # stored now, so the feedback buttons can find it
        show_assistant_extras(msg, idx, latest=False)

        if EFFECTS["follow_ups"] and not msg["abstained"]:
            with st.spinner("Thinking of follow-up questions..."):
                msg["follow_ups"] = suggest_follow_ups(question, text, hits)
            show_follow_ups(msg["follow_ups"], idx)
    return msg


# --------------------------------------------------------------------------
# Page
# --------------------------------------------------------------------------
with st.sidebar:
    st.markdown(
        '<div class="vu-brand"><div class="mark">AI</div>'
        '<div class="name">AI master<br>study assistant</div></div>',
        unsafe_allow_html=True,
    )
    st.write("Answers come only from the 2026-2027 study guides and the Teaching and "
             "Examination Regulations of the MSc Artificial Intelligence at VU Amsterdam.")
    st.markdown(
        '<div class="vu-sidenote">Independent student project, not an official VU service. '
        "Check the cited source or ask your academic adviser before making decisions.</div>",
        unsafe_allow_html=True,
    )
    if st.button("Start a new conversation", icon=":material/add_comment:"):
        st.session_state.messages = []
        st.rerun()
    with st.expander("Technical details"):
        st.markdown(f"- Retrieval: `{RETRIEVAL_MODE}`\n"
                    f"- Reranker: `{RERANK_MODEL}`\n"
                    f"- Language model: `{LLM_MODEL}` (runs locally)")
    if BACKGROUND_CREDIT and BACKGROUND.exists():
        st.markdown(f'<div class="vu-credit">{BACKGROUND_CREDIT}</div>', unsafe_allow_html=True)

st.markdown(
    '<div class="vu-hero">'
    "<h1>Ask about exams, resits and courses</h1>"
    "<p>Answers come only from the 2026-2027 study guides and exam regulations of the "
    "MSc Artificial Intelligence, with the exact passages shown.</p>"
    '<p class="vu-note">Independent student project. Not an official VU Amsterdam service.</p>'
    "</div>",
    unsafe_allow_html=True,
)

try:
    warm_up()
except Exception as e:  # e.g. the index hasn't been built yet
    st.error(f"The search index couldn't be loaded: {e}\n\n"
             "Build it first with `python src/ingest.py` and `python src/index.py`.")
    st.stop()

if "messages" not in st.session_state:
    st.session_state.messages = []
pending = st.session_state.pop("pending", None)
question = st.chat_input("Ask a question, e.g. Can I resit an exam I already passed?") or pending

history = st.session_state.messages
for i, msg in enumerate(history):
    show_message(msg, i, latest=(i == len(history) - 1 and not question))

# Empty state: example questions by category. They disappear as soon as one is clicked.
if not history and not question:
    cols = st.columns(len(EXAMPLES))
    for col, (category, questions) in zip(cols, EXAMPLES.items()):
        with col:
            st.markdown(category)
            for j, q in enumerate(questions):
                st.button(q, key=f"ex-{category}-{j}", on_click=set_pending, args=(q,))

if question:
    user_msg = {"role": "user", "content": question}
    st.session_state.messages.append(user_msg)
    show_message(user_msg, len(st.session_state.messages) - 1, latest=False)
    if answer_live(question, idx=len(st.session_state.messages)) is None:
        st.session_state.messages.pop()  # don't keep a question that got no answer
