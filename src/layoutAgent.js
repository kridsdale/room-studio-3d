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
  'Dual office: both desks on West wall + loveseat on East',
  'Dual office face-off (East + West) with 42" monitor desk',
  'Dual office L-corner studio near the North window',
  'Move 42" monitor desk to West wall facing East & pair chairs',
  'Add a BILLY bookcase on West wall, HEKTAR lamp & STOENSE rug',
  'Switch finishes to walnut & dark grey, evening lighting',
  'Audit clearances, chair aisle & IKEA budget',
];

const FINISH_ALIASES = [
  ['blackbrown', 'blackBrown'],
  ['black-brown', 'blackBrown'],
  ['espresso', 'blackBrown'],
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

// Smart collision-free spatial candidate search respecting the 5-sided room, door swing, and closet!
function findBestPlacement(catalogId, opts, items, room, excludeUid = null) {
  const cat = ALL_CATALOG[catalogId];
  if (!cat) return null;
  const dims = getItemDimensionsIn({ expanded: false }, cat);
  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;
  const flareL = room.swFlareLengthIn || 46;
  const otherItems = excludeUid ? items.filter((i) => i.uid !== excludeUid) : items;

  const wall = (opts.wall || '').toLowerCase();
  const corner = (opts.corner || '').toLowerCase();
  const facingRot = facingToRotDeg(opts.facing);
  const candidates = [];

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
    };
    const st = checkPlacementStatus(cand, otherItems, ALL_CATALOG, room);
    let score = prefBias;
    if (st.colliding) score += 10000;
    else if (st.warningOnly) score += 500 * st.warnings.length;
    candidates.push({ x: snapped.x, z: snapped.z, rotDeg: r, status: st, score });
  };

  // Explicit coordinates (e.g., from live LLM tool call)
  if (typeof opts.x === 'number' && typeof opts.z === 'number') {
    const r = typeof opts.rotDeg === 'number' ? opts.rotDeg : (facingRot ?? 0);
    pushCand(opts.x, opts.z, r, opts.wallSnap !== false, 0);
    // Also add nearby micro-offsets in case exact coordinate slightly overlaps
    for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6], [12, 0], [-12, 0], [0, 12], [0, -12]]) {
      pushCand(opts.x + dx, opts.z + dz, r, false, Math.hypot(dx, dz) * 0.5);
    }
  }

  // Relative to another placed item (e.g., chair in front of desk, rug under loveseat, bookcase next to desk)
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
      // Snap neatly onto the corner/top of the supporting tabletop!
      const sideOff = Math.max(0, aDims.w / 2 - dims.w / 2 - 3);
      pushCand(anchor.x + rx * sideOff - fx * 3, anchor.z + rz * sideOff - fz * 3, facingRot ?? anchor.rotDeg, false, 0);
      pushCand(anchor.x - rx * sideOff - fx * 3, anchor.z - rz * sideOff - fz * 3, facingRot ?? anchor.rotDeg, false, 1);
      pushCand(anchor.x, anchor.z, facingRot ?? anchor.rotDeg, false, 2);
    } else if (cat.isRug || rel === 'under') {
      pushCand(anchor.x + fx * 10, anchor.z + fz * 10, facingRot ?? 0, false, 0);
      pushCand(anchor.x, anchor.z, facingRot ?? 0, false, 2);
      pushCand(0, -12, facingRot ?? 0, false, 8);
    } else if (rel === 'in_front' || cat.meshType === 'office_chair') {
      const dist = aDims.d / 2 + dims.d / 2 + 4;
      const rot = facingRot ?? normDeg(anchor.rotDeg + 180);
      for (const delta of [0, -3, 3, -6, 6]) {
        pushCand(anchor.x + fx * (dist + delta), anchor.z + fz * (dist + delta), rot, false, Math.abs(delta));
      }
    } else {
      // Beside / next to anchor along its wall/tangent
      const sideDist = aDims.w / 2 + dims.w / 2 + 3;
      const rot = facingRot ?? anchor.rotDeg;
      for (const s of [1, -1]) {
        for (const extra of [0, 6, 12]) {
          pushCand(anchor.x + rx * s * (sideDist + extra), anchor.z + rz * s * (sideDist + extra), rot, true, extra);
        }
      }
    }
  }

  // Corner placements
  if (corner) {
    const cornerMap = {
      nw: { x: -halfW + 18, z: -halfL + 18, rots: [0, 90, 45] },
      ne: { x: halfW - 18,  z: -halfL + 18, rots: [0, 270, 315] },
      se: { x: halfW - 18,  z: halfL - 36,  rots: [270, 180] },
      sw: { x: -halfW + 14, z: halfL - flareL - 12, rots: [90, 75] },
      center: { x: 0, z: -10, rots: [0, 90, 270] },
    };
    const cDef = cornerMap[corner] || cornerMap.center;
    const rots = facingRot !== null ? [facingRot] : cDef.rots;
    for (const r of rots) {
      for (const dx of [0, 10, -10, 20, -20]) {
        for (const dz of [0, 10, -10, 20, -20]) {
          pushCand(cDef.x + dx, cDef.z + dz, r, corner !== 'center', Math.hypot(dx, dz));
        }
      }
    }
  }

  // Wall sweeps (5-sided aware!)
  if (wall) {
    const rot = facingRot !== null ? facingRot : wallDefaultFacingRot(wall);
    if (wall === 'west') {
      // Straight West wall runs z in [-92, +46] (138"!)
      const zVals = [-14, -30, 8, -48, 22, -62, -4, 16, -72, 32];
      zVals.forEach((z, idx) => pushCand(-halfW + dims.d / 2 + 1, z, rot, true, idx * 2));
    } else if (wall === 'east') {
      const zVals = [16, -12, -42, 30, -58, 4, 46, -72, 60];
      zVals.forEach((z, idx) => pushCand(halfW - dims.d / 2 - 1, z, rot, true, idx * 2));
    } else if (wall === 'north') {
      const xVals = [0, -22, 22, -32, 32, -12, 12, -42, 42];
      xVals.forEach((x, idx) => pushCand(x, -halfL + dims.d / 2 + 1, rot, true, idx * 2));
    } else if (wall === 'south') {
      const xVals = [-16, -24, -8, 12];
      xVals.forEach((x, idx) => pushCand(x, halfL - dims.d / 2 - 18, rot, false, idx * 2));
    } else if (wall === 'sw') {
      const zVals = [32, 20, 42, 10];
      zVals.forEach((z, idx) => pushCand(-halfW + dims.d / 2 + 1, z, rot, true, idx * 2));
    }
  }

  // General fallback room sweep if no location specified or requested spot was tight
  if (candidates.length === 0 || candidates.every((c) => c.score >= 500)) {
    if (cat.isRug) {
      pushCand(0, -14, facingRot ?? 0, false, 10);
      pushCand(6, -20, facingRot ?? 0, false, 14);
    } else {
      const sweep = [
        ...[-56, -32, -8, 14, 28].map((z, i) => ({ x: -halfW + 14, z, r: facingRot ?? 90, b: 20 + i })),
        ...[-52, -24, 10, 28, 48].map((z, i) => ({ x: halfW - 14, z, r: facingRot ?? 270, b: 22 + i })),
        ...[-24, 0, 24].map((x, i) => ({ x, z: -halfL + 16, r: facingRot ?? 0, b: 25 + i })),
        { x: 0, z: -12, r: facingRot ?? 0, b: 40 },
      ];
      for (const s of sweep) {
        pushCand(s.x, s.z, s.r, true, s.b);
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] || null;
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

  // 4. Dual-Office & Room Preset / Optimizer triggers
  if (/(dual|two|2)\s*(home\s*)?(office|desk|workstation|setup)|both desks/.test(low)) {
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

  if (/(shuffle|optimize|suggest|recommend|auto[\s-]?layout|surprise me)/.test(low)) {
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

  const rawClauses = protectedText
    .split(/(?:\s*;\s*|\s+and\s+then\s+|\s+then\s+|,\s*(?:and\s+)?|\s+\band\b\s+|\s*&\s*)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  // First try whole sentence if it's a single holistic dual-office / preset command with "and"
  const calls = [];
  if (rawClauses.length > 1) {
    const wholeLow = protectedText.toLowerCase();
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

  return {
    reply: calls.length
      ? `Executed ${calls.length} layout action${calls.length > 1 ? 's' : ''} on your 5-sided room.`
      : `I didn't recognize a specific room action in "${userText}". Try commands like "Dual office: both desks on West wall", "Move 42" desk to East wall facing West", "Add a BILLY bookcase on West wall", or "Audit clearances".`,
    tool_calls: calls,
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
    'load_preset', 'run_optimizer', 'add_item', 'move_item', 'nudge_item',
    'rotate_item', 'remove_item', 'clear_ikea', 'set_finish',
    'swap_retained_desk', 'pair_office_chairs', 'toggle_daybed',
  ]);
  if (toolCalls.some((tc) => mutatingTools.has(tc.tool))) {
    api.pushUndoSnapshot();
  }

  const summaryNotes = [];
  let lastTouchedUid = state.selectedUid;

  for (const tc of toolCalls) {
    const tool = tc.tool;
    const args = tc.args || {};

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
      // Respect user's currently chosen retained desk variant (wood vs white)
      const itemsCopy = preset.items.map((it) => {
        if (it.catalogId === 'retained_wood_desk' && state.retainedDeskId === 'retained_white_desk') {
          return { ...it, catalogId: 'retained_white_desk', finish: 'white' };
        }
        return { ...it };
      });
      api.loadItemsList(itemsCopy, false);
      api.syncPresetSelectors(args.presetKey);
      const optBar = document.getElementById('optimizer-bar');
      if (optBar) optBar.classList.add('hidden');
      trace.push({ tool, summary: `Loaded "${preset.label}" (${itemsCopy.length} items)`, ok: true });
      summaryNotes.push(preset.description);
      continue;
    }

    if (tool === 'run_optimizer') {
      const plan = api.runOptimizedSuggestion(args.goal || 'dual_office', false);
      trace.push({
        tool,
        summary: `Generated "${plan.title}" · ${plan.ikeaCount} IKEA ($${plan.ikeaCost})`,
        ok: true,
      });
      summaryNotes.push(`Palette: ${plan.paletteName}, zero collisions.`);
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
      const count = Math.min(3, Math.max(1, parseInt(args.count, 10) || 1));
      for (let k = 0; k < count; k++) {
        const nearItem = args.nearTarget ? resolvePlacedTarget(args.nearTarget, state.items, lastTouchedUid) : null;
        const spot = findBestPlacement(cat.id, { ...args, nearItem }, state.items, state.room);
        if (!spot) continue;
        const fin = resolveFinishForCat(cat, args.finish);
        const newItem = {
          uid: api.nextUid(),
          catalogId: cat.id,
          x: spot.x,
          z: spot.z,
          rotDeg: spot.rotDeg,
          finish: fin,
          expanded: false,
        };
        state.items.push(newItem);
        api.syncItemMesh(newItem, true);
        lastTouchedUid = newItem.uid;
        state.selectedUid = newItem.uid;
        const warnTag = spot.status.colliding ? ' (tight fit)' : spot.status.warningOnly ? ` (${spot.status.warnings[0]})` : '';
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
      const isDesk = ['retained_wood_desk', 'retained_white_desk', 'desk_42_monitor', 'mittzon_desk'].includes(item.catalogId);
      // If moving a desk, find its currently paired ergonomic chair so it moves smoothly with the desk!
      let pairedChair = null;
      if (isDesk) {
        pairedChair = state.items.find(
          (o) =>
            (o.catalogId === 'markus_chair' || o.catalogId === 'jarvfjallet_chair') &&
            Math.hypot(o.x - item.x, o.z - item.z) < 42
        ) || null;
      }
      const searchItems = pairedChair ? state.items.filter((i) => i.uid !== pairedChair.uid) : state.items;
      const nearItem = args.nearTarget ? resolvePlacedTarget(args.nearTarget, searchItems, lastTouchedUid) : null;
      const spot = findBestPlacement(item.catalogId, { ...args, nearItem }, searchItems, state.room, item.uid);
      if (spot) {
        item.x = spot.x;
        item.z = spot.z;
        item.rotDeg = spot.rotDeg;
        if (args.finish) item.finish = resolveFinishForCat(cat, args.finish);
        api.syncItemMesh(item, false);
        if (pairedChair) {
          const chSpot = findBestPlacement(
            pairedChair.catalogId,
            { nearItem: item, relation: 'in_front' },
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
      }
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
      const collisions = [];
      const warnings = [];
      let ikeaCost = 0;
      let ikeaCount = 0;
      const desks = [];
      const chairs = [];
      for (const it of state.items) {
        const c = ALL_CATALOG[it.catalogId];
        if (!c) continue;
        if (!c.retained && c.brand === 'IKEA') {
          ikeaCost += c.price;
          ikeaCount++;
        }
        if (['retained_wood_desk', 'retained_white_desk', 'desk_42_monitor', 'mittzon_desk'].includes(it.catalogId)) {
          desks.push(it);
        }
        if (it.catalogId === 'markus_chair' || it.catalogId === 'jarvfjallet_chair') {
          chairs.push(it);
        }
        const st = checkPlacementStatus(it, state.items, ALL_CATALOG, state.room);
        if (st.colliding) collisions.push(`${c.name}: ${st.warnings.join(', ')}`);
        else if (st.warningOnly) warnings.push(`${c.name}: ${st.warnings.join(', ')}`);
      }
      const sqFt = (getRoomFloorAreaSqIn(state.room) / 144).toFixed(1);
      const notes = [
        `Room: 5-sided (${sqFt} sq ft) · ${desks.length} desk(s), ${chairs.length} office chair(s).`,
        `IKEA Cart: ${ikeaCount} items ($${ikeaCost.toLocaleString()}).`,
      ];
      if (desks.length >= 2) {
        const dGap = Math.round(Math.hypot(desks[0].x - desks[1].x, desks[0].z - desks[1].z));
        notes.push(`Desk-to-desk center spacing: ${api.formatLen(dGap)}.`);
      }
      if (collisions.length === 0 && warnings.length === 0) {
        notes.push('All 5 walls, entry door swing & SE closet bi-folds are 100% clear ✓');
      } else {
        if (collisions.length) notes.push(`Collisions: ${collisions.join(' | ')}`);
        if (warnings.length) notes.push(`Clearance alerts: ${warnings.join(' | ')}`);
      }
      summaryNotes.push(...notes);
      trace.push({
        tool,
        summary: collisions.length ? `${collisions.length} collision(s) found` : warnings.length ? `${warnings.length} clearance warning(s)` : '0 collisions · 0 warnings ✓',
        ok: collisions.length === 0,
      });
    }
  }

  return { trace, summaryNotes };
}

// Build live room context JSON for Optional External LLM Tool-Calling Mode
function buildLLMSystemPrompt(state) {
  const poly = getRoomPolygon(state.room);
  const placed = state.items.map((it) => {
    const c = ALL_CATALOG[it.catalogId];
    return {
      uid: it.uid,
      catalogId: it.catalogId,
      name: c?.name,
      w: c?.w,
      d: c?.d,
      x: Math.round(it.x),
      z: Math.round(it.z),
      rotDeg: it.rotDeg,
      finish: it.finish,
    };
  });
  // Keep prompt compact: include all core starter pieces + any currently placed live Renton items
  const placedIds = new Set(state.items.map((it) => it.catalogId));
  const catalogIds = Object.values(ALL_CATALOG)
    .filter((c) => !c.liveRenton || placedIds.has(c.id))
    .map((c) => `${c.id} (${c.name}, ${c.w}x${c.d}", $${c.price})`);

  return `You are a 3D Room Layout Planner Agent for a 5-sided room (inches, origin at center):
Polygon vertices: ${JSON.stringify(poly)}
Walls: North window wall z=-92, East window wall x=+58.5, Straight West wall x=-58.5 (z in [-92,+46]), Angled SW entry wall (-58.5,+46)->(-70.5,+92), South door+closet wall z=+92.
Entry door swing zone: x in [-70.5,-33.5], z in [+58,+92]. SE Closet clearance: x in [-1.5,+46.5], z in [+77,+92].
rotDeg: 0 faces South (+Z), 90 faces East (+X), 180 faces North (-Z), 270 faces West (-X).
Current items: ${JSON.stringify(placed)}
Catalog: ${catalogIds.join('; ')}
Presets: ${Object.keys(LAYOUT_PRESETS).join(', ')}

Respond ONLY with strict JSON: {"reply": "short 1-2 sentence explanation", "tool_calls": [{"tool": "...", "args": {...}}]}
Available tools:
- load_preset: {presetKey}
- run_optimizer: {goal: "dual_office"|"office"|"guest"|"library"|"kids"|"any"}
- add_item: {catalogId, wall?: "north"|"south"|"east"|"west"|"sw", corner?: "nw"|"ne"|"se"|"sw"|"center", nearTarget?, relation?: "in_front"|"beside"|"under", facing?, finish?, x?, z?, rotDeg?, count?}
- move_item: {target, wall?, corner?, nearTarget?, relation?, facing?, finish?, x?, z?, rotDeg?}
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

async function callExternalLLM(userText, state, llmConfig) {
  const sysPrompt = buildLLMSystemPrompt(state);
  const provider = llmConfig.provider || 'gemini-4-neon';
  const apiKey = (llmConfig.apiKey || '').trim();
  const modelOverride = (llmConfig.model || '').trim();

  if (isGeminiProvider(provider)) {
    const m = resolveGeminiModelId(llmConfig);
    const isGemini4 = /^gemini-4/i.test(m);
    const rawLevel = String(llmConfig.thinkingLevel || 'MEDIUM').toUpperCase();
    // Gemini 4 Carbon supports LOW/MEDIUM/HIGH; Neon & Hydrogen also support XHIGH
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sysPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
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
    // Gemini 4 returns thought parts with { thought: true }; extract only the final output text
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

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: m,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userText },
      ],
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

  if (llmConfig && llmConfig.mode === 'api' && (llmConfig.apiKey || llmConfig.provider === 'custom')) {
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

  const { trace, summaryNotes } = executeToolCalls(plan.tool_calls, ctx);
  const parts = [];
  if (fallbackNotice) parts.push(fallbackNotice);
  if (plan.reply) parts.push(plan.reply);
  if (summaryNotes.length) parts.push(summaryNotes.join(' '));

  return {
    reply: parts.join('\n'),
    trace,
    modeUsed,
  };
}
