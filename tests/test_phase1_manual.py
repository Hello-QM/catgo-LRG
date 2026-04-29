#!/usr/bin/env python
"""Phase 1 人工测试辅助脚本 — 自动运行 API 测试.

用法:
    # 先确保后端运行中:
    #   cd D:/CatGO-dev && pnpm desktop:serve
    #   或: conda activate CatGo01 && python server/main.py

    # 然后运行此脚本:
    python tests/test_phase1_manual.py [--port 8000]

该脚本会依次测试:
  1. GET  /api/plugins/         — 插件列表（含 reader 类型）
  2. GET  /api/plugins/readers  — reader 插件列表
  3. POST /api/plugins/readers/upload  — 上传单自旋 CP2K .pdos
  4. POST /api/plugins/readers/upload  — 上传多文件（Ti + O）
  5. POST /api/plugins/readers/upload  — 上传自旋极化 ALPHA/BETA
  6. POST /api/dos/compute      — 用插件创建的 session 计算 PDOS
  7. POST /api/plugins/readers/upload  — 指定 reader_id
  8. POST /api/plugins/readers/upload  — 不存在的文件类型 → 400
"""

import argparse
import json
import sys
import time
from pathlib import Path

try:
    import httpx
except ImportError:
    print("ERROR: httpx 未安装。请运行: pip install httpx")
    sys.exit(1)

FIXTURES = Path(__file__).parent / "fixtures" / "cp2k-pdos"

# ANSI colors
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
RESET = "\033[0m"
BOLD = "\033[1m"


def ok(msg):
    print(f"  {GREEN}✓{RESET} {msg}")


def fail(msg):
    print(f"  {RED}✗{RESET} {msg}")


def info(msg):
    print(f"  {CYAN}ℹ{RESET} {msg}")


def header(title):
    print(f"\n{BOLD}{'═' * 60}{RESET}")
    print(f"{BOLD}  {title}{RESET}")
    print(f"{BOLD}{'═' * 60}{RESET}")


def subheader(title):
    print(f"\n{YELLOW}── {title} ──{RESET}")


