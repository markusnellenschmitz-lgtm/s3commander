// View-Model des Hauptfensters (Screen 2 und 6): Verbindungen mit Buckets, Navigation
// durch Präfixe mit Verlauf, seitenweises Listing mit Abbruch und Statusleiste.

import type {
  BackendError,
  BackendPort,
  BucketInfo,
  FolderPage,
  ConnectionProfile,
  ObjectSelection,
  FolderLocation,
} from '../../core/backend';
import { CANCELLED_KIND, toBackendError } from '../../core/backend';
import { Selection } from '../../core/table/selection.svelte';
import type { SortState } from '../../core/table/types';
import type { TreeNode } from '../../core/tree';
import { treeKeyAction } from '../../core/tree';
import { formatCount, formatDate } from '../../core/format';
import { ArraySource } from '../objects/arraySource.svelte';
import { toSelectedItem, type EntryColumn, type S3Entry } from '../objects/entry';
import { selectedBytes, selectedEntries } from '../objects/objectSource';
import { objectCountText, selectionText, sortText } from '../objects/statusText';
import { crumbs, pageEntries, parentPrefix, type Crumb } from './entryMapping';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ListingState = 'idle' | 'loading' | 'done' | 'cancelled' | 'error';

export interface ConnectionState {
  profile: ConnectionProfile;
  status: ConnectionStatus;
  buckets: BucketInfo[];
  error: BackendError | null;
  expanded: boolean;
}

export interface Location {
  profileId: string;
  bucket: string;
  prefix: string;
}

/** Alles, was ein Tab sich merkt: offener Ordner, Verlauf und Sortierung. */
export interface BrowserView {
  location: Location | null;
  back: Location[];
  forward: Location[];
  sort: SortState;
}

export interface BrowserDeps {
  backend: BackendPort;
  newId?: () => string;
  /** Plant das Übernehmen gesammelter Seiten in die Tabelle. */
  schedule?: (run: () => void, delayMs: number) => void;
}

export const DEFAULT_SORT: SortState = { column: 'name', dir: 1 };
/** Seiten werden höchstens so oft in die Tabelle übernommen, damit sie nicht ständig neu sortiert. */
export const FLUSH_INTERVAL_MS = 150;

/** Was ein Knoten des Verbindungsbaums darstellt: eine Verbindung oder einen Bucket darin. */
export interface TreeTarget {
  profileId: string;
  bucket?: string;
}

export const connectionNodeId = (profileId: string) => `c:${profileId}`;
export const bucketNodeId = (profileId: string, bucket: string) => `b:${profileId}/${bucket}`;

export class BrowserViewModel {
  connections = $state<ConnectionState[]>([]);
  profilesError = $state<BackendError | null>(null);
  location = $state<Location | null>(null);
  listingState = $state<ListingState>('idle');
  listingError = $state<BackendError | null>(null);
  loadedCount = $state(0);
  /** Zeitpunkt des gespeicherten Listings, solange die Tabelle den Stand aus dem Cache zeigt. */
  cachedAtMs = $state<number | null>(null);
  compact = $state(false);
  /** Ausgeblendete Spalten der Objekttabelle (Einstellungen › Darstellung). */
  hiddenColumns = $state<EntryColumn[]>([]);
  sort = $state<SortState>(DEFAULT_SORT);
  activeTreeId = $state<string | null>(null);
  readonly source = new ArraySource([], DEFAULT_SORT);
  readonly selection = new Selection();
  #refreshQueued = false;

  #backHistory = $state<Location[]>([]);
  #forwardHistory = $state<Location[]>([]);
  #listingId: string | null = null;
  readonly #forgetListeners = new Set<(profileId: string) => void>();
  #pending: S3Entry[] = [];
  /** Frische Einträge, während die Tabelle noch den Stand aus dem Cache zeigt. */
  #live: S3Entry[] = [];
  #flushPlanned = false;
  readonly #backend: BackendPort;
  readonly #newId: () => string;
  readonly #schedule: (run: () => void, delayMs: number) => void;

  constructor(deps: BrowserDeps) {
    this.#backend = deps.backend;
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
    this.#schedule = deps.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
  }

  // ---------- Verbindungen ----------

