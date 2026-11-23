// Runtime Natural-Language Layout Planner Agent
// Supports both:
// 1. Built-in zero-setup semantic tool-calling planner (works 100% offline / inside sandboxed iframes)
// 2. Optional Live LLM API mode (OpenAI, Google Gemini, or Custom OpenAI-compatible / Ollama endpoint)
// Both modes execute the exact same validated spatial tool calls on the live 3D room state.

import { ALL_CATALOG, IKEA_CATALOG, FINISH_SWATCHES, LAYOUT_PRESETS } from './catalog.js';
import {
  getItemDimensionsIn,
  clampAndSnapToRoom,
  checkPlacementStatus,
  getRoomFloorAreaSqIn,
  getRoomPolygon,
} from './collision.js';

export const AGENT_QUICK_PROMPTS = [
  'Balance storage, aesthetics & walkway with TONSTAD + dual desks',
  'Arrange only my Considering hotlist cleanly',
  'Dual office: both desks on West wall + loveseat on East',
  'Dual office face-off (East + West) with 42" monitor desk',
  'Dual office L-corner studio near the North window',
  'Add TONSTAD Double Hutch on West wall & IDANÄS on East',
  'Switch finishes to oak & off-white, evening lighting',
  'Audit clearances, chair aisle & IKEA budget',
];

const FINISH_ALIASES = [
  ['blackbrown', 'blackBrown'],
  ['black-brown', 'blackBrown'],
  ['espresso', 'blackBrown'],
  ['stained oak', 'stainedOak'],
  ['brown oak', 'stainedOak'],
  ['off-white', 'offWhite'],
  ['off white', 'offWhite'],
  ['dark blue', 'darkBlue'],
  ['matte black', 'matteBlack'],
  ['black', 'matteBlack'],
  ['walnut', 'walnut'],
  ['white oak', 'oak'],
  ['oak', 'oak'],
  ['birch', 'birch'],
  ['pine', 'pine'],
  ['white', 'white'],
  ['slate blue', 'slateBlue'],
  ['slate', 'slateBlue'],
  ['blue', 'slateBlue'],
  ['light grey', 'lightGrey'],
  ['light gray', 'lightGrey'],
  ['dark grey', 'darkGrey'],
  ['dark gray', 'darkGrey'],
  ['anthracite', 'darkGrey'],
  ['charcoal', 'darkGrey'],
  ['grey', 'darkGrey'],
  ['gray', 'darkGrey'],
  ['sage green', 'sage'],
  ['sage', 'sage'],
  ['green', 'sage'],
  ['beige', 'beige'],
  ['cream', 'beige'],
  ['terracotta', 'terracotta'],
  ['jute', 'jute'],
];

const CATALOG_SYNONYMS = [
  ['desk_42_monitor', ['42 inch', '42"', '42-inch', '42in', 'second desk', '2nd desk', 'monitor desk', 'big monitor', 'dual desk', '42 monitor']],
  ['retained_wood_desk', ['wood desk', 'standing desk', 'bamboo desk', 'retained desk', 'wood standing', 'first desk', '1st desk', 'original desk']],
  ['retained_white_desk', ['white desk', 'corner desk', 'white corner']],
  ['retained_loveseat', ['loveseat', 'love seat', 'big loveseat', 'chair and a half', 'couch', 'retained sofa', 'existing sofa', 'blue chair', 'armchair']],
  ['tonstad_tv_unit', ['tonstad tv', 'tonstad tv unit', 'tonstad media', 'tonstad 70', '60542962']],
  ['tonstad_storage_glass_oak', ['tonstad glass hutch', 'tonstad oak glass', '59570263']],
  ['tonstad_storage_solid_oak', ['tonstad solid hutch', 'tonstad oak sliding', '79570257']],
  ['billy_narrow_oak', ['narrow billy', 'slim billy', 'billy 15', 'billy narrow', '60477382']],
  ['tonstad_double_hutch', ['tonstad double hutch', 'tonstad 64 hutch', 'tonstad hutch 64', 'tonstad $838']],
  ['tonstad_hutch_combo', ['tonstad tall hutch', 'tonstad hutch', 'tonstad 32 hutch']],
  ['tonstad_sliding_glass_wide', ['tonstad sliding glass 47', 'tonstad wide glass', 'tonstad 47', 'tonstad glass']],
  ['tonstad_sliding_glass_narrow', ['tonstad sliding glass 32', 'tonstad narrow glass']],
  ['tonstad_sliding_solid', ['tonstad sliding door', 'tonstad solid sliding']],
  ['tonstad_bookcase', ['tonstad bookcase', 'tonstad shelf', 'tonstad']],
  ['tonstad_double_credenza', ['tonstad double cabinet', 'tonstad credenza', 'tonstad 64']],
  ['tonstad_base_doors', ['tonstad base', 'tonstad cabinet']],
  ['tonstad_4drawer', ['tonstad 4-drawer', 'tonstad dresser', 'tonstad drawers']],
  ['idanas_high_cabinet', ['idanas', 'idanäs', 'high cabinet', 'glass display cabinet']],
  ['kallax_5x5', ['kallax 5x5', 'kallax 5×5', '25 cube', '25-cubby']],
  ['kallax_2x4', ['kallax 2x4', 'kallax 2×4', 'kallax tower']],
  ['jarvfjallet_chair', ['jarvfjallet', 'järvfjället', 'headrest chair', 'ergonomic chair']],
  ['markus_chair', ['markus', 'office chair', 'desk chair', 'swivel chair', 'mesh chair', 'chair']],
  ['brimnes_daybed', ['brimnes', 'brimnes daybed']],
  ['hemnes_daybed', ['hemnes daybed', 'daybed', 'day bed', 'pull out bed', 'pull-out bed', 'trundle']],
  ['malm_queen', ['malm queen', 'queen bed', 'queen']],
  ['malm_full', ['malm full', 'full bed', 'double bed']],
  ['tarva_twin', ['tarva', 'twin bed', 'pine bed']],
  ['kura_bed', ['kura', 'loft bed', 'kids bed', 'bunk']],
  ['poang_chair', ['poang', 'poäng', 'bentwood']],
  ['strandmon', ['strandmon', 'wing chair', 'wingback', 'reading chair']],
  ['kivik_loveseat', ['kivik', 'ikea sofa', '2-seat', 'two seat']],
  ['barslov_sleeper', ['barslov', 'bårslöv', 'barslöv', 'compact sleeper']],
  ['friheten_sleeper', ['friheten', 'sectional', 'sleeper sofa']],
  ['kallax_4x4', ['kallax 4x4', 'kallax 4×4', '16 cube', 'tall kallax', 'room divider']],
  ['kallax_4x2', ['kallax 4x2', 'kallax 4×2', 'kallax', 'cubby', 'credenza']],
  ['billy_double', ['double billy', 'billy 2x', 'billy double', 'wide billy', 'two billy', '2 billy', 'library wall']],
  ['billy_single', ['billy', 'bookcase', 'bookshelf', 'book shelf']],
  ['helmer_drawer', ['helmer', 'rolling file', 'rolling cabinet', 'file cabinet', 'metal drawers']],
  ['eket_wall_shelf', ['eket', 'wall shelf', 'wall cube', 'floating shelf', 'wall cabinet']],
  ['alex_drawer', ['alex', 'drawer unit', 'file drawers', 'desk drawers', 'pedestal']],
  ['storklinta_6drawer', ['storklinta', '6-drawer', '6 drawer', 'wide dresser', 'dresser']],
  ['gullaberg_3drawer', ['gullaberg', '3-drawer', '3 drawer', 'chest of drawers', 'chest']],
  ['malm_6drawer', ['malm dresser', 'malm 6']],
  ['hemnes_3drawer', ['hemnes dresser', 'hemnes 3', 'hemnes chest']],
  ['besta_tv', ['besta', 'bestå', 'tv unit', 'tv stand', 'media unit', 'media console']],
  ['trofast', ['trofast', 'toy bins', 'toy storage']],
  ['pax_wardrobe', ['pax', 'wardrobe', 'armoire', 'extra closet']],
  ['mittzon_desk', ['mittzon', 'ikea desk']],
  ['listerby_round', ['listerby', 'round coffee table', 'round table']],
  ['lack_coffee', ['lack', 'coffee table']],
  ['nesna_nightstand', ['nesna', 'side table', 'end table']],
  ['hemnes_nightstand', ['hemnes nightstand', 'nightstand', 'bedside table']],
  ['stoense_rug', ['stoense', 'plush rug', 'area rug', 'rug']],
  ['lohals_rug', ['lohals', 'jute rug']],
  ['existing_geo_rug', ['geo rug', 'existing rug', 'triangle rug']],
  ['hektar_lamp', ['hektar', 'floor lamp', 'standing lamp', 'lamp']],
  ['fado_lamp', ['fado', 'globe lamp', 'orb lamp', 'mood lamp', 'table lamp']],
  ['fejka_plant', ['fejka', 'monstera', 'plant', 'potted plant']],
];

function normDeg(deg) {
  let d = Math.round(deg) % 360;
  if (d < 0) d += 360;
  return d;
}

function facingToRotDeg(facing) {
  switch ((facing || '').toLowerCase()) {
    case 'south': case 's': case 'down': case 'door': return 0;
    case 'east':  case 'e': case 'right': return 90;
    case 'north': case 'n': case 'up': case 'window': return 180;
    case 'west':  case 'w': case 'left': return 270;
    default: return null;
  }
}

function wallDefaultFacingRot(wall) {
  switch ((wall || '').toLowerCase()) {
    case 'north': return 0;   // faces South (into room)
    case 'west':  return 90;  // faces East (into room)
    case 'east':  return 270; // faces West (into room)
    case 'south': return 180; // faces North (into room)
    case 'sw':    return 75;  // faces ENE perpendicular to angled SW wall
    default: return 0;
  }
}

