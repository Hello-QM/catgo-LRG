import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import desktopConfig from '../../vite.desktop.config'

const require = createRequire(import.meta.url)
const repoRoot = resolve(import.meta.dirname, '../..')

type AliasEntry = {
  find: string | RegExp
  replacement: string
}

function getAliasEntries(): AliasEntry[] {
  const aliases = desktopConfig.resolve?.alias ?? []
  if (Array.isArray(aliases)) return aliases as AliasEntry[]
  return Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }))
}

function matchesAlias(find: string | RegExp, id: string): boolean {
  if (typeof find === 'string') return id === find || id.startsWith(`${find}/`)
  find.lastIndex = 0
  return find.test(id)
}

describe('desktop Vite ferrox WASM resolution', () => {
  it('leaves the threaded package subpath to the package exports map', () => {
    const threadedId = '@catgo/ferrox-wasm/threaded'
    const capturingAliases = getAliasEntries().filter(({ find }) =>
      matchesAlias(find, threadedId)
    )

    expect(capturingAliases).toEqual([])
    expect(realpathSync(require.resolve(threadedId))).toBe(
      realpathSync(resolve(repoRoot, 'extensions/rust-wasm/pkg-threaded/ferrox.js')),
    )
  })

  it('emits ES module workers so threaded dependencies can code split', () => {
    expect(desktopConfig.worker?.format).toBe('es')
  })
})
