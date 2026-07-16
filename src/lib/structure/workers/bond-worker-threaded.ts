// Threaded bond-worker entry — the threads+SIMD+Rayon ferrox artifact
// (`@catgo/ferrox-wasm/threaded` → pkg-threaded/, built with wasm-bindgen-rayon).
// This is the ONE coordinating worker of design §8.3: it receives the compiled
// threaded WebAssembly.Module plus a thread_count, initializes wasm (the glue
// creates its own shared WebAssembly.Memory), then awaits
// `initThreadPool(thread_count)` BEFORE signalling ready — so a Rayon pool
// failure (no COI, sub-worker spawn failure, …) is an init failure the runtime
// retries once on the scalar artifact. The shared message loop lives in
// bond-worker.ts.

import * as glue from '@catgo/ferrox-wasm/threaded'
import { type BondWorkerGlue, type BondWorkerScope, install_bond_worker } from './bond-worker'

install_bond_worker(
  self as unknown as BondWorkerScope,
  glue as unknown as BondWorkerGlue,
)
