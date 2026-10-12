import { describe, expect, it } from 'vitest';
import { isInsideLocal, localCrumbs, localFolder, localName, localParent } from './localPath';

describe('Lokale Pfade unter Windows', () => {
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

describe('Lokale Pfade unter Linux', () => {
  it('nennt Ordner und Namen', () => {
    expect(localFolder('/home/anna/film.mkv')).toBe('/home/anna');
    expect(localName('/home/anna/bericht.pdf')).toBe('bericht.pdf');
  });

  it('findet Elternordner bis zur Wurzel', () => {
    expect(localParent('/home/anna/fotos')).toBe('/home/anna');
    expect(localParent('/home/anna/')).toBe('/home');
    expect(localParent('/home')).toBe('/');
    expect(localParent('/')).toBeNull();
  });

  it('baut die Pfadleiste ab der Wurzel', () => {
    expect(localCrumbs('/home/anna')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'anna', path: '/home/anna' },
    ]);
    expect(localCrumbs('/')).toEqual([{ label: '/', path: '/' }]);
  });

  it('unterscheidet Groß- und Kleinschreibung', () => {
    expect(isInsideLocal('/home/anna/neu', '/home/anna')).toBe(true);
    expect(isInsideLocal('/home/anna', '/home/anna/')).toBe(true);
    expect(isInsideLocal('/home/Anna/neu', '/home/anna')).toBe(false);
    expect(isInsideLocal('/home/anna2', '/home/anna')).toBe(false);
  });
});
