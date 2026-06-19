<script module lang="ts">
  import DOMPurify from 'dompurify'

  export function sanitize_html(raw: string): string {
    return DOMPurify.sanitize(raw, {
      ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
      ADD_DATA_URI_TAGS: ['img'],
    })
  }
</script>

<script lang="ts">
  let { html: raw }: { html: string } = $props()
  const safe = $derived(sanitize_html(raw ?? ''))
</script>

<div class="html-body">{@html safe}</div>

<style>
  .html-body {
    padding: 16px 24px;
    overflow: auto;
    height: 100%;
    line-height: 1.5;
    color: var(--text-color, #e2e8f0);
  }
</style>
