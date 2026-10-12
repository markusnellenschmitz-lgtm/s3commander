<script lang="ts">
  // Einstellungsdialog (Screen 7): Kategorien links, Formularzeilen rechts, Änderungen im Fuß.
  import X from '@lucide/svelte/icons/x';
  import Search from '@lucide/svelte/icons/search';
  import Settings from '@lucide/svelte/icons/settings';
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
  import Database from '@lucide/svelte/icons/database';
  import Palette from '@lucide/svelte/icons/palette';
  import Shield from '@lucide/svelte/icons/shield';
  import Info from '@lucide/svelte/icons/info';
  import type { Component } from 'svelte';
  import SpriteIcon from '../../ui/icons/SpriteIcon.svelte';
  import { focusTrap } from '../../ui/actions/focusTrap';
  import { countText, formatBytes } from '../../core/format';
  import { CATEGORIES, type SettingsCategory, type SettingsViewModel } from './settingsViewModel.svelte';
  import { CONFLICT_OPTIONS, PART_SIZES_MIB, partLimitText, type NumericField as NumberField } from './settingsRules';
  import { OPTIONAL_COLUMNS } from './viewPreferences.svelte';
  import type { ThemePreference } from './themeViewModel.svelte';

  interface Props {
    vm: SettingsViewModel;
  }

  let { vm }: Props = $props();

  const ICONS: Record<SettingsCategory, Component<{ class?: string }>> = {
    general: Settings,
    transfers: ArrowUpDown,
    cache: Database,
    appearance: Palette,
    security: Shield,
    about: Info,
  };

  const THEMES: readonly { id: ThemePreference; label: string }[] = [
    { id: 'system', label: 'Wie Windows' },
    { id: 'dark', label: 'Dunkel' },
    { id: 'light', label: 'Hell' },
  ];

  const errors = $derived(vm.errors);
  const title = $derived(CATEGORIES.find((c) => c.id === vm.category)?.label ?? '');

  /** Zahlenfelder; leere Limits bedeuten „unbegrenzt“. */
  function setNumber(field: NumberField, input: HTMLInputElement, emptyIs?: number) {
    const value = input.value.trim() === '' && emptyIs !== undefined ? emptyIs : input.valueAsNumber;
    vm.draft.transfers[field] = value;
  }
</script>