function detectFinish(text) {
  const low = text.toLowerCase();
  for (const [alias, key] of FINISH_ALIASES) {
    const re = new RegExp(`\\b${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (re.test(low)) return key;
  }
  return null;
}

function detectCatalogId(text, preferPlaced = null) {
  const low = text.toLowerCase();
  // Explicit desk disambiguation
  if (/(42["”']?|42\s*inch|second|2nd|monitor)\s*(inch)?\s*(monitor)?\s*desk|42["”']?\s*monitor/.test(low)) {
    return 'desk_42_monitor';
  }
  const GENERIC_WORDS = new Set(['lamp', 'chair', 'rug', 'dresser', 'chest', 'table', 'bed', 'couch', 'desk', 'plant']);
  let bestId = null;
  let bestScore = -1;
  for (const [id, phrases] of CATALOG_SYNONYMS) {
    for (let idx = 0; idx < phrases.length; idx++) {
      const p = phrases[idx];
      if (!low.includes(p)) continue;
      // Avoid matching generic "chair" when user actually wrote "loveseat" or "armchair"
      if (id === 'markus_chair' && p === 'chair' && /loveseat|armchair|wing|poang|poäng|strandmon|jarvfjallet|järvfjället/.test(low)) {
        continue;
      }
      // Prefer exact primary product names and multi-word/longer specific phrases over generic single words
      let score = p.length * 2;
      if (idx === 0) score += 20;
      if (p.includes(' ')) score += 8;
      if (GENERIC_WORDS.has(p)) score -= 25;
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }
  }
  if (bestId) return bestId;
  if (/\bdesk\b/.test(low) && preferPlaced) {
    const d42 = preferPlaced.find((i) => i.catalogId === 'desk_42_monitor');
    if (d42 && /42|second|2nd|new/.test(low)) return d42.catalogId;
    const ret = preferPlaced.find((i) => i.catalogId === 'retained_wood_desk' || i.catalogId === 'retained_white_desk');
    if (ret) return ret.catalogId;
  }
  return null;
}

function resolvePlacedTarget(ref, items, selectedUid) {
  if (!ref) {
    return selectedUid ? items.find((i) => i.uid === selectedUid) || null : null;
  }
  const low = String(ref).toLowerCase().trim();
  if (low === 'selected' || low === 'it' || low === 'that' || low === 'this') {
    return selectedUid ? items.find((i) => i.uid === selectedUid) || null : null;
  }
  // Direct uid or catalogId match
  const byUid = items.find((i) => i.uid === ref || i.catalogId === ref);
  if (byUid) return byUid;
  const catId = detectCatalogId(low, items);
  if (catId) {
    const exact = items.find((i) => i.catalogId === catId);
    if (exact) return exact;
  }
  // Fuzzy name match
  return (
    items.find((i) => {
      const c = ALL_CATALOG[i.catalogId];
      return c && c.name.toLowerCase().includes(low);
    }) || null
  );
}

function resolveFinishForCat(cat, desiredFinish) {
  if (!desiredFinish) return cat.defaultFinish || 'white';
  if (cat.finishes && cat.finishes.includes(desiredFinish)) return desiredFinish;
  // Soft fallback mapping
  const fallbacks = {
    walnut: ['blackBrown', 'oak', 'birch'],
    oak: ['birch', 'pine', 'walnut'],
    blackBrown: ['walnut', 'matteBlack', 'darkGrey'],
    matteBlack: ['darkGrey', 'blackBrown'],
    darkGrey: ['matteBlack', 'slateBlue', 'lightGrey'],
    white: ['lightGrey', 'beige', 'birch'],
  };
  for (const fb of fallbacks[desiredFinish] || []) {
    if (cat.finishes && cat.finishes.includes(fb)) return fb;
  }
  return cat.defaultFinish || 'white';
}

const DESK_IDS_SET = new Set([
  'retained_wood_desk',
  'retained_white_desk',
  'desk_42_monitor',
  'mittzon_desk',
]);

const STORAGE_MESH_SET = new Set([
  'billy',
  'kallax',
  'tonstad_cabinet',
  'tonstad_hutch',
  'idanas_cabinet',
  'dresser_wide',
  'dresser_tall',
  'besta',
  'alex',
  'helmer',
  'wardrobe',
  'eket_wall',
  'trofast',
]);

const AGENT_PALETTES = {
  oak_white:    { name: 'Nordic Oak & Off-White', wood: 'oak',        storage: 'oak',       fabric: 'slateBlue', rug: 'beige',     lamp: 'matteBlack', plant: 'terracotta' },
  warm_birch:   { name: 'Warm Birch & Natural',   wood: 'birch',      storage: 'white',     fabric: 'beige',     rug: 'jute',      lamp: 'beige',      plant: 'sage' },
  walnut_slate: { name: 'Walnut & Slate Studio',  wood: 'walnut',     storage: 'stainedOak',fabric: 'darkGrey',  rug: 'lightGrey', lamp: 'matteBlack', plant: 'white' },
  scandi_pine:  { name: 'Scandi Pine & Cream',    wood: 'pine',       storage: 'white',     fabric: 'lightGrey', rug: 'beige',     lamp: 'white',      plant: 'terracotta' },
  espresso_oak: { name: 'Espresso & Oak Contrast',wood: 'blackBrown', storage: 'oak',       fabric: 'slateBlue', rug: 'lightGrey', lamp: 'matteBlack', plant: 'sage' },
};

function isDeskCat(c) {
  if (!c) return false;
  return DESK_IDS_SET.has(c.id) || c.meshType === 'ikea_desk' || (/\bdesk\b/i.test(`${c.name} ${c.subtitle}`) && c.category === 'tables');
}

function isChairCat(c) {
  if (!c) return false;
  return c.meshType === 'office_chair' || /office chair|desk chair|swivel chair/i.test(`${c.name} ${c.subtitle}`);
}

function isStorageCat(c) {
  if (!c) return false;
  return STORAGE_MESH_SET.has(c.meshType) || c.category === 'storage';
}

function resolvePaletteFinish(cat, paletteKey, explicitFinish) {
  if (explicitFinish) return resolveFinishForCat(cat, explicitFinish);
  const pal = AGENT_PALETTES[paletteKey];
  if (!pal) return cat.defaultFinish || 'white';
  let role = 'wood';
  if (cat.isRug) role = 'rug';
  else if (cat.isLamp) role = 'lamp';
  else if (cat.meshType === 'plant') role = 'plant';
  else if (isStorageCat(cat)) role = 'storage';
  else if (cat.category === 'seating' || cat.category === 'beds') role = 'fabric';
  return resolveFinishForCat(cat, pal[role] || pal.wood);
}

// Measure remaining continuous free wall runs (inches) on straight West, East, and North walls
function computeWallFreeRuns(items, room) {
  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;
  const flareL = room.swFlareLengthIn || 44;
  const straightWestMaxZ = halfL - flareL - 2;
  const closetSpan = 16;

  const freeSpanOnWall = (wall, minC, maxC) => {
    const blocked = [];
    for (const it of items) {
      const c = ALL_CATALOG[it.catalogId];
      if (!c || c.isRug || c.wallMounted || c.stackable) continue;
      const d = getItemDimensionsIn(it, c);
      const rad = (it.rotDeg * Math.PI) / 180;
      const ex = (Math.abs(d.w * Math.cos(rad)) + Math.abs(d.d * Math.sin(rad))) / 2;
      const ez = (Math.abs(d.w * Math.sin(rad)) + Math.abs(d.d * Math.cos(rad))) / 2;
      if (wall === 'west' && it.x - ex < -halfW + 18) blocked.push([it.z - ez, it.z + ez]);
      else if (wall === 'east' && it.x + ex > halfW - 18) blocked.push([it.z - ez, it.z + ez]);
      else if (wall === 'north' && it.z - ez < -halfL + 18) blocked.push([it.x - ex, it.x + ex]);
    }
    blocked.sort((a, b) => a[0] - b[0]);
    let cursor = minC;
    let maxGap = 0;
    let totalFree = 0;
    for (const [b0, b1] of blocked) {
      const s = Math.max(minC, b0);
      const e = Math.min(maxC, b1);
      if (e <= cursor) continue;
      if (s > cursor) {
        const g = s - cursor;
        totalFree += g;
        if (g > maxGap) maxGap = g;
      }
      cursor = Math.max(cursor, e);
    }
    if (maxC > cursor) {
      const g = maxC - cursor;
      totalFree += g;
      if (g > maxGap) maxGap = g;
    }
    return { maxRunIn: Math.round(maxGap), totalFreeIn: Math.round(totalFree) };
  };

  return {
    westStraight: freeSpanOnWall('west', -halfL, straightWestMaxZ),
    east: freeSpanOnWall('east', -halfL, halfL - closetSpan),
    north: freeSpanOnWall('north', -halfW, halfW),
  };
}

// 3-Pillar Interior Architecture Evaluator:
// Balances (1) Storage Capacity, (2) Aesthetics & Daylight Harmony, (3) Human Movement Traffic Efficiency (BFS reachability + aisle width)
export function scoreLayoutTriad(items, room) {
  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;
  const flareW = room.swFlareWidthIn || 0;
  const flareL = room.swFlareLengthIn || 44;

  // --- 1. Collision & Warning Audit ---
  let collisions = 0;
  let windowBlocks = 0;
  let doorBlocks = 0;
  let closetBlocks = 0;
  let tightWalkways = 0;
  const statusByUid = new Map();
  for (const it of items) {
    const c = ALL_CATALOG[it.catalogId];
    if (!c) continue;
    const st = checkPlacementStatus(it, items, ALL_CATALOG, room);
    statusByUid.set(it.uid, st);
    if (st.colliding) collisions++;
    for (const w of st.warnings) {
      if (w.includes('window')) windowBlocks++;
      else if (w.includes('entry door')) doorBlocks++;
      else if (w.includes('closet')) closetBlocks++;
      else if (w.includes('Tight walkway')) tightWalkways++;
    }
  }

  // --- 2. Storage Capacity Score (0..100) ---
  let storageCuFt = 0;
  let storageCount = 0;
  let tallOrWallBonus = 0;
  for (const it of items) {
    const c = ALL_CATALOG[it.catalogId];
    if (!c || !isStorageCat(c)) continue;
    const d = getItemDimensionsIn(it, c);
    const cuFt = (d.w * d.d * d.h) / 1728;
    storageCuFt += cuFt;
    storageCount++;
    if (c.wallMounted) tallOrWallBonus += 8; // Vertical storage with zero floor footprint!
    else if (d.h >= 60) tallOrWallBonus += 5;
  }
  // 55 cu ft (~2 tall cabinets + credenza or KALLAX 4x4 + BILLY) is a rich target for a 135 sq ft studio
  const storageScore = Math.min(100, Math.round((Math.min(storageCuFt, 62) / 62) * 82 + Math.min(18, tallOrWallBonus)));

  // --- 3. Human Movement & Traffic Efficiency Score (0..100) via 6" Grid BFS Walkability ---
  const CELL = 6;
  const minGridX = -halfW - flareW;
  const maxGridX = halfW;
  const minGridZ = -halfL;
  const maxGridZ = halfL;
  const cols = Math.max(8, Math.ceil((maxGridX - minGridX) / CELL));
  const rows = Math.max(8, Math.ceil((maxGridZ - minGridZ) / CELL));
  const blocked = new Uint8Array(cols * rows);

  // Build OBBs for solid floor obstacles (exclude rugs, wall shelves, stackable lamps, and office chairs tucked at desks)
  const obstacleBoxes = [];
  for (const it of items) {
    const c = ALL_CATALOG[it.catalogId];
    if (!c || c.isRug || c.wallMounted || c.stackable || isChairCat(c)) continue;
    const d = getItemDimensionsIn(it, c);
    const rad = (-it.rotDeg * Math.PI) / 180;
    obstacleBoxes.push({
      x: it.x,
      z: it.z,
      hw: d.w / 2 + 1.5,
      hd: d.d / 2 + 1.5,
      cos: Math.cos(rad),
      sin: Math.sin(rad),
    });
  }

  let totalFloorCells = 0;
  let openFloorCells = 0;
  for (let r = 0; r < rows; r++) {
    const cz = minGridZ + (r + 0.5) * CELL;
    const westEdge = cz > halfL - flareL && flareW > 0 && flareL > 0
      ? -halfW - flareW * Math.min(1, (cz - (halfL - flareL)) / flareL)
      : -halfW;
    for (let col = 0; col < cols; col++) {
      const cx = minGridX + (col + 0.5) * CELL;
      const idx = r * cols + col;
      if (cx < westEdge + 2 || cx > halfW - 2 || cz < -halfL + 2 || cz > halfL - 2) {
        blocked[idx] = 1;
        continue;
      }
      totalFloorCells++;
      let hit = false;
      for (let k = 0; k < obstacleBoxes.length; k++) {
        const b = obstacleBoxes[k];
        const dx = cx - b.x;
        const dz = cz - b.z;
        const lx = dx * b.cos + dz * b.sin;
        const lz = -dx * b.sin + dz * b.cos;
        if (Math.abs(lx) <= b.hw && Math.abs(lz) <= b.hd) {
          hit = true;
          break;
        }
      }
      if (hit) blocked[idx] = 1;
      else openFloorCells++;
    }
  }

  // BFS from entry doorway interior into the room
  const swX = -halfW - flareW;
  const startX = swX + (room.entryDoorOffsetFromWestIn || 4) + (room.entryDoorWidthIn || 32) * 0.5;
  const startZ = halfL - 12;
  const startCol = Math.max(0, Math.min(cols - 1, Math.floor((startX - minGridX) / CELL)));
  const startRow = Math.max(0, Math.min(rows - 1, Math.floor((startZ - minGridZ) / CELL)));

  const visited = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  let qHead = 0;
  let qTail = 0;
  // Seed BFS at doorway (find nearest open cell within 2 cells if needed)
  outerSeed: for (let rad = 0; rad <= 3; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        const rr = startRow + dr;
        const cc = startCol + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && !blocked[rr * cols + cc]) {
          const id0 = rr * cols + cc;
          visited[id0] = 1;
          queue[qTail++] = id0;
          break outerSeed;
        }
      }
    }
  }

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cr = Math.floor(cur / cols);
    const cc = cur - cr * cols;
    const nbrs = [
      [cr - 1, cc],
      [cr + 1, cc],
      [cr, cc - 1],
      [cr, cc + 1],
    ];
    for (let i = 0; i < 4; i++) {
      const nr = nbrs[i][0];
      const nc = nbrs[i][1];
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nid = nr * cols + nc;
      if (!blocked[nid] && !visited[nid]) {
        visited[nid] = 1;
        queue[qTail++] = nid;
      }
    }
  }

  const isPointReachable = (px, pz) => {
    const c0 = Math.max(0, Math.min(cols - 1, Math.floor((px - minGridX) / CELL)));
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor((pz - minGridZ) / CELL)));
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const rr = r0 + dr;
        const cc = c0 + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && visited[rr * cols + cc]) {
          return true;
        }
      }
    }
    return false;
  };

  // Check reachability of every desk, loveseat, bed, cabinet front, and SE closet
  let keyTargets = 1;
  let reachedTargets = isPointReachable(halfW - 26, halfL - 18) ? 1 : 0; // SE closet
  for (const it of items) {
    const c = ALL_CATALOG[it.catalogId];
    if (!c || c.isRug || c.wallMounted || c.stackable || isChairCat(c)) continue;
    if (isDeskCat(c) || c.id === 'retained_loveseat' || c.category === 'beds' || isStorageCat(c)) {
      keyTargets++;
      const d = getItemDimensionsIn(it, c);
      const rad = (it.rotDeg * Math.PI) / 180;
      const frontX = it.x + Math.sin(rad) * (d.d / 2 + 12);
      const frontZ = it.z + Math.cos(rad) * (d.d / 2 + 12);
      if (isPointReachable(frontX, frontZ)) reachedTargets++;
    }
  }

  // Measure average central corridor open width across the room's middle Z spine (z in [-56, +44])
  let spineRows = 0;
  let wideSpineRows = 0;
  let minSpineWidthIn = 111;
  for (let r = 0; r < rows; r++) {
    const cz = minGridZ + (r + 0.5) * CELL;
    if (cz < -56 || cz > 44) continue;
    let bestRun = 0;
    let curRun = 0;
    for (let col = 0; col < cols; col++) {
      if (visited[r * cols + col]) {
        curRun++;
        if (curRun > bestRun) bestRun = curRun;
      } else {
        curRun = 0;
      }
    }
    const runIn = bestRun * CELL;
    spineRows++;
    if (runIn >= 30) wideSpineRows++;
    if (runIn < minSpineWidthIn) minSpineWidthIn = runIn;
  }

  const reachRatio = reachedTargets / Math.max(1, keyTargets);
  const openRatio = openFloorCells / Math.max(1, totalFloorCells);
  const spineRatio = wideSpineRows / Math.max(1, spineRows);
  let trafficScore =
    reachRatio * 42 +
    Math.min(1, openRatio / 0.52) * 26 +
    spineRatio * 32 -
    doorBlocks * 24 -
    closetBlocks * 20 -
    tightWalkways * 14 -
    collisions * 35;
  if (minSpineWidthIn < 24) trafficScore -= 16;
  trafficScore = Math.max(0, Math.min(100, Math.round(trafficScore)));

  // --- 4. Aesthetics & Architectural Harmony Score (0..100) ---
  let aesScore = 64;
  // (a) Window daylight preservation
  if (windowBlocks === 0) aesScore += 14;
  else aesScore -= windowBlocks * 20;

  // (b) Finish palette cohesion (non-retained furniture)
  const finishSet = new Set();
  for (const it of items) {
    const c = ALL_CATALOG[it.catalogId];
    if (!c || c.retained || c.isRug || c.isLamp || c.meshType === 'plant') continue;
    if (it.finish) finishSet.add(it.finish);
  }
  if (finishSet.size >= 1 && finishSet.size <= 2) aesScore += 10;
  else if (finishSet.size === 3) aesScore += 4;
  else if (finishSet.size >= 4) aesScore -= 8;

  // (c) Flush cabinet clustering along same wall (rewards clean 0-3" built-in seams, penalizes messy 5-12" awkward gaps!)
  const wallStorage = { west: [], east: [], north: [] };
  for (const it of items) {
    const c = ALL_CATALOG[it.catalogId];
    if (!c || !isStorageCat(c) || c.wallMounted) continue;
    const d = getItemDimensionsIn(it, c);
    const rad = (it.rotDeg * Math.PI) / 180;
    const ex = (Math.abs(d.w * Math.cos(rad)) + Math.abs(d.d * Math.sin(rad))) / 2;
    const ez = (Math.abs(d.w * Math.sin(rad)) + Math.abs(d.d * Math.cos(rad))) / 2;
    if (it.x - ex < -halfW + 6) wallStorage.west.push({ c0: it.z - ez, c1: it.z + ez });
    else if (it.x + ex > halfW - 6) wallStorage.east.push({ c0: it.z - ez, c1: it.z + ez });
    else if (it.z - ez < -halfL + 6) wallStorage.north.push({ c0: it.x - ex, c1: it.x + ex });
  }
  for (const arr of Object.values(wallStorage)) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.c0 - b.c0);
    for (let i = 0; i + 1 < arr.length; i++) {
      const gap = arr[i + 1].c0 - arr[i].c1;
      if (gap >= -0.5 && gap <= 3.5) aesScore += 6;
      else if (gap > 4 && gap < 12) aesScore -= 4;
    }
  }

  // (d) West vs East visual balance + rug grounding + chair-to-desk alignment
  let westMass = 0;
  let eastMass = 0;
  let hasRug = false;
  const desks = [];
  const chairs = [];
  for (const it of items) {
    const c = ALL_CATALOG[it.catalogId];
    if (!c) continue;
    if (c.isRug) { hasRug = true; continue; }
    if (isDeskCat(c)) desks.push(it);
    if (isChairCat(c)) chairs.push(it);
    const d = getItemDimensionsIn(it, c);
    const area = d.w * d.d;
    if (it.x < -8) westMass += area;
    else if (it.x > 8) eastMass += area;
  }
  if (hasRug) aesScore += 5;
  if (westMass > 0 && eastMass > 0) {
    const balRatio = Math.min(westMass, eastMass) / Math.max(westMass, eastMass);
    if (balRatio >= 0.45) aesScore += 6;
  }
  // Reward 1-to-1 desk-to-chair pairing and penalize orphaned chairs floating away from their desk
  const usedChairUids = new Set();
  for (const d of desks) {
    let bestCh = null;
    let bestDist = Infinity;
    for (const ch of chairs) {
      if (usedChairUids.has(ch.uid)) continue;
      const dist = Math.hypot(ch.x - d.x, ch.z - d.z);
      if (dist < bestDist) {
        bestDist = dist;
        bestCh = ch;
      }
    }
    if (bestCh && bestDist <= 34) {
      usedChairUids.add(bestCh.uid);
      aesScore += 4;
    }
  }
  const orphanChairs = chairs.length - usedChairUids.size;
  if (orphanChairs > 0 && desks.length > 0) {
    aesScore -= orphanChairs * 12;
  }
  aesScore -= collisions * 25;
  aesScore = Math.max(0, Math.min(100, Math.round(aesScore)));

  const overall = Math.round(storageScore * 0.33 + aesScore * 0.33 + trafficScore * 0.34);

  return {
    overall,
    storage: storageScore,
    storageCuFt: +storageCuFt.toFixed(1),
    storageCount,
    aesthetics: aesScore,
    traffic: trafficScore,
    minCorridorIn: Math.round(minSpineWidthIn),
    reachRatio: +(reachRatio * 100).toFixed(0),
    collisions,
    windowBlocks,
    doorBlocks,
    closetBlocks,
    tightWalkways,
    statusByUid,
  };
}

export function computeRoomAudit(state) {
  const triad = scoreLayoutTriad(state.items, state.room);
  const freeWalls = computeWallFreeRuns(state.items, state.room);
  const collisionDetails = [];
  const warningDetails = [];
  let ikeaCost = 0;
  let ikeaCount = 0;

  for (const it of state.items) {
    const c = ALL_CATALOG[it.catalogId];
    if (!c) continue;
    if (!c.retained && c.brand === 'IKEA') {
      ikeaCost += c.price;
      ikeaCount++;
    }
    const st = triad.statusByUid.get(it.uid);
    if (!st) continue;
    if (st.colliding) collisionDetails.push(`${c.name}: ${st.warnings.join(', ')}`);
    else if (st.warningOnly) warningDetails.push(`${c.name}: ${st.warnings.join(', ')}`);
  }

  return {
    triad,
    freeWalls,
    collisionDetails,
    warningDetails,
    ikeaCost,
    ikeaCount,
  };
}

// Compute flush-adjacent wall coordinates next to existing items on the same wall
function buildFlushWallCandidates(catalogId, dims, wall, rot, otherItems, room) {
  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;
  const out = [];
  const rad = (rot * Math.PI) / 180;
  const myEx = (Math.abs(dims.w * Math.cos(rad)) + Math.abs(dims.d * Math.sin(rad))) / 2;
  const myEz = (Math.abs(dims.w * Math.sin(rad)) + Math.abs(dims.d * Math.cos(rad))) / 2;

  for (const other of otherItems) {
    const oCat = ALL_CATALOG[other.catalogId];
    if (!oCat || oCat.isRug || oCat.wallMounted || oCat.stackable) continue;
    const oDim = getItemDimensionsIn(other, oCat);
    const oRad = (other.rotDeg * Math.PI) / 180;
    const oEx = (Math.abs(oDim.w * Math.cos(oRad)) + Math.abs(oDim.d * Math.sin(oRad))) / 2;
    const oEz = (Math.abs(oDim.w * Math.sin(oRad)) + Math.abs(oDim.d * Math.cos(oRad))) / 2;

    if (wall === 'west' && other.x - oEx < -halfW + 8) {
      out.push({ x: -halfW + myEx, z: other.z - oEz - myEz - 0.5, rotDeg: rot, flush: true });
      out.push({ x: -halfW + myEx, z: other.z + oEz + myEz + 0.5, rotDeg: rot, flush: true });
    } else if (wall === 'east' && other.x + oEx > halfW - 8) {
      out.push({ x: halfW - myEx, z: other.z - oEz - myEz - 0.5, rotDeg: rot, flush: true });
      out.push({ x: halfW - myEx, z: other.z + oEz + myEz + 0.5, rotDeg: rot, flush: true });
    } else if (wall === 'north' && other.z - oEz < -halfL + 8) {
      out.push({ x: other.x - oEx - myEx - 0.5, z: -halfL + myEz, rotDeg: rot, flush: true });
      out.push({ x: other.x + oEx + myEx + 0.5, z: -halfL + myEz, rotDeg: rot, flush: true });
    }
  }
  return out;
}

// Smart collision-free spatial candidate search with dense 4" sweeps, zone bias, flush-cabinet snapping, and strict collision rejection
function findBestPlacement(catalogId, opts, items, room, excludeUid = null) {
  const cat = ALL_CATALOG[catalogId];
  if (!cat) return null;
  const dims = getItemDimensionsIn({ expanded: false }, cat);
  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;
  const flareL = room.swFlareLengthIn || 44;
  const straightWestMaxZ = halfL - flareL - 2;
  const otherItems = excludeUid ? items.filter((i) => i.uid !== excludeUid) : items;

  const wall = (opts.wall || '').toLowerCase();
  const corner = (opts.corner || '').toLowerCase();
  const zone = (opts.zone || '').toLowerCase();
  const facingRot = facingToRotDeg(opts.facing);
  const allowColliding = opts.allowColliding === true;
  const candidates = [];

  const zoneBias = (x, z) => {
    if (!zone) return 0;
    if (zone === 'north') return Math.max(0, (z + halfL) * 0.22);
    if (zone === 'south') return Math.max(0, (halfL - z) * 0.22);
    if (zone === 'west') return Math.max(0, (x + halfW) * 0.22);
    if (zone === 'east') return Math.max(0, (halfW - x) * 0.22);
    if (zone === 'center') return Math.hypot(x, z + 6) * 0.2;
    return 0;
  };

  const pushCand = (x, z, rotDeg, wallSnap = true, prefBias = 0) => {
    const r = normDeg(rotDeg);
    const snapped = clampAndSnapToRoom(x, z, dims.w, dims.d, r, room, { gridSnapIn: 1, wallSnap });
    const cand = {
      uid: excludeUid || '__probe__',
      catalogId,
      x: snapped.x,
      z: snapped.z,
      rotDeg: r,
      expanded: false,
      ...(typeof opts.mountHeightIn === 'number' ? { mountHeightIn: opts.mountHeightIn } : {}),
    };
    const st = checkPlacementStatus(cand, otherItems, ALL_CATALOG, room);
    let score = prefBias + zoneBias(snapped.x, snapped.z);
    if (st.colliding) score += 20000;
    else if (st.warningOnly) score += 800 * st.warnings.length;
    candidates.push({ x: snapped.x, z: snapped.z, rotDeg: r, status: st, score });
  };

  // Explicit coordinates (when given, test micro-offsets AND auto-corrected wall-facing rotations)
  if (typeof opts.x === 'number' && typeof opts.z === 'number') {
    const r = typeof opts.rotDeg === 'number' ? opts.rotDeg : (facingRot ?? 0);
    pushCand(opts.x, opts.z, r, opts.wallSnap !== false, 0);
    for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4], [10, 0], [-10, 0], [0, 10], [0, -10]]) {
      pushCand(opts.x + dx, opts.z + dz, r, false, Math.hypot(dx, dz) * 0.6);
    }
  }

  // Relative to another placed item (e.g., chair in front of desk, rug under loveseat, cabinet flush beside sibling)
  if (opts.nearItem) {
    const anchor = opts.nearItem;
    const aCat = ALL_CATALOG[anchor.catalogId];
    const aDims = getItemDimensionsIn(anchor, aCat);
    const rad = (anchor.rotDeg * Math.PI) / 180;
    const fx = Math.sin(rad);
    const fz = Math.cos(rad);
    const rx = Math.cos(rad);
    const rz = -Math.sin(rad);
    const rel = (opts.relation || 'near').toLowerCase();

    if (cat.stackable && aCat && aCat.isSurface && (rel === 'on' || rel === 'near' || rel === 'beside')) {
      const sideOff = Math.max(0, aDims.w / 2 - dims.w / 2 - 3);
      pushCand(anchor.x + rx * sideOff - fx * 3, anchor.z + rz * sideOff - fz * 3, facingRot ?? anchor.rotDeg, false, 0);
      pushCand(anchor.x - rx * sideOff - fx * 3, anchor.z - rz * sideOff - fz * 3, facingRot ?? anchor.rotDeg, false, 1);
      pushCand(anchor.x, anchor.z, facingRot ?? anchor.rotDeg, false, 2);
    } else if (cat.isRug || rel === 'under') {
      pushCand(anchor.x + fx * 10, anchor.z + fz * 10, facingRot ?? 0, false, 0);
      pushCand(anchor.x, anchor.z, facingRot ?? 0, false, 2);
      pushCand(0, -12, facingRot ?? 0, false, 8);
    } else if (rel === 'in_front' || isChairCat(cat)) {
      // Office chairs can now tuck cleanly under desks! Test natural tucked & seated distances
      const rot = facingRot ?? normDeg(anchor.rotDeg + 180);
      const baseDist = isChairCat(cat) && isDeskCat(aCat)
        ? aDims.d / 2 + dims.d / 2 - 4
        : aDims.d / 2 + dims.d / 2 + 4;
      for (const delta of [0, 4, -4, 8, -8, 12]) {
        pushCand(anchor.x + fx * (baseDist + delta), anchor.z + fz * (baseDist + delta), rot, false, Math.abs(delta) * 0.8);
      }
    } else {
      // Flush beside anchor along its wall/tangent
      const sideDist = aDims.w / 2 + dims.w / 2 + 0.5;
      const rot = facingRot ?? anchor.rotDeg;
      for (const s of [1, -1]) {
        for (const extra of [0, 2, 6, 12]) {
          pushCand(anchor.x + rx * s * (sideDist + extra), anchor.z + rz * s * (sideDist + extra), rot, true, extra * 1.2);
        }
      }
    }
  }

  // Corner placements
  if (corner) {
    const cornerMap = {
      nw: { x: -halfW + 16, z: -halfL + 16, rots: [0, 90] },
      ne: { x: halfW - 16,  z: -halfL + 16, rots: [0, 270] },
      se: { x: halfW - 16,  z: halfL - 32,  rots: [270, 180] },
      sw: { x: -halfW + 14, z: straightWestMaxZ - 8, rots: [90, 75] },
      center: { x: 0, z: -10, rots: [0, 90, 270] },
    };
    const cDef = cornerMap[corner] || cornerMap.center;
    const rots = facingRot !== null ? [facingRot] : cDef.rots;
    for (const r of rots) {
      for (let dx = -16; dx <= 16; dx += 4) {
        for (let dz = -16; dz <= 16; dz += 4) {
          pushCand(cDef.x + dx, cDef.z + dz, r, corner !== 'center', Math.hypot(dx, dz) * 0.7);
        }
      }
    }
  }

  // Helper: dense 4" sweep along a named wall (plus flush-to-sibling priority spots!)
  const sweepWall = (wName, baseBias = 0) => {
    const rot = facingRot !== null ? facingRot : wallDefaultFacingRot(wName);
    // Prioritize flush alignment right beside existing furniture on this wall!
    const flushCands = buildFlushWallCandidates(catalogId, dims, wName, rot, otherItems, room);
    for (const fc of flushCands) {
      pushCand(fc.x, fc.z, fc.rotDeg, true, baseBias - 6);
    }
    if (wName === 'west') {
      for (let z = -halfL + 8; z <= straightWestMaxZ; z += 4) {
        pushCand(-halfW + dims.d / 2 + 1, z, rot, true, baseBias);
      }
    } else if (wName === 'east') {
      for (let z = -halfL + 8; z <= halfL - 18; z += 4) {
        pushCand(halfW - dims.d / 2 - 1, z, rot, true, baseBias);
      }
    } else if (wName === 'north') {
      for (let x = -halfW + 8; x <= halfW - 8; x += 4) {
        pushCand(x, -halfL + dims.d / 2 + 1, rot, true, baseBias);
      }
    } else if (wName === 'south') {
      for (let x = -28; x <= 14; x += 4) {
        pushCand(x, halfL - dims.d / 2 - 18, rot, false, baseBias);
      }
    } else if (wName === 'sw') {
      for (let z = straightWestMaxZ - 14; z <= halfL - 22; z += 4) {
        pushCand(-halfW + dims.d / 2 + 1, z, rot, true, baseBias);
      }
    }
  };

  if (wall) {
    sweepWall(wall, 0);
  }

  // Dense fallback across all usable walls/interior if no spot requested or requested wall was blocked/warned
  if (candidates.length === 0 || candidates.every((c) => c.score >= 600)) {
    if (cat.isRug) {
      for (const [rx, rz] of [[0, -10], [4, -14], [-4, -8], [0, 4], [0, -24]]) {
        pushCand(rx, rz, facingRot ?? 0, false, 15);
      }
    } else if (cat.meshType === 'coffee_rect' || cat.meshType === 'coffee_round') {
      for (const [cx, cz] of [[0, -18], [6, -24], [-6, -24], [0, -6], [8, -10], [-8, -10]]) {
        pushCand(cx, cz, facingRot ?? 0, false, 18);
      }
    } else {
      const order = wall === 'east' ? ['west', 'north', 'east'] : ['west', 'east', 'north'];
      for (let i = 0; i < order.length; i++) {
        if (order[i] === wall) continue;
        sweepWall(order[i], 35 + i * 10);
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0] || null;
  if (!best) return null;
  if (best.status.colliding && !allowColliding) return null;
  return best;
}

// Declarative Multi-Restart Whole-Room Constraint Solver (balances Storage, Aesthetics & Human Movement Traffic!)
function solveConstrainedLayout(spec, state) {
  const room = state.room;
  const hotlistArr = Array.isArray(state.hotlistIds) ? state.hotlistIds : [];
  const hotSet = state.hotlistOnly && hotlistArr.length > 0 ? new Set(hotlistArr) : null;
  const paletteKey = spec.palette && AGENT_PALETTES[spec.palette] ? spec.palette : 'oak_white';
  const rawList = Array.isArray(spec.items) ? spec.items : [];

  // Normalize & filter requested items (always preserve retained pieces unless explicitly removed)
  const blockedHotlist = [];
  const unknownCatalogIds = [];
  const normalized = [];
  const hasRetainedLove = rawList.some((r) => r.catalogId === 'retained_loveseat');
  const hasRetainedDesk = rawList.some((r) => r.catalogId === 'retained_wood_desk' || r.catalogId === 'retained_white_desk');

  for (const r of rawList) {
    const cid = r.catalogId;
    const cat = ALL_CATALOG[cid];
    if (!cat) {
      if (cid) unknownCatalogIds.push(`unknown_id(${cid})`);
      continue;
    }
    if (hotSet && !cat.retained && cat.brand !== 'Move-In' && !hotSet.has(cid)) {
      blockedHotlist.push(cat.name);
      continue;
    }
    let rel = r.relation || (r.flushWith ? 'beside' : null);
    if (rel === 'at_desk') rel = 'in_front';
    else if (rel === 'next_to') rel = 'beside';
    normalized.push({
      catalogId: cid,
      wall: r.wall || null,
      corner: r.corner || null,
      zone: r.zone || null,
      facing: r.facing || null,
      near: r.near || r.target || r.nearTarget || r.flushWith || null,
      relation: rel,
      finish: resolvePaletteFinish(cat, paletteKey, r.finish),
      frontStyle: r.frontStyle || cat.defaultFrontStyle || null,
      frontFinish: r.frontFinish || null,
      hardware: r.hardware || 'auto',
      doorsOpen: !!r.doorsOpen,
      mountHeightIn: typeof r.mountHeightIn === 'number' ? r.mountHeightIn : (cat.mountHeightIn ?? null),
    });
  }

  // Ensure user's retained desk & loveseat stay in the room unless explicitly excluded via keepRetained: false
  if (spec.keepRetained !== false) {
    if (!hasRetainedLove && ALL_CATALOG.retained_loveseat) {
      normalized.push({
        catalogId: 'retained_loveseat',
        wall: null,
        zone: null,
        facing: null,
        finish: 'slateBlue',
      });
    }
    if (!hasRetainedDesk) {
      const rDeskId = state.retainedDeskId || 'retained_wood_desk';
      const rCat = ALL_CATALOG[rDeskId] || ALL_CATALOG.retained_wood_desk;
      normalized.push({
        catalogId: rCat.id,
        wall: null,
        zone: null,
        finish: rCat.defaultFinish,
      });
    }
  }

  // Assign strict interior-design placement phase so big anchors never get blocked by small clutter
  const phaseOf = (entry) => {
    const c = ALL_CATALOG[entry.catalogId];
    if (!c) return 9;
    if (c.isRug) return 0;
    if (isDeskCat(c) || c.id === 'retained_loveseat' || c.category === 'beds' || c.meshType === 'sofa' || c.meshType === 'sectional') return 1;
    if (isStorageCat(c) && !c.wallMounted) return 2;
    if (isChairCat(c)) return 3;
    if (c.stackable || c.isLamp || c.meshType === 'plant') return 4;
    if (c.wallMounted) return 5;
    return 2;
  };

  // Run 20 fast restarts with slight within-phase ordering & wall-sweep perturbations, pick highest composite score!
  let bestResult = null;
  const RESTARTS = 20;

  for (let pass = 0; pass < RESTARTS; pass++) {
    const ordered = [...normalized].sort((a, b) => {
      const pa = phaseOf(a);
      const pb = phaseOf(b);
      if (pa !== pb) return pa - pb;
      const ca = ALL_CATALOG[a.catalogId];
      const cb = ALL_CATALOG[b.catalogId];
      const areaDiff = cb.w * cb.d - ca.w * ca.d;
      if (pass === 0) return areaDiff;
      return areaDiff + (Math.random() - 0.5) * 900;
    });

    const placed = [];
    const unplaced = [];
    let intentBonus = 0;
    let uidSeq = 1;

    for (const req of ordered) {
      const cat = ALL_CATALOG[req.catalogId];
      let nearItem = null;
      if (req.near) {
        nearItem = placed.find((p) => p.catalogId === req.near) || null;
      } else if (isChairCat(cat)) {
        // Automatically pair unpaired office chairs to an unpaired placed desk!
        const desks = placed.filter((p) => isDeskCat(ALL_CATALOG[p.catalogId]));
        nearItem = desks.find((d) => !placed.some((p) => isChairCat(ALL_CATALOG[p.catalogId]) && Math.hypot(p.x - d.x, p.z - d.z) < 40)) || desks[0] || null;
      }

      // On later restarts, gently diversify zone if default wall was crowded
      const altZone = pass > 4 && !req.zone ? (pass % 2 === 0 ? 'north' : 'south') : req.zone;

      const spot = findBestPlacement(
        req.catalogId,
        {
          wall: req.wall,
          corner: req.corner,
          zone: altZone,
          facing: req.facing,
          nearItem,
          relation: req.relation || (isChairCat(cat) && nearItem ? 'in_front' : null),
          mountHeightIn: req.mountHeightIn,
          allowColliding: false,
        },
        placed,
        room
      );

      if (!spot) {
        unplaced.push(cat.name);
        continue;
      }

      // Bonus for honoring explicit requested wall
      if (req.wall) {
        const halfW = room.widthIn / 2;
        const halfL = room.lengthIn / 2;
        if (
          (req.wall === 'west' && spot.x < -halfW + 32) ||
          (req.wall === 'east' && spot.x > halfW - 32) ||
          (req.wall === 'north' && spot.z < -halfL + 32)
        ) {
          intentBonus += 18;
        }
      }

      placed.push({
        uid: `solve_${uidSeq++}`,
        catalogId: req.catalogId,
        x: spot.x,
        z: spot.z,
        rotDeg: spot.rotDeg,
        finish: req.finish,
        expanded: false,
        ...(req.frontStyle ? { frontStyle: req.frontStyle } : {}),
        ...(req.frontFinish ? { frontFinish: req.frontFinish } : {}),
        ...(req.hardware && req.hardware !== 'auto' ? { hardware: req.hardware } : {}),
        ...(req.doorsOpen ? { doorsOpen: true } : {}),
        ...(typeof req.mountHeightIn === 'number' ? { mountHeightIn: req.mountHeightIn } : {}),
      });
    }

    const triad = scoreLayoutTriad(placed, room);
    const totalScore =
      placed.length * 1000 -
      unplaced.length * 600 +
      triad.overall * 8 +
      intentBonus -
      triad.collisions * 5000 -
      (triad.windowBlocks + triad.doorBlocks + triad.closetBlocks) * 450;

    if (!bestResult || totalScore > bestResult.totalScore) {
      bestResult = {
        placed,
        unplaced: [...unplaced, ...unknownCatalogIds],
        blockedHotlist,
        triad,
        totalScore,
        paletteName: AGENT_PALETTES[paletteKey]?.name || paletteKey,
      };
    }
  }

  return bestResult;
}

// Parse a single clause into one or more structured tool calls
function parseClause(clause, state) {
  const low = clause.toLowerCase().trim();
  if (!low) return [];

  // 1. Undo
  if (/^(undo|revert|go back|ctrl\s*\+?\s*z)\b/.test(low)) {
    return [{ tool: 'undo', args: {} }];
  }

  // 2. Audit / check clearances / fit report
  if (/(audit|check|inspect|analyze|measure|how much|budget|cost|clearance|fit|conflict|collision|report|glare)/.test(low) && !/(add|move|put|place|remove|delete|rotate|turn|switch|set|try|load|make)/.test(low)) {
    return [{ tool: 'audit_layout', args: {} }];
  }

  // 3. View / Lighting / Wall mode commands
  if (/(evening|night|dark mode|warm light|dim light)/.test(low)) {
    return [{ tool: 'set_lighting', args: { mood: 'evening' } }];
  }
  if (/(daytime|day light|daylight|bright light|morning)/.test(low)) {
    return [{ tool: 'set_lighting', args: { mood: 'day' } }];
  }
  if (/\b2d\b|top[\s-]down|floor\s*plan|overhead/.test(low)) {
    return [{ tool: 'set_view', args: { mode: '2d' } }];
  }
  if (/eye[\s-]level|first[\s-]person|walkthrough|inside view/.test(low)) {
    return [{ tool: 'set_view', args: { mode: 'fp' } }];
  }
  if (/\b3d\b|isometric|iso view|exit eye/.test(low)) {
    return [{ tool: 'set_view', args: { mode: '3d' } }];
  }
  if (/walls?\s+up|show\s+walls/.test(low)) {
    return [{ tool: 'set_walls', args: { mode: 'up' } }];
  }
  if (/walls?\s+(down|low)|low\s+walls/.test(low)) {
    return [{ tool: 'set_walls', args: { mode: 'down' } }];
  }
  if (/cutaway/.test(low)) {
    return [{ tool: 'set_walls', args: { mode: 'cutaway' } }];
  }

  // 4. Considering Hotlist / Dual-Office & Room Preset / Optimizer triggers
  const hasHotlist = Array.isArray(state.hotlistIds) && state.hotlistIds.length > 0;
  if (/(hotlist|considering|shortlist|pre[\s-]?cart|my\s+picks|my\s+list)/.test(low)) {
    let goal = /dual|two|2\s*desk/.test(low) ? 'dual_office' : 'any';
    return [{ tool: 'run_optimizer', args: { goal, forceHotlist: true } }];
  }

  if (/(dual|two|2)\s*(home\s*)?(office|desk|workstation|setup)|both desks/.test(low)) {
    if (state.hotlistOnly && hasHotlist) {
      return [{ tool: 'run_optimizer', args: { goal: 'dual_office', forceHotlist: true } }];
    }
    if (/tandem|side[\s-]by[\s-]side|both desks.*west|along.*west/.test(low)) {
      return [{ tool: 'load_preset', args: { presetKey: 'dual_tandem_west' } }];
    }
    if (/l[\s-]?corner|l[\s-]?shape|north\s*window/.test(low)) {
      return [{ tool: 'load_preset', args: { presetKey: 'dual_l_corner' } }];
    }
    if (/glare|split|privacy|perpendicular/.test(low)) {
      return [{ tool: 'load_preset', args: { presetKey: 'dual_glare_free' } }];
    }
    if (/baseline|minimal|move[\s-]?in\s*only|no\s*ikea|\$0/.test(low)) {
      return [{ tool: 'load_preset', args: { presetKey: 'dual_movein_baseline' } }];
    }
    if (/face[\s-]?off|opposite|parallel|east.*west|west.*east/.test(low)) {
      return [{ tool: 'load_preset', args: { presetKey: 'dual_parallel' } }];
    }
    if (/shuffle|random|suggest|optimize|another|idea|scenario/.test(low)) {
      return [{ tool: 'run_optimizer', args: { goal: 'dual_office' } }];
    }
    return [{ tool: 'load_preset', args: { presetKey: 'dual_parallel' } }];
  }

  if (/(shuffle|optimize|suggest|recommend|auto[\s-]?layout|surprise me|arrange)/.test(low)) {
    let goal = 'dual_office';
    if (/guest|bed|daybed/.test(low)) goal = 'guest';
    else if (/library|book|reading/.test(low)) goal = 'library';
    else if (/kid|kura/.test(low)) goal = 'kids';
    else if (/single|one desk/.test(low)) goal = 'office';
    else if (/any|surprise/.test(low)) goal = 'any';
    return [{ tool: 'run_optimizer', args: { goal } }];
  }

  if (/retained\s*only|reset\s*room|start\s*over|clean\s*slate/.test(low)) {
    return [{ tool: 'load_preset', args: { presetKey: 'retained_only' } }];
  }
  if (/guest\s*(room|suite|office)/.test(low) && /(load|try|preset|switch|make)/.test(low)) {
    return [{ tool: 'load_preset', args: { presetKey: 'guest_office' } }];
  }
  if (/kids?\s*(room|study)/.test(low) && /(load|try|preset|switch|make)/.test(low)) {
    return [{ tool: 'load_preset', args: { presetKey: 'kids_study' } }];
  }

  // 5. Clear IKEA / Remove items
  if (/(clear|remove|delete)\s+(all\s+)?ikea/.test(low)) {
    return [{ tool: 'clear_ikea', args: {} }];
  }
  if (/^(remove|delete|drop|get rid of|hide)\b/.test(low)) {
    const catId = detectCatalogId(low, state.items);
    return [{ tool: 'remove_item', args: { target: catId || 'selected' } }];
  }

  // 6. Swap retained desk
  if (/(keep|use|switch to|swap to).*(white\s*(corner\s*)?desk)/.test(low)) {
    return [{ tool: 'swap_retained_desk', args: { variant: 'retained_white_desk' } }];
  }
  if (/(keep|use|switch to|swap to).*(wood\s*(standing\s*)?desk)/.test(low)) {
    return [{ tool: 'swap_retained_desk', args: { variant: 'retained_wood_desk' } }];
  }

  // 7. Pair office chairs to all desks
  if (/(pair|add|match|put)\s*(both\s*)?(office\s*)?chairs?(\s*for\s*(both\s*)?desks?)?$/.test(low) || /pair\s*chairs/.test(low)) {
    return [{ tool: 'pair_office_chairs', args: {} }];
  }

  // 8. Pull out / fold HEMNES daybed
  if (/(pull\s*out|expand|open)\s*(the\s*)?(hemnes|daybed)/.test(low)) {
    return [{ tool: 'toggle_daybed', args: { expanded: true } }];
  }
  if (/(fold|close|collapse)\s*(the\s*)?(hemnes|daybed)/.test(low)) {
    return [{ tool: 'toggle_daybed', args: { expanded: false } }];
  }

  // 9. Nudge (e.g. "nudge the wood desk 50cm north", "shift loveseat 12 inches west")
  if (/(nudge|shift|slide|push)\b/.test(low)) {
    const target = detectCatalogId(low, state.items) || 'selected';
    let distIn = 10; // default ~25cm
    const cmM = low.match(/(\d+(?:\.\d+)?)\s*cm\b/);
    const mM = low.match(/(\d+(?:\.\d+)?)\s*m(?:eters?)?\b/);
    const ftM = low.match(/(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')\b/);
    const inM = low.match(/(\d+(?:\.\d+)?)\s*(?:in|inches|")\b/);
    if (cmM) distIn = parseFloat(cmM[1]) / 2.54;
    else if (mM) distIn = parseFloat(mM[1]) * 39.37;
    else if (ftM) distIn = parseFloat(ftM[1]) * 12;
    else if (inM) distIn = parseFloat(inM[1]);

    let dxIn = 0, dzIn = 0;
    if (/\b(north|up)\b/.test(low)) dzIn -= distIn;
    if (/\b(south|down)\b/.test(low)) dzIn += distIn;
    if (/\b(east|right)\b/.test(low)) dxIn += distIn;
    if (/\b(west|left)\b/.test(low)) dxIn -= distIn;
    if (dxIn !== 0 || dzIn !== 0) {
      return [{ tool: 'nudge_item', args: { target, dxIn: Math.round(dxIn), dzIn: Math.round(dzIn) } }];
    }
  }

  // 10. Rotate / face
  if (/(rotate|turn|spin|flip)\b/.test(low) && !/(move|put|place|add)\b/.test(low)) {
    const target = detectCatalogId(low, state.items) || 'selected';
    const degM = low.match(/(\d+)\s*(?:deg|degrees|°)/);
    const mag = degM ? parseInt(degM[1], 10) : 90;
    if (/\bleft\b|\bccw\b|counter/.test(low)) {
      return [{ tool: 'rotate_item', args: { target, deltaDeg: -mag } }];
    }
    if (/\bright\b|\bcw\b|clockwise/.test(low)) {
      return [{ tool: 'rotate_item', args: { target, deltaDeg: mag } }];
    }
    if (/facing\s+(north|south|east|west|window|door)/.test(low)) {
      const f = low.match(/facing\s+(north|south|east|west|window|door)/)[1];
      return [{ tool: 'rotate_item', args: { target, facing: f } }];
    }
    return [{ tool: 'rotate_item', args: { target, deltaDeg: mag } }];
  }

  // 11. Finish / color change (single item or all items)
  if (/(finish|color|colour|paint|swap.*to|change.*to|make.*(walnut|oak|white|birch|pine|black|grey|gray|sage|beige|terracotta|slate))/.test(low) && !/(move|put|place|add|buy|insert)\b/.test(low)) {
    const fin = detectFinish(low);
    if (fin) {
      const isAll = /\b(all|everything|room|palette|finishes)\b/.test(low);
      const target = isAll ? 'all' : (detectCatalogId(low, state.items) || 'selected');
      return [{ tool: 'set_finish', args: { target, finish: fin } }];
    }
  }

  // 12. Parse spatial modifiers for ADD or MOVE
  let wall = null;
  if (/north\s*(wall|window)|\bwindow\s*wall\b/.test(low)) wall = 'north';
  else if (/east\s*(wall|window)/.test(low)) wall = 'east';
  else if (/angled|sw\s*wall|southwest\s*wall/.test(low)) wall = 'sw';
  else if (/west\s*wall/.test(low)) wall = 'west';
  else if (/south\s*wall/.test(low)) wall = 'south';

  let corner = null;
  if (/\b(nw|north[\s-]?west)\b/.test(low)) corner = 'nw';
  else if (/\b(ne|north[\s-]?east)\b/.test(low)) corner = 'ne';
  else if (/\b(se|south[\s-]?east)\b/.test(low)) corner = 'se';
  else if (/\b(sw|south[\s-]?west)\b/.test(low) && !wall) corner = 'sw';
  else if (/\bcenter\b|\bmiddle\b/.test(low)) corner = 'center';

  let facing = null;
  const fMatch = low.match(/facing\s+(north|south|east|west|window|door)/);
  if (fMatch) facing = fMatch[1];

  const finish = detectFinish(low);
  let count = 1;
  if (/\b(two|2|pair of|couple of)\b/.test(low) && !/2nd|42|4x2|4×2|2-seat/.test(low)) count = 2;

  // Detect relative target ("on top of X", "on X", "in front of X", "next to X", "under X", "beside X")
  let relation = null;
  let nearTarget = null;
  const relMatch = low.match(/\b(on top of|in front of|under|underneath|beside|next to|behind|by|near|on)\s+(?:the\s+)?(.+?)(?:\s+(?:facing|against|in|with)\b|$)/);
  if (relMatch) {
    const rPhrase = relMatch[1];
    const rhs = relMatch[2];
    if (rPhrase === 'on top of' || rPhrase === 'on') relation = 'on';
    else if (rPhrase.includes('front')) relation = 'in_front';
    else if (rPhrase.includes('under')) relation = 'under';
    else relation = 'beside';
    if (!/wall|corner|window|door|closet/.test(rhs)) {
      nearTarget = detectCatalogId(rhs, state.items) || (/\bit\b|\bthat\b/.test(rhs) ? 'selected' : null);
    } else if (/north\s*window/.test(rhs) && !wall) {
      wall = 'north';
    }
  }

  // Strip the relative tail before detecting the primary subject item
  const subjectText = relMatch ? low.slice(0, relMatch.index) : low;
  const subjectCatId = detectCatalogId(subjectText, state.items) || detectCatalogId(low, state.items);

  if (subjectCatId) {
    const isExplicitAdd = /\b(add|buy|insert|bring|drop in|include|get|new)\b/.test(low);
    const isExplicitMove = /\b(move|put|place|relocate|reposition|slide|snap|set)\b/.test(low);
    const alreadyPlaced = state.items.some((i) => i.catalogId === subjectCatId);

    if (isExplicitAdd || (!alreadyPlaced && (isExplicitMove || wall || corner || nearTarget))) {
      return [{
        tool: 'add_item',
        args: { catalogId: subjectCatId, wall, corner, nearTarget, relation, facing, finish, count },
      }];
    }
    if (alreadyPlaced && (isExplicitMove || wall || corner || nearTarget || facing)) {
      return [{
        tool: 'move_item',
        args: { target: subjectCatId, wall, corner, nearTarget, relation, facing, finish },
      }];
    }
  }

  // Check if user wants to move currently selected item to a wall/corner
  if ((wall || corner || facing) && state.selectedUid) {
    return [{ tool: 'move_item', args: { target: 'selected', wall, corner, facing, finish } }];
  }

  return [];
}

function planActionsLocally(userText, state) {
  // Split compound multi-step commands cleanly while preserving phrases like "chair and a half"
  const protectedText = userText
    .replace(/chair\s+and\s+a\s+half/gi, 'chair-and-a-half')
    .replace(/black[\s-]and[\s-]brown/gi, 'black-brown')
    .replace(/east\s*(?:and|&|\+)\s*west/gi, 'east-west')
    .replace(/west\s*(?:and|&|\+)\s*east/gi, 'west-east')
    .replace(/walnut\s*(?:and|&)\s*dark\s*gr[ae]y/gi, 'walnut');

  const fullLow = userText.toLowerCase();
  if (/(balance|triad|optimal|best\s+balance)/.test(fullLow) && /(storage|aesthetic|walkway|traffic|flow|tonstad)/.test(fullLow)) {
    const deskId = state.retainedDeskId === 'retained_white_desk' ? 'retained_white_desk' : 'retained_wood_desk';
    const wantDual = /dual|two|2\s*desk|both\s*desk/.test(fullLow);
    const items = [
      { catalogId: 'tonstad_storage_glass_oak', wall: 'west', zone: 'north' },
      { catalogId: 'tonstad_storage_solid_oak', wall: 'west', near: 'tonstad_storage_glass_oak', relation: 'beside' },
      { catalogId: 'billy_narrow_oak', wall: 'west', near: 'tonstad_storage_solid_oak', relation: 'beside' },
      { catalogId: 'tonstad_tv_unit', wall: 'north', zone: 'center' },
      { catalogId: deskId, wall: 'east', zone: 'north' },
      { catalogId: 'markus_chair', near: deskId, relation: 'in_front' },
    ];
    if (wantDual) {
      items.push({ catalogId: 'desk_42_monitor', wall: 'east', zone: 'south' });
      items.push({ catalogId: 'jarvfjallet_chair', near: 'desk_42_monitor', relation: 'in_front' });
    }
    items.push({ catalogId: 'stoense_rug', zone: 'center' });
    return {
      reply: 'Solving a balanced whole-room layout optimizing Storage Capacity, Aesthetics & Daylight Harmony, and Human Movement Traffic Efficiency.',
      tool_calls: [{ tool: 'plan_layout', args: { palette: 'oak_white', keepRetained: true, items } }],
    };
  }

  const rawClauses = protectedText
    .split(/(?:\s*;\s*|\s+and\s+then\s+|\s+then\s+|,\s*(?:and\s+)?|\s+\band\b\s+|\s*&\s*)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  // First try whole sentence if it's a single holistic dual-office / preset command with "and"
  const calls = [];
  if (rawClauses.length > 1) {
    // Check if the first clause is a full preset and subsequent clauses refine it
    for (const c of rawClauses) {
      const parsed = parseClause(c, state);
      calls.push(...parsed);
    }
  } else {
    calls.push(...parseClause(protectedText, state));
  }

  // If multi-clause missed a holistic dual-office intent, try whole prompt
  if (calls.length === 0) {
    calls.push(...parseClause(protectedText, state));
  }

  // Auto-add chair if user asked "add 42" monitor desk ... + chair"
  if (/\b(\+|with|plus)\s*(an?\s*)?(office\s*)?chair\b/i.test(userText) && !calls.some((c) => c.tool === 'pair_office_chairs' || (c.tool === 'add_item' && (c.args.catalogId === 'markus_chair' || c.args.catalogId === 'jarvfjallet_chair')))) {
    calls.push({ tool: 'pair_office_chairs', args: {} });
  }

  // Deduplicate redundant audit_layout calls from multi-clause prompts (e.g. "Audit clearances, chair aisle & IKEA budget")
  let seenAudit = false;
  const dedupedCalls = calls.filter((c) => {
    if (c.tool === 'audit_layout') {
      if (seenAudit) return false;
      seenAudit = true;
    }
    return true;
  });

  return {
    reply: dedupedCalls.length
      ? `Executed ${dedupedCalls.length} layout action${dedupedCalls.length > 1 ? 's' : ''} on your 5-sided room.`
      : `I didn't recognize a specific room action in "${userText}". Try commands like "Balance storage, aesthetics & walkway with TONSTAD + dual desks", "Dual office: both desks on West wall", "Move 42" desk to East wall facing West", or "Audit clearances".`,
    tool_calls: dedupedCalls,
  };
}

// Execute structured tool calls atomically against the live 3D app state
export function executeToolCalls(toolCalls, ctx) {
  const { state, api } = ctx;
  const trace = [];
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { trace, summaryNotes: [] };
  }

  const mutatingTools = new Set([
    'plan_layout', 'load_preset', 'run_optimizer', 'add_item', 'move_item', 'nudge_item',
    'rotate_item', 'remove_item', 'clear_ikea', 'set_finish',
    'swap_retained_desk', 'pair_office_chairs', 'toggle_daybed',
  ]);
  if (toolCalls.some((tc) => mutatingTools.has(tc.tool))) {
    api.pushUndoSnapshot();
  }

  const summaryNotes = [];
  const solverReports = [];
  let lastTouchedUid = state.selectedUid;

  for (const tc of toolCalls) {
    const tool = tc.tool;
    const args = tc.args || {};

    if (tool === 'plan_layout') {
      const solved = solveConstrainedLayout(args, state);
      if (!solved || solved.placed.length === 0) {
        trace.push({ tool, summary: 'Constraint solver could not place requested layout', ok: false });
        solverReports.push({ unplaced: solved?.unplaced || ['requested items'], blockedHotlist: solved?.blockedHotlist || [] });
        continue;
      }
      api.loadItemsList(solved.placed, false);
      api.syncPresetSelectors('custom');
      const optBar = typeof document !== 'undefined' ? document.getElementById('optimizer-bar') : null;
      if (optBar) optBar.classList.add('hidden');
      const t = solved.triad;
      const unpNote = solved.unplaced.length ? ` · Unplaced: ${solved.unplaced.join(', ')}` : '';
      trace.push({
        tool,
        summary: `Solved layout (${solved.placed.length} pcs · Storage ${t.storage} · Aesthetics ${t.aesthetics} · Traffic ${t.traffic}${unpNote})`,
        ok: solved.unplaced.length === 0 && t.collisions === 0,
      });
      summaryNotes.push(
        `Triad Score ${t.overall}/100 — Storage: ${t.storage} (${t.storageCuFt} cu ft), Aesthetics: ${t.aesthetics} (${solved.paletteName}), Traffic: ${t.traffic} (${t.minCorridorIn}" aisle, ${t.reachRatio}% reach).`
      );
      if (solved.unplaced.length > 0) {
        summaryNotes.push(`Could not fit without colliding: ${solved.unplaced.join(', ')}.`);
      }
      if (solved.blockedHotlist.length > 0) {
        summaryNotes.push(`Skipped (not in Considering Hotlist): ${solved.blockedHotlist.join(', ')}.`);
      }
      solverReports.push({ unplaced: solved.unplaced, blockedHotlist: solved.blockedHotlist, triad: t });
      continue;
    }

    if (tool === 'undo') {
      api.undo();
      trace.push({ tool, summary: 'Reverted previous layout change', ok: true });
      continue;
    }

    if (tool === 'set_view') {
      api.setCameraView(args.mode || '3d');
      trace.push({ tool, summary: `Switched camera to ${(args.mode || '3d').toUpperCase()}`, ok: true });
      continue;
    }

    if (tool === 'set_walls') {
      api.setWallMode(args.mode || 'cutaway');
      trace.push({ tool, summary: `Set walls to ${args.mode || 'cutaway'}`, ok: true });
      continue;
    }

    if (tool === 'set_lighting') {
      state.lightingMood = args.mood === 'evening' ? 'evening' : 'day';
      api.applyLightingMood();
      trace.push({ tool, summary: `Lighting → ${state.lightingMood}`, ok: true });
      continue;
    }

    if (tool === 'load_preset') {
      const preset = LAYOUT_PRESETS[args.presetKey];
      if (!preset) {
        trace.push({ tool, summary: `Unknown preset: ${args.presetKey}`, ok: false });
        continue;
      }
      const hotSet =
        state.hotlistOnly && Array.isArray(state.hotlistIds) && state.hotlistIds.length > 0 && args.presetKey !== 'retained_only'
          ? new Set(state.hotlistIds)
          : null;
      // Respect user's currently chosen retained desk variant (wood vs white) & Hotlist-Only constraint
      const itemsCopy = preset.items
        .map((it) => {
          if (it.catalogId === 'retained_wood_desk' && state.retainedDeskId === 'retained_white_desk') {
            return { ...it, catalogId: 'retained_white_desk', finish: 'white' };
          }
          return { ...it };
        })
        .filter((it) => {
          if (!hotSet) return true;
          const c = ALL_CATALOG[it.catalogId];
          return !c || c.retained || c.brand === 'Move-In' || hotSet.has(it.catalogId);
        });
      api.loadItemsList(itemsCopy, false);
      api.syncPresetSelectors(args.presetKey);
      const optBar = typeof document !== 'undefined' ? document.getElementById('optimizer-bar') : null;
      if (optBar) optBar.classList.add('hidden');
      trace.push({
        tool,
        summary: `Loaded "${preset.label}" (${itemsCopy.length} items${hotSet ? ' · Hotlist filtered' : ''})`,
        ok: true,
      });
      summaryNotes.push(preset.description);
      continue;
    }

    if (tool === 'run_optimizer') {
      if (args.forceHotlist && (!state.hotlistIds || state.hotlistIds.length === 0)) {
        trace.push({ tool, summary: 'Considering Hotlist is empty — star items in Buy Mode first', ok: false });
        summaryNotes.push('Tap the ♥ button on any IKEA catalog cards to build your Considering list first.');
        continue;
      }
      const plan = api.runOptimizedSuggestion(args.goal || 'dual_office', false, !!args.forceHotlist);
      trace.push({
        tool,
        summary: `Generated "${plan.title}" · ${plan.ikeaCount} IKEA ($${plan.ikeaCost})`,
        ok: true,
      });
      summaryNotes.push(
        plan.hotlistOnly
          ? `Hotlist-Only mode: placed ${plan.hotlistPlaced}/${plan.hotlistTotal} Considering items with zero collisions.`
          : `Palette: ${plan.paletteName}, zero collisions.`
      );
      continue;
    }

    if (tool === 'swap_retained_desk') {
      api.swapRetainedDesk(args.variant === 'retained_white_desk' ? 'retained_white_desk' : 'retained_wood_desk');
      trace.push({ tool, summary: `Swapped retained desk → ${ALL_CATALOG[state.retainedDeskId].name}`, ok: true });
      continue;
    }

    if (tool === 'clear_ikea') {
      const kept = state.items.filter((i) => {
        const c = ALL_CATALOG[i.catalogId];
        return c && (c.retained || c.brand === 'Move-In');
      });
      api.loadItemsList(kept, false);
      trace.push({ tool, summary: `Cleared all IKEA purchases (${kept.length} kept/move-in remain)`, ok: true });
      continue;
    }

    if (tool === 'add_item') {
      const cat = ALL_CATALOG[args.catalogId];
      if (!cat) {
        trace.push({ tool, summary: `Catalog item not found: ${args.catalogId}`, ok: false });
        continue;
      }
      const hotlistGuard =
        state.hotlistOnly &&
        Array.isArray(state.hotlistIds) &&
        state.hotlistIds.length > 0 &&
        !cat.retained &&
        cat.brand !== 'Move-In' &&
        !state.hotlistIds.includes(cat.id);
      if (hotlistGuard) {
        trace.push({
          tool,
          summary: `Blocked "${cat.name}" — not in Considering Hotlist (Hotlist-Only mode is ON)`,
          ok: false,
        });
        continue;
      }
      const count = Math.min(3, Math.max(1, parseInt(args.count, 10) || 1));
      for (let k = 0; k < count; k++) {
        const nearItem = args.nearTarget ? resolvePlacedTarget(args.nearTarget, state.items, lastTouchedUid) : null;
        const spot = findBestPlacement(cat.id, { ...args, nearItem, allowColliding: false }, state.items, state.room);
        if (!spot) {
          trace.push({
            tool,
            summary: `No collision-free space for ${cat.name} (${cat.w}"×${cat.d}")`,
            ok: false,
          });
          continue;
        }
        const fin = resolveFinishForCat(cat, args.finish);
        const newItem = {
          uid: api.nextUid(),
          catalogId: cat.id,
          x: spot.x,
          z: spot.z,
          rotDeg: spot.rotDeg,
          finish: fin,
          expanded: false,
          ...(cat.defaultFrontStyle ? { frontStyle: cat.defaultFrontStyle } : {}),
        };
        state.items.push(newItem);
        api.syncItemMesh(newItem, true);
        lastTouchedUid = newItem.uid;
        state.selectedUid = newItem.uid;
        const warnTag = spot.status.warningOnly ? ` (${spot.status.warnings[0]})` : ' ✓';
        trace.push({
          tool,
          summary: `Added ${cat.name}${args.wall ? ` on ${args.wall} wall` : args.corner ? ` in ${args.corner.toUpperCase()} corner` : ''}${warnTag}`,
          ok: !spot.status.colliding,
        });
      }
      api.revalidateAllItems();
      api.updateInspector();
      api.updateCartBadge();
      api.updateLeftRail();
      api.saveToStorage();
      continue;
    }

    if (tool === 'move_item') {
      const item = resolvePlacedTarget(args.target, state.items, lastTouchedUid);
      if (!item) {
        trace.push({ tool, summary: `Couldn't find "${args.target}" in room`, ok: false });
        continue;
      }
      const cat = ALL_CATALOG[item.catalogId];
      const isDesk = isDeskCat(cat);
      let pairedChair = null;
      if (isDesk) {
        pairedChair = state.items.find(
          (o) =>
            isChairCat(ALL_CATALOG[o.catalogId]) &&
            Math.hypot(o.x - item.x, o.z - item.z) < 42
        ) || null;
      }
      const searchItems = pairedChair ? state.items.filter((i) => i.uid !== pairedChair.uid) : state.items;
      const nearItem = args.nearTarget ? resolvePlacedTarget(args.nearTarget, searchItems, lastTouchedUid) : null;
      const spot = findBestPlacement(item.catalogId, { ...args, nearItem, allowColliding: false }, searchItems, state.room, item.uid);
      if (!spot) {
        trace.push({
          tool,
          summary: `Could not move ${cat.name} without colliding — use plan_layout to rearrange multiple items cleanly`,
          ok: false,
        });
        continue;
      }
      item.x = spot.x;
      item.z = spot.z;
      item.rotDeg = spot.rotDeg;
      if (args.finish) item.finish = resolveFinishForCat(cat, args.finish);
      api.syncItemMesh(item, false);
      if (pairedChair) {
        const chSpot = findBestPlacement(
          pairedChair.catalogId,
          { nearItem: item, relation: 'in_front', allowColliding: false },
          state.items,
          state.room,
          pairedChair.uid
        );
        if (chSpot) {
          pairedChair.x = chSpot.x;
          pairedChair.z = chSpot.z;
          pairedChair.rotDeg = chSpot.rotDeg;
          api.syncItemMesh(pairedChair, false);
        }
      }
      lastTouchedUid = item.uid;
      state.selectedUid = item.uid;
      api.revalidateAllItems();
      api.updateInspector();
      api.saveToStorage();
      const warnTag = spot.status.warnings.length ? ` ⚠ ${spot.status.warnings[0]}` : ' ✓';
      trace.push({
        tool,
        summary: `Moved ${cat.name}${pairedChair ? ' + chair' : ''}${args.wall ? ` → ${args.wall} wall` : args.corner ? ` → ${args.corner.toUpperCase()}` : ''}${warnTag}`,
        ok: !spot.status.colliding,
      });
      continue;
    }

    if (tool === 'nudge_item') {
      const item = resolvePlacedTarget(args.target, state.items, lastTouchedUid);
      if (!item) {
        trace.push({ tool, summary: `No item selected/found to nudge`, ok: false });
        continue;
      }
      const cat = ALL_CATALOG[item.catalogId];
      const dims = getItemDimensionsIn(item, cat);
      const snapped = clampAndSnapToRoom(
        item.x + (args.dxIn || 0),
        item.z + (args.dzIn || 0),
        dims.w,
        dims.d,
        item.rotDeg,
        state.room,
        { gridSnapIn: 1, wallSnap: false }
      );
      item.x = snapped.x;
      item.z = snapped.z;
      api.syncItemMesh(item, false);
      lastTouchedUid = item.uid;
      state.selectedUid = item.uid;
      api.revalidateAllItems();
      api.updateInspector();
      api.saveToStorage();
      trace.push({ tool, summary: `Nudged ${cat.name} (${args.dxIn || 0}" E, ${args.dzIn || 0}" S)`, ok: true });
      continue;
    }

    if (tool === 'rotate_item') {
      const item = resolvePlacedTarget(args.target, state.items, lastTouchedUid);
      if (!item) {
        trace.push({ tool, summary: `No item selected/found to rotate`, ok: false });
        continue;
      }
      const cat = ALL_CATALOG[item.catalogId];
      const absRot = typeof args.absoluteDeg === 'number'
        ? normDeg(args.absoluteDeg)
        : args.facing
          ? (facingToRotDeg(args.facing) ?? item.rotDeg)
          : normDeg(item.rotDeg + (args.deltaDeg || 90));
      item.rotDeg = absRot;
      const dims = getItemDimensionsIn(item, cat);
      const clamped = clampAndSnapToRoom(item.x, item.z, dims.w, dims.d, item.rotDeg, state.room, {
        gridSnapIn: 1,
        wallSnap: false,
      });
      item.x = clamped.x;
      item.z = clamped.z;
      api.syncItemMesh(item, false);
      lastTouchedUid = item.uid;
      state.selectedUid = item.uid;
      api.revalidateAllItems();
      api.updateInspector();
      api.saveToStorage();
      trace.push({ tool, summary: `Rotated ${cat.name} → ${absRot}°`, ok: true });
      continue;
    }

    if (tool === 'remove_item') {
      const item = resolvePlacedTarget(args.target, state.items, lastTouchedUid);
      if (!item) {
        trace.push({ tool, summary: `Couldn't find "${args.target}" to remove`, ok: false });
        continue;
      }
      const cat = ALL_CATALOG[item.catalogId];
      api.deleteItemByUid(item.uid, false);
      trace.push({ tool, summary: `Removed ${cat.name}`, ok: true });
      continue;
    }

    if (tool === 'set_finish') {
      const fin = args.finish;
      if (args.target === 'all') {
        let changed = 0;
        for (const it of state.items) {
          const cat = ALL_CATALOG[it.catalogId];
          if (!cat || cat.retained) continue;
          const resolved = resolveFinishForCat(cat, fin);
          if (resolved !== it.finish) {
            it.finish = resolved;
            api.syncItemMesh(it, false);
            changed++;
          }
        }
        api.revalidateAllItems();
        api.updateInspector();
        api.saveToStorage();
        const lbl = FINISH_SWATCHES[fin]?.label || fin;
        trace.push({ tool, summary: `Updated ${changed} items to ${lbl} palette`, ok: true });
      } else {
        const item = resolvePlacedTarget(args.target, state.items, lastTouchedUid);
        if (!item) {
          trace.push({ tool, summary: `Couldn't find "${args.target}" to recolor`, ok: false });
          continue;
        }
        const cat = ALL_CATALOG[item.catalogId];
        item.finish = resolveFinishForCat(cat, fin);
        api.syncItemMesh(item, false);
        api.revalidateAllItems();
        api.updateInspector();
        api.saveToStorage();
        trace.push({ tool, summary: `${cat.name} finish → ${FINISH_SWATCHES[item.finish]?.label || item.finish}`, ok: true });
      }
      continue;
    }

    if (tool === 'pair_office_chairs') {
      const desks = state.items.filter((i) =>
        ['retained_wood_desk', 'retained_white_desk', 'desk_42_monitor', 'mittzon_desk'].includes(i.catalogId)
      );
      const chairs = state.items.filter((i) => i.catalogId === 'markus_chair' || i.catalogId === 'jarvfjallet_chair');
      let paired = 0;
      for (const d of desks) {
        const hasNearbyChair = chairs.some((ch) => Math.hypot(ch.x - d.x, ch.z - d.z) < 42);
        if (hasNearbyChair) continue;
        const chairId = d.catalogId === 'desk_42_monitor' ? 'jarvfjallet_chair' : 'markus_chair';
        const spot = findBestPlacement(chairId, { nearItem: d, relation: 'in_front' }, state.items, state.room);
        if (spot && !spot.status.colliding) {
          const ch = {
            uid: api.nextUid(),
            catalogId: chairId,
            x: spot.x,
            z: spot.z,
            rotDeg: spot.rotDeg,
            finish: 'darkGrey',
            expanded: false,
          };
          state.items.push(ch);
          chairs.push(ch);
          api.syncItemMesh(ch, true);
          paired++;
        }
      }
      api.revalidateAllItems();
      api.updateCartBadge();
      api.saveToStorage();
      trace.push({
        tool,
        summary: paired > 0 ? `Paired ${paired} ergonomic chair${paired > 1 ? 's' : ''} with desks ✓` : 'All desks already have paired chairs ✓',
        ok: true,
      });
      continue;
    }

    if (tool === 'toggle_daybed') {
      const bed = state.items.find((i) => i.catalogId === 'hemnes_daybed');
      if (!bed) {
        trace.push({ tool, summary: 'No HEMNES Daybed in room', ok: false });
        continue;
      }
      bed.expanded = !!args.expanded;
      api.syncItemMesh(bed, false);
      api.revalidateAllItems();
      api.updateInspector();
      api.saveToStorage();
      trace.push({ tool, summary: bed.expanded ? 'Pulled out HEMNES to King width' : 'Folded HEMNES back to daybed', ok: true });
      continue;
    }

    if (tool === 'audit_layout') {
      api.revalidateAllItems();
      const audit = computeRoomAudit(state);
      const t = audit.triad;
      const sqFt = (getRoomFloorAreaSqIn(state.room) / 144).toFixed(1);
      const notes = [
        `Triad Score: ${t.overall}/100 · Storage ${t.storage} (${t.storageCuFt} cu ft) · Aesthetics ${t.aesthetics} · Traffic ${t.traffic} (${t.minCorridorIn}" aisle, ${t.reachRatio}% reachable).`,
        `Room: 5-sided (${sqFt} sq ft) · Free wall runs: West ${audit.freeWalls.westStraight.maxRunIn}", East ${audit.freeWalls.east.maxRunIn}", North ${audit.freeWalls.north.maxRunIn}".`,
        `IKEA Cart: ${audit.ikeaCount} items ($${audit.ikeaCost.toLocaleString()}).`,
      ];
      if (audit.collisionDetails.length === 0 && audit.warningDetails.length === 0) {
        notes.push('All 5 walls, both windows, entry door swing & SE closet bi-folds are 100% clear ✓');
      } else {
        if (audit.collisionDetails.length) notes.push(`Collisions: ${audit.collisionDetails.join(' | ')}`);
        if (audit.warningDetails.length) notes.push(`Clearance alerts: ${audit.warningDetails.join(' | ')}`);
      }
      summaryNotes.push(...notes);
      trace.push({
        tool,
        summary: audit.collisionDetails.length
          ? `${audit.collisionDetails.length} collision(s) · Score ${t.overall}/100`
          : audit.warningDetails.length
          ? `${audit.warningDetails.length} alert(s) · Score ${t.overall}/100`
          : `Score ${t.overall}/100 (S:${t.storage} A:${t.aesthetics} T:${t.traffic}) ✓`,
        ok: audit.collisionDetails.length === 0,
      });
    }
  }

  return { trace, summaryNotes, solverReports };
}

