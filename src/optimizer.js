// Algorithmic Room Layout & IKEA Purchase Optimizer
// Selects cohesive IKEA purchases and computes collision-free, door/closet-safe placements
// tailored to the calibrated room dimensions and the user's 2 retained pieces.

import { ALL_CATALOG } from './catalog.js';
import { getItemDimensionsIn, clampAndSnapToRoom, checkPlacementStatus } from './collision.js';

const PALETTES = [
  { name: 'Nordic Oak & Sage',       wood: 'oak',        storage: 'white',      fabric: 'sage',       rug: 'beige',     lamp: 'matteBlack', plant: 'terracotta' },
  { name: 'Warm Birch & Natural',    wood: 'birch',      storage: 'white',      fabric: 'beige',      rug: 'jute',      lamp: 'beige',      plant: 'sage' },
  { name: 'Walnut & Slate Studio',   wood: 'walnut',     storage: 'oak',        fabric: 'darkGrey',   rug: 'lightGrey', lamp: 'matteBlack', plant: 'white' },
  { name: 'Scandi Pine & Cream',     wood: 'pine',       storage: 'white',      fabric: 'lightGrey',  rug: 'beige',     lamp: 'white',      plant: 'terracotta' },
  { name: 'Contrast Espresso & Oak', wood: 'blackBrown', storage: 'white',      fabric: 'slateBlue',  rug: 'lightGrey', lamp: 'matteBlack', plant: 'sage' },
];

