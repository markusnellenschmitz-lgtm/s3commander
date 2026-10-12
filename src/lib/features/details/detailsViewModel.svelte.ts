// View-Model des Seitenpanels „Eigenschaften“ (Screen 5): folgt der Auswahl, lädt Kopfdaten,
// Tags, Versionen und Berechtigungen getrennt, damit ein Fehler die anderen Abschnitte nicht leert.

import type {
  BackendError,
  BackendPort,
  FolderLocation,
  ObjectAcl,
  ObjectAt,
  ObjectHead,
  ObjectTag,
  ObjectVersion,
} from '../../core/backend';
import { toBackendError } from '../../core/backend';
import type { S3Entry } from '../objects/entry';
import { DEFAULT_SHARE_SECS, tagError } from './detailsRules';
import { MetadataEditor } from './metadataEditor.svelte';

export type DetailsSection = 'general' | 'metadata' | 'tags' | 'versions' | 'share' | 'permissions';

export const PROPERTIES_KEY = 'Enter';

/** Ergebnis eines einzeln geladenen Abschnitts. */
export interface Loaded<T> {
  value: T | null;
  error: BackendError | null;
}

const EMPTY = { value: null, error: null };

export interface DetailsDeps {
  backend: BackendPort;
  writeText: (text: string) => Promise<void>;
  now?: () => number;
  /** Ein Objekt wurde verändert (neue Version); das Hauptfenster lädt den Ordner neu. */
  onChanged?: (folder: FolderLocation) => void;
}

export class DetailsViewModel {
  isOpen = $state(false);
  target = $state<ObjectAt | null>(null);
  entry = $state<S3Entry | null>(null);
  /** Hinweis statt Details, wenn nicht genau eine Datei gewählt ist. */
  placeholder = $state<string | null>(null);
  collapsed = $state<Record<DetailsSection, boolean>>({
    general: false,
    metadata: false,
    tags: false,
    versions: false,
    share: false,
    permissions: true,
  });
  head = $state<Loaded<ObjectHead>>(EMPTY);
  tags = $state<Loaded<ObjectTag[]>>(EMPTY);
  versions = $state<Loaded<ObjectVersion[]>>(EMPTY);
  acl = $state<Loaded<ObjectAcl>>(EMPTY);
  readonly metadata = new MetadataEditor();
  /** Fehler einer Aktion (Speichern, Wiederherstellen, …) im jeweiligen Abschnitt. */
  actionError = $state<{ section: DetailsSection; error: BackendError } | null>(null);
  busy = $state(false);
  tagDraft = $state<{ key: string; value: string } | null>(null);
  shareSecs = $state(DEFAULT_SHARE_SECS);
  shareUrl = $state<string | null>(null);
  pendingVersionDelete = $state<ObjectVersion | null>(null);

  readonly #backend: BackendPort;
  readonly #writeText: DetailsDeps['writeText'];
  readonly #now: () => number;
  readonly #onChanged: DetailsDeps['onChanged'];
  /** Erhöht sich bei jedem neuen Ziel; verspätete Antworten werden verworfen. */
  #loadToken = 0;

  constructor(deps: DetailsDeps) {
    this.#backend = deps.backend;
    this.#writeText = deps.writeText;
    this.#now = deps.now ?? Date.now;
    this.#onChanged = deps.onChanged;
  }

  get nowMs(): number {
    return this.#now();
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
  }

  close(): void {
    this.isOpen = false;
  }

  /** Alt+Enter öffnet und schließt das Panel; liefert true, wenn das Kürzel behandelt wurde. */
  handleShortcut(key: string, alt: boolean): boolean {
    if (!alt || key !== PROPERTIES_KEY) return false;
    this.toggle();
    return true;
  }

  toggleSection(section: DetailsSection): void {
    this.collapsed[section] = !this.collapsed[section];
  }

