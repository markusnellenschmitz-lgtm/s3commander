import { describe, expect, it } from 'vitest';
import { isInsideLocal, localCrumbs, localFolder, localName, localParent } from './localPath';

describe('Lokale Pfade', () => {
  it('nennt den Ordner einer Datei für Anzeigen', () => {
    expect(localFolder('C:/a/b.txt')).toBe('C:/a');
    expect(localFolder('D:\\Ziel\\film.mkv')).toBe('D:\\Ziel');
    expect(localFolder('b.txt')).toBe('b.txt');
  });

  it('findet Elternordner bis zum Laufwerk', () => {
    expect(localParent('D:\\Backups\\db-prod')).toBe('D:\\Backups');
    expect(localParent('D:\\Backups')).toBe('D:\\');
    expect(localParent('D:\\Backups\\')).toBe('D:\\');
    expect(localParent('D:\\')).toBeNull();
    expect(localName('D:\\Backups\\db-prod')).toBe('db-prod');
  });

  it('baut die Pfadleiste', () => {
    expect(localCrumbs('D:\\Backups\\db-prod')).toEqual([
      { label: 'D:', path: 'D:\\' },
      { label: 'Backups', path: 'D:\\Backups' },
      { label: 'db-prod', path: 'D:\\Backups\\db-prod' },
    ]);
    expect(localCrumbs('D:\\')).toEqual([{ label: 'D:', path: 'D:\\' }]);
    expect(localCrumbs('')).toEqual([]);
  });

  it('erkennt Pfade innerhalb eines Ordners ohne Rücksicht auf Groß- und Kleinschreibung', () => {
    expect(isInsideLocal('D:\\Backups\\neu', 'd:\\backups')).toBe(true);
    expect(isInsideLocal('D:\\Backups', 'D:\\Backups\\')).toBe(true);
    expect(isInsideLocal('D:\\Backups2', 'D:\\Backups')).toBe(false);
  });
});