export const OPTIMIZER_GOALS = [
  { id: 'dual_office', label: 'Dual Home Office (2 Desks + 42")' },
  { id: 'any',         label: 'Surprise Me (All Goals)' },
  { id: 'office',      label: 'Single Office + Lounge' },
  { id: 'guest',       label: 'Guest Bed + Study' },
  { id: 'library',     label: 'Reading Library + Office' },
  { id: 'kids',        label: 'Kids Room + Study' },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function resolveFinish(cat, palette, role) {
  const desired = palette[role] || cat.defaultFinish;
  if (cat.finishes && cat.finishes.includes(desired)) return desired;
  if (cat.finishes && cat.finishes.includes(palette.wood)) return palette.wood;
  if (cat.finishes && cat.finishes.includes(palette.storage)) return palette.storage;
  return cat.defaultFinish || 'white';
}

function tryPlaceCandidate(placed, catalogId, candidates, finish, room) {
  const cat = ALL_CATALOG[catalogId];
  if (!cat) return null;
  for (const cand of candidates) {
    const dims = getItemDimensionsIn({ expanded: false }, cat);
    const snapped = clampAndSnapToRoom(cand.x, cand.z, dims.w, dims.d, cand.rotDeg, room, {
      gridSnapIn: 1,
      wallSnap: cand.wallSnap !== false,
    });
    const item = {
      uid: `opt_${placed.length + 1}`,
      catalogId,
      x: snapped.x,
      z: snapped.z,
      rotDeg: cand.rotDeg,
      finish,
      expanded: false,
    };
    const st = checkPlacementStatus(item, placed, ALL_CATALOG, room);
    if (!st.colliding && !st.warningOnly) {
      placed.push(item);
      return item;
    }
  }
  return null;
}

export function generateOptimizedLayout(room, retainedDeskId, goal = 'any', lastArchetypeId = null) {
  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;
  const palette = pick(PALETTES);
  const deskCat = ALL_CATALOG[retainedDeskId] || ALL_CATALOG.retained_wood_desk;
  const loveCat = ALL_CATALOG.retained_loveseat;

  // Define distinct architectural archetypes with varied zones
  const allArchetypes = [
    { id: 'dual_face_off',          goal: 'dual_office', title: 'Dual Office · Face-Off (East + West)' },
    { id: 'dual_tandem_west',       goal: 'dual_office', title: 'Dual Office · Tandem West Wall Run' },
    { id: 'dual_l_corner_studio',   goal: 'dual_office', title: 'Dual Office · L-Corner Command Studio' },
    { id: 'dual_glare_free_split',  goal: 'dual_office', title: 'Dual Office · Glare-Free Split Zone' },
    { id: 'dual_peninsula_collab',  goal: 'dual_office', title: 'Dual Office · Executive Studio + Lounge' },
    { id: 'east_desk_north_lounge', goal: 'office',      title: 'Executive East Desk + North Lounge' },
    { id: 'window_desk_east_lounge',goal: 'office',      title: 'Window-View Desk + Media Wall' },
    { id: 'west_desk_corner_lounge',goal: 'office',      title: 'West Studio Desk + Reading Corner' },
    { id: 'guest_daybed_suite',     goal: 'guest',       title: 'HEMNES Daybed Guest Suite + Study' },
    { id: 'guest_full_bed_office',  goal: 'guest',       title: 'Compact Guest Bedroom + Workspace' },
    { id: 'library_sanctuary',      goal: 'library',     title: 'BILLY Library Wall + Cozy Reading Nook' },
    { id: 'kids_kura_study',        goal: 'kids',        title: 'KURA Kids Loft + Parent Study' },
  ];

  let pool = goal === 'any' ? allArchetypes : allArchetypes.filter((a) => a.goal === goal);
  if (pool.length > 1 && lastArchetypeId) {
    pool = pool.filter((a) => a.id !== lastArchetypeId);
  }
  const arch = pick(pool);

  const placed = [];

  // Helper: place chair cleanly facing a desk (supports MARKUS or JÄRVFJÄLLET)
  const placeDeskChair = (deskItem, chairId = 'markus_chair') => {
    const chairCat = ALL_CATALOG[chairId] || ALL_CATALOG.markus_chair;
    const rad = (deskItem.rotDeg * Math.PI) / 180;
    const fx = Math.sin(rad);
    const fz = Math.cos(rad);
    const chairCands = [
      { x: deskItem.x + fx * 29, z: deskItem.z + fz * 29, rotDeg: (deskItem.rotDeg + 180) % 360, wallSnap: false },
      { x: deskItem.x + fx * 26, z: deskItem.z + fz * 26, rotDeg: (deskItem.rotDeg + 180) % 360, wallSnap: false },
      { x: deskItem.x + fx * 23, z: deskItem.z + fz * 23, rotDeg: (deskItem.rotDeg + 180) % 360, wallSnap: false },
    ];
    return tryPlaceCandidate(placed, chairCat.id, chairCands, resolveFinish(chairCat, palette, 'fabric'), room);
  };

  // Helper: place rug first so it sits cleanly under lounge area
  const addRug = (cx, cz, rotDeg = 0) => {
    const rugId = pick(['stoense_rug', 'lohals_rug']);
    const cat = ALL_CATALOG[rugId];
    return tryPlaceCandidate(
      placed,
      rugId,
      [{ x: cx, z: cz, rotDeg, wallSnap: false }],
      resolveFinish(cat, palette, 'rug'),
      room
    );
  };

  // Helper: sweep candidate positions along walls (respecting 5-sided straight West run z <= 46)
  const westWallCands = (zList) => zList.map((z) => ({ x: -halfW + 10, z, rotDeg: 90, wallSnap: true }));
  const eastWallCands = (zList) => zList.map((z) => ({ x: halfW - 10, z, rotDeg: -90, wallSnap: true }));
  const northWallCands = (xList) => xList.map((x) => ({ x, z: -halfL + 10, rotDeg: 0, wallSnap: true }));

  let deskItem = null;
  let desk2Item = null;
  let loveItem = null;

  if (arch.id === 'dual_face_off') {
    addRug(0, -12, 0);
    const loveX = pick([20, 24, -14]);
    loveItem = tryPlaceCandidate(placed, 'retained_loveseat', northWallCands([loveX, 22, -16]), 'slateBlue', room);
    desk2Item = tryPlaceCandidate(
      placed,
      'desk_42_monitor',
      westWallCands([-10, -6, -16, -2]),
      resolveFinish(ALL_CATALOG.desk_42_monitor, palette, 'wood'),
      room
    );
    if (desk2Item) placeDeskChair(desk2Item, 'jarvfjallet_chair');
    deskItem = tryPlaceCandidate(placed, deskCat.id, eastWallCands([22, 18, 26, 14]), deskCat.defaultFinish, room);
    if (deskItem) placeDeskChair(deskItem, 'markus_chair');
    tryPlaceCandidate(placed, 'billy_single', westWallCands([-60, -56, -64]), resolveFinish(ALL_CATALOG.billy_single, palette, 'storage'), room);
    tryPlaceCandidate(placed, 'alex_drawer', eastWallCands([59, -16, 56]), resolveFinish(ALL_CATALOG.alex_drawer, palette, 'storage'), room);
    tryPlaceCandidate(placed, 'nesna_nightstand', northWallCands([-48, 48]), resolveFinish(ALL_CATALOG.nesna_nightstand, palette, 'wood'), room);
  } else if (arch.id === 'dual_tandem_west') {
    addRug(10, -20, 0);
    desk2Item = tryPlaceCandidate(
      placed,
      'desk_42_monitor',
      westWallCands([-56, -58, -52]),
      resolveFinish(ALL_CATALOG.desk_42_monitor, palette, 'wood'),
      room
    );
    if (desk2Item) placeDeskChair(desk2Item, 'jarvfjallet_chair');
    tryPlaceCandidate(placed, 'alex_drawer', westWallCands([-20, -18, -22]), resolveFinish(ALL_CATALOG.alex_drawer, palette, 'storage'), room);
    deskItem = tryPlaceCandidate(placed, deskCat.id, westWallCands([16, 14, 18]), deskCat.defaultFinish, room);
    if (deskItem) placeDeskChair(deskItem, 'markus_chair');
    loveItem = tryPlaceCandidate(
      placed,
      'retained_loveseat',
      [
        { x: halfW - loveCat.d / 2 - 1, z: -48, rotDeg: -90, wallSnap: true },
        { x: halfW - loveCat.d / 2 - 1, z: -54, rotDeg: -90, wallSnap: true },
      ],
      'slateBlue',
      room
    );
    const eastStorage = pick(['kallax_4x2', 'storklinta_6drawer', 'gullaberg_3drawer']);
    tryPlaceCandidate(placed, eastStorage, eastWallCands([20, 24, 14]), resolveFinish(ALL_CATALOG[eastStorage], palette, 'storage'), room);
    tryPlaceCandidate(placed, 'nesna_nightstand', eastWallCands([-82, -14]), resolveFinish(ALL_CATALOG.nesna_nightstand, palette, 'wood'), room);
  } else if (arch.id === 'dual_l_corner_studio') {
    addRug(4, 14, 0);
    desk2Item = tryPlaceCandidate(
      placed,
      'desk_42_monitor',
      northWallCands([-24, -20, -28]),
      resolveFinish(ALL_CATALOG.desk_42_monitor, palette, 'wood'),
      room
    );
    if (desk2Item) placeDeskChair(desk2Item, 'jarvfjallet_chair');
    deskItem = tryPlaceCandidate(placed, deskCat.id, eastWallCands([-42, -38, -46]), deskCat.defaultFinish, room);
    if (deskItem) placeDeskChair(deskItem, 'markus_chair');
    loveItem = tryPlaceCandidate(
      placed,
      'retained_loveseat',
      [
        { x: -halfW + loveCat.d / 2 + 1, z: 14, rotDeg: 90, wallSnap: true },
        { x: -halfW + loveCat.d / 2 + 1, z: 10, rotDeg: 90, wallSnap: true },
      ],
      'slateBlue',
      room
    );
    tryPlaceCandidate(placed, 'lack_coffee', [{ x: 6, z: 14, rotDeg: 90, wallSnap: false }, { x: 4, z: 10, rotDeg: 90, wallSnap: false }], resolveFinish(ALL_CATALOG.lack_coffee, palette, 'wood'), room);
    const storageId = pick(['kallax_4x2', 'storklinta_6drawer', 'billy_double']);
    tryPlaceCandidate(placed, storageId, eastWallCands([22, 18, 26]), resolveFinish(ALL_CATALOG[storageId], palette, 'storage'), room);
  } else if (arch.id === 'dual_glare_free_split') {
    addRug(0, -14, 0);
    loveItem = tryPlaceCandidate(placed, 'retained_loveseat', northWallCands([-22, -26, -18]), 'slateBlue', room);
    desk2Item = tryPlaceCandidate(
      placed,
      'desk_42_monitor',
      eastWallCands([-34, -36, -32]),
      resolveFinish(ALL_CATALOG.desk_42_monitor, palette, 'wood'),
      room
    );
    if (desk2Item) placeDeskChair(desk2Item, 'jarvfjallet_chair');
    deskItem = tryPlaceCandidate(placed, deskCat.id, westWallCands([14, 10, 16]), deskCat.defaultFinish, room);
    if (deskItem) placeDeskChair(deskItem, 'markus_chair');
    tryPlaceCandidate(placed, 'billy_single', westWallCands([-34, -38, -30]), resolveFinish(ALL_CATALOG.billy_single, palette, 'storage'), room);
    const credenza = pick(['storklinta_6drawer', 'kallax_4x2', 'gullaberg_3drawer']);
    tryPlaceCandidate(placed, credenza, eastWallCands([26, 28, 22]), resolveFinish(ALL_CATALOG[credenza], palette, 'storage'), room);
  } else if (arch.id === 'dual_peninsula_collab') {
    addRug(-2, -16, 0);
    loveItem = tryPlaceCandidate(placed, 'retained_loveseat', northWallCands([30, 28, 32]), 'slateBlue', room);
    desk2Item = tryPlaceCandidate(
      placed,
      'desk_42_monitor',
      westWallCands([-38, -36, -42]),
      resolveFinish(ALL_CATALOG.desk_42_monitor, palette, 'wood'),
      room
    );
    if (desk2Item) placeDeskChair(desk2Item, 'jarvfjallet_chair');
    deskItem = tryPlaceCandidate(placed, deskCat.id, eastWallCands([16, 20, 12]), deskCat.defaultFinish, room);
    if (deskItem) placeDeskChair(deskItem, 'markus_chair');
    tryPlaceCandidate(placed, 'billy_single', westWallCands([16, 20, 12]), resolveFinish(ALL_CATALOG.billy_single, palette, 'storage'), room);
    tryPlaceCandidate(placed, 'alex_drawer', eastWallCands([-24, 54, -28]), resolveFinish(ALL_CATALOG.alex_drawer, palette, 'storage'), room);
    tryPlaceCandidate(placed, 'fado_lamp', northWallCands([-48, 50]), 'white', room);
  } else if (arch.id === 'east_desk_north_lounge') {
    addRug(-4, -22, 0);
    // Retained Loveseat near North-East / North-Center
    const loveX = pick([14, 22, -16]);
    const loveRot = loveX > 0 ? pick([0, -10]) : pick([0, 10]);
    loveItem = tryPlaceCandidate(
      placed,
      'retained_loveseat',
      [
        { x: loveX, z: -halfL + loveCat.d / 2 + 1, rotDeg: loveRot, wallSnap: true },
        { x: 18, z: -halfL + 22, rotDeg: 0, wallSnap: true },
      ],
      'slateBlue',
      room
    );
    // Retained Desk on East wall mid-South
    deskItem = tryPlaceCandidate(
      placed,
      deskCat.id,
      eastWallCands([14, 18, 8, 22]),
      deskCat.defaultFinish,
      room
    );
    if (deskItem) placeDeskChair(deskItem);

    // Storage along West wall (mix of tall + low units)
    const westPrimary = pick(['billy_double', 'kallax_4x4', 'malm_6drawer', 'besta_tv']);
    tryPlaceCandidate(placed, westPrimary, westWallCands([-40, -34, -28]), resolveFinish(ALL_CATALOG[westPrimary], palette, 'wood'), room);
    const westSecondary = pick(['kallax_4x2', 'hemnes_3drawer', 'billy_single', 'pax_wardrobe']);
    tryPlaceCandidate(placed, westSecondary, westWallCands([26, 22, 32, 16]), resolveFinish(ALL_CATALOG[westSecondary], palette, 'storage'), room);

    // Desk drawer & Coffee/Side table
    tryPlaceCandidate(placed, 'alex_drawer', eastWallCands([54, -26, 50]), resolveFinish(ALL_CATALOG.alex_drawer, palette, 'storage'), room);
    const tableId = pick(['listerby_round', 'lack_coffee', 'nesna_nightstand']);
    tryPlaceCandidate(
      placed,
      tableId,
      [
        { x: (loveItem?.x || 12) - 8, z: -26, rotDeg: 0, wallSnap: false },
        { x: (loveItem?.x || 12) + 36, z: -72, rotDeg: 0, wallSnap: false },
        { x: 0, z: -30, rotDeg: 0, wallSnap: false },
      ],
      resolveFinish(ALL_CATALOG[tableId], palette, 'wood'),
      room
    );
  } else if (arch.id === 'window_desk_east_lounge') {
    addRug(2, 6, 0);
    // Retained Desk centered right under the bright North double window!
    deskItem = tryPlaceCandidate(
      placed,
      deskCat.id,
      [
        { x: -8, z: -halfL + deskCat.d / 2, rotDeg: 180, wallSnap: true },
        { x: 0, z: -halfL + deskCat.d / 2, rotDeg: 180, wallSnap: true },
      ],
      deskCat.defaultFinish,
      room
    );
    if (deskItem) placeDeskChair(deskItem);

    // Retained Loveseat along East wall facing West toward media/shelving wall!
    loveItem = tryPlaceCandidate(
      placed,
      'retained_loveseat',
      eastWallCands([10, 16, 4, 22]),
      'slateBlue',
      room
    );

    // Media console or low storage on West wall opposite the loveseat
    const mediaId = pick(['besta_tv', 'kallax_4x2', 'malm_6drawer']);
    tryPlaceCandidate(placed, mediaId, westWallCands([12, 16, 6]), resolveFinish(ALL_CATALOG[mediaId], palette, 'wood'), room);

    // Secondary accent chair or tall bookcase on West/North-East
    const accentId = pick(['billy_single', 'poang_chair', 'hemnes_3drawer']);
    tryPlaceCandidate(placed, accentId, westWallCands([-44, -36, -50]), resolveFinish(ALL_CATALOG[accentId], palette, 'storage'), room);

    // Side table next to loveseat & ALEX beside desk
    const sideId = pick(['nesna_nightstand', 'hemnes_nightstand', 'lack_coffee']);
    tryPlaceCandidate(
      placed,
      sideId,
      [
        { x: halfW - 14, z: (loveItem?.z || 12) - 38, rotDeg: -90, wallSnap: true },
        { x: 4, z: 12, rotDeg: 90, wallSnap: false },
      ],
      resolveFinish(ALL_CATALOG[sideId], palette, 'wood'),
      room
    );
    tryPlaceCandidate(
      placed,
      'alex_drawer',
      northWallCands([32, 42, -46]),
      resolveFinish(ALL_CATALOG.alex_drawer, palette, 'storage'),
      room
    );
  } else if (arch.id === 'west_desk_corner_lounge') {
    addRug(4, -14, 0);
    // Retained Desk along West wall (mid-north)
    deskItem = tryPlaceCandidate(
      placed,
      deskCat.id,
      westWallCands([-16, -24, -8, 4]),
      deskCat.defaultFinish,
      room
    );
    if (deskItem) placeDeskChair(deskItem);

    // Big Loveseat in NE corner
    loveItem = tryPlaceCandidate(
      placed,
      'retained_loveseat',
      [
        { x: 24, z: -halfL + 22, rotDeg: pick([0, -12]), wallSnap: true },
        { x: 26, z: -halfL + 24, rotDeg: 0, wallSnap: true },
      ],
      'slateBlue',
      room
    );

    // Storage along East wall (South of loveseat)
    const eastUnit = pick(['kallax_4x2', 'besta_tv', 'hemnes_3drawer', 'billy_double']);
    tryPlaceCandidate(placed, eastUnit, eastWallCands([20, 26, 14, 30]), resolveFinish(ALL_CATALOG[eastUnit], palette, 'wood'), room);

    // Tall bookcase on West wall South of desk or North of desk
    tryPlaceCandidate(placed, 'billy_single', westWallCands([36, -68, 32]), resolveFinish(ALL_CATALOG.billy_single, palette, 'storage'), room);
    tryPlaceCandidate(placed, 'alex_drawer', westWallCands([-60, 22]), resolveFinish(ALL_CATALOG.alex_drawer, palette, 'storage'), room);

    // Coffee or side table by loveseat
    const tbl = pick(['listerby_round', 'nesna_nightstand']);
    tryPlaceCandidate(
      placed,
      tbl,
      [
        { x: 24, z: -26, rotDeg: 0, wallSnap: false },
        { x: halfW - 12, z: -38, rotDeg: -90, wallSnap: true },
      ],
      resolveFinish(ALL_CATALOG[tbl], palette, 'wood'),
      room
    );
  } else if (arch.id === 'guest_daybed_suite') {
    addRug(4, -8, 0);
    // HEMNES or BRIMNES Daybed along straight West wall with >=28" walkway past NE Loveseat
    const daybedId = pick(['hemnes_daybed', 'brimnes_daybed']);
    tryPlaceCandidate(
      placed,
      daybedId,
      westWallCands([-16, -18, -14]),
      resolveFinish(ALL_CATALOG[daybedId], palette, 'storage'),
      room
    );
    // Retained Loveseat in NE corner
    loveItem = tryPlaceCandidate(
      placed,
      'retained_loveseat',
      [
        { x: 28, z: -halfL + 21, rotDeg: 0, wallSnap: true },
        { x: 30, z: -halfL + 22, rotDeg: 0, wallSnap: true },
      ],
      'slateBlue',
      room
    );
    // Retained Desk on East wall
    deskItem = tryPlaceCandidate(placed, deskCat.id, eastWallCands([24, 22, 26]), deskCat.defaultFinish, room);
    if (deskItem) placeDeskChair(deskItem);

    // Nightstand + Floating EKET Wall Cube
    const ns = pick(['nesna_nightstand', 'hemnes_nightstand']);
    tryPlaceCandidate(placed, ns, westWallCands([-64, -66, -62]), resolveFinish(ALL_CATALOG[ns], palette, 'wood'), room);
    tryPlaceCandidate(placed, 'eket_wall_shelf', eastWallCands([24, -18, 20]), resolveFinish(ALL_CATALOG.eket_wall_shelf, palette, 'storage'), room);
  } else if (arch.id === 'guest_full_bed_office') {
    addRug(0, -16, 0);
    // Compact MALM Full or TARVA Twin in NW corner
    const bedId = pick(['malm_full', 'tarva_twin']);
    tryPlaceCandidate(
      placed,
      bedId,
      [
        { x: -halfW + ALL_CATALOG[bedId].w / 2 + 2, z: -halfL + ALL_CATALOG[bedId].d / 2 + 1, rotDeg: 0, wallSnap: true },
      ],
      resolveFinish(ALL_CATALOG[bedId], palette, 'wood'),
      room
    );
    // Retained Loveseat along East wall (North or mid)
    loveItem = tryPlaceCandidate(placed, 'retained_loveseat', eastWallCands([-48, -42, -54]), 'slateBlue', room);
    // Retained Desk on East wall South or West wall mid-South
    deskItem = tryPlaceCandidate(
      placed,
      deskCat.id,
      [...eastWallCands([20, 24, 14]), ...westWallCands([20, 14])],
      deskCat.defaultFinish,
      room
    );
    if (deskItem) placeDeskChair(deskItem);

    // Nightstand + Slim BILLY
    tryPlaceCandidate(placed, 'nesna_nightstand', northWallCands([14, 18, 22]), resolveFinish(ALL_CATALOG.nesna_nightstand, palette, 'wood'), room);
    tryPlaceCandidate(placed, 'billy_single', westWallCands([24, 30, 36]), resolveFinish(ALL_CATALOG.billy_single, palette, 'storage'), room);
  } else if (arch.id === 'library_sanctuary') {
    addRug(-2, -16, 0);
    // Full BILLY library wall on West wall!
    tryPlaceCandidate(placed, 'billy_double', westWallCands([-46, -42]), resolveFinish(ALL_CATALOG.billy_double, palette, 'wood'), room);
    tryPlaceCandidate(placed, 'billy_double', westWallCands([20, 22]), resolveFinish(ALL_CATALOG.billy_double, palette, 'wood'), room);

    // Retained Loveseat + Reading Chair pair
    loveItem = tryPlaceCandidate(placed, 'retained_loveseat', northWallCands([18, 22, 12]), 'slateBlue', room);
    const reader = pick(['poang_chair', 'strandmon']);
    tryPlaceCandidate(
      placed,
      reader,
      [
        { x: -24, z: -64, rotDeg: 35, wallSnap: false },
        { x: -22, z: -56, rotDeg: 45, wallSnap: false },
      ],
      resolveFinish(ALL_CATALOG[reader], palette, 'fabric'),
      room
    );
    // Round coffee table between reading chairs
    tryPlaceCandidate(
      placed,
      'listerby_round',
      [{ x: 4, z: -26, rotDeg: 0, wallSnap: false }, { x: 0, z: -30, rotDeg: 0, wallSnap: false }],
      resolveFinish(ALL_CATALOG.listerby_round, palette, 'wood'),
      room
    );
    // Retained Desk on East wall
    deskItem = tryPlaceCandidate(placed, deskCat.id, eastWallCands([18, 22, 14]), deskCat.defaultFinish, room);
    if (deskItem) placeDeskChair(deskItem);
  } else {
    // kids_kura_study
    addRug(0, -4, 0);
    tryPlaceCandidate(
      placed,
      'kura_bed',
      [{ x: -halfW + 21, z: -halfL + 40, rotDeg: 0, wallSnap: true }],
      resolveFinish(ALL_CATALOG.kura_bed, palette, 'wood'),
      room
    );
    tryPlaceCandidate(placed, 'trofast', westWallCands([6, 10, 4]), resolveFinish(ALL_CATALOG.trofast, palette, 'wood'), room);
    tryPlaceCandidate(placed, 'billy_single', westWallCands([42, 40]), resolveFinish(ALL_CATALOG.billy_single, palette, 'storage'), room);
    loveItem = tryPlaceCandidate(placed, 'retained_loveseat', northWallCands([32, 28]), 'slateBlue', room);
    deskItem = tryPlaceCandidate(placed, deskCat.id, eastWallCands([16, 20, 12]), deskCat.defaultFinish, room);
    if (deskItem) placeDeskChair(deskItem);
    tryPlaceCandidate(placed, 'nesna_nightstand', eastWallCands([-44, -40]), resolveFinish(ALL_CATALOG.nesna_nightstand, palette, 'wood'), room);
  }

  // Finishing touches: Floor Lamp & Potted Plant in available corners!
  const cornerSpots = shuffled([
    { x: halfW - 8, z: -halfL + 8, rotDeg: 0, wallSnap: true },
    { x: -halfW + 9, z: -halfL + 9, rotDeg: 0, wallSnap: true },
    { x: halfW - 8, z: -38, rotDeg: 0, wallSnap: true },
    { x: halfW - 8, z: 54, rotDeg: 0, wallSnap: true },
    { x: -halfW + 10, z: 46, rotDeg: 0, wallSnap: true },
  ]);
  tryPlaceCandidate(placed, 'hektar_lamp', cornerSpots, resolveFinish(ALL_CATALOG.hektar_lamp, palette, 'lamp'), room);
  tryPlaceCandidate(placed, 'fejka_plant', shuffled(cornerSpots), resolveFinish(ALL_CATALOG.fejka_plant, palette, 'plant'), room);

  // Compute summary stats (count actual IKEA purchases; Move-In & Retained are $0)
  let ikeaCost = 0;
  let ikeaCount = 0;
  for (const it of placed) {
    const c = ALL_CATALOG[it.catalogId];
    if (c && !c.retained && c.brand === 'IKEA') {
      ikeaCost += c.price;
      ikeaCount++;
    }
  }

  return {
    archetypeId: arch.id,
    title: arch.title,
    paletteName: palette.name,
    ikeaCount,
    ikeaCost,
    items: placed,
  };
}
