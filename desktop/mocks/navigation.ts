// Mock for $app/navigation in standalone desktop build
export function goto(url: string) {
  console.warn('Navigation not available in desktop app:', url)
  return Promise.resolve()
}

export function invalidate() {
  return Promise.resolve()
}

export function invalidateAll() {
  return Promise.resolve()
}

export function preloadData() {
  return Promise.resolve()
}

export function preloadCode() {
  return Promise.resolve()
}

export function beforeNavigate() {}
export function afterNavigate() {}
export function onNavigate() {}
