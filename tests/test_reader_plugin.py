"""Tests for Phase 1: ReaderPlugin base class, PluginManager reader support,
and CP2K .pdos reader plugin."""

import asyncio
import json
import textwrap
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

# ---------------------------------------------------------------------------
# 1. ReaderPlugin base class & validation
# ---------------------------------------------------------------------------


def test_reader_plugin_validate_missing_attrs():
    """ReaderPlugin.validate() should catch missing required attributes."""
    from plugins.base import ReaderPlugin

    # Minimal class with no required attrs
    class Bad(ReaderPlugin):
        name = "bad"
        display_name = "Bad"
        description = "test"
        version = "1.0.0"
        author = "test"

        async def read(self, file_paths, options=None):
            return {}

    errors = Bad.validate()
    assert any("reader_id" in e for e in errors)
    assert any("supported_formats" in e for e in errors)
    assert any("output_type" in e for e in errors)


def test_reader_plugin_validate_invalid_output_type():
    """ReaderPlugin.validate() should reject unknown output_type."""
    from plugins.base import ReaderPlugin

    class Bad(ReaderPlugin):
        name = "bad"
        display_name = "Bad"
        description = "test"
        version = "1.0.0"
        author = "test"
        reader_id = "bad_reader"
        supported_formats = [".bad"]
        output_type = "invalid_type"

        async def read(self, file_paths, options=None):
            return {}

    errors = Bad.validate()
    assert any("Invalid output_type" in e for e in errors)


def test_reader_plugin_validate_ok():
    """Valid ReaderPlugin should pass validation."""
    from plugins.base import ReaderPlugin

    class Good(ReaderPlugin):
        name = "good"
        display_name = "Good"
        description = "test"
        version = "1.0.0"
        author = "test"
        reader_id = "good_reader"
        supported_formats = [".dat"]
        output_type = "electronic_dos"

        async def read(self, file_paths, options=None):
            return {}

    errors = Good.validate()
    assert errors == []


def test_reader_plugin_detect_files():
    """detect_files should match file extensions case-insensitively."""
    from plugins.base import ReaderPlugin

    class R(ReaderPlugin):
        name = "r"
        display_name = "R"
        description = "test"
        version = "1.0.0"
        author = "test"
        reader_id = "r"
        supported_formats = [".pdos"]
        output_type = "electronic_dos"

        async def read(self, file_paths, options=None):
            return {}

    r = R()
    assert r.detect_files(["file.pdos"]) is True
    assert r.detect_files(["FILE.PDOS"]) is True
    assert r.detect_files(["file.xyz"]) is False


def test_reader_plugin_priority_score():
    """priority_score should count matching files."""
    from plugins.base import ReaderPlugin

    class R(ReaderPlugin):
        name = "r"
        display_name = "R"
        description = "test"
        version = "1.0.0"
        author = "test"
        reader_id = "r"
        supported_formats = [".pdos"]
        output_type = "electronic_dos"

        async def read(self, file_paths, options=None):
            return {}

    r = R()
    assert r.priority_score(["a.pdos", "b.pdos", "c.xyz"]) == 2


def test_reader_plugin_metadata():
    """get_metadata should include reader-specific extras."""
    from plugins.base import ReaderPlugin

    class R(ReaderPlugin):
        name = "r"
        display_name = "R"
        description = "test"
        version = "1.0.0"
        author = "test"
        reader_id = "test_reader"
        supported_formats = [".dat"]
        output_type = "electronic_dos"
        multi_file = True

        async def read(self, file_paths, options=None):
            return {}

    meta = R().get_metadata()
    assert meta.extra["reader_id"] == "test_reader"
    assert meta.extra["supported_formats"] == [".dat"]
    assert meta.extra["output_type"] == "electronic_dos"
    assert meta.extra["multi_file"] is True


def test_plugin_type_includes_reader():
    """PluginType enum should include READER."""
    from plugins.base import PluginType

    assert PluginType.READER == "reader"


