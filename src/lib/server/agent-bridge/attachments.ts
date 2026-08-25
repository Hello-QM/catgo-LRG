import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Attachment } from './types.js'

const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export interface MaterializedAttachment extends Attachment {
  path: string
}

export interface MaterializedAttachments {
  entries: MaterializedAttachment[]
  cleanup: () => void
}

function safeFileName(name: string, index: number): string {
  const leaf = name.split(/[\\/]/).pop() || `attachment-${index + 1}`
  const safe = leaf.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  return `${String(index + 1).padStart(2, '0')}-${safe || 'attachment'}`
}

function decodeBase64(data: string, name: string): Buffer {
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error(`Attachment "${name}" has no data`)
  }
  // Base64 expands bytes by roughly 4/3. Reject before allocating a large
  // Buffer; the renderer already enforces the same 20 MiB per-file limit, but
  // the local bridge is still an input boundary and must validate independently.
  if (data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4) {
    throw new Error(`Attachment "${name}" exceeds the 20MB limit`)
  }
  const compact = data.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error(`Attachment "${name}" is not valid base64`)
  }
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment "${name}" exceeds the 20MB limit`)
  }
  return bytes
}

/**
 * Materialize browser-supplied attachments inside the agent's working tree.
 *
 * Codex accepts images by local path, while Claude/Gemini need a path fallback
 * for arbitrary files. Keeping the turn directory under `cwd` also makes it
 * readable when a CLI restricts file tools to the current workspace. The
 * caller must invoke cleanup in a finally block after the streamed turn ends.
 */
export function materializeAttachments(
  attachments: Attachment[] | undefined,
  cwd: string,
): MaterializedAttachments {
  if (!attachments || attachments.length === 0) {
    return { entries: [], cleanup: () => {} }
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`At most ${MAX_ATTACHMENTS} attachments can be sent in one message`)
  }
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
  const dir = mkdtempSync(join(cwd, '.catgo-attachments-'))
  try {
    const entries = attachments.map((attachment, index) => {
      const path = join(dir, safeFileName(attachment.name, index))
      writeFileSync(path, decodeBase64(attachment.data, attachment.name))
      return { ...attachment, path }
    })
    return {
      entries,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/** Text appended for attachments that a provider cannot embed natively. */
export function attachmentPathContext(entries: MaterializedAttachment[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map(
    (entry) => `- ${entry.name} (${entry.mimeType || 'application/octet-stream'}): ${entry.path}`,
  )
  return [
    '[Attachments]',
    'The user attached the following local files. Inspect them with your file/image tools before answering:',
    ...lines,
  ].join('\n')
}
