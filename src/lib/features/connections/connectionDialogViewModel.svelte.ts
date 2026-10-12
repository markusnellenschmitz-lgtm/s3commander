// View-Model des Verbindungsdialogs (Screen 1).

import type {
  Addressing,
  BackendError,
  BackendPort,
  ConnectionProfile,
  ConnectionTest,
  CredentialsInput,
  Provider,
  ProviderPreset,
} from '../../core/backend';
import { toBackendError } from '../../core/backend';
import { credentialStoreName } from '../../core/platform';
import { matchEndpoint, type EndpointMatch } from '../../core/presets';

export const DEFAULT_TIMEOUT_SECS = 60;
export const DEFAULT_CONCURRENCY = 8;
export const TIMEOUT_RANGE = { min: 1, max: 600 } as const;
export const CONCURRENCY_RANGE = { min: 1, max: 64 } as const;
/** Rückfall, wenn die Region weder angegeben noch aus der Endpoint-URL ableitbar ist.
 * Die meisten S3-kompatiblen Server (MinIO, Ceph, Garage) akzeptieren diesen Wert. */
export const FALLBACK_REGION = 'us-east-1';

export interface ConnectionForm {
  id: string;
  provider: Provider;
  name: string;
  endpoint: string;
  region: string;
  /** Konto-ID für Vorlagen mit {account} (Cloudflare R2). */
  account: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  addressing: Addressing;
  timeoutSecs: number;
  concurrency: number;
  verifyTls: boolean;
  caFile: string;
  proxy: string;
}

export type FormErrors = Partial<Record<keyof ConnectionForm, string>>;
export type TestState = 'idle' | 'testing' | 'ok' | 'error';

export interface ConnectionDialogDeps {
  backend: BackendPort;
  newId?: () => string;
  onSaved: (profile: ConnectionProfile) => void | Promise<void>;
  /** „Verbindung löschen …“ im Bearbeiten-Dialog. */
  onDeleteRequest?: (profileId: string) => void;
}

function emptyForm(id: string): ConnectionForm {
  return {
    id,
    provider: 'custom',
    name: '',
    endpoint: '',
    region: '',
    account: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    addressing: 'path-style',
    timeoutSecs: DEFAULT_TIMEOUT_SECS,
    concurrency: DEFAULT_CONCURRENCY,
    verifyTls: true,
    caFile: '',
    proxy: '',
  };
}

const inRange = (value: number, range: { min: number; max: number }) =>
  Number.isInteger(value) && value >= range.min && value <= range.max;

const blankToNull = (value: string) => (value.trim() === '' ? null : value.trim());

/** Fehler der Verbindungsfelder; jede Regel liefert ihre Meldung, wenn sie verletzt ist. */
function connectionErrors(f: ConnectionForm): FormErrors {
  const rules: [keyof ConnectionForm, boolean, string][] = [
    ['name', !f.name.trim(), 'Profilname ist Pflicht'],
    ['endpoint', !/^https?:\/\/\S+$/.test(f.endpoint.trim()), 'Endpoint-URL mit http:// oder https://'],
    ['timeoutSecs', !inRange(f.timeoutSecs, TIMEOUT_RANGE), '1 bis 600 Sekunden'],
    ['concurrency', !inRange(f.concurrency, CONCURRENCY_RANGE), '1 bis 64'],
  ];
  return Object.fromEntries(rules.filter(([, broken]) => broken).map(([field, , message]) => [field, message]));
}

/** Die Region fließt in die Signatur ein; sie muss zur Region in der Endpoint-URL passen. */
function regionMismatch(f: ConnectionForm, presets: readonly ProviderPreset[]): FormErrors {
  const expected = matchEndpoint(f.endpoint, presets)?.region;
  const entered = f.region.trim().toLowerCase();
  // Leer heißt: Region aus der URL übernehmen, das ist kein Widerspruch.
  if (!expected || !entered || entered === expected) return {};
  return { region: `Region muss ${expected} sein (aus der Endpoint-URL)` };
}

/** Schlüssel sind beim Anlegen Pflicht; beim Bearbeiten nur, wenn einer der beiden geändert wird. */
function keyErrors(f: ConnectionForm, mode: 'create' | 'edit'): FormErrors {
  const accessKey = f.accessKeyId.trim();
  const secret = f.secretAccessKey.trim();
  if (mode === 'edit' && !accessKey && !secret) return {};
  return {
    ...(accessKey ? {} : { accessKeyId: 'Access Key ist Pflicht' }),
    ...(secret ? {} : { secretAccessKey: 'Secret Key ist Pflicht' }),
  };
}

