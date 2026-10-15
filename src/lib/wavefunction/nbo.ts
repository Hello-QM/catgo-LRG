/**
 * NBO results from Gaussian / ORCA output (NBO 3–7): natural charges,
 * Wiberg bond indices and second-order perturbation (E(2)) energies.
 */

import type { NboCharge, NboE2, NboResult } from "./api";

const NPA_ROW =
  /^\s*([A-Z][a-z]?)\s+(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/;
const WBI_HEADER = /^\s*Atom(\s+\d+)+\s*$/;
const WBI_ROW = /^\s*(\d+)\.\s+([A-Za-z]{1,2})((?:\s+-?\d+\.\d+)+)\s*$/;
const E2_ROW =
  /^\s*(\d+)\.\s*(\S.*?)\s+\/?\s*(\d+)\.\s*(\S.*?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/;

const squash = (s: string) => s.trim().split(/\s+/).join(` `);

function npa_charges(lines: string[]): NboCharge[] {
  for (let k = 0; k < lines.length; k++) {
    if (!lines[k].includes(`Summary of Natural Population Analysis`)) continue;
    const rows: NboCharge[] = [];
    for (const row of lines.slice(k + 1)) {
      const m = row.match(NPA_ROW);
      if (m) {
        rows.push({
          atom: Number(m[2]),
          symbol: m[1],
          charge: Number(m[3]),
          core: Number(m[4]),
          valence: Number(m[5]),
          rydberg: Number(m[6]),
          total: Number(m[7]),
        });
      } else if (
        rows.length && (row.includes(`====`) || row.includes(`Total`))
      ) {
        break;
      }
    }
    if (rows.length) return rows;
  }
  return [];
}

function wiberg(lines: string[]): number[][] {
  for (let k = 0; k < lines.length; k++) {
    if (!lines[k].includes(`Wiberg bond index matrix`)) continue;
    let cols: number[] = [];
    const matrix = new Map<number, Map<number, number>>();
    for (const row of lines.slice(k + 1)) {
      if (!row.trim() || /^[- ]+$/.test(row.trim())) continue;
      if (WBI_HEADER.test(row)) {
        cols = row.trim().split(/\s+/).slice(1).map(Number);
        continue;
      }
      const m = row.match(WBI_ROW);
      if (m && cols.length) {
        const i = Number(m[1]);
        const vals = m[3].trim().split(/\s+/).map(Number);
        if (!matrix.has(i)) matrix.set(i, new Map());
        cols.forEach((c, j) => matrix.get(i)!.set(c, vals[j]));
        continue;
      }
      break;
    }
    if (matrix.size) {
      const n = Math.max(...matrix.keys());
      return Array.from(
        { length: n },
        (_, i) =>
          Array.from(
            { length: n },
            (_, j) => matrix.get(i + 1)?.get(j + 1) ?? 0,
          ),
      );
    }
  }
  return [];
}

function e2_entries(lines: string[]): NboE2[] {
  const entries: NboE2[] = [];
  let spin: NboE2[`spin`] = null;
  let in_e2 = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.includes(`ALPHA SPIN ORBITALS`)) spin = `alpha`;
    else if (upper.includes(`BETA SPIN ORBITALS`)) spin = `beta`;
    if (upper.includes(`SECOND ORDER PERTURBATION THEORY ANALYSIS`)) {
      in_e2 = true;
      continue;
    }
    if (!in_e2) continue;
    if (
      upper.includes(`NATURAL BOND ORBITALS (SUMMARY)`) ||
      upper.includes(`NBO SUMMARY`)
    ) {
      in_e2 = false;
      continue;
    }
    const m = line.match(E2_ROW);
    if (m) {
      entries.push({
        donor_index: Number(m[1]),
        donor: squash(m[2]),
        acceptor_index: Number(m[3]),
        acceptor: squash(m[4]),
        e2: Number(m[5]),
        gap: Number(m[6]),
        fock: Number(m[7]),
        spin,
      });
    }
  }
  return entries;
}

/** Natural charges, Wiberg indices and the strongest E(2) donor→acceptor pairs. */
export function parse_nbo(text: string, max_e2 = 300): NboResult {
  const lines = text.split(/\r?\n/);
  const charges = npa_charges(lines);
  const wbi = wiberg(lines);
  const e2 = e2_entries(lines).sort((a, b) => b.e2 - a.e2);
  if (!charges.length && !wbi.length && !e2.length) {
    throw new Error(
      `No NBO results found (expected natural population, Wiberg or E(2) sections)`,
    );
  }
  const bonds: NboResult[`bonds`] = [];
  wbi.forEach((row, i) => {
    for (let j = i + 1; j < row.length; j++) {
      if (row[j] >= 0.1) bonds.push({ atoms: [i + 1, j + 1], wbi: row[j] });
    }
  });
  bonds.sort((a, b) => b.wbi - a.wbi);
  return {
    charges,
    wiberg: wbi,
    bonds,
    e2: e2.slice(0, max_e2),
    n_e2: e2.length,
  };
}
