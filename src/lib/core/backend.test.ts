import { describe, expect, it } from 'vitest';
import { errorDetail, isSelfHosted, toBackendError } from './backend';

describe('toBackendError', () => {
  it('übernimmt Fehler des Backends unverändert', () => {
    const error = { kind: 'timeout', message: 'Zeitüberschreitung' };
    expect(toBackendError(error)).toBe(error);
  });

  it('wandelt JS-Fehler und sonstige Werte um', () => {
    expect(toBackendError(new Error('kaputt'))).toEqual({ kind: 'unexpected', message: 'kaputt' });
    expect(toBackendError('text')).toEqual({ kind: 'unexpected', message: 'text' });
    expect(toBackendError({ kind: 1 })).toEqual({ kind: 'unexpected', message: '[object Object]' });
    expect(toBackendError(null)).toEqual({ kind: 'unexpected', message: 'null' });
  });
});

describe('errorDetail', () => {
  it('nennt Code, HTTP-Status und Request-ID', () => {
    const service = { code: 'AccessDenied', message: 'nein', httpStatus: 403, requestId: 'R1' };
    expect(errorDetail({ kind: 'service', message: 'x', service })).toBe('AccessDenied · HTTP 403 · Request-ID R1');
    expect(errorDetail({ kind: 'service', message: 'x', service: { ...service, requestId: null } })).toBe(
      'AccessDenied · HTTP 403',
    );
  });

  it('liefert null ohne Dienstfehler', () => {
    expect(errorDetail({ kind: 'network', message: 'weg' })).toBeNull();
  });
});

it('unterscheidet selbst gehostete und gehostete Anbieter', () => {
  expect(isSelfHosted('minio')).toBe(true);
  expect(isSelfHosted('custom')).toBe(true);
  expect(isSelfHosted('hetzner')).toBe(false);
});
