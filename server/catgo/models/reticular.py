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
    "irmof-10": {
        "label": "IRMOF-10",
        "topology": "pcu",
        # Same Zn4O(CO2)6 cluster as MOF-5 (N33, 6-connected), but with a longer
        # ditopic linker -> isoreticular expansion of MOF-5.
        "node_bbs": {0: "N33"},
        # E34 = biphenyl (C12H8), 2-connected. With the carboxylate-terminated N33
        # node this is BPDC (biphenyl-4,4'-dicarboxylate), the IRMOF-10 linker.
        # Build: pcu/N33/E34 -> 84 atoms, C42H24O14Zn4, vol 5742 (Zn4O(BPDC)3).
        "edge_bbs": {"0,0": "E34"},
    },
    "irmof-16": {
        "label": "IRMOF-16",
        "topology": "pcu",
        # Zn4O cluster (N33) + an even longer ditopic linker -> the largest of the
        # classic isoreticular MOF-5 series.
        "node_bbs": {0: "N33"},
        # E1 = p-terphenyl (C18H12), 2-connected -> TPDC (terphenyl-4,4''-
        # dicarboxylate), the IRMOF-16 linker.
        # Build: pcu/N33/E1 -> 114 atoms, C60H36O14Zn4, vol 11146 (Zn4O(TPDC)3).
        "edge_bbs": {"0,0": "E1"},
    },
    "uio-66": {
        "label": "UiO-66",
        "topology": "fcu",
        # N419 = Zr6O4(OH)4 oxo cluster (Zr6O32C12), 12-connected -> the hallmark
        # Zr6 secondary building unit of the UiO family on the fcu net.
        "node_bbs": {0: "N419"},
        # E14 = 1,4-phenylene (C6H4); with the carboxylate-bearing Zr6 node this is
        # BDC (benzene-1,4-dicarboxylate), the UiO-66 linker, 2-connected.
        # Build: fcu/N419/E14 -> 440 atoms, C192H96O128Zr24, vol 8942.
        "edge_bbs": {"0,0": "E14"},
    },
    "uio-67": {
        "label": "UiO-67",
        "topology": "fcu",
        # Same Zr6 cluster (N419) as UiO-66, isoreticularly expanded with a longer
        # ditopic linker.
        "node_bbs": {0: "N419"},
        # E34 = biphenyl (C12H8) -> BPDC (biphenyl-4,4'-dicarboxylate), the UiO-67
        # linker, 2-connected.
        # Build: fcu/N419/E34 -> 680 atoms, C336H192O128Zr24, vol 20301.
        "edge_bbs": {"0,0": "E34"},
    },
    "zif-67": {
        "label": "ZIF-67",
        "topology": "sod",
        # N435 = bare tetrahedral 4-connected Co-imidazolate node (Co C20H16N4 --
        # the direct cobalt analog of the Zn ZIF-8 node N2), i.e. genuine CoN4 ZIF
        # coordination (no oxygen).
        "node_bbs": {0: "N435"},
        # E15 = imidazolate (C3H3N2), 2-connected. As with the bundled ZIF-8 entry,
        # the 2-methyl substituent of true ZIF-67 (2-methylimidazolate) has no BB in
        # the DB, so this is the unmethylated ZIF-67 analog -- Co(imidazolate)2 on
        # the SOD net.
        # Build: sod/N435/E15 -> 684 atoms, C312H264Co12N96 (no oxygen).
        "edge_bbs": {"0,0": "E15"},
    },
    "mof-177": {
        "label": "MOF-177",
        # MOF-177 is built from a tritopic carboxylate linker + Zn4O cluster, a
        # (3,6)-coordinated net. PORMAKE ships the (3,6) pyr net (the real MOF-177
        # net is qom); this is the closest bundled (3,6) Zn4O/tribenzoate framework.
        "topology": "pyr",
        # N386 = 1,3,5-tris(phenyl)benzene core (C30H15), 3-connected -> after the
        # carboxylates of the Zn4O node this is the BTB (benzene-1,3,5-tribenzoate)
        # tritopic linker. N33 = Zn4O(CO2)6 cluster, 6-connected.
        # Build: pyr/N386+N33 -> 456 atoms, C264H120O56Zn16, vol 36825.
        "node_bbs": {0: "N386", 1: "N33"},
        "edge_bbs": {},
    },
    "nott-100": {
        "label": "NOTT-100 / MOF-505 (analog)",
        # nbo-net Cu-paddlewheel framework. In true MOF-505/NOTT-100 the linker is a
        # single tetratopic tetracarboxylate (a 4-c node); here the nbo net is filled
        # by the 4-c Cu paddlewheel as the node with a ditopic aromatic edge supplying
        # the carboxylate spacers -- topologically the same nbo Cu-paddlewheel
        # framework, with the linker decomposed differently. Named by net + cluster.
        "topology": "nbo",
        # N409 = Cu2(CO2)4 paddlewheel (C4Cu2O8), 4-connected.
        "node_bbs": {0: "N409"},
        # E14 = 1,4-phenylene (C6H4), 2-connected aromatic spacer.
        # Build: nbo/N409/E14 -> 204 atoms, C96H48Cu12O48, vol 11078.
        "edge_bbs": {"0,0": "E14"},
    },
    "cof-102": {
        "label": "COF-102 (analog)",
        # 3D ctn-net boronate-ester COF (COF-102/COF-103 family). Real COF-102 is a
        # tetrahedral tetraboronic-acid node self-condensed with a triol; the bundled
        # BBs give the same (3,4)-ctn net with a tetrahedral C node and a tritopic
        # O-rich node -- the all-organic boronate-ester analog (exact B-O-C monomers
        # differ from the bundled BBs). Named by net + chemistry.
        "topology": "ctn",
        # N231 = tris(catecholate/triol-type) C9O6H3 node, 3-connected; N600 =
        # tetraphenylmethane core (C25H16), tetrahedral 4-connected node.
        # Build: ctn/N231+N600 -> 780 atoms, C444H240O96, vol 40397 (t~1.3s).
        "node_bbs": {0: "N231", 1: "N600"},
        "edge_bbs": {},
    },
    "cof-108": {
        "label": "COF-108 (analog)",
        # 3D bor-net boronate COF (COF-108 family). The bor net is the (3,4)-net of
        # COF-108; here the 3-c node is a genuine boron-bearing organic node and the
        # 4-c node is a tetrahedral carbon core -> a real boron-containing 3D COF.
        # Exact monomers differ from the literature COF-108 boroxine/silane pair.
        "topology": "bor",
        # N321 = boron-bearing tritopic node (C30BH36), 3-connected; N600 =
        # tetraphenylmethane core (C25H16), tetrahedral 4-connected node.
        # Build: bor/N321+N600 -> 391 atoms, C195H192B4, vol 14951.
        "node_bbs": {0: "N321", 1: "N600"},
        "edge_bbs": {},
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
    formula: str = ""
    elements: list[str] = Field(default_factory=list)


class TopologyDetail(BaseModel):
    name: str
    node_types: list[int]
    node_cn: list[int]
    edge_types: list[list[int]]
