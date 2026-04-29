/**
 * Attachment handling, clipboard, and code-block interaction helpers for ChatPane.
 */

/** Copy text to clipboard with fallback for older browsers */
export function copy_to_clipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {
      _fallback_copy(text)
    })
  }
  _fallback_copy(text)
  return Promise.resolve()
}

function _fallback_copy(text: string): void {
  const ta = document.createElement(`textarea`)
  ta.value = text
  ta.style.position = `fixed`
  ta.style.opacity = `0`
  document.body.appendChild(ta)
  ta.select()
  document.execCommand(`copy`)
  document.body.removeChild(ta)
}

/**
 * Event-delegated click handler for code blocks inside the messages container.
 * Handles "Copy code" and "Expand/Collapse" buttons.
 */
export function handle_messages_click(event: MouseEvent): void {
  const target = event.target as HTMLElement

  // Copy code button
  if (target.classList.contains(`copy-code-btn`)) {
    const wrapper = target.closest(`.code-block-wrapper`)
    // For collapsible blocks, copy from the full code (hidden or visible)
    const full_el = wrapper?.querySelector(`.code-full code`) ?? wrapper?.querySelector(`code`)
    if (!full_el) return
    copy_to_clipboard(full_el.textContent ?? ``).then(() => {
      target.textContent = `Copied!`
      setTimeout(() => { target.textContent = `Copy` }, 1500)
    })
    return
  }

  // Expand/collapse code button
  if (target.classList.contains(`code-expand-btn`)) {
    const wrapper = target.closest(`.code-block-wrapper`) as HTMLElement | null
    if (!wrapper) return
    const preview = wrapper.querySelector(`.code-preview`) as HTMLElement | null
    const full = wrapper.querySelector(`.code-full`) as HTMLElement | null
    const collapsed = wrapper.getAttribute(`data-collapsed`) === `true`
    if (preview && full) {
      preview.style.display = collapsed ? `none` : ``
      full.style.display = collapsed ? `` : `none`
      wrapper.setAttribute(`data-collapsed`, collapsed ? `false` : `true`)
      target.textContent = collapsed ? `Collapse` : `Show all ${wrapper.getAttribute(`data-lines`) ?? ``} lines`
    }
    return
  }
}
