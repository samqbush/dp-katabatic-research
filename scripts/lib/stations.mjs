/**
 * Canonical station registry.
 *
 * This lives in code, not only in Neon, for a specific reason: deciding *where a day file goes*
 * must never require a network call. When station metadata was read from Neon, a database outage
 * threw before the local file was written, so an unreachable database could cost an irreplaceable
 * Holfuy day — the exact failure the file-first write protocol exists to prevent.
 *
 * `scripts/db/apply-schema.mjs` seeds the `stations` table from this list, so there is one source
 * of truth rather than a JS copy and a SQL copy that can drift.
 *
 * **Device MACs are read from the environment, not committed.** They are not credentials — the
 * Ecowitt API still requires a key — but they identify physical hardware belonging to other
 * people, and this repository is public. Keeping them in `.env` means the code can be shared
 * without publishing someone else's device IDs. See `.env.example`.
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

/** Env var holding a station's Ecowitt MAC, derived from its slug. */
function macEnvVar(slug) {
  return `ECOWITT_MAC_${slug.toUpperCase().replace(/-/g, '_')}`;
}

function macFor(slug) {
  return process.env[macEnvVar(slug)]?.trim() || null;
}

export const STATIONS = [
  {
    slug: 'dp-boulder-res',
    name: 'DP Boulder Res',
    source: 'ecowitt',
    ecowitt_mac: macFor('dp-boulder-res'),
    
    holfuy_id: null,
    lat: null,
    lon: null,
  },
  {
    slug: 'dp-soda-lakes',
    name: 'DP Soda Lakes',
    source: 'ecowitt',
    ecowitt_mac: macFor('dp-soda-lakes'),
    
    holfuy_id: null,
    lat: null,
    lon: null,
  },
  {
    slug: 'dp-standley-west',
    name: 'DP Standley West',
    source: 'ecowitt',
    ecowitt_mac: macFor('dp-standley-west'),
    
    holfuy_id: null,
    lat: null,
    lon: null,
  },
  {
    slug: 'lookout-mtn',
    name: 'Lookout Mtn - RMHPA',
    source: 'holfuy',
    ecowitt_mac: null,
    holfuy_id: 1295,
    lat: 39.7392,
    lon: -105.2419,
  },
];

const BY_SLUG = new Map(STATIONS.map((s) => [s.slug, s]));

/** Resolve a station with no network access. Throws on unknown slugs rather than guessing. */
export function stationBySlug(slug) {
  const row = BY_SLUG.get(slug);
  if (!row) {
    throw new Error(
      `Unknown station "${slug}". Add it to scripts/lib/stations.mjs and re-run apply-schema.`
    );
  }
  return row;
}

export function stationsBySource(source) {
  return source ? STATIONS.filter((s) => s.source === source) : STATIONS.slice();
}

/**
 * Resolve a station's Ecowitt MAC, failing loudly when it is not configured.
 *
 * A missing MAC must never degrade into a request with `mac=undefined`: Ecowitt answers that with
 * an error that reads like an outage, and the archive would record a gap on a day the station was
 * fine. Per §4.2, a day not captured within ~5 days is gone for good, so this fails immediately
 * and says exactly which variable to set.
 */
export function requireEcowittMac(slug) {
  const station = stationBySlug(slug);
  if (station.source !== 'ecowitt') {
    throw new Error(`Station "${slug}" is a ${station.source} station and has no Ecowitt MAC.`);
  }
  if (!station.ecowitt_mac) {
    throw new Error(
      `Missing Ecowitt MAC for "${slug}".\n` +
      `  Set ${macEnvVar(slug)} in .env (device MACs are not committed — see .env.example).`
    );
  }
  return station.ecowitt_mac;
}