export class ConnectionDialogViewModel {
  isOpen = $state(false);
  mode = $state<'create' | 'edit'>('create');
  presets = $state<ProviderPreset[]>([]);
  form = $state<ConnectionForm>(emptyForm(''));
  advancedOpen = $state(false);
  showSecret = $state(false);
  testState = $state<TestState>('idle');
  testResult = $state<ConnectionTest | null>(null);
  error = $state<BackendError | null>(null);
  saving = $state(false);
  /** Felder, die der Benutzer verlassen hat; erst dann zeigen sie Fehler. */
  touched = $state<Partial<Record<keyof ConnectionForm, boolean>>>({});
  /** Nach einem Test- oder Speicherversuch zeigen alle Felder ihre Fehler. */
  attempted = $state(false);
  /** Endpoint stammt aus der Vorlage und folgt Region und Konto. */
  #endpointFromTemplate = $state(false);

  readonly #backend: BackendPort;
  readonly #newId: () => string;
  readonly #onSaved: ConnectionDialogDeps['onSaved'];
  readonly #onDeleteRequest: ConnectionDialogDeps['onDeleteRequest'];

  constructor(deps: ConnectionDialogDeps) {
    this.#backend = deps.backend;
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
    this.#onSaved = deps.onSaved;
    this.#onDeleteRequest = deps.onDeleteRequest;
  }

  /** Bearbeiten → „Verbindung löschen …“: Dialog schließen und die Rückfrage öffnen. */
  requestDelete(): void {
    if (this.mode !== 'edit') return;
    this.close();
    this.#onDeleteRequest?.(this.form.id);
  }

  async loadPresets(): Promise<void> {
    this.presets = await this.#backend.listPresets();
  }

  openCreate(provider?: Provider): void {
    this.#reset('create', emptyForm(this.#newId()));
    this.selectPreset(provider ?? this.presets[0]?.provider ?? 'custom');
  }

