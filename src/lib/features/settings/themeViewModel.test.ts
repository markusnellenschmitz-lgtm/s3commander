import { describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY, ThemeViewModel, type ColorSchemeSource, type KeyValueStore } from './themeViewModel.svelte';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
}

function fakeScheme(dark: boolean): ColorSchemeSource & { emit(dark: boolean): void; unsubscribe: () => void } {
  let listener: ((dark: boolean) => void) | null = null;
  const unsubscribe = vi.fn();
  return {
    prefersDark: () => dark,
    subscribe(l) {
      listener = l;
      return unsubscribe;
    },
    emit: (d) => listener?.(d),
    unsubscribe,
  };
}

describe('ThemeViewModel', () => {
  it('folgt ohne Einstellung dem System', () => {
    const scheme = fakeScheme(false);
    const vm = new ThemeViewModel(memoryStore(), scheme);
    expect(vm.preference).toBe('system');
    expect(vm.resolved).toBe('light');
    scheme.emit(true);
    expect(vm.resolved).toBe('dark');
  });

  it('übernimmt eine gespeicherte Einstellung', () => {
    const vm = new ThemeViewModel(memoryStore({ [THEME_STORAGE_KEY]: 'light' }), fakeScheme(true));
    expect(vm.resolved).toBe('light');
  });

  it('ignoriert ungültige gespeicherte Werte', () => {
    const vm = new ThemeViewModel(memoryStore({ [THEME_STORAGE_KEY]: 'pink' }), fakeScheme(true));
    expect(vm.preference).toBe('system');
  });

  it('speichert die Auswahl und überschreibt das System', () => {
    const store = memoryStore();
    const vm = new ThemeViewModel(store, fakeScheme(true));
    vm.select('light');
    expect(vm.resolved).toBe('light');
    expect(store.data[THEME_STORAGE_KEY]).toBe('light');
  });

  it('meldet sich beim Entsorgen ab', () => {
    const scheme = fakeScheme(true);
    new ThemeViewModel(memoryStore(), scheme).dispose();
    expect(scheme.unsubscribe).toHaveBeenCalledOnce();
  });
});
