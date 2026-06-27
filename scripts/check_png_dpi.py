#!/usr/bin/env python3
"""Check the pHYs DPI metadata of a PNG file.

Usage:
  python scripts/check_png_dpi.py exported.png 600
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def read_phys(path: Path) -> tuple[int, int, int]:
  data = path.read_bytes()
  if not data.startswith(PNG_SIGNATURE):
    raise ValueError(f"{path} is not a PNG file")

  offset = len(PNG_SIGNATURE)
  while offset + 8 <= len(data):
    length = struct.unpack(">I", data[offset:offset + 4])[0]
    chunk_type = data[offset + 4:offset + 8]
    chunk_data_start = offset + 8
    chunk_end = chunk_data_start + length + 4
    if chunk_end > len(data):
      raise ValueError(f"{path} has a truncated PNG chunk")
    if chunk_type == b"pHYs":
      if length != 9:
        raise ValueError(f"{path} has an invalid pHYs chunk length: {length}")
      x_ppm, y_ppm, unit = struct.unpack(">IIB", data[chunk_data_start:chunk_data_start + 9])
      return x_ppm, y_ppm, unit
    offset = chunk_end

  raise ValueError(f"{path} has no pHYs chunk")


def ppm_to_dpi(ppm: int) -> float:
  return ppm * 0.0254


def main(argv: list[str]) -> int:
  if len(argv) not in (2, 3):
    print("Usage: python scripts/check_png_dpi.py exported.png [expected_dpi]", file=sys.stderr)
    return 2

  path = Path(argv[1])
  x_ppm, y_ppm, unit = read_phys(path)
  x_dpi = ppm_to_dpi(x_ppm)
  y_dpi = ppm_to_dpi(y_ppm)
  print(f"{path}: x={x_dpi:.2f} dpi, y={y_dpi:.2f} dpi, unit={unit}")

  if len(argv) == 3:
    expected = float(argv[2])
    # PNG stores pixels per meter as an integer, so a tiny conversion tolerance
    # is expected when converting back to DPI.
    if abs(x_dpi - expected) > 0.02 or abs(y_dpi - expected) > 0.02 or unit != 1:
      print(f"Expected {expected:.2f} dpi with meter unit, got {x_dpi:.2f}/{y_dpi:.2f}", file=sys.stderr)
      return 1
  return 0


if __name__ == "__main__":
  raise SystemExit(main(sys.argv))
