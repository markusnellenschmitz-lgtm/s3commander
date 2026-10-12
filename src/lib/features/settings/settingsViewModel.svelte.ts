// View-Model des Einstellungsdialogs (Screen 7): bearbeitet einen Entwurf, zählt Änderungen je
// Kategorie und speichert Transfer-Werte im Backend, Ansichtswerte lokal.

import type { BackendError, BackendPort, CacheStats, TransferPreferences } from '../../core/backend';
import { toBackendError } from '../../core/backend';
import { countText } from '../../core/format';
import { credentialStoreName } from '../../core/platform';
import type { EntryColumn } from '../objects/entry';
import { DEFAULT_TRANSFER_PREFERENCES, transferErrors } from './settingsRules';
import type { ThemePreference, ThemeViewModel } from './themeViewModel.svelte';
import { DEFAULT_VIEW, type ViewPreferences, type ViewPrefs } from './viewPreferences.svelte';

export type SettingsCategory = 'general' | 'transfers' | 'cache' | 'appearance' | 'security' | 'about';

export const SETTINGS_KEY = ',';

export const CATEGORIES: readonly { id: SettingsCategory; label: string }[] = [
  { id: 'general', label: 'Allgemein' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'cache', label: 'Cache' },
  { id: 'appearance', label: 'Darstellung' },
  { id: 'security', label: 'Sicherheit' },
  { id: 'about', label: 'Über' },
];

/** Suchbare Zeilen je Kategorie (Titel und Stichwörter). */
export const SETTING_ROWS: readonly { category: SettingsCategory; title: string; keywords: string }[] = [
  { category: 'general', title: 'Beim Start verbinden', keywords: 'automatisch verbindungen start' },
  { category: 'transfers', title: 'Parallelität', keywords: 'gleichzeitig transfers teile parallel' },
  { category: 'transfers', title: 'Teilgröße', keywords: 'chunk multipart teile größe schwelle' },
  { category: 'transfers', title: 'Bandbreitenlimit', keywords: 'upload download geschwindigkeit begrenzen mib/s' },
  {
    category: 'transfers',
    title: 'Verhalten bei Konflikten',
    keywords: 'überschreiben überspringen umbenennen vorhanden',
  },
  { category: 'transfers', title: 'Prüfung', keywords: 'prüfsumme crc32c md5 fehler wiederholen retry' },
  { category: 'cache', title: 'Listing-Cache', keywords: 'zwischenspeichern ordner sqlite offline schneller' },
  { category: 'cache', title: 'Cache leeren', keywords: 'löschen speicherplatz größe' },
  { category: 'appearance', title: 'Theme', keywords: 'dunkel hell system farbe' },
  { category: 'appearance', title: 'Dichte', keywords: 'zeilenhöhe kompakt' },
  { category: 'appearance', title: 'Sichtbare Spalten', keywords: 'spalten größe geändert storage class etag' },
  { category: 'security', title: 'Zugangsdaten', keywords: 'anmeldeinformationen passwort schlüssel speicher' },
  { category: 'security', title: 'Zertifikate', keywords: 'tls ca zertifikat proxy' },
  { category: 'about', title: 'Version', keywords: 'über lizenz version' },
];

/** Alles, was der Dialog bearbeitet. */
export interface SettingsDraft {
  autoConnect: boolean;
  transfers: TransferPreferences;
  cacheEnabled: boolean;
  theme: ThemePreference;
  compact: boolean;
  hiddenColumns: EntryColumn[];
}

/** Welche Felder des Entwurfs zu welcher Kategorie gehören. */
const FIELDS: Record<SettingsCategory, (draft: SettingsDraft) => unknown[]> = {
  general: (d) => [d.autoConnect],
  transfers: (d) => Object.values(d.transfers),
  cache: (d) => [d.cacheEnabled],
  appearance: (d) => [d.theme, d.compact, [...d.hiddenColumns].sort().join(',')],
  security: () => [],
  about: () => [],
};

export interface SettingsDeps {
  backend: BackendPort;
  theme: ThemeViewModel;
  view: ViewPreferences;
  /** Nach dem Speichern: Ansichtswerte auf das Hauptfenster anwenden. */
  onSaved?: (view: ViewPrefs) => void;
}

export class SettingsViewModel {
  isOpen = $state(false);
  category = $state<SettingsCategory>('transfers');
  search = $state('');
  draft = $state<SettingsDraft>(defaults());
  saved = $state<SettingsDraft>(defaults());
  loading = $state(false);
  saving = $state(false);
  error = $state<BackendError | null>(null);
  /** Umfang des Listing-Caches; null, solange unbekannt. */
  cacheStats = $state<CacheStats | null>(null);
  clearingCache = $state(false);

  readonly #deps: SettingsDeps;

  constructor(deps: SettingsDeps) {
    this.#deps = deps;
  }

  /** Öffnet den Dialog mit dem aktuellen Stand aus Backend und lokalen Einstellungen. */
  async open(category: SettingsCategory = 'transfers'): Promise<void> {
    if (this.isOpen) return;
    this.category = category;
    this.search = '';
    this.error = null;
    this.isOpen = true;
    this.loading = true;
    try {
      const settings = await this.#deps.backend.getSettings();
      const view = this.#deps.view.value;
      this.saved = {
        autoConnect: view.autoConnect,
        transfers: { ...settings.transfers },
        cacheEnabled: settings.cache.enabled,
        theme: this.#deps.theme.preference,
        compact: view.compact,
        hiddenColumns: [...view.hiddenColumns],
      };
      this.draft = structuredClone($state.snapshot(this.saved));
      this.cacheStats = await this.#deps.backend.cacheStats();
    } catch (error) {
      this.error = toBackendError(error);
    } finally {
      this.loading = false;
    }
  }

