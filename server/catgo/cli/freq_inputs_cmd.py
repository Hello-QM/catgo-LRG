"""`catgo freq-inputs ...` — build VASP frequency inputs from a relaxed structure.

Thin launcher: locates the catgo-gibbs-pipeline skill's `build_freq_inputs.py` (shipped
in the repo at server/catgo/workflow/skills/catgo-gibbs-pipeline/scripts/) and calls its
`main(argv)`. This makes the bundled skill script runnable from ANY directory via the
`catgo` console command — no fragile path needed. The script stays in the skill as the
adaptable reference; this is just a portable launcher (mirrors `catgo campaign`).
"""
from __future__ import annotations

import sys
from pathlib import Path


def _script_dir() -> Path:
    # server/catgo/cli/freq_inputs_cmd.py -> server/catgo/workflow/skills/.../scripts
    return (Path(__file__).resolve().parent.parent
            / "workflow" / "skills" / "catgo-gibbs-pipeline" / "scripts")


def run_freq_inputs(argv: list[str]) -> int:
    scripts = str(_script_dir())
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import build_freq_inputs
    return int(build_freq_inputs.main(argv) or 0)


def cmd_freq_inputs(args) -> None:
    """argparse hook: `catgo freq-inputs <rest...>`."""
    raise SystemExit(run_freq_inputs(list(getattr(args, "rest", []) or [])))
