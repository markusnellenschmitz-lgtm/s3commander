// Browser-Adapter für die Ports aus features/settings/themeViewModel.
// Nur die Kompositionswurzel (App.svelte) importiert diese Datei.

import type {
  ColorSchemeSource,
  KeyValueStore,
  ResolvedTheme,
  ThemeTarget,
} from '../features/settings/themeViewModel.svelte';

/** localStorage kann in Vorschauen oder bei gesperrten Daten fehlen oder werfen. */
export function createLocalStorageStore(storage: () => Storage = () => window.localStorage): KeyValueStore {
  return {
    get(key) {
      try {
        return storage().getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        storage().setItem(key, value);
      } catch {
        /* Speicher nicht verfügbar: Einstellung gilt nur für diese Sitzung. */
      }
    },
  };
}

export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export function createMediaColorScheme(
  matchMedia: (query: string) => MediaQueryList = window.matchMedia.bind(window),
): ColorSchemeSource {
  const query = matchMedia(DARK_SCHEME_QUERY);
  return {
    prefersDark: () => query.matches,
    subscribe(listener) {
      const handler = (e: MediaQueryListEvent) => listener(e.matches);
      query.addEventListener('change', handler);
      return () => query.removeEventListener('change', handler);
    },
  };
}

/** Setzt data-theme am <html>, wie es tokens.css erwartet. */
/** Schreibt Text in die Zwischenablage von Windows (WebView2 erlaubt das ohne Rückfrage). */
export function createClipboardWriter(clipboard: Pick<Clipboard, 'writeText'> = navigator.clipboard) {
  return (text: string): Promise<void> => clipboard.writeText(text);
}

export function createDocumentThemeTarget(root: HTMLElement = document.documentElement): ThemeTarget {
  return {
    apply(theme: ResolvedTheme) {
      root.dataset.theme = theme;
    },
  };
}
