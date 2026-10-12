import { describe, expect, it } from 'vitest';
import {
  metadataNameError,
  metadataValueError,
  permissionSummary,
  shareUntilText,
  shortVersion,
  encryptionText,
  tagError,
} from './detailsRules';

describe('Regeln der Objekt-Details', () => {
  it('prüft Metadaten-Namen und -Werte wie das Backend', () => {
    expect(metadataNameError(' X-Amz-Meta-Pg-Version ')).toBeNull();
    expect(metadataNameError('Cache-Control')).toBeNull();
    expect(metadataNameError('x-amz-meta-')).not.toBeNull();
    expect(metadataNameError('authorization')).not.toBeNull();
    expect(metadataValueError('no-store, max-age=0')).toBeNull();
    expect(metadataValueError('ümlaut')).toBe('Nur sichtbare ASCII-Zeichen und Leerzeichen');
  });

  it('prüft neue Tags', () => {
    const existing = [{ key: 'env', value: 'prod' }];
    expect(tagError('owner', 'ops', existing)).toBeNull();
    expect(tagError(' ', 'x', existing)).toBe('Schlüssel mit 1 bis 128 Zeichen eingeben');
    expect(tagError('k'.repeat(129), 'x', existing)).not.toBeNull();
    expect(tagError('k', 'v'.repeat(257), existing)).toBe('Werte dürfen höchstens 256 Zeichen lang sein');
    expect(tagError('env', 'x', existing)).toBe('„env“ gibt es schon');
    const full = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, value: '' }));
    expect(tagError('neu', '', full)).toBe('Ein Objekt kann höchstens 10 Tags haben');
  });

  it('fasst Berechtigungen zusammen', () => {
    const owner = { grantee: 'ops', isPublic: false, permission: 'FULL_CONTROL' };
    expect(permissionSummary({ owner: 'ops', grants: [owner] })).toBe(
      'Nicht öffentlich · 1 Berechtigung · Eigentümer ops',
    );
    const publicRead = { grantee: 'AllUsers', isPublic: true, permission: 'READ' };
    expect(permissionSummary({ owner: null, grants: [owner, publicRead] })).toBe(
      'Öffentlich lesbar · 2 Berechtigungen',
    );
    const publicAcp = { grantee: 'AllUsers', isPublic: true, permission: 'READ_ACP' };
    expect(permissionSummary({ owner: null, grants: [publicAcp] })).toMatch(/^Nicht öffentlich/);
  });

  it('formatiert Gültigkeit und Version-IDs', () => {
    const now = new Date(2026, 9, 11, 15, 23, 8).getTime();
    expect(shareUntilText(now, 24 * 60 * 60)).toBe('bis 12.10.2026 15:23:08');
    expect(shortVersion('p7Kd2sVb9QeR1aXc')).toBe('p7Kd2sVb…');
    expect(shortVersion('null')).toBe('null');
    expect(encryptionText(null)).toBe('Keine');
    expect(encryptionText('aws:kms')).toBe('SSE-KMS');
    expect(encryptionText('aws:fips')).toBe('aws:fips');
  });
});
