import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ConnectionDialogViewModel,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_SECS,
  FALLBACK_REGION,
} from './connectionDialogViewModel.svelte';
import { createFakeBackend, FAKE_PROFILES, SIGNATURE_ERROR } from '../../infrastructure/fakeBackend';
import type { BackendPort, ConnectionProfile } from '../../core/backend';

let backend: BackendPort;
let onSaved: Mock<(profile: ConnectionProfile) => void>;
let vm: ConnectionDialogViewModel;

beforeEach(async () => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  onSaved = vi.fn<(profile: ConnectionProfile) => void>();
  vm = new ConnectionDialogViewModel({ backend, newId: () => 'neu-1', onSaved });
  await vm.loadPresets();
});

function fillKeys() {
  vm.form.name = 'Hetzner Produktion';
  vm.form.accessKeyId = 'HZK7Q2M4XW9PL3RT8VN1';
  vm.form.secretAccessKey = 'geheim';
}

describe('Vorlagen', () => {
  it('öffnet mit der ersten Vorlage und füllt Endpoint, Region und Adressierung', () => {
    vm.openCreate();
    expect(vm.isOpen).toBe(true);
    expect(vm.mode).toBe('create');
    expect(vm.form.id).toBe('neu-1');
    expect(vm.form.provider).toBe('aws');
    expect(vm.form.endpoint).toBe('https://s3.eu-central-1.amazonaws.com');
    expect(vm.form.addressing).toBe('virtual-hosted');
  });

  it('folgt beim Regionswechsel der Vorlage, bis der Endpoint von Hand geändert wird', () => {
    vm.openCreate('hetzner');
    vm.setRegion('nbg1');
    expect(vm.form.endpoint).toBe('https://nbg1.your-objectstorage.com');
    expect(vm.endpointHelp).toBe('Aus der Vorlage Hetzner. Für andere Standorte die Region wechseln.');
    vm.setEndpoint('https://eigener.host');
    vm.setRegion('hel1');
    expect(vm.form.endpoint).toBe('https://eigener.host');
  });

  it('verlangt bei R2 die Konto-ID und baut daraus den Endpoint', () => {
    vm.openCreate('cloudflare-r2');
    expect(vm.needsAccount).toBe(true);
    expect(vm.errors.account).toBe('Konto-ID ist Pflicht');
    vm.setAccount('abc123');
    expect(vm.form.endpoint).toBe('https://abc123.r2.cloudflarestorage.com');
    expect(vm.endpointHelp).toBe('Aus der Vorlage Cloudflare R2.');
  });

  it('lässt den Endpoint bei selbst gehosteten Diensten leer', () => {
    vm.openCreate('minio');
    expect(vm.form.endpoint).toBe('');
    expect(vm.form.addressing).toBe('path-style');
    expect(vm.endpointHelp).toMatch(/eigenen Servers/);
  });

  it('übernimmt unbekannte Anbieter ohne Vorlage', () => {
    vm.openCreate();
    vm.selectPreset('garage');
    expect(vm.form.provider).toBe('garage');
    expect(vm.preset).toBeUndefined();
    expect(vm.endpointHelp).toMatch(/eigenen Servers/);
  });

  it('nimmt ohne geladene Vorlagen Benutzerdefiniert', () => {
    const empty = new ConnectionDialogViewModel({ backend, onSaved });
    empty.openCreate();
    expect(empty.form.provider).toBe('custom');
    expect(empty.form.id).toMatch(/[0-9a-f-]{36}/);
  });
});

describe('Endpoint-Erkennung', () => {
  it('setzt bei einer Hetzner-URL Vorlage, Region und Adressierung', () => {
    vm.openCreate('aws');
    vm.setEndpoint('https://fsn1.your-objectstorage.com');
    expect(vm.form.provider).toBe('hetzner');
    expect(vm.form.region).toBe('fsn1');
    expect(vm.form.addressing).toBe('virtual-hosted');
    expect(vm.regionSuggestions).toEqual(['fsn1', 'nbg1', 'hel1']);
    vm.setRegion('nbg1');
    expect(vm.form.endpoint).toBe('https://nbg1.your-objectstorage.com');
  });

  it('übernimmt die Konto-ID aus einer R2-URL', () => {
    vm.openCreate('custom');
    vm.setEndpoint('https://abc123.r2.cloudflarestorage.com');
    expect(vm.form.provider).toBe('cloudflare-r2');
    expect(vm.form.account).toBe('abc123');
  });

  it('meldet eine Region, die nicht zur Endpoint-URL passt', () => {
    vm.openEdit({ ...FAKE_PROFILES[0], endpoint: 'https://fsn1.your-objectstorage.com', region: 'eu-central-1' });
    expect(vm.errors.region).toBe('Region muss fsn1 sein (aus der Endpoint-URL)');
    vm.setRegion('FSN1');
    expect(vm.errors.region).toBeUndefined();
  });

  it('lässt eigene Server unverändert und bietet keine Vorschläge', () => {
    vm.openCreate('minio');
    vm.setEndpoint('http://localhost:9000');
    expect(vm.form.provider).toBe('minio');
    vm.selectPreset('garage');
    expect(vm.regionSuggestions).toEqual([]);
  });
});

