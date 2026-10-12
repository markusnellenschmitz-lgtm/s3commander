import { describe, expect, it } from 'vitest';
import {
  changedFolders,
  DIRECTION_ICONS,
  errorClipboardText,
  percent,
  progressClass,
  restSeconds,
  routeText,
  stateText,
} from './transferText';
import { transfer } from '../../../test/transfers';

describe('Kennzahlen', () => {
  it('berechnet Prozent, auch für fertige und leere Transfers', () => {
    expect(percent(transfer())).toBe(65);
    expect(percent(transfer({ state: 'done', doneBytes: 0 }))).toBe(100);
    expect(percent(transfer({ totalBytes: 0, doneBytes: 0 }))).toBe(0);
  });

  it('berechnet die Restzeit aus dem Tempo', () => {
    expect(restSeconds(transfer())).toBe(52);
    expect(restSeconds(transfer({ bytesPerSec: 0 }))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('Texte', () => {
  it('nennt Zielordner und Route', () => {
    expect(routeText(transfer())).toBe('→ prod-backups-eu/backups/2026/10/');
  });

  it('nennt geänderte Ordner: Ziel, bei Kopien auch die Quelle', () => {
    const upload = transfer();
    expect(changedFolders(upload)).toEqual([
      { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: 'backups/2026/10/' },
    ]);
    expect(changedFolders(transfer({ direction: 'download' }))).toEqual([]);
    const copy = transfer({ direction: 'copy', key: 'neu/a.bin', copySource: { bucket: 'alt-b', key: 'alt/a.bin' } });
    expect(changedFolders(copy)).toEqual([
      { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: 'neu/' },
      { profileId: 'aws-prod', bucket: 'alt-b', prefix: 'alt/' },
    ]);
    expect(routeText(copy)).toBe('alt-b/alt/ → prod-backups-eu/neu/');
    const relayed = { ...copy, profileId: 'hetzner-fsn1', sourceProfileId: 'aws-prod' };
    expect(changedFolders(relayed).map((f) => f.profileId)).toEqual(['hetzner-fsn1', 'aws-prod']);
    const marker = transfer({ direction: 'copy', key: 'neu (2)/', copySource: { bucket: 'b', key: 'neu/' } });
    expect(changedFolders(marker).map((f) => f.prefix)).toEqual(['', '']);
  });

  it('nennt bei Downloads Quelle und lokalen Zielordner', () => {
    const download = transfer({ direction: 'download', localPath: 'D:\\Exporte\\db.tar.zst' });
    expect(routeText(download)).toBe('← prod-backups-eu/backups/2026/10/ nach D:\\Exporte');
    expect(stateText({ ...download, partCount: 1 }, 0)).toBe('Lädt herunter');
    expect(DIRECTION_ICONS.download).toEqual({ icon: 'arrow-down', label: 'Download' });
  });

  it.each([
    [transfer(), 'Teil 101 / 152'],
    [transfer({ partsDone: 152 }), 'Teil 152 / 152'],
    [transfer({ partCount: 1 }), 'Lädt hoch'],
    [transfer({ state: 'waiting' }), 'Wartend · Platz 3'],
    [transfer({ state: 'paused' }), 'Pausiert'],
    [transfer({ state: 'done', finishedMs: new Date(2026, 9, 11, 15, 9).getTime() }), 'Fertig · 15:09'],
    [transfer({ state: 'done' }), 'Fertig'],
    [transfer({ state: 'skipped' }), 'Übersprungen · Datei vorhanden'],
    [transfer({ state: 'failed' }), 'Fehlgeschlagen'],
    [transfer({ state: 'cancelled' }), 'Abgebrochen'],
  ])('%#: %s', (t, expected) => {
    expect(stateText(t, 3)).toBe(expected);
  });

  it('wählt die Balkenfarbe je Zustand', () => {
    expect(progressClass('active')).toBe('');
    expect(progressClass('failed')).toBe('s3-progress-error');
    expect(progressClass('done')).toBe('s3-progress-success');
    expect(progressClass('paused')).toBe('s3-progress-warning');
  });

  it('baut den Text für die Zwischenablage mit S3-Details', () => {
    const service = { code: 'RequestTimeout', message: 'zu langsam', httpStatus: 400, requestId: 'R1' };
    expect(errorClipboardText({ kind: 'service', message: 'RequestTimeout: zu langsam', service })).toBe(
      'RequestTimeout: zu langsam · RequestTimeout · HTTP 400 · Request-ID R1',
    );
    expect(errorClipboardText({ kind: 'network', message: 'weg' })).toBe('weg');
  });
});