def test_get_plugin_type_returns_reader():
    """get_plugin_type should return READER for ReaderPlugin subclass."""
    from plugins.base import ReaderPlugin, PluginType

    class R(ReaderPlugin):
        name = "r"
        display_name = "R"
        description = "test"
        version = "1.0.0"
        author = "test"
        reader_id = "r"
        supported_formats = [".dat"]
        output_type = "electronic_dos"

        async def read(self, file_paths, options=None):
            return {}

    assert R.get_plugin_type() == PluginType.READER


# ---------------------------------------------------------------------------
# 2. PluginManager reader registration & query
# ---------------------------------------------------------------------------


@pytest.fixture
def manager():
    """Fresh PluginManager for each test."""
    from plugins.manager import PluginManager

    return PluginManager()


def _make_reader(reader_id="test_reader", formats=None, output_type="electronic_dos"):
    from plugins.base import ReaderPlugin

    formats = formats or [".dat"]

    class R(ReaderPlugin):
        name = f"test-{reader_id}"
        display_name = f"Test {reader_id}"
        description = "test"
        version = "1.0.0"
        author = "test"

        async def read(self, file_paths, options=None):
            return {"test": True}

    R.reader_id = reader_id
    R.supported_formats = formats
    R.output_type = output_type
    r = R()
    r._path = Path(".")
    return r


@pytest.mark.asyncio
async def test_manager_register_reader(manager):
    """PluginManager should register and find readers."""
    reader = _make_reader("my_reader", [".pdos"])
    await manager._register_plugin(reader)

    assert manager.has_reader("my_reader")
    assert not manager.has_reader("nonexistent")
    assert manager.get_reader("my_reader") is reader


@pytest.mark.asyncio
async def test_manager_find_reader_for_files(manager):
    """find_reader_for_files should return the best matching reader."""
    r1 = _make_reader("r1", [".pdos"])
    r2 = _make_reader("r2", [".h5"])
    await manager._register_plugin(r1)
    await manager._register_plugin(r2)

    found = manager.find_reader_for_files(["data.pdos"])
    assert found is r1

    found = manager.find_reader_for_files(["data.h5"])
    assert found is r2

    found = manager.find_reader_for_files(["data.xyz"])
    assert found is None


@pytest.mark.asyncio
async def test_manager_find_reader_disabled(manager):
    """find_reader_for_files should skip disabled readers."""
    r = _make_reader("r_disabled", [".pdos"])
    await manager._register_plugin(r)
    r._enabled = False

    found = manager.find_reader_for_files(["data.pdos"])
    assert found is None


@pytest.mark.asyncio
async def test_manager_get_all_readers(manager):
    """get_all_readers returns info dicts for all registered readers."""
    await manager._register_plugin(_make_reader("r1", [".pdos"]))
    await manager._register_plugin(_make_reader("r2", [".h5"]))

    readers = manager.get_all_readers()
    assert len(readers) == 2
    ids = {r["reader_id"] for r in readers}
    assert ids == {"r1", "r2"}

    for r in readers:
        assert "formats" in r
        assert "output_type" in r
        assert "display_name" in r


@pytest.mark.asyncio
async def test_manager_uninstall_reader(manager):
    """uninstall_plugin should remove reader from registry."""
    r = _make_reader("r_to_remove", [".pdos"])
    r._path = None  # prevent rmtree
    await manager._register_plugin(r)
    assert manager.has_reader("r_to_remove")

    await manager.uninstall_plugin("test-r_to_remove")
    assert not manager.has_reader("r_to_remove")


# ---------------------------------------------------------------------------
# 3. Discovery: _find_plugin_class recognizes ReaderPlugin
# ---------------------------------------------------------------------------


