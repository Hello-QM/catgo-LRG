"""Quickbuild catalysis recipes must use adsorbate-only freeze for freq nodes.

A freq calc on an adsorbate/slab system must fix the whole slab and vibrate only
the adsorbate (freeze_mode=adsorbate). The recipes previously used freeze_mode=
bottom (like geo_opt), which wrongly lets the top slab layers vibrate → wrong
ZPE/entropy in the free-energy diagram.
"""

from catgo.mcp_tools.server_claude_code import _quickbuild_recipes

_ADSORBATE_RECIPES = {"HER", "OER", "ORR", "NRR", "CO2RR_2e"}


def test_adsorbate_recipe_freq_nodes_use_adsorbate_freeze():
    recipes = _quickbuild_recipes()
    for name in _ADSORBATE_RECIPES:
        g = recipes[name]
        freq_nodes = [n for n in g["nodes"] if n["type"] == "freq"]
        assert freq_nodes, f"{name} has no freq node"
        for n in freq_nodes:
            assert n["params"].get("freeze_mode") == "adsorbate", (
                f"{name} freq node freeze_mode={n['params'].get('freeze_mode')} (want adsorbate)"
            )


def test_geo_opt_keeps_bottom_layer_freeze():
    # geo_opt relaxation should still freeze the bottom layers (not adsorbate mode).
    recipes = _quickbuild_recipes()
    for name in _ADSORBATE_RECIPES:
        for n in recipes[name]["nodes"]:
            if n["type"] == "geo_opt":
                fm = n["params"].get("freeze_mode")
                assert fm in ("bottom", "layers"), f"{name} geo_opt freeze_mode={fm}"


def test_adsorbate_recipes_relax_clean_slab_before_placement():
    """Every adsorbate branch must reuse one relaxed clean slab."""
    recipes = _quickbuild_recipes()
    for name in _ADSORBATE_RECIPES:
        graph = recipes[name]
        nodes = {node["id"]: node for node in graph["nodes"]}
        edges = set(graph["edges"])

        assert nodes["slab_opt"]["type"] == "geo_opt"
        assert ("slab", "slab_opt") in edges

        adsorbate_ids = [
            node_id for node_id, node in nodes.items()
            if node["type"] == "adsorbate_place"
        ]
        assert adsorbate_ids, f"{name} has no adsorbate branch"
        for adsorbate_id in adsorbate_ids:
            assert ("slab_opt", adsorbate_id) in edges, (
                f"{name} places {adsorbate_id} before clean-slab relaxation"
            )
            assert ("slab", adsorbate_id) not in edges
