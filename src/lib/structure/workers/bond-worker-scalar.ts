// Scalar bond-worker entry — the portable single-thread SIMD ferrox artifact
// (`@catgo/ferrox-wasm` resolves to pkg/, a copy of pkg-scalar). Loaded by
// bond-worker-api via `?worker&inline`; the shared message loop lives in
// bond-worker.ts.

import * as glue from '@catgo/ferrox-wasm'
import { type BondWorkerGlue, type BondWorkerScope, install_bond_worker } from './bond-worker'

install_bond_worker(
  self as unknown as BondWorkerScope,
  glue as unknown as BondWorkerGlue,
)