def test_find_plugin_class_reader():
    """_find_plugin_class should find ReaderPlugin subclasses."""
    import types
    from plugins.discovery import _find_plugin_class
    from plugins.base import ReaderPlugin

    mod = types.ModuleType("fake_module")

    class FakeReader(ReaderPlugin):
        name = "fake"
        display_name = "Fake"
        description = "test"
        version = "1.0.0"
        author = "test"
        reader_id = "fake"
        supported_formats = [".fake"]
        output_type = "electronic_dos"

        async def read(self, file_paths, options=None):
            return {}

    mod.FakeReader = FakeReader
    found = _find_plugin_class(mod)
    assert found is FakeReader


# ---------------------------------------------------------------------------
# 4. CP2K .pdos reader plugin
# ---------------------------------------------------------------------------


@pytest.fixture
def cp2k_pdos_single(tmp_path):
    """Create a minimal single-spin CP2K .pdos file."""
    content = textwrap.dedent("""\
        # Projected DOS for atomic kind Ti at iteration step i = 100, E(Fermi) = -0.18500 a.u.
        # MO Eigenvalue [a.u.] Occupation s py pz px dxy dyz dz2 dxz dx2
        1 -0.90000 2.0000 0.100 0.000 0.000 0.000 0.200 0.000 0.000 0.000 0.000
        2 -0.50000 2.0000 0.050 0.010 0.010 0.010 0.100 0.050 0.050 0.050 0.050
        3  0.10000 0.0000 0.001 0.002 0.003 0.004 0.005 0.006 0.007 0.008 0.009
    """)
    fp = tmp_path / "Ti-k1-1.pdos"
    fp.write_text(content)
    return fp


@pytest.fixture
def cp2k_pdos_spin(tmp_path):
    """Create spin-polarized ALPHA/BETA .pdos file pair."""
    alpha = textwrap.dedent("""\
        # Projected DOS for atomic kind O at iteration step i = 100, E(Fermi) = -0.20000 a.u.
        # MO Eigenvalue [a.u.] Occupation s py pz px
        1 -1.00000 1.0000 0.300 0.100 0.100 0.100
        2 -0.40000 1.0000 0.200 0.050 0.050 0.050
        3  0.20000 0.0000 0.010 0.005 0.005 0.005
    """)
    beta = textwrap.dedent("""\
        # Projected DOS for atomic kind O at iteration step i = 100, E(Fermi) = -0.20000 a.u.
        # MO Eigenvalue [a.u.] Occupation s py pz px
        1 -0.95000 1.0000 0.280 0.090 0.090 0.090
        2 -0.35000 0.0000 0.150 0.030 0.030 0.030
        3  0.25000 0.0000 0.008 0.004 0.004 0.004
    """)
    fp_a = tmp_path / "O-ALPHA-k1-1.pdos"
    fp_b = tmp_path / "O-BETA-k1-1.pdos"
    fp_a.write_text(alpha)
    fp_b.write_text(beta)
    return fp_a, fp_b


def test_cp2k_parse_pdos_file(cp2k_pdos_single):
    """_parse_pdos_file should extract eigenvalues, orbitals, and Fermi."""
    from plugin import _parse_pdos_file, HA_TO_EV

    result = _parse_pdos_file(cp2k_pdos_single)

    assert result["kind"] == "Ti"
    assert result["spin"] == ""
    assert abs(result["fermi_au"] - (-0.185)) < 1e-6
    assert abs(result["fermi_ev"] - (-0.185 * HA_TO_EV)) < 0.01
    assert len(result["eigenvalues_ev"]) == 3
    assert "s" in result["orbitals"]
    assert "dxy" in result["orbitals"]
    assert len(result["orbitals"]["s"]) == 3