// Rolling multi-turn conversation memory for live LLM mode (last 6 exchanges)
const agentChatHistory = [];
const MAX_CHAT_TURNS = 6;

function recordAgentTurn(userText, assistantReply) {
  agentChatHistory.push({
    user: String(userText || '').slice(0, 400),
    assistant: String(assistantReply || '').slice(0, 500),
  });
  while (agentChatHistory.length > MAX_CHAT_TURNS) agentChatHistory.shift();
}

// Build rich spatial context prompt for External LLM Tool-Calling Mode
function buildLLMSystemPrompt(state) {
  const audit = computeRoomAudit(state);
  const t = audit.triad;
  const placed = state.items.map((it) => {
    const c = ALL_CATALOG[it.catalogId];
    const st = t.statusByUid.get(it.uid);
    return {
      uid: it.uid,
      catalogId: it.catalogId,
      name: c?.name,
      w: c?.w,
      d: c?.d,
      h: c?.h,
      x: Math.round(it.x),
      z: Math.round(it.z),
      rotDeg: it.rotDeg,
      finish: it.finish,
      ...(st?.colliding ? { collision: st.warnings } : st?.warningOnly ? { warning: st.warnings } : {}),
    };
  });

  const placedIds = new Set(state.items.map((it) => it.catalogId));
  const hotlistArr = Array.isArray(state.hotlistIds) ? state.hotlistIds.filter((id) => ALL_CATALOG[id]) : [];
  const hotlistSet = new Set(hotlistArr);
  const enforceHotlist = !!state.hotlistOnly && hotlistArr.length > 0;

  const catalogTag = (c) => {
    const tags = [];
    if (c.retained) tags.push('KEPT');
    else if (c.brand === 'Move-In') tags.push('MOVE-IN');
    if (isDeskCat(c)) tags.push('DESK');
    if (isChairCat(c)) tags.push('CHAIR');
    if (isStorageCat(c)) tags.push('STORAGE');
    if (c.isRug) tags.push('RUG');
    if (c.wallMounted) tags.push('WALL_SHELF');
    if (c.stackable) tags.push('STACKABLE');
    if (!c.isRug && !c.wallMounted) tags.push((c.h || 0) <= 34 ? 'LOW<=34"' : 'TALL');
    if (hotlistSet.has(c.id)) tags.push('HOTLIST');
    return tags.length ? ` [${tags.join(',')}]` : '';
  };

  const catalogLines = Object.values(ALL_CATALOG)
    .filter((c) => {
      if (enforceHotlist) {
        return c.retained || c.brand === 'Move-In' || placedIds.has(c.id) || hotlistSet.has(c.id);
      }
      return !c.liveRenton || placedIds.has(c.id) || hotlistSet.has(c.id);
    })
    .map((c) => `${c.id} (${c.name}, ${c.w}×${c.d}×${c.h}", $${c.price}${catalogTag(c)})`);

  const hotlistClause = enforceHotlist
    ? `\nHARD CONSTRAINT — HOTLIST-ONLY MODE IS ON: ONLY include retained/move-in items and IKEA items from the user's Considering Hotlist (${hotlistArr.join(', ')}). NEVER add any other IKEA product!`
    : hotlistArr.length > 0
      ? `\nUser's Considering Hotlist (preferred picks): ${hotlistArr.join(', ')}.`
      : '';

  const halfW = state.room.widthIn / 2;
  const halfL = state.room.lengthIn / 2;
  const flareW = state.room.swFlareWidthIn || 0;
  const flareL = state.room.swFlareLengthIn || 44;
  const swX = -(halfW + flareW);
  const kinkZ = halfL - flareL;
  const doorEndX = swX + state.room.entryDoorOffsetFromWestIn + state.room.entryDoorWidthIn;
  const closetRightX = halfW - state.room.closetOffsetFromEastIn;
  const closetLeftX = closetRightX - state.room.closetWidthIn;
  const nw = state.room.northWindow || { widthIn: 59, heightIn: 48, sillIn: 30, offsetFromWestIn: 26 };
  const ew = state.room.eastWindow || { widthIn: 24, heightIn: 44, sillIn: 34, offsetFromSouthIn: 17 };
  const nwX0 = Math.round(-halfW + nw.offsetFromWestIn);
  const nwX1 = Math.round(nwX0 + nw.widthIn);
  const ewZ1 = Math.round(halfL - ew.offsetFromSouthIn);
  const ewZ0 = Math.round(ewZ1 - ew.widthIn);
  const straightWestLen = Math.round(kinkZ - -halfL);

  return `You are an expert 3D Interior Architect Agent for a calibrated 5-sided room (${state.room.widthIn}" W × ${state.room.lengthIn}" L × ${state.room.heightIn}" H, origin at center).

CORE DESIGN GOAL — BALANCE ALL THREE PILLARS EQUALLY:
1. STORAGE CAPACITY: Maximize practical vertical & closed/display storage (target 35–60 cu ft using tall cabinets, credenzas, drawers, or wall shelves) without crowding the floor.
2. AESTHETICS & DAYLIGHT: Keep TALL items (>36") clear of BOTH windows (place LOW<=34" desks, TV units, or loveseats under windows!), cluster sibling cabinets flush along walls, balance West vs East mass, ground seating with a rug, and use a cohesive 1–2 finish palette.
3. HUMAN MOVEMENT TRAFFIC EFFICIENCY: Preserve a wide (>=30") walkable central corridor from the SW entry door to every desk, loveseat, cabinet, and SE closet. Never block door swing or closet bi-folds. Note: office chairs CAN tuck cleanly under desks!

EXACT 5-WALL & WINDOW GEOMETRY (inches):
- Straight West wall (x=${-halfW}, z in [${-halfL},+${kinkZ}]): ${straightWestLen}" uninterrupted run — best for tandem dual desks OR a flush TONSTAD/BILLY gallery!
- North window wall (z=${-halfL}, x in [${-halfW},+${halfW}]): North window spans x in [${nwX0},+${nwX1}] (${nw.widthIn}"W, sill ${nw.sillIn}"H — keep TALL items off this span!).
- East window wall (x=+${halfW}, z in [${-halfL},+${halfL}]): East window spans z in [+${ewZ0},+${ewZ1}] (${ew.widthIn}"W, sill ${ew.sillIn}"H — keep TALL items off this span!).
- Angled SW wall (${-halfW},+${kinkZ})->(${swX},+${halfL}) + Entry door swing zone: x in [${swX},${doorEndX}], z in [+${halfL - state.room.entryDoorWidthIn - 2},+${halfL}] (MUST STAY CLEAR).
- South SE Closet bi-fold clearance: x in [${closetLeftX},+${closetRightX}], z in [+${halfL - 15},+${halfL}] (MUST STAY CLEAR).

CURRENT ROOM STATE & TRIAD AUDIT:
- Live Scores: Overall ${t.overall}/100 (Storage ${t.storage} [${t.storageCuFt} cu ft], Aesthetics ${t.aesthetics}, Traffic ${t.traffic} [${t.minCorridorIn}" min aisle, ${t.reachRatio}% reachable])
- Remaining Free Wall Runs: West straight=${audit.freeWalls.westStraight.maxRunIn}", East=${audit.freeWalls.east.maxRunIn}", North=${audit.freeWalls.north.maxRunIn}"
- Active Issues: ${audit.collisionDetails.length ? `COLLISIONS: ${audit.collisionDetails.join('; ')}` : '0 collisions'} | ${audit.warningDetails.length ? `WARNINGS: ${audit.warningDetails.join('; ')}` : '0 warnings'}
- Current Items: ${JSON.stringify(placed)}
- Catalog: ${catalogLines.join('; ')}${hotlistClause}
- Presets: ${Object.keys(LAYOUT_PRESETS).join(', ')}

HOW TO USE TOOLS EFFECTIVELY (CRITICAL):
- For ANY whole-room design, rearrangement, multi-item layout, swap, or optimization request: ALWAYS call "plan_layout" with declarative walls & zones! NEVER manually guess raw (x, z, rotDeg) coordinates or emit chains of move_item calls that deadlock against old furniture. The built-in 20-restart spatial constraint solver computes exact zero-collision flush geometry optimizing Storage + Aesthetics + Traffic automatically!
- Only use add_item / move_item / remove_item / rotate_item / set_finish for small single-item tweaks to the existing room.
- Always include the user's kept pieces (retained_loveseat + ${state.retainedDeskId || 'retained_wood_desk'}) in plan_layout unless the user explicitly asks to remove them.

Respond ONLY with strict JSON: {"reply": "concise 1-2 sentence architectural rationale balancing storage, aesthetics, and traffic", "tool_calls": [{"tool": "...", "args": {...}}]}
Available tools:
- plan_layout: {palette?: "oak_white"|"warm_birch"|"walnut_slate"|"scandi_pine"|"espresso_oak", keepRetained?: boolean, items: [{catalogId, wall?: "west"|"east"|"north"|"south"|"sw", corner?: "nw"|"ne"|"se"|"sw"|"center", zone?: "north"|"center"|"south"|"west"|"east", facing?: "north"|"south"|"east"|"west", near?: catalogId, flushWith?: catalogId, relation?: "in_front"|"beside"|"under"|"on", finish?, frontStyle?, mountHeightIn?}]}
- load_preset: {presetKey}
- run_optimizer: {goal: "dual_office"|"office"|"guest"|"library"|"kids"|"any", forceHotlist?: boolean}
- add_item: {catalogId, wall?, corner?, zone?, nearTarget?, relation?, facing?, finish?, count?}
- move_item: {target, wall?, corner?, zone?, nearTarget?, relation?, facing?, finish?}
- nudge_item: {target, dxIn, dzIn}
- rotate_item: {target, deltaDeg?, absoluteDeg?, facing?}
- remove_item: {target}
- clear_ikea: {}
- set_finish: {target: "all"|catalogId|"selected", finish}
- swap_retained_desk: {variant: "retained_wood_desk"|"retained_white_desk"}
- pair_office_chairs: {}
- toggle_daybed: {expanded: boolean}
- set_view: {mode: "3d"|"2d"|"fp"}
- set_walls: {mode: "cutaway"|"up"|"down"}
- set_lighting: {mood: "day"|"evening"}
- audit_layout: {}
- undo: {}`;
}

