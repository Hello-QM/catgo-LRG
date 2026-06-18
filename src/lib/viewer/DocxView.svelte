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
      ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
      ADD_DATA_URI_TAGS: ['img'],
    })
  }
</script>

<script lang="ts">
  let { base64 }: { base64: string } = $props()
  let html = $state(``)
  let error = $state(``)

  $effect(() => {
    error = ``
    html = ``
    const b64 = base64
    if (!b64) return
    ;(async () => {
      try {
        const mammoth = (await import(`mammoth`)).default ?? (await import(`mammoth`))
        const result = await mammoth.convertToHtml({ arrayBuffer: base64_to_arraybuffer(b64) })
        html = sanitize_docx_html(result.value)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    })()
  })
</script>

{#if error}
  <div class="docx-error">{error}</div>
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
