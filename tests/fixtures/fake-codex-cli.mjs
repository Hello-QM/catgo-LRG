#!/usr/bin/env node

import { writeFileSync } from 'node:fs'

const argsPath = process.env.CATGO_CODEX_TEST_ARGS_FILE
if (argsPath) {
  writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)), 'utf8')
}

process.stdin.resume()
process.stdin.on('end', () => {
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'test-thread' })}\n`)
  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
  })}\n`)
})
