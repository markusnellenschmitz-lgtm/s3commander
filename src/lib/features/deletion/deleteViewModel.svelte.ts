// View-Model des Löschdialogs: Vorschau ermitteln, bestätigen, mit Fortschritt löschen,
// Ergebnis zeigen. Gelöscht werden genau die Keys der bestätigten Vorschau.

import type {
  BackendError,
  BackendPort,
  DeleteOutcome,
  DeletePreview,
  DeleteProgress,
  FolderLocation,
  ObjectSelection,
} from '../../core/backend';
import { toBackendError, type SelectionRequest } from '../../core/backend';

/** closed → preparing → confirm → deleting → (closed | result); Fehler führen zu result. */
export type DeletePhase = 'closed' | 'preparing' | 'confirm' | 'deleting' | 'result';

export const DELETE_KEY = 'Delete';

export interface DeleteDeps {
  backend: BackendPort;
  /** Im Ordner wurde gelöscht; das Hauptfenster lädt ihn neu. */
  onDeleted?: (folder: FolderLocation) => void;
}

export class DeleteViewModel {
  phase = $state<DeletePhase>('closed');
  selection = $state<ObjectSelection | null>(null);
  preview = $state<DeletePreview | null>(null);
  progress = $state<DeleteProgress | null>(null);
  outcome = $state<DeleteOutcome | null>(null);
  error = $state<BackendError | null>(null);

  readonly #backend: BackendPort;
  readonly #onDeleted: DeleteDeps['onDeleted'];
  /** Erhöht sich bei jedem Öffnen und Schließen; verspätete Vorschauen werden verworfen. */
  #session = 0;

  constructor(deps: DeleteDeps) {
    this.#backend = deps.backend;
    this.#onDeleted = deps.onDeleted;
  }

  get isOpen(): boolean {
    return this.phase !== 'closed';
  }

  get canConfirm(): boolean {
    return this.phase === 'confirm' && (this.preview?.objects ?? 0) > 0;
  }

  /** Öffnet den Dialog und ermittelt, was gelöscht würde. */
  async open(selection: ObjectSelection): Promise<void> {
    if (this.isOpen) return;
    const session = this.#start(selection);
    try {
      const preview = await this.#backend.prepareDelete(selection.folder, selection.items);
      if (session !== this.#session) {
        void this.#backend.discardDelete(preview.planId);
        return;
      }
      this.preview = preview;
      this.phase = 'confirm';
    } catch (error) {
      if (session === this.#session) this.#fail(error);
    }
  }

  /** Löscht nach der Bestätigung; schließt bei Erfolg, sonst bleibt das Ergebnis stehen. */
  async confirm(): Promise<void> {
    const { preview, selection } = this;
    if (!this.canConfirm || !preview || !selection) return;
    this.phase = 'deleting';
    this.progress = { processed: 0, total: preview.objects };
    try {
      const outcome = await this.#backend.deleteObjects(preview.planId, (progress) => (this.progress = progress));
      this.outcome = outcome;
      if (outcome.failedCount === 0 && !outcome.cancelled) this.#close();
      else this.phase = 'result';
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#onDeleted?.(selection.folder);
    }
  }

  /** Abbrechen: vor dem Löschen schließen, während des Löschens anhalten. */
  cancel(): void {
    if (this.phase === 'deleting') {
      if (this.preview) void this.#backend.cancelDelete(this.preview.planId);
      return;
    }
    if (this.phase === 'confirm' && this.preview) void this.#backend.discardDelete(this.preview.planId);
    this.#close();
  }

  /** Entf öffnet den Dialog für die Auswahl; liefert true, wenn das Kürzel behandelt wurde. */
  handleShortcut(key: string, request: SelectionRequest): boolean {
    if (key !== DELETE_KEY || this.isOpen || request.count === 0) return false;
    void request.resolve().then((selection) => (selection ? this.open(selection) : undefined));
    return true;
  }

  #start(selection: ObjectSelection): number {
    this.selection = selection;
    this.preview = null;
    this.progress = null;
    this.outcome = null;
    this.error = null;
    this.phase = 'preparing';
    return ++this.#session;
  }

  #fail(error: unknown): void {
    this.error = toBackendError(error);
    this.phase = 'result';
  }

  #close(): void {
    this.#session++;
    this.phase = 'closed';
    this.selection = null;
  }
}
