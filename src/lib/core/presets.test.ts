import { describe, expect, it } from 'vitest';
import { matchEndpoint } from './presets';
import { FAKE_PRESETS } from '../infrastructure/fakeBackend';

describe('matchEndpoint', () => {
  it('erkennt Hetzner mit Region aus der URL', () => {
    expect(matchEndpoint('https://fsn1.your-objectstorage.com', FAKE_PRESETS)).toEqual({
      provider: 'hetzner',
      region: 'fsn1',
      account: null,
    });
    expect(matchEndpoint(' https://NBG1.your-objectstorage.com/ ', FAKE_PRESETS)?.region).toBe('nbg1');
  });

  it('erkennt AWS auch mit nicht gelisteten Regionen', () => {
    expect(matchEndpoint('https://s3.ap-south-2.amazonaws.com', FAKE_PRESETS)).toEqual({
      provider: 'aws',
      region: 'ap-south-2',
      account: null,
    });
  });

  it('erkennt R2 mit Konto-ID', () => {
    expect(matchEndpoint('https://abc123.r2.cloudflarestorage.com', FAKE_PRESETS)).toEqual({
      provider: 'cloudflare-r2',
      region: null,
      account: 'abc123',
    });
  });

  it('ignoriert unbekannte Regionen bei festen Listen und eigene Server', () => {
    expect(matchEndpoint('https://xyz9.your-objectstorage.com', FAKE_PRESETS)).toBeNull();
    expect(matchEndpoint('http://localhost:9000', FAKE_PRESETS)).toBeNull();
    expect(matchEndpoint('https://fsn1.your-objectstorage.com/pfad', FAKE_PRESETS)).toBeNull();
  });
});
