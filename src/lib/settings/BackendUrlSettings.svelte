<script lang="ts">
  // Unobtrusive "Backend URL" control (Model C: hosted frontend → user-chosen backend).
  // Lets the user point the app at a different backend at runtime. On Save it
  // persists to localStorage ('catgo-backend-url') and fans the URL out to every
  // API consumer via apply_backend_url(). Leaving it blank resets to the default.
  import {
    apply_backend_url,
    backend_url_store,
    DEFAULT_BACKEND_URL,
    load_backend_url,
    save_backend_url,
  } from '$lib/api/backend-url.svelte'

  // Seed the input from the persisted value (falls back to the live store).
  let value = $state(load_backend_url() ?? backend_url_store.url ?? ``)
  let saved_note = $state(false)

  // Effective URL currently in force (blank ⇒ build-time default).
  let effective = $derived(
    (backend_url_store.url || ``).trim() || DEFAULT_BACKEND_URL,
  )

  function save() {
    const next = value.trim()
    save_backend_url(next)
    apply_backend_url(next)
    saved_note = true
    setTimeout(() => (saved_note = false), 1500)
  }

  function handle_keydown(event: KeyboardEvent) {
    if (event.key === `Enter`) {
      event.preventDefault()
      save()
    }
  }
</script>

<div class="backend-url-settings">
  <label for="catgo-backend-url-input">Backend URL</label>
  <div class="row">
    <input
      id="catgo-backend-url-input"
      type="url"
      placeholder={DEFAULT_BACKEND_URL}
      bind:value
      onkeydown={handle_keydown}
      spellcheck="false"
      autocomplete="off"
    />
    <button type="button" onclick={save}>Save & Connect</button>
  </div>
  <small class="effective">
    Current: <code>{effective}</code>
    {#if saved_note}<span class="ok">· applied</span>{/if}
  </small>
</div>

<style>
  .backend-url-settings {
    display: flex;
    flex-direction: column;
    gap: 4pt;
    font-size: 0.85em;
  }
  label {
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 4pt;
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 3pt 6pt;
    border: 1px solid var(--border-color, #d1d5db);
    border-radius: 3pt;
    background: var(--input-bg, transparent);
    color: inherit;
    font: inherit;
  }
  button {
    padding: 3pt 8pt;
    border: 1px solid var(--border-color, #d1d5db);
    border-radius: 3pt;
    background: var(--btn-bg, rgba(0, 0, 0, 0.06));
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover {
    background: var(--btn-bg-hover, rgba(0, 0, 0, 0.12));
  }
  .effective {
    color: var(--text-color-muted, #6b7280);
  }
  .ok {
    color: var(--success-color, #16a34a);
  }
</style>
