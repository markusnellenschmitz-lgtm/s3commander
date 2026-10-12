// Regeln und Texte der Objekt-Details. Dieselben Regeln wie src-tauri/src/domain/details.rs;
// das Backend prüft verbindlich, hier gibt es sofortige Rückmeldung.

import type { ObjectAcl, ObjectTag } from '../../core/backend';
import { countText } from '../../core/format';

export const MAX_TAGS = 10;
const MAX_TAG_KEY_CHARS = 128;
const MAX_TAG_VALUE_CHARS = 256;
const USER_METADATA = /^x-amz-meta-[a-z0-9_-]+$/;
const SYSTEM_METADATA: ReadonlySet<string> = new Set([
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'expires',
]);
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export function metadataNameError(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (USER_METADATA.test(normalized) || SYSTEM_METADATA.has(normalized)) return null;
  return 'x-amz-meta-… oder Cache-Control, Content-Disposition, Content-Encoding, Content-Language, Expires';
}

export function metadataValueError(value: string): string | null {
  return PRINTABLE_ASCII.test(value) ? null : 'Nur sichtbare ASCII-Zeichen und Leerzeichen';
}

/** Fehler für ein neues Tag; null, wenn es hinzugefügt werden kann. */
export function tagError(key: string, value: string, existing: readonly ObjectTag[]): string | null {
  if (existing.length >= MAX_TAGS) return 'Ein Objekt kann höchstens 10 Tags haben';
  const keyChars = [...key.trim()].length;
  if (keyChars === 0 || keyChars > MAX_TAG_KEY_CHARS) return 'Schlüssel mit 1 bis 128 Zeichen eingeben';
  if ([...value].length > MAX_TAG_VALUE_CHARS) return 'Werte dürfen höchstens 256 Zeichen lang sein';
  if (existing.some((t) => t.key === key.trim())) return `„${key.trim()}“ gibt es schon`;
  return null;
}

/** Zusammenfassung der Berechtigungen: "Öffentlich lesbar · 2 Berechtigungen · Eigentümer ops". */
export function permissionSummary(acl: ObjectAcl): string {
  const publicRead = acl.grants.some((g) => g.isPublic && (g.permission === 'READ' || g.permission === 'FULL_CONTROL'));
  const parts = [
    publicRead ? 'Öffentlich lesbar' : 'Nicht öffentlich',
    countText(acl.grants.length, 'Berechtigung', 'Berechtigungen'),
    acl.owner ? `Eigentümer ${acl.owner}` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Kurzform einer Version-ID für Knöpfe: "p7Kd2sVb…" */
const ENCRYPTION_LABELS: Readonly<Record<string, string>> = {
  AES256: 'SSE-S3 (AES-256)',
  'aws:kms': 'SSE-KMS',
  'aws:kms:dsse': 'DSSE-KMS',
  'SSE-C': 'SSE-C (eigener Schlüssel)',
};

/** Serverseitige Verschlüsselung lesbar; unbekannte Werte erscheinen unverändert. */
export function encryptionText(encryption: string | null): string {
  if (encryption === null) return 'Keine';
  return ENCRYPTION_LABELS[encryption] ?? encryption;
}

export function shortVersion(versionId: string): string {
  return versionId.length > 8 ? `${versionId.slice(0, 8)}…` : versionId;
}