export function resolveGeminiModelId(llmConfig) {
  const override = (llmConfig?.model || '').trim();
  if (override) return override;
  const prov = llmConfig?.provider || 'gemini-4-neon';
  if (prov === 'gemini-4-carbon' || prov === 'gemini-4-neon' || prov === 'gemini-4-hydrogen') {
    return prov;
  }
  return 'gemini-4-neon';
}

function isGeminiProvider(provider) {
  return (
    provider === 'gemini' ||
    provider === 'gemini-4-neon' ||
    provider === 'gemini-4-carbon' ||
    provider === 'gemini-4-hydrogen'
  );
}

function extractJsonObject(rawText) {
  const cleaned = String(rawText || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1));
    }
    throw new Error('Model returned non-JSON response');
  }
}

async function callExternalLLM(userText, state, llmConfig, extraMessages = []) {
  const sysPrompt = buildLLMSystemPrompt(state);
  const provider = llmConfig.provider || 'gemini-4-neon';
  const apiKey = (llmConfig.apiKey || '').trim();
  const modelOverride = (llmConfig.model || '').trim();

  if (isGeminiProvider(provider)) {
    const m = resolveGeminiModelId(llmConfig);
    const isGemini4 = /^gemini-4/i.test(m);
    const rawLevel = String(llmConfig.thinkingLevel || 'MEDIUM').toUpperCase();
    const allowedLevel =
      m === 'gemini-4-carbon' && rawLevel === 'XHIGH'
        ? 'HIGH'
        : ['LOW', 'MEDIUM', 'HIGH', 'XHIGH'].includes(rawLevel)
          ? rawLevel
          : 'MEDIUM';

    const generationConfig = {
      responseMimeType: 'application/json',
      ...(isGemini4
        ? { thinkingConfig: { thinkingLevel: allowedLevel } }
        : { temperature: 0.2 }),
    };

    const contents = [];
    for (const turn of agentChatHistory) {
      contents.push({ role: 'user', parts: [{ text: turn.user }] });
      contents.push({ role: 'model', parts: [{ text: turn.assistant }] });
    }
    contents.push({ role: 'user', parts: [{ text: userText }] });
    for (const msg of extraMessages) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.text }],
      });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sysPrompt }] },
        contents,
        generationConfig,
      }),
    });

    if (!res.ok) {
      let apiMsg = '';
      try {
        const errBody = await res.json();
        apiMsg = errBody?.error?.message || '';
      } catch (_) {}
      if ((res.status === 403 || res.status === 429) && (m === 'gemini-4-neon' || m === 'gemini-4-carbon')) {
        throw new Error(`Gemini ${m} HTTP ${res.status} (paid API tier required — try Gemini 4 Hydrogen for Free tier${apiMsg ? `: ${apiMsg}` : ''})`);
      }
      throw new Error(`Gemini ${m} HTTP ${res.status}${apiMsg ? `: ${apiMsg}` : ''}`);
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const answerText = parts
      .filter((p) => !p?.thought && typeof p?.text === 'string')
      .map((p) => p.text)
      .join('');
    return extractJsonObject(answerText || '{}');
  }

  // OpenAI or Custom OpenAI-compatible (e.g. local Ollama / LM Studio)
  const endpoint =
    provider === 'custom' && llmConfig.endpoint
      ? llmConfig.endpoint.trim()
      : 'https://api.openai.com/v1/chat/completions';
  const m = modelOverride || (provider === 'custom' ? 'llama3.1' : 'gpt-4o-mini');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const messages = [{ role: 'system', content: sysPrompt }];
  for (const turn of agentChatHistory) {
    messages.push({ role: 'user', content: turn.user });
    messages.push({ role: 'assistant', content: turn.assistant });
  }
  messages.push({ role: 'user', content: userText });
  for (const msg of extraMessages) {
    messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.text });
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: m,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '{}';
  return extractJsonObject(raw);
}

