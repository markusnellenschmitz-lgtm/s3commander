// Tabs je Bucket (Screen 2): Jeder Tab merkt sich Ordner, Verlauf und Sortierung. Der aktive Tab
// lebt im Browser; inaktive halten ihre Ansicht hier. Solange es keine Tabs gibt, ist der offene
// Bucket automatisch der erste Tab.

import type { BrowserView, BrowserViewModel, ConnectionStatus, Location } from './browserViewModel.svelte';

/** Ein Tab; `view` ist null beim aktiven Tab, dessen Zustand im Browser liegt. */
interface TabEntry {
  id: number;
  view: BrowserView | null;
}

/** Was die Tab-Leiste zeigt. */
export interface TabInfo {
  id: number;
  label: string;
  /** Vollständiger Pfad für den Tooltip. */
  title: string;
  status: ConnectionStatus;
  active: boolean;
}

export const NEW_TAB_LABEL = 'Neuer Tab';

export class TabsViewModel {
  #entries = $state<TabEntry[]>([]);
  #activeId = $state(0);
  #nextId = 1;
  readonly #browser: BrowserViewModel;

  constructor(browser: BrowserViewModel) {
    this.#browser = browser;
    browser.onForget((profileId) => this.#closeProfile(profileId));
  }

  get tabs(): TabInfo[] {
    return this.#visibleEntries().map((entry) => {
      const active = entry.id === this.#activeId || entry.view === null;
      const location = active ? this.#browser.location : (entry.view?.location ?? null);
      return { id: entry.id, ...this.#describe(location), active };
    });
  }

  /** Ein neuer Tab übernimmt den offenen Ordner; ohne Ordner gibt es nichts zu öffnen. */
  get canCreate(): boolean {
    return this.#browser.location !== null;
  }

  /** Strg+T: neuer Tab mit dem offenen Ordner. */
  newTab(): void {
    const view = this.#browser.captureView();
    if (!view.location) return;
    this.#open({ ...view, back: [], forward: [] });
  }

  /** „In neuem Tab öffnen“ im Verbindungsbaum. */
  openInNewTab(profileId: string, bucket: string): void {
    const location: Location = { profileId, bucket, prefix: '' };
    if (!this.#browser.location) {
      this.#browser.openBucket(profileId, bucket);
      return;
    }
    this.#open({ location, back: [], forward: [], sort: this.#browser.sort });
  }

  select(id: number): void {
    this.#materialize();
    const target = this.#entries.find((e) => e.id === id);
    if (!target || id === this.#activeId) return;
    this.#store();
    this.#activate(target);
  }

  /** Strg+W oder Schließen-x; der Nachbar rechts (sonst links) wird aktiv. */
  close(id: number = this.#activeId): void {
    this.#materialize();
    const index = this.#entries.findIndex((e) => e.id === id);
    if (index < 0) return;
    if (id === this.#activeId) {
      const neighbour = this.#entries[index + 1] ?? this.#entries[index - 1];
      if (neighbour) this.#activate(neighbour);
      else this.#browser.restoreView({ location: null, back: [], forward: [], sort: this.#browser.sort });
    }
    this.#entries = this.#entries.filter((e) => e.id !== id);
  }

  /** Strg+Tab bzw. Strg+Umschalt+Tab: zum nächsten bzw. vorigen Tab, im Kreis. */
  cycle(step: 1 | -1): void {
    this.#materialize();
    const count = this.#entries.length;
    if (count < 2) return;
    const index = this.#entries.findIndex((e) => e.id === this.#activeId);
    this.select(this.#entries[(index + step + count) % count].id);
  }

  /** Strg+T, Strg+W und Strg+(Umschalt+)Tab; liefert true, wenn das Kürzel behandelt wurde. */
  handleShortcut(key: string, ctrl: boolean, shift: boolean): boolean {
    if (!ctrl) return false;
    switch (key.toLowerCase()) {
      case 't':
        this.newTab();
        return true;
      case 'w':
        if (this.tabs.length === 0) return false;
        this.close();
        return true;
      case 'tab':
        this.cycle(shift ? -1 : 1);
        return true;
      default:
        return false;
    }
  }

  // ---------- intern ----------

  /** Ohne Tabs zeigt die Leiste den offenen Bucket als einzigen Tab. */
  #visibleEntries(): TabEntry[] {
    if (this.#entries.length > 0) return this.#entries;
    return this.#browser.location ? [{ id: 0, view: null }] : [];
  }

  /** Macht den angezeigten Ersatz-Tab zu einem echten, bevor Tabs verändert werden. */
  #materialize(): void {
    if (this.#entries.length > 0 || !this.#browser.location) return;
    this.#entries = [{ id: this.#nextId, view: null }];
    this.#activeId = this.#nextId++;
  }

  /** Merkt sich die Ansicht des aktiven Tabs. */
  #store(): void {
    const active = this.#entries.find((e) => e.id === this.#activeId);
    if (active) active.view = this.#browser.captureView();
  }

  #activate(entry: TabEntry): void {
    const view = entry.view;
    entry.view = null;
    this.#activeId = entry.id;
    if (view) this.#browser.restoreView(view);
  }

  #open(view: BrowserView): void {
    this.#materialize();
    this.#store();
    const entry: TabEntry = { id: this.#nextId++, view };
    this.#entries = [...this.#entries, entry];
    this.#activate(this.#entries[this.#entries.length - 1]);
  }

  /** Eine Verbindung wurde getrennt oder gelöscht: ihre inaktiven Tabs schließen, der aktive bleibt leer. */
  #closeProfile(profileId: string): void {
    this.#entries = this.#entries.filter((e) => e.id === this.#activeId || e.view?.location?.profileId !== profileId);
  }

  #describe(location: Location | null): Pick<TabInfo, 'label' | 'title' | 'status'> {
    if (!location) return { label: NEW_TAB_LABEL, title: NEW_TAB_LABEL, status: 'disconnected' };
    const connection = this.#browser.connections.find((c) => c.profile.id === location.profileId);
    return {
      label: location.bucket,
      title: `${connection?.profile.name ?? location.profileId} · ${location.bucket}/${location.prefix}`,
      status: connection?.status ?? 'disconnected',
    };
  }
}
