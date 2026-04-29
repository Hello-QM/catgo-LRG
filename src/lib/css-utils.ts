export function resolve_css_var(var_name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const computed = getComputedStyle(document.documentElement)
  const value = computed.getPropertyValue(var_name).trim()
  return value || fallback
}