  /** Lädt die Profile; mit `autoConnect` (Standard) werden alle sofort verbunden. */
  async loadProfiles({ autoConnect = true }: { autoConnect?: boolean } = {}): Promise<void> {
    try {
      const profiles = await this.#backend.listProfiles();
      this.connections = profiles.map((profile) => ({
        profile,
        status: 'disconnected',
        buckets: [],
        error: null,
        expanded: false,
      }));
      this.profilesError = null;
      if (autoConnect) await Promise.all(profiles.map((p) => this.connect(p.id)));
    } catch (error) {
      this.profilesError = toBackendError(error);
    }
  }

  async connect(profileId: string): Promise<void> {
    const connection = this.#connection(profileId);
    if (!connection) return;
    connection.status = 'connecting';
    connection.error = null;
    try {
      connection.buckets = await this.#backend.listBuckets(profileId);
      connection.status = 'connected';
      connection.expanded = true;
    } catch (error) {
      connection.status = 'error';
      connection.error = toBackendError(error);
    }
  }

  /** Klick auf eine Verbindung: verbinden, wenn nötig, sonst auf- oder zuklappen. */
  async toggleConnection(profileId: string): Promise<void> {
    const connection = this.#connection(profileId);
    if (!connection) return;
    if (connection.status === 'connected') connection.expanded = !connection.expanded;
    else await this.connect(profileId);
  }

  /** Trennt die Verbindung; ein offener Ordner dieser Verbindung wird geschlossen. */
  disconnect(profileId: string): void {
    const connection = this.#connection(profileId);
    if (!connection) return;
    connection.status = 'disconnected';
    connection.buckets = [];
    connection.expanded = false;
    connection.error = null;
    this.#forget(profileId);
  }

  /**
   * Entfernt Profil und Zugangsdaten. Die Daten im Bucket bleiben unberührt.
   * Fehler des Backends gibt die Methode an den Aufrufer weiter.
   */
  async deleteProfile(profileId: string): Promise<void> {
    await this.#backend.deleteProfile(profileId);
    this.connections = this.connections.filter((c) => c.profile.id !== profileId);
    this.#forget(profileId);
  }

  /** Nach dem Speichern im Verbindungsdialog: Profil übernehmen und neu verbinden. */
  async upsertProfile(profile: ConnectionProfile): Promise<void> {
    const existing = this.#connection(profile.id);
    if (existing) existing.profile = profile;
    else this.connections.push({ profile, status: 'disconnected', buckets: [], error: null, expanded: false });
    this.connections.sort((a, b) => a.profile.name.localeCompare(b.profile.name, 'de'));
    await this.connect(profile.id);
  }

  // ---------- Navigation ----------

  openBucket(profileId: string, bucket: string): void {
    this.#navigate({ profileId, bucket, prefix: '' });
  }

  /** Enter oder Doppelklick in der Tabelle: Ordner öffnen. */
  open(entry: S3Entry): void {
    if (entry.isPrefix && this.location) this.#navigate({ ...this.location, prefix: entry.key });
  }

  openPrefix(prefix: string): void {
    if (this.location && prefix !== this.location.prefix) this.#navigate({ ...this.location, prefix });
  }

  goUp(): void {
    if (this.canGoUp && this.location) this.openPrefix(parentPrefix(this.location.prefix));
  }

  goBack(): void {
    const previous = this.#backHistory.at(-1);
    if (!previous || !this.location) return;
    this.#backHistory = this.#backHistory.slice(0, -1);
    this.#forwardHistory = [...this.#forwardHistory, this.location];
    this.#show(previous);
  }

  goForward(): void {
    const next = this.#forwardHistory.at(-1);
    if (!next || !this.location) return;
    this.#forwardHistory = this.#forwardHistory.slice(0, -1);
    this.#backHistory = [...this.#backHistory, this.location];
    this.#show(next);
  }

  /** F5 und nach eigenen Änderungen: frisch vom Server, ohne Umweg über den Cache. */
  refresh(): void {
    if (this.location) void this.#load(this.location, true);
  }

