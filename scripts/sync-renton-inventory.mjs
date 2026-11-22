// Syncs live IKEA Renton, WA (Store #488) inventory snapshot into src/rentonInventory.js
// Usage: node scripts/sync-renton-inventory.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { IKEA_CATALOG } from '../src/catalog.js';
import { mapIkeaProductToCatalogItem, RENTON_STORE_NO, RENTON_STORE_NAME } from '../src/rentonLookup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.resolve(__dirname, '../src/rentonInventory.js');

const CATEGORY_QUERIES = [
  { q: 'desk', cat: 'tables', limit: 22 },
  { q: 'standing desk', cat: 'tables', limit: 12 },
  { q: 'office chair', cat: 'seating', limit: 16 },
  { q: 'bookcase', cat: 'storage', limit: 18 },
  { q: 'kallax', cat: 'storage', limit: 16 },
  { q: 'drawer unit', cat: 'storage', limit: 14 },
  { q: 'dresser', cat: 'storage', limit: 16 },
  { q: 'besta tv', cat: 'storage', limit: 10 },
  { q: 'wall shelf', cat: 'storage', limit: 12 },
  { q: 'wardrobe', cat: 'storage', limit: 10 },
  { q: 'daybed', cat: 'beds', limit: 10 },
  { q: 'bed frame', cat: 'beds', limit: 14 },
  { q: 'sleeper sofa', cat: 'seating', limit: 14 },
  { q: 'loveseat sofa', cat: 'seating', limit: 12 },
  { q: 'armchair', cat: 'seating', limit: 12 },
  { q: 'coffee table', cat: 'tables', limit: 14 },
  { q: 'nightstand', cat: 'tables', limit: 12 },
  { q: 'area rug', cat: 'rugs', limit: 14 },
  { q: 'floor lamp', cat: 'lighting', limit: 12 },
  { q: 'table lamp', cat: 'lighting', limit: 12 },
  { q: 'artificial potted plant', cat: 'lighting', limit: 10 },
];

// Exclude non-furniture accessories/spare parts that sometimes match broad searches
const EXCLUDE_RE = /\b(accessory|tent|canopy|cover|cushion|mattress pad|leg|frame only|shelf insert|door|glass door|drawer insert|box|basket|organizer|cable|tray|bracket|knob|handle|bulb|shade|cord|coaster|runner|protector|castor|caster|caster wheel|replacement|rail|rod|hanger|hook|mirror|clock|frame,|picture|candle|vase|pillow|blanket|throw|curtain|sheet|duvet|bedding|slatted bed base|beam|mounting|underframe|table top|tabletop)\b/i;

const CORE_QUERY_OVERRIDES = {
  hemnes_daybed: 'HEMNES daybed frame 3 drawers',
  brimnes_daybed: 'BRIMNES daybed frame 2 drawers',
  malm_queen: 'MALM bed frame queen',
  malm_full: 'MALM bed frame full',
  tarva_twin: 'TARVA bed frame twin',
  kura_bed: 'KURA reversible bed',
  poang_chair: 'POANG armchair',
  strandmon: 'STRANDMON wing chair',
  kivik_loveseat: 'KIVIK loveseat',
  barslov_sleeper: 'BARSLOV sleeper sofa',
  friheten_sleeper: 'FRIHETEN sleeper sectional',
  markus_chair: 'MARKUS office chair',
  jarvfjallet_chair: 'JARVFJALLET office chair',
  billy_single: 'BILLY bookcase 31 1/2',
  billy_double: 'BILLY bookcase combination',
  kallax_4x4: 'KALLAX shelf unit 57 7/8x57 7/8',
  kallax_4x2: 'KALLAX shelf unit 30 1/8x57 7/8',
  alex_drawer: 'ALEX drawer unit 14 1/8',
  helmer_drawer: 'HELMER drawer unit',
  eket_wall_shelf: 'EKET wall cabinet',
  mittzon_desk: 'MITTZON desk',
  listerby_round: 'LISTERBY coffee table round',
  lack_coffee: 'LACK coffee table',
  nesna_nightstand: 'NESNA nightstand',
  hemnes_nightstand: 'HEMNES nightstand',
  fado_lamp: 'FADO table lamp',
  hektar_lamp: 'HEKTAR floor lamp',
  fejka_plant: 'FEJKA monstera',
};

async function fetchIkeaRenton(q, size = 30) {
  const url = `https://sik.search.blue.cdtapps.com/us/en/search-result-page?q=${encodeURIComponent(q)}&size=${size}&c=sr&store=${RENTON_STORE_NO}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for q=${q}`);
  const data = await res.json();
  return (data?.searchResultPage?.products?.main?.items || [])
    .filter((r) => r?.type === 'PRODUCT' && r.product)
    .map((r) => r.product);
}

function coreSearchQuery(item) {
  if (CORE_QUERY_OVERRIDES[item.id]) return CORE_QUERY_OVERRIDES[item.id];
  return `${item.name}`.trim();
}

