<script lang="ts">
  import { markdown_to_html } from '$lib/chat/markdown'
  import { download as unified_download } from '$lib/io/fetch'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('sidebar')
  load_i18n_module('structure')

  let {
    mode,
    content = ``,
    binary_data = ``,
    mime_type = ``,
    filename = ``,
    file_path = ``,
    session_id = ``,
    readonly = true,
    onclose,
  }: {
    mode: 'image' | 'pdf' | 'markdown' | 'csv' | 'excel' | 'text'
    content?: string
    binary_data?: string
    mime_type?: string
    filename?: string
    file_path?: string
    session_id?: string
    readonly?: boolean
    onclose?: () => void
  } = $props()

  // --- Image zoom state ---
  let img_scale = $state(1)
  let img_natural_width = $state(0)
  let img_natural_height = $state(0)

  function on_wheel(e: WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    img_scale = Math.max(0.1, Math.min(10, img_scale + delta))
  }

  function on_img_load(e: Event) {
    const img = e.target as HTMLImageElement
    img_natural_width = img.naturalWidth
    img_natural_height = img.naturalHeight
  }

  // --- PDF blob URL ---
  let pdf_blob_url = $state(``)

  $effect(() => {
    if (mode !== `pdf` || !binary_data) return
    const bytes = Uint8Array.from(atob(binary_data), (c) => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: mime_type || `application/pdf` })
    const url = URL.createObjectURL(blob)
    pdf_blob_url = url
    return () => {
      URL.revokeObjectURL(url)
      pdf_blob_url = ``
    }
  })

  // --- Markdown rendered HTML ---
  let rendered_markdown = $state(``)
  $effect(() => {
    if (mode !== `markdown`) { rendered_markdown = ``; return }
    const html = markdown_to_html(content)
    rendered_markdown = html

    // Resolve remote images when viewing HPC markdown files
    if (session_id && file_path) {
      resolve_remote_images(html, session_id, file_path).then((resolved) => {
        if (resolved !== html) rendered_markdown = resolved
      })
    }
  })

  /** Scan rendered HTML for <img> with relative src, fetch from HPC, replace with data URI. */
  async function resolve_remote_images(html: string, sid: string, md_path: string): Promise<string> {
    const { readRemoteBinaryFile } = await import(`$lib/api/hpc`)
    const dir = md_path.substring(0, md_path.lastIndexOf(`/`))
    // Match both src="..." and src=&quot;...&quot; (HTML-escaped from esc())
    const img_regex = /<img\s[^>]*?src="([^"]+)"/g
    const matches = [...html.matchAll(img_regex)]
    if (matches.length === 0) return html

    let result = html
    for (const match of matches) {
      const src = match[1]
      if (src.startsWith(`data:`) || src.startsWith(`http://`) || src.startsWith(`https://`)) continue
      const abs_path = src.startsWith(`/`) ? src : `${dir}/${src}`
      try {
        const resp = await readRemoteBinaryFile(sid, abs_path)
        if (resp.success && resp.data) {
          // Guess MIME from extension if not provided
          const mime = resp.mime_type || guess_image_mime(src)
          result = result.replace(
            `src="${src}"`,
            `src="data:${mime};base64,${resp.data}"`,
          )
        } else {
          console.warn(`[FilePreview] Failed to load remote image: ${abs_path}`, resp.message)
        }
      } catch (err) {
        console.warn(`[FilePreview] Error fetching remote image: ${abs_path}`, err)
      }
    }
    return result
  }

  function guess_image_mime(path: string): string {
    const ext = path.split(`.`).pop()?.toLowerCase()
    const map: Record<string, string> = {
      png: `image/png`, jpg: `image/jpeg`, jpeg: `image/jpeg`, gif: `image/gif`,
      svg: `image/svg+xml`, webp: `image/webp`, bmp: `image/bmp`, ico: `image/x-icon`,
    }
    return map[ext ?? ``] ?? `image/png`
  }

  // --- CSV parsing ---
  function parse_csv(text: string, delimiter = `,`): string[][] {
    const rows: string[][] = []
    for (const line of text.split(`\n`)) {
      if (!line.trim()) continue
      const cells: string[] = []
      let current = ``
      let in_quotes = false
      for (const char of line) {
        if (char === `"`) { in_quotes = !in_quotes; continue }
        if (char === delimiter && !in_quotes) { cells.push(current.trim()); current = ``; continue }
        current += char
      }
      cells.push(current.trim())
      rows.push(cells)
    }
    return rows
  }

  let csv_data = $derived.by(() => {
    if (mode !== `csv`) return { headers: [] as string[], rows: [] as string[][] }
    // Auto-detect delimiter: if tabs are more common than commas, use tab
    const tab_count = (content.match(/\t/g) || []).length
    const comma_count = (content.match(/,/g) || []).length
    const delimiter = tab_count > comma_count ? `\t` : `,`
    const all_rows = parse_csv(content, delimiter)
    if (all_rows.length === 0) return { headers: [] as string[], rows: [] as string[][] }
    return { headers: all_rows[0], rows: all_rows.slice(1) }
  })

  // --- Excel parsing ---
  let excel_sheets = $state<{ name: string; headers: string[]; rows: string[][] }[]>([])
  let excel_active_sheet = $state(0)
  let excel_error = $state(``)

  $effect(() => {
    if (mode !== `excel` || !binary_data) return
    excel_sheets = []
    excel_active_sheet = 0
    excel_error = ``
    ;(async () => {
      try {
        const XLSX = await import(`xlsx`)
        const bytes = Uint8Array.from(atob(binary_data), (c) => c.charCodeAt(0))
        const wb = XLSX.read(bytes, { type: `array` })
        const sheets: typeof excel_sheets = []
        for (const name of wb.SheetNames) {
          const rows_raw: string[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: `` }) as string[][]
          if (rows_raw.length === 0) { sheets.push({ name, headers: [], rows: [] }); continue }
          sheets.push({ name, headers: rows_raw[0].map(String), rows: rows_raw.slice(1).map(r => r.map(String)) })
        }
        excel_sheets = sheets
      } catch (e: any) {
        excel_error = e.message || t('structure.failed_parse_excel_file')
      }
    })()
  })

  let active_excel = $derived(excel_sheets[excel_active_sheet] ?? { headers: [], rows: [] })

  // --- Text line numbers ---
  let text_lines = $derived(mode === `text` ? content.split(`\n`) : [])

  // --- Mode info string ---
  let mode_info = $derived.by(() => {
    switch (mode) {
      case `image`:
        return img_natural_width && img_natural_height
          ? `${img_natural_width} x ${img_natural_height} | ${Math.round(img_scale * 100)}%`
          : ``
      case `csv`:
        return `${csv_data.rows.length} rows, ${csv_data.headers.length} columns`
      case `text`:
        return `${text_lines.length} lines`
      case `excel`:
        return excel_sheets.length > 0
          ? `${active_excel.rows.length} rows, ${active_excel.headers.length} cols | Sheet ${excel_active_sheet + 1}/${excel_sheets.length}`
          : ``
      case `markdown`:
        return `Markdown`
      case `pdf`:
        return `PDF`
      default:
        return ``
    }
  })

  // --- Export to PDF (markdown mode) ---
  function export_pdf() {
    const title_str = filename || `Document`

    // Extract only KaTeX CSS rules (not ALL stylesheets — Three.js/xterm are huge and slow)
    const katex_rules: string[] = []
    for (const sheet of document.styleSheets) {
      try {
        let has_katex = false
        for (const rule of sheet.cssRules) {
          if (rule.cssText?.includes(`.katex`)) { has_katex = true; break }
        }
        if (has_katex) {
          for (const rule of sheet.cssRules) katex_rules.push(rule.cssText)
        }
      } catch {
        // Cross-origin stylesheets throw SecurityError — skip
      }
    }

    const html = build_pdf_html(title_str, katex_rules)

    // Use hidden iframe + print dialog — works in Tauri WebView2 and browsers
    // (window.open is blocked by Tauri WebView2's popup policy)
    const iframe = document.createElement(`iframe`)
    iframe.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:900px;height:700px;border:none`
    document.body.appendChild(iframe)
    const doc = iframe.contentDocument || iframe.contentWindow?.document
    if (!doc) { document.body.removeChild(iframe); return }
    doc.open()
    doc.write(html)
    doc.close()
    // Wait for content to render, then trigger print dialog
    const on_ready = () => {
      try { iframe.contentWindow?.print() } catch (e) { console.error(`[PDF] print failed:`, e) }
      setTimeout(() => { try { document.body.removeChild(iframe) } catch {} }, 2000)
    }
    if (iframe.contentWindow) {
      iframe.contentWindow.addEventListener(`afterprint`, () => {
        try { document.body.removeChild(iframe) } catch {}
      })
    }
    // Use requestAnimationFrame to ensure layout is complete before printing
    requestAnimationFrame(() => requestAnimationFrame(on_ready))
  }

  function build_pdf_html(title_str: string, katex_css: string[]): string {
    // Use string concat to avoid Svelte preprocessor detecting style tags in script
    const so = `<` + `style>`
    const sc = `</` + `style>`
    const css_rules = [
      `body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:800px;margin:0 auto;padding:40px 24px;font-size:14px;line-height:1.6;color:#24292f}`,
      `h1,h2,h3,h4{margin-top:24px;margin-bottom:16px;font-weight:600}`,
      `h1{font-size:2em;border-bottom:1px solid #d1d9e0;padding-bottom:.3em}`,
      `h2{font-size:1.5em;border-bottom:1px solid #d1d9e0;padding-bottom:.3em}`,
      `pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto;font-size:85%}`,
      `code{padding:.2em .4em;font-size:85%;background:rgba(175,184,193,.2);border-radius:6px}`,
      `pre code{padding:0;background:transparent}`,
      `table{border-collapse:collapse;width:100%;margin-bottom:16px}`,
      `th,td{padding:6px 13px;border:1px solid #d1d9e0}`,
      `th{font-weight:600;background:#f6f8fa}`,
      `blockquote{margin:0 0 16px;padding:0 1em;color:#636c76;border-left:.25em solid #d1d9e0}`,
      `img{max-width:100%;height:auto}`,
      `hr{height:.25em;padding:0;margin:24px 0;background:#d1d9e0;border:0}`,
      `ul,ol{padding-left:2em}`,
      `.code-block-wrapper{position:relative}`,
      `.code-expand-btn,.copy-code-btn,.code-lang{display:none}`,
      `.code-preview{display:none!important}.code-full{display:block!important}`,
      `@media print{body{padding:0}}`,
    ].join(`\n`)
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title_str}</title>${so}${katex_css.join(`\n`)}${sc}${so}${css_rules}${sc}</head><body>${rendered_markdown}</body></html>`
  }

  // --- Download ---
  function download_file() {
    const download_name = filename || `download`
    try {
      if (mode === `image` || mode === `pdf` || mode === `excel`) {
        const bytes = Uint8Array.from(atob(binary_data), (c) => c.charCodeAt(0))
        const blob = new Blob([bytes], { type: mime_type || `application/octet-stream` })
        unified_download(blob, download_name, mime_type || `application/octet-stream`)
      } else {
        unified_download(content, download_name, `text/plain;charset=utf-8`)
      }
    } catch (err) {
      console.error(`[FilePreview] Download error:`, err)
    }
  }

  // --- Markdown click delegation (copy code, expand/collapse) ---
  function handle_markdown_click(event: MouseEvent) {
    const target = event.target as HTMLElement

    // Copy code button
    if (target.classList.contains(`copy-code-btn`)) {
      const wrapper = target.closest(`.code-block-wrapper`)
      const full_el = wrapper?.querySelector(`.code-full code`) ?? wrapper?.querySelector(`code`)
      if (!full_el) return
      navigator.clipboard.writeText(full_el.textContent ?? ``).then(() => {
        target.textContent = t('sidebar.copied_to_clipboard')
        setTimeout(() => { target.textContent = t('common.copy') }, 1500)
      }).catch(() => {}) // Clipboard API may be unavailable (non-HTTPS, iframe sandbox)
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
        target.textContent = collapsed ? t('common.collapse') : t('structure.show_all_lines', { n: wrapper.getAttribute(`data-lines`) ?? `` })
      }
      return
    }
  }
</script>

<div class="preview-panel">
  <div class="preview-header">
    <div class="preview-title" title={filename || t('sidebar.preview')}>
      {filename || t('sidebar.preview')}
    </div>
    <div class="preview-info">
      {mode_info}
    </div>
    <div class="preview-controls">
      {#if mode === `markdown`}
        <button class="preview-btn download-btn" onclick={export_pdf} title={t('structure.export_as_pdf')}>
          PDF
        </button>
      {/if}
      <button class="preview-btn download-btn" onclick={download_file} title={t('common.download')}>
        {t('common.download')}
      </button>
      {#if onclose}
        <button class="preview-btn close-btn" onclick={onclose} title={t('structure.close_preview')}>
          &times;
        </button>
      {/if}
    </div>
  </div>
  <div class="preview-content">
    {#if mode === `image`}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="image-container" onwheel={on_wheel}>
        <img
          src={`data:${mime_type || `image/png`};base64,${binary_data}`}
          alt={filename}
          style:transform={`scale(${img_scale})`}
          onload={on_img_load}
        />
      </div>

    {:else if mode === `pdf`}
      {#if pdf_blob_url}
        <iframe
          src={pdf_blob_url}
          title={filename || t('structure.pdf_preview')}
          class="pdf-frame"
        ></iframe>
      {/if}

    {:else if mode === `markdown`}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="markdown-container" onclick={handle_markdown_click}>
        <div class="markdown-body">
          {@html rendered_markdown}
        </div>
      </div>

    {:else if mode === `csv`}
      <div class="csv-container">
        <table class="csv-table">
          {#if csv_data.headers.length > 0}
            <thead>
              <tr>
                <th class="row-num">#</th>
                {#each csv_data.headers as header}
                  <th>{header}</th>
                {/each}
              </tr>
            </thead>
          {/if}
          <tbody>
            {#each csv_data.rows as row, i}
              <tr>
                <td class="row-num">{i + 1}</td>
                {#each row as cell}
                  <td>{cell}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

    {:else if mode === `excel`}
      <div class="excel-container">
        {#if excel_error}
          <div class="excel-error">{excel_error}</div>
        {:else if excel_sheets.length === 0}
          <div class="excel-loading">Loading...</div>
        {:else}
          {#if excel_sheets.length > 1}
            <div class="sheet-tabs">
              {#each excel_sheets as sheet, i}
                <button
                  class="sheet-tab"
                  class:active={excel_active_sheet === i}
                  onclick={() => { excel_active_sheet = i }}
                >{sheet.name}</button>
              {/each}
            </div>
          {/if}
          <div class="csv-container">
            <table class="csv-table">
              {#if active_excel.headers.length > 0}
                <thead>
                  <tr>
                    <th class="row-num">#</th>
                    {#each active_excel.headers as header}
                      <th>{header}</th>
                    {/each}
                  </tr>
                </thead>
              {/if}
              <tbody>
                {#each active_excel.rows as row, i}
                  <tr>
                    <td class="row-num">{i + 1}</td>
                    {#each row as cell}
                      <td>{cell}</td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>

    {:else}
      <!-- text mode (fallback) -->
      <div class="text-container">
        <pre class="text-content">{#each text_lines as line, i}<span class="line-num">{String(i + 1).padStart(4, ` `)}</span>  {line}
{/each}</pre>
      </div>
    {/if}
  </div>
</div>

<style>
  /* --- Panel layout --- */
  .preview-panel {
    display: flex;
    flex-direction: column;
    border-left: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    min-height: 0;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  /* --- Header (matches MonacoEditorPanel) --- */
  .preview-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.3));
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
  }
  .preview-title {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--struct-text-color, #ccc);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .preview-info {
    font-size: 0.72em;
    flex-shrink: 0;
    white-space: nowrap;
    color: light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.5));
  }
  .preview-controls {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .preview-btn {
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.12));
    color: var(--struct-text-color, #aaa);
    border-radius: 3px;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 0.75em;
    line-height: 1.4;
  }
  .preview-btn:hover {
    background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.15));
    color: var(--text-color);
  }
  .download-btn {
    color: var(--accent-color, #7aa2f7);
    border-color: color-mix(in srgb, var(--accent-color, #7aa2f7) 30%, transparent);
  }
  .close-btn {
    font-size: 1em !important;
    padding: 0 5px !important;
  }

  /* --- Content area --- */
  .preview-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* --- Image mode --- */
  .image-container {
    flex: 1;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    background: light-dark(
      repeating-conic-gradient(#f0f0f0 0% 25%, #fff 0% 50%) 50% / 20px 20px,
      repeating-conic-gradient(#1a1a2e 0% 25%, #16161e 0% 50%) 50% / 20px 20px
    );
  }
  .image-container img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    transform-origin: center center;
    transition: transform 0.1s ease;
    image-rendering: auto;
  }

  /* --- PDF mode --- */
  .pdf-frame {
    flex: 1;
    width: 100%;
    border: none;
    background: light-dark(#fff, #1e1e2e);
  }

  /* --- Markdown mode --- */
  .markdown-container {
    flex: 1;
    overflow: auto;
    padding: 16px 24px;
    background: light-dark(#fff, #1e1e2e);
  }
  .markdown-body {
    max-width: 800px;
    margin: 0 auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: light-dark(#24292f, #c9d1d9);
    word-wrap: break-word;
  }
  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
    color: light-dark(#1f2328, #e6edf3);
  }
  .markdown-body :global(h1) { font-size: 2em; border-bottom: 1px solid light-dark(#d1d9e0, #30363d); padding-bottom: 0.3em; }
  .markdown-body :global(h2) { font-size: 1.5em; border-bottom: 1px solid light-dark(#d1d9e0, #30363d); padding-bottom: 0.3em; }
  .markdown-body :global(h3) { font-size: 1.25em; }
  .markdown-body :global(p) { margin-top: 0; margin-bottom: 16px; }
  .markdown-body :global(a) { color: var(--accent-color, #7aa2f7); text-decoration: none; }
  .markdown-body :global(a:hover) { text-decoration: underline; }
  .markdown-body :global(code) {
    padding: 0.2em 0.4em;
    font-size: 85%;
    background: light-dark(rgba(175, 184, 193, 0.2), rgba(110, 118, 129, 0.4));
    border-radius: 6px;
    font-family: 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
  }
  .markdown-body :global(pre) {
    padding: 16px;
    overflow: auto;
    font-size: 85%;
    line-height: 1.45;
    background: light-dark(#f6f8fa, #161b22);
    border-radius: 6px;
    margin-bottom: 16px;
  }
  .markdown-body :global(pre code) {
    padding: 0;
    background: transparent;
    border-radius: 0;
  }
  .markdown-body :global(blockquote) {
    margin: 0 0 16px 0;
    padding: 0 1em;
    color: light-dark(#636c76, #8b949e);
    border-left: 0.25em solid light-dark(#d1d9e0, #30363d);
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin-top: 0;
    margin-bottom: 16px;
    padding-left: 2em;
  }
  .markdown-body :global(table) {
    border-spacing: 0;
    border-collapse: collapse;
    margin-bottom: 16px;
    width: 100%;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    padding: 6px 13px;
    border: 1px solid light-dark(#d1d9e0, #30363d);
  }
  .markdown-body :global(th) {
    font-weight: 600;
    background: light-dark(#f6f8fa, #161b22);
  }
  .markdown-body :global(tr:nth-child(2n)) {
    background: light-dark(#f6f8fa, rgba(255, 255, 255, 0.02));
  }
  .markdown-body :global(img) {
    max-width: 100%;
    height: auto;
  }
  .markdown-body :global(hr) {
    height: 0.25em;
    padding: 0;
    margin: 24px 0;
    background: light-dark(#d1d9e0, #30363d);
    border: 0;
  }
  .markdown-body :global(.code-block-wrapper) {
    position: relative;
    margin-bottom: 16px;
  }
  .markdown-body :global(.code-block-wrapper .code-lang) {
    position: absolute;
    top: 4px;
    left: 8px;
    font-size: 0.75em;
    opacity: 0.5;
    font-family: monospace;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .markdown-body :global(.code-block-wrapper .copy-code-btn) {
    position: absolute;
    top: 4px;
    right: 4px;
    z-index: 10;
    font-size: 0.72em;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.2));
    background: light-dark(rgba(240, 240, 240, 0.9), rgba(30, 30, 30, 0.85));
    color: light-dark(#555, #bbb);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s;
  }
  .markdown-body :global(.code-block-wrapper:hover .copy-code-btn) {
    opacity: 0.9;
  }
  .markdown-body :global(.code-block-wrapper .copy-code-btn:hover) {
    opacity: 1;
    background: light-dark(rgba(220, 220, 220, 0.95), rgba(80, 80, 80, 0.95));
    color: light-dark(#222, #fff);
  }
  .markdown-body :global(.code-expand-btn) {
    display: block;
    width: 100%;
    padding: 6px;
    border: none;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.04));
    color: var(--accent-color, #7aa2f7);
    font-size: 0.78em;
    cursor: pointer;
    border-radius: 0 0 6px 6px;
  }
  .markdown-body :global(.code-expand-btn:hover) {
    background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
  }

  /* --- CSV mode --- */
  .csv-container {
    flex: 1;
    overflow: auto;
    background: light-dark(#fff, #1e1e2e);
  }
  .csv-table {
    border-collapse: collapse;
    width: max-content;
    min-width: 100%;
    font-size: 0.82em;
  }
  .csv-table th,
  .csv-table td {
    padding: 5px 12px;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    white-space: nowrap;
    text-align: left;
  }
  .csv-table th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: light-dark(#f0f0f5, #24243a);
    font-weight: 600;
    color: light-dark(#24292f, #e6edf3);
    border-bottom: 2px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
  }
  .csv-table tbody tr:nth-child(even) {
    background: light-dark(rgba(0, 0, 0, 0.02), rgba(255, 255, 255, 0.02));
  }
  .csv-table tbody tr:hover {
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
  }
  .csv-table td {
    color: light-dark(#24292f, #c9d1d9);
    font-family: 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
    font-size: 0.95em;
  }
  .row-num {
    color: light-dark(rgba(0, 0, 0, 0.3), rgba(255, 255, 255, 0.25));
    font-size: 0.85em;
    text-align: right !important;
    user-select: none;
    min-width: 3em;
    font-family: 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
  }

  /* --- Excel mode --- */
  .excel-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .excel-container .csv-container {
    flex: 1;
  }
  .excel-error, .excel-loading {
    padding: 24px;
    text-align: center;
    color: light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.5));
    font-size: 0.85em;
  }
  .excel-error { color: #f87171; }
  .sheet-tabs {
    display: flex;
    gap: 1px;
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06));
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    overflow-x: auto;
    flex-shrink: 0;
  }
  .sheet-tab {
    padding: 4px 12px;
    font-size: 0.75em;
    border: none;
    background: light-dark(rgba(0, 0, 0, 0.02), rgba(255, 255, 255, 0.04));
    color: light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.5));
    cursor: pointer;
    white-space: nowrap;
    border-bottom: 2px solid transparent;
  }
  .sheet-tab:hover {
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
  }
  .sheet-tab.active {
    color: var(--accent-color, #7aa2f7);
    border-bottom-color: var(--accent-color, #7aa2f7);
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
  }

  /* --- Text mode --- */
  .text-container {
    flex: 1;
    overflow: auto;
    background: light-dark(#fff, #1e1e2e);
  }
  .text-content {
    margin: 0;
    padding: 12px 16px;
    font-family: 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.5;
    color: light-dark(#24292f, #c9d1d9);
    tab-size: 4;
    white-space: pre;
    overflow-x: auto;
  }
  .line-num {
    display: inline-block;
    color: light-dark(rgba(0, 0, 0, 0.25), rgba(255, 255, 255, 0.2));
    user-select: none;
    text-align: right;
    min-width: 3em;
  }
</style>
