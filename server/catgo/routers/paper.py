"""Paper/literature import API endpoints.

Provides endpoints for:
- Uploading PDF papers and extracting text
- Resolving DOIs to fetch metadata via CrossRef
- Managing paper sessions (TTL-based cleanup)
"""

import logging
import re
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict

import httpx
from fastapi import APIRouter, HTTPException, UploadFile

from catgo.models.paper import (
    DOIResolveRequest,
    DOIResolveResponse,
    PaperSessionInfo,
    PaperUploadResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/paper", tags=["paper"])


@dataclass
class PaperSession:
    """Session holding extracted paper content."""

    title: str
    authors: list[str] = field(default_factory=list)
    doi: str = ""
    abstract: str = ""
    full_text: str = ""
    page_count: int = 0
    timestamp: float = 0.0


# In-memory session cache
_sessions: Dict[str, PaperSession] = {}
_SESSION_TTL = 1800  # 30 minutes


def _cleanup_expired() -> None:
    now = time.time()
    expired = [sid for sid, s in _sessions.items() if now - s.timestamp > _SESSION_TTL]
    for sid in expired:
        del _sessions[sid]


def _get_session(session_id: str) -> PaperSession:
    _cleanup_expired()
    if session_id not in _sessions:
        raise HTTPException(
            status_code=404,
            detail=f"Paper session {session_id} not found or expired",
        )
    session = _sessions[session_id]
    session.timestamp = time.time()
    return session


def _extract_abstract(text: str) -> str:
    """Try to extract abstract from paper text."""
    patterns = [
        r"(?i)abstract[:\s]*\n(.+?)(?:\n\s*\n|\n(?:introduction|keywords|1\.))",
        r"(?i)abstract[:\s]*(.+?)(?:\n\s*\n)",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, re.DOTALL)
        if m:
            abstract = m.group(1).strip()
            if 50 < len(abstract) < 3000:
                return abstract
    return ""


def _extract_doi_from_text(text: str) -> str:
    """Try to extract DOI from paper text."""
    m = re.search(
        r"(?:doi[:\s]*|https?://doi\.org/)(10\.\d{4,}/\S+)", text, re.IGNORECASE
    )
    return m.group(1).rstrip(".,;") if m else ""


@router.post("/upload", response_model=PaperUploadResponse)
async def upload_paper(file: UploadFile) -> PaperUploadResponse:
    """Upload a PDF paper and extract text content."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        import fitz  # PyMuPDF

        doc = fitz.open(tmp_path)
        metadata = doc.metadata or {}

        # Extract all text
        pages_text = []
        for page in doc:
            pages_text.append(page.get_text())
        full_text = "\n\n".join(pages_text)

        title = metadata.get("title", "") or ""
        author_str = metadata.get("author", "") or ""
        authors = (
            [a.strip() for a in author_str.split(",") if a.strip()]
            if author_str
            else []
        )
        page_count = len(doc)

        doc.close()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read PDF: {e}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    # Post-process: extract abstract and DOI from text if not in metadata
    abstract = _extract_abstract(full_text)
    doi = _extract_doi_from_text(full_text)

    # Truncate excessively long text to avoid context window issues
    if len(full_text) > 100_000:
        full_text = (
            full_text[:80_000]
            + "\n\n[... truncated ...]\n\n"
            + full_text[-20_000:]
        )

    session_id = str(uuid.uuid4())
    _sessions[session_id] = PaperSession(
        title=title,
        authors=authors,
        doi=doi,
        abstract=abstract,
        full_text=full_text,
        page_count=page_count,
        timestamp=time.time(),
    )
    _cleanup_expired()

    return PaperUploadResponse(
        session_id=session_id,
        title=title,
        authors=authors,
        doi=doi,
        abstract=abstract,
        full_text=full_text,
        page_count=page_count,
        char_count=len(full_text),
    )


@router.get("/{session_id}", response_model=PaperSessionInfo)
def get_paper_info(session_id: str) -> PaperSessionInfo:
    """Get paper session metadata (without full text)."""
    session = _get_session(session_id)
    return PaperSessionInfo(
        session_id=session_id,
        title=session.title,
        authors=session.authors,
        doi=session.doi,
        abstract=session.abstract,
        page_count=session.page_count,
        char_count=len(session.full_text),
    )


@router.get("/{session_id}/text")
def get_paper_text(session_id: str) -> dict:
    """Get the full extracted text of a paper."""
    session = _get_session(session_id)
    return {"text": session.full_text}


@router.post("/resolve-doi", response_model=DOIResolveResponse)
async def resolve_doi(request: DOIResolveRequest) -> DOIResolveResponse:
    """Resolve a DOI via CrossRef API to get paper metadata."""
    doi = request.doi.strip()
    # Normalize: remove URL prefix if present
    doi = re.sub(r"^https?://doi\.org/", "", doi)

    url = f"https://api.crossref.org/works/{doi}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, headers={"Accept": "application/json"})

    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail=f"DOI not found: {doi}")

    data = resp.json().get("message", {})

    title_parts = data.get("title", [])
    title = title_parts[0] if title_parts else ""

    authors = []
    for a in data.get("author", []):
        name = f"{a.get('given', '')} {a.get('family', '')}".strip()
        if name:
            authors.append(name)

    abstract = data.get("abstract", "")
    # CrossRef abstract often has JATS XML tags
    abstract = re.sub(r"<[^>]+>", "", abstract)

    journal_list = data.get("container-title", [])
    journal = journal_list[0] if journal_list else ""

    year = None
    date_parts = data.get("published-print", data.get("published-online", {})).get(
        "date-parts", [[]]
    )
    if date_parts and date_parts[0]:
        year = date_parts[0][0]

    # Store as a lightweight session
    session_id = str(uuid.uuid4())
    summary = (
        f"Title: {title}\n"
        f"Authors: {', '.join(authors)}\n"
        f"Journal: {journal}\n"
        f"Year: {year}\n"
        f"Abstract: {abstract}"
    )
    _sessions[session_id] = PaperSession(
        title=title,
        authors=authors,
        doi=doi,
        abstract=abstract,
        full_text=f"[DOI metadata only — no full text]\n\n{summary}",
        page_count=0,
        timestamp=time.time(),
    )

    return DOIResolveResponse(
        session_id=session_id,
        title=title,
        authors=authors,
        doi=doi,
        abstract=abstract,
        journal=journal,
        year=year,
    )


@router.delete("/{session_id}")
def cleanup_session(session_id: str) -> dict:
    """Remove a paper session."""
    if session_id in _sessions:
        del _sessions[session_id]
    return {"status": "ok"}
