<script lang="ts">
  import { desktop_download } from '$lib/desktop-download.svelte'
  import Icon from '$lib/Icon.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('app')

  const REPO = `Hello-QM/catgo-LRG`
  const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

  type OS = `windows` | `mac` | `linux` | `android` | `ios`

  function detect_os(): OS {
    const ua = (typeof navigator !== `undefined` && navigator.userAgent) || ``
    const is_ios = /iPhone|iPad|iPod/i.test(ua) ||
      (/Macintosh/.test(ua) && typeof navigator !== `undefined` && navigator.maxTouchPoints > 1)
    if (is_ios) return `ios`
    if (/Android/i.test(ua)) return `android`
    if (/Windows/i.test(ua)) return `windows`
    if (/Mac/i.test(ua)) return `mac`
    return `linux`
  }

  let os = $state<OS>(detect_os())
  let status = $state<`idle` | `fetching`>(`idle`)

  // iOS ships via TestFlight public beta (an unsigned .ipa won't install), so
  // the iOS option opens the join link rather than a release asset.
  const TESTFLIGHT = `https://testflight.apple.com/join/FdHup5Hz`

  const OSES: OS[] = [`windows`, `mac`, `linux`, `android`, `ios`]
  const os_label: Record<OS, string> = {
    windows: `Windows`,
    mac: `macOS`,
    linux: `Linux`,
    android: `Android`,
    ios: `iOS`,
  }

  // Release assets are version-stamped (CatGo_1.3.4_amd64.deb, _x64-setup.exe,
  // _aarch64.dmg, CatGo-v1.3.4-android-universal.apk, ...). Match by extension so
  // the URL auto-tracks each release.
  const matchers: Record<OS, RegExp[]> = {
    windows: [/_x64-setup\.exe$/i, /\.msi$/i, /\.exe$/i],
    mac: [/aarch64.*\.dmg$/i, /\.dmg$/i, /\.app\.tar\.gz$/i],
    linux: [/_amd64\.deb$/i, /\.deb$/i, /\.rpm$/i, /\.AppImage$/i],
    android: [/android.*\.apk$/i, /\.apk$/i],
    ios: [],
  }

  async function download() {
    // iOS → TestFlight external testing, not a release asset.
    if (os === `ios`) {
      window.open(TESTFLIGHT, `_blank`, `noopener`)
      desktop_download.close()
      return
    }
    status = `fetching`
    try {
      // Always hit releases/latest so we follow the newest version automatically.
      const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      if (!resp.ok) throw new Error(`GitHub API ${resp.status}`)
      const rel = await resp.json()
      const assets: { name: string; browser_download_url: string }[] = rel.assets || []
      let url = ``
      for (const re of matchers[os]) {
        const hit = assets.find((a) => re.test(a.name))
        if (hit) {
          url = hit.browser_download_url
          break
        }
      }
      if (url) {
        window.location.href = url
        desktop_download.close()
      } else {
        // No matching asset for this OS — fall back to the releases page.
        window.open(RELEASES_PAGE, `_blank`, `noopener`)
      }
    } catch {
      // API rate-limited / offline — fall back to the releases page.
      window.open(RELEASES_PAGE, `_blank`, `noopener`)
    } finally {
      status = `idle`
    }
  }
</script>

{#if desktop_download.visible}
  <div class="ddm-overlay" role="presentation" onclick={() => desktop_download.close()}>
    <div class="ddm-modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
      <button class="ddm-close" aria-label="close" onclick={() => desktop_download.close()}>
        <Icon icon="Cross" />
      </button>
      <div class="ddm-head">
        <Icon icon="Download" />
        <h3>{t('app.desktop_required_title')}</h3>
      </div>
      <p class="ddm-msg">{t('app.desktop_required_msg')}</p>

      <div class="ddm-os">
        {#each OSES as o}
          <button class="ddm-os-btn" class:active={os === o} onclick={() => (os = o)}>
            {os_label[o]}
          </button>
        {/each}
      </div>

      <button class="ddm-download" disabled={status === `fetching`} onclick={download}>
        {#if status === `fetching`}
          {t('app.desktop_fetching')}
        {:else if os === `ios`}
          {t('app.desktop_ios_testflight')}
        {:else}
          {t('app.desktop_download_for', { os: os_label[os] })}
        {/if}
      </button>

      <a class="ddm-fallback" href={RELEASES_PAGE} target="_blank" rel="noopener">
        {t('app.desktop_all_downloads')}
      </a>
    </div>
  </div>
{/if}

<style>
  .ddm-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }
  .ddm-modal {
    position: relative;
    width: min(420px, 92vw);
    padding: 24px;
    border-radius: 12px;
    background: var(--surface-color, #1e293b);
    color: var(--text-color, #e2e8f0);
    border: 1px solid rgba(59, 130, 246, 0.3);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  }
  .ddm-close {
    position: absolute;
    top: 10px;
    right: 10px;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
  }
  .ddm-close:hover {
    opacity: 1;
  }
  .ddm-head {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #60a5fa;
    margin-bottom: 8px;
  }
  .ddm-head h3 {
    margin: 0;
    font-size: 1.1em;
    color: var(--text-color, #e2e8f0);
  }
  .ddm-msg {
    margin: 0 0 16px;
    font-size: 0.9em;
    opacity: 0.85;
    line-height: 1.5;
  }
  .ddm-os {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }
  .ddm-os-btn {
    flex: 1;
    padding: 8px;
    border-radius: 8px;
    border: 1px solid rgba(148, 163, 184, 0.3);
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.9em;
  }
  .ddm-os-btn.active {
    border-color: #3b82f6;
    background: rgba(59, 130, 246, 0.15);
    color: #93c5fd;
    font-weight: 600;
  }
  .ddm-download {
    width: 100%;
    padding: 10px;
    border-radius: 8px;
    border: none;
    background: #3b82f6;
    color: #fff;
    font-weight: 600;
    cursor: pointer;
  }
  .ddm-download:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .ddm-fallback {
    display: block;
    text-align: center;
    margin-top: 12px;
    font-size: 0.82em;
    color: #93c5fd;
  }
</style>