describe('Optionale Region', () => {
  it('nimmt bei leerer Region die Region aus der Endpoint-URL', () => {
    vm.openCreate('hetzner');
    vm.setRegion('');
    expect(vm.form.endpoint).toBe('https://fsn1.your-objectstorage.com');
    expect(vm.effectiveRegion).toBe('fsn1');
    vm.setEndpoint('https://hel1.your-objectstorage.com');
    vm.setRegion('');
    expect(vm.effectiveRegion).toBe('hel1');
    expect(vm.errors.region).toBeUndefined();
  });

  it('fällt bei eigenen Servern auf den Standard der Vorlage, sonst auf us-east-1 zurück', () => {
    vm.openCreate('minio');
    vm.setRegion('');
    vm.setEndpoint('http://localhost:9000');
    expect(vm.effectiveRegion).toBe('us-east-1');
    vm.selectPreset('garage');
    vm.setRegion('');
    expect(vm.effectiveRegion).toBe(FALLBACK_REGION);
  });

  it('speichert die wirksame Region im Profil und bevorzugt eine Eingabe', () => {
    vm.openCreate('hetzner');
    vm.setRegion('');
    expect(vm.toProfile().region).toBe('fsn1');
    vm.openCreate('minio');
    vm.setEndpoint('http://minio.lan:9000');
    vm.setRegion('eu-west-2');
    expect(vm.toProfile().region).toBe('eu-west-2');
  });
});

describe('Prüfung', () => {
  it('meldet alle Pflichtfelder und gültige Bereiche', () => {
    vm.openCreate('minio');
    vm.form.region = '';
    vm.form.timeoutSecs = 0;
    vm.form.concurrency = 100;
    expect(vm.errors).toEqual({
      name: 'Profilname ist Pflicht',
      endpoint: 'Endpoint-URL mit http:// oder https://',
      timeoutSecs: '1 bis 600 Sekunden',
      concurrency: '1 bis 64',
      accessKeyId: 'Access Key ist Pflicht',
      secretAccessKey: 'Secret Key ist Pflicht',
    });
    expect(vm.isValid).toBe(false);
  });

  it('erlaubt beim Bearbeiten leere Schlüssel, verlangt aber beide, wenn einer gesetzt ist', () => {
    vm.openEdit(FAKE_PROFILES[0]);
    expect(vm.isValid).toBe(true);
    expect(vm.credentials()).toBeNull();
    vm.form.accessKeyId = 'neu';
    expect(vm.errors.secretAccessKey).toBe('Secret Key ist Pflicht');
  });

  it('zeigt Fehler erst nach Verlassen des Feldes oder einem Versuch', async () => {
    vm.openCreate('hetzner');
    expect(vm.visibleErrors).toEqual({});
    vm.touch('name');
    expect(vm.visibleErrors).toEqual({ name: 'Profilname ist Pflicht' });
    await vm.save();
    expect(Object.keys(vm.visibleErrors)).toEqual(['name', 'accessKeyId', 'secretAccessKey']);
    vm.openCreate('hetzner');
    expect(vm.visibleErrors).toEqual({});
  });

  it('zählt geänderte Werte unter Erweitert', () => {
    vm.openCreate('hetzner');
    expect(vm.changedAdvancedCount).toBe(0);
    vm.form.addressing = 'path-style';
    vm.form.timeoutSecs = 30;
    vm.form.concurrency = 4;
    vm.form.verifyTls = false;
    vm.form.caFile = 'C:\\ca.pem';
    vm.form.proxy = 'http://proxy:3128';
    expect(vm.changedAdvancedCount).toBe(6);
  });
});