  cancelListing(): void {
    if (this.#listingId) void this.#backend.cancelListing(this.#listingId);
  }

  changeSort(sort: SortState): void {
    this.sort = sort;
    this.source.setSort(sort);
  }

  get canGoBack(): boolean {
    return this.#backHistory.length > 0;
  }

  get canGoForward(): boolean {
    return this.#forwardHistory.length > 0;
  }

  get canGoUp(): boolean {
    return (this.location?.prefix ?? '') !== '';
  }

  get crumbs(): Crumb[] {
    return this.location ? crumbs(this.location.prefix) : [];
  }

  get currentConnection(): ConnectionState | undefined {
    return this.location ? this.#connection(this.location.profileId) : undefined;
  }

  /** Fehler für die Fehlerleiste: Listing-Fehler oder Verbindungsfehler des aktuellen Profils. */
  get visibleError(): BackendError | null {
    const connection = this.currentConnection;
    return this.listingError ?? (connection?.status === 'error' ? connection.error : null);
  }

  get isEmptyFolder(): boolean {
    void this.source.version;
    return this.listingState === 'done' && this.source.totalCount === 0;
  }

  /** Der Ordner hat Einträge, aber der Filter blendet alle aus. */
  get hasNoMatches(): boolean {
    void this.source.version;
    return this.source.isFiltered && this.source.length === 0 && this.source.totalCount > 0;
  }

  /** "Erneut versuchen" in der Fehlerleiste: fehlerhafte Verbindung neu aufbauen, Ordner neu laden. */
  retry(): void {
    const connection = this.currentConnection;
    if (connection?.status === 'error') void this.connect(connection.profile.id);
    this.refresh();
  }

  /**
   * Fensterweite Tastenkürzel (UI-SPEC §6). Liefert true, wenn das Kürzel behandelt wurde.
   * inGrid: Fokus liegt in einer Liste (Rücktaste geht dann eine Ebene hoch).
   */
  handleShortcut(key: string, alt: boolean, inGrid: boolean): boolean {
    const actions: [boolean, () => void][] = [
      [key === 'F5', () => this.refresh()],
      [alt && key === 'ArrowUp', () => this.goUp()],
      [alt && key === 'ArrowLeft', () => this.goBack()],
      [alt && key === 'ArrowRight', () => this.goForward()],
      [inGrid && key === 'Backspace', () => this.goUp()],
    ];
    const match = actions.find(([applies]) => applies);
    match?.[1]();
    return match !== undefined;
  }

  /** Ziel für Uploads: der offene Ordner, sonst null. */
  get uploadTarget(): FolderLocation | null {
    const location = this.location;
    return location ? { profileId: location.profileId, bucket: location.bucket, prefix: location.prefix } : null;
  }

  /** Ob im offenen Ordner etwas ausgewählt ist (Herunterladen, Löschen). */
  get hasSelection(): boolean {
    return this.location !== null && this.selectedCount > 0;
  }

  get selectedCount(): number {
    void this.selection.version;
    return this.selection.count(this.source.length);
  }

  get selectedBytes(): number {
    void this.selection.version;
    return selectedBytes(this.selection, this.source);
  }

  /** Gewählte und geladene Einträge in Anzeigereihenfolge. */
  get selectedEntries(): S3Entry[] {
    return this.hasSelection ? selectedEntries(this.selection, this.source) : [];
  }

  /** Gewählte Einträge für Herunterladen und Löschen; null ohne offenen Ordner oder Auswahl. */
  get selectedObjects(): ObjectSelection | null {
    const folder = this.uploadTarget;
    const items = this.selectedEntries.map(toSelectedItem);
    return folder && items.length > 0 ? { folder, items } : null;
  }

  /**
   * Nach einer Änderung im Ordner `prefix` neu laden, wenn er oder ein übergeordneter Ordner
   * angezeigt wird (dort kann ein neuer Unterordner erscheinen). Mehrere Meldungen im selben
   * Durchlauf ergeben ein einziges Neuladen.
   */
  refreshIfShowing(profileId: string, bucket: string, prefix: string): void {
    const l = this.location;
    const affected = l && l.profileId === profileId && l.bucket === bucket && prefix.startsWith(l.prefix);
    if (!affected || this.#refreshQueued) return;
    this.#refreshQueued = true;
    queueMicrotask(() => {
      this.#refreshQueued = false;
      this.refresh();
    });
  }

  get tableLabel(): string {
    return this.location ? `Objekte in ${this.location.bucket}/${this.location.prefix}` : 'Objekte';
  }

  // ---------- Statusleiste ----------

  get countText(): string {
    void this.source.version;
    const folders = this.source.folderCount;
    const visible = objectCountText(this.source.length - folders, folders);
    return this.source.isFiltered ? `${visible} von ${formatCount(this.source.totalCount)} (gefiltert)` : visible;
  }

  get selectionText(): string {
    return selectionText(this.selectedCount, this.selectedBytes);
  }

  get sortText(): string {
    return sortText(this.sort);
  }

  get listingText(): string {
    const count = formatCount(this.loadedCount);
    if (this.cachedAtMs !== null) {
      const cached = `Stand ${formatDate(this.cachedAtMs)} aus dem Cache`;
      if (this.listingState === 'loading') return `${cached}, wird aktualisiert (${count} Objekte geladen)`;
      return `${cached}, Aktualisieren ${this.listingState === 'cancelled' ? 'abgebrochen' : 'fehlgeschlagen'}`;
    }
    if (this.listingState === 'loading') return `${count} Objekte geladen, Listing läuft`;
    if (this.listingState === 'cancelled') return `Listing abgebrochen nach ${count} Einträgen`;
    return '';
  }

  // ---------- Baum ----------

  get treeNodes(): TreeNode[] {
    return this.connections.flatMap((c) => {
      const id = connectionNodeId(c.profile.id);
      const node: TreeNode = { id, level: 0, expandable: true, expanded: c.expanded, parentId: null };
      const children = c.expanded
        ? c.buckets.map((b) => ({
            id: bucketNodeId(c.profile.id, b.name),
            level: 1,
            expandable: false,
            expanded: false,
            parentId: id,
          }))
        : [];
      return [node, ...children];
    });
  }

  /** Verbindung oder Bucket zu einer Knoten-ID; null für unbekannte Knoten. */
  treeTarget(nodeId: string): TreeTarget | null {
    for (const { profile, buckets } of this.connections) {
      if (connectionNodeId(profile.id) === nodeId) return { profileId: profile.id };
      const bucket = buckets.find((b) => bucketNodeId(profile.id, b.name) === nodeId);
      if (bucket) return { profileId: profile.id, bucket: bucket.name };
    }
    return null;
  }

  isActiveBucket(profileId: string, bucket: string): boolean {
    return this.location?.profileId === profileId && this.location.bucket === bucket;
  }

  treeKeyDown(key: string): boolean {
    const action = treeKeyAction(this.treeNodes, this.activeTreeId, key);
    switch (action.type) {
      case 'none':
        return false;
      case 'move':
        this.activeTreeId = action.id;
        return true;
      case 'expand':
      case 'collapse':
      case 'activate':
        void this.activateTreeNode(action.id, action.type);
        return true;
    }
  }

  async activateTreeNode(id: string, intent: 'expand' | 'collapse' | 'activate' = 'activate'): Promise<void> {
    this.activeTreeId = id;
    const connection = this.connections.find((c) => connectionNodeId(c.profile.id) === id);
    if (connection) {
      if (intent === 'collapse') connection.expanded = false;
      else if (intent === 'expand' && connection.status === 'connected') connection.expanded = true;
      else await this.toggleConnection(connection.profile.id);
      return;
    }
    for (const c of this.connections) {
      const bucket = c.buckets.find((b) => bucketNodeId(c.profile.id, b.name) === id);
      if (bucket) this.openBucket(c.profile.id, bucket.name);
    }
  }

  // ---------- Ansichten für Tabs ----------

  captureView(): BrowserView {
    return {
      location: this.location,
      back: [...this.#backHistory],
      forward: [...this.#forwardHistory],
      sort: this.sort,
    };
  }

  /** Stellt eine gemerkte Ansicht her und lädt ihren Ordner neu; ohne Ordner bleibt die Tabelle leer. */
  restoreView(view: BrowserView): void {
    this.#backHistory = [...view.back];
    this.#forwardHistory = [...view.forward];
    this.changeSort(view.sort);
    if (view.location) this.#show(view.location);
    else this.#clearFolder();
  }

  /** Meldet, wenn eine Verbindung getrennt oder gelöscht wurde; liefert die Abmeldung. */
  onForget(listener: (profileId: string) => void): () => void {
    this.#forgetListeners.add(listener);
    return () => this.#forgetListeners.delete(listener);
  }

  // ---------- intern ----------

  #connection(profileId: string): ConnectionState | undefined {
    return this.connections.find((c) => c.profile.id === profileId);
  }

  /** Schließt alles, was zu einer Verbindung gehört: offenen Ordner, Verlauf, Baum-Cursor. */
  #forget(profileId: string): void {
    const other = (l: Location) => l.profileId !== profileId;
    this.#backHistory = this.#backHistory.filter(other);
    this.#forwardHistory = this.#forwardHistory.filter(other);
    const ids = [connectionNodeId(profileId), bucketNodeId(profileId, '')];
    if (ids.some((id) => this.activeTreeId?.startsWith(id))) this.activeTreeId = null;
    if (this.location?.profileId === profileId) this.#clearFolder();
    for (const listener of this.#forgetListeners) listener(profileId);
  }

  /** Schließt den offenen Ordner: kein Listing, leere Tabelle. */
  #clearFolder(): void {
    this.cancelListing();
    this.#listingId = null;
    this.location = null;
    this.source.replace([]);
    this.selection.clear();
    this.loadedCount = 0;
    this.listingError = null;
    this.listingState = 'idle';
    this.cachedAtMs = null;
  }

  #navigate(target: Location): void {
    if (this.location) this.#backHistory = [...this.#backHistory, this.location];
    this.#forwardHistory = [];
    this.#show(target);
  }

  #show(target: Location): void {
    this.location = target;
    this.activeTreeId = bucketNodeId(target.profileId, target.bucket);
    void this.#load(target);
  }

