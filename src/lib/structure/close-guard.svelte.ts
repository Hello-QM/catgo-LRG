import { SvelteSet } from 'svelte/reactivity'

export function create_modified_registry() {
  const dirty = new SvelteSet<string>()
  return {
    mark: (tab_id: string) => dirty.add(tab_id),
    clear: (tab_id: string) => dirty.delete(tab_id),
    is_modified: (tab_id: string) => dirty.has(tab_id),
    any_modified: () => dirty.size > 0,
  }
}