  /** Folgt der Auswahl im offenen Ordner. Lädt nur neu, wenn sich die Datei ändert. */
  show(entries: readonly S3Entry[], folder: FolderLocation | null): Promise<void> {
    const [entry] = entries;
    const placeholder = this.#placeholderFor(entries, folder);
    if (placeholder || !folder) {
      this.#clear(placeholder);
      return Promise.resolve();
    }
    const at = { profileId: folder.profileId, bucket: folder.bucket, key: entry.key };
    this.placeholder = null;
    this.entry = entry;
    if (this.#isTarget(at)) return Promise.resolve();
    this.target = at;
    return this.reload();
  }

  /** Lädt alle Abschnitte neu, z. B. nach dem Speichern. */
  async reload(): Promise<void> {
    const at = this.target;
    if (!at) return;
    const token = ++this.#loadToken;
    this.actionError = null;
    this.tagDraft = null;
    const [head, tags, versions, acl, url] = await Promise.all([
      load(() => this.#backend.objectHead(at)),
      load(() => this.#backend.objectTags(at)),
      load(() => this.#backend.objectVersions(at)),
      load(() => this.#backend.objectAcl(at)),
      load(() => this.#backend.presignObject(at, this.shareSecs)),
    ]);
    if (token !== this.#loadToken) return;
    this.head = head;
    this.tags = tags;
    this.versions = versions;
    this.acl = acl;
    this.shareUrl = url.value;
    this.metadata.load(head.value?.metadata ?? []);
  }

  // ---------- Metadaten ----------

  async saveMetadata(): Promise<void> {
    if (this.metadata.changeCount === 0 || !this.metadata.isValid) return;
    await this.#act('metadata', (at) => this.#backend.saveObjectMetadata(at, this.metadata.entries), true);
  }

  // ---------- Tags ----------

  startTag(): void {
    this.tagDraft = { key: '', value: '' };
  }

  cancelTag(): void {
    this.tagDraft = null;
  }

  get tagDraftError(): string | null {
    return this.tagDraft ? tagError(this.tagDraft.key, this.tagDraft.value, this.tags.value ?? []) : null;
  }

  async addTag(): Promise<void> {
    const draft = this.tagDraft;
    if (!draft || this.tagDraftError) return;
    const tags = [...(this.tags.value ?? []), { key: draft.key.trim(), value: draft.value.trim() }];
    await this.#saveTags(tags);
  }

  async removeTag(key: string): Promise<void> {
    await this.#saveTags((this.tags.value ?? []).filter((t) => t.key !== key));
  }

  // ---------- Versionen ----------

  async restoreVersion(versionId: string): Promise<void> {
    await this.#act('versions', (at) => this.#backend.restoreObjectVersion(at, versionId), true);
  }

  requestVersionDelete(version: ObjectVersion): void {
    this.pendingVersionDelete = version;
  }

  cancelVersionDelete(): void {
    if (!this.busy) this.pendingVersionDelete = null;
  }

  async confirmVersionDelete(): Promise<void> {
    const version = this.pendingVersionDelete;
    if (!version) return;
    await this.#act('versions', (at) => this.#backend.deleteObjectVersion(at, version.versionId), true);
    this.pendingVersionDelete = null;
  }

  // ---------- Freigabe ----------

  async setShareDuration(secs: number): Promise<void> {
    this.shareSecs = secs;
    const at = this.target;
    if (!at) return;
    await this.#act('share', async () => {
      this.shareUrl = await this.#backend.presignObject(at, secs);
    });
  }

  async copyShareUrl(): Promise<void> {
    if (this.shareUrl) await this.#writeText(this.shareUrl);
  }

  /** Kontextmenü „Presigned URL kopieren“: Link mit 24 Stunden Gültigkeit ohne offenes Panel. */
  async copyPresignedUrl(at: ObjectAt): Promise<void> {
    try {
      await this.#writeText(await this.#backend.presignObject(at, DEFAULT_SHARE_SECS));
    } catch (error) {
      this.actionError = { section: 'share', error: toBackendError(error) };
    }
  }

  async copy(text: string): Promise<void> {
    await this.#writeText(text);
  }

  errorFor(section: DetailsSection): BackendError | null {
    return this.actionError?.section === section ? this.actionError.error : null;
  }

  // ---------- intern ----------

  async #saveTags(tags: ObjectTag[]): Promise<void> {
    await this.#act('tags', async (at) => {
      await this.#backend.saveObjectTags(at, tags);
      this.tags = { value: tags, error: null };
      this.tagDraft = null;
    });
  }

  /** Führt eine Aktion aus, zeigt Fehler im Abschnitt und lädt bei Änderungen am Objekt neu. */
  async #act(section: DetailsSection, action: (at: ObjectAt) => Promise<void>, changesObject = false): Promise<void> {
    const at = this.target;
    if (!at || this.busy) return;
    this.busy = true;
    this.actionError = null;
    try {
      await action(at);
      if (changesObject) {
        this.#onChanged?.({
          profileId: at.profileId,
          bucket: at.bucket,
          prefix: at.key.slice(0, at.key.lastIndexOf('/') + 1),
        });
        await this.reload();
      }
    } catch (error) {
      this.actionError = { section, error: toBackendError(error) };
    } finally {
      this.busy = false;
    }
  }

  #placeholderFor(entries: readonly S3Entry[], folder: FolderLocation | null): string | null {
    if (!folder || entries.length === 0) return 'Wähle eine Datei, um ihre Eigenschaften zu sehen.';
    if (entries.length > 1) return `${entries.length} Einträge ausgewählt. Wähle eine einzelne Datei.`;
    return entries[0].isPrefix ? 'Ordner haben keine eigenen Eigenschaften. Wähle eine Datei.' : null;
  }

  #isTarget(at: ObjectAt): boolean {
    const t = this.target;
    return t !== null && t.profileId === at.profileId && t.bucket === at.bucket && t.key === at.key;
  }

  #clear(placeholder: string | null): void {
    this.#loadToken++;
    this.placeholder = placeholder;
    this.target = null;
    this.entry = null;
    this.head = EMPTY;
    this.tags = EMPTY;
    this.versions = EMPTY;
    this.acl = EMPTY;
    this.shareUrl = null;
    this.metadata.load([]);
  }
}

async function load<T>(request: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { value: await request(), error: null };
  } catch (error) {
    return { value: null, error: toBackendError(error) };
  }
}
