// Theme: Start folgt Windows (prefers-color-scheme), überschreibbar.
// Browser-Zugriffe laufen über Ports, damit das View-Model ohne DOM testbar ist.

export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 's3client.theme';
const PREFERENCES: readonly ThemePreference[] = ['system', 'dark', 'light'];

/** Port: dauerhafte Ablage einfacher Werte. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Port: Farbschema des Betriebssystems. */
export interface ColorSchemeSource {
  prefersDark(): boolean;
  /** Meldet Änderungen, gibt eine Abmeldefunktion zurück. */
  subscribe(listener: (prefersDark: boolean) => void): () => void;
}

/** Port: Anwendung des Themes auf die Oberfläche. */
export interface ThemeTarget {
  apply(theme: ResolvedTheme): void;
}

function isPreference(value: string | null): value is ThemePreference {
  return value !== null && (PREFERENCES as readonly string[]).includes(value);
}

export class ThemeViewModel {
  preference = $state<ThemePreference>('system');
  #systemDark = $state(true);
  readonly resolved = $derived<ResolvedTheme>(
    this.preference === 'system' ? (this.#systemDark ? 'dark' : 'light') : this.preference,
  );

  readonly #store: KeyValueStore;
  readonly #unsubscribe: () => void;

  constructor(store: KeyValueStore, scheme: ColorSchemeSource) {
    this.#store = store;
    const stored = store.get(THEME_STORAGE_KEY);
    if (isPreference(stored)) this.preference = stored;
    this.#systemDark = scheme.prefersDark();
    this.#unsubscribe = scheme.subscribe((dark) => (this.#systemDark = dark));
  }

  select(preference: ThemePreference): void {
    this.preference = preference;
    this.#store.set(THEME_STORAGE_KEY, preference);
  }

  dispose(): void {
    this.#unsubscribe();
  }
}
