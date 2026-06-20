import asyncio

from catgo.routers import view_state


def setup_function():
    view_state.reset()


def teardown_function():
    view_state.reset()


def _structure(element: str) -> dict:
    return {
        "sites": [
            {
                "species": [{"element": element, "occu": 1}],
                "xyz": [0, 0, 0],
            }
        ]
    }


def test_legacy_tab_target_routes_to_active_viewer():
    viewer_id = "structure-1:leaf-42"
    view_state.panel_structures["structure-1"] = _structure("Old")
    view_state.mark_active(viewer_id)

    view_state.push_structure(_structure("Mo"), panel_id="structure-1")

    assert view_state.get_structure(viewer_id)["sites"][0]["species"][0]["element"] == "Mo"
    assert view_state.get_structure("structure-1") == view_state.get_structure(viewer_id)
    assert view_state.panel_structures["structure-1"]["sites"][0]["species"][0]["element"] == "Old"


def test_explicit_viewers_remain_isolated():
    left = "structure-1:leaf-left"
    right = "structure-1:leaf-right"
    view_state.push_structure(_structure("Li"), panel_id=left)
    view_state.push_structure(_structure("Mn"), panel_id=right)

    assert view_state.get_structure(left)["sites"][0]["species"][0]["element"] == "Li"
    assert view_state.get_structure(right)["sites"][0]["species"][0]["element"] == "Mn"

    view_state.mark_active(right)
    assert view_state.get_structure("structure-1") == view_state.get_structure(right)


def test_reset_viewer_removes_tab_alias():
    viewer_id = "structure-1:leaf-42"
    view_state.mark_active(viewer_id)
    view_state.push_structure(_structure("S"), panel_id=viewer_id)

    view_state.reset(viewer_id)

    assert view_state.resolve_panel_id("structure-1") == "structure-1"
    assert view_state.get_structure("structure-1") is None


def test_viewer_command_round_trip_is_scoped_to_one_viewer():
    async def run():
        viewer_id = "structure-1:leaf-right"
        queue = view_state.subscribe(viewer_id)
        task = asyncio.create_task(
            view_state.request_viewer_command(
                viewer_id,
                "inspect",
                {},
                timeout=1,
            )
        )
        message = await queue.get()
        assert message["event"] == "command"
        assert message["data"]["action"] == "inspect"
        assert not view_state.has_subscribers("structure-1:leaf-left")
        view_state.complete_viewer_command(
            message["data"]["command_id"],
            {"ok": True, "result": {"atom_count": 72}},
        )
        assert await task == {"ok": True, "result": {"atom_count": 72}}
        view_state.unsubscribe(viewer_id, queue)

    asyncio.run(run())


def test_viewer_command_fails_fast_when_viewer_is_gone():
    result = asyncio.run(
        view_state.request_viewer_command(
            "structure-1:missing",
            "inspect",
            {},
            timeout=1,
        )
    )
    assert result["ok"] is False
    assert "not mounted" in result["error"]


def test_manifest_resolves_unique_position_and_rejects_ambiguity():
    view_state.update_manifest(
        "structure-1:leaf-top",
        {"tab_id": "structure-1", "position": "top-right", "pane_number": 1},
    )
    view_state.update_manifest(
        "structure-1:leaf-bottom-a",
        {"tab_id": "structure-1", "position": "bottom-right", "pane_number": 2},
    )
    view_state.update_manifest(
        "structure-1:leaf-bottom-b",
        {"tab_id": "structure-1", "position": "bottom-right", "pane_number": 3},
    )

    viewer_id, error = view_state.resolve_viewer_ref("top-right", "structure-1")
    assert error is None
    assert viewer_id == "structure-1:leaf-top"
    assert view_state.resolve_viewer_ref("右上角", "structure-1") == (
        "structure-1:leaf-top",
        None,
    )

    viewer_id, error = view_state.resolve_viewer_ref("bottom-right", "structure-1")
    assert viewer_id is None
    assert "ambiguous" in error
    assert [item["viewer_id"] for item in view_state.list_manifests("structure-1")] == [
        "structure-1:leaf-top",
        "structure-1:leaf-bottom-a",
        "structure-1:leaf-bottom-b",
    ]


def test_manifest_resolves_by_pane_number():
    view_state.update_manifest(
        "structure-1:leaf-a",
        {"tab_id": "structure-1", "position": "left", "pane_number": 1},
    )
    view_state.update_manifest(
        "structure-1:leaf-b",
        {"tab_id": "structure-1", "position": "right", "pane_number": 2},
    )
    assert view_state.resolve_viewer_ref("pane 2", "structure-1") == (
        "structure-1:leaf-b",
        None,
    )
    assert view_state.resolve_viewer_ref("窗口1", "structure-1") == (
        "structure-1:leaf-a",
        None,
    )


def test_manifest_filename_matches_exact_or_stem_not_substring():
    view_state.update_manifest(
        "structure-1:leaf-p",
        {"tab_id": "structure-1", "position": "left", "filename": "POSCAR"},
    )
    view_state.update_manifest(
        "structure-1:leaf-m",
        {"tab_id": "structure-1", "position": "right", "filename": "mos2.traj"},
    )
    # Substring ("o" in "POSCAR") must NOT resolve — that routed to the wrong pane.
    viewer_id, error = view_state.resolve_viewer_ref("o", "structure-1")
    assert viewer_id is None
    assert "not found" in error
    # Exact name and stem do resolve.
    assert view_state.resolve_viewer_ref("POSCAR", "structure-1")[0] == "structure-1:leaf-p"
    assert view_state.resolve_viewer_ref("mos2", "structure-1")[0] == "structure-1:leaf-m"
