// View-Model der Transfer-Queue (Screen 4) und der Kurzinfo in der Statusleiste.

import type {
  BackendError,
  BackendPort,
  ObjectSelection,
  FilePickerPort,
  FolderLocation,
  TransferSnapshot,
  TransferUpdate,
} from '../../core/backend';
import { toBackendError, type SelectionRequest } from '../../core/backend';
import { changedFolders } from './transferText';
import { localFolder } from '../../core/localPath';
import { TransferList } from './transferList.svelte';
import {
  filterTransfers,
  summarizeTransfers,
  transferRowSlots,
  type TransferFilter,
  type TransferTotals,
} from './transferSummary';

export { FINISHED_STATES, type TransferFilter, type TransferTotals } from './transferSummary';

export const TRANSFER_FILTERS: readonly { id: TransferFilter; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'active', label: 'Aktiv' },
  { id: 'waiting', label: 'Wartend' },
  { id: 'done', label: 'Fertig' },
  { id: 'failed', label: 'Fehler' },
];

/** Was die Kürzel Strg+U und Strg+D gerade betreffen würden. */
export interface TransferShortcutContext {
  uploadTarget: FolderLocation | null;
  selection: SelectionRequest;
}

export interface TransfersDeps {
  backend: BackendPort;
  picker: FilePickerPort;
  /** Ein Transfer hat einen Ordner verändert; das Hauptfenster lädt ihn neu, wenn er offen ist. */
  onFolderChanged?: (folder: FolderLocation) => void;
  /** Ein Download hat einen lokalen Ordner verändert (Zwei-Panel-Ansicht). */
  onLocalChanged?: (dir: string) => void;
}

export class TransfersViewModel {
  expanded = $state(false);
  filter = $state<TransferFilter>('all');
  selectedId = $state<number | null>(null);
  error = $state<BackendError | null>(null);

  readonly #backend: BackendPort;
  readonly #picker: FilePickerPort;
  readonly #onFolderChanged: TransfersDeps['onFolderChanged'];
  readonly #onLocalChanged: TransfersDeps['onLocalChanged'];
  readonly #reported = new Set<number>();
  readonly #list = new TransferList();
  readonly #summary = $derived(summarizeTransfers(this.#list.all));
  readonly #visible = $derived(filterTransfers(this.#list.all, this.filter));
  readonly #rows = $derived(transferRowSlots(this.#visible));
  #unsubscribe: (() => void) | null = null;

  constructor(deps: TransfersDeps) {
    this.#backend = deps.backend;
    this.#picker = deps.picker;
    this.#onFolderChanged = deps.onFolderChanged;
    this.#onLocalChanged = deps.onLocalChanged;
  }

  /** Abonniert die Meldungen des Backends und lädt den aktuellen Stand. */
  async start(): Promise<void> {
    this.#unsubscribe = await this.#backend.onTransfers((update) => this.#apply(update));
    this.transfers = await this.#backend.listTransfers();
  }

  /** Alle Transfers aufsteigend nach ID. */
  get transfers(): readonly TransferSnapshot[] {
    return this.#list.all;
  }

