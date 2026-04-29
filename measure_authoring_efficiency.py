#!/usr/bin/env python3
"""Measure token cost of exposing the 24-node Pt(111) ORR DAG of the
CatGo paper Section 7 to an LLM agent under several serialization
strategies. Uses the actual CatGo snapshot serializer (_graph_snapshot)
from server/catgo/mcp_tools/workflow_tools.py.

Prints a benchmark table suitable for inclusion in the paper.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Make the server importable
REPO = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "server"))

import tiktoken
from catgo.mcp_tools.workflow_tools import _graph_snapshot


def build_orr_dag() -> dict:
    """Construct the Pt(111) ORR DAG used as the benchmark in the paper's
    Section 6.2.1 / Section 7: one bulk, one slab, three adsorbate
    branches (OH*, O*, OOH*) each with (place, geo_opt, single_point,
    freq) stages, three gas-phase reference branches (H2, H2O, O2) each
    with (structure_input, geo_opt) stages, and one terminal
    free-energy node. The exact graph dictionary used to produce the
    token / tool-call benchmark numbers reported in the paper.
    """
    nodes = []
    edges = []
    eid = 0

    def add_node(nid, ntype, **params):
        nodes.append({"id": nid, "type": ntype, "params": params})

    def add_edge(src, dst, fromH="structure", toH="structure"):
        nonlocal eid
        eid += 1
        edges.append({
            "id": f"e{eid}",
            "from": src,
            "to": dst,
            "fromH": fromH,
            "toH": toH,
        })

    # Bulk + slab
    add_node("bulk", "structure_input", source="Pt_bulk.cif", formula="Pt")
    add_node("slab", "slab_gen",        miller=[1,1,1], n_layers=8, vacuum=15.0, fix_bottom=4)

    # 3 adsorbate placements
    add_node("ads_OH",  "adsorbate_place", species="OH",  site="atop", height=2.0)
    add_node("ads_O",   "adsorbate_place", species="O",   site="atop", height=2.0)
    add_node("ads_OOH", "adsorbate_place", species="OOH", site="atop", height=2.0)

    # 3 adsorbate branches × (geo_opt, single_point, freq) = 9
    for tag in ("OH", "O", "OOH"):
        add_node(f"opt_{tag}", "geo_opt",      software="vasp", encut=520, ibrion=2, ediff=1e-5, ediffg=-0.02)
        add_node(f"spe_{tag}", "single_point", software="vasp", encut=520, ediff=1e-6)
        add_node(f"frq_{tag}", "freq",         software="vasp", ibrion=5, encut=520)

    # Gas-phase references: 3 species × (structure_input, geo_opt) = 6
    for mol in ("H2", "H2O", "O2"):
        add_node(f"gas_{mol}",  "structure_input", source=f"{mol}.xyz", formula=mol)
        add_node(f"gopt_{mol}", "geo_opt",         software="vasp", encut=520, ibrion=2, ediff=1e-5)

    # Terminal free-energy
    add_node("fe", "free_energy", temperature=298.15, reaction="ORR", che=True, n_electrons=4, pH=0)

    # Edges
    add_edge("bulk", "slab")
    for tag in ("OH", "O", "OOH"):
        add_edge("slab",       f"ads_{tag}")
        add_edge(f"ads_{tag}", f"opt_{tag}")
        add_edge(f"opt_{tag}", f"spe_{tag}")
        add_edge(f"spe_{tag}", f"frq_{tag}")
        add_edge(f"frq_{tag}", "fe", fromH="energy", toH=f"energy_{tag}")
    for mol in ("H2", "H2O", "O2"):
        add_edge(f"gas_{mol}",  f"gopt_{mol}")
        add_edge(f"gopt_{mol}", "fe", fromH="energy", toH=f"ref_{mol}")

    return {"nodes": nodes, "edges": edges}


def topology_only(graph: dict) -> dict:
    """Strip params to simulate a 'node list + edges, no parameters'
    serialization strategy."""
    return {
        "nodes": [{"id": n["id"], "type": n["type"]} for n in graph["nodes"]],
        "edges": [{"from": e["from"], "to": e["to"]} for e in graph["edges"]],
    }


def count_tokens(text: str, encoding_name: str = "cl100k_base") -> int:
    enc = tiktoken.get_encoding(encoding_name)
    return len(enc.encode(text))


def main() -> int:
    graph = build_orr_dag()
    n_nodes = len(graph["nodes"])
    n_edges = len(graph["edges"])

    # Three strategies
    full_json = json.dumps(graph, separators=(",", ":"))
    full_json_indent = json.dumps(graph, indent=2)
    topo = json.dumps(topology_only(graph), separators=(",", ":"))
    snap = _graph_snapshot(graph)

    encodings = ("cl100k_base", "o200k_base")
    print(f"CatGo authoring-efficiency benchmark")
    print(f"  DAG: {n_nodes} nodes, {n_edges} edges "
          f"(Pt(111) ORR: bulk + slab + 3×[OOH,O,OH] branches "
          f"with [place, geo_opt, single_point, freq] stages + "
          f"3 gas refs [H2, H2O, O2] with [input, geo_opt] stages "
          f"+ free-energy terminal)")
    print()
    for enc_name in encodings:
        print(f"== Tokens (encoding = {enc_name}) ==")
        full_tok  = count_tokens(full_json, enc_name)
        full_tokp = count_tokens(full_json_indent, enc_name)
        topo_tok  = count_tokens(topo, enc_name)
        snap_tok  = count_tokens(snap, enc_name)

        strategies = [
            ("Full JSON dump (compact)",      full_tok,  full_json),
            ("Full JSON dump (pretty/indent)",full_tokp, full_json_indent),
            ("Topology-only",                  topo_tok,  topo),
            ("CatGo _graph_snapshot",          snap_tok,  snap),
        ]
        baseline = full_tok
        print(f"{'Strategy':<36} {'Tokens':>8} {'Chars':>8} {'× vs full':>10} {'Reduction':>11}")
        print("-" * 78)
        for name, tok, text in strategies:
            ratio = baseline / tok if tok else float("inf")
            reduction = f"{(1 - tok / baseline) * 100:+.1f}%" if tok else "--"
            print(f"{name:<36} {tok:>8d} {len(text):>8d} {ratio:>8.2f}× {reduction:>11}")
        print()

    # Show the actual snapshot output so we know what the agent sees
    print("== Actual _graph_snapshot(graph) output ==")
    print(snap)
    print()
    print(f"(snapshot is {len(snap)} chars, {count_tokens(snap):d} cl100k tokens)")
    print()

    # Mutation count: how many MCP tool calls are needed to build this DAG
    # with and without the `batch` action. Deterministic, no LLM needed.
    n_create = 1
    n_add_node = n_nodes
    n_connect = n_edges
    # Each add_node already accepts params in `params` field, so no extra
    # set_params is required unless user wants to modify later. We take the
    # minimal case: create + add_node + connect.
    without_batch = n_create + n_add_node + n_connect
    # With batch: one `create` (or one `batch` that does create + add_node +
    # connect). In practice the paper's example collapses everything into a
    # single batch call.
    with_batch = 2  # 1 batch call + 1 validate_workflow; run_workflow is separate
    print("== Mutation / MCP tool-call count ==")
    print(f"{'Strategy':<45} {'Calls':>6} {'Reduction':>11}")
    print("-" * 68)
    print(f"{'One tool call per mutation (no batch)':<45} {without_batch:>6d} {'1.00×':>11}")
    print(f"{'batch action (all mutations in one call)':<45} {with_batch:>6d} {f'{without_batch / with_batch:.1f}×':>11}")
    print()
    print(f"  (DAG requires {n_create} create + {n_add_node} add_node + {n_connect} connect = "
          f"{without_batch} individual calls; a single batch reduces this to {with_batch}.)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