  openEdit(profile: ConnectionProfile): void {
    this.#reset('edit', {
      ...emptyForm(profile.id),
      provider: profile.provider,
      name: profile.name,
      endpoint: profile.endpoint,
      region: profile.region,
      bucket: profile.defaultBucket ?? '',
      addressing: profile.addressing,
      timeoutSecs: profile.timeoutSecs,
      concurrency: profile.concurrency,
      verifyTls: profile.verifyTls,
      caFile: profile.caFile ?? '',
      proxy: profile.proxy ?? '',
    });
  }

  close(): void {
    this.isOpen = false;
  }

  /** Wo die Zugangsdaten landen, z. B. „Windows-Anmeldeinformationsspeicher“. */
  get credentialStore(): string {
    return credentialStoreName(this.#backend.platform);
  }

  get preset(): ProviderPreset | undefined {
    return this.presets.find((p) => p.provider === this.form.provider);
  }

  selectPreset(provider: Provider): void {
    const preset = this.presets.find((p) => p.provider === provider);
    this.form.provider = provider;
    if (!preset) return;
    this.form.region = preset.defaultRegion;
    this.form.addressing = preset.addressing;
    this.#endpointFromTemplate = preset.endpointTemplate !== '';
    this.form.endpoint = this.#endpointFromTemplate ? this.#templateEndpoint(preset) : '';
    this.#invalidateTest();
  }

  setRegion(region: string): void {
    this.form.region = region;
    this.#followTemplate();
  }

  setAccount(account: string): void {
    this.form.account = account;
    this.#followTemplate();
  }

  /** Von Hand eingegebener Endpoint; eine erkannte Vorlage setzt Anbieter und Region passend. */
  setEndpoint(endpoint: string): void {
    this.form.endpoint = endpoint;
    this.#endpointFromTemplate = false;
    const match = matchEndpoint(endpoint, this.presets);
    if (match) this.#applyMatch(match);
    this.#invalidateTest();
  }

  /** Vorschläge für das Regionsfeld aus der Vorlage. */
  /**
   * Region für die Signatur: Eingabe, sonst aus der Endpoint-URL, sonst Standard der Vorlage,
   * sonst us-east-1. SigV4 braucht immer einen Wert, das Feld ist trotzdem optional.
   */
  get effectiveRegion(): string {
    const entered = this.form.region.trim();
    if (entered) return entered;
    return matchEndpoint(this.form.endpoint, this.presets)?.region ?? (this.preset?.defaultRegion || FALLBACK_REGION);
  }

  get regionSuggestions(): string[] {
    return this.preset?.regions ?? [];
  }

  get needsAccount(): boolean {
    return this.preset?.endpointTemplate.includes('{account}') ?? false;
  }

  get endpointHelp(): string {
    const preset = this.preset;
    if (!preset || preset.endpointTemplate === '') return 'Adresse des eigenen Servers, z. B. http://localhost:9000';
    const regions = preset.regions.length > 1 ? ' Für andere Standorte die Region wechseln.' : '';
    return `Aus der Vorlage ${preset.label}.${regions}`;
  }

  /** Anzahl der Werte unter "Erweitert", die von der Vorlage abweichen. */
  get changedAdvancedCount(): number {
    const f = this.form;
    return [
      f.addressing !== (this.preset?.addressing ?? f.addressing),
      f.timeoutSecs !== DEFAULT_TIMEOUT_SECS,
      f.concurrency !== DEFAULT_CONCURRENCY,
      !f.verifyTls,
      f.caFile.trim() !== '',
      f.proxy.trim() !== '',
    ].filter(Boolean).length;
  }

  get errors(): FormErrors {
    const accountMissing = this.needsAccount && this.#endpointFromTemplate && !this.form.account.trim();
    return {
      ...connectionErrors(this.form),
      ...(accountMissing ? { account: 'Konto-ID ist Pflicht' } : {}),
      ...keyErrors(this.form, this.mode),
      ...regionMismatch(this.form, this.presets),
    };
  }

  /** Fehler, die angezeigt werden: berührte Felder oder alle nach einem Versuch. */
  get visibleErrors(): FormErrors {
    const errors = this.errors;
    if (this.attempted) return errors;
    return Object.fromEntries(Object.entries(errors).filter(([field]) => this.touched[field as keyof ConnectionForm]));
  }

  touch(field: keyof ConnectionForm): void {
    this.touched[field] = true;
  }

  get isValid(): boolean {
    return Object.keys(this.errors).length === 0;
  }

  toProfile(): ConnectionProfile {
    const f = this.form;
    return {
      id: f.id,
      name: f.name.trim(),
      provider: f.provider,
      endpoint: f.endpoint.trim(),
      region: this.effectiveRegion,
      defaultBucket: blankToNull(f.bucket),
      addressing: f.addressing,
      quirks: this.preset?.quirks ?? { urlEncodedListing: false, crc32cChecksums: false },
      timeoutSecs: f.timeoutSecs,
      concurrency: f.concurrency,
      verifyTls: f.verifyTls,
      caFile: blankToNull(f.caFile),
      proxy: blankToNull(f.proxy),
    };
  }

  /** Beim Bearbeiten ohne neue Schlüssel bleiben die gespeicherten erhalten (null). */
  credentials(): CredentialsInput | null {
    const { accessKeyId, secretAccessKey } = this.form;
    if (!accessKeyId.trim() && !secretAccessKey.trim()) return null;
    return { accessKeyId, secretAccessKey };
  }

  async test(): Promise<void> {
    this.attempted = true;
    if (!this.isValid) return;
    this.testState = 'testing';
    this.error = null;
    try {
      this.testResult = await this.#backend.testConnection(this.toProfile(), this.credentials());
      this.testState = 'ok';
    } catch (error) {
      this.error = toBackendError(error);
      this.testState = 'error';
    }
  }

  async save(): Promise<void> {
    this.attempted = true;
    if (!this.isValid || this.saving) return;
    this.saving = true;
    this.error = null;
    try {
      const profile = this.toProfile();
      await this.#backend.saveProfile(profile, this.credentials());
      this.isOpen = false;
      await this.#onSaved(profile);
    } catch (error) {
      this.error = toBackendError(error);
    } finally {
      this.saving = false;
    }
  }

  #reset(mode: 'create' | 'edit', form: ConnectionForm): void {
    this.mode = mode;
    this.form = form;
    this.#endpointFromTemplate = false;
    this.advancedOpen = false;
    this.showSecret = false;
    this.saving = false;
    this.touched = {};
    this.attempted = false;
    this.#invalidateTest();
    this.isOpen = true;
  }

  #applyMatch(match: EndpointMatch): void {
    this.form.provider = match.provider;
    if (match.region) this.form.region = match.region;
    if (match.account) this.form.account = match.account;
    this.form.addressing = this.preset?.addressing ?? this.form.addressing;
    this.#endpointFromTemplate = true;
  }

  #templateEndpoint(preset: ProviderPreset): string {
    return preset.endpointTemplate.replace('{region}', this.form.region.trim()).replace('{account}', this.form.account);
  }

  /** Endpoint der Vorlage nachführen. Eine geleerte Region lässt den Endpoint stehen,
   * damit die Region weiter aus der URL abgeleitet wird. */
  #followTemplate(): void {
    const preset = this.preset;
    const regionCleared = preset?.endpointTemplate.includes('{region}') && !this.form.region.trim();
    if (preset && this.#endpointFromTemplate && !regionCleared) this.form.endpoint = this.#templateEndpoint(preset);
    this.#invalidateTest();
  }

  #invalidateTest(): void {
    this.testState = 'idle';
    this.testResult = null;
    this.error = null;
  }
}
