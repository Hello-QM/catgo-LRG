export interface FerroxWasmCandidate {
  filename: string
  buffer: Uint8Array
}

// The webview uses scalar wasm-bindgen glue. Threaded builds import memory,
// so passing one to that glue fails before slab generation starts.
export function select_scalar_ferrox_wasm<T extends FerroxWasmCandidate>(
  candidates: readonly T[],
  on_invalid?: (candidate: T, error: unknown) => void,
): T | undefined {
  for (const candidate of candidates) {
    try {
      const module = new WebAssembly.Module(
        candidate.buffer as unknown as BufferSource,
      )
      const is_threaded = WebAssembly.Module.imports(module)
        .some((entry) => entry.kind === `memory`)
      if (!is_threaded) return candidate
    } catch (error) {
      on_invalid?.(candidate, error)
    }
  }
}
