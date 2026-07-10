// Minimal `vscode` module mock for extension-host unit tests.
//
// The real `vscode` module is only provided by the VS Code host at runtime,
// so it cannot be resolved under vitest. Extension-host tests either declare
// an inline `vi.mock('vscode', ...)` (see tests/extension.test.ts) or rely on
// this module via the `vscode` alias in vitest.config.ts.
//
// Only the surface exercised at runtime by the code under test is implemented.
// `src/catgo-document.ts` (the VS-Code-free document core) uses a functional
// `EventEmitter`; every other `vscode.*` reference in that file is type-only
// and erased at compile time, so it needs no runtime shape here.

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = []
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener)
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener)
      },
    }
  }
  fire(data: T): void {
    for (const listener of [...this.listeners]) listener(data)
  }
  dispose(): void {
    this.listeners = []
  }
}