async function main() {
  console.log(`Syncing live ${RENTON_STORE_NAME} (Store #${RENTON_STORE_NO}) inventory...`);
  const coreUpdates = {};

  // 1. Sync live Renton #488 price, SKU, pipUrl, and stock for every built-in starter item
  for (const item of IKEA_CATALOG) {
    if (item.brand !== 'IKEA' || item.liveRenton || String(item.id).startsWith('renton_')) continue;
    try {
      const q = coreSearchQuery(item);
      const prods = await fetchIkeaRenton(q, 10);
      const firstName = item.name.split(/\s+/)[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const cleanProds = prods.filter((p) => {
        const nm = `${p.name || ''} ${p.typeName || ''}`;
        if (EXCLUDE_RE.test(nm)) return false;
        const pPrice = Number(p.salesPrice?.numeral) || 0;
        if (item.price > 0 && (pPrice < item.price * 0.45 || pPrice > item.price * 2.4)) return false;
        return true;
      });
      const matches = cleanProds.filter((p) =>
        String(p.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(firstName)
      );
      const pool = matches.length > 0 ? matches : cleanProds;
      const inStock = pool.find((p) =>
        (p.availability || []).some((a) => a.type2 === 'CASH_AND_CARRY' && (a.status === 'HIGH_IN_STOCK' || a.status === 'LOW_IN_STOCK'))
      );
      const best = inStock || pool[0];
      if (best) {
        const mapped = mapIkeaProductToCatalogItem(best, item.category);
        if (mapped) {
          coreUpdates[item.id] = {
            price: mapped.price || item.price,
            prevPrice: mapped.prevPrice || null,
            priceTag: mapped.priceTag || null,
            itemNo: mapped.itemNo,
            skuFormatted: mapped.skuFormatted,
            pipUrl: mapped.pipUrl,
            rentonStock: mapped.rentonStock,
          };
        }
      }
    } catch (err) {
      console.warn(`  Core sync skip ${item.id}:`, err.message);
    }
  }
  console.log(`Synced ${Object.keys(coreUpdates).length} core starter items against Renton #488.`);

  // 2. Gather comprehensive in-stock Renton #488 furniture across all 21 category queries
  const coreSkus = new Set(Object.values(coreUpdates).map((u) => u.itemNo));
  const seenSku = new Set(coreSkus);
  const seenNameDim = new Set(
    IKEA_CATALOG.map((it) => `${it.name.toLowerCase().split(/\s+/)[0]}_${Math.round(it.w)}_${Math.round(it.h)}`)
  );
  const liveCatalog = [];

  for (const { q, cat, limit } of CATEGORY_QUERIES) {
    try {
      const prods = await fetchIkeaRenton(q, Math.min(48, limit * 2));
      let added = 0;
      for (const p of prods) {
        if (added >= limit) break;
        const typeStr = `${p.name || ''} ${p.typeName || ''}`;
        if (EXCLUDE_RE.test(typeStr)) continue;

        const mapped = mapIkeaProductToCatalogItem(p, cat);
        if (!mapped || !mapped.price || mapped.price <= 0) continue;
        if (mapped.rentonStock !== 'HIGH_IN_STOCK' && mapped.rentonStock !== 'LOW_IN_STOCK') continue;
        if (seenSku.has(mapped.itemNo)) continue;

        const dedupKey = `${mapped.name.toLowerCase()}_${Math.round(mapped.w)}_${Math.round(mapped.d)}_${Math.round(mapped.h)}`;
        if (seenNameDim.has(dedupKey)) continue;

        seenSku.add(mapped.itemNo);
        seenNameDim.add(dedupKey);
        liveCatalog.push(mapped);
        added++;
      }
      console.log(`  Query "${q}" -> +${added} in-stock Renton #488 items`);
    } catch (err) {
      console.warn(`  Query "${q}" failed:`, err.message);
    }
  }

  const meta = {
    storeNo: RENTON_STORE_NO,
    storeName: RENTON_STORE_NAME,
    syncedAt: new Date().toISOString(),
    coreSyncedCount: Object.keys(coreUpdates).length,
    liveCatalogCount: liveCatalog.length,
  };

  const out = `// Auto-generated live inventory snapshot from ${RENTON_STORE_NAME} (Store #${RENTON_STORE_NO})
// Generated at: ${meta.syncedAt}
// Re-sync anytime via: node scripts/sync-renton-inventory.mjs

export const RENTON_SYNC_META = ${JSON.stringify(meta, null, 2)};

export const RENTON_CORE_UPDATES = ${JSON.stringify(coreUpdates, null, 2)};

export const RENTON_LIVE_CATALOG = ${JSON.stringify(liveCatalog, null, 2)};
`;

  fs.writeFileSync(OUT_FILE, out, 'utf8');
  console.log(`\nWrote ${OUT_FILE} (${(Buffer.byteLength(out) / 1024).toFixed(1)} KB) — ${liveCatalog.length} additional live Renton #488 in-stock items!`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
