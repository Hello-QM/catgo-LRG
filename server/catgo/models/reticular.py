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
        # SUBSTITUTION: the bundled DB has no bare tetrahedral Zn node. N238 is
        # the smallest Zn 4-connected node (C4O8X4Zn, a Zn-carboxylate unit), so
        # the framework carries spurious carboxylate O vs. ideal ZnN4 ZIF-8.
        "node_bbs": {0: "N238"},
        # SUBSTITUTION: no 2-methylimidazolate edge in the DB. E15 = imidazolate
        # (C3H3N2X2), the unmethylated parent of 2-methylimidazolate, 2-connected.
        # Build: sod/N238/E15 -> 348 atoms, C120H72N48O96Zn12, vol 27373.5.
        "edge_bbs": {"0,0": "E15"},
    },
    "cof-5": {
        "label": "COF-5",
        # SUBSTITUTION: the hcb (honeycomb) net is absent from the vendored
        # topology set. ths is a bundled single-node-type 3-connected net used as
        # the closest 3-c substitute for the COF-5 hexagonal layer topology.
        "topology": "ths",
        # N610 = triphenylene-hexaol core (C27H27O6X3, 6 oxygens), 3-connected ->
        # HHTP (2,3,6,7,10,11-hexahydroxytriphenylene) node.
        "node_bbs": {0: "N610"},
        # SUBSTITUTION: no benzene diboronic-acid edge in the DB. E14 = 1,4-phenylene
        # (C6H4X2) is the BDBA aromatic backbone (boronate-ester chemistry to the
        # HHTP catechol O is implicit), 2-connected.
        # Build: ths/N610/E14 -> 600 atoms, C288H264O48, vol 87042.3.
        "edge_bbs": {"0,0": "E14"},
    },
}
