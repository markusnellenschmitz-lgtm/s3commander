<script lang="ts">
  // Verbindungsdialog (Screen 1, S1_Verbindung.dc.html).
  import Cloud from '@lucide/svelte/icons/cloud';
  import Server from '@lucide/svelte/icons/server';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import X from '@lucide/svelte/icons/x';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Loader from '@lucide/svelte/icons/loader';
  import { focusTrap } from '../../ui/actions/focusTrap';
  import { errorDetail } from '../../core/backend';
  import { countText, formatCount } from '../../core/format';
  import type { ConnectionDialogViewModel } from './connectionDialogViewModel.svelte';

  interface Props {
    vm: ConnectionDialogViewModel;
  }

  let { vm }: Props = $props();

  const errors = $derived(vm.visibleErrors);
  const customPreset = $derived(vm.presets.filter((p) => p.provider === 'custom'));
  const providerPresets = $derived(vm.presets.filter((p) => p.provider !== 'custom'));

  /** Wenige Regionen werden genannt, viele zusammengefasst (wie im Mockup). */
  const MAX_LISTED_REGIONS = 3;

  function presetHint(regions: string[], selfHosted: boolean): string {
    if (selfHosted) return 'selbst gehostet';
    if (regions.length <= 1) return 'Konto-ID';
    return regions.length <= MAX_LISTED_REGIONS ? regions.join(' · ') : 'Regionen';
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    void vm.save();
  }
</script>

