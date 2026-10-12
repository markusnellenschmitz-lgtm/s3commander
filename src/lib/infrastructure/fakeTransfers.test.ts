import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransferEngine, fakeFileSize, fakeLocalPath, FAKE_UPLOAD_ERROR } from './fakeTransfers';
import { createFakeFilePicker, createTauriFilePicker, FAKE_PICKED_FILES, FAKE_TARGET_FOLDER } from './filePickers';
import type { TransferUpdate } from '../core/backend';

const target = { profileId: 'p', bucket: 'b', prefix: 'ordner/' };
const MiB = 1024 ** 2;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function engine(onFinished = vi.fn()) {
  const e = new FakeTransferEngine({ tickMs: 100, bytesPerSec: 1000 * MiB, maxActive: 1, onFinished });
  const seen: TransferUpdate[] = [];
  e.subscribe((update) => seen.push(update));
  return { e, seen, onFinished };
}

const states = (e: FakeTransferEngine) => e.list().map((t) => t.state);

describe('FakeTransferEngine', () => {
  it('reiht ein, startet nach Parallelität und meldet jede Änderung', () => {
    const { e, seen } = engine();
    const ids = e.enqueue(target, ['C:\\x\\a.bin', 'C:\\x\\b.bin']);
    expect(ids).toEqual([1, 2]);
    expect(states(e)).toEqual(['active', 'waiting']);
    const [first] = e.list();
    expect(first.key).toBe('ordner/a.bin');
    expect(first.name).toBe('a.bin');
    expect(seen).toHaveLength(1);
    expect(seen[0].changed.map((t) => t.id)).toEqual([1, 2]);
  });

  it('meldet nur Geändertes und entfernte Transfers', () => {
    const { e, seen } = engine();
    e.enqueue(target, ['C:\\x\\a.bin', 'C:\\x\\b.bin', 'C:\\x\\c.bin']);
    e.pause(3);
    expect(seen.at(-1)?.changed.map((t) => [t.id, t.state])).toEqual([[3, 'paused']]);
    e.pause(99);
    expect(seen).toHaveLength(2);
    e.cancel(2);
    e.cancel(3);
    e.removeFinished();
    expect(seen.at(-1)).toEqual({ changed: [], removed: [2, 3] });
  });

  it('lädt fertig hoch, meldet den Upload und startet den nächsten', () => {
    const { e, onFinished } = engine();
    e.enqueue(target, ['C:\\x\\a.bin', 'C:\\x\\b.bin']);
    vi.advanceTimersByTime(2000);
    expect(states(e)).toEqual(['done', 'done']);
    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'b', key: 'ordner/a.bin', totalBytes: fakeFileSize('C:\\x\\a.bin') }),
    );
    expect(e.list()[0].finishedMs).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(states(e)).toEqual(['done', 'done']);
  });

  it('lässt Fehler-Dateien einmal scheitern und beim neuen Versuch gelingen', () => {
    const { e } = engine();
    const [id] = e.enqueue(target, ['C:\\fehler-test.log']);
    vi.advanceTimersByTime(500);
    expect(e.list()[0]).toMatchObject({ state: 'failed', error: FAKE_UPLOAD_ERROR });
    e.retry(id);
    expect(e.list()[0].error).toBeNull();
    vi.advanceTimersByTime(500);
    expect(states(e)).toEqual(['done']);
  });

  it('pausiert, setzt fort, bricht ab und entfernt Fertige', () => {
    const { e } = engine();
    const [a, b, c] = e.enqueue(target, ['C:\\a', 'C:\\b', 'C:\\c']);
    e.pause(a);
    expect(states(e)).toEqual(['paused', 'active', 'waiting']);
    e.cancel(c);
    e.resume(a);
    expect(states(e)).toEqual(['waiting', 'active', 'cancelled']);
    e.pause(999);
    vi.advanceTimersByTime(5000);
    expect(states(e)).toEqual(['done', 'done', 'cancelled']);
    e.removeFinished();
    expect(e.list()).toEqual([]);
    e.cancel(b);
  });

  it('pausiert und setzt die ganze Warteschlange fort', () => {
    const { e } = engine();
    e.enqueue(target, ['C:\\a', 'C:\\b']);
    e.pauseAll();
    expect(states(e)).toEqual(['paused', 'paused']);
    e.enqueue(target, ['C:\\c']);
    expect(states(e)).toEqual(['paused', 'paused', 'waiting']);
    e.resumeAll();
    expect(states(e)[0]).toBe('active');
  });

  it('meldet sich ab und nutzt Standardwerte', () => {
    const e = new FakeTransferEngine();
    const listener = vi.fn();
    const unsubscribe = e.subscribe(listener);
    unsubscribe();
    e.enqueue(target, ['C:\\a']);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(states(e)).toEqual(['done']);
  });

  it('erzeugt stabile Größen, kleine für Fehler-Dateien', () => {
    expect(fakeFileSize('C:\\a.bin')).toBe(fakeFileSize('C:\\a.bin'));
    expect(fakeFileSize('C:\\a.bin')).toBeGreaterThanOrEqual(64 * MiB);
    expect(fakeFileSize('C:\\fehler.log')).toBe(8 * MiB);
  });
});

