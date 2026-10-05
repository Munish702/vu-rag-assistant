"""
app.py - a web interface for the VU study assistant (Streamlit).

Run from the project root:
    streamlit run src/app.py
or double-click start.command (macOS).
"""

import re

import streamlit as st

from config import LLM_MODEL, RERANK_MODEL, RETRIEVAL_MODE
from generate import NOT_FOUND, SYSTEM_PROMPT, build_prompt, call_llm, scope_label
from retrieve import retrieve

EXAMPLES = [
    "Can I resit an exam I already passed?",
    "How is Deep Learning graded?",
    "When can I start my master project?",
    "What IELTS score do I need?",
]

st.set_page_config(page_title="VU AI master study assistant", page_icon="🎓", layout="centered")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def md_safe(text: str) -> str:
    """Stop Streamlit treating '$' as maths and single newlines as spaces."""
    return text.replace("$", "\\$").replace("\n", "  \n")


def scope_tag(meta: dict) -> str:
    """Short, user-friendly version of the scope label the LLM sees."""
    label = scope_label(meta)
    if label.startswith("General"):
        return "General rule"
    if label.startswith("Course-specific"):
        return f"Course rule: {meta.get('course_name', '')}"
    return "Programme overview"


@st.cache_resource(show_spinner="Loading the search models. The first start takes about a minute...")
def warm_up() -> bool:
    """Load the embedding model, index and reranker once, before the first question."""
    retrieve("warm up", k=1)
    return True


def ask(question: str) -> dict:
    """Run the full pipeline and package everything the UI needs to show."""
    with st.spinner("Searching the study guide and regulations..."):
        hits = retrieve(question, k=5)
    with st.spinner("Writing the answer..."):
        text = call_llm(SYSTEM_PROMPT, build_prompt(question, hits))

    cited = {int(n) for n in re.findall(r"\[(\d+)\]", text)}
    sources = []
    for n, hit in enumerate(hits, start=1):
        title, _, body = hit["text"].partition("\n")
        sources.append({
            "n": n,
            "title": title,
            "body": body,
            "tag": scope_tag(hit["metadata"]),
            "url": hit["metadata"].get("source_url", ""),
            "cited": n in cited,
        })
    return {
        "role": "assistant",
        "content": text,
        "abstained": NOT_FOUND.lower().rstrip(".") in text.lower(),
        "sources": sources,
    }


def show_sources(sources: list[dict]) -> None:
    """The receipts: cited sources first, each expandable to the exact text."""
    used = [s for s in sources if s["cited"]]
    other = [s for s in sources if not s["cited"]]

    def show(s):
        with st.expander(f"[{s['n']}] {s['title']}  ({s['tag']})"):
            st.markdown(md_safe(s["body"]))
            if s["url"]:
                st.markdown(f"[Open the original document]({s['url']})")

    if used:
        st.caption("Sources used in this answer")
        for s in used:
            show(s)
    if other:
        with st.expander(f"Other passages that were searched ({len(other)})"):
            for s in other:
                st.markdown(f"**[{s['n']}] {s['title']}** ({s['tag']})")
                st.markdown(md_safe(s["body"]))
                st.divider()


def show_message(msg: dict) -> None:
    with st.chat_message(msg["role"]):
        st.markdown(md_safe(msg["content"]))
        if msg["role"] == "assistant":
            if msg.get("abstained"):
                st.caption("Try rephrasing your question, or ask your academic adviser. "
                           "This assistant only knows the 2026-2027 study guide and exam regulations.")
            show_sources(msg.get("sources", []))


# --------------------------------------------------------------------------
# Page
# --------------------------------------------------------------------------
with st.sidebar:
    st.subheader("About")
    st.write("Answers come only from the 2026-2027 study guides and the Teaching and "
             "Examination Regulations of the MSc Artificial Intelligence at VU Amsterdam. "
             "Every answer shows the passages it is based on.")
    st.warning("This is not official advice. Always check the cited source or ask your "
               "academic adviser before making decisions.")
    if st.button("Start a new conversation"):
        st.session_state.messages = []
        st.rerun()
    with st.expander("Technical details"):
        st.markdown(
            f"- Retrieval: `{RETRIEVAL_MODE}`\n"
            f"- Reranker: `{RERANK_MODEL}`\n"
            f"- Language model: `{LLM_MODEL}` (runs locally)"
        )

st.title("VU AI master study assistant")
st.write("Ask about exams, resits, admission or courses. "
         "Answers come with the exact passages they're based on.")

try:
    warm_up()
except Exception as e:  # e.g. the index hasn't been built yet
    st.error(f"The search index couldn't be loaded: {e}\n\n"
             "Build it first with `python src/ingest.py` and `python src/index.py`.")
    st.stop()

if "messages" not in st.session_state:
    st.session_state.messages = []

for msg in st.session_state.messages:
    show_message(msg)

# Empty state: offer example questions instead of a blank page.
clicked = None
if not st.session_state.messages:
    st.caption("Try one of these")
    cols = st.columns(2)
    for i, example in enumerate(EXAMPLES):
        if cols[i % 2].button(example, key=f"example-{i}"):
            clicked = example

question = st.chat_input("Ask a question, e.g. Can I resit an exam I already passed?") or clicked

if question:
    user_msg = {"role": "user", "content": question}
    st.session_state.messages.append(user_msg)
    show_message(user_msg)
    try:
        reply = ask(question)
    except SystemExit as e:  # call_llm exits with a readable message if Ollama is unreachable
        st.error(f"{e}\n\nOpen the Ollama app and try again.")
        st.session_state.messages.pop()
        st.stop()
    st.session_state.messages.append(reply)
    show_message(reply)
