export interface SelectedKeyFile {
  path?: string
  name: string
  content?: string
}

function is_tauri_runtime(): boolean {
  return typeof window !== `undefined` && (`__TAURI__` in window || `__TAURI_INTERNALS__` in window)
}

function is_mobile_runtime(): boolean {
  if (typeof navigator === `undefined`) return false
  const ua = navigator.userAgent
  return /android|iphone|ipod|ipad/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

async function pick_browser_key_file(): Promise<SelectedKeyFile | null> {
  if (typeof document === `undefined`) return null

  return new Promise((resolve) => {
    const input = document.createElement(`input`)
    input.type = `file`
    input.accept = `.pem,.key,.rsa,.ed25519,.openssh,.ppk,*`
    input.style.display = `none`

    input.onchange = async () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) {
        resolve(null)
        return
      }
      try {
        resolve({
          name: file.name,
          content: await file.text(),
        })
      } catch {
        resolve(null)
      }
    }

    document.body.appendChild(input)
    input.click()
  })
}

export async function pick_hpc_key_file(): Promise<SelectedKeyFile | null> {
  if (is_tauri_runtime() && !is_mobile_runtime()) {
    try {
      const { open } = await import(`@tauri-apps/plugin-dialog`)
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: `SSH private keys`, extensions: [`pem`, `key`, `rsa`, `ed25519`, `openssh`, `ppk`] },
          { name: `All files`, extensions: [`*`] },
        ],
      })
      if (typeof picked === `string` && picked) {
        return { path: picked, name: basename(picked) }
      }
    } catch {
      // Browser builds cannot import Tauri plugins; fall back to content import.
    }
  }

  return pick_browser_key_file()
}
