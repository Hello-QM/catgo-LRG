"""A finished reaction path should be watchable, not just readable.

NEB/IRC already write the whole path as one multi-frame XYZ on the cluster, and
the viewer already animates trajectories — but nothing carried the file across,
so a mechanism study came back as a barrier number and a single TS geometry.
"""

import asyncio

import pytest

from catgo.routers import view_state
from catgo.workflow.engine import result_handler


def setup_function():
    view_state.reset()


def teardown_function():
    view_state.reset()


def _drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


MEP = "2\nimage 0\nH 0 0 0\nH 0 0 1\n2\nimage 1\nH 0 0 0\nH 0 0 2\n"


class _Result:
    def __init__(self, stdout="", exit_status=0):
        self.stdout = stdout
        self.exit_status = exit_status


class _Conn:
    """Minimal stand-in for the HPC connection: answers `stat` and `cat`."""

    def __init__(self, files: dict[str, str]):
        self.files = files
        self.commands: list[str] = []

    class _Inner:
        def __init__(self, outer):
            self.outer = outer

        def run(self, cmd, check=False):
            self.outer.commands.append(cmd)
            verb, _, path = cmd.partition(" ")
            if verb == "stat":
                path = cmd.split()[-1]
                if path not in self.outer.files:
                    return _Result(exit_status=1)
                return _Result(str(len(self.outer.files[path])))
            if verb == "cat":
                if path not in self.outer.files:
                    return _Result(exit_status=1)
                return _Result(self.outer.files[path])
            return _Result(exit_status=1)

    @property
    def conn(self):
        return self._Inner(self)

    async def run_on_owner(self, fn):
        return fn()


def _publish(files, resolved_type="orca_neb_ts", work_dir="/scratch/run"):
    return asyncio.run(result_handler._publish_path_trajectory(
        _Conn(files), work_dir, "task-1", resolved_type
    ))


def test_a_neb_path_is_pushed_as_an_animatable_trajectory():
    # It lands in the External/remote pane, NOT in whichever pane the human
    # happens to be using: push_trajectory pops that panel's structure, so
    # targeting the active pane would delete the geometry under the user.
    view_state.mark_active("structure-1")
    view_state.push_structure({"sites": [{"label": "Pt"}]}, panel_id="structure-1")
    q = view_state.subscribe("default")

    _publish({"/scratch/run/ORCA_MEP_trj.xyz": MEP})

    events = _drain(q)
    assert [e["event"] for e in events] == ["trajectory"]
    assert events[0]["data"]["content"] == MEP
    assert events[0]["data"]["filename"] == "ORCA_MEP_trj.xyz"
    # stored too, so a viewer connecting later still gets it on replay
    assert view_state.get_trajectory("default")["filename"] == "ORCA_MEP_trj.xyz"
    # and the pane the user was working in is untouched
    assert view_state.get_structure("structure-1")


def test_an_irc_path_uses_its_own_file():
    q = view_state.subscribe("default")

    _publish({"/scratch/run/ORCA_IRC_Full_trj.xyz": MEP}, resolved_type="orca_irc")

    assert _drain(q)[0]["data"]["filename"] == "ORCA_IRC_Full_trj.xyz"


def test_the_first_available_candidate_wins_and_only_one_is_pushed():
    q = view_state.subscribe("default")

    _publish({
        "/scratch/run/ORCA_MEP_trj.xyz": MEP,
        "/scratch/run/ORCA_MEP_ALL_trj.xyz": MEP,
    })

    events = _drain(q)
    assert len(events) == 1 and events[0]["data"]["filename"] == "ORCA_MEP_trj.xyz"


def test_a_task_type_with_no_path_file_is_left_alone():
    view_state.mark_active("default")
    q = view_state.subscribe("default")

    _publish({"/scratch/run/ORCA_MEP_trj.xyz": MEP}, resolved_type="orca_opt")

    assert _drain(q) == []


def test_a_missing_file_is_not_an_error():
    view_state.mark_active("default")
    q = view_state.subscribe("default")

    _publish({})

    assert _drain(q) == []


def test_a_run_sized_trajectory_is_declined_rather_than_shipped(monkeypatch):
    # A production MD would cost more to transfer than the animation is worth.
    monkeypatch.setattr(result_handler, "_MAX_PATH_TRAJECTORY_BYTES", 10)
    view_state.mark_active("default")
    q = view_state.subscribe("default")

    _publish({"/scratch/run/ORCA_MEP_trj.xyz": MEP})

    assert _drain(q) == []


def test_a_stub_file_with_no_frames_is_not_pushed():
    view_state.mark_active("default")
    q = view_state.subscribe("default")

    _publish({"/scratch/run/ORCA_MEP_trj.xyz": "0\n\n"})

    assert _drain(q) == []


def test_a_broken_connection_never_fails_the_completed_task():
    class _Exploding:
        @property
        def conn(self):
            raise RuntimeError("ssh died")

        async def run_on_owner(self, fn):
            return fn()

    asyncio.run(result_handler._publish_path_trajectory(
        _Exploding(), "/scratch/run", "task-2", "orca_neb_ts"
    ))  # must not raise


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
