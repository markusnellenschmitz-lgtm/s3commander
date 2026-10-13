// View-Model des Namensdialogs: „Neuer Ordner“ und „Umbenennen“ (F2).
// Umbenennen kopiert auf dem Server und löscht danach die Originale; bei Ordnern mit Fortschritt.

import type {
  BackendError,
  BackendPort,
  FolderLocation,
  ObjectSelection,
  RenameProgress,
  SelectedItem,
} from '../../core/backend';
import { toBackendError, type SelectionRequest } from '../../core/backend';
import { formatCount } from '../../core/format';
import { baseName, nameError, parentOfKey } from '../../core/objectName';

export type NameDialogMode = 'createFolder' | 'rename';
/** closed → editing → working → (closed | warning); Fehler führen zurück zu editing. */
export type NameDialogPhase = 'closed' | 'editing' | 'working' | 'warning';

export const RENAME_KEY = 'F2';

export interface NameDialogDeps {
  backend: BackendPort;
  /** Im Ordner hat sich etwas geändert; das Hauptfenster lädt ihn neu. */
  onChanged?: (folder: FolderLocation) => void;
}

export class NameDialogViewModel {
  phase = $state<NameDialogPhase>('closed');
  mode = $state<NameDialogMode>('createFolder');
  folder = $state<FolderLocation | null>(null);
  item = $state<SelectedItem | null>(null);
  name = $state('');
  /** Fehlertexte erscheinen erst nach der ersten Eingabe oder einem Versuch. */
  touched = $state(false);
  error = $state<BackendError | null>(null);
  progress = $state<RenameProgress | null>(null);
  warning = $state<string | null>(null);

  readonly #backend: BackendPort;
  readonly #onChanged: NameDialogDeps['onChanged'];

  constructor(deps: NameDialogDeps) {
    this.#backend = deps.backend;
    this.#onChanged = deps.onChanged;
  }

  get isOpen(): boolean {
    return this.phase !== 'closed';
  }

  openCreateFolder(folder: FolderLocation): void {
    this.#open('createFolder', folder, null, '');
  }

  /** Umbenennen geht nur für genau einen Eintrag. */
  openRename(selection: ObjectSelection): void {
    if (selection.items.length !== 1) return;
    const [item] = selection.items;
    this.#open('rename', selection.folder, item, baseName(item.key));
  }

  /** F2 öffnet „Umbenennen“ für die Auswahl; liefert true, wenn das Kürzel behandelt wurde. */
  handleShortcut(key: string, request: SelectionRequest): boolean {
    if (key !== RENAME_KEY || this.isOpen || request.count !== 1) return false;
    void request.resolve().then((selection) => {
      if (selection) this.openRename(selection);
    });
    return true;
  }

  get title(): string {
    return this.mode === 'createFolder' ? 'Neuer Ordner' : `„${baseName(this.item?.key ?? '')}“ umbenennen`;
  }

  get submitLabel(): string {
    return this.mode === 'createFolder' ? 'Anlegen' : 'Umbenennen';
  }

  /** "in prod-backups-eu/backups/" */
  get locationText(): string {
    return this.folder ? `in ${this.folder.bucket}/${this.#parent}` : '';
  }

  /** Fehler der Eingabe oder des Backends, sobald er angezeigt werden soll. */
  get fieldError(): string | null {
    const invalid = this.touched ? this.#validation : null;
    return invalid ?? this.error?.message ?? null;
  }

  get canSubmit(): boolean {
    return this.phase === 'editing' && this.#validation === null;
  }

  get progressText(): string {
    return this.progress ? `${formatCount(this.progress.copied)} von ${formatCount(this.progress.total)} kopiert` : '';
  }

  /** Jede Eingabe macht Fehler sichtbar und verwirft den letzten Backend-Fehler. */
  input(value: string): void {
    this.name = value;
    this.touched = true;
    this.error = null;
  }

  async submit(): Promise<void> {
    this.touched = true;
    const { folder } = this;
    if (!this.canSubmit || !folder) return;
    this.phase = 'working';
    try {
      const undeleted = await this.#perform(folder, this.name.trim());
      this.#onChanged?.(folder);
      if (undeleted > 0) {
        this.warning = `Kopiert, aber ${formatCount(undeleted)} Originale ließen sich nicht löschen.`;
        this.phase = 'warning';
      } else {
        this.phase = 'closed';
      }
    } catch (error) {
      this.error = toBackendError(error);
      this.phase = 'editing';
    }
  }

  /** Schließt; während der Arbeit nicht, weil Kopieren und Löschen nicht halb enden sollen. */
  close(): void {
    if (this.phase === 'working') return;
    this.phase = 'closed';
  }

  get #parent(): string {
    return this.item ? parentOfKey(this.item.key) : (this.folder?.prefix ?? '');
  }

  get #validation(): string | null {
    const isFolder = this.mode === 'createFolder' || (this.item?.isFolder ?? false);
    return nameError(this.name.trim(), this.#parent, isFolder);
  }

  /** Führt die Aktion aus und liefert die Zahl nicht gelöschter Originale. */
  async #perform(folder: FolderLocation, name: string): Promise<number> {
    if (this.mode === 'createFolder' || !this.item) {
      await this.#backend.createFolder(folder, name);
      return 0;
    }
    const outcome = await this.#backend.renameObject(folder, this.item, name, (p) => (this.progress = p));
    return outcome.undeleted;
  }

  #open(mode: NameDialogMode, folder: FolderLocation, item: SelectedItem | null, name: string): void {
    if (this.isOpen) return;
    this.mode = mode;
    this.folder = folder;
    this.item = item;
    this.name = name;
    this.touched = false;
    this.error = null;
    this.progress = null;
    this.warning = null;
    this.phase = 'editing';
  }
}
