"""
ingest.py - turn raw VU PDFs into clean, metadata-rich chunks.

Input : data/raw/*.pdf + data/raw/manifest.csv
Output: data/processed/chunks.jsonl  (one chunk per line)

Two parsers, because the two document types are built differently:
  * study guide (studiegids) -> one chunk per course *section*
                                 (Method of Assessment, Course Content, ...)
  * TER / OER regulations     -> one chunk per *article*

Run from the project root:
    python src/ingest.py
"""

import csv
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
OUT_FILE = ROOT / "data" / "processed" / "chunks.jsonl"

MAX_WORDS = 350  # chunks longer than this get split at paragraph boundaries


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------
def normalize(text: str) -> str:
    """NFKC turns ligatures like 'ﬁ' into 'fi'; then tidy whitespace."""
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def split_long(body: str, max_words: int = MAX_WORDS) -> list[str]:
    """Pack paragraphs (lines) into pieces of at most ~max_words words."""
    if len(body.split()) <= max_words:
        return [body]
    pieces, current = [], []
    for line in body.split("\n"):
        if current and len(" ".join(current + [line]).split()) > max_words:
            pieces.append("\n".join(current))
            current = []
        current.append(line)
    if current:
        pieces.append("\n".join(current))
    return pieces


def make_chunks(header: str, body: str, base_id: str, meta: dict) -> list[dict]:
    """Prefix every piece with a header so each chunk is self-explanatory."""
    pieces = split_long(body.strip())
    chunks = []
    for i, piece in enumerate(pieces):
        suffix = f" (part {i + 1}/{len(pieces)})" if len(pieces) > 1 else ""
        chunks.append({
            "id": base_id + (f"-p{i + 1}" if len(pieces) > 1 else ""),
            "text": f"{header}{suffix}\n{piece}",
            "metadata": {**meta, "part": i + 1, "n_parts": len(pieces)},
        })
    return chunks


# --------------------------------------------------------------------------
# Study guide parser
# --------------------------------------------------------------------------
SG_FOOTER = re.compile(r"^Vrije Universiteit Amsterdam - .* Page \d+ of \d+$")
SG_HEADER = re.compile(r"^.+ - \d{4}-\d{4}$")  # e.g. "Artificial Intelligence - 2026-2027"

COURSE_FIELDS = [  # the metadata block right under each course title
    "Course Code", "Credits", "Period", "Course Level", "Language Of Tuition",
    "Faculty", "Course Coordinator", "Examiner", "Teaching Staff",
    "Teaching method(s)",
]
SECTION_HEADINGS = [
    "Course Objective", "Course Content", "Additional Information Teaching Methods",
    "Method of Assessment", "Entry Requirements", "Literature",
    "Additional Information Target Audience", "Recommended background knowledge",
    "Additional Information", "Custom Course Registration", "Explanation Canvas",
    "Use of Generative AI (GenAI)",
]
TOC_LINE = re.compile(r"\s\d{1,3}$")
TABLE_ROW = re.compile(r"\b\d+EC\b|^Course Name Period Credits Code$|^Ac\. Year$|^\(September\)$")


def read_study_guide_lines(path: Path) -> list[str]:
    """All lines of the PDF, minus repeated page headers/footers."""
    lines = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for line in (page.extract_text() or "").split("\n"):
                line = normalize(line)
                if not line or SG_FOOTER.match(line) or SG_HEADER.match(line):
                    continue
                lines.append(line)
    return lines


def parse_course(title: str, block: list[str], meta: dict) -> list[dict]:
    # 1) metadata fields (Course Code, Credits, ...)
    fields, i = {}, 0
    while i < len(block) and block[i] not in SECTION_HEADINGS:
        for f in COURSE_FIELDS:
            if block[i].startswith(f):
                fields[f] = block[i][len(f):].strip()
                break
        else:  # a wrapped value (e.g. long Teaching Staff list) -> append
            if fields:
                last = list(fields)[-1]
                fields[last] = (fields[last] + " " + block[i]).strip()
        i += 1

    code = fields.get("Course Code", "UNKNOWN")
    course_meta = {
        **meta,
        "course_name": title,
        "course_code": code,
        "credits": fields.get("Credits", ""),
        "period": fields.get("Period", ""),
        "course_level": fields.get("Course Level", ""),
    }

    # 2) a "facts" chunk: great for questions like "how many EC is X?"
    facts = "\n".join(f"{k}: {v}" for k, v in fields.items())
    chunks = make_chunks(f"{title} ({code}) - Course facts", facts,
                         f"sg-{code}-facts", {**course_meta, "section": "Course facts"})

    # 3) one chunk per section (Method of Assessment, Course Content, ...)
    section, body = None, []

    def flush():
        if section and body:
            chunks.extend(make_chunks(
                f"{title} ({code}) - {section}", "\n".join(body),
                f"sg-{code}-{slug(section)}", {**course_meta, "section": section}))

    for line in block[i:]:
        if line in SECTION_HEADINGS:
            flush()
            section, body = line, []
        else:
            body.append(line)
    flush()
    return chunks