@pytest.mark.asyncio
async def test_cp2k_reader_single(cp2k_pdos_single):
    """CP2KDosReader.read() single-spin should produce VaspData-compatible dict."""
    from plugin import CP2KDosReader

    reader = CP2KDosReader()
    result = await reader.read([str(cp2k_pdos_single)])

    # Check required VaspData fields
    assert "eigenvalues" in result
    assert "kweights" in result
    assert "efermi" in result
    assert "projectors" in result
    assert "positions" in result
    assert "lattice" in result
    assert "elements" in result
    assert "ion_types" in result
    assert "ion_counts" in result

    import numpy as np

    eig = np.array(result["eigenvalues"])
    assert eig.shape[0] == 1  # nspin = 1
    assert eig.shape[1] == 1  # nkpts = 1 (Gamma)
    assert eig.shape[2] == 3  # nbands = 3

    proj = np.array(result["projectors"])
    assert proj.shape[0] == 1  # nspin
    assert proj.shape[1] == 1  # nions (one kind: Ti)
    assert proj.shape[3] == 1  # nkpts
    assert proj.shape[4] == 3  # nbands

    assert result["elements"] == ["Ti"]
    assert result["ion_types"] == ["Ti"]
    assert result["ion_counts"] == [1]

    kw = np.array(result["kweights"])
    assert kw.shape == (1,)
    assert kw[0] == 1.0


@pytest.mark.asyncio
async def test_cp2k_reader_spin_polarized(cp2k_pdos_spin):
    """CP2KDosReader.read() spin-polarized should produce nspin=2."""
    from plugin import CP2KDosReader

    reader = CP2KDosReader()
    fp_a, fp_b = cp2k_pdos_spin
    result = await reader.read([str(fp_a), str(fp_b)])

    import numpy as np

    eig = np.array(result["eigenvalues"])
    assert eig.shape[0] == 2  # nspin = 2

    proj = np.array(result["projectors"])
    assert proj.shape[0] == 2  # nspin = 2

    # Alpha and beta eigenvalues should differ
    assert not np.allclose(eig[0], eig[1])


@pytest.mark.asyncio
async def test_cp2k_reader_fermi_override(cp2k_pdos_single):
    """Fermi energy override should take precedence."""
    from plugin import CP2KDosReader

    reader = CP2KDosReader()
    result = await reader.read(
        [str(cp2k_pdos_single)],
        options={"fermi_override": -5.0},
    )
    assert abs(result["efermi"] - (-5.0)) < 1e-10


@pytest.mark.asyncio
async def test_cp2k_reader_no_pdos_files():
    """Should raise ValueError if no .pdos files."""
    from plugin import CP2KDosReader

    reader = CP2KDosReader()
    with pytest.raises(ValueError, match="No .pdos files"):
        await reader.read(["/tmp/data.xyz"])


@pytest.mark.asyncio
async def test_cp2k_reader_detect_and_priority():
    """CP2K reader should detect .pdos files with high priority."""
    from plugin import CP2KDosReader

    reader = CP2KDosReader()
    assert reader.detect_files(["Ti-k1-1.pdos"]) is True
    assert reader.detect_files(["data.h5"]) is False
    assert reader.priority_score(["Ti-k1-1.pdos", "O-k1-1.pdos"]) == 20


# ---------------------------------------------------------------------------
# 5. Builtin readers registration
# ---------------------------------------------------------------------------


def test_builtin_readers_list():
    """BUILTIN_READERS should contain 4 readers."""
    from plugins.builtin_readers import BUILTIN_READERS

    assert len(BUILTIN_READERS) == 4
    ids = {cls.reader_id for cls in [c() for c in BUILTIN_READERS]}
    assert "vaspout_h5" in ids
    assert "vasp_procar" in ids
    assert "vasprun_bands" in ids
    assert "lobster_cohp" in ids


def test_builtin_readers_validate():
    """All builtin readers should pass validation."""
    from plugins.builtin_readers import BUILTIN_READERS

    for cls in BUILTIN_READERS:
        errors = cls.validate()
        assert errors == [], f"{cls.__name__} validation failed: {errors}"


# ---------------------------------------------------------------------------
# 6. __init__.py exports
# ---------------------------------------------------------------------------


def test_init_exports():
    """plugins.__init__ should export ReaderPlugin."""
    import plugins

    assert hasattr(plugins, "ReaderPlugin")
    from plugins import ReaderPlugin
    from plugins.base import ReaderPlugin as BaseReaderPlugin

    assert ReaderPlugin is BaseReaderPlugin


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