  /**
   * Lädt einen Ordner. Seiten aus dem Cache erscheinen sofort; die frischen Seiten sammeln sich
   * dann im Hintergrund und ersetzen den gespeicherten Stand erst, wenn das Listing fertig ist.
   */
  async #load(target: Location, fresh = false): Promise<void> {
    this.cancelListing();
    const listingId = this.#newId();
    this.#listingId = listingId;
    this.#pending = [];
    this.#live = [];
    this.source.replace([]);
    this.selection.clear();
    this.loadedCount = 0;
    this.listingError = null;
    this.listingState = 'loading';
    this.cachedAtMs = null;
    const isCurrent = () => this.#listingId === listingId;
    const onPage = (page: FolderPage) => {
      if (isCurrent()) this.#receive(page, pageEntries(page, target.prefix));
    };
    try {
      const { profileId, bucket, prefix } = target;
      await this.#backend.listFolder(profileId, bucket, prefix, listingId, onPage, { fresh });
      if (isCurrent()) {
        this.#replaceCachedWithLive();
        this.listingState = 'done';
      }
    } catch (error) {
      if (!isCurrent()) return;
      const backendError = toBackendError(error);
      this.listingState = backendError.kind === CANCELLED_KIND ? 'cancelled' : 'error';
      this.listingError = backendError.kind === CANCELLED_KIND ? null : backendError;
    } finally {
      if (isCurrent()) {
        this.#flush();
        this.#listingId = null;
      }
    }
  }

  /** Cache-Seiten und frische Seiten ohne Cache gehen in die Tabelle, frische nach Cache-Seiten in den Puffer. */
  #receive(page: FolderPage, entries: S3Entry[]): void {
    if (page.cachedMs !== null) {
      this.cachedAtMs = page.cachedMs;
    } else if (this.cachedAtMs !== null) {
      this.#live.push(...entries);
      this.loadedCount += entries.length;
      return;
    } else {
      this.loadedCount += entries.length;
    }
    this.#pending.push(...entries);
    this.#planFlush();
  }

  /** Ersetzt den Stand aus dem Cache durch das fertige Listing; die Auswahl bleibt, soweit vorhanden. */
  #replaceCachedWithLive(): void {
    if (this.cachedAtMs === null) return;
    this.#pending = [];
    this.source.replace(this.#live);
    this.selection.prune(this.source);
    this.#live = [];
    this.cachedAtMs = null;
  }

  #planFlush(): void {
    if (this.#flushPlanned) return;
    this.#flushPlanned = true;
    this.#schedule(() => this.#flush(), FLUSH_INTERVAL_MS);
  }

  #flush(): void {
    this.#flushPlanned = false;
    const entries = this.#pending;
    this.#pending = [];
    this.source.append(entries);
  }
}