export async function runLayoutAgentCommand(userText, ctx, llmConfig = { mode: 'builtin' }) {
  const trimmed = (userText || '').trim();
  if (!trimmed) return { reply: 'Type a room layout instruction to run.', trace: [], modeUsed: 'builtin' };

  let plan = null;
  let modeUsed = 'builtin';
  let fallbackNotice = '';
  const useLiveLLM = !!(llmConfig && llmConfig.mode === 'api' && (llmConfig.apiKey || llmConfig.provider === 'custom'));

  if (useLiveLLM) {
    try {
      plan = await callExternalLLM(trimmed, ctx.state, llmConfig);
      modeUsed = isGeminiProvider(llmConfig.provider)
        ? resolveGeminiModelId(llmConfig)
        : llmConfig.provider || 'api';
    } catch (err) {
      fallbackNotice = `Live LLM error (${err.message || 'blocked by browser CSP'}) — ran via Built-in Layout Agent instead.`;
    }
  }

  if (!plan || !Array.isArray(plan.tool_calls)) {
    plan = planActionsLocally(trimmed, ctx.state);
    modeUsed = 'builtin';
  }

  const execRes = executeToolCalls(plan.tool_calls, ctx);
  let trace = [...execRes.trace];
  let summaryNotes = [...execRes.summaryNotes];
  let finalReply = plan.reply || '';

  // Closed-Loop Turn-2 Spatial Critique & Auto-Repair for Live LLM mode!
  if (useLiveLLM && modeUsed !== 'builtin' && plan.tool_calls.length > 0) {
    const auditAfter1 = computeRoomAudit(ctx.state);
    const t1 = auditAfter1.triad;
    const failedTools = trace.filter((tr) => !tr.ok);
    const unplacedAll = (execRes.solverReports || []).flatMap((r) => r.unplaced || []);
    const needsRepair =
      failedTools.length > 0 ||
      unplacedAll.length > 0 ||
      auditAfter1.collisionDetails.length > 0 ||
      t1.windowBlocks > 0 ||
      t1.doorBlocks > 0 ||
      t1.closetBlocks > 0 ||
      t1.traffic < 62 ||
      t1.aesthetics < 62;

    if (needsRepair) {
      const issues = [];
      if (failedTools.length) issues.push(`Failed calls: ${failedTools.map((f) => f.summary).join('; ')}`);
      if (unplacedAll.length) issues.push(`Could not fit without colliding: ${unplacedAll.join(', ')}`);
      if (auditAfter1.collisionDetails.length) issues.push(`Collisions: ${auditAfter1.collisionDetails.join('; ')}`);
      if (auditAfter1.warningDetails.length) issues.push(`Warnings: ${auditAfter1.warningDetails.join('; ')}`);
      if (t1.traffic < 62) issues.push(`Low Traffic score (${t1.traffic}/100, min aisle ${t1.minCorridorIn}", reach ${t1.reachRatio}%) — open up the central walkway!`);
      if (t1.aesthetics < 62) issues.push(`Low Aesthetics score (${t1.aesthetics}/100) — clear windows, unify palette, or cluster cabinets flush.`);

      const repairPrompt =
        `SPATIAL VERIFICATION AUDIT FAILED — AUTO-REPAIR REQUIRED.\n` +
        `Issues found:\n- ${issues.join('\n- ')}\n` +
        `Current Scores: Overall ${t1.overall}/100 (Storage ${t1.storage}, Aesthetics ${t1.aesthetics}, Traffic ${t1.traffic}).\n` +
        `Remaining Free Wall Runs: West=${auditAfter1.freeWalls.westStraight.maxRunIn}", East=${auditAfter1.freeWalls.east.maxRunIn}", North=${auditAfter1.freeWalls.north.maxRunIn}".\n` +
        `Emit a SINGLE repaired "plan_layout" call that resolves ALL issues while balancing Storage, Aesthetics, and Traffic (swap to slimmer pieces like billy_narrow_oak or relocate tall pieces off windows if needed).`;

      try {
        const repairPlan = await callExternalLLM(trimmed, ctx.state, llmConfig, [
          { role: 'assistant', text: JSON.stringify(plan) },
          { role: 'user', text: repairPrompt },
        ]);
        if (repairPlan && Array.isArray(repairPlan.tool_calls) && repairPlan.tool_calls.length > 0) {
          trace.push({ tool: 'auto_repair', summary: 'Spatial audit triggered Turn-2 auto-repair ✓', ok: true });
          const repExec = executeToolCalls(repairPlan.tool_calls, ctx);
          trace.push(...repExec.trace);
          summaryNotes = [...repExec.summaryNotes];
          if (repairPlan.reply) finalReply = repairPlan.reply;
        }
      } catch (_) {
        // Keep Turn-1 best effort if repair network call fails
      }
    }
  }

  const parts = [];
  if (fallbackNotice) parts.push(fallbackNotice);
  if (finalReply) parts.push(finalReply);
  if (summaryNotes.length) parts.push(summaryNotes.join(' '));

  const finalText = parts.join('\n');
  recordAgentTurn(trimmed, finalText);

  return {
    reply: finalText,
    trace,
    modeUsed,
  };
}