def run_tests(base_url: str):
    client = httpx.Client(base_url=base_url, timeout=30.0)
    passed = 0
    failed = 0

    # ------------------------------------------------------------------
    # Test 1: GET /api/plugins/ — 插件列表
    # ------------------------------------------------------------------
    header("Test 1: GET /api/plugins/")
    try:
        resp = client.get("/plugins/")
        assert resp.status_code == 200, f"status={resp.status_code}"
        data = resp.json()
        plugins = data["plugins"]
        total = data["total"]
        ok(f"status=200, total={total} 个插件")

        reader_plugins = [p for p in plugins if p["plugin_type"] == "reader"]
        info(f"其中 reader 类型: {len(reader_plugins)} 个")

        cp2k_found = any("cp2k" in p["name"].lower() for p in plugins)
        if cp2k_found:
            ok("CP2K DOS reader 插件已加载")
        else:
            fail("CP2K DOS reader 插件未找到！检查 plugins/ 目录")
            failed += 1
            return passed, failed

        for p in plugins:
            info(f"  [{p['plugin_type']}] {p['name']} v{p['version']} (enabled={p['enabled']})")

        passed += 1
    except Exception as e:
        fail(f"请求失败: {e}")
        failed += 1
        return passed, failed

    # ------------------------------------------------------------------
    # Test 2: GET /api/plugins/readers — reader 列表
    # ------------------------------------------------------------------
    header("Test 2: GET /api/plugins/readers")
    try:
        resp = client.get("/plugins/readers")
        assert resp.status_code == 200
        data = resp.json()
        readers = data["readers"]
        ok(f"status=200, total={data['total']} 个 reader")

        for r in readers:
            info(f"  {r['reader_id']}: formats={r['formats']}, output={r['output_type']}")

        # Verify CP2K reader
        cp2k_readers = [r for r in readers if r["reader_id"] == "cp2k_pdos"]
        assert len(cp2k_readers) == 1, "cp2k_pdos reader 应该恰好有 1 个"
        cp2k = cp2k_readers[0]
        assert ".pdos" in cp2k["formats"]
        assert cp2k["output_type"] == "electronic_dos"
        assert cp2k["multi_file"] is True
        ok("cp2k_pdos reader: formats=['.pdos'], output=electronic_dos, multi_file=True")
        passed += 1
    except Exception as e:
        fail(f"请求失败: {e}")
        failed += 1

    # ------------------------------------------------------------------
    # Test 3: POST /api/plugins/readers/upload — 单文件 Ti .pdos
    # ------------------------------------------------------------------
    header("Test 3: 上传单个 Ti .pdos 文件")
    session_id_single = None
    try:
        ti_file = FIXTURES / "TiO2-Ti-k1-1.pdos"
        assert ti_file.exists(), f"fixture 文件不存在: {ti_file}"

        with open(ti_file, "rb") as f:
            resp = client.post(
                "/plugins/readers/upload",
                files=[("files", ("TiO2-Ti-k1-1.pdos", f, "application/octet-stream"))],
            )
        assert resp.status_code == 200, f"status={resp.status_code}, body={resp.text}"
        data = resp.json()

        assert data["reader_id"] == "cp2k_pdos"
        assert data["output_type"] == "electronic_dos"
        assert "session_id" in data
        assert data["data"] is not None

        session_id_single = data["session_id"]
        session_data = data["data"]
        ok(f"reader_id=cp2k_pdos, output=electronic_dos")
        ok(f"session_id={session_id_single[:12]}...")
        info(f"  nions={session_data.get('nions')}, nspin={session_data.get('nspin')}, "
             f"elements={session_data.get('elements')}, efermi={session_data.get('efermi'):.3f}")
        passed += 1
    except Exception as e:
        fail(f"上传失败: {e}")
        failed += 1

    # ------------------------------------------------------------------
    # Test 4: POST /api/plugins/readers/upload — 多文件 Ti + O
    # ------------------------------------------------------------------
    header("Test 4: 上传 Ti + O 两个 .pdos 文件")
    session_id_multi = None
    try:
        ti_file = FIXTURES / "TiO2-Ti-k1-1.pdos"
        o_file = FIXTURES / "TiO2-O-k1-1.pdos"

        files = [
            ("files", ("TiO2-Ti-k1-1.pdos", open(ti_file, "rb"), "application/octet-stream")),
            ("files", ("TiO2-O-k1-1.pdos", open(o_file, "rb"), "application/octet-stream")),
        ]
        resp = client.post("/plugins/readers/upload", files=files)
        assert resp.status_code == 200, f"status={resp.status_code}"
        data = resp.json()
        session_id_multi = data["session_id"]
        session_data = data["data"]

        assert session_data["nions"] == 2  # Ti + O = 2 kinds
        assert set(session_data["elements"]) == {"Ti", "O"}
        ok(f"nions=2, elements=[Ti, O]")
        ok(f"session_id={session_id_multi[:12]}...")
        passed += 1
    except Exception as e:
        fail(f"上传失败: {e}")
        failed += 1

    # ------------------------------------------------------------------
    # Test 5: POST /api/plugins/readers/upload — 自旋极化
    # ------------------------------------------------------------------
    header("Test 5: 上传自旋极化 ALPHA/BETA .pdos 文件")
    session_id_spin = None
    try:
        spin_files = [
            FIXTURES / "TiO2-Ti-ALPHA-k1-1.pdos",
            FIXTURES / "TiO2-Ti-BETA-k1-1.pdos",
            FIXTURES / "TiO2-O-ALPHA-k1-1.pdos",
            FIXTURES / "TiO2-O-BETA-k1-1.pdos",
        ]
        files = [
            ("files", (fp.name, open(fp, "rb"), "application/octet-stream"))
            for fp in spin_files
        ]
        resp = client.post("/plugins/readers/upload", files=files)
        assert resp.status_code == 200, f"status={resp.status_code}"
        data = resp.json()
        session_id_spin = data["session_id"]
        session_data = data["data"]

        assert session_data["nspin"] == 2, f"Expected nspin=2, got {session_data['nspin']}"
        assert session_data["nions"] == 2  # Ti + O
        ok(f"nspin=2 (自旋极化), nions=2")
        ok(f"session_id={session_id_spin[:12]}...")
        passed += 1
    except Exception as e:
        fail(f"上传失败: {e}")
        failed += 1

    # ------------------------------------------------------------------
    # Test 6: POST /api/dos/compute — 用插件 session 计算 PDOS
    # ------------------------------------------------------------------
    header("Test 6: 使用插件创建的 session 计算 PDOS")
    if session_id_multi:
        try:
            compute_req = {
                "session_id": session_id_multi,
                "groups": [
                    {"atoms": [0], "channels": "d", "label": "Ti-d", "normalize": False},
                    {"atoms": [1], "channels": "p", "label": "O-p", "normalize": False},
                ],
                "sigma": 0.1,
                "emin": -15.0,
                "emax": 10.0,
                "ngrid": 500,
            }
            resp = client.post("/dos/compute", json=compute_req)
            assert resp.status_code == 200, f"status={resp.status_code}, body={resp.text}"
            data = resp.json()

            assert "grid" in data
            assert "series" in data
            assert len(data["grid"]) == 500
            assert len(data["series"]) == 2
            ok(f"PDOS 计算成功: grid={len(data['grid'])} points, series={len(data['series'])}")

            for s in data["series"]:
                max_up = max(s["spin_up"]) if s["spin_up"] else 0
                info(f"  {s['label']}: max(spin_up)={max_up:.4f}")
                if max_up > 0:
                    ok(f"  {s['label']} 有非零 DOS 数据")
                else:
                    fail(f"  {s['label']} DOS 全为零！")
                    failed += 1

            passed += 1
        except Exception as e:
            fail(f"PDOS 计算失败: {e}")
            failed += 1
    else:
        info("跳过 (Test 4 的 session 不可用)")

    # ------------------------------------------------------------------
    # Test 7: POST /api/plugins/readers/upload — 指定 reader_id
    # ------------------------------------------------------------------
    header("Test 7: 显式指定 reader_id=cp2k_pdos")
    try:
        ti_file = FIXTURES / "TiO2-Ti-k1-1.pdos"
        with open(ti_file, "rb") as f:
            resp = client.post(
                "/plugins/readers/upload",
                files=[("files", ("TiO2-Ti-k1-1.pdos", f, "application/octet-stream"))],
                data={"reader_id": "cp2k_pdos"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["reader_id"] == "cp2k_pdos"
        ok("显式 reader_id 路由正确")
        passed += 1
    except Exception as e:
        fail(f"请求失败: {e}")
        failed += 1

    # ------------------------------------------------------------------
    # Test 8: POST /api/plugins/readers/upload — 无匹配 reader → 400
    # ------------------------------------------------------------------
    header("Test 8: 上传不支持的文件类型 → 400 错误")
    try:
        resp = client.post(
            "/plugins/readers/upload",
            files=[("files", ("unknown.xyz", b"fake content", "application/octet-stream"))],
        )
        assert resp.status_code == 400, f"Expected 400, got {resp.status_code}"
        data = resp.json()
        assert "No reader found" in data["detail"]
        ok(f"正确返回 400: {data['detail'][:60]}...")
        passed += 1
    except Exception as e:
        fail(f"请求失败: {e}")
        failed += 1

    # ------------------------------------------------------------------
    # Test 9: POST /api/plugins/readers/upload — 不存在的 reader_id → 404
    # ------------------------------------------------------------------
    header("Test 9: 指定不存在的 reader_id → 404 错误")
    try:
        ti_file = FIXTURES / "TiO2-Ti-k1-1.pdos"
        with open(ti_file, "rb") as f:
            resp = client.post(
                "/plugins/readers/upload",
                files=[("files", ("TiO2-Ti-k1-1.pdos", f, "application/octet-stream"))],
                data={"reader_id": "nonexistent_reader"},
            )
        assert resp.status_code == 404, f"Expected 404, got {resp.status_code}"
        ok("正确返回 404")
        passed += 1
    except Exception as e:
        fail(f"请求失败: {e}")
        failed += 1

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    header("测试结果汇总")
    total = passed + failed
    if failed == 0:
        print(f"\n  {GREEN}{BOLD}全部通过 ✓{RESET}  {passed}/{total} tests")
    else:
        print(f"\n  {RED}{BOLD}{failed} 个失败 ✗{RESET}  {passed}/{total} tests")

    return passed, failed


def main():
    parser = argparse.ArgumentParser(description="Phase 1 ReaderPlugin 人工测试")
    parser.add_argument("--port", type=int, default=8000, help="后端端口 (default: 8000)")
    parser.add_argument("--host", default="localhost", help="后端地址 (default: localhost)")
    args = parser.parse_args()

    base_url = f"http://{args.host}:{args.port}/api"
    print(f"\n{BOLD}Phase 1 ReaderPlugin 人工测试{RESET}")
    print(f"后端地址: {base_url}")

    # Check server is reachable
    try:
        httpx.get(f"{base_url}/plugins/", timeout=5)
    except httpx.ConnectError:
        print(f"\n{RED}ERROR: 无法连接到 {base_url}{RESET}")
        print(f"请先启动后端:")
        print(f"  cd D:/CatGO-dev && pnpm desktop:serve")
        print(f"  或: conda activate CatGo01 && python server/main.py")
        sys.exit(1)

    passed, failed = run_tests(base_url)
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
