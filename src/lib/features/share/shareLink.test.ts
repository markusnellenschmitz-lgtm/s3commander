import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareLink } from './shareLink.svelte';
import { ShareDialogViewModel } from './shareDialogViewModel.svelte';
import { DEFAULT_SHARE_SECS, SHARE_DURATIONS, shareUntilText } from './shareRules';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import type { BackendPort } from '../../core/backend';
import { BACKUPS_PREFIX } from '../../infrastructure/fixtures/buckets';

const at = {
  profileId: 'aws-prod',
  bucket: 'prod-backups-eu',
  key: `${BACKUPS_PREFIX}daily/db-incr-20261011-0600.tar.zst`,
};
const NAME = 'db-incr-20261011-0600.tar.zst';
const NOW = new Date(2026, 9, 11, 15, 23, 8).getTime();

let backend: BackendPort;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
});

describe('shareRules', () => {
  it('bietet höchstens sieben Tage an und nennt das Ablaufdatum', () => {
    expect(SHARE_DURATIONS.at(-1)?.secs).toBe(7 * 24 * 60 * 60);
    expect(DEFAULT_SHARE_SECS).toBe(24 * 60 * 60);
    expect(shareUntilText(NOW, 24 * 60 * 60)).toBe('bis 12.10.2026 15:23:08');
  });
});

describe('ShareLink', () => {
  it('erzeugt den Link mit der gewählten Gültigkeit, kopiert ihn und gibt ihn an Windows', async () => {
    const link = new ShareLink({ backend, writeText, now: () => NOW });
    await link.setDuration(60);
    expect(link.url).toBeNull();
    await link.load(at);
    expect(link.url).toContain('X-Amz-Expires=60');
    expect(link.untilText).toBe('bis 11.10.2026 15:24:08');
    await link.copy();
    expect(writeText).toHaveBeenCalledWith(link.url);
    const shareLink = vi.spyOn(backend, 'shareLink');
    expect(await link.share(NAME)).toBe(true);
    expect(shareLink).toHaveBeenCalledWith(NAME, link.url);
  });

  it('meldet Fehler beim Erzeugen und Teilen und teilt ohne Link nichts', async () => {
    const link = new ShareLink({ backend, writeText });
    expect(await link.share('x')).toBe(false);
    await link.copy();
    expect(writeText).not.toHaveBeenCalled();
    vi.spyOn(backend, 'presignObject').mockRejectedValueOnce({ kind: 'service', message: 'Zugriff verweigert' });
    await link.load(at);
    expect([link.url, link.error?.message]).toEqual([null, 'Zugriff verweigert']);
    await link.load(at);
    expect(link.error).toBeNull();
    vi.spyOn(backend, 'shareLink').mockRejectedValueOnce({ kind: 'share', message: 'kein Dialog' });
    expect(await link.share('x')).toBe(false);
    expect(link.error?.message).toBe('kein Dialog');
    expect(link.untilText).toMatch(/^bis /);
  });

  it('verwirft verspätete Links nach einem Wechsel oder Leeren', async () => {
    const link = new ShareLink({ backend, writeText });
    let finish: (url: string) => void = () => {};
    vi.spyOn(backend, 'presignObject').mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const slow = link.load(at);
    link.clear();
    finish('https://alt');
    await slow;
    expect(link.url).toBeNull();

    let fail: (error: unknown) => void = () => {};
    vi.spyOn(backend, 'presignObject').mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const failing = link.load(at);
    await link.setDuration(3600);
    fail({ kind: 'network', message: 'weg' });
    await failing;
    expect([link.url?.includes('X-Amz-Expires=3600'), link.error]).toEqual([true, null]);
  });
});

describe('ShareDialogViewModel', () => {
  it('öffnet mit dem Dateinamen, teilt und schließt danach', async () => {
    const vm = new ShareDialogViewModel({ backend, writeText });
    vm.open(at);
    expect([vm.isOpen, vm.name]).toEqual([true, NAME]);
    await vi.waitFor(() => expect(vm.link.url).not.toBeNull());
    const shareLink = vi.spyOn(backend, 'shareLink');
    await vm.share();
    expect(shareLink).toHaveBeenCalledWith(NAME, expect.stringContaining('X-Amz-Expires=86400'));
    expect([vm.isOpen, vm.link.url]).toEqual([false, null]);
  });

  it('bleibt bei einem Fehler offen', async () => {
    const vm = new ShareDialogViewModel({ backend, writeText });
    vm.open(at);
    await vi.waitFor(() => expect(vm.link.url).not.toBeNull());
    vi.spyOn(backend, 'shareLink').mockRejectedValueOnce({ kind: 'share', message: 'kein Dialog' });
    await vm.share();
    expect([vm.isOpen, vm.link.error?.message]).toEqual([true, 'kein Dialog']);
  });
});
