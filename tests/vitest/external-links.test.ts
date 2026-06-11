import { beforeEach, describe, expect, it, vi } from 'vitest'

const open_mock = vi.fn(() => Promise.resolve())
let tauri_present = true

vi.mock(`$lib/io/tauri`, () => ({ check_tauri: () => tauri_present }))
vi.mock(`@tauri-apps/plugin-shell`, () => ({ open: open_mock }))

import { install_external_link_handler } from '$lib/io/external-links'

function click_anchor(href: string): MouseEvent {
  const anchor = document.createElement(`a`)
  anchor.href = href
  anchor.textContent = `link`
  document.body.appendChild(anchor)
  const event = new MouseEvent(`click`, { bubbles: true, cancelable: true })
  anchor.dispatchEvent(event)
  anchor.remove()
  return event
}

describe(`install_external_link_handler`, () => {
  beforeEach(() => {
    open_mock.mockClear()
    tauri_present = true
    document.body.replaceChildren()
  })

  it(`routes cross-origin http(s) anchors through shell.open`, async () => {
    install_external_link_handler()
    const event = click_anchor(`https://github.com/Hello-QM/catgo-LRG`)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(open_mock).toHaveBeenCalledWith(`https://github.com/Hello-QM/catgo-LRG`))
  })

  it(`leaves same-origin links alone`, () => {
    install_external_link_handler()
    const event = click_anchor(`${globalThis.location.origin}/some/page`)
    expect(event.defaultPrevented).toBe(false)
    expect(open_mock).not.toHaveBeenCalled()
  })

  it(`leaves non-http schemes alone`, () => {
    install_external_link_handler()
    const event = click_anchor(`mailto:someone@example.com`)
    expect(event.defaultPrevented).toBe(false)
    expect(open_mock).not.toHaveBeenCalled()
  })

  it(`does nothing outside Tauri`, () => {
    tauri_present = false
    install_external_link_handler()
    const event = click_anchor(`https://github.com/Hello-QM/catgo-LRG`)
    expect(event.defaultPrevented).toBe(false)
    expect(open_mock).not.toHaveBeenCalled()
  })
})