describe('Profil und Zugangsdaten', () => {
  it('baut das Profil mit bereinigten Werten', () => {
    vm.openCreate('hetzner');
    fillKeys();
    vm.form.bucket = '  ';
    vm.form.proxy = ' http://proxy:3128 ';
    expect(vm.toProfile()).toEqual({
      id: 'neu-1',
      name: 'Hetzner Produktion',
      provider: 'hetzner',
      endpoint: 'https://fsn1.your-objectstorage.com',
      region: 'fsn1',
      defaultBucket: null,
      addressing: 'virtual-hosted',
      quirks: { urlEncodedListing: false, crc32cChecksums: false },
      timeoutSecs: DEFAULT_TIMEOUT_SECS,
      concurrency: DEFAULT_CONCURRENCY,
      verifyTls: true,
      caFile: null,
      proxy: 'http://proxy:3128',
    });
    expect(vm.credentials()).toEqual({ accessKeyId: 'HZK7Q2M4XW9PL3RT8VN1', secretAccessKey: 'geheim' });
  });

  it('nimmt ohne Vorlage vorsichtige Eigenheiten', () => {
    vm.openCreate();
    vm.selectPreset('garage');
    expect(vm.toProfile().quirks).toEqual({ urlEncodedListing: false, crc32cChecksums: false });
  });

  it('füllt beim Bearbeiten das Formular aus dem Profil', () => {
    vm.openEdit({ ...FAKE_PROFILES[0], defaultBucket: 'gtg-mods', caFile: 'ca.pem', proxy: 'http://p' });
    expect(vm.mode).toBe('edit');
    expect(vm.form).toMatchObject({
      id: 'aws-prod',
      name: 'AWS Produktion',
      bucket: 'gtg-mods',
      caFile: 'ca.pem',
      proxy: 'http://p',
    });
    expect(vm.form.secretAccessKey).toBe('');
  });
});

describe('Testen und Speichern', () => {
  it('testet die Verbindung und zeigt das Ergebnis', async () => {
    vm.openCreate('hetzner');
    fillKeys();
    const pending = vm.test();
    expect(vm.testState).toBe('testing');
    await pending;
    expect(vm.testState).toBe('ok');
    expect(vm.testResult).toEqual({ bucketCount: 5, latencyMs: 142 });
  });

  it('zeigt Fehler beim Test und setzt das Ergebnis bei Änderungen zurück', async () => {
    vm.openCreate('hetzner');
    fillKeys();
    vm.form.secretAccessKey = 'falsch';
    await vm.test();
    expect(vm.testState).toBe('error');
    expect(vm.error).toEqual(SIGNATURE_ERROR);
    vm.setRegion('nbg1');
    expect(vm.testState).toBe('idle');
    expect(vm.error).toBeNull();
  });

  it('testet und speichert keine ungültigen Formulare', async () => {
    vm.openCreate('hetzner');
    const save = vi.spyOn(backend, 'saveProfile');
    await vm.test();
    await vm.save();
    expect(vm.testState).toBe('idle');
    expect(save).not.toHaveBeenCalled();
  });

  it('speichert, schließt und meldet das Profil', async () => {
    vm.openCreate('hetzner');
    fillKeys();
    await vm.save();
    expect(vm.isOpen).toBe(false);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'neu-1', name: 'Hetzner Produktion' }));
    expect((await backend.listProfiles()).some((p) => p.id === 'neu-1')).toBe(true);
  });

  it('bleibt bei Speicherfehlern offen und zeigt den Fehler', async () => {
    vi.spyOn(backend, 'saveProfile').mockRejectedValue({ kind: 'credential', message: 'Speicher gesperrt' });
    vm.openCreate('hetzner');
    fillKeys();
    await vm.save();
    expect(vm.isOpen).toBe(true);
    expect(vm.error?.message).toBe('Speicher gesperrt');
    expect(vm.saving).toBe(false);
  });

  it('verhindert doppeltes Speichern', async () => {
    vm.openCreate('hetzner');
    fillKeys();
    const save = vi.spyOn(backend, 'saveProfile');
    await Promise.all([vm.save(), vm.save()]);
    expect(save).toHaveBeenCalledOnce();
  });

  it('schließt ohne zu speichern', () => {
    vm.openCreate();
    vm.close();
    expect(vm.isOpen).toBe(false);
  });
});
