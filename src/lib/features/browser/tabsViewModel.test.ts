import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserViewModel } from './browserViewModel.svelte';
import { NEW_TAB_LABEL, TabsViewModel } from './tabsViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import { BACKUPS_PREFIX } from '../../infrastructure/fixtures/buckets';

let browser: BrowserViewModel;
let tabs: TabsViewModel;

beforeEach(async () => {
  browser = new BrowserViewModel({ backend: createFakeBackend({ pageDelayMs: 0 }), schedule: (run) => run() });
  tabs = new TabsViewModel(browser);
  await browser.loadProfiles();
});

const labels = () => tabs.tabs.map((t) => `${t.label}${t.active ? '*' : ''}`);

describe('TabsViewModel', () => {
  it('zeigt ohne offenen Bucket keine Tabs und danach den offenen Bucket als ersten', () => {
    expect(tabs.tabs).toEqual([]);
    expect(tabs.canCreate).toBe(false);
    tabs.newTab();
    expect(tabs.tabs).toEqual([]);
    browser.openBucket('aws-prod', 'prod-backups-eu');
    expect(tabs.tabs).toEqual([
      {
        id: 0,
        label: 'prod-backups-eu',
        title: 'AWS Produktion · prod-backups-eu/',
        status: 'connected',
        active: true,
      },
    ]);
  });

  it('öffnet neue Tabs mit dem offenen Ordner und merkt sich Ordner, Verlauf und Sortierung', () => {
    browser.openBucket('aws-prod', 'prod-backups-eu');
    browser.openPrefix(BACKUPS_PREFIX);
    tabs.newTab();
    expect(labels()).toEqual(['prod-backups-eu', 'prod-backups-eu*']);
    expect(browser.location?.prefix).toBe(BACKUPS_PREFIX);
    expect(browser.canGoBack).toBe(false);
    browser.openBucket('aws-prod', 'prod-logs-eu');
    browser.changeSort({ column: 'size', dir: -1 });
    expect(labels()).toEqual(['prod-backups-eu', 'prod-logs-eu*']);

    tabs.select(tabs.tabs[0].id);
    expect(browser.location).toEqual({ profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX });
    expect(browser.canGoBack).toBe(true);
    expect(browser.sort).toEqual({ column: 'name', dir: 1 });
    tabs.select(tabs.tabs[1].id);
    expect(browser.location?.bucket).toBe('prod-logs-eu');
    expect(browser.sort).toEqual({ column: 'size', dir: -1 });
    tabs.select(tabs.tabs[1].id);
    tabs.select(999);
    expect(browser.location?.bucket).toBe('prod-logs-eu');
  });

  it('öffnet Buckets aus dem Baum in einem neuen Tab, ohne offenen Bucket im aktuellen', () => {
    tabs.openInNewTab('aws-prod', 'prod-logs-eu');
    expect(labels()).toEqual(['prod-logs-eu*']);
    tabs.openInNewTab('aws-prod', 'prod-backups-eu');
    expect(labels()).toEqual(['prod-logs-eu', 'prod-backups-eu*']);
    expect(browser.location?.prefix).toBe('');
  });

  it('schließt Tabs, aktiviert den Nachbarn und leert ohne Tabs den Browser', () => {
    browser.openBucket('aws-prod', 'prod-backups-eu');
    tabs.openInNewTab('aws-prod', 'prod-logs-eu');
    tabs.openInNewTab('aws-prod', 'prod-exports-eu');
    tabs.select(tabs.tabs[1].id);
    tabs.close();
    expect(labels()).toEqual(['prod-backups-eu', 'prod-exports-eu*']);
    tabs.close(tabs.tabs[0].id);
    expect(labels()).toEqual(['prod-exports-eu*']);
    tabs.close(12345);
    tabs.close();
    expect(tabs.tabs).toEqual([]);
    expect(browser.location).toBeNull();
  });

  it('springt mit Strg+Tab im Kreis und reagiert auf die Kürzel', () => {
    expect(tabs.handleShortcut('w', true, false)).toBe(false);
    browser.openBucket('aws-prod', 'prod-backups-eu');
    tabs.cycle(1);
    expect(tabs.handleShortcut('t', false, false)).toBe(false);
    expect(tabs.handleShortcut('T', true, false)).toBe(true);
    tabs.openInNewTab('aws-prod', 'prod-logs-eu');
    expect(labels()).toEqual(['prod-backups-eu', 'prod-backups-eu', 'prod-logs-eu*']);
    expect(tabs.handleShortcut('Tab', true, false)).toBe(true);
    expect(labels()[0]).toBe('prod-backups-eu*');
    expect(tabs.handleShortcut('Tab', true, true)).toBe(true);
    expect(labels()[2]).toBe('prod-logs-eu*');
    expect(tabs.handleShortcut('w', true, false)).toBe(true);
    expect(tabs.tabs).toHaveLength(2);
    expect(tabs.handleShortcut('x', true, false)).toBe(false);
  });

  it('schließt beim Trennen die inaktiven Tabs der Verbindung, der aktive wird leer', () => {
    browser.openBucket('aws-prod', 'prod-backups-eu');
    tabs.openInNewTab('aws-prod', 'prod-logs-eu');
    browser.disconnect('aws-prod');
    expect(tabs.tabs).toEqual([
      { id: tabs.tabs[0].id, label: NEW_TAB_LABEL, title: NEW_TAB_LABEL, status: 'disconnected', active: true },
    ]);
  });

  it('zeigt Verbindungen ohne Profil mit ihrer ID und als getrennt', () => {
    browser.openBucket('unbekannt', 'eimer');
    expect(tabs.tabs[0]).toMatchObject({ title: 'unbekannt · eimer/', status: 'disconnected' });
  });
});
