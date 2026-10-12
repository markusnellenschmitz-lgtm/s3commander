import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsViewModel } from './settingsViewModel.svelte';
import { ThemeViewModel, type KeyValueStore } from './themeViewModel.svelte';
import { ViewPreferences, type ViewPrefs } from './viewPreferences.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import type { BackendPort } from '../../core/backend';

function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => values.set(key, value) };
}

let backend: BackendPort;
let theme: ThemeViewModel;
let view: ViewPreferences;
let onSaved: ReturnType<typeof vi.fn<(view: ViewPrefs) => void>>;
let vm: SettingsViewModel;

beforeEach(() => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  theme = new ThemeViewModel(memoryStore(), { prefersDark: () => true, subscribe: () => () => {} });
  view = new ViewPreferences(memoryStore());
  onSaved = vi.fn<(view: ViewPrefs) => void>();
  vm = new SettingsViewModel({ backend, theme, view, onSaved });
});

describe('SettingsViewModel', () => {
  it('nennt den Speicher für Zugangsdaten der Plattform', () => {
    expect(vm.credentialStore).toBe('Windows-Anmeldeinformationsspeicher');
    const linux = new SettingsViewModel({ backend: createFakeBackend({ platform: 'linux' }), theme, view, onSaved });
    expect(linux.credentialStore).toBe('Schlüsselbund des Systems');
  });

  it('öffnet mit dem gespeicherten Stand und zählt Änderungen je Kategorie', async () => {
    await vm.open();
    expect([vm.isOpen, vm.category, vm.totalChanges, vm.canSave]).toEqual([true, 'transfers', 0, false]);
    vm.draft.transfers.maxTransfers = 4;
    vm.draft.transfers.conflict = 'skip';
    vm.draft.compact = true;
    expect(vm.changesIn('transfers')).toBe(2);
    expect(vm.changesIn('appearance')).toBe(1);
    expect(vm.changesText).toBe('3 Änderungen');
    vm.draft.compact = false;
    expect(vm.changesText).toBe('2 Änderungen in Transfers');
    vm.draft.transfers.conflict = 'rename';
    expect(vm.changesText).toBe('1 Änderung in Transfers');
    await vm.open('general');
    expect(vm.category).toBe('transfers');
  });

  it('speichert Transfers im Backend und Ansichtswerte lokal', async () => {
    const save = vi.spyOn(backend, 'saveSettings');
    await vm.open('appearance');
    vm.draft.theme = 'light';
    vm.toggleColumn('etag', false);
    vm.draft.autoConnect = false;
    await vm.save();
    expect(save).not.toHaveBeenCalled();
    expect(theme.preference).toBe('light');
    expect(view.value).toEqual({ autoConnect: false, compact: false, hiddenColumns: ['etag'] });
    expect(onSaved).toHaveBeenCalledWith(view.value);
    expect(vm.isOpen).toBe(false);

    await vm.open();
    vm.setLimitEnabled(true);
    expect(vm.limitEnabled).toBe(true);
    expect(vm.draft.transfers.uploadLimitMibps).toBe(50);
    await vm.save();
    expect(save).toHaveBeenCalledWith({
      transfers: expect.objectContaining({ uploadLimitMibps: 50 }),
      cache: { enabled: true },
    });
    expect((await backend.getSettings()).transfers.uploadLimitMibps).toBe(50);
  });

  it('verhindert Speichern mit ungültigen Werten und zeigt Fehler des Backends', async () => {
    await vm.open();
    vm.draft.transfers.partSizeMib = 2;
    expect(vm.errors.partSizeMib).toBeDefined();
    expect(vm.canSave).toBe(false);
    await vm.save();
    vm.draft.transfers.partSizeMib = 32;
    vi.spyOn(backend, 'saveSettings').mockRejectedValueOnce({ kind: 'repository', message: 'Datei gesperrt' });
    await vm.save();
    expect(vm.error?.message).toBe('Datei gesperrt');
    expect(vm.isOpen).toBe(true);
  });

  it('zeigt den Umfang des Listing-Caches, leert ihn und speichert den Schalter', async () => {
    const save = vi.spyOn(backend, 'saveSettings');
    await backend.listFolder('aws-prod', 'prod-backups-eu', '', 'l', () => {});
    await vm.open('cache');
    expect(vm.cacheStats?.folders).toBe(1);
    await vm.clearCache();
    expect(vm.cacheStats?.folders).toBe(0);
    vm.draft.cacheEnabled = false;
    expect(vm.changesText).toBe('1 Änderung in Cache');
    vm.resetCategory();
    expect(vm.draft.cacheEnabled).toBe(true);
    vm.draft.cacheEnabled = false;
    await vm.save();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cache: { enabled: false } }));
    expect((await backend.getSettings()).cache.enabled).toBe(false);
  });

  it('meldet Fehler beim Leeren des Caches und leert nicht doppelt', async () => {
    await vm.open('cache');
    const clear = vi.spyOn(backend, 'clearListingCache').mockRejectedValueOnce({ kind: 'cache', message: 'gesperrt' });
    const first = vm.clearCache();
    void vm.clearCache();
    await first;
    expect(clear).toHaveBeenCalledOnce();
    expect(vm.error?.message).toBe('gesperrt');
    expect(vm.clearingCache).toBe(false);
  });

  it('setzt die gewählte Kategorie auf Standardwerte zurück', async () => {
    await vm.open();
    vm.draft.transfers.retries = 7;
    vm.draft.compact = true;
    vm.draft.autoConnect = false;
    vm.resetCategory();
    expect(vm.draft.transfers.retries).toBe(3);
    expect(vm.draft.compact).toBe(true);
    vm.category = 'appearance';
    vm.resetCategory();
    expect(vm.draft.compact).toBe(false);
    vm.category = 'general';
    vm.resetCategory();
    expect(vm.draft.autoConnect).toBe(true);
    vm.toggleColumn('size', false);
    vm.toggleColumn('size', true);
    expect(vm.draft.hiddenColumns).toEqual([]);
  });

  it('sucht Einstellungen und springt zur passenden Kategorie', async () => {
    await vm.open();
    vm.setSearch('theme');
    expect(vm.visibleCategories).toEqual(['appearance']);
    expect(vm.category).toBe('appearance');
    vm.setSearch('gibt es nicht');
    expect(vm.visibleCategories).toEqual([]);
    expect(vm.category).toBe('appearance');
    vm.setSearch('');
    expect(vm.visibleCategories).toHaveLength(6);
  });

  it('öffnet mit Strg+Komma, meldet Ladefehler und schließt nicht beim Speichern', async () => {
    expect(vm.handleShortcut(',', false)).toBe(false);
    vi.spyOn(backend, 'getSettings').mockRejectedValueOnce({ kind: 'repository', message: 'kaputt' });
    expect(vm.handleShortcut(',', true)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(vm.error?.message).toBe('kaputt');
    vm.saving = true;
    vm.close();
    expect(vm.isOpen).toBe(true);
    vm.saving = false;
    vm.close();
    expect(vm.isOpen).toBe(false);
  });
});
