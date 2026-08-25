import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeAttachments, type MaterializedAttachment } from '../attachments.js'
import { buildClaudePrompt } from '../adapters/claude.js'
import { buildCodexInput } from '../adapters/codex.js'
import { buildGeminiPromptBlocks } from '../adapters/gemini.js'

const image: MaterializedAttachment = {
  type: 'image',
  name: 'surface.png',
  mimeType: 'image/png',
  data: Buffer.from('png').toString('base64'),
  path: '/tmp/surface.png',
}

const pdf: MaterializedAttachment = {
  type: 'pdf',
  name: 'paper.pdf',
  mimeType: 'application/pdf',
  data: Buffer.from('pdf').toString('base64'),
  path: '/tmp/paper.pdf',
}

describe('agent attachment transport', () => {
  it('materializes safe files under cwd and removes them after the turn', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'catgo-attachment-test-'))
    const bundle = materializeAttachments([{
      type: 'file',
      name: '../../input.txt',
      mimeType: 'text/plain',
      data: Buffer.from('hello').toString('base64'),
    }], cwd)

    expect(bundle.entries[0].path.startsWith(cwd)).toBe(true)
    expect(bundle.entries[0].path).not.toContain('../')
    expect(readFileSync(bundle.entries[0].path, 'utf8')).toBe('hello')
    const materializedPath = bundle.entries[0].path
    bundle.cleanup()
    expect(existsSync(materializedPath)).toBe(false)
  })

  it('builds native Claude image and PDF blocks', async () => {
    const input = buildClaudePrompt('inspect', [image, pdf])
    expect(typeof input).not.toBe('string')
    const messages = []
    for await (const message of input as AsyncIterable<any>) messages.push(message)
    const content = messages[0].message.content
    expect(content.some((block: any) => block.type === 'image')).toBe(true)
    expect(content.some((block: any) => block.type === 'document')).toBe(true)
  })

  it('passes Codex images as local_image and exposes other files by path', () => {
    const input = buildCodexInput('inspect', [image, pdf])
    expect(input).toEqual([
      { type: 'text', text: expect.stringContaining('/tmp/paper.pdf') },
      { type: 'local_image', path: '/tmp/surface.png' },
    ])
  })

  it('passes Gemini images as ACP image blocks and exposes other files by path', () => {
    const blocks = buildGeminiPromptBlocks('inspect', 'system', [image, pdf])
    expect(blocks[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('/tmp/paper.pdf'),
    })
    expect(blocks[1]).toEqual({
      type: 'image',
      data: image.data,
      mimeType: 'image/png',
    })
  })
})