describe('Dateiauswahl', () => {
  it('liefert im Browser feste Beispieldateien', async () => {
    expect(await createFakeFilePicker().pickFiles()).toEqual(FAKE_PICKED_FILES);
  });

  it('übersetzt das Ergebnis des Windows-Dialogs', async () => {
    const open = vi.fn();
    const picker = createTauriFilePicker(open as never);
    open.mockResolvedValueOnce(null).mockResolvedValueOnce('C:\\eins.txt').mockResolvedValueOnce(['C:\\a', 'C:\\b']);
    expect(await picker.pickFiles()).toEqual([]);
    expect(await picker.pickFiles()).toEqual(['C:\\eins.txt']);
    expect(await picker.pickFiles()).toEqual(['C:\\a', 'C:\\b']);
    expect(open).toHaveBeenCalledWith({ multiple: true, directory: false, title: 'Dateien hochladen' });
  });

  it('wählt Zielordner im Windows-Dialog und im Browser', async () => {
    const open = vi.fn().mockResolvedValueOnce('D:\\Ziel').mockResolvedValueOnce(null);
    const picker = createTauriFilePicker(open as never);
    expect(await picker.pickFolder()).toBe('D:\\Ziel');
    expect(await picker.pickFolder()).toBeNull();
    expect(open).toHaveBeenCalledWith({ multiple: false, directory: true, title: 'Zielordner wählen' });
    expect(await createFakeFilePicker().pickFolder()).toBe(FAKE_TARGET_FOLDER);
    expect(await createFakeFilePicker([], null).pickFolder()).toBeNull();
  });
});

describe('Downloads', () => {
  it('bildet lokale Pfade unterhalb des Zielordners', () => {
    expect(fakeLocalPath('D:\\Ziel\\', 'backups/', 'backups/daily/a.tar')).toBe('D:\\Ziel\\daily\\a.tar');
    expect(fakeLocalPath('D:\\Ziel', 'anders/', 'x.txt')).toBe('D:\\Ziel\\x.txt');
  });

  it('lädt herunter und meldet fertige Downloads', () => {
    const onFinished = vi.fn();
    const e = new FakeTransferEngine({ tickMs: 100, bytesPerSec: 1000 * MiB, onFinished });
    const folder = { profileId: 'p', bucket: 'b', prefix: 'x/' };
    const [id] = e.enqueueDownloads(folder, [
      { key: 'x/a.bin', size: 128 * MiB, localPath: 'D:\\a.bin' },
      { key: 'x/leer.txt', size: 0, localPath: 'D:\\leer.txt' },
    ]);
    expect(e.list()[0]).toMatchObject({
      id,
      direction: 'download',
      name: 'a.bin',
      partCount: 8,
      localPath: 'D:\\a.bin',
    });
    vi.advanceTimersByTime(1000);
    expect(e.list().map((t) => t.state)).toEqual(['done', 'done']);
    expect(onFinished).toHaveBeenCalledTimes(2);
    expect(onFinished.mock.calls[0][0]).toMatchObject({ direction: 'download', copySource: null });
  });

  it('kopiert auf dem Server mit Quelle', () => {
    const e = new FakeTransferEngine({ tickMs: 100, bytesPerSec: 1000 * MiB });
    const source = { bucket: 'q', key: 'a/x.bin' };
    e.enqueueCopies('p', [{ source, bucket: 'z', key: 'b/x.bin', size: 10 }]);
    expect(e.list()[0]).toMatchObject({ direction: 'copy', name: 'x.bin', localPath: '', copySource: source });
  });
});