def parse_study_guide(path: Path, meta: dict) -> list[dict]:
    lines = read_study_guide_lines(path)
    starts = [i for i, l in enumerate(lines) if l.startswith("Course Code ")]
    if not starts:
        raise ValueError(f"No courses found in {path.name} - is this a study guide?")

    # The table of contents lists full course names; use it to repair titles
    # that wrap over several lines (e.g. "Interdisciplinary Community Service
    # Learning:" / "Addressing Challenges Through Transdisciplinary" / "Research").
    toc = " ".join(lines[:starts[0]])

    def title_start(code_idx: int) -> int:
        for n_lines in (3, 2):
            candidate = " ".join(lines[code_idx - n_lines:code_idx])
            if candidate in toc:
                return code_idx - n_lines
        return code_idx - 1

    title_idx = [title_start(s) for s in starts]
    chunks = []

    # Programme overview: everything before the first course, minus course
    # tables and table-of-contents lines (which end in a page number).
    overview = [l for l in lines[:title_idx[0]]
                if not TABLE_ROW.search(l) and not TOC_LINE.search(l)]
    chunks += make_chunks(f"{meta['programme']} master - programme overview ({meta['year']})",
                          "\n".join(overview), f"sg-{slug(meta['programme'])}-overview",
                          {**meta, "section": "Programme overview"})

    # Courses: from each title to the next title.
    for n, t in enumerate(title_idx):
        end = title_idx[n + 1] if n + 1 < len(title_idx) else len(lines)
        title = " ".join(lines[t:starts[n]])
        chunks += parse_course(title, lines[starts[n]:end], meta)
    return chunks


# --------------------------------------------------------------------------
# TER (Teaching and Examination Regulations) parser
# --------------------------------------------------------------------------
TER_HEADER = re.compile(r"^\d{4}-\d{4} Teaching and Examination Regulations Master( \d+/\d+)?$")
ARTICLE = re.compile(r"^Article (\d+\.\d+) (.+)$")
APPENDIX = re.compile(r"^Appendix ([IVX]+)$")
SECTION = re.compile(r"^Section (A|B1|B2): (.+)$")


def is_legal_basis_note(obj) -> bool:
    """The small (8pt) right-hand column, e.g. 'Advice OLC, approval FGV (9.38 sub b)'.
    Without removing it, those words get glued into the middle of sentences."""
    return obj.get("object_type") == "char" and obj["size"] < 8.5 and obj["x0"] >= 448


def read_ter_lines(path: Path) -> list[str]:
    lines, started = [], False
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            body = page.filter(lambda o: not is_legal_basis_note(o))
            for line in (body.extract_text() or "").split("\n"):
                line = normalize(line)
                # Skip the cover page and table of contents: the real text
                # starts at the exact heading "Section A: ..." (ToC lines have dots).
                if not started:
                    started = bool(re.match(r"^Section A: [^.]+$", line))
                if not started or not line or TER_HEADER.match(line):
                    continue
                lines.append(line)
    return lines


def parse_ter(path: Path, meta: dict) -> list[dict]:
    chunks, section = [], ""
    current, body = None, []  # current = (ref, title)

    def flush():
        if current and body:
            ref, title = current
            chunks.extend(make_chunks(
                f"{meta['programme']} TER {meta['year']} - {ref} {title}", "\n".join(body),
                f"ter-{slug(meta['programme'])}-{meta['year']}-{slug(ref)}",
                {**meta, "section": f"{ref} {title}", "ter_section": section,
                 "article": ref, "article_title": title}))

    lines = read_ter_lines(path)
    for i, line in enumerate(lines):
        if (m := SECTION.match(line)) and section != "Appendix":
            section = m.group(1)
        elif (m := ARTICLE.match(line)) and section != "Appendix":
            # (Appendix I re-lists article titles; those are not new articles.)
            flush()
            current, body = (f"Article {m.group(1)}", m.group(2)), []
        elif m := APPENDIX.match(line):
            flush()
            title = lines[i + 1] if i + 1 < len(lines) else ""
            current, body, section = (f"Appendix {m.group(1)}", title), [], "Appendix"
        elif current:
            body.append(line)
    flush()
    return chunks


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
PARSERS = {"study_guide": parse_study_guide, "ter": parse_ter}


def main():
    with open(RAW_DIR / "manifest.csv", newline="", encoding="utf-8") as f:
        manifest = list(csv.DictReader(f))

    all_chunks, seen = [], {}
    for row in manifest:
        path = RAW_DIR / row["filename"]
        meta = {
            "source_file": row["filename"],
            "doc_type": row["doc_type"],
            "programme": row["programme"],
            "year": row["year"],
            "source_url": row.get("source_url", ""),
        }
        chunks = PARSERS[row["doc_type"]](path, meta)
        print(f"{row['filename']:<48} -> {len(chunks):4d} chunks")

        # Deduplicate courses shared between programmes (e.g. Evolutionary
        # Computing is in both the AI and Finance study guides): keep one
        # chunk and record every programme that offers it.
        for c in chunks:
            if c["id"] in seen:
                kept = seen[c["id"]]["metadata"]
                if c["metadata"]["programme"] not in kept["programmes"].split("|"):
                    kept["programmes"] += "|" + c["metadata"]["programme"]
                continue
            c["metadata"]["programmes"] = c["metadata"]["programme"]
            seen[c["id"]] = c
            all_chunks.append(c)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        for c in all_chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    words = [len(c["text"].split()) for c in all_chunks]
    types = Counter(c["metadata"]["doc_type"] for c in all_chunks)
    print(f"\nWrote {len(all_chunks)} unique chunks to {OUT_FILE.relative_to(ROOT)}")
    print(f"By type: {dict(types)}")
    print(f"Words per chunk: min {min(words)}, median {sorted(words)[len(words) // 2]}, max {max(words)}")


if __name__ == "__main__":
    main()