  /** Ersetzt den gesamten Stand. */
  set transfers(list: readonly TransferSnapshot[]) {
    this.#list.replace(list);
    this.#reportFinished(list);
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** Dateiauswahl öffnen und die gewählten Dateien in den Ordner hochladen (Strg+U). */
  async upload(target: FolderLocation): Promise<void> {
    const paths = await this.#picker.pickFiles();
    if (paths.length > 0) await this.uploadPaths(target, paths);
  }

  /** Zielordner wählen und die Auswahl dorthin herunterladen (Strg+D). */
  async download(selection: ObjectSelection): Promise<void> {
    await this.#run(async () => {
      const targetDir = await this.#picker.pickFolder();
      if (targetDir) await this.downloadTo(selection, targetDir);
    });
  }

  /** Auswahl ohne Rückfrage nach `targetDir` herunterladen („← lokal speichern“). */
  async downloadTo(selection: ObjectSelection, targetDir: string): Promise<void> {
    await this.#run(() => this.#backend.enqueueDownloads(selection.folder, selection.items, targetDir));
  }

  /**
   * Auswahl in den Ordner kopieren oder verschieben (Strg+V). Innerhalb einer Verbindung kopiert
   * der Dienst selbst, zwischen Verbindungen laufen die Daten über den Rechner.
   */
  async copy(source: ObjectSelection, target: FolderLocation, move: boolean): Promise<void> {
    await this.#run(() => this.#backend.enqueueCopies(source, target, move));
  }

  /** Dateien und Ordner hochladen, z. B. per Drag and Drop aus dem Explorer. */
  async uploadPaths(target: FolderLocation, paths: string[]): Promise<void> {
    await this.#run(() => this.#backend.enqueueUploads(target, paths));
  }

  pause = (id: number) => this.#run(() => this.#backend.pauseTransfer(id));
  resume = (id: number) => this.#run(() => this.#backend.resumeTransfer(id));
  cancel = (id: number) => this.#run(() => this.#backend.cancelTransfer(id));
  retry = (id: number) => this.#run(() => this.#backend.retryTransfer(id));
  pauseAll = () => this.#run(() => this.#backend.pauseAllTransfers());
  resumeAll = () => this.#run(() => this.#backend.resumeAllTransfers());
  removeFinished = () => this.#run(() => this.#backend.removeFinishedTransfers());

  toggle(): void {
    this.expanded = !this.expanded;
  }

  /**
   * Strg+J klappt die Queue auf und zu, Strg+U lädt in den offenen Ordner hoch,
   * Strg+D lädt die Auswahl herunter. Liefert true, wenn das Kürzel behandelt wurde.
   */
  handleShortcut(key: string, ctrl: boolean, context: TransferShortcutContext): boolean {
    if (!ctrl) return false;
    switch (key.toLowerCase()) {
      case 'j':
        this.toggle();
        return true;
      case 'u':
        return this.#start(context.uploadTarget, (target) => this.upload(target));
      case 'd':
        if (context.selection.count === 0) return false;
        void context.selection.resolve().then((selection) => (selection ? this.download(selection) : undefined));
        return true;
      default:
        return false;
    }
  }

  #start<T>(subject: T | null, action: (subject: T) => Promise<void>): boolean {
    if (subject === null) return false;
    void action(subject);
    return true;
  }

  /** Kurzinfo der Statusleiste: "2 aktiv · 5 wartend · 1 Fehler" */
  get summaryText(): string {
    const { active, waiting, failed } = this.counts;
    const parts = [
      active ? `${active} aktiv` : null,
      waiting ? `${waiting} wartend` : null,
      failed ? `${failed} Fehler` : null,
    ];
    return parts.filter(Boolean).join(' · ');
  }

  get counts(): Record<TransferFilter, number> {
    return this.#summary.counts;
  }

  get visible(): readonly TransferSnapshot[] {
    return this.#visible;
  }

  /** Zeilen der virtuellen Liste, siehe `transferRowSlots`. */
  get rows(): number[] {
    return this.#rows;
  }

  /** Gesamtfortschritt über alle nicht abgebrochenen Transfers (UI-SPEC §5). */
  get totals(): TransferTotals {
    return this.#summary.totals;
  }

  /** Erster laufender Transfer für die eingeklappte Leiste. */
  get current(): TransferSnapshot | undefined {
    return this.#summary.current;
  }

  /** Platz in der Warteschlange (ab 1) für "Wartend · Platz n"; 0, wenn nicht wartend. */
  waitingPosition(id: number): number {
    return this.#summary.waitingPositions.get(id) ?? 0;
  }

  get canPauseAll(): boolean {
    const { active, waiting } = this.#summary.byState;
    return active + waiting > 0;
  }

  get canResumeAll(): boolean {
    return this.#summary.byState.paused > 0;
  }

  get canRemoveFinished(): boolean {
    const { done, skipped, cancelled } = this.#summary.byState;
    return done + skipped + cancelled > 0;
  }

  #apply(update: TransferUpdate): void {
    this.#list.apply(update);
    this.#reportFinished(update.changed);
  }

  /** Meldet die geänderten Ordner jedes fertigen Transfers genau einmal. */
  #reportFinished(transfers: readonly TransferSnapshot[]): void {
    for (const transfer of transfers) {
      if (transfer.state === 'done' && !this.#reported.has(transfer.id)) {
        this.#reported.add(transfer.id);
        for (const folder of changedFolders(transfer)) this.#onFolderChanged?.(folder);
        if (transfer.direction === 'download') this.#onLocalChanged?.(localFolder(transfer.localPath));
      }
    }
  }

  async #run(action: () => Promise<unknown>): Promise<void> {
    try {
      this.error = null;
      await action();
    } catch (error) {
      this.error = toBackendError(error);
    }
  }
}
