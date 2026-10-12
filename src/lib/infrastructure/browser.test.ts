import { describe, expect, it, vi } from 'vitest';
import {
  createClipboardWriter,
  createDocumentThemeTarget,
  createLocalStorageStore,
  createMediaColorScheme,
  DARK_SCHEME_QUERY,
} from './browser';

describe('createClipboardWriter', () => {
  it('schreibt Text in die Zwischenablage', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await createClipboardWriter({ writeText })('s3://b/k');
    expect(writeText).toHaveBeenCalledWith('s3://b/k');
    expect(typeof createClipboardWriter).toBe('function');
  });
});

describe('createLocalStorageStore', () => {
  it('liest und schreibt über localStorage', () => {
    const store = createLocalStorageStore();
    store.set('s3client.test', 'wert');
    expect(store.get('s3client.test')).toBe('wert');
    expect(window.localStorage.getItem('s3client.test')).toBe('wert');
  });

  it('übersteht einen gesperrten Speicher', () => {
    const store = createLocalStorageStore(() => {
      throw new Error('gesperrt');
    });
    expect(store.get('x')).toBeNull();
    expect(() => store.set('x', 'y')).not.toThrow();
  });
});

describe('createMediaColorScheme', () => {
  it('fragt das Farbschema ab und meldet Änderungen bis zur Abmeldung', () => {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const query = {
      matches: true,
      addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
      removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
    } as unknown as MediaQueryList;
    const matchMedia = vi.fn(() => query);

    const scheme = createMediaColorScheme(matchMedia);
    expect(matchMedia).toHaveBeenCalledWith(DARK_SCHEME_QUERY);
    expect(scheme.prefersDark()).toBe(true);

    const seen: boolean[] = [];
    const unsubscribe = scheme.subscribe((d) => seen.push(d));
    listeners.forEach((l) => l({ matches: false } as MediaQueryListEvent));
    unsubscribe();
    expect(seen).toEqual([false]);
    expect(listeners.size).toBe(0);
  });

  it('nutzt standardmäßig window.matchMedia', () => {
    expect(createMediaColorScheme().prefersDark()).toBe(false);
  });
});

describe('createDocumentThemeTarget', () => {
  it('setzt data-theme am Wurzelelement', () => {
    createDocumentThemeTarget().apply('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    const el = document.createElement('div');
    createDocumentThemeTarget(el).apply('dark');
    expect(el.dataset.theme).toBe('dark');
  });
});
