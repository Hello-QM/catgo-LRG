/**
 * Svelte action for drag-to-resize panels.
 *
 * Usage:
 *   <div use:resizable={{ side: 'left', min: 200, max: 600, onresize: (w) => width = w }}>
 */

export interface ResizableOptions {
  /** Which side the drag handle appears on */
  side: 'left' | 'right'
  /** Minimum width in px (default 200) */
  min?: number
  /** Maximum width in px (default 600) */
  max?: number
  /** Called with new width during drag */
  onresize?: (width: number) => void
}

export function resizable(node: HTMLElement, opts: ResizableOptions) {
  const HANDLE_WIDTH = 6

  const handle = document.createElement('div')
  handle.style.cssText = `
    position: absolute; top: 0; bottom: 0; width: ${HANDLE_WIDTH}px;
    cursor: col-resize; z-index: 4;
    ${opts.side === 'left' ? 'left: 0' : 'right: 0'};
  `
  // Hover highlight
  handle.addEventListener('mouseenter', () => {
    handle.style.background = 'var(--accent-color, #3b82f6)'
    handle.style.opacity = '0.3'
  })
  handle.addEventListener('mouseleave', () => {
    if (!dragging) {
      handle.style.background = ''
      handle.style.opacity = ''
    }
  })

  node.appendChild(handle)

  let dragging = false
  let startX = 0
  let startW = 0

  function onMouseDown(e: MouseEvent) {
    e.preventDefault()
    dragging = true
    startX = e.clientX
    startW = node.getBoundingClientRect().width
    handle.style.background = 'var(--accent-color, #3b82f6)'
    handle.style.opacity = '0.4'
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  function onMouseMove(e: MouseEvent) {
    if (!dragging) return
    const dx = e.clientX - startX
    // For left-side handle: dragging left increases width
    const raw = opts.side === 'left' ? startW - dx : startW + dx
    const min = opts.min ?? 200
    const max = opts.max ?? 600
    const clamped = Math.round(Math.max(min, Math.min(max, raw)))
    node.style.width = `${clamped}px`
    opts.onresize?.(clamped)
  }

  function onMouseUp() {
    dragging = false
    handle.style.background = ''
    handle.style.opacity = ''
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  handle.addEventListener('mousedown', onMouseDown)

  return {
    update(newOpts: ResizableOptions) {
      Object.assign(opts, newOpts)
      handle.style[opts.side === 'left' ? 'left' : 'right'] = '0'
      handle.style[opts.side === 'left' ? 'right' : 'left'] = ''
    },
    destroy() {
      handle.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      handle.remove()
    },
  }
}