  /** „Cache leeren“: löscht alle gespeicherten Listings sofort, unabhängig vom Speichern. */
  async clearCache(): Promise<void> {
    if (this.clearingCache) return;
    this.clearingCache = true;
    this.error = null;
    try {
      await this.#deps.backend.clearListingCache();
      this.cacheStats = await this.#deps.backend.cacheStats();
    } catch (error) {
      this.error = toBackendError(error);
    } finally {
      this.clearingCache = false;
    }
  }

  close(): void {
    if (!this.saving) this.isOpen = false;
  }

  /** Strg+, öffnet den Dialog; liefert true, wenn das Kürzel behandelt wurde. */
  handleShortcut(key: string, ctrl: boolean): boolean {
    if (!ctrl || key !== SETTINGS_KEY) return false;
    void this.open();
    return true;
  }

  changesIn(category: SettingsCategory): number {
    const draft = FIELDS[category](this.draft);
    const saved = FIELDS[category](this.saved);
    return draft.filter((value, i) => value !== saved[i]).length;
  }

  /** Wo die Zugangsdaten liegen, z. B. „Schlüsselbund des Systems“. */
  get credentialStore(): string {
    return credentialStoreName(this.#deps.backend.platform);
  }

  get totalChanges(): number {
    return CATEGORIES.reduce((sum, c) => sum + this.changesIn(c.id), 0);
  }

  /** "2 Änderungen in Transfers" oder "3 Änderungen" über mehrere Kategorien. */
  get changesText(): string {
    const total = this.totalChanges;
    if (total === 0) return '';
    const changed = CATEGORIES.filter((c) => this.changesIn(c.id) > 0);
    const count = countText(total, 'Änderung', 'Änderungen');
    return changed.length === 1 ? `${count} in ${changed[0].label}` : count;
  }

  get errors(): Partial<Record<keyof TransferPreferences, string>> {
    return transferErrors(this.draft.transfers);
  }

  get canSave(): boolean {
    return this.totalChanges > 0 && Object.keys(this.errors).length === 0 && !this.saving && !this.loading;
  }

  /** „Standardwerte“: setzt die Felder der gewählten Kategorie zurück. */
  resetCategory(): void {
    const fresh = defaults();
    if (this.category === 'general') this.draft.autoConnect = fresh.autoConnect;
    if (this.category === 'transfers') this.draft.transfers = fresh.transfers;
    if (this.category === 'cache') this.draft.cacheEnabled = fresh.cacheEnabled;
    if (this.category === 'appearance') {
      this.draft.theme = fresh.theme;
      this.draft.compact = fresh.compact;
      this.draft.hiddenColumns = fresh.hiddenColumns;
    }
  }

  toggleColumn(column: EntryColumn, visible: boolean): void {
    const hidden = this.draft.hiddenColumns.filter((c) => c !== column);
    this.draft.hiddenColumns = visible ? hidden : [...hidden, column];
  }

  /** Bandbreitenlimit an oder aus; beim Einschalten 50 MiB/s für Uploads wie im Entwurf. */
  setLimitEnabled(enabled: boolean): void {
    this.draft.transfers.uploadLimitMibps = enabled ? DEFAULT_UPLOAD_LIMIT_MIBPS : 0;
    this.draft.transfers.downloadLimitMibps = 0;
  }

  get limitEnabled(): boolean {
    return this.draft.transfers.uploadLimitMibps > 0 || this.draft.transfers.downloadLimitMibps > 0;
  }

  /** Kategorien, die zur Suche passen; ohne Suche alle. */
  get visibleCategories(): SettingsCategory[] {
    const term = this.search.trim().toLowerCase();
    if (term === '') return CATEGORIES.map((c) => c.id);
    return CATEGORIES.filter((c) =>
      SETTING_ROWS.some((r) => r.category === c.id && `${r.title} ${r.keywords}`.toLowerCase().includes(term)),
    ).map((c) => c.id);
  }

  /** Suchbegriff setzen und zur ersten passenden Kategorie springen. */
  setSearch(search: string): void {
    this.search = search;
    const visible = this.visibleCategories;
    if (visible.length > 0 && !visible.includes(this.category)) this.category = visible[0];
  }

  async save(): Promise<void> {
    if (!this.canSave) return;
    this.saving = true;
    this.error = null;
    try {
      if (this.changesIn('transfers') + this.changesIn('cache') > 0) {
        const saved = await this.#deps.backend.saveSettings({
          transfers: { ...this.draft.transfers },
          cache: { enabled: this.draft.cacheEnabled },
        });
        this.draft.transfers = { ...saved.transfers };
        this.draft.cacheEnabled = saved.cache.enabled;
      }
      if (this.draft.theme !== this.saved.theme) this.#deps.theme.select(this.draft.theme);
      const view: ViewPrefs = {
        autoConnect: this.draft.autoConnect,
        compact: this.draft.compact,
        hiddenColumns: [...this.draft.hiddenColumns],
      };
      this.#deps.view.update(view);
      this.#deps.onSaved?.(view);
      this.saved = structuredClone($state.snapshot(this.draft));
      this.isOpen = false;
    } catch (error) {
      this.error = toBackendError(error);
    } finally {
      this.saving = false;
    }
  }
}

const DEFAULT_UPLOAD_LIMIT_MIBPS = 50;

function defaults(): SettingsDraft {
  return {
    autoConnect: DEFAULT_VIEW.autoConnect,
    transfers: { ...DEFAULT_TRANSFER_PREFERENCES },
    cacheEnabled: true,
    theme: 'system',
    compact: DEFAULT_VIEW.compact,
    hiddenColumns: [],
  };
}
