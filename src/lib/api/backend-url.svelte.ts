// Runtime backend-URL store + persistence (Model C: hosted frontend → user-chosen backend).
//
// Several API modules snapshot API_BASE/WS_BASE at import time and therefore
// ignore later changes to config.SERVER_URL. To switch the backend at runtime we
// must call EVERY module's setter, not just config.setServerUrl(). This module
// owns that fan-out plus localStorage persistence under the shared contract key
// 'catgo-backend-url'.
//
// Persistence pattern mirrors src/lib/structure/controllers/settings.svelte.ts
// (SSR-guarded, try/catch wrapped).

import { setServerUrl } from './config'
import { setHpcApiBase } from './hpc'
import { setMPApiBase } from './materials-project'
import { setApiBase } from './compute'
import { setOptimadeApiBase } from './optimade'
import { setPubChemApiBase } from './pubchem'

/** Shared contract: localStorage key for the user-entered backend URL. */
export const BACKEND_URL_STORAGE_KEY = `catgo-backend-url`

/** Frontend default backend URL (matches build-time config default). */
export const DEFAULT_BACKEND_URL = `http://localhost:8000`

/** Reactive, app-wide effective backend URL (empty string ⇒ build-time default). */
export const backend_url_store = $state<{ url: string }>({ url: `` })

/** Strip a trailing slash so `${base}/api` never produces a double slash. */
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, ``)
}

/** Read the persisted backend URL, or `null` when none is saved / unavailable. */
export function load_backend_url(): string | null {
  try {
    if (typeof window === `undefined`) return null
    const stored = localStorage.getItem(BACKEND_URL_STORAGE_KEY)
    if (typeof stored === `string` && stored.trim().length > 0) {
      return normalize(stored)
    }
  } catch (err) {
    console.warn(`[CatGo] Failed to load persisted backend URL:`, err)
  }
  return null
}

/** Persist the backend URL (empty/blank clears it so the default re-applies). */
export function save_backend_url(url: string): void {
  try {
    if (typeof window === `undefined`) return
    const normalized = normalize(url)
    if (normalized.length === 0) {
      localStorage.removeItem(BACKEND_URL_STORAGE_KEY)
    } else {
      localStorage.setItem(BACKEND_URL_STORAGE_KEY, normalized)
    }
  } catch (err) {
    console.warn(`[CatGo] Failed to save backend URL:`, err)
  }
}

/**
 * Apply a backend URL to EVERY API consumer so import-time snapshots pick it up.
 *
 * Fans out to all setters: config (live-binding consumers), hpc, materials-project,
 * compute, optimade, pubchem. Pass a blank string to reset everything to the
 * build-time default (http://localhost:8000).
 */
export function apply_backend_url(url: string): void {
  const base = normalize(url)
  const effective = base.length > 0 ? base : DEFAULT_BACKEND_URL
  const httpApi = `${effective}/api`
  const wsApi = effective.replace(/^http/, `ws`) + `/api`

  // config.ts — drives live-binding consumers + STATIC_ONLY fetch guard.
  setServerUrl(effective)
  // Snapshot consumers — each kept its own copy of API_BASE/WS_BASE at import.
  setHpcApiBase(httpApi, wsApi)
  setMPApiBase(httpApi)
  setApiBase(httpApi, wsApi)
  setOptimadeApiBase(httpApi)
  setPubChemApiBase(httpApi)

  backend_url_store.url = base
}

/**
 * Boot helper: load the saved URL (if any) and apply it before feature modules
 * make their first network calls. No-op when nothing is saved, so the default
 * behaviour (http://localhost:8000) is preserved.
 */
export function init_backend_url(): void {
  const saved = load_backend_url()
  if (saved) apply_backend_url(saved)
}