{#snippet numberInput(field: NumberField, label: string, unit: string, width = 120, emptyIs?: number)}
  <span class="s3-input" class:is-invalid={errors[field]} style:width="{width}px">
    <input
      type="number"
      class="s3-num"
      aria-label={label}
      value={emptyIs !== undefined && vm.draft.transfers[field] === emptyIs ? '' : vm.draft.transfers[field]}
      placeholder={emptyIs !== undefined ? 'unbegrenzt' : undefined}
      oninput={(e) => setNumber(field, e.currentTarget, emptyIs)}
    />
    <span class="s3-muted">{unit}</span>
  </span>
{/snippet}

{#snippet fieldErrors(fields: NumberField[])}
  {#each fields as field (field)}
    {#if errors[field]}<span class="s3-field-error">{errors[field]}</span>{/if}
  {/each}
{/snippet}

{#snippet check(label: string, checked: boolean, onchange: (checked: boolean) => void)}
  <label class="s3-check">
    <input type="checkbox" {checked} onchange={(e) => onchange(e.currentTarget.checked)} />
    <span class="s3-check-box"><SpriteIcon name="check" /></span>{label}
  </label>
{/snippet}

{#if vm.isOpen}
  <div class="s3-scrim">
    <div
      class="s3-dialog settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      use:focusTrap={{ onescape: () => vm.close() }}
    >
      <div class="head">
        <h2 id="settings-title" class="s3-dialog-title grow">Einstellungen</h2>
        <label class="s3-input search">
          <Search class="s3-ico" />
          <input
            type="search"
            placeholder="Einstellung suchen"
            aria-label="Einstellung suchen"
            value={vm.search}
            oninput={(e) => vm.setSearch(e.currentTarget.value)}
          />
        </label>
        <button class="s3-btn s3-btn-ghost s3-btn-icon" aria-label="Dialog schließen" onclick={() => vm.close()}>
          <X class="s3-ico" />
        </button>
      </div>

      <div class="body">
        <nav aria-label="Kategorien" class="nav">
          {#each CATEGORIES.filter((c) => vm.visibleCategories.includes(c.id)) as category (category.id)}
            {@const Icon = ICONS[category.id]}
            {@const changes = vm.changesIn(category.id)}
            <button
              class="s3-plain s3-nav-item"
              class:is-selected={vm.category === category.id}
              aria-current={vm.category === category.id ? 'page' : undefined}
              onclick={() => (vm.category = category.id)}
            >
              <Icon class="s3-ico" /><span class="grow">{category.label}</span>
              {#if changes > 0}<span class="s3-badge s3-badge-accent" aria-label="{changes} ungespeichert"
                  >{changes}</span
                >{/if}
            </button>
          {:else}
            <p class="s3-muted empty">Keine Einstellung gefunden.</p>
          {/each}
        </nav>

        <div class="content" aria-busy={vm.loading}>
          <h3>{title}</h3>
          {#if vm.error}<p class="s3-field-error" role="alert">{vm.error.message}</p>{/if}

          {#if vm.category === 'general'}
            <div class="s3-form-row">
              <div class="s3-form-k">
                <strong>Beim Start verbinden</strong><span>Buckets aller Verbindungen laden</span>
              </div>
              <div>
                {@render check(
                  'Alle Verbindungen beim Start verbinden',
                  vm.draft.autoConnect,
                  (v) => (vm.draft.autoConnect = v),
                )}
              </div>
            </div>
          {:else if vm.category === 'transfers'}
            <p class="s3-muted lead">Gilt für alle Verbindungen. Änderungen gelten nach dem Speichern sofort.</p>
            <div class="s3-form-row">
              <div class="s3-form-k">
                <strong>Parallelität</strong><span>Gleichzeitige Transfers und Teile pro Datei</span>
              </div>
              <div class="s3-field">
                <div class="line">
                  {@render numberInput('maxTransfers', 'Gleichzeitige Transfers', 'Transfers')}
                  {@render numberInput('partsParallel', 'Teile pro Datei parallel', 'Teile')}
                </div>
                {@render fieldErrors(['maxTransfers', 'partsParallel'])}
              </div>
            </div>
            <div class="s3-form-row">
              <div class="s3-form-k">
                <strong>Teilgröße</strong><span>Größe der Teile bei Multipart-Transfers</span>
              </div>
              <div class="s3-field">
                <div class="line">
                  <label class="s3-input s3-select size-select">
                    <select
                      aria-label="Teilgröße"
                      value={vm.draft.transfers.partSizeMib}
                      onchange={(e) => (vm.draft.transfers.partSizeMib = Number(e.currentTarget.value))}
                    >
                      {#each PART_SIZES_MIB as size (size)}<option value={size}>{size} MiB</option>{/each}
                    </select>
                  </label>
                  <span>Multipart ab</span>
                  {@render numberInput('multipartThresholdMib', 'Multipart-Schwelle', 'MiB')}
                </div>
                <span class="s3-field-help">{partLimitText(vm.draft.transfers.partSizeMib)}</span>
                {@render fieldErrors(['partSizeMib', 'multipartThresholdMib'])}
              </div>
            </div>
            <div class="s3-form-row">
              <div class="s3-form-k"><strong>Bandbreitenlimit</strong><span>Summe über alle Transfers</span></div>
              <div class="s3-field">
                <div class="line">
                  <label class="s3-toggle">
                    <input
                      type="checkbox"
                      checked={vm.limitEnabled}
                      onchange={(e) => vm.setLimitEnabled(e.currentTarget.checked)}
                    />
                    <span class="s3-toggle-track"></span>Begrenzen
                  </label>
                  {#if vm.limitEnabled}
                    <span>Upload</span>
                    {@render numberInput('uploadLimitMibps', 'Upload-Limit', 'MiB/s', 120, 0)}
                    <span>Download</span>
                    {@render numberInput('downloadLimitMibps', 'Download-Limit', 'MiB/s', 140, 0)}
                  {/if}
                </div>
                <span class="s3-field-help">Werte gelten sofort, auch für laufende Transfers.</span>
                {@render fieldErrors(['uploadLimitMibps', 'downloadLimitMibps'])}
              </div>
            </div>
            <div class="s3-form-row">
              <div class="s3-form-k">
                <strong>Verhalten bei Konflikten</strong><span>Wenn eine heruntergeladene Datei schon existiert</span>
              </div>
              <fieldset class="options">
                <legend class="s3-sr">Verhalten bei Konflikten</legend>
                {#each CONFLICT_OPTIONS as option (option.id)}
                  <label class="s3-radio">
                    <input
                      type="radio"
                      name="conflict"
                      checked={vm.draft.transfers.conflict === option.id}
                      onchange={() => (vm.draft.transfers.conflict = option.id)}
                    />
                    <span class="s3-radio-dot"></span>{option.label}
                    {#if option.id === 'rename'}<span class="s3-mono s3-muted example">bericht (2).pdf</span>{/if}
                  </label>
                {/each}
              </fieldset>
            </div>
            <div class="s3-form-row">
              <div class="s3-form-k">
                <strong>Prüfung</strong><span>Prüfsummen und Wiederholung bei Fehlern</span>
              </div>
              <div class="s3-field">
                {@render check(
                  'Prüfsumme nach dem Upload vergleichen (CRC32C, sonst MD5)',
                  vm.draft.transfers.verifyChecksums,
                  (v) => (vm.draft.transfers.verifyChecksums = v),
                )}
                <div class="line">
                  {@render check(
                    'Fehlgeschlagene Teile wiederholen',
                    vm.draft.transfers.retries > 0,
                    (v) => (vm.draft.transfers.retries = v ? 3 : 0),
                  )}
                  {#if vm.draft.transfers.retries > 0}{@render numberInput(
                      'retries',
                      'Anzahl Wiederholungen',
                      '×',
                      72,
                    )}{/if}
                </div>
                {@render fieldErrors(['retries'])}
              </div>
            </div>
          {:else if vm.category === 'cache'}
            <p class="s3-muted lead">
              Ordner öffnen sich sofort mit dem zuletzt gelisteten Stand und werden im Hintergrund aktualisiert.
            </p>
            <div class="s3-form-row">
              <div class="s3-form-k">
                <strong>Listing-Cache</strong><span>Gilt für alle Verbindungen</span>
              </div>
              <div class="s3-field">
                <label class="s3-toggle">
                  <input
                    type="checkbox"
                    checked={vm.draft.cacheEnabled}
                    onchange={(e) => (vm.draft.cacheEnabled = e.currentTarget.checked)}
                  />
                  <span class="s3-toggle-track"></span>Ordner-Listings zwischenspeichern
                </label>
                <span class="s3-field-help">F5 lädt einen Ordner immer frisch vom Server.</span>
              </div>
            </div>
            <div class="s3-form-row">
              <div class="s3-form-k">
                <strong>Cache leeren</strong><span>Löscht alle gespeicherten Listings sofort</span>
              </div>
              <div class="s3-field">
                <div class="line">
                  <span class="s3-num cache-stats">
                    {#if vm.cacheStats}
                      {countText(vm.cacheStats.folders, 'Ordner', 'Ordner')} · {countText(
                        vm.cacheStats.entries,
                        'Eintrag',
                        'Einträge',
                      )} · {formatBytes(vm.cacheStats.bytes)}
                    {:else}—{/if}
                  </span>
                  <button
                    class="s3-btn s3-btn-secondary s3-btn-sm"
                    disabled={vm.clearingCache || vm.cacheStats?.folders === 0}
                    onclick={() => vm.clearCache()}>Cache leeren</button
                  >
                </div>
              </div>
            </div>
          {:else if vm.category === 'appearance'}
            <div class="s3-form-row">
              <div class="s3-form-k"><strong>Theme</strong><span>Farbschema der Anwendung</span></div>
              <fieldset class="options">
                <legend class="s3-sr">Theme</legend>
                {#each THEMES as theme (theme.id)}
                  <label class="s3-radio">
                    <input
                      type="radio"
                      name="theme"
                      checked={vm.draft.theme === theme.id}
                      onchange={() => (vm.draft.theme = theme.id)}
                    />
                    <span class="s3-radio-dot"></span>{theme.label}
                  </label>
                {/each}
              </fieldset>
            </div>
            <div class="s3-form-row">
              <div class="s3-form-k"><strong>Dichte</strong><span>Zeilenhöhe der Objektliste</span></div>
              <fieldset class="options">
                <legend class="s3-sr">Dichte</legend>
                <label class="s3-radio">
                  <input
                    type="radio"
                    name="density"
                    checked={!vm.draft.compact}
                    onchange={() => (vm.draft.compact = false)}
                  />
                  <span class="s3-radio-dot"></span>Standard, 28 px
                </label>
                <label class="s3-radio">
                  <input
                    type="radio"
                    name="density"
                    checked={vm.draft.compact}
                    onchange={() => (vm.draft.compact = true)}
                  />
                  <span class="s3-radio-dot"></span>Kompakt, 24 px
                </label>
              </fieldset>
            </div>
            <div class="s3-form-row">
              <div class="s3-form-k"><strong>Sichtbare Spalten</strong><span>Der Name ist immer sichtbar</span></div>
              <div class="options">
                {#each OPTIONAL_COLUMNS as column (column.id)}
                  {@render check(column.label, !vm.draft.hiddenColumns.includes(column.id), (v) =>
                    vm.toggleColumn(column.id, v),
                  )}
                {/each}
              </div>
            </div>
          {:else if vm.category === 'security'}
            <div class="s3-form-row">
              <div class="s3-form-k"><strong>Zugangsdaten</strong></div>
              <p class="text">
                Access Keys liegen im {vm.credentialStore}, nie in Dateien oder Protokollen. Beim Löschen einer
                Verbindung werden sie mit entfernt.
              </p>
            </div>
            <div class="s3-form-row">
              <div class="s3-form-k"><strong>Zertifikate</strong></div>
              <p class="text">
                TLS prüft gegen den Windows-Zertifikatspeicher. Eigene Stammzertifikate und Proxys stellst du je
                Verbindung unter „Erweitert“ ein.
              </p>
            </div>
          {:else}
            <div class="s3-form-row">
              <div class="s3-form-k">
                <strong>S3 Commander</strong><span>Windows-Client für S3-kompatiblen Speicher</span>
              </div>
              <dl class="about">
                <dt>Version</dt>
                <dd class="s3-num">{__APP_VERSION__}</dd>
                <dt>Technik</dt>
                <dd>Tauri 2, Rust, Svelte 5</dd>
                <dt>Icons</dt>
                <dd>Lucide, ISC-Lizenz</dd>
              </dl>
            </div>
          {/if}
        </div>
      </div>

      <div class="s3-dialog-foot foot">
        <button
          class="s3-btn s3-btn-ghost"
          disabled={vm.category === 'security' || vm.category === 'about'}
          onclick={() => vm.resetCategory()}>Standardwerte</button
        >
        <span class="s3-muted grow changes">{vm.changesText}</span>
        <button class="s3-btn s3-btn-secondary" disabled={vm.saving} onclick={() => vm.close()}>Abbrechen</button>
        <button class="s3-btn s3-btn-primary" disabled={!vm.canSave} onclick={() => vm.save()}>Speichern</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .settings {
    width: 980px;
    max-width: calc(100vw - 48px);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-12);
    padding: var(--space-16) var(--space-12) var(--space-16) var(--space-24);
    border-bottom: 1px solid var(--border-subtle);
  }
  .grow {
    flex: 1;
  }
  .search {
    width: 240px;
    font-size: var(--text-13);
  }
  .body {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    height: 560px;
    max-height: calc(100vh - 200px);
  }
  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-12) var(--space-8);
    background: var(--bg-panel);
    border-right: 1px solid var(--border-subtle);
    font-size: var(--text-13);
  }
  .empty {
    padding: var(--space-8);
    font-size: var(--text-12);
  }
  .content {
    padding: var(--space-16) var(--space-24);
    overflow: auto;
  }
  h3 {
    margin: 0 0 var(--space-4);
    font-size: var(--text-16);
    line-height: 22px;
    font-weight: var(--weight-semibold);
  }
  .lead {
    margin: 0 0 var(--space-4);
    font-size: var(--text-13);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-16);
    font-size: var(--text-13);
  }
  .size-select {
    width: 160px;
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin: 0;
    padding: 0;
    border: 0;
    font-size: var(--text-13);
  }
  .example {
    font-size: var(--text-12);
  }
  .text {
    margin: 6px 0 0;
    font-size: var(--text-13);
  }
  .about {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: var(--space-4) var(--space-12);
    margin: 6px 0 0;
    font-size: var(--text-13);
  }
  .about dt {
    color: var(--fg-secondary);
  }
  .about dd {
    margin: 0;
  }
  .foot {
    align-items: center;
  }
  .changes {
    font-size: var(--text-13);
  }
</style>
