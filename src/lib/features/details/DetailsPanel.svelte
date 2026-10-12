<script lang="ts">
  // Seitenpanel „Eigenschaften“ (Screen 5): Allgemein, Metadaten, Tags, Versionen, Freigabe,
  // Berechtigungen als zusammenklappbare Abschnitte.
  import type { Snippet } from 'svelte';
  import SpriteIcon from '../../ui/icons/SpriteIcon.svelte';
  import ConfirmDialog from '../../ui/dialog/ConfirmDialog.svelte';
  import { countText, formatBytes, formatBytesExact, formatDate, formatDateSeconds } from '../../core/format';
  import { ICON_BY_KIND, kindOf } from '../objects/entry';
  import type { DetailsSection, DetailsViewModel } from './detailsViewModel.svelte';
  import ShareLinkFields from '../share/ShareLinkFields.svelte';
  import { MAX_TAGS, encryptionText, permissionSummary, shortVersion } from './detailsRules';

  interface Props {
    vm: DetailsViewModel;
  }

  let { vm }: Props = $props();

  const head = $derived(vm.head.value);
  const tags = $derived(vm.tags.value ?? []);
  const versions = $derived(vm.versions.value ?? []);
  const changeCount = $derived(vm.metadata.changeCount);
</script>

{#snippet sectionHead(section: DetailsSection, title: string, aside?: string, action?: Snippet)}
  <div class="s3-section-h">
    <button
      class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
      aria-expanded={!vm.collapsed[section]}
      aria-label="{title} {vm.collapsed[section] ? 'ausklappen' : 'einklappen'}"
      onclick={() => vm.toggleSection(section)}
    >
      <SpriteIcon name={vm.collapsed[section] ? 'chevron-right' : 'chevron-down'} />
    </button>
    {title}
    {#if aside}<span class="s3-muted s3-ellipsis s3-section-aside">{aside}</span>{/if}
    {@render action?.()}
  </div>
{/snippet}

{#snippet addMetadata()}
  <button class="s3-btn s3-btn-ghost s3-btn-sm" disabled={!head || vm.busy} onclick={() => vm.metadata.add()}>
    <SpriteIcon name="plus" />Hinzufügen
  </button>
{/snippet}

{#snippet problem(section: DetailsSection, loadError: { message: string } | null)}
  {@const error = vm.errorFor(section) ?? loadError}
  {#if error}<p class="s3-section-bar error" role="alert">{error.message}</p>{/if}
{/snippet}

{#snippet readonlyRow(label: string, value: string, mono = false, copyLabel?: string)}
  <div class="s3-prop-row is-readonly">
    <div class="s3-prop-k">{label}</div>
    <div class="s3-prop-v" class:s3-mono={mono}>
      <span title={value}>{value}</span>
      {#if copyLabel}
        <button class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon" aria-label={copyLabel} onclick={() => vm.copy(value)}>
          <SpriteIcon name="copy" />
        </button>
      {/if}
    </div>
  </div>
{/snippet}

<aside class="s3-sidepanel panel" aria-label="Eigenschaften">
  <div class="s3-sidepanel-head">
    {#if vm.entry}<SpriteIcon name={ICON_BY_KIND[kindOf(vm.entry)]} />{/if}
    <span class="s3-sidepanel-title s3-ellipsis">{vm.entry?.name ?? 'Eigenschaften'}</span>
    <button
      class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
      aria-label="Panel schließen (Alt+Enter)"
      onclick={() => vm.close()}
    >
      <SpriteIcon name="x" />
    </button>
  </div>
  <div class="s3-sidepanel-body">
    {#if vm.placeholder}
      <p class="placeholder s3-muted">{vm.placeholder}</p>
    {:else if vm.target}
      <section aria-label="Allgemein">
        {@render sectionHead('general', 'Allgemein')}
        {#if !vm.collapsed.general}
          {@render problem('general', vm.head.error)}
          {#if head}
            <div class="s3-props">
              {@render readonlyRow('Key', vm.target.key, true, 'Key kopieren')}
              {@render readonlyRow('Größe', `${formatBytes(head.size)} (${formatBytesExact(head.size)})`)}
              {@render readonlyRow('Content-Type', head.contentType ?? '—', true)}
              {@render readonlyRow('ETag', head.etag ?? '—', true, head.etag ? 'ETag kopieren' : undefined)}
              {@render readonlyRow('Storage Class', head.storageClass ?? '—')}
              {@render readonlyRow('Verschlüsselung', encryptionText(head.encryption))}
              {@render readonlyRow('Letzte Änderung', formatDateSeconds(head.lastModifiedMs ?? undefined) || '—')}
              {#if head.versionId && head.versionId !== 'null'}
                {@render readonlyRow('Version', head.versionId, true, 'Version-ID kopieren')}
              {/if}
            </div>
          {:else if !vm.head.error}
            <p class="s3-section-bar s3-muted">Lädt …</p>
          {/if}
        {/if}
      </section>

      <section aria-label="Metadaten">
        {@render sectionHead('metadata', 'Metadaten', undefined, addMetadata)}
        {#if !vm.collapsed.metadata}
          {@render problem('metadata', null)}
          <div class="s3-props">
            {#each vm.metadata.rows as row (row.id)}
              {@const error = vm.metadata.error(row)}
              <div
                class="s3-prop-row"
                class:is-editing={row.editing}
                class:is-dirty={vm.metadata.isDirty(row)}
                class:is-invalid={error !== null}
              >
                <div class="s3-prop-k s3-mono" title={error ?? row.name}>
                  {#if row.original === null}
                    <label class="s3-input s3-input-sm s3-mono name-input">
                      <input
                        value={row.name}
                        aria-label="Name des neuen Metadatums"
                        oninput={(e) => vm.metadata.setName(row.id, e.currentTarget.value)}
                      />
                    </label>
                  {:else}
                    <span class="s3-ellipsis">{row.name}</span>
                  {/if}
                </div>
                <div class="s3-prop-v s3-mono">
                  {#if row.editing}
                    <label class="s3-input s3-input-sm s3-mono">
                      <input
                        value={row.value}
                        aria-label="Wert für {row.name}"
                        oninput={(e) => vm.metadata.setValue(row.id, e.currentTarget.value)}
                      />
                    </label>
                    <button
                      class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon always"
                      aria-label="{row.name} entfernen"
                      onclick={() => vm.metadata.remove(row.id)}
                    >
                      <SpriteIcon name="x" />
                    </button>
                  {:else}
                    <span>{row.value}</span>
                    <button
                      class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
                      aria-label="{row.name} bearbeiten"
                      onclick={() => vm.metadata.edit(row.id)}
                    >
                      <SpriteIcon name="pencil" />
                    </button>
                  {/if}
                </div>
              </div>
            {:else}
              <p class="s3-section-bar s3-muted empty">Keine Metadaten.</p>
            {/each}
          </div>
          {#if changeCount > 0}
            <div class="s3-section-bar">
              <span class="s3-muted grow">
                {countText(changeCount, 'Änderung', 'Änderungen')} · Speichern kopiert das Objekt auf sich selbst
              </span>
              <button class="s3-btn s3-btn-ghost s3-btn-sm" disabled={vm.busy} onclick={() => vm.metadata.discard()}
                >Verwerfen</button
              >
              <button
                class="s3-btn s3-btn-secondary s3-btn-sm"
                disabled={vm.busy || !vm.metadata.isValid}
                onclick={() => vm.saveMetadata()}>Speichern</button
              >
            </div>
          {/if}
        {/if}
      </section>

      <section aria-label="Tags">
        {@render sectionHead('tags', 'Tags', vm.tags.value ? `${tags.length} von ${MAX_TAGS}` : undefined)}
        {#if !vm.collapsed.tags}
          {@render problem('tags', vm.tags.error)}
          <div class="s3-section-body">
            {#each tags as tag (tag.key)}
              <span class="s3-chip">
                <span class="s3-chip-k">{tag.key}</span><span class="s3-chip-v">{tag.value}</span>
                <button
                  class="s3-chip-x"
                  aria-label="Tag {tag.key} entfernen"
                  disabled={vm.busy}
                  onclick={() => vm.removeTag(tag.key)}><SpriteIcon name="x" /></button
                >
              </span>
            {/each}
            {#if vm.tagDraft}
              <form
                class="tag-form"
                onsubmit={(e) => {
                  e.preventDefault();
                  void vm.addTag();
                }}
              >
                <label class="s3-input s3-input-sm s3-mono">
                  <input bind:value={vm.tagDraft.key} aria-label="Tag-Schlüssel" placeholder="Schlüssel" />
                </label>
                <label class="s3-input s3-input-sm">
                  <input bind:value={vm.tagDraft.value} aria-label="Tag-Wert" placeholder="Wert" />
                </label>
                <button type="submit" class="s3-btn s3-btn-secondary s3-btn-sm" disabled={vm.tagDraftError !== null}
                  >Hinzufügen</button
                >
                <button type="button" class="s3-btn s3-btn-ghost s3-btn-sm" onclick={() => vm.cancelTag()}
                  >Abbrechen</button
                >
                {#if vm.tagDraft.key && vm.tagDraftError}<span class="error">{vm.tagDraftError}</span>{/if}
              </form>
            {:else if vm.tags.value && tags.length < MAX_TAGS}
              <button class="s3-chip s3-chip-add" onclick={() => vm.startTag()}><SpriteIcon name="plus" />Tag</button>
            {/if}
          </div>
        {/if}
      </section>

      <section aria-label="Versionen">
        {@render sectionHead('versions', 'Versionen', vm.versions.value ? String(versions.length) : undefined)}
        {#if !vm.collapsed.versions}
          {@render problem('versions', vm.versions.error)}
          <div role="list" aria-label="Versionen">
            {#each versions as version (version.versionId)}
              <div role="listitem" class="s3-version-row">
                <span class="version-id">
                  <span class="s3-mono s3-ellipsis" title={version.versionId}>{version.versionId}</span>
                  {#if version.isDeleteMarker}<span class="s3-badge s3-badge-warning">Delete Marker</span>
                  {:else if version.isLatest}<span class="s3-badge s3-badge-accent">aktuell</span>{/if}
                </span>
                <span class="s3-num s3-muted">{formatDate(version.lastModifiedMs ?? undefined)}</span>
                <span class="s3-num right">{version.isDeleteMarker ? '—' : formatBytes(version.size)}</span>
                <span class="s3-version-actions">
                  {#if !version.isLatest && !version.isDeleteMarker}
                    <button
                      class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
                      aria-label="Version {shortVersion(version.versionId)} wiederherstellen"
                      disabled={vm.busy}
                      onclick={() => vm.restoreVersion(version.versionId)}><SpriteIcon name="history" /></button
                    >
                  {/if}
                  <button
                    class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
                    aria-label="Version {shortVersion(version.versionId)} endgültig löschen"
                    disabled={vm.busy}
                    onclick={() => vm.requestVersionDelete(version)}><SpriteIcon name="trash-2" /></button
                  >
                </span>
              </div>
            {:else}
              {#if vm.versions.value}<p class="s3-section-bar s3-muted">Keine Versionen.</p>{/if}
            {/each}
          </div>
        {/if}
      </section>

      <section aria-label="Freigabe">
        {@render sectionHead('share', 'Freigabe')}
        {#if !vm.collapsed.share}
          {@render problem('share', null)}
          <div class="share">
            <ShareLinkFields link={vm.share} onshare={() => vm.shareWithWindows()} />
          </div>
        {/if}
      </section>

      <section aria-label="Berechtigungen">
        {@render sectionHead(
          'permissions',
          'Berechtigungen',
          vm.acl.value ? permissionSummary(vm.acl.value) : undefined,
        )}
        {#if !vm.collapsed.permissions}
          {@render problem('permissions', vm.acl.error)}
          {#if vm.acl.value}
            <div class="s3-props">
              {#each vm.acl.value.grants as grant, index (index)}
                {@render readonlyRow(
                  grant.isPublic ? `${grant.grantee} (öffentlich)` : grant.grantee,
                  grant.permission,
                )}
              {/each}
            </div>
          {/if}
        {/if}
      </section>
    {/if}
  </div>
</aside>

{#if vm.pendingVersionDelete}
  <ConfirmDialog
    title="Version endgültig löschen?"
    message="Version {shortVersion(vm.pendingVersionDelete.versionId)} von „{vm.entry?.name}“ wird endgültig gelöscht."
    note={vm.pendingVersionDelete.isLatest
      ? 'Es ist die aktuelle Version; danach gilt die nächstältere als aktuell.'
      : 'Das lässt sich nicht rückgängig machen.'}
    confirmLabel="Endgültig löschen"
    danger
    busy={vm.busy}
    error={vm.errorFor('versions')?.message ?? null}
    onconfirm={() => vm.confirmVersionDelete()}
    oncancel={() => vm.cancelVersionDelete()}
  />
{/if}

<style>
  .panel {
    flex: none;
    height: auto;
    min-height: 0;
  }
  .placeholder {
    margin: var(--space-16);
  }
  .error {
    color: var(--error-fg);
  }
  .grow {
    flex: 1;
  }
  .right {
    text-align: right;
  }
  .version-id {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-12);
  }
  .name-input {
    flex: 1;
  }
  /* Entfernen bleibt beim Bearbeiten sichtbar; components.css blendet Knöpfe sonst bis zum Hover aus. */
  .s3-prop-row .s3-prop-v .always {
    visibility: visible;
  }
  .empty {
    grid-column: 1 / -1;
  }
  .tag-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  .tag-form .s3-input {
    width: 110px;
  }
  .share {
    padding: 10px var(--space-16) var(--space-12);
    border-bottom: 1px solid var(--border-subtle);
  }
</style>
