/// <reference lib="webworker" />
// Worker running the wfn-wasm module; one of a small pool (see engine.ts).
import { type CoreRequest, run_core } from "./wfn-core";

self.onmessage = async (
  event: MessageEvent<{ id: number; req: CoreRequest }>,
) => {
  const { id, req } = event.data;
  try {
    const res = await run_core(req);
    const transfer = `data` in res ? [res.data.buffer] : [];
    (self as unknown as Worker).postMessage({ id, res }, transfer);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ id, error });
  }
};
