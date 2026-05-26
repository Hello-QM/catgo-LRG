"""Pydantic models + preset recipes for the reticular (MOF/COF) builder."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

from .structure import PymatgenStructure

# Preset recipe = topology name + per-node-type BB id + per-edge-type BB id.
# node_bbs key = node type (int); edge_bbs key = edge type encoded "i,j" (decoded
# to a tuple in the algorithm). BB ids are bundled-DB codes resolved + build-tested
# against server/catgo/vendor/pormake/database. Connectivity noted in comments.
#
# Resolved + build-tested 2026-05-25 against the vendored PORMAKE DB
# (867 BBs, 2404 topologies). Build output recorded per entry.
PRESETS: dict[str, dict] = {
    "mof-5": {
        "label": "MOF-5",
        "topology": "pcu",
        # N33 = Zn4O(CO2)6 cluster (C6O14X6Zn4), 6-connected -> the canonical
        # MOF-5 secondary building unit.
        "node_bbs": {0: "N33"},
        # E14 = 1,4-phenylene (C6H4X2); with the carboxylate-terminated N33 node
        # this is the BDC (benzene-1,4-dicarboxylate) linker, 2-connected.
        # Build: pcu/N33/E14 -> 54 atoms, C24H12O14Zn4, vol 2427.4 (Zn4O(BDC)3).
        "edge_bbs": {"0,0": "E14"},
    },
    "hkust-1": {
        "label": "HKUST-1",
        "topology": "tbo",
        # N10 = BTC (benzene-1,3,5-tricarboxylate), 3-connected node;
        # N409 = Cu paddlewheel, 4-connected node. Verified upstream-working
        # (PORMAKE example 1_make_HKUST1.py). Build: tbo/N10+N409 builds with
        # a valid positive-volume cell.
        "node_bbs": {0: "N10", 1: "N409"},
        "edge_bbs": {},
    },
    "zif-8": {
        "label": "ZIF-8",
        "topology": "sod",
        # N2 = bare tetrahedral 4-connected Zn-imidazolate node (elements
        # C,H,N,X,Zn -- NO oxygen), i.e. genuine ZnN4 ZIF coordination.
        "node_bbs": {0: "N2"},
        # E15 = imidazolate (C3H3N2X2), 2-connected. The 2-methyl substituent of
        # true ZIF-8 (2-methylimidazolate) has no BB in the DB, so this is the
        # unmethylated ZIF-8 framework analog -- chemically Zn(imidazolate)2 on the
        # SOD net (zero spurious O).
        # Build: sod/N2/E15 -> 684 atoms, C312H264N96Zn12 (no oxygen).
        "edge_bbs": {"0,0": "E15"},
    },
    "cof-300": {
        "label": "COF-300",
        # The 2D COF-5 (hcb honeycomb) net is not buildable: PORMAKE ships no 2D
        # nets (hcb/sql/kgm/hxl all absent) and its scaler targets 3D periodic
        # nets. Replaced with a genuine 3D dia-net imine COF (COF-300 family).
        "topology": "dia",
        # N600 = tetraphenylmethane core (C25H16X4), the tetrahedral 4-connected
        # organic node of the tetra(aminophenyl)methane building block of COF-300.
        "node_bbs": {0: "N600"},
        # E35 = N-bearing linear aromatic linker (C10H6N2X2), 2-connected, supplying
        # the imine/azine-type linkage of the dia-net 3D COF. The exact COF-300
        # monomers may differ from these bundled BBs; named by topology + chemistry
        # (dia-net tetrahedral-node + linear N-linker imine COF analog).
        # Build: dia/N600/E35 -> 616 atoms, C360H224N32 (all-organic), vol 86422.9.
        "edge_bbs": {"0,0": "E35"},
    },
}


class ReticularBuildRequest(BaseModel):
    """Build request. mode='preset' uses `preset`; mode='advanced' uses the rest."""

    mode: Literal["preset", "advanced"] = "preset"
    preset: Optional[str] = Field(default=None, description="Preset id, e.g. 'mof-5'")
    topology: Optional[str] = Field(default=None, description="RCSR net name (advanced)")
    node_bbs: dict[int, str] = Field(
        default_factory=dict, description="{node_type: bb_id} (advanced)"
    )
    edge_bbs: dict[str, str] = Field(
        default_factory=dict, description="{'i,j': bb_id} edge-type keys (advanced)"
    )


class ReticularBuildResult(BaseModel):
    structure: PymatgenStructure
    n_atoms: int = Field(description="Total number of atoms")
    topology: str
    formula: str
    message: str = ""


class TopologyInfo(BaseModel):
    name: str


class BuildingBlockInfo(BaseModel):
    name: str
    n_connection_points: int


class TopologyDetail(BaseModel):
    name: str
    node_types: list[int]
    node_cn: list[int]
    edge_types: list[list[int]]
