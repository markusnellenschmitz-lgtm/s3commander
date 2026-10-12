import { describe, expect, it } from 'vitest';
import { deleteSummary, deleteTitle, outcomeText, progressPercent, progressText, versionNote } from './deleteText';
import type { DeletePreview, ObjectSelection } from '../../core/backend';

const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: 'backups/' };
const item = (key: string, isFolder = false) => ({ key, isFolder, size: 0, etag: null });
const selection = (...keys: string[]): ObjectSelection => ({
  folder,
  items: keys.map((k) => item(k, k.endsWith('/'))),
});
const preview = (overrides: Partial<DeletePreview> = {}): DeletePreview => ({
  planId: 'delete-1',
  objects: 4210,
  bytes: 38.6 * 1024 ** 3,
  versioned: false,
  ...overrides,
});

describe('Texte des Löschdialogs', () => {
  it('nennt im Titel den Namen oder die Anzahl', () => {
    expect(deleteTitle(selection('backups/daily/'))).toBe('„daily/“ löschen?');
    expect(deleteTitle(selection('backups/a.bin'))).toBe('„a.bin“ löschen?');
    expect(deleteTitle(selection('backups/a', 'backups/b', 'backups/c/'))).toBe('3 Einträge löschen?');
  });

  it('nennt Ziel und Menge und sagt nur ohne Versionierung „endgültig“', () => {
    expect(deleteSummary(preview(), selection('backups/a'))).toBe(
      '4.210 Objekte (38,6 GiB) in prod-backups-eu/backups/ werden endgültig gelöscht.',
    );
    expect(deleteSummary(preview({ objects: 1, bytes: 10, versioned: true }), selection('backups/a'))).toBe(
      '1 Objekt (10 B) in prod-backups-eu/backups/ wird gelöscht.',
    );
    expect(deleteSummary(preview({ objects: 0 }), selection('backups/leer/'))).toBe(
      'Hier gibt es keine Objekte zu löschen.',
    );
  });

  it('weist auf ältere Versionen hin', () => {
    expect(versionNote(preview({ versioned: true }))).toContain('Ältere Versionen bleiben erhalten');
    expect(versionNote(preview({ versioned: null }))).toContain('ließ sich nicht prüfen');
    expect(versionNote(preview())).toBeNull();
  });

  it('beschreibt Fortschritt und Ergebnis', () => {
    expect(progressText({ processed: 1000, total: 4210 })).toBe('1.000 von 4.210 gelöscht');
    expect(progressPercent({ processed: 1000, total: 4000 })).toBe(25);
    expect(progressPercent({ processed: 0, total: 0 })).toBe(100);
    const outcome = { deleted: 3900, failedCount: 310, failures: [], cancelled: false };
    expect(outcomeText(outcome)).toBe('3.900 Objekte gelöscht, 310 nicht gelöscht.');
    expect(outcomeText({ ...outcome, failedCount: 0, cancelled: true })).toBe('Abgebrochen. 3.900 Objekte gelöscht.');
  });
});
