// Reduced-motion preference helper — shared by the 3D viewer + trajectory playback.
//
// The viewer suppresses continuous animations (selection pulse, vibration
// auto-play, camera auto-rotate, trackball inertia, trajectory auto-play) when
// EITHER an explicit user setting (`reduced_motion`) is on OR the OS-level
// `prefers-reduced-motion: reduce` media query matches. This pure helper
// combines the two so the rAF-gating call sites stay trivial (and unit-testable
// without a real `matchMedia`).

/** True when continuous viewer animations should be suppressed. */
export function should_reduce_motion(setting: boolean, media_matches: boolean): boolean {
  return Boolean(setting) || Boolean(media_matches)
}

/** Reads the OS-level `prefers-reduced-motion: reduce` media query.
 *  SSR-safe: returns false when `matchMedia` is unavailable. */
export function os_prefers_reduced_motion(): boolean {
  return typeof matchMedia !== `undefined` &&
    matchMedia(`(prefers-reduced-motion: reduce)`).matches
}
