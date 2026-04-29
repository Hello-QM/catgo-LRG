"""Pydantic models for paper/literature import."""

from typing import Optional

from pydantic import BaseModel, Field


class PaperUploadResponse(BaseModel):
    """Response after uploading a PDF paper."""

    session_id: str
    title: str = ""
    authors: list[str] = Field(default_factory=list)
    doi: str = ""
    abstract: str = ""
    full_text: str = Field(default="", description="Extracted text content")
    page_count: int = 0
    char_count: int = 0


class PaperSessionInfo(BaseModel):
    """Lightweight session info (no full_text)."""

    session_id: str
    title: str = ""
    authors: list[str] = Field(default_factory=list)
    doi: str = ""
    abstract: str = ""
    page_count: int = 0
    char_count: int = 0


class DOIResolveRequest(BaseModel):
    """Request to resolve a DOI and fetch paper metadata."""

    doi: str = Field(description="DOI string, e.g. '10.1021/acscatal.3c01234'")


class DOIResolveResponse(BaseModel):
    """Response from DOI resolution."""

    session_id: str
    title: str = ""
    authors: list[str] = Field(default_factory=list)
    doi: str = ""
    abstract: str = ""
    journal: str = ""
    year: Optional[int] = None
