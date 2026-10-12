import { describe, expect, it } from 'vitest';
import { DEFAULT_TRANSFER_PREFERENCES, partLimitText, rangeError, transferErrors } from './settingsRules';

describe('Regeln der Einstellungen', () => {
  it('prüft Zahlen gegen ihre Grenzen', () => {
    expect(rangeError('maxTransfers', 8)).toBeNull();
    expect(rangeError('maxTransfers', 0)).toBe('Gleichzeitige Transfers muss zwischen 1 und 32 liegen');
    expect(rangeError('partSizeMib', 4.5)).not.toBeNull();
    expect(rangeError('uploadLimitMibps', Number.NaN)).not.toBeNull();
    expect(rangeError('multipartThresholdMib', 5120)).toBeNull();
  });

  it('sammelt Fehler je Feld', () => {
    expect(transferErrors(DEFAULT_TRANSFER_PREFERENCES)).toEqual({});
    const errors = transferErrors({ ...DEFAULT_TRANSFER_PREFERENCES, retries: 11, partsParallel: 0 });
    expect(Object.keys(errors).sort()).toEqual(['partsParallel', 'retries']);
  });

  it('nennt die größte Datei bei 10.000 Teilen', () => {
    expect(partLimitText(16)).toBe(
      'Bei 10.000 Teilen höchstens 156 GiB pro Objekt. Größere Dateien erhöhen die Teilgröße automatisch.',
    );
    expect(partLimitText(512)).toContain('5.000 GiB');
  });
});
