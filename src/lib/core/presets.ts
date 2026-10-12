// Erkennt eine Anbieter-Vorlage an der Endpoint-URL, z. B. https://fsn1.your-objectstorage.com
// → Hetzner, Region fsn1. Verhindert Profile, deren Region nicht zum Endpoint passt: die
// Region fließt in die SigV4-Signatur ein, eine falsche Region führt zu 403-Fehlern.

import type { Provider, ProviderPreset } from './backend';

export interface EndpointMatch {
  provider: Provider;
  region: string | null;
  account: string | null;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function templatePattern(template: string): RegExp {
  const pattern = escapeRegExp(template)
    .replace(escapeRegExp('{region}'), '(?<region>[a-z0-9-]+)')
    .replace(escapeRegExp('{account}'), '(?<account>[a-z0-9]+)');
  return new RegExp(`^${pattern}/?$`, 'i');
}

/** Vorlage, deren Endpoint-Muster zur URL passt; null bei eigenen Servern. */
export function matchEndpoint(endpoint: string, presets: readonly ProviderPreset[]): EndpointMatch | null {
  const url = endpoint.trim();
  for (const preset of presets) {
    if (!preset.endpointTemplate) continue;
    const groups = templatePattern(preset.endpointTemplate).exec(url)?.groups;
    if (!groups) continue;
    const region = groups.region?.toLowerCase() ?? null;
    if (region && preset.regions.length > 0 && !preset.regions.includes(region) && preset.provider !== 'aws') continue;
    return { provider: preset.provider, region, account: groups.account ?? null };
  }
  return null;
}
