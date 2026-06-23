"""A locked slab_gen node must NOT regenerate — it must return the saved slab.

Regression: a workflow uploaded a 45-atom, no-constraints POSCAR to HPC while
the frontend showed a finalized 36-atom slab with the bottom 2 layers frozen.
Root cause: `run_slab_gen` always rebuilt the slab from bulk + miller/layers,
ignoring the frontend contract (SlabGenPreview.svelte: "When locked, preview
shows the saved structure_json instead of regenerating"). The rebuilt ferrox
slab had a different layer count (45 vs 36) and, with no `frozen_layers` param,
carried no selective_dynamics — discarding the user's finalized, edited slab.

When `slab_locked` is set and a `structure_json` is present, run_slab_gen must
return that exact structure (atom count + selective_dynamics preserved).
"""

import json

from pymatgen.core import Lattice, Structure

from catgo.workflow.builtins_impl import run_slab_gen


def _locked_slab_json() -> str:
    """A tiny finalized slab: 2 Pt atoms, bottom one frozen via selective_dynamics."""
    lattice = Lattice.from_parameters(3, 3, 20, 90, 90, 90)
    s = Structure(
        lattice,
        ["Pt", "Pt"],
        [[0.0, 0.0, 0.2], [0.0, 0.0, 0.4]],
    )
    # bottom atom fixed, top atom free — the exact thing the user set
    s.add_site_property("selective_dynamics", [[False, False, False], [True, True, True]])
    return json.dumps(s.as_dict())


# A bulk that, if regenerated, would NOT produce the 2-atom frozen slab above.
def _bulk_json() -> str:
    lattice = Lattice.cubic(3.92)
    s = Structure(lattice, ["Pt"], [[0.0, 0.0, 0.0]])
    return json.dumps(s.as_dict())


def test_locked_slab_is_returned_verbatim_not_regenerated():
    locked = _locked_slab_json()
    out = run_slab_gen(
        structure=_bulk_json(),
        miller=(1, 1, 1),
        layers=4,
        vacuum=15.0,
        slab_locked=True,
        structure_json=locked,
    )
    result = Structure.from_dict(json.loads(out["structure"]))
    # atom count preserved (2, not a regenerated count)
    assert len(result) == 2
    # selective_dynamics preserved exactly
    sd = result.site_properties.get("selective_dynamics")
    assert sd is not None, "locked slab lost its selective_dynamics"
    assert [list(map(bool, f)) for f in sd] == [[False, False, False], [True, True, True]]


def test_unlocked_slab_still_regenerates_from_bulk():
    # Without slab_locked, the generator builds from the bulk (different result),
    # so it must NOT just echo the 2-atom structure_json.
    out = run_slab_gen(
        structure=_bulk_json(),
        miller=(1, 1, 1),
        layers=4,
        vacuum=15.0,
        structure_json=_locked_slab_json(),
    )
    result = Structure.from_dict(json.loads(out["structure"]))
    assert len(result) != 2  # regenerated slab, not the 2-atom locked echo