{#snippet fieldError(message: string | undefined)}
  {#if message}<span class="s3-field-error">{message}</span>{/if}
{/snippet}

{#if vm.isOpen}
  <div class="s3-scrim">
    <div
      class="s3-dialog conn-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conn-title"
      use:focusTrap={{ onescape: () => vm.close() }}
    >
      <div class="conn-head">
        <div class="conn-head-text">
          <h2 id="conn-title" class="s3-dialog-title">
            {vm.mode === 'create' ? 'Neue Verbindung' : 'Verbindung bearbeiten'}
          </h2>
          <span class="s3-muted">Zugangsdaten werden im {vm.credentialStore} abgelegt, nicht in der Profildatei.</span>
        </div>
        <button
          type="button"
          class="s3-btn s3-btn-ghost s3-btn-icon"
          aria-label="Dialog schließen"
          onclick={() => vm.close()}
        >
          <X class="s3-ico" />
        </button>
      </div>

      <form class="conn-body" onsubmit={submit} novalidate>
        <nav class="conn-presets" aria-label="Anbieter-Vorlagen">
          <span class="s3-tree-group">Vorlage</span>
          {#each [...providerPresets, ...customPreset] as preset (preset.provider)}
            {#if preset.provider === 'custom'}<hr class="s3-sep" />{/if}
            <button
              type="button"
              class="s3-plain s3-nav-item"
              class:is-selected={vm.form.provider === preset.provider}
              aria-current={vm.form.provider === preset.provider}
              onclick={() => vm.selectPreset(preset.provider)}
            >
              {#if preset.provider === 'custom'}<SlidersHorizontal class="s3-ico" />
              {:else if preset.selfHosted}<Server class="s3-ico" />
              {:else}<Cloud class="s3-ico" />{/if}
              <span class="conn-grow">{preset.label}</span>
              <span class="s3-muted conn-hint">
                {preset.provider === 'custom' ? 'beliebiger Endpunkt' : presetHint(preset.regions, preset.selfHosted)}
              </span>
            </button>
          {/each}
        </nav>

        <div class="conn-form">
          <div class="s3-field">
            <label class="s3-field-label" for="f-name">Profilname</label>
            <span class="s3-input" class:is-invalid={errors.name}>
              <input
                id="f-name"
                onblur={() => vm.touch('name')}
                data-autofocus
                bind:value={vm.form.name}
                placeholder="z. B. Hetzner Produktion"
              />
            </span>
            {@render fieldError(errors.name)}
          </div>

          {#if vm.needsAccount}
            <div class="s3-field">
              <label class="s3-field-label" for="f-account">Konto-ID</label>
              <span class="s3-input" class:is-invalid={errors.account}>
                <input
                  id="f-account"
                  onblur={() => vm.touch('account')}
                  class="s3-mono"
                  value={vm.form.account}
                  oninput={(e) => vm.setAccount(e.currentTarget.value)}
                />
              </span>
              {@render fieldError(errors.account)}
            </div>
          {/if}

          <div class="s3-field">
            <label class="s3-field-label" for="f-ep">Endpoint-URL</label>
            <span class="s3-input" class:is-invalid={errors.endpoint}>
              <input
                id="f-ep"
                onblur={() => vm.touch('endpoint')}
                class="s3-mono"
                value={vm.form.endpoint}
                oninput={(e) => vm.setEndpoint(e.currentTarget.value)}
              />
            </span>
            {#if errors.endpoint}{@render fieldError(errors.endpoint)}{:else}<span class="s3-field-help"
                >{vm.endpointHelp}</span
              >{/if}
          </div>

          <div class="conn-grid-2">
            <div class="s3-field">
              <label class="s3-field-label" for="f-region">Region (optional)</label>
              <!-- Freies Feld mit Vorschlägen: Regionen außerhalb der Vorlage bleiben möglich. -->
              <span class="s3-input" class:is-invalid={errors.region}>
                <input
                  id="f-region"
                  list="region-options"
                  placeholder={vm.effectiveRegion}
                  onblur={() => vm.touch('region')}
                  value={vm.form.region}
                  oninput={(e) => vm.setRegion(e.currentTarget.value)}
                />
              </span>
              <datalist id="region-options">
                {#each vm.regionSuggestions as region (region)}<option value={region}></option>{/each}
              </datalist>
              {#if errors.region}{@render fieldError(errors.region)}{:else}<span class="s3-field-help"
                  >Leer lassen: wird aus der Endpoint-URL oder der Vorlage übernommen.</span
                >{/if}
            </div>
            <div class="s3-field">
              <label class="s3-field-label" for="f-bucket">Bucket (optional)</label>
              <span class="s3-input"><input id="f-bucket" bind:value={vm.form.bucket} /></span>
              <span class="s3-field-help">Leer lassen, um alle Buckets des Schlüssels zu listen.</span>
            </div>
          </div>

          <div class="conn-grid-2">
            <div class="s3-field">
              <label class="s3-field-label" for="f-ak">Access Key</label>
              <span class="s3-input" class:is-invalid={errors.accessKeyId}>
                <input
                  id="f-ak"
                  onblur={() => vm.touch('accessKeyId')}
                  class="s3-mono"
                  autocomplete="off"
                  bind:value={vm.form.accessKeyId}
                  placeholder={vm.mode === 'edit' ? 'unverändert' : ''}
                />
              </span>
              {@render fieldError(errors.accessKeyId)}
            </div>
            <div class="s3-field">
              <label class="s3-field-label" for="f-sk">Secret Key</label>
              <span class="s3-input" class:is-invalid={errors.secretAccessKey}>
                <input
                  id="f-sk"
                  onblur={() => vm.touch('secretAccessKey')}
                  class="s3-mono"
                  autocomplete="off"
                  type={vm.showSecret ? 'text' : 'password'}
                  bind:value={vm.form.secretAccessKey}
                  placeholder={vm.mode === 'edit' ? 'unverändert' : ''}
                />
                <button
                  type="button"
                  class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
                  aria-label={vm.showSecret ? 'Secret Key verbergen' : 'Secret Key anzeigen'}
                  aria-pressed={vm.showSecret}
                  onclick={() => (vm.showSecret = !vm.showSecret)}
                >
                  {#if vm.showSecret}<EyeOff class="s3-ico" />{:else}<Eye class="s3-ico" />{/if}
                </button>
              </span>
              {@render fieldError(errors.secretAccessKey)}
            </div>
          </div>

          <div class="conn-advanced">
            <button
              type="button"
              class="s3-plain conn-advanced-head"
              aria-expanded={vm.advancedOpen}
              onclick={() => (vm.advancedOpen = !vm.advancedOpen)}
            >
              {#if vm.advancedOpen}<ChevronDown class="s3-ico" />{:else}<ChevronRight class="s3-ico" />{/if}
              Erweitert
              {#if vm.changedAdvancedCount > 0}
                <span class="s3-muted conn-advanced-count">
                  {countText(vm.changedAdvancedCount, 'Wert', 'Werte')} geändert
                </span>
              {/if}
            </button>
            {#if vm.advancedOpen}
              <div class="conn-advanced-body">
                <fieldset class="s3-field conn-span-3">
                  <legend class="s3-field-label">Adressierung</legend>
                  <div class="conn-radios">
                    <label class="s3-radio">
                      <input type="radio" name="addr" value="virtual-hosted" bind:group={vm.form.addressing} />
                      <span class="s3-radio-dot"></span>Virtual-Hosted
                    </label>
                    <label class="s3-radio">
                      <input type="radio" name="addr" value="path-style" bind:group={vm.form.addressing} />
                      <span class="s3-radio-dot"></span>Path-Style
                    </label>
                  </div>
                </fieldset>
                <div class="s3-field conn-span-3">
                  <label class="s3-field-label" for="f-proxy">Proxy</label>
                  <span class="s3-input">
                    <input
                      id="f-proxy"
                      class="s3-mono"
                      bind:value={vm.form.proxy}
                      placeholder="http://proxy.intern:3128"
                    />
                  </span>
                </div>
                <div class="s3-field conn-span-6">
                  <label class="s3-field-label" for="f-ca">Eigene CA-Datei (PEM)</label>
                  <span class="s3-input">
                    <input id="f-ca" bind:value={vm.form.caFile} placeholder="Keine, Windows-Zertifikatspeicher" />
                  </span>
                </div>
                <div class="s3-field conn-span-2">
                  <label class="s3-field-label" for="f-to">Timeout</label>
                  <span class="s3-input" class:is-invalid={errors.timeoutSecs}>
                    <input
                      id="f-to"
                      onblur={() => vm.touch('timeoutSecs')}
                      class="s3-num"
                      type="number"
                      min="1"
                      max="600"
                      bind:value={vm.form.timeoutSecs}
                    />
                    <span class="s3-muted">s</span>
                  </span>
                  {@render fieldError(errors.timeoutSecs)}
                </div>
                <div class="s3-field conn-span-2">
                  <label class="s3-field-label" for="f-par">Parallelität</label>
                  <span class="s3-input" class:is-invalid={errors.concurrency}>
                    <input
                      id="f-par"
                      onblur={() => vm.touch('concurrency')}
                      class="s3-num"
                      type="number"
                      min="1"
                      max="64"
                      bind:value={vm.form.concurrency}
                    />
                    <span class="s3-muted">Verbindungen</span>
                  </span>
                  {@render fieldError(errors.concurrency)}
                </div>
                <div class="s3-field conn-span-2 conn-check">
                  <label class="s3-check">
                    <input type="checkbox" bind:checked={vm.form.verifyTls} />
                    <span class="s3-check-box"
                      ><svg class="s3-ico i-check" aria-hidden="true"><use href="#i-check" /></svg></span
                    >
                    TLS-Zertifikat prüfen
                  </label>
                </div>
              </div>
            {/if}
          </div>
        </div>
      </form>

      <div class="s3-dialog-foot conn-foot">
        {#if vm.mode === 'edit'}
          <button type="button" class="s3-btn s3-btn-ghost conn-delete" onclick={() => vm.requestDelete()}>
            <Trash2 class="s3-ico" />Löschen …
          </button>
        {/if}
        <button
          type="button"
          class="s3-btn s3-btn-secondary"
          disabled={vm.testState === 'testing'}
          onclick={() => vm.test()}
        >
          Verbindung testen
        </button>
        <span role="status" class="conn-status">
          {#if vm.testState === 'testing'}
            <Loader class="s3-ico" /><span class="s3-muted">Verbinde …</span>
          {:else if vm.testState === 'ok' && vm.testResult}
            <CircleCheck class="s3-ico conn-ok" /><strong class="conn-ok">Verbunden</strong>
            <span class="s3-muted">
              · {vm.testResult.bucketCount === null
                ? 'Bucket erreichbar'
                : `${formatCount(vm.testResult.bucketCount)} Buckets`}
              · {formatCount(vm.testResult.latencyMs)} ms
            </span>
          {:else if vm.error}
            <CircleX class="s3-ico conn-err" />
            <span class="conn-err s3-ellipsis" title={errorDetail(vm.error) ?? vm.error.message}
              >{vm.error.message}</span
            >
          {/if}
        </span>
        <span class="conn-grow"></span>
        <button type="button" class="s3-btn s3-btn-secondary" onclick={() => vm.close()}>Abbrechen</button>
        <button type="button" class="s3-btn s3-btn-primary" disabled={vm.saving} onclick={() => vm.save()}>
          Speichern
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .conn-dialog {
    width: 980px;
    max-width: calc(100vw - 48px);
  }
  .conn-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-12);
    padding: var(--space-20) var(--space-12) var(--space-16) var(--space-24);
    border-bottom: 1px solid var(--border-subtle);
  }
  .conn-head-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: var(--text-13);
  }
  .conn-body {
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
    height: 600px;
    max-height: calc(100vh - 200px);
  }
  .conn-presets {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-12) var(--space-8);
    background: var(--bg-panel);
    border-right: 1px solid var(--border-subtle);
    font-size: var(--text-13);
    overflow: auto;
  }
  .conn-hint {
    font-size: var(--text-12);
    white-space: nowrap;
  }
  .conn-presets .conn-grow {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .conn-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: var(--space-20) var(--space-24);
    overflow: auto;
    font-size: var(--text-14);
  }
  .conn-grid-2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-16);
  }
  .conn-advanced {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .conn-advanced-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 32px;
    padding: 0 var(--space-8);
    font-size: var(--text-13);
    font-weight: var(--weight-semibold);
  }
  .conn-advanced-head:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
  .conn-advanced-count {
    margin-left: auto;
    font-weight: var(--weight-regular);
  }
  .conn-advanced-body {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: var(--space-12) var(--space-16);
    padding: var(--space-12) var(--space-12) 14px;
    border-top: 1px solid var(--border-subtle);
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
  }
  .conn-span-2 {
    grid-column: span 2;
  }
  .conn-span-3 {
    grid-column: span 3;
  }
  .conn-span-6 {
    grid-column: span 6;
  }
  .conn-radios {
    display: flex;
    gap: var(--space-16);
    height: 32px;
    align-items: center;
    font-size: var(--text-13);
  }
  .conn-check {
    justify-content: flex-end;
    font-size: var(--text-13);
  }
  .conn-check .s3-check {
    height: 32px;
  }
  .conn-foot {
    justify-content: flex-start;
    align-items: center;
  }
  .conn-delete {
    color: var(--error-fg);
  }
  .conn-status {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-13);
  }
  .conn-grow {
    flex: 1;
  }
  .conn-ok {
    color: var(--success-fg);
    font-weight: var(--weight-semibold);
  }
  .conn-err {
    color: var(--error-fg);
  }
</style>
