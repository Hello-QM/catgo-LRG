<script module lang="ts">
  import DOMPurify from 'dompurify'

  export function base64_to_arraybuffer(b64: string): ArrayBuffer {
    const bin = atob(b64)
    const len = bin.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
    return bytes.buffer
  }

  export function sanitize_docx_html(raw: string): string {
    // Keep DOMPurify's default XSS protections (strips <script>, on* handlers,
    // javascript:/data: on hrefs) but allow data: URIs on <img> so mammoth's
    // inline base64 images render.
    return DOMPurify.sanitize(raw, {
      ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|blob):/i,
      ADD_DATA_URI_TAGS: ['img'],
    })
  }
</script>

<script lang="ts">
  let { base64 }: { base64: string } = $props()
  let html = $state(``)
  let error = $state(``)
  // 'input' = no bytes reached us; 'output' = mammoth returned no HTML.
  let empty = $state<'' | 'input' | 'output'>(``)
  // Blob URLs minted for embedded images this render — revoked on re-render/unmount.
  let blob_urls: string[] = []

  function revoke_blobs(): void {
    for (const u of blob_urls) URL.revokeObjectURL(u)
    blob_urls = []
  }

  $effect(() => {
    error = ``
    html = ``
    empty = ``
    revoke_blobs()
    const b64 = base64
    if (!b64) { empty = `input`; return }
    let cancelled = false
    ;(async () => {
      try {
        // Use mammoth's prebuilt browser bundle — the default `mammoth` entry is
        // the Node build and silently yields empty output in a WebView.
        // @ts-expect-error no type declarations for the browser bundle subpath
        const mod = await import(`mammoth/mammoth.browser.js`)
        const mammoth = mod.default ?? mod
        // Emit embedded images as lightweight blob: URLs instead of mammoth's
        // default inline base64 data URIs — the latter bloat the HTML by the
        // full image size, making DOMPurify + DOM parsing slow for image-heavy
        // docs. Blob URLs keep the HTML tiny and let the WebView load images
        // lazily from memory.
        const minted: string[] = []
        const convert_image = mammoth.images.imgElement(async (image: { read: (e: string) => Promise<string>; contentType: string }) => {
          const data = await image.read(`base64`)
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bytes], { type: image.contentType }))
          minted.push(url)
          return { src: url }
        })
        const result = await mammoth.convertToHtml(
          { arrayBuffer: base64_to_arraybuffer(b64) },
          { convertImage: convert_image },
        )
        if (cancelled) { for (const u of minted) URL.revokeObjectURL(u); return }
        blob_urls = minted
        const safe = sanitize_docx_html(result.value || ``)
        html = safe
        if (!safe.trim()) empty = `output`
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    })()
    return () => { cancelled = true; revoke_blobs() }
  })
</script>

{#if error}
  <div class="docx-error">Failed to render .docx: {error}</div>
{:else if empty === `input`}
  <div class="docx-error">No document content received (the file may not have been read).</div>
{:else if empty === `output`}
  <div class="docx-error">mammoth produced no HTML for this .docx (unsupported content, e.g. images/tables only).</div>
{:else}
  <!-- mammoth output is structural HTML from a .docx; rendered read-only -->
  <div class="docx-body">{@html html}</div>
{/if}

<style>
  .docx-body {
    padding: 16px 24px;
    overflow: auto;
    height: 100%;
    line-height: 1.5;
    color: var(--text-color, #e2e8f0);
  }
  .docx-error {
    padding: 16px;
    color: var(--error-color, #f87171);
  }
</style>
