"""Pydantic models for MOF-database (MOFX-DB) search."""

from pydantic import BaseModel, Field

from .structure import PymatgenStructure


class MofSearchRequest(BaseModel):
    name: str | None = Field(default=None, description="Name prefix search")
    database: str | None = Field(
        default=None,
        description="Source DB: CoREMOF 2014|CoREMOF 2019|CSD|hMOF|IZA|PCOD-syn|Tobacco",
    )
    limit: int = Field(default=50, ge=1, le=200)


class MofHit(BaseModel):
    # Round-trip key is (name, database). mofdb_client.fetch() has no `id` kwarg,
    # `mofid` is None in CoREMOF, and `name` alone is not unique (the same MOF is
    # mirrored across CoREMOF 2014/2019). `id` is the true unique int key (kept for
    # display / dedup) but cannot be queried back via fetch().
    id: int = 0
    name: str
    database: str = ""
    elements: list[str] = Field(default_factory=list)
    n_elements: int = 0


class MofSearchResult(BaseModel):
    hits: list[MofHit]
    count: int


class MofStructureResult(BaseModel):
    structure: PymatgenStructure
    name: str
    database: str
