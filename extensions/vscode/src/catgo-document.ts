import { Buffer } from 'node:buffer'
import { basename } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as vscode from 'vscode'

// Injected dependencies keep CatgoDocument a VS-Code-free, unit-testable core:
// the round-trip to the webview and the actual disk write are supplied by the
// Provider (see extension.ts), so tests can drive save() with plain fakes.
export interface DocDeps {
  requestContent: () => Promise<{ content: string; is_binary: boolean }>
  writeFile: (uri: vscode.Uri, data: Uint8Array) => Promise<void>
  showError?: (message: string) => void
}

// Editable custom-editor document. Structural edit state lives in the webview;
// this only tracks dirtiness (via onDidChange) and performs saves by asking the
// webview for the current content and writing it to `uri` (or a Save-As/backup
// target). Format is never changed on save — whatever the webview returns is
// written to the source path as-is (gzip re-applied for `.gz` sources).
export class CatgoDocument implements vscode.CustomDocument {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event
  constructor(public readonly uri: vscode.Uri, private deps: DocDeps) {}
  signalEdit(): void {
    this._onDidChange.fire()
  }
  async save(target: vscode.Uri = this.uri): Promise<void> {
    const { content, is_binary } = await this.deps.requestContent()
    // Empty content means the webview cannot serialize this source (OUTCAR,
    // cube, CHGCAR, LAMMPS dump, trajectory formats). Treat as a failed save:
    // surface an error and leave the file untouched — never write an empty
    // file and never let VS Code mark the document clean.
    if (!content) {
      const message = `CatGo: cannot save ${basename(target.fsPath)} — ` +
        `this file's format is not editable (the viewer produced no content).`
      this.deps.showError?.(message)
      throw new Error(message)
    }
    let data = is_binary
      ? Uint8Array.from(Buffer.from(content.replace(/^data:[^;]+;base64,/, ``), `base64`))
      : new TextEncoder().encode(content)
    // A `.gz` source is delivered UNCOMPRESSED by the webview; re-gzip so the
    // on-disk file stays a valid gzip archive rather than corrupt plain text.
    if (target.fsPath.endsWith(`.gz`)) {
      data = gzipSync(data)
    }
    await this.deps.writeFile(target, data)
  }
  dispose(): void {
    this._onDidChange.dispose()
  }
}
