import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  IN_TO_M,
  M_TO_IN,
  DEFAULT_ROOM,
  FINISH_SWATCHES,
  CATEGORIES,
  IKEA_CATALOG,
  RETAINED_CATALOG,
  ALL_CATALOG,
  LAYOUT_PRESETS,
  RENTON_SYNC_META,
  registerDynamicCatalogItem,
} from './catalog.js';
import { buildRoom } from './roomBuilder.js';
import { createFurnitureMesh } from './furnitureMesh.js';
import {
  getItemDimensionsIn,
  clampAndSnapToRoom,
  checkPlacementStatus,
  getWestWallXAtZ,
  getRoomFloorAreaSqIn,
} from './collision.js';
import { PRODUCT_THUMBNAILS } from './productThumbnails.js';
import { generateOptimizedLayout } from './optimizer.js';
import { AGENT_QUICK_PROMPTS, runLayoutAgentCommand, resolveGeminiModelId } from './layoutAgent.js';
import {
  DEFAULT_AGENT_SETTINGS,
  loadAgentSettings,
  saveAgentSettings,
  clearStoredApiKey,
  testGeminiApiKey,
} from './keyVault.js';
import { FisheyeLensRig } from './fisheyeLens.js';
import { searchLiveRentonInventory } from './rentonLookup.js';
import {
  AUTO_STATE_KEY,
  SAVED_CONFIGS_KEY,
  detectLocalStorageAvailable,
  idbGet,
  buildConfigSnapshot,
  validateAndNormalizeConfig,
  loadAutoSavedConfig,
  persistAutoSavedConfig,
  loadSavedConfigsList,
  persistSavedConfigsList,
  buildBackupBundle,
  downloadJsonFile,
  formatSavedTimestamp,
  slugifyFilename,
} from './persistence.js';

import {
  getGoogleClientId,
  setGoogleClientId,
  loadGoogleUserHint,
  signInWithGoogleDrive,
  signOutGoogleDrive,
  pullFromGoogleDrive,
  pushToGoogleDrive,
} from './googleDriveSync.js';

// ======================== STATE ========================
const STORAGE_KEY = 'room_planner_v4_state';
const AGENT_CFG_KEY = 'room_planner_llm_cfg';
const NUDGE_STEP_CM = 25;
const NUDGE_FINE_CM = 5;
const CM_TO_IN = 1 / 2.54;

const state = {
  room: { ...DEFAULT_ROOM },
  items: [], // { uid, catalogId, x, z, rotDeg, finish, expanded }
  selectedUid: null,
  placingCatalogId: null,
  placingRotDeg: 0,
  placingFinish: null,
  placingStatus: null,
  wallMode: 'cutaway', // 'cutaway' | 'up' | 'down'
  viewMode: '3d',      // '3d' | '2d' | 'fp'
  fisheyeMode: 'equidistant', // 'equidistant' | 'panini' | 'stereographic' | 'rectilinear'
  fisheyeFovDeg: 138,         // 90° .. 165° horizontal FOV for Eye-Level curvilinear shader
  eyeVantage: 'doorway',      // 'doorway' | 'nw' | 'ne' | 'se' | 'center'
  lightingMood: 'day', // 'day' | 'evening'
  units: 'imperial',   // 'imperial' | 'metric'
  gridSnapIn: 1,
  wallSnap: true,
  showGrid: true,
  showClearances: true,
  showDimensions: true,
  closetOpen: true,
  entryDoorOpen: true,
  activeCategory: 'all',
  searchQuery: '',
  retainedDeskId: 'retained_wood_desk',
  measureMode: false,
  measureActive: false, // true while aiming from Point A -> Point B
  measureStart: null,   // THREE.Vector3
  measureEnd: null,
  optimizerGoal: 'dual_office',
  lastArchetypeId: null,
  undoStack: [],
};

let uidCounter = 1;
const nextUid = () => `item_${uidCounter++}`;
const normDeg = (deg) => ((Math.round(deg) % 360) + 360) % 360;

// ======================== FORMATTERS ========================
function formatLen(inches) {
  if (state.units === 'metric') {
    const cm = Math.round(inches * 2.54);
    if (cm >= 100) return `${(cm / 100).toFixed(2)} m`;
    return `${cm} cm`;
  }
  const rounded = Math.round(inches * 2) / 2;
  const ft = Math.floor(rounded / 12);
  const rem = +(rounded - ft * 12).toFixed(1);
  if (ft === 0) return `${rem}"`;
  if (rem === 0) return `${ft}'`;
  return `${ft}' ${rem}"`;
}

function formatDimsShort(w, d, h) {
  if (state.units === 'metric') {
    return `${Math.round(w * 2.54)}×${Math.round(d * 2.54)}×${Math.round(h * 2.54)} cm`;
  }
  return `${Math.round(w)}"×${Math.round(d)}"×${Math.round(h)}"`;
}

function formatFootprintShort(w, d) {
  if (state.units === 'metric') {
    return `${Math.round(w * 2.54)}×${Math.round(d * 2.54)} cm`;
  }
  return `${Math.round(w)}"×${Math.round(d)}"`;
}

function cleanSubtitle(sub) {
  // Strip hardcoded imperial dimension suffixes (e.g. "· 31½×11×79½\"") when showing metric so units never mix
  if (state.units === 'metric') {
    return sub.replace(/\s*·\s*[0-9½¼¾⅜⅝⅞×"'′\s]+(dia|tall|in)?$/i, '').trim();
  }
  return sub;
}

function formatArea(wIn, lIn) {
  const areaSqIn = getRoomFloorAreaSqIn({ ...state.room, widthIn: wIn, lengthIn: lIn });
  if (state.units === 'metric') {
    const sqm = areaSqIn * IN_TO_M * IN_TO_M;
    return `${sqm.toFixed(1)} m²`;
  }
  const sqft = areaSqIn / 144;
  return `${sqft.toFixed(1)} sq ft`;
}

// ======================== THREE.JS SETUP ========================
const viewport = document.getElementById('viewport');
const labelsLayer = document.getElementById('labels-layer');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xece9e2);

const camera = new THREE.PerspectiveCamera(44, window.innerWidth / window.innerHeight, 0.08, 60);
camera.position.set(4.1, 4.3, 4.6);

let renderer;
let hasWebGL = true;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  viewport.appendChild(renderer.domElement);
} catch (_) {
  hasWebGL = false;
  const fallbackEl = document.createElement('div');
  fallbackEl.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:#ece9e2;color:#0f172a;font-family:system-ui,sans-serif;text-align:center;';
  fallbackEl.innerHTML =
    '<div style="max-width:480px;background:#fff;border-radius:14px;padding:24px;box-shadow:0 8px 28px rgba(15,23,42,.1);">' +
    '<h2 style="margin:0 0 8px;font-size:20px;">Room Studio 3D</h2>' +
    '<p style="margin:0 0 12px;font-size:14px;color:#475569;line-height:1.5;">Interactive WebGL 3D room layout planner with live IKEA Renton WA (#488) inventory lookup, Gemini 4 AI Layout Planner, and optional Google Drive appDataFolder sync. Enable WebGL in your browser to explore the 3D viewport.</p>' +
    '<p style="margin:0;font-size:13px;"><a href="./privacy.html" style="color:#0058a3;font-weight:600;margin-right:14px;">Privacy Policy</a><a href="./terms.html" style="color:#0058a3;font-weight:600;">Terms of Service</a></p>' +
    '</div>';
  viewport.appendChild(fallbackEl);
  renderer = {
    domElement: fallbackEl,
    setSize() {},
    setPixelRatio() {},
    setRenderTarget() {},
    render() {},
    shadowMap: {},
  };
}

// Eye-Level Curvilinear Fisheye / Panini / Stereographic Lens Shader Rig
const fisheyeRig = hasWebGL
  ? new FisheyeLensRig(renderer, 768)
  : {
      isActive: () => false,
      invalidate() {},
      render() {},
      setMode() {},
      setFovDeg() {},
      unprojectClientPoint: () => null,
      projectWorldPoint: () => null,
    };

function isFisheyeActive() {
  return hasWebGL && state.viewMode === 'fp' && fisheyeRig.isActive();
}

function invalidateFisheye() {
  if (hasWebGL) fisheyeRig.invalidate();
}

function renderActiveView(forceCubemap = false) {
  if (!hasWebGL) return;
  if (isFisheyeActive()) {
    fisheyeRig.render(renderer, scene, camera, window.innerWidth, window.innerHeight, forceCubemap);
  } else {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.minDistance = 1.1;
controls.maxDistance = 15;
controls.target.set(0, 0.45, 0);

// Lighting Rig
const hemiLight = new THREE.HemisphereLight(0xf8fbff, 0xcab9a3, 0.85);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfffaf0, 1.35);
sunLight.position.set(3.2, 6.5, -4.5);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far = 18;
sunLight.shadow.camera.left = -5;
sunLight.shadow.camera.right = 5;
sunLight.shadow.camera.top = 5;
sunLight.shadow.camera.bottom = -5;
sunLight.shadow.bias = -0.0005;
scene.add(sunLight);

const fillLight = new THREE.DirectionalLight(0xdbe8f8, 0.42);
fillLight.position.set(-4.0, 3.5, 4.0);
scene.add(fillLight);

const ceilingLight = new THREE.PointLight(0xffdfad, 0, 9.5, 1.6);
ceilingLight.position.set(0.25, 2.32, 1.08);
ceilingLight.castShadow = true;
ceilingLight.shadow.bias = -0.001;
scene.add(ceilingLight);

const backdropFloor = new THREE.Mesh(
  new THREE.CircleGeometry(18, 48),
  new THREE.MeshStandardMaterial({ color: 0xe3dfd6, roughness: 0.96 })
);
backdropFloor.rotation.x = -Math.PI / 2;
backdropFloor.position.y = -0.125;
backdropFloor.receiveShadow = true;
scene.add(backdropFloor);

// ======================== SCENE GROUPS ========================
let roomObj = null;
const furnitureRoot = new THREE.Group();
furnitureRoot.name = 'FurnitureRoot';
scene.add(furnitureRoot);

const meshByUid = new Map();

let ghostGroup = null;
let ghostFootprint = null;
let ghostMeshNodes = [];

const guidesGroup = new THREE.Group();
scene.add(guidesGroup);

const tapeGroup = new THREE.Group();
scene.add(tapeGroup);

function rebuildRoomArchitecture() {
  if (roomObj) scene.remove(roomObj.root);
  roomObj = buildRoom(state.room);
  scene.add(roomObj.root);
  roomObj.gridGroup.visible = state.showGrid;
  roomObj.clearanceGroup.visible = state.showClearances;
  roomObj.setClosetOpen(state.closetOpen ? 0.82 : 0.02);
  roomObj.setEntryDoorOpen(state.entryDoorOpen ? 0.9 : 0.04);
  roomObj.setLightingMood(state.lightingMood);
  ceilingLight.position.set(
    0.25,
    state.room.heightIn * IN_TO_M - 0.12,
    (state.room.lengthIn / 2) * IN_TO_M - 1.25
  );
  updateRoomMetaHeader();
  revalidateAllItems();
}

function updateFurnitureLampLights() {
  const lampIntensity = state.lightingMood === 'evening' ? 1.85 : 0.0;
  furnitureRoot.traverse((obj) => {
    if (obj.isPointLight && obj.name === 'furnitureLampLight') {
      obj.intensity = lampIntensity;
    }
  });
}

function applyLightingMood() {
  if (state.lightingMood === 'day') {
    scene.background.setHex(0xece9e2);
    backdropFloor.material.color.setHex(0xe3dfd6);
    hemiLight.intensity = 0.88;
    hemiLight.color.setHex(0xf8fbff);
    sunLight.intensity = 1.35;
    fillLight.intensity = 0.42;
    ceilingLight.intensity = 0.0;
    renderer.toneMappingExposure = 1.06;
  } else {
    scene.background.setHex(0x212832);
    backdropFloor.material.color.setHex(0x1b212a);
    hemiLight.intensity = 0.34;
    hemiLight.color.setHex(0x8ea7c7);
    sunLight.intensity = 0.12;
    fillLight.intensity = 0.16;
    ceilingLight.intensity = 2.4;
    renderer.toneMappingExposure = 1.04;
  }
  if (roomObj) roomObj.setLightingMood(state.lightingMood);
  updateFurnitureLampLights();
  const label = state.lightingMood === 'day' ? 'Day' : 'Evening';
  const b1 = document.getElementById('btn-lighting');
  const b2 = document.getElementById('pop-lighting-btn');
  if (b1) b1.textContent = label;
  if (b2) b2.textContent = label;
  invalidateFisheye();
}

// ======================== FURNITURE MANAGEMENT ========================
function createFootprintOutline(wM, dM, colorHex) {
  const g = new THREE.Group();
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(wM + 0.04, dM + 0.04),
    new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 0.017;
  plane.renderOrder = 4;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(wM + 0.04, dM + 0.04)),
    new THREE.LineBasicMaterial({ color: colorHex, depthWrite: false })
  );
  edges.rotation.x = -Math.PI / 2;
  edges.position.y = 0.019;
  edges.renderOrder = 5;

  const arrowShape = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.07, 0.02, dM / 2 + 0.04),
    new THREE.Vector3(0, 0.02, dM / 2 + 0.12),
    new THREE.Vector3(0.07, 0.02, dM / 2 + 0.04),
  ]);
  const arrow = new THREE.Line(arrowShape, new THREE.LineBasicMaterial({ color: colorHex, depthWrite: false }));
  arrow.renderOrder = 5;

  g.add(plane, edges, arrow);
  g.userData.planeMat = plane.material;
  g.userData.edgeMat = edges.material;
  g.userData.arrowMat = arrow.material;
  return g;
}

function setFootprintColor(fp, colorHex, opacity = 0.2) {
  if (!fp) return;
  fp.userData.planeMat.color.setHex(colorHex);
  fp.userData.planeMat.opacity = opacity;
  fp.userData.edgeMat.color.setHex(colorHex);
  fp.userData.arrowMat.color.setHex(colorHex);
}

function syncItemMesh(item, animatePop = false) {
  const cat = ALL_CATALOG[item.catalogId];
  if (!cat) return;
  const existing = meshByUid.get(item.uid);
  if (existing) {
    furnitureRoot.remove(existing.group);
    meshByUid.delete(item.uid);
  }

  const wrapper = new THREE.Group();
  wrapper.userData.uid = item.uid;
  const mesh = createFurnitureMesh(cat, item.finish, { expanded: !!item.expanded });
  mesh.traverse((c) => {
    c.userData.uid = item.uid;
  });
  wrapper.add(mesh);

  const dims = getItemDimensionsIn(item, cat);
  const fp = createFootprintOutline(dims.w * IN_TO_M, dims.d * IN_TO_M, 0x0058a3);
  fp.visible = false;
  wrapper.add(fp);

  wrapper.position.set(item.x * IN_TO_M, 0, item.z * IN_TO_M);
  wrapper.rotation.y = (item.rotDeg * Math.PI) / 180;

  furnitureRoot.add(wrapper);
  meshByUid.set(item.uid, {
    group: wrapper,
    footprint: fp,
    popStart: animatePop ? performance.now() : null,
  });
  updateFurnitureLampLights();
}

function pushUndoSnapshot() {
  state.undoStack.push(JSON.stringify(state.items));
  if (state.undoStack.length > 35) state.undoStack.shift();
}

function undo() {
  if (state.undoStack.length === 0) return;
  const prev = JSON.parse(state.undoStack.pop());
  loadItemsList(prev, false);
}

function loadItemsList(rawItems, saveUndo = false) {
  if (saveUndo) pushUndoSnapshot();
  clearGhost(); // Always cancel active Buy Mode placement when switching layouts/presets!
  for (const [, entry] of meshByUid) {
    furnitureRoot.remove(entry.group);
  }
  meshByUid.clear();
  state.items = rawItems.map((it) => ({
    uid: it.uid || nextUid(),
    catalogId: it.catalogId,
    x: it.x,
    z: it.z,
    rotDeg: normDeg(it.rotDeg || 0),
    finish: it.finish || ALL_CATALOG[it.catalogId]?.defaultFinish || 'white',
    expanded: !!it.expanded,
  }));

  const hasWhite = state.items.some((i) => i.catalogId === 'retained_white_desk');
  const hasWood = state.items.some((i) => i.catalogId === 'retained_wood_desk');
  if (hasWhite && !hasWood) state.retainedDeskId = 'retained_white_desk';
  else if (hasWood) state.retainedDeskId = 'retained_wood_desk';

  for (const item of state.items) {
    syncItemMesh(item, false);
  }
  state.selectedUid = null;
  revalidateAllItems();
  updateInspector();
  updateCartBadge();
  updateLeftRail();
  saveToStorage();
}

function revalidateAllItems() {
  for (const item of state.items) {
    const entry = meshByUid.get(item.uid);
    if (!entry) continue;
    const status = checkPlacementStatus(item, state.items, ALL_CATALOG, state.room);
    item._status = status;
    entry.group.position.y = (status.elevationIn || 0) * IN_TO_M;

    const isSelected = item.uid === state.selectedUid;
    if (status.colliding) {
      entry.footprint.visible = true;
      setFootprintColor(entry.footprint, 0xdc2626, isSelected ? 0.3 : 0.18);
    } else if (status.warningOnly) {
      entry.footprint.visible = true;
      setFootprintColor(entry.footprint, 0xd97706, isSelected ? 0.25 : 0.14);
    } else if (isSelected) {
      entry.footprint.visible = true;
      setFootprintColor(entry.footprint, 0x0058a3, 0.2);
    } else {
      entry.footprint.visible = false;
    }
  }
  rebuildSelectionGuides();
  invalidateFisheye();
}

let wallDistAnchors = [];
function rebuildSelectionGuides() {
  while (guidesGroup.children.length > 0) {
    guidesGroup.remove(guidesGroup.children[0]);
  }
  wallDistAnchors = [];
  if (!state.selectedUid) return;
  const item = state.items.find((i) => i.uid === state.selectedUid);
  if (!item || !item._status) return;

  const { aabb, distances } = item._status;
  const halfW = state.room.widthIn / 2;
  const halfL = state.room.lengthIn / 2;
  const cx = ((aabb.minX + aabb.maxX) / 2) * IN_TO_M;
  const cz = ((aabb.minZ + aabb.maxZ) / 2) * IN_TO_M;

  const lineMat = new THREE.LineBasicMaterial({ color: 0x0058a3, transparent: true, opacity: 0.72 });
  const addLaser = (x1, z1, x2, z2, distIn) => {
    if (distIn < 1.5) return;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x1, 0.025, z1),
      new THREE.Vector3(x2, 0.025, z2),
    ]);
    guidesGroup.add(new THREE.Line(geo, lineMat));
    wallDistAnchors.push({
      pos: new THREE.Vector3((x1 + x2) / 2, 0.05, (z1 + z2) / 2),
      text: formatLen(distIn),
    });
  };

  const czIn = (aabb.minZ + aabb.maxZ) / 2;
  const westWallAtCz = getWestWallXAtZ(czIn, state.room) * IN_TO_M;
  addLaser(aabb.minX * IN_TO_M, cz, westWallAtCz, cz, distances.west);
  addLaser(aabb.maxX * IN_TO_M, cz, halfW * IN_TO_M, cz, distances.east);
  addLaser(cx, aabb.minZ * IN_TO_M, cx, -halfL * IN_TO_M, distances.north);
  addLaser(cx, aabb.maxZ * IN_TO_M, cx, halfL * IN_TO_M, distances.south);
}

// ======================== SIMS BUY MODE GHOST ========================
function startPlacing(catalogId) {
  stopMeasureMode();
  clearGhost();
  const cat = ALL_CATALOG[catalogId];
  if (!cat) return;
  // Never allow placing a duplicate unique retained item if it is already in the room
  if (cat.retained && !cat.isRug && state.items.some((i) => i.catalogId === catalogId)) {
    const existing = state.items.find((i) => i.catalogId === catalogId);
    state.selectedUid = existing.uid;
    revalidateAllItems();
    updateInspector();
    return;
  }

  state.placingCatalogId = catalogId;
  state.placingRotDeg = 0;
  state.placingFinish = cat.defaultFinish;
  state.placingStatus = null;
  state.selectedUid = null;
  revalidateAllItems();
  updateInspector();

  ghostGroup = new THREE.Group();
  ghostMeshNodes = [];
  const mesh = createFurnitureMesh(cat, state.placingFinish);
  mesh.traverse((c) => {
    if (c.isMesh && c.material) {
      c.material = c.material.clone();
      c.material.transparent = true;
      c.material.opacity = 0.72;
      c.castShadow = false;
      c.userData.origColor = c.material.color ? c.material.color.clone() : new THREE.Color(0xffffff);
      ghostMeshNodes.push(c);
    }
  });
  ghostGroup.add(mesh);

  ghostFootprint = createFootprintOutline(cat.w * IN_TO_M, cat.d * IN_TO_M, 0x15803d);
  ghostGroup.add(ghostFootprint);
  ghostGroup.visible = false;
  scene.add(ghostGroup);

  viewport.classList.add('placing');
  updateModeBanner();
  renderCatalogCards();
}

function clearGhost() {
  if (ghostGroup) {
    scene.remove(ghostGroup);
    ghostGroup = null;
    ghostFootprint = null;
    ghostMeshNodes = [];
  }
  state.placingCatalogId = null;
  state.placingStatus = null;
  viewport.classList.remove('placing');
  updateModeBanner();
  renderCatalogCards();
  invalidateFisheye();
}

function applyGhostTint(mode) {
  const red = new THREE.Color(0xdc2626);
  const amber = new THREE.Color(0xd97706);
  for (const m of ghostMeshNodes) {
    const orig = m.userData.origColor;
    if (!orig || !m.material?.color) continue;
    if (mode === 'error') {
      m.material.color.copy(orig).lerp(red, 0.72);
      m.material.opacity = 0.78;
    } else if (mode === 'warn') {
      m.material.color.copy(orig).lerp(amber, 0.52);
      m.material.opacity = 0.76;
    } else {
      m.material.color.copy(orig);
      m.material.opacity = 0.72;
    }
  }
}

function updateGhostAtWorldPoint(worldPt) {
  if (!ghostGroup || !state.placingCatalogId) return;
  const cat = ALL_CATALOG[state.placingCatalogId];
  const rawX = worldPt.x * M_TO_IN;
  const rawZ = worldPt.z * M_TO_IN;
  const snapped = clampAndSnapToRoom(rawX, rawZ, cat.w, cat.d, state.placingRotDeg, state.room, {
    gridSnapIn: state.gridSnapIn,
    wallSnap: state.wallSnap,
  });

  const status = checkPlacementStatus(
    { uid: '__ghost__', catalogId: cat.id, x: snapped.x, z: snapped.z, rotDeg: state.placingRotDeg },
    state.items,
    ALL_CATALOG,
    state.room
  );
  state.placingStatus = status;

  ghostGroup.visible = true;
  ghostGroup.position.set(snapped.x * IN_TO_M, (status.elevationIn || 0) * IN_TO_M, snapped.z * IN_TO_M);
  ghostGroup.rotation.y = (state.placingRotDeg * Math.PI) / 180;
  ghostGroup.userData.snapped = snapped;

  if (status.colliding) {
    setFootprintColor(ghostFootprint, 0xdc2626, 0.35);
    applyGhostTint('error');
  } else if (status.warningOnly) {
    setFootprintColor(ghostFootprint, 0xd97706, 0.3);
    applyGhostTint('warn');
  } else {
    setFootprintColor(ghostFootprint, 0x15803d, 0.28);
    applyGhostTint('ok');
  }
  updateModeBanner();
  invalidateFisheye();
}

// ======================== TAPE MEASURE TOOL ========================
function toggleMeasureMode() {
  if (state.measureMode) {
    stopMeasureMode();
  } else {
    clearGhost();
    state.measureMode = true;
    state.measureActive = false;
    state.measureStart = null;
    state.measureEnd = null;
    rebuildTapeMesh();
    viewport.classList.add('measuring');
    updateModeBanner();
    document.getElementById('btn-measure').classList.add('accent-active');
  }
}

function stopMeasureMode() {
  state.measureMode = false;
  state.measureActive = false;
  state.measureStart = null;
  state.measureEnd = null;
  rebuildTapeMesh();
  viewport.classList.remove('measuring');
  updateModeBanner();
  document.getElementById('btn-measure')?.classList.remove('accent-active');
}

function clearTapeMeasurement() {
  state.measureActive = false;
  state.measureStart = null;
  state.measureEnd = null;
  rebuildTapeMesh();
  updateModeBanner();
}

function rebuildTapeMesh() {
  while (tapeGroup.children.length > 0) {
    tapeGroup.remove(tapeGroup.children[0]);
  }
  if (!state.measureStart) {
    invalidateFisheye();
    return;
  }
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xb45309 });
  const d1 = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 12), dotMat);
  d1.position.copy(state.measureStart).setY(0.035);
  tapeGroup.add(d1);

  if (state.measureEnd) {
    const d2 = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 12), dotMat);
    d2.position.copy(state.measureEnd).setY(0.035);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(state.measureStart.x, 0.035, state.measureStart.z),
      new THREE.Vector3(state.measureEnd.x, 0.035, state.measureEnd.z),
    ]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xb45309 }));
    tapeGroup.add(d2, line);
  }
  invalidateFisheye();
}

// ======================== POINTER & DRAG INTERACTION ========================
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

let draggingItem = null;
let dragOffsetIn = { x: 0, z: 0 };
let pointerDownPos = { x: 0, y: 0 };
let dragMoved = false;

function getNDC(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function setRaycasterFromPointer() {
  if (isFisheyeActive()) {
    fisheyeRig.unprojectRay(
      pointerNDC.x,
      pointerNDC.y,
      camera,
      window.innerWidth / Math.max(1, window.innerHeight),
      raycaster.ray
    );
  } else {
    raycaster.setFromCamera(pointerNDC, camera);
  }
}

function raycastFloor(event) {
  if (!roomObj) return null;
  getNDC(event);
  setRaycasterFromPointer();
  const hits = raycaster.intersectObject(roomObj.hitPlane, false);
  return hits.length > 0 ? hits[0].point : null;
}

function raycastFurniture(event) {
  getNDC(event);
  setRaycasterFromPointer();
  const hits = raycaster.intersectObjects(furnitureRoot.children, true);
  for (const h of hits) {
    let obj = h.object;
    while (obj && !obj.userData.uid) obj = obj.parent;
    if (obj && obj.userData.uid) {
      return { uid: obj.userData.uid, point: h.point };
    }
  }
  return null;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  // Close open compact drawers when interacting with canvas
  document.getElementById('more-popover')?.classList.add('hidden');

  if (e.button === 2) {
    if (state.placingCatalogId) clearGhost();
    if (state.measureMode) stopMeasureMode();
    return;
  }
  if (e.button !== 0) return;

  pointerDownPos = { x: e.clientX, y: e.clientY };
  dragMoved = false;

  // 1. Tape Measure click (P0 #2 fix: cleanly lock Point B without erasing!)
  if (state.measureMode) {
    const pt = raycastFloor(e);
    if (!pt) return;
    if (!state.measureActive) {
      // Start fresh span from Point A
      state.measureStart = pt.clone();
      state.measureEnd = pt.clone();
      state.measureActive = true;
    } else {
      // Lock completed span at Point B!
      state.measureEnd = pt.clone();
      state.measureActive = false;
    }
    rebuildTapeMesh();
    updateModeBanner();
    return;
  }

  // 2. Sims Buy Mode Ghost Placement click (P0 #3 fix: prevent accidental overlap unless Alt held)
  if (state.placingCatalogId) {
    const pt = raycastFloor(e);
    if (!pt) return;
    updateGhostAtWorldPoint(pt);
    if (state.placingStatus?.colliding && !e.altKey) {
      // Shake banner subtly & block hard overlap unless Alt is held
      updateModeBanner();
      return;
    }
    const snapped = ghostGroup.userData.snapped;
    pushUndoSnapshot();
    const newItem = {
      uid: nextUid(),
      catalogId: state.placingCatalogId,
      x: snapped.x,
      z: snapped.z,
      rotDeg: normDeg(state.placingRotDeg),
      finish: state.placingFinish,
      expanded: false,
    };
    state.items.push(newItem);
    syncItemMesh(newItem, true);
    state.selectedUid = newItem.uid;
    revalidateAllItems();
    updateInspector();
    updateCartBadge();
    updateLeftRail();
    saveToStorage();
    if (!e.shiftKey) {
      clearGhost();
    }
    return;
  }

  // 3. In Eye Level mode, dragging orbits/looks around cleanly instead of grabbing furniture!
  if (state.viewMode === 'fp') {
    return;
  }

  // 4. Click/Drag existing furniture
  const hit = raycastFurniture(e);
  if (hit) {
    const item = state.items.find((i) => i.uid === hit.uid);
    if (item) {
      state.selectedUid = item.uid;
      revalidateAllItems();
      updateInspector();

      const floorPt = raycastFloor(e) || hit.point;
      draggingItem = item;
      dragOffsetIn = {
        x: item.x - floorPt.x * M_TO_IN,
        z: item.z - floorPt.z * M_TO_IN,
      };
      controls.enabled = false;
      viewport.classList.add('dragging');
      pushUndoSnapshot();
    }
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (state.measureMode && state.measureActive && state.measureStart) {
    const pt = raycastFloor(e);
    if (pt) {
      state.measureEnd = pt.clone();
      rebuildTapeMesh();
    }
    return;
  }

  if (state.placingCatalogId) {
    const pt = raycastFloor(e);
    if (pt) updateGhostAtWorldPoint(pt);
    return;
  }

  if (draggingItem) {
    const distPx = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    if (distPx > 3) dragMoved = true;
    const pt = raycastFloor(e);
    if (!pt) return;
    const cat = ALL_CATALOG[draggingItem.catalogId];
    const dims = getItemDimensionsIn(draggingItem, cat);
    const snapped = clampAndSnapToRoom(
      pt.x * M_TO_IN + dragOffsetIn.x,
      pt.z * M_TO_IN + dragOffsetIn.z,
      dims.w,
      dims.d,
      draggingItem.rotDeg,
      state.room,
      { gridSnapIn: state.gridSnapIn, wallSnap: state.wallSnap }
    );
    draggingItem.x = snapped.x;
    draggingItem.z = snapped.z;
    const entry = meshByUid.get(draggingItem.uid);
    if (entry) {
      entry.group.position.set(snapped.x * IN_TO_M, 0, snapped.z * IN_TO_M);
    }
    revalidateAllItems();
    updateInspector();
  }
});

window.addEventListener('pointerup', (e) => {
  if (draggingItem) {
    if (!dragMoved && state.undoStack.length > 0) {
      state.undoStack.pop();
    } else if (dragMoved) {
      saveToStorage();
    }
    draggingItem = null;
    controls.enabled = true;
    viewport.classList.remove('dragging');
    return;
  }

  if (!state.placingCatalogId && !state.measureMode && e.target === renderer.domElement) {
    const distPx = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    if (distPx < 5) {
      const hit = raycastFurniture(e);
      if (state.viewMode === 'fp' && hit) {
        state.selectedUid = hit.uid;
        revalidateAllItems();
        updateInspector();
      } else if (!hit && state.selectedUid) {
        state.selectedUid = null;
        revalidateAllItems();
        updateInspector();
      }
    }
  }
});

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// ======================== KEYBOARD SHORTCUTS & CARTESIAN NUDGING ========================
function nudgeSelected(dxIn, dzIn) {
  const item = state.items.find((i) => i.uid === state.selectedUid);
  if (!item) return;
  pushUndoSnapshot();
  const cat = ALL_CATALOG[item.catalogId];
  const dims = getItemDimensionsIn(item, cat);
  const clamped = clampAndSnapToRoom(item.x + dxIn, item.z + dzIn, dims.w, dims.d, item.rotDeg, state.room, {
    gridSnapIn: 0,
    wallSnap: false,
  });
  item.x = clamped.x;
  item.z = clamped.z;
  const entry = meshByUid.get(item.uid);
  if (entry) {
    entry.group.position.set(item.x * IN_TO_M, 0, item.z * IN_TO_M);
  }
  revalidateAllItems();
  updateInspector();
  saveToStorage();
}

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  const isTextInput =
    (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT';

  const key = e.key.toLowerCase();

  // Escape always closes open modals / popovers first!
  if (key === 'escape') {
    const cartModal = document.getElementById('cart-modal');
    const calibModal = document.getElementById('calib-modal');
    const configModal = document.getElementById('config-modal');
    const rentonModal = document.getElementById('renton-modal');
    const morePop = document.getElementById('more-popover');
    const leftRail = document.getElementById('left-rail');
    if (rentonModal && !rentonModal.classList.contains('hidden')) {
      rentonModal.classList.add('hidden');
      return;
    }
    if (configModal && !configModal.classList.contains('hidden')) {
      configModal.classList.add('hidden');
      return;
    }
    if (cartModal && !cartModal.classList.contains('hidden')) {
      cartModal.classList.add('hidden');
      return;
    }
    if (calibModal && !calibModal.classList.contains('hidden')) {
      calibModal.classList.add('hidden');
      return;
    }
    if (morePop && !morePop.classList.contains('hidden')) {
      morePop.classList.add('hidden');
      return;
    }
    if (leftRail && leftRail.classList.contains('drawer-open')) {
      leftRail.classList.remove('drawer-open');
      return;
    }
    const agentPanel = document.getElementById('agent-panel');
    if (agentPanel && !agentPanel.classList.contains('hidden')) {
      agentPanel.classList.add('hidden');
      document.getElementById('btn-agent')?.classList.remove('active');
      return;
    }
    if (state.placingCatalogId) clearGhost();
    else if (state.measureMode) stopMeasureMode();
    else if (state.viewMode === 'fp') setCameraView('3d');
    else if (state.selectedUid) {
      state.selectedUid = null;
      revalidateAllItems();
      updateInspector();
    }
    return;
  }

  if (isTextInput) return;

  if (e.key === '/') {
    e.preventDefault();
    openAgentPanel(true);
    return;
  }

  // Cartesian Arrow-Key Nudging (25 cm default, 5 cm with Shift!)
  if (
    state.selectedUid &&
    !state.placingCatalogId &&
    (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
  ) {
    e.preventDefault();
    const stepCm = e.shiftKey ? NUDGE_FINE_CM : NUDGE_STEP_CM;
    const stepIn = stepCm * CM_TO_IN;
    if (e.key === 'ArrowUp') nudgeSelected(0, -stepIn);       // North (-Z)
    else if (e.key === 'ArrowDown') nudgeSelected(0, stepIn); // South (+Z)
    else if (e.key === 'ArrowLeft') nudgeSelected(-stepIn, 0);// West (-X)
    else if (e.key === 'ArrowRight') nudgeSelected(stepIn, 0);// East (+X)
    return;
  }

  // Eye Level WASD / Arrow walking when no furniture is selected
  if (state.viewMode === 'fp' && !state.selectedUid) {
    const stepM = 0.25;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    let move = null;
    if (key === 'w' || e.key === 'ArrowUp') move = fwd.clone().multiplyScalar(stepM);
    else if (key === 's' || e.key === 'ArrowDown') move = fwd.clone().multiplyScalar(-stepM);
    else if (key === 'a' || e.key === 'ArrowLeft') move = right.clone().multiplyScalar(-stepM);
    else if (key === 'd' || e.key === 'ArrowRight') move = right.clone().multiplyScalar(stepM);
    if (move) {
      e.preventDefault();
      const hl = (state.room.lengthIn / 2 - 10) * IN_TO_M;
      const nextPos = camera.position.clone().add(move);
      nextPos.z = Math.max(-hl, Math.min(hl, nextPos.z));
      const minX = (getWestWallXAtZ(nextPos.z * M_TO_IN, state.room) + 10) * IN_TO_M;
      const maxX = (state.room.widthIn / 2 - 10) * IN_TO_M;
      nextPos.x = Math.max(minX, Math.min(maxX, nextPos.x));
      const delta = nextPos.clone().sub(camera.position);
      camera.position.copy(nextPos);
      controls.target.add(delta);
      invalidateFisheye();
      return;
    }
  }

  if (key === 'r') {
    const step = e.shiftKey ? 15 : 90;
    if (state.placingCatalogId && ghostGroup) {
      state.placingRotDeg = normDeg(state.placingRotDeg + step);
      ghostGroup.rotation.y = (state.placingRotDeg * Math.PI) / 180;
    } else if (state.selectedUid) {
      rotateSelected(step);
    }
  } else if (key === 'q' && state.selectedUid) {
    rotateSelected(-15);
  } else if (key === 'e' && state.selectedUid) {
    rotateSelected(15);
  } else if ((key === 'delete' || key === 'backspace') && state.selectedUid) {
    deleteSelected();
  } else if ((e.metaKey || e.ctrlKey) && key === 'z') {
    e.preventDefault();
    undo();
  } else if ((e.metaKey || e.ctrlKey) && key === 's') {
    e.preventDefault();
    openConfigModal();
  }
});

function rotateSelected(deltaDeg) {
  const item = state.items.find((i) => i.uid === state.selectedUid);
  if (!item) return;
  pushUndoSnapshot();
  setSelectedRotation(normDeg(item.rotDeg + deltaDeg), false);
}

function setSelectedRotation(newDeg, recordUndo = false) {
  const item = state.items.find((i) => i.uid === state.selectedUid);
  if (!item) return;
  if (recordUndo) pushUndoSnapshot();
  item.rotDeg = normDeg(newDeg);
  const cat = ALL_CATALOG[item.catalogId];
  const dims = getItemDimensionsIn(item, cat);
  const clamped = clampAndSnapToRoom(item.x, item.z, dims.w, dims.d, item.rotDeg, state.room, {
    gridSnapIn: 0,
    wallSnap: false,
  });
  item.x = clamped.x;
  item.z = clamped.z;
  const entry = meshByUid.get(item.uid);
  if (entry) {
    entry.group.position.set(item.x * IN_TO_M, 0, item.z * IN_TO_M);
    entry.group.rotation.y = (item.rotDeg * Math.PI) / 180;
  }
  revalidateAllItems();
  updateInspector();
  saveToStorage();
}

function deleteItemByUid(uid, saveUndo = true) {
  const item = state.items.find((i) => i.uid === uid);
  if (!item) return;
  if (saveUndo) pushUndoSnapshot();
  const entry = meshByUid.get(uid);
  if (entry) {
    furnitureRoot.remove(entry.group);
    meshByUid.delete(uid);
  }
  state.items = state.items.filter((i) => i.uid !== uid);
  if (state.selectedUid === uid) state.selectedUid = null;
  revalidateAllItems();
  updateInspector();
  updateCartBadge();
  updateLeftRail();
  saveToStorage();
}

function deleteSelected() {
  if (!state.selectedUid) return;
  deleteItemByUid(state.selectedUid);
}

function duplicateSelected() {
  const item = state.items.find((i) => i.uid === state.selectedUid);
  if (!item) return;
  const cat = ALL_CATALOG[item.catalogId];
  if (cat.retained) return;
  pushUndoSnapshot();
  const dims = getItemDimensionsIn(item, cat);
  const snapped = clampAndSnapToRoom(item.x + 12, item.z + 12, dims.w, dims.d, item.rotDeg, state.room, {
    gridSnapIn: state.gridSnapIn,
    wallSnap: state.wallSnap,
  });
  const copy = {
    uid: nextUid(),
    catalogId: item.catalogId,
    x: snapped.x,
    z: snapped.z,
    rotDeg: normDeg(item.rotDeg),
    finish: item.finish,
    expanded: item.expanded,
  };
  state.items.push(copy);
  syncItemMesh(copy, true);
  state.selectedUid = copy.uid;
  revalidateAllItems();
  updateInspector();
  updateCartBadge();
  saveToStorage();
}

function restoreRetainedItem(catalogId) {
  if (state.items.some((i) => i.catalogId === catalogId)) return;
  const cat = ALL_CATALOG[catalogId];
  if (!cat) return;
  pushUndoSnapshot();
  const defaults =
    catalogId === 'retained_loveseat'
      ? { x: 26, z: -64, rotDeg: 342 }
      : { x: 44.5, z: 16, rotDeg: 270 };
  const clamped = clampAndSnapToRoom(defaults.x, defaults.z, cat.w, cat.d, defaults.rotDeg, state.room, {
    gridSnapIn: 1,
    wallSnap: true,
  });
  const item = {
    uid: nextUid(),
    catalogId,
    x: clamped.x,
    z: clamped.z,
    rotDeg: normDeg(defaults.rotDeg),
    finish: cat.defaultFinish,
    expanded: false,
  };
  state.items.push(item);
  syncItemMesh(item, true);
  state.selectedUid = item.uid;
  revalidateAllItems();
  updateInspector();
  updateLeftRail();
  saveToStorage();
}

function swapRetainedDesk(targetDeskId) {
  if (state.retainedDeskId === targetDeskId) return;
  pushUndoSnapshot();
  const oldDeskId = state.retainedDeskId;
  state.retainedDeskId = targetDeskId;
  const existing = state.items.find((i) => i.catalogId === oldDeskId);
  const cat = ALL_CATALOG[targetDeskId];
  if (existing) {
    existing.catalogId = targetDeskId;
    existing.finish = cat.defaultFinish;
    const clamped = clampAndSnapToRoom(existing.x, existing.z, cat.w, cat.d, existing.rotDeg, state.room, {
      gridSnapIn: 1,
      wallSnap: true,
    });
    existing.x = clamped.x;
    existing.z = clamped.z;
    syncItemMesh(existing, true);
    state.selectedUid = existing.uid;
  } else {
    restoreRetainedItem(targetDeskId);
    return;
  }
  revalidateAllItems();
  updateInspector();
  updateLeftRail();
  saveToStorage();
}

// ======================== CAMERA PRESETS ========================
let cameraLerp = null;

function getEyeVantagePose(vantageId) {
  const W = state.room.widthIn * IN_TO_M;
  const L = state.room.lengthIn * IN_TO_M;
  const flareW = (state.room.swFlareWidthIn || 0) * IN_TO_M;
  const eyeY = 1.54; // ~5' 0.6" natural interior eye height
  let pos;
  let lookAt;

  switch (vantageId) {
    case 'nw':
      pos = new THREE.Vector3(-W * 0.5 + 0.44, eyeY, -L * 0.5 + 0.46);
      lookAt = new THREE.Vector3(0.16, 1.32, L * 0.24);
      break;
    case 'ne':
      pos = new THREE.Vector3(W * 0.5 - 0.44, eyeY, -L * 0.5 + 0.46);
      lookAt = new THREE.Vector3(-0.22, 1.32, L * 0.26);
      break;
    case 'se':
      pos = new THREE.Vector3(W * 0.5 - 0.42, eyeY, L * 0.5 - 0.52);
      lookAt = new THREE.Vector3(-0.18, 1.34, -L * 0.22);
      break;
    case 'center':
      pos = new THREE.Vector3(0.0, eyeY, 0.24);
      lookAt = new THREE.Vector3(0.0, 1.38, -L * 0.36);
      break;
    case 'doorway':
    default:
      // Just inside the angled SW entry doorway looking NE across the entire 5-sided room
      pos = new THREE.Vector3(-W * 0.5 - flareW * 0.32 + 0.44, eyeY, L * 0.5 - 0.48);
      lookAt = new THREE.Vector3(0.14, 1.36, -L * 0.22);
      break;
  }

  // Place OrbitControls target 0.06m in front of eye so drag rotates head in-place without swinging into walls!
  const dir = lookAt.clone().sub(pos).normalize();
  const target = pos.clone().addScaledVector(dir, 0.06);
  return { pos, target };
}

function jumpToEyeVantage(vantageId, instant = false) {
  state.eyeVantage = vantageId;
  document.querySelectorAll('[data-vantage]').forEach((b) => {
    b.classList.toggle('active', b.dataset.vantage === vantageId);
  });
  const pose = getEyeVantagePose(vantageId);
  if (instant) {
    cameraLerp = null;
    const prevDamp = controls.enableDamping;
    controls.enableDamping = false;
    camera.position.copy(pose.pos);
    controls.target.copy(pose.target);
    camera.up.set(0, 1, 0);
    controls.update();
    controls.enableDamping = prevDamp;
  } else {
    cameraLerp = pose;
  }
  invalidateFisheye();
}

function setFisheyeMode(lensMode) {
  state.fisheyeMode = lensMode;
  fisheyeRig.setMode(lensMode);
  document.querySelectorAll('[data-lens]').forEach((b) => {
    b.classList.toggle('active', b.dataset.lens === lensMode);
  });
  const fovWrap = document.getElementById('fe-fov-wrap');
  if (fovWrap) fovWrap.classList.toggle('disabled', lensMode === 'rectilinear');
  if (state.viewMode === 'fp') {
    const targetFov = lensMode === 'rectilinear' ? 68 : 44;
    if (camera.fov !== targetFov) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }
    invalidateFisheye();
  }
}

function setFisheyeFovDeg(deg) {
  const clamped = Math.max(90, Math.min(165, Math.round(Number(deg) || 138)));
  state.fisheyeFovDeg = clamped;
  fisheyeRig.setHFovDeg(clamped);
  const slider = document.getElementById('fisheye-fov-slider');
  const valEl = document.getElementById('fisheye-fov-val');
  if (slider) slider.value = String(clamped);
  if (valEl) valEl.textContent = `${clamped}°`;
}

function setCameraView(mode) {
  state.viewMode = mode;
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === mode);
  });

  const feBar = document.getElementById('fisheye-bar');
  if (feBar) feBar.classList.toggle('hidden', mode !== 'fp');

  const L = state.room.lengthIn * IN_TO_M;

  if (mode === '3d') {
    if (camera.fov !== 44 || camera.near !== 0.08) {
      camera.fov = 44;
      camera.near = 0.08;
      camera.updateProjectionMatrix();
    }
    setWallMode('cutaway');
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.rotateSpeed = 1.0;
    controls.minDistance = 1.2;
    controls.maxDistance = 15;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    cameraLerp = {
      pos: new THREE.Vector3(4.0, 4.2, 4.5),
      target: new THREE.Vector3(0, 0.45, 0),
    };
  } else if (mode === '2d') {
    // Near-orthographic narrow-FOV North-up top-down view; near=2.0 gives 25x depth precision at dist=20.6m!
    if (camera.fov !== 24 || camera.near !== 2.0) {
      camera.fov = 24;
      camera.near = 2.0;
      camera.updateProjectionMatrix();
    }
    setWallMode('down');
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.rotateSpeed = 1.0;
    controls.minDistance = 4.0;
    controls.maxDistance = 32;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    cameraLerp = null;
    const dist = Math.max(20.6, L * 4.58);
    const zCenter = 0.65; // Shift room slightly up clear of bottom Buy Mode dock
    const prevDamp = controls.enableDamping;
    controls.enableDamping = false;
    controls.update(); // Flush any residual sphericalDelta from Eye Level or orbit drag!
    camera.position.set(0, dist, zCenter + 0.08);
    controls.target.set(0, 0, zCenter);
    camera.up.set(0, 1, 0);
    controls.update();
    controls.enableDamping = prevDamp;
  } else if (mode === 'fp') {
    const targetFov = state.fisheyeMode === 'rectilinear' ? 68 : 44;
    if (camera.fov !== targetFov || camera.near !== 0.08) {
      camera.fov = targetFov;
      camera.near = 0.08;
      camera.updateProjectionMatrix();
    }
    setWallMode('up');
    controls.enableRotate = true;
    controls.enableZoom = false; // Prevent zooming backwards outside walls!
    controls.rotateSpeed = -0.55; // Street-View-style natural drag-to-look pan
    controls.minDistance = 0.05;
    controls.maxDistance = 0.08;
    controls.minPolarAngle = 0.25;
    controls.maxPolarAngle = Math.PI - 0.25;
    jumpToEyeVantage(state.eyeVantage || 'doorway', true);
  }
  updateModeBanner();
}

function setWallMode(mode) {
  state.wallMode = mode;
  document.querySelectorAll('[data-wall]').forEach((b) => {
    b.classList.toggle('active', b.dataset.wall === mode);
  });
  invalidateFisheye();
}

// ======================== FLOATING 3D LABELS ========================
const labelPool = [];
function getLabelEl(index, cls) {
  while (labelPool.length <= index) {
    const el = document.createElement('div');
    labelsLayer.appendChild(el);
    labelPool.push(el);
  }
  const el = labelPool[index];
  el.className = `dim-pill ${cls}`;
  el.style.display = 'block';
  el.style.background = '';
  el.style.fontSize = '';
  return el;
}

function projectToScreen(vec3) {
  if (isFisheyeActive()) {
    return fisheyeRig.projectPoint(
      vec3,
      camera,
      window.innerWidth / Math.max(1, window.innerHeight),
      window.innerWidth,
      window.innerHeight
    );
  }
  const v = vec3.clone().project(camera);
  if (v.z > 1) return null;
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
  };
}

function updateFloatingLabels() {
  let idx = 0;
  const W = state.room.widthIn * IN_TO_M;
  const L = state.room.lengthIn * IN_TO_M;
  const H = state.room.heightIn * IN_TO_M;
  const dockEl = document.getElementById('buy-dock');
  const dockTop = dockEl ? dockEl.getBoundingClientRect().top : window.innerHeight - 190;
  const minY = 72;
  const maxY = Math.max(minY + 40, dockTop - 18);

  const clampY = (y) => Math.max(minY, Math.min(maxY, y));

  const flareW = (state.room.swFlareWidthIn || 0) * IN_TO_M;
  const flareL = (state.room.swFlareLengthIn || 0) * IN_TO_M;

  // 1. Exterior Room Wall Dimensions (all 5 walls of the non-rectangular floor!)
  if (state.showDimensions && state.viewMode !== 'fp' && state.wallMode !== 'up') {
    const straightWestIn = state.room.lengthIn - (state.room.swFlareLengthIn || 0);
    const angledLenIn = Math.hypot(state.room.swFlareWidthIn || 0, state.room.swFlareLengthIn || 0);
    const southWidthIn = state.room.widthIn + (state.room.swFlareWidthIn || 0);
    const wallTags = [
      { pos: new THREE.Vector3(0, 0.08, -L / 2 - 0.34), text: `N · ${formatLen(state.room.widthIn)}` },
      { pos: new THREE.Vector3(-W / 2 - 0.42, 0.08, -flareL / 2), text: `W · ${formatLen(straightWestIn)}` },
      { pos: new THREE.Vector3(W / 2 + 0.42, 0.08, 0), text: `E · ${formatLen(state.room.lengthIn)}` },
      { pos: new THREE.Vector3(-flareW / 2, 0.08, L / 2 + 0.34), text: `S · ${formatLen(southWidthIn)}` },
    ];
    if (angledLenIn > 1) {
      wallTags.push({
        pos: new THREE.Vector3(-W / 2 - flareW / 2 - 0.48, 0.08, L / 2 - flareL / 2),
        text: `SW · ${formatLen(angledLenIn)} (15°)`,
      });
    }
    for (const wt of wallTags) {
      const p = projectToScreen(wt.pos);
      if (p && p.y > minY - 12 && p.y < maxY + 12) {
        const el = getLabelEl(idx++, '');
        el.textContent = wt.text;
        el.style.left = `${p.x}px`;
        el.style.top = `${clampY(p.y)}px`;
      }
    }
  }

  // 1b. Door & Closet Zone Floor Callouts (anchored to flared SW corner!)
  if (state.showClearances && state.viewMode !== 'fp' && state.wallMode !== 'up') {
    const entryX = -W / 2 - flareW + (state.room.entryDoorOffsetFromWestIn + state.room.entryDoorWidthIn * 0.45) * IN_TO_M;
    const entryP = projectToScreen(new THREE.Vector3(entryX, 0.04, L / 2 - 0.35));
    if (entryP && entryP.y < maxY) {
      const el = getLabelEl(idx++, '');
      el.textContent = `Door ${formatLen(state.room.entryDoorWidthIn)}`;
      el.style.background = 'rgba(180, 83, 9, 0.86)';
      el.style.fontSize = '10px';
      el.style.left = `${entryP.x}px`;
      el.style.top = `${entryP.y}px`;
    }
    const closetRightX = W / 2 - state.room.closetOffsetFromEastIn * IN_TO_M;
    const closetCx = closetRightX - (state.room.closetWidthIn * IN_TO_M) / 2;
    const closetP = projectToScreen(new THREE.Vector3(closetCx, 0.04, L / 2 - 0.2));
    if (closetP && closetP.y < maxY) {
      const el = getLabelEl(idx++, '');
      el.textContent = `Closet ${formatLen(state.room.closetWidthIn)}`;
      el.style.background = 'rgba(37, 99, 235, 0.84)';
      el.style.fontSize = '10px';
      el.style.left = `${closetP.x}px`;
      el.style.top = `${closetP.y}px`;
    }
  }

  // 2. Retained Item Subtle Badges (hidden when occluded by Walls Up or while selected)
  if (state.showDimensions && (state.wallMode !== 'up' || state.viewMode === 'fp')) {
    for (const item of state.items) {
      if (item.uid === state.selectedUid) continue;
      const cat = ALL_CATALOG[item.catalogId];
      if (!cat || !cat.retained) continue;
      const p = projectToScreen(new THREE.Vector3(item.x * IN_TO_M, cat.h * IN_TO_M + 0.16, item.z * IN_TO_M));
      if (p && p.y > minY && p.y < maxY) {
        const el = getLabelEl(idx++, 'retained-tag');
        el.textContent = `Kept · ${cat.name}`;
        el.style.left = `${p.x}px`;
        el.style.top = `${p.y}px`;
      }
    }
  }

  // 3. Selected Item Wall Distance Lasers
  for (const a of wallDistAnchors) {
    const p = projectToScreen(a.pos);
    if (p && p.y > minY && p.y < maxY) {
      const el = getLabelEl(idx++, 'wall-dist');
      el.textContent = a.text;
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    }
  }

  // 4. Tape Measure Distance Label (always updates live with active unit!)
  if (state.measureStart && state.measureEnd) {
    const distIn = state.measureStart.distanceTo(state.measureEnd) * M_TO_IN;
    if (distIn > 0.5) {
      const mid = state.measureStart.clone().add(state.measureEnd).multiplyScalar(0.5);
      mid.y = 0.14;
      const p = projectToScreen(mid);
      if (p) {
        const el = getLabelEl(idx++, 'tape');
        el.textContent = `↔ ${formatLen(distIn)}`;
        el.style.left = `${p.x}px`;
        el.style.top = `${clampY(p.y)}px`;
      }
    }
  }

  // 5. On-Canvas 90-Degree L / R Rotation Overlay Gizmo above Selected Furniture
  const gizmo = document.getElementById('selection-gizmo');
  if (gizmo) {
    const sel = state.items.find((i) => i.uid === state.selectedUid);
    if (sel && !state.placingCatalogId && !state.measureMode) {
      const cat = ALL_CATALOG[sel.catalogId];
      const topY = Math.max(0.35, (cat?.h || 24) * IN_TO_M + 0.18);
      const p = projectToScreen(new THREE.Vector3(sel.x * IN_TO_M, topY, sel.z * IN_TO_M));
      if (p) {
        const clampedX = Math.max(115, Math.min(window.innerWidth - 115, p.x));
        const clampedY = Math.max(106, Math.min(maxY, p.y - 8));
        gizmo.classList.remove('hidden');
        gizmo.style.left = `${clampedX}px`;
        gizmo.style.top = `${clampedY}px`;
        document.getElementById('gizmo-label').textContent = `${cat.name} · ${normDeg(sel.rotDeg)}°`;
      } else {
        gizmo.classList.add('hidden');
      }
    } else {
      gizmo.classList.add('hidden');
    }
  }

  for (let i = idx; i < labelPool.length; i++) {
    labelPool[i].style.display = 'none';
  }
}

// ======================== UI RENDERERS ========================
function updateRoomMetaHeader() {
  const el = document.getElementById('room-dims-summary');
  el.textContent = `${formatLen(state.room.widthIn)} × ${formatLen(state.room.lengthIn)} · ${formatLen(state.room.heightIn)} H · ${formatArea(state.room.widthIn, state.room.lengthIn)}`;
}

function updateModeBanner() {
  const banner = document.getElementById('mode-banner');
  if (state.placingCatalogId) {
    const cat = ALL_CATALOG[state.placingCatalogId];
    const st = state.placingStatus;
    let statusChip = '';
    if (st?.colliding) {
      statusChip = `<span class="banner-status error">✕ ${st.warnings[0]} (Alt+Click to force)</span>`;
    } else if (st?.warningOnly) {
      statusChip = `<span class="banner-status warn">⚠ ${st.warnings[0]}</span>`;
    } else if (st?.supportedBy) {
      statusChip = `<span class="banner-status ok">✓ Stacks on ${st.supportedBy}</span>`;
    } else if (st) {
      statusChip = `<span class="banner-status ok">✓ Fits</span>`;
    }
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <span>Placing <strong>${cat.name}</strong></span>
      ${statusChip}
      <button id="banner-rot-btn">↻ 90°</button>
      <button id="banner-cancel-btn">Cancel</button>
    `;
    document.getElementById('banner-rot-btn').onclick = () => {
      state.placingRotDeg = normDeg(state.placingRotDeg + 90);
      if (ghostGroup) ghostGroup.rotation.y = (state.placingRotDeg * Math.PI) / 180;
    };
    document.getElementById('banner-cancel-btn').onclick = clearGhost;
  } else if (state.measureMode) {
    const hasPinned = state.measureStart && state.measureEnd && !state.measureActive;
    const msg = state.measureActive
      ? 'Click Point B to pin measurement'
      : hasPinned
      ? 'Measurement pinned — click anywhere to measure a new span'
      : 'Click Point A on the floor to start measuring';
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <span><strong>Tape Measure</strong> · ${msg}</span>
      ${state.measureStart ? '<button id="banner-clear-tape">Clear</button>' : ''}
      <button id="banner-cancel-btn">Done</button>
    `;
    const clr = document.getElementById('banner-clear-tape');
    if (clr) clr.onclick = clearTapeMeasurement;
    document.getElementById('banner-cancel-btn').onclick = stopMeasureMode;
  } else {
    banner.classList.add('hidden');
  }
}

function updateLeftRail() {
  const retainedList = document.getElementById('retained-list');
  const love = state.items.find((i) => i.catalogId === 'retained_loveseat');
  const desk = state.items.find((i) => i.catalogId === state.retainedDeskId);
  const activeCount = (love ? 1 : 0) + (desk ? 1 : 0);
  document.getElementById('retained-count-title').textContent = `Retained Pieces (${activeCount} of 2)`;

  retainedList.innerHTML = '';
  const addChip = (label, dimStr, item, restoreId) => {
    const div = document.createElement('div');
    div.className = 'retained-chip';
    div.innerHTML = `<span>${label}</span><span class="sub">${dimStr}</span>`;
    div.onclick = () => {
      if (item) {
        state.selectedUid = item.uid;
        revalidateAllItems();
        updateInspector();
      } else {
        restoreRetainedItem(restoreId);
      }
      document.getElementById('left-rail').classList.remove('drawer-open');
    };
    retainedList.appendChild(div);
  };

  const loveCat = ALL_CATALOG.retained_loveseat;
  const dCat = ALL_CATALOG[state.retainedDeskId];
  addChip(
    'Big Loveseat',
    love ? formatFootprintShort(loveCat.w, loveCat.d) : '+ Restore',
    love,
    'retained_loveseat'
  );
  addChip(
    dCat.name.replace(' Corner', ''),
    desk ? formatFootprintShort(dCat.w, dCat.d) : '+ Restore',
    desk,
    state.retainedDeskId
  );

  // Sync desk button labels with active units & active class
  const woodBtn = document.getElementById('desk-wood-btn');
  const whiteBtn = document.getElementById('desk-white-btn');
  woodBtn.textContent = state.units === 'metric' ? 'Wood 140cm' : 'Wood 55"';
  whiteBtn.textContent = state.units === 'metric' ? 'White 122cm' : 'White 48"';
  woodBtn.classList.toggle('active', state.retainedDeskId === 'retained_wood_desk');
  whiteBtn.classList.toggle('active', state.retainedDeskId === 'retained_white_desk');

  const lblGrid = document.getElementById('lbl-grid');
  if (lblGrid) lblGrid.textContent = state.units === 'metric' ? '30cm Floor Grid' : '1-ft Floor Grid';
}

function updateInspector() {
  const panel = document.getElementById('inspector');
  const agentPanel = document.getElementById('agent-panel');
  const item = state.items.find((i) => i.uid === state.selectedUid);
  if (!item) {
    panel.classList.add('hidden');
    if (agentPanel) agentPanel.classList.remove('inspector-open');
    return;
  }
  const cat = ALL_CATALOG[item.catalogId];
  const dims = getItemDimensionsIn(item, cat);
  const status = item._status || checkPlacementStatus(item, state.items, ALL_CATALOG, state.room);

  panel.classList.remove('hidden');
  if (agentPanel) agentPanel.classList.add('inspector-open');

  const brandEl = document.getElementById('insp-brand');
  const isMoveIn = cat.brand === 'Move-In';
  brandEl.textContent = cat.retained ? 'Retained · $0' : isMoveIn ? 'Move-In · $0' : `IKEA · $${cat.price}`;
  brandEl.className = `insp-brand ${cat.retained ? 'retained' : isMoveIn ? 'movein' : 'ikea'}`;

  const thumbEl = document.getElementById('insp-thumb');
  if (thumbEl) {
    const src = PRODUCT_THUMBNAILS[cat.id] || cat.imageUrl || '';
    if (src) {
      thumbEl.src = src;
      thumbEl.style.display = 'block';
    } else {
      thumbEl.style.display = 'none';
    }
  }

  document.getElementById('insp-name').textContent = cat.name;
  const skuTag = cat.skuFormatted ? ` · #${cat.skuFormatted}` : '';
  document.getElementById('insp-sub').textContent = `${cleanSubtitle(cat.subtitle)}${skuTag}`;

  const statusEl = document.getElementById('insp-status');
  if (status.colliding) {
    statusEl.className = 'status-banner error';
    statusEl.textContent = `✕ ${status.warnings.join(' · ')}`;
  } else if (status.warningOnly) {
    statusEl.className = 'status-banner warn';
    statusEl.textContent = `⚠ ${status.warnings.join(' · ')}`;
  } else if (status.supportedBy) {
    statusEl.className = 'status-banner ok';
    statusEl.textContent = `✓ Stacked cleanly on ${status.supportedBy}`;
  } else if (cat.wallMounted) {
    statusEl.className = 'status-banner ok';
    statusEl.textContent = `✓ Wall-mounted at ${formatLen(cat.mountHeightIn || 54)} (0 floor footprint)`;
  } else {
    statusEl.className = 'status-banner ok';
    statusEl.textContent = '✓ Fits cleanly with full clearance';
  }

  document.getElementById('insp-w').textContent = formatLen(dims.w);
  document.getElementById('insp-d').textContent = formatLen(dims.d);
  document.getElementById('insp-h').textContent = formatLen(dims.h);

  const angle = normDeg(item.rotDeg);
  document.getElementById('insp-angle-val').textContent = `${angle}°`;
  document.getElementById('insp-angle-slider').value = angle;

  document.getElementById('nudge-step-label').textContent =
    state.units === 'metric' ? '↑↓←→ · 25 cm' : '↑↓←→ · 10" (25cm)';

  const expandWrap = document.getElementById('insp-expand-wrap');
  if (cat.expandable) {
    expandWrap.style.display = 'block';
    const btn = document.getElementById('insp-expand-btn');
    btn.textContent = item.expanded
      ? `Fold Back to Daybed (${formatLen(cat.d)} D)`
      : `Pull Out to King Bed (${formatLen(cat.expandedD)} D)`;
    btn.classList.toggle('primary', !item.expanded);
  } else {
    expandWrap.style.display = 'none';
  }

  const swatchRow = document.getElementById('insp-swatches');
  swatchRow.innerHTML = '';
  for (const fk of cat.finishes || ['white']) {
    const sw = FINISH_SWATCHES[fk];
    if (!sw) continue;
    const b = document.createElement('button');
    b.className = `swatch ${item.finish === fk ? 'active' : ''}`;
    b.style.background = sw.hex;
    b.title = sw.label;
    b.onclick = () => {
      pushUndoSnapshot();
      item.finish = fk;
      syncItemMesh(item, false);
      revalidateAllItems();
      updateInspector();
      saveToStorage();
    };
    swatchRow.appendChild(b);
  }

  const d = status.distances;
  document.getElementById('insp-wall-dists').innerHTML = `
    <div><span>North</span><strong>${formatLen(d.north)}</strong></div>
    <div><span>South</span><strong>${formatLen(d.south)}</strong></div>
    <div><span>West</span><strong>${formatLen(d.west)}</strong></div>
    <div><span>East</span><strong>${formatLen(d.east)}</strong></div>
  `;

  document.getElementById('insp-dup-btn').style.display = cat.retained ? 'none' : 'block';
  document.getElementById('insp-del-btn').textContent = cat.retained ? 'Hide Retained' : 'Remove Item';
}

function updateCartBadge() {
  let total = 0;
  let count = 0;
  for (const it of state.items) {
    const cat = ALL_CATALOG[it.catalogId];
    if (cat && !cat.retained && cat.brand === 'IKEA') {
      total += cat.price;
      count++;
    }
  }
  document.getElementById('cart-count').textContent = `${count} IKEA`;
  document.getElementById('cart-total').textContent = `$${total.toLocaleString()}`;
}

function expandBuyDock() {
  const dock = document.getElementById('buy-dock');
  const dockBtn = document.getElementById('dock-toggle-btn');
  if (dock.classList.contains('collapsed')) {
    dock.classList.remove('collapsed');
    document.body.classList.remove('dock-collapsed');
    dockBtn.textContent = 'Hide ▼';
  }
}

function getStockBadgeHTML(stock) {
  if (stock === 'HIGH_IN_STOCK') return '<span class="stock-dot high" title="In stock at IKEA Renton, WA (#488)">● Renton</span>';
  if (stock === 'LOW_IN_STOCK') return '<span class="stock-dot low" title="Low stock at IKEA Renton, WA (#488)">● Low</span>';
  if (stock === 'OUT_OF_STOCK') return '<span class="stock-dot out" title="Currently out of stock at IKEA Renton, WA (#488)">○ Out</span>';
  return '';
}

function renderCatalogCards() {
  const strip = document.getElementById('catalog-strip');
  const q = state.searchQuery.trim().toLowerCase();
  const filtered = IKEA_CATALOG.filter((item) => {
    const matchCat = state.activeCategory === 'all' || item.category === state.activeCategory;
    const matchQ =
      !q ||
      item.name.toLowerCase().includes(q) ||
      (item.subtitle || '').toLowerCase().includes(q) ||
      (item.description || '').toLowerCase().includes(q) ||
      (item.itemNo || '').includes(q);
    return matchCat && matchQ;
  });

  strip.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-search';
    empty.innerHTML = `
      <span>No local match for "<strong>${state.searchQuery}</strong>"</span>
      <button id="lookup-live-empty-btn" class="renton-lookup-btn">Lookup Live Renton #488 →</button>
      <button id="clear-search-btn" class="mini-btn">Clear</button>
    `;
    strip.appendChild(empty);
    document.getElementById('lookup-live-empty-btn').onclick = () => openRentonLookupModal(state.searchQuery);
    document.getElementById('clear-search-btn').onclick = () => {
      state.searchQuery = '';
      document.getElementById('catalog-search').value = '';
      renderCatalogCards();
    };
    return;
  }

  for (const item of filtered) {
    const card = document.createElement('div');
    card.className = `catalog-card ${state.placingCatalogId === item.id ? 'placing-active' : ''}`;
    const photoSrc = PRODUCT_THUMBNAILS[item.id] || item.imageUrl || '';
    const isFree = item.retained || item.brand === 'Move-In';
    const priceLabel = item.retained ? 'Kept' : item.brand === 'Move-In' ? 'Move-In' : `$${item.price}`;
    const stockBadge = getStockBadgeHTML(item.rentonStock);
    card.innerHTML = `
      <div class="card-photo-wrap">
        <img class="card-photo" src="${photoSrc}" alt="${item.name}" loading="lazy" />
        ${stockBadge}
        <span class="card-price-pill ${isFree ? 'free' : ''}">${priceLabel}</span>
      </div>
      <div class="card-body">
        <div class="card-name">${item.name}</div>
        <div class="card-sub">${cleanSubtitle(item.subtitle || '')}</div>
        <div class="card-dims">${formatDimsShort(item.w, item.d, item.h)}</div>
      </div>
    `;
    const skuNote = item.skuFormatted ? ` (#${item.skuFormatted})` : '';
    card.title = `${item.name}${skuNote} — ${item.description || item.subtitle || 'IKEA Renton #488'} — Click to place in 3D`;
    card.onclick = () => {
      if (state.placingCatalogId === item.id) clearGhost();
      else startPlacing(item.id);
    };
    strip.appendChild(card);
  }
}

function openShoppingModal() {
  const modal = document.getElementById('cart-modal');
  const body = document.getElementById('cart-modal-list');
  const grouped = new Map();
  let total = 0;

  for (const it of state.items) {
    const cat = ALL_CATALOG[it.catalogId];
    if (!cat || cat.retained || cat.brand !== 'IKEA') continue;
    const key = `${cat.id}_${it.finish}`;
    if (!grouped.has(key)) {
      grouped.set(key, { cat, finish: it.finish, uids: [] });
    }
    grouped.get(key).uids.push(it.uid);
    total += cat.price;
  }

  if (grouped.size === 0) {
    body.innerHTML = `<div class="note-box">No IKEA items added yet! Pick items from the <strong>IKEA Buy Mode</strong> catalog at the bottom, click <strong>Live Renton #488</strong> to search any live SKU, or ask the <strong>✦ AI Planner</strong>.</div>`;
  } else {
    body.innerHTML = '';
    for (const { cat, finish, uids } of grouped.values()) {
      const qty = uids.length;
      const sw = FINISH_SWATCHES[finish]?.label || finish;
      const thumb = PRODUCT_THUMBNAILS[cat.id] || cat.imageUrl || '';
      const searchQ = encodeURIComponent(cat.itemNo || cat.name.split(' ')[0]);
      const ikeaUrl = cat.pipUrl || `https://www.ikea.com/us/en/search/?q=${searchQ}`;
      const skuBit = cat.skuFormatted ? ` · #${cat.skuFormatted}` : '';
      const stockLabel =
        cat.rentonStock === 'HIGH_IN_STOCK'
          ? 'In Stock · Renton #488 ↗'
          : cat.rentonStock === 'LOW_IN_STOCK'
          ? 'Low Stock · Renton #488 ↗'
          : cat.rentonStock === 'OUT_OF_STOCK'
          ? 'Out at Renton · Check ↗'
          : 'Renton #488 ↗';
      const row = document.createElement('div');
      row.className = 'cart-row';
      row.innerHTML = `
        <div class="cart-row-info">
          ${thumb ? `<img class="cart-thumb" src="${thumb}" alt="IKEA ${cat.name}" loading="lazy" />` : ''}
          <div class="cart-row-left">
            <h4>${qty}× IKEA ${cat.name} <span style="font-weight:500;color:var(--text-muted)">(${sw})</span></h4>
            <p>${cleanSubtitle(cat.subtitle || '')} · ${formatDimsShort(cat.w, cat.d, cat.h)}${skuBit} <a class="cart-stock-link" href="${ikeaUrl}" target="_blank" rel="noopener">${stockLabel}</a></p>
          </div>
        </div>
        <div class="cart-row-right">
          <span class="cart-row-price">$${(cat.price * qty).toLocaleString()}</span>
          <button class="cart-icon-btn focus-btn" title="Select in 3D">Select</button>
          <button class="cart-icon-btn del remove-btn" title="Remove one from room">×</button>
        </div>
      `;
      row.querySelector('.focus-btn').onclick = () => {
        state.selectedUid = uids[0];
        modal.classList.add('hidden');
        revalidateAllItems();
        updateInspector();
      };
      row.querySelector('.remove-btn').onclick = () => {
        deleteItemByUid(uids[uids.length - 1]);
        openShoppingModal();
      };
      body.appendChild(row);
    }
  }
  document.getElementById('cart-modal-total').textContent = `$${total.toLocaleString()}`;
  updateBudgetBar(total);
  modal.classList.remove('hidden');
}

function updateBudgetBar(totalOverride = null) {
  const inp = document.getElementById('budget-cap-input');
  const fill = document.getElementById('budget-bar-fill');
  const txt = document.getElementById('budget-status-text');
  if (!inp || !fill || !txt) return;
  let total = totalOverride;
  if (total === null) {
    total = 0;
    for (const it of state.items) {
      const c = ALL_CATALOG[it.catalogId];
      if (c && !c.retained && c.brand === 'IKEA') total += c.price;
    }
  }
  const cap = Math.max(0, Number(inp.value) || 0);
  try { localStorage.setItem('room_planner_budget_cap', String(cap)); } catch (_) {}
  if (cap <= 0) {
    fill.style.width = '0%';
    fill.className = 'budget-fill';
    txt.className = 'budget-status';
    txt.textContent = `No budget cap set · Current total: $${total.toLocaleString()}`;
    return;
  }
  const pct = Math.min(100, Math.round((total / cap) * 100));
  fill.style.width = `${pct}%`;
  const diff = cap - total;
  if (total > cap) {
    fill.className = 'budget-fill over';
    fill.style.background = '#dc2626';
    txt.className = 'budget-status over';
    txt.textContent = `$${total.toLocaleString()} / $${cap.toLocaleString()} — $${Math.abs(diff).toLocaleString()} over budget`;
  } else if (pct >= 85) {
    fill.className = 'budget-fill warn';
    fill.style.background = '#d97706';
    txt.className = 'budget-status';
    txt.textContent = `$${total.toLocaleString()} / $${cap.toLocaleString()} (${pct}%) · $${diff.toLocaleString()} remaining`;
  } else {
    fill.className = 'budget-fill';
    fill.style.background = '#16a34a';
    txt.className = 'budget-status';
    txt.textContent = `$${total.toLocaleString()} / $${cap.toLocaleString()} (${pct}%) · $${diff.toLocaleString()} remaining`;
  }
}

function exportFloorplanPNG() {
  // Force a fresh WebGL frame (including curvilinear fisheye pass if in Eye Level!)
  renderActiveView(true);
  const srcCanvas = renderer.domElement;
  const outW = 1440;
  const outH = 920;
  const sideW = 400;
  const c = document.createElement('canvas');
  c.width = outW;
  c.height = outH;
  const ctx = c.getContext('2d');

  // Background
  ctx.fillStyle = '#f8f7f4';
  ctx.fillRect(0, 0, outW, outH);

  // Left: live 3D/2D canvas snapshot (cover-fitted)
  const viewW = outW - sideW;
  const srcAspect = srcCanvas.width / srcCanvas.height;
  const dstAspect = viewW / outH;
  let sx = 0, sy = 0, sw = srcCanvas.width, sh = srcCanvas.height;
  if (srcAspect > dstAspect) {
    sw = srcCanvas.height * dstAspect;
    sx = (srcCanvas.width - sw) / 2;
  } else {
    sh = srcCanvas.width / dstAspect;
    sy = (srcCanvas.height - sh) / 2;
  }
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, viewW, outH);

  // Right sidebar card
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(viewW, 0, sideW, outH);
  ctx.fillStyle = '#0058a3';
  ctx.fillRect(viewW, 0, sideW, 74);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px system-ui, -apple-system, sans-serif';
  ctx.fillText('Room Studio · IKEA Plan', viewW + 22, 34);
  ctx.font = '600 12px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#dbeafe';
  ctx.fillText(
    `5-Sided Room · ${formatLen(state.room.widthIn)} / 10' 9" × ${formatLen(state.room.lengthIn)} · ${formatArea(state.room.widthIn, state.room.lengthIn)}`,
    viewW + 22,
    56
  );

  // Group IKEA items
  const grouped = new Map();
  let total = 0;
  for (const it of state.items) {
    const cat = ALL_CATALOG[it.catalogId];
    if (!cat || cat.retained || cat.brand !== 'IKEA') continue;
    const key = `${cat.id}_${it.finish}`;
    if (!grouped.has(key)) grouped.set(key, { cat, finish: it.finish, qty: 0 });
    grouped.get(key).qty++;
    total += cat.price;
  }

  let y = 104;
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
  ctx.fillText('IKEA SHOPPING LIST', viewW + 22, y);
  y += 22;

  if (grouped.size === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px system-ui, -apple-system, sans-serif';
    ctx.fillText('No IKEA items added yet.', viewW + 22, y);
  } else {
    for (const { cat, finish, qty } of grouped.values()) {
      if (y > outH - 95) break;
      const swLbl = FINISH_SWATCHES[finish]?.label || finish;
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
      ctx.fillText(`${qty}× IKEA ${cat.name}`, viewW + 22, y);
      ctx.fillStyle = '#0058a3';
      ctx.textAlign = 'right';
      ctx.fillText(`$${(cat.price * qty).toLocaleString()}`, outW - 22, y);
      ctx.textAlign = 'left';
      y += 16;
      ctx.fillStyle = '#64748b';
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      ctx.fillText(`${swLbl} · ${formatDimsShort(cat.w, cat.d, cat.h)}`, viewW + 22, y);
      y += 22;
      ctx.strokeStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.moveTo(viewW + 22, y - 10);
      ctx.lineTo(outW - 22, y - 10);
      ctx.stroke();
    }
  }

  // Footer total
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(viewW, outH - 72, sideW, 72);
  ctx.fillStyle = '#475569';
  ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
  ctx.fillText('ESTIMATED IKEA TOTAL', viewW + 22, outH - 42);
  ctx.fillStyle = '#0058a3';
  ctx.font = 'bold 24px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`$${total.toLocaleString()}`, outW - 22, outH - 28);
  ctx.textAlign = 'left';

  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = 'room-studio-ikea-plan.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function syncPresetSelectors(val) {
  const s1 = document.getElementById('preset-select');
  const s2 = document.getElementById('pop-preset-select');
  if (s1) s1.value = val;
  if (s2) s2.value = val;
}

function runOptimizedSuggestion(goalOverride = null, saveUndo = true) {
  if (goalOverride) {
    state.optimizerGoal = goalOverride;
    const sel = document.getElementById('opt-goal-select');
    if (sel) sel.value = goalOverride;
  }
  clearGhost();
  stopMeasureMode();
  const plan = generateOptimizedLayout(
    state.room,
    state.retainedDeskId,
    state.optimizerGoal,
    state.lastArchetypeId
  );
  state.lastArchetypeId = plan.archetypeId;

  loadItemsList(plan.items, saveUndo);
  syncPresetSelectors('custom');
  const now = performance.now();
  let delayIdx = 0;
  for (const [, entry] of meshByUid) {
    entry.popStart = now + delayIdx * 18;
    delayIdx++;
  }

  document.getElementById('opt-title').textContent = plan.title;
  document.getElementById('opt-meta').textContent = `${plan.paletteName} · ${plan.ikeaCount} IKEA · $${plan.ikeaCost.toLocaleString()} · Zero Collisions ✓`;
  document.getElementById('optimizer-bar').classList.remove('hidden');
  return plan;
}

function copyShoppingListText() {
  const dCat = ALL_CATALOG[state.retainedDeskId];
  const loveCat = ALL_CATALOG.retained_loveseat;
  const lines = [
    `Room Layout Plan (${formatLen(state.room.widthIn)} × ${formatLen(state.room.lengthIn)}, ${formatArea(state.room.widthIn, state.room.lengthIn)})`,
    `Retained: Big Loveseat (${formatFootprintShort(loveCat.w, loveCat.d)}) + ${dCat.name} (${formatFootprintShort(dCat.w, dCat.d)})`,
    '',
    'IKEA Shopping List:',
  ];
  let total = 0;
  for (const it of state.items) {
    const cat = ALL_CATALOG[it.catalogId];
    if (!cat || cat.retained) continue;
    const sw = FINISH_SWATCHES[it.finish]?.label || it.finish;
    lines.push(`- IKEA ${cat.name} (${sw}) — ${formatDimsShort(cat.w, cat.d, cat.h)} — $${cat.price}`);
    total += cat.price;
  }
  lines.push(`\nEstimated IKEA Total: $${total}`);
  const text = lines.join('\n');

  const showCopied = () => {
    const btn = document.getElementById('copy-cart-btn');
    btn.textContent = 'Copied ✓';
    setTimeout(() => (btn.textContent = 'Copy List'), 1800);
  };

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(showCopied).catch(() => {
      fallbackCopyText(text);
      showCopied();
    });
  } else {
    fallbackCopyText(text);
    showCopied();
  }
}

function fallbackCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch (_) {}
  document.body.removeChild(ta);
}

// Calibration Modal Helpers (fully unit-aware!)
function populateCalibrationModal() {
  const isMetric = state.units === 'metric';
  const unitTag = isMetric ? 'cm' : 'in';
  document.getElementById('lbl-calib-width').textContent = `Width E–W (${unitTag})`;
  document.getElementById('lbl-calib-length').textContent = `Length N–S (${unitTag})`;
  document.getElementById('lbl-calib-height').textContent = `Ceiling H (${unitTag})`;

  const wEl = document.getElementById('calib-width');
  const lEl = document.getElementById('calib-length');
  const hEl = document.getElementById('calib-height');

  if (isMetric) {
    wEl.min = 180; wEl.max = 610; wEl.value = Math.round(state.room.widthIn * 2.54);
    lEl.min = 240; lEl.max = 760; lEl.value = Math.round(state.room.lengthIn * 2.54);
    hEl.min = 210; hEl.max = 370; hEl.value = Math.round(state.room.heightIn * 2.54);
  } else {
    wEl.min = 72; wEl.max = 240; wEl.value = Math.round(state.room.widthIn);
    lEl.min = 96; lEl.max = 300; lEl.value = Math.round(state.room.lengthIn);
    hEl.min = 84; hEl.max = 144; hEl.value = Math.round(state.room.heightIn);
  }

  document.getElementById('calib-note-box').innerHTML = `
    Derived from your 11 ultra-wide room photos:
    <strong>${formatLen(DEFAULT_ROOM.widthIn)} W × ${formatLen(DEFAULT_ROOM.lengthIn)} L × ${formatLen(DEFAULT_ROOM.heightIn)} H</strong>.
    Fine-tune exact ${isMetric ? 'centimeters' : 'inches'} below:
  `;
  updateCalibrationHints();
}

function updateCalibrationHints() {
  const isMetric = state.units === 'metric';
  const toIn = (val) => (isMetric ? val * CM_TO_IN : val);
  const wIn = toIn(Number(document.getElementById('calib-width').value) || 0);
  const lIn = toIn(Number(document.getElementById('calib-length').value) || 0);
  const hIn = toIn(Number(document.getElementById('calib-height').value) || 0);
  document.getElementById('hint-calib-width').textContent = `= ${formatLen(wIn)}`;
  document.getElementById('hint-calib-length').textContent = `= ${formatLen(lIn)}`;
  document.getElementById('hint-calib-height').textContent = `= ${formatLen(hIn)}`;
}

// ======================== PERSISTENCE ========================
let hasLocalStorage = detectLocalStorageAvailable();
let activeConfigName = 'Current Workspace';
let savedConfigs = [];
let activeSavedConfigId = null;

function getCurrentBudgetCap() {
  const inp = document.getElementById('budget-cap-input');
  return inp ? Math.max(0, Number(inp.value) || 0) : 1200;
}

function updateAutosaveStatusUI(labelOverride = null) {
  const el = document.getElementById('autosave-status');
  const badge = document.getElementById('storage-health-badge');
  if (el) {
    if (hasLocalStorage) {
      el.className = 'autosave-status';
      el.textContent = labelOverride || `Auto-saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ✓`;
    } else {
      el.className = 'autosave-status warn';
      el.textContent = 'Session only · Export .json to keep';
    }
  }
  if (badge) {
    if (hasLocalStorage) {
      badge.className = 'storage-badge ok';
      badge.textContent = 'Local + IDB ✓';
    } else {
      badge.className = 'storage-badge warn';
      badge.textContent = 'Session Only · Use JSON';
    }
  }
}

let scheduleGoogleCloudPush = () => {};

function saveToStorage(skipCloudPush = false) {
  const snapshot = buildConfigSnapshot(state, activeConfigName, getCurrentBudgetCap(), ALL_CATALOG);
  persistAutoSavedConfig(snapshot);
  updateAutosaveStatusUI();
  if (!skipCloudPush) scheduleGoogleCloudPush();
}

function migrateLegacyUncalibratedRoom(rawRoom) {
  if (!rawRoom || typeof rawRoom !== 'object') return { ...DEFAULT_ROOM };
  // Upgrade old pre-23"-measurement photo estimate (117 x 184, 12" flare, 46" run) automatically
  if (
    rawRoom.widthIn === 117 &&
    rawRoom.lengthIn === 184 &&
    (rawRoom.swFlareWidthIn === 12 || rawRoom.swFlareWidthIn === undefined) &&
    (rawRoom.swFlareLengthIn === 46 || rawRoom.swFlareLengthIn === undefined)
  ) {
    return { ...DEFAULT_ROOM };
  }
  return { ...DEFAULT_ROOM, ...rawRoom };
}

function applyFullConfiguration(config, saveUndo = true, opts = {}) {
  if (!config) return;
  clearGhost();
  stopMeasureMode();

  // 0. Ensure any embedded live-looked-up Renton items are registered in IKEA_CATALOG as well as ALL_CATALOG
  if (config.dynamicCatalog && typeof config.dynamicCatalog === 'object') {
    for (const def of Object.values(config.dynamicCatalog)) {
      registerDynamicCatalogItem(def);
    }
  }

  // 1. Room geometry & retained desk choice
  state.room = migrateLegacyUncalibratedRoom(config.room);
  state.retainedDeskId = config.retainedDeskId || 'retained_wood_desk';

  // 2. Settings (units, lighting, wall mode, fisheye lens, overlays, budget cap)
  const s = config.settings || {};
  state.units = s.units === 'metric' ? 'metric' : 'imperial';
  const unitLabel = state.units === 'imperial' ? 'ft / in' : 'm / cm';
  const u1 = document.getElementById('btn-units');
  const u2 = document.getElementById('pop-units-btn');
  if (u1) u1.textContent = unitLabel;
  if (u2) u2.textContent = unitLabel;

  state.lightingMood = s.lightingMood === 'evening' ? 'evening' : 'day';
  state.showGrid = s.showGrid !== false;
  state.showClearances = s.showClearances !== false;
  state.showDimensions = s.showDimensions !== false;
  state.wallSnap = s.wallSnap !== false;
  state.closetOpen = s.closetOpen !== false;
  state.entryDoorOpen = s.entryDoorOpen !== false;

  const setChk = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
  };
  setChk('chk-grid', state.showGrid);
  setChk('chk-clearance', state.showClearances);
  setChk('chk-dims', state.showDimensions);
  setChk('chk-wallsnap', state.wallSnap);
  setChk('chk-closet', state.closetOpen);
  setChk('chk-door', state.entryDoorOpen);

  if (s.wallMode && ['cutaway', 'up', 'down'].includes(s.wallMode)) {
    setWallMode(s.wallMode);
  }
  if (s.fisheyeMode) setFisheyeMode(s.fisheyeMode);
  if (Number.isFinite(Number(s.fisheyeFovDeg))) setFisheyeFovDeg(s.fisheyeFovDeg);
  if (s.eyeVantage) {
    state.eyeVantage = s.eyeVantage;
    document.querySelectorAll('[data-vantage]').forEach((b) => {
      b.classList.toggle('active', b.dataset.vantage === state.eyeVantage);
    });
  }

  const budgetInp = document.getElementById('budget-cap-input');
  if (budgetInp && Number.isFinite(Number(s.budgetCap))) {
    budgetInp.value = String(s.budgetCap);
  }

  // 3. Rebuild room & load furniture items
  rebuildRoomArchitecture();
  applyLightingMood();
  loadItemsList(config.items || [], saveUndo);
  renderCatalogCards();
  updateBudgetBar();
  activeConfigName = config.name || 'Loaded Configuration';
  syncPresetSelectors('custom');
  document.getElementById('optimizer-bar')?.classList.add('hidden');
  saveToStorage(!!opts.skipCloudPush);
}

function loadInitialState() {
  const autoSaved = loadAutoSavedConfig(ALL_CATALOG, DEFAULT_ROOM);
  if (autoSaved && Array.isArray(autoSaved.items) && autoSaved.items.length > 0) {
    applyFullConfiguration(autoSaved, false);
    updateAutosaveStatusUI('Restored auto-save ✓');
    return;
  }

  // Default initial preset while checking IndexedDB fallback asynchronously
  rebuildRoomArchitecture();
  loadItemsList(LAYOUT_PRESETS.dual_parallel.items, false);
  syncPresetSelectors('dual_parallel');
  updateAutosaveStatusUI();

  // Secondary IndexedDB restore if localStorage was cleared
  idbGet(AUTO_STATE_KEY).then((idbRaw) => {
    if (!idbRaw) return;
    const res = validateAndNormalizeConfig(idbRaw, ALL_CATALOG, DEFAULT_ROOM);
    if (res.ok && !res.isBackup && res.config.items.length > 0) {
      applyFullConfiguration(res.config, false);
      updateAutosaveStatusUI('Restored from IDB ✓');
    }
  });
}

// ======================== WIRE UI CONTROLS ========================
function toggleUnits() {
  state.units = state.units === 'imperial' ? 'metric' : 'imperial';
  const label = state.units === 'imperial' ? 'ft / in' : 'm / cm';
  document.getElementById('btn-units').textContent = label;
  document.getElementById('pop-units-btn').textContent = label;
  updateRoomMetaHeader();
  updateLeftRail();
  renderCatalogCards();
  rebuildSelectionGuides();
  updateInspector();
  if (!document.getElementById('calib-modal').classList.contains('hidden')) {
    populateCalibrationModal();
  }
  saveToStorage();
}

function toggleLighting() {
  state.lightingMood = state.lightingMood === 'day' ? 'evening' : 'day';
  applyLightingMood();
  saveToStorage();
}

function applyPresetByKey(key) {
  if (!LAYOUT_PRESETS[key]) return;
  document.getElementById('optimizer-bar').classList.add('hidden');
  syncPresetSelectors(key);
  const itemsCopy = LAYOUT_PRESETS[key].items.map((it) => {
    if (it.catalogId === 'retained_wood_desk' && state.retainedDeskId === 'retained_white_desk') {
      return { ...it, catalogId: 'retained_white_desk', finish: 'white' };
    }
    return { ...it };
  });
  loadItemsList(itemsCopy, true);
}

function initUI() {
  // Category tabs (auto-expand Buy Mode dock if collapsed!)
  const catTabs = document.getElementById('cat-tabs');
  for (const c of CATEGORIES) {
    const btn = document.createElement('button');
    btn.className = `cat-tab ${c.id === 'all' ? 'active' : ''}`;
    btn.textContent = c.label;
    btn.onclick = () => {
      state.activeCategory = c.id;
      catTabs.querySelectorAll('.cat-tab').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      expandBuyDock();
      renderCatalogCards();
    };
    catTabs.appendChild(btn);
  }
  renderCatalogCards();

  const searchInput = document.getElementById('catalog-search');
  searchInput.addEventListener('focus', expandBuyDock);
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    expandBuyDock();
    renderCatalogCards();
  });

  // Buy dock collapse toggle
  const dock = document.getElementById('buy-dock');
  const dockBtn = document.getElementById('dock-toggle-btn');
  dockBtn.onclick = () => {
    const isCollapsed = dock.classList.toggle('collapsed');
    document.body.classList.toggle('dock-collapsed', isCollapsed);
    dockBtn.textContent = isCollapsed ? 'Expand ▲' : 'Hide ▼';
  };

  // Dismiss onboarding hint
  document.getElementById('dismiss-hint-btn').onclick = () => {
    document.getElementById('controls-hint').classList.add('hidden');
  };

  // Responsive Room Drawer & More Popover Toggles
  document.getElementById('btn-toggle-rail').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('more-popover').classList.add('hidden');
    document.getElementById('left-rail').classList.toggle('drawer-open');
  };
  document.getElementById('btn-more-tools').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('left-rail').classList.remove('drawer-open');
    document.getElementById('more-popover').classList.toggle('hidden');
  };

  // Camera views
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => setCameraView(b.dataset.view);
  });

  // Wall cutaway modes (sync both desktop & More popover)
  document.querySelectorAll('[data-wall]').forEach((b) => {
    b.onclick = () => setWallMode(b.dataset.wall);
  });

  // Lighting & Units (both inline and More popover)
  document.getElementById('btn-lighting').onclick = toggleLighting;
  document.getElementById('pop-lighting-btn').onclick = toggleLighting;
  document.getElementById('btn-units').onclick = toggleUnits;
  document.getElementById('pop-units-btn').onclick = toggleUnits;

  // Tape Measure & Undo
  document.getElementById('btn-measure').onclick = toggleMeasureMode;
  document.getElementById('btn-undo').onclick = undo;

  // Optimized Suggestion Mode + Shuffle
  document.getElementById('btn-optimize').onclick = () => runOptimizedSuggestion();
  document.getElementById('opt-shuffle-btn').onclick = () => runOptimizedSuggestion();
  document.getElementById('opt-goal-select').onchange = (e) => runOptimizedSuggestion(e.target.value);
  document.getElementById('opt-close-btn').onclick = () => {
    document.getElementById('optimizer-bar').classList.add('hidden');
  };

  // On-Canvas 90-Degree L / R Rotation Overlay Gizmo
  const gizmoEl = document.getElementById('selection-gizmo');
  gizmoEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.getElementById('gizmo-rot-left').onclick = (e) => {
    e.stopPropagation();
    rotateSelected(-90);
  };
  document.getElementById('gizmo-rot-right').onclick = (e) => {
    e.stopPropagation();
    rotateSelected(90);
  };

  // Layout Presets selectors
  document.getElementById('preset-select').onchange = (e) => applyPresetByKey(e.target.value);
  document.getElementById('pop-preset-select').onchange = (e) => {
    applyPresetByKey(e.target.value);
    document.getElementById('more-popover').classList.add('hidden');
  };

  // Retained desk toggle
  document.getElementById('desk-wood-btn').onclick = () => swapRetainedDesk('retained_wood_desk');
  document.getElementById('desk-white-btn').onclick = () => swapRetainedDesk('retained_white_desk');

  // Room display checkboxes
  document.getElementById('chk-grid').onchange = (e) => {
    state.showGrid = e.target.checked;
    if (roomObj) roomObj.gridGroup.visible = state.showGrid;
    invalidateFisheye();
    saveToStorage();
  };
  document.getElementById('chk-clearance').onchange = (e) => {
    state.showClearances = e.target.checked;
    if (roomObj) roomObj.clearanceGroup.visible = state.showClearances;
    invalidateFisheye();
    saveToStorage();
  };
  document.getElementById('chk-dims').onchange = (e) => {
    state.showDimensions = e.target.checked;
    saveToStorage();
  };
  document.getElementById('chk-wallsnap').onchange = (e) => {
    state.wallSnap = e.target.checked;
    saveToStorage();
  };
  document.getElementById('chk-closet').onchange = (e) => {
    state.closetOpen = e.target.checked;
    if (roomObj) roomObj.setClosetOpen(state.closetOpen ? 0.82 : 0.02);
    invalidateFisheye();
    saveToStorage();
  };
  document.getElementById('chk-door').onchange = (e) => {
    state.entryDoorOpen = e.target.checked;
    if (roomObj) roomObj.setEntryDoorOpen(state.entryDoorOpen ? 0.9 : 0.04);
    invalidateFisheye();
    saveToStorage();
  };

  // Eye-Level Fisheye / Panini / Stereographic Lens HUD Controls
  document.querySelectorAll('[data-lens]').forEach((btn) => {
    btn.onclick = () => {
      setFisheyeMode(btn.dataset.lens);
      saveToStorage();
    };
  });
  const feFovSlider = document.getElementById('fisheye-fov-slider');
  if (feFovSlider) {
    feFovSlider.addEventListener('input', (e) => setFisheyeFovDeg(e.target.value));
    feFovSlider.addEventListener('change', () => {
      feFovSlider.blur();
      saveToStorage();
    });
    feFovSlider.addEventListener('pointerup', () => feFovSlider.blur());
  }
  document.querySelectorAll('[data-vantage]').forEach((btn) => {
    btn.onclick = () => {
      jumpToEyeVantage(btn.dataset.vantage, true);
      saveToStorage();
    };
  });
  const feExitBtn = document.getElementById('fisheye-exit-btn');
  if (feExitBtn) feExitBtn.onclick = () => setCameraView('3d');

  // Inspector controls
  document.getElementById('insp-close').onclick = () => {
    state.selectedUid = null;
    revalidateAllItems();
    updateInspector();
  };
  const inspCollapseBtn = document.getElementById('insp-collapse-btn');
  if (inspCollapseBtn) {
    inspCollapseBtn.onclick = () => {
      const panel = document.getElementById('inspector');
      const isCol = panel.classList.toggle('collapsed');
      inspCollapseBtn.textContent = isCol ? '▸' : '▾';
    };
  }
  document.getElementById('rot-ccw-90').onclick = () => rotateSelected(-90);
  document.getElementById('rot-ccw-15').onclick = () => rotateSelected(-15);
  document.getElementById('rot-cw-15').onclick = () => rotateSelected(15);
  document.getElementById('rot-cw-90').onclick = () => rotateSelected(90);
  const angleSlider = document.getElementById('insp-angle-slider');
  angleSlider.addEventListener('input', (e) => {
    setSelectedRotation(Number(e.target.value), false);
  });
  // Blur range input on release so R / Q / E keyboard shortcuts are never swallowed!
  angleSlider.addEventListener('change', () => angleSlider.blur());
  angleSlider.addEventListener('pointerup', () => angleSlider.blur());

  // Buy Mode catalog horizontal scroll chevrons
  const catStrip = document.getElementById('catalog-strip');
  const prevBtn = document.getElementById('strip-prev-btn');
  const nextBtn = document.getElementById('strip-next-btn');
  if (prevBtn && catStrip) {
    prevBtn.onclick = () => catStrip.scrollBy({ left: -420, behavior: 'smooth' });
  }
  if (nextBtn && catStrip) {
    nextBtn.onclick = () => catStrip.scrollBy({ left: 420, behavior: 'smooth' });
  }

  // Inspector Cartesian Nudge Pad (25 cm default, Shift+click = 5 cm)
  const stepInFromEvent = (e) => (e.shiftKey ? NUDGE_FINE_CM : NUDGE_STEP_CM) * CM_TO_IN;
  document.getElementById('nudge-n').onclick = (e) => nudgeSelected(0, -stepInFromEvent(e));
  document.getElementById('nudge-s').onclick = (e) => nudgeSelected(0, stepInFromEvent(e));
  document.getElementById('nudge-w').onclick = (e) => nudgeSelected(-stepInFromEvent(e), 0);
  document.getElementById('nudge-e').onclick = (e) => nudgeSelected(stepInFromEvent(e), 0);

  document.getElementById('insp-expand-btn').onclick = () => {
    const item = state.items.find((i) => i.uid === state.selectedUid);
    if (!item) return;
    pushUndoSnapshot();
    item.expanded = !item.expanded;
    const cat = ALL_CATALOG[item.catalogId];
    const dims = getItemDimensionsIn(item, cat);
    const clamped = clampAndSnapToRoom(item.x, item.z, dims.w, dims.d, item.rotDeg, state.room, {
      gridSnapIn: 0,
      wallSnap: false,
    });
    item.x = clamped.x;
    item.z = clamped.z;
    syncItemMesh(item, true);
    revalidateAllItems();
    updateInspector();
    saveToStorage();
  };
  document.getElementById('insp-dup-btn').onclick = duplicateSelected;
  document.getElementById('insp-del-btn').onclick = deleteSelected;

  // Shopping Cart Modal + Budget Cap + PNG Export
  document.getElementById('cart-btn').onclick = openShoppingModal;
  document.getElementById('close-cart-modal').onclick = () =>
    document.getElementById('cart-modal').classList.add('hidden');
  document.getElementById('copy-cart-btn').onclick = copyShoppingListText;
  const exportPngBtn = document.getElementById('export-png-btn');
  if (exportPngBtn) exportPngBtn.onclick = exportFloorplanPNG;
  const budgetInp = document.getElementById('budget-cap-input');
  if (budgetInp) {
    try {
      const savedCap = localStorage.getItem('room_planner_budget_cap');
      if (savedCap !== null) budgetInp.value = savedCap;
    } catch (_) {}
    budgetInp.addEventListener('input', () => updateBudgetBar(null));
  }
  document.getElementById('cart-modal').addEventListener('click', (e) => {
    if (e.target.id === 'cart-modal') e.target.classList.add('hidden');
  });

  // Named Save Slots (Layout A / B / C side-by-side IKEA cost comparison!)
  initSaveSlotsUI();

  // Live IKEA Renton WA (Store #488) Inventory Lookup Modal
  initRentonLookupUI();

  // Room Calibration Modal
  document.getElementById('open-calib-btn').onclick = () => {
    populateCalibrationModal();
    document.getElementById('calib-modal').classList.remove('hidden');
  };
  ['calib-width', 'calib-length', 'calib-height'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateCalibrationHints);
  });
  document.getElementById('close-calib-modal').onclick = () =>
    document.getElementById('calib-modal').classList.add('hidden');
  document.getElementById('calib-modal').addEventListener('click', (e) => {
    if (e.target.id === 'calib-modal') e.target.classList.add('hidden');
  });
  document.getElementById('reset-calib-btn').onclick = () => {
    state.room = { ...DEFAULT_ROOM };
    populateCalibrationModal();
    rebuildRoomArchitecture();
    saveToStorage();
  };
  document.getElementById('apply-calib-btn').onclick = () => {
    const isMetric = state.units === 'metric';
    const rawW = Number(document.getElementById('calib-width').value);
    const rawL = Number(document.getElementById('calib-length').value);
    const rawH = Number(document.getElementById('calib-height').value);
    const wIn = isMetric ? rawW * CM_TO_IN : rawW;
    const lIn = isMetric ? rawL * CM_TO_IN : rawL;
    const hIn = isMetric ? rawH * CM_TO_IN : rawH;
    state.room.widthIn = Math.max(72, Math.min(240, wIn || DEFAULT_ROOM.widthIn));
    state.room.lengthIn = Math.max(96, Math.min(300, lIn || DEFAULT_ROOM.lengthIn));
    state.room.heightIn = Math.max(84, Math.min(144, hIn || DEFAULT_ROOM.heightIn));
    rebuildRoomArchitecture();
    for (const it of state.items) {
      const cat = ALL_CATALOG[it.catalogId];
      const dims = getItemDimensionsIn(it, cat);
      const c = clampAndSnapToRoom(it.x, it.z, dims.w, dims.d, it.rotDeg, state.room, {
        gridSnapIn: 0,
        wallSnap: false,
      });
      it.x = c.x;
      it.z = c.z;
      const entry = meshByUid.get(it.uid);
      if (entry) entry.group.position.set(it.x * IN_TO_M, 0, it.z * IN_TO_M);
    }
    revalidateAllItems();
    saveToStorage();
    document.getElementById('calib-modal').classList.add('hidden');
  };

  initAgentUI();
}

// ======================== AI LAYOUT PLANNER AGENT UI ========================
function formatProviderBadge(cfg) {
  const override = (cfg.model || '').trim();
  if (override) return override;
  switch (cfg.provider) {
    case 'gemini-4-neon': return 'Gemini 4 Neon';
    case 'gemini-4-carbon': return 'Gemini 4 Carbon';
    case 'gemini-4-hydrogen': return 'Gemini 4 Hydrogen';
    case 'openai': return 'OpenAI';
    case 'custom': return 'Custom LLM';
    default: return 'Gemini 4 Neon';
  }
}

function isGeminiChoice(provider) {
  return provider === 'gemini-4-neon' || provider === 'gemini-4-carbon' || provider === 'gemini-4-hydrogen';
}

function openAgentPanel(focusInput = false) {
  const panel = document.getElementById('agent-panel');
  const btn = document.getElementById('btn-agent');
  if (!panel) return;
  panel.classList.remove('hidden');
  if (btn) btn.classList.add('active');
  if (focusInput) {
    const inp = document.getElementById('agent-input');
    if (inp) setTimeout(() => inp.focus(), 30);
  }
}

function initAgentUI() {
  const panel = document.getElementById('agent-panel');
  const btn = document.getElementById('btn-agent');
  const closeBtn = document.getElementById('agent-close-btn');
  const settingsBtn = document.getElementById('agent-settings-btn');
  const settingsBox = document.getElementById('agent-settings');
  const modeSel = document.getElementById('agent-mode-select');
  const apiFields = document.getElementById('agent-api-fields');
  const provSel = document.getElementById('agent-provider-select');
  const thinkRow = document.getElementById('agent-thinking-row');
  const thinkSel = document.getElementById('agent-thinking-select');
  const keyInp = document.getElementById('agent-api-key');
  const keyToggleBtn = document.getElementById('agent-key-toggle');
  const keyTestBtn = document.getElementById('agent-key-test');
  const keyClearBtn = document.getElementById('agent-key-clear');
  const keyStatusEl = document.getElementById('agent-key-status');
  const modelInp = document.getElementById('agent-model-input');
  const epRow = document.getElementById('agent-endpoint-row');
  const epInp = document.getElementById('agent-endpoint-input');
  const subEl = document.getElementById('agent-mode-sub');
  const logEl = document.getElementById('agent-log');
  const chipsEl = document.getElementById('agent-chips');
  const form = document.getElementById('agent-form');
  const input = document.getElementById('agent-input');
  const sendBtn = document.getElementById('agent-send-btn');

  if (!panel || !btn) return;

  const llmCfg = { ...DEFAULT_AGENT_SETTINGS };
  let vaultStorageMode = 'none';
  let saveTimer = null;

  const setKeyStatus = (text, tone = '') => {
    if (!keyStatusEl) return;
    keyStatusEl.textContent = text;
    keyStatusEl.className = `agent-vault-status${tone ? ` ${tone}` : ''}`;
  };

  const refreshVaultStatusLabel = () => {
    if (!llmCfg.apiKey.trim()) {
      setKeyStatus('No key stored · Built-in planner active');
      return;
    }
    if (vaultStorageMode === 'encrypted') {
      setKeyStatus('🔒 Encrypted Vault (IDB + Local) · Never in .json exports', 'ok');
    } else if (vaultStorageMode === 'local') {
      setKeyStatus('💾 Saved in Local Vault (IDB + Local) · Never in .json', 'ok');
    } else {
      setKeyStatus('Session memory only (storage blocked by sandbox)');
    }
  };

  const syncSettingsUI = () => {
    modeSel.value = llmCfg.mode;
    provSel.value = llmCfg.provider;
    if (thinkSel) thinkSel.value = llmCfg.thinkingLevel || 'MEDIUM';
    if (document.activeElement !== keyInp) keyInp.value = llmCfg.apiKey;
    if (document.activeElement !== modelInp) modelInp.value = llmCfg.model;
    if (document.activeElement !== epInp) epInp.value = llmCfg.endpoint;

    apiFields.classList.toggle('hidden', llmCfg.mode !== 'api');
    const geminiActive = isGeminiChoice(llmCfg.provider);
    if (thinkRow) thinkRow.style.display = geminiActive ? 'flex' : 'none';
    epRow.style.display = llmCfg.provider === 'custom' ? 'flex' : 'none';
    if (keyTestBtn) keyTestBtn.style.display = geminiActive ? '' : 'none';

    if (llmCfg.mode === 'api' && (llmCfg.apiKey.trim() || llmCfg.provider === 'custom')) {
      const thinkTag = geminiActive ? ` · ${(llmCfg.thinkingLevel || 'MEDIUM').toLowerCase()}` : '';
      const vaultTag = llmCfg.apiKey.trim() ? (vaultStorageMode === 'encrypted' ? ' · 🔒 Vault' : ' · Saved') : '';
      subEl.textContent = `${formatProviderBadge(llmCfg)}${thinkTag}${vaultTag}`;
    } else if (llmCfg.mode === 'api') {
      subEl.textContent = `${formatProviderBadge(llmCfg)} · Paste API key in ⚙ Gemini 4`;
    } else {
      subEl.textContent = 'Built-in Spatial Agent · Click ⚙ Gemini 4 for Live AI';
    }
    refreshVaultStatusLabel();
  };
  syncSettingsUI();

  const persistNow = async () => {
    const res = await saveAgentSettings(llmCfg);
    vaultStorageMode = res.storageMode;
    syncSettingsUI();
  };

  const schedulePersist = (immediate = false) => {
    if (saveTimer) clearTimeout(saveTimer);
    if (immediate) {
      persistNow();
    } else {
      saveTimer = setTimeout(persistNow, 180);
    }
  };

  const onCfgChange = (immediate = false) => {
    llmCfg.mode = modeSel.value;
    llmCfg.provider = provSel.value;
    llmCfg.thinkingLevel = thinkSel ? thinkSel.value : 'MEDIUM';
    llmCfg.apiKey = keyInp.value.trim();
    llmCfg.model = modelInp.value.trim();
    llmCfg.endpoint = epInp.value.trim();

    // Auto-switch to Gemini 4 when a Google AI Studio key (AIza...) is pasted
    if (llmCfg.apiKey.startsWith('AIza') && llmCfg.mode === 'builtin') {
      llmCfg.mode = 'api';
      if (!isGeminiChoice(llmCfg.provider)) llmCfg.provider = 'gemini-4-neon';
    }
    syncSettingsUI();
    schedulePersist(immediate);
  };

  modeSel.onchange = () => onCfgChange(true);
  provSel.onchange = () => onCfgChange(true);
  if (thinkSel) thinkSel.onchange = () => onCfgChange(true);
  keyInp.oninput = () => onCfgChange(false);
  keyInp.onblur = () => onCfgChange(true);
  modelInp.oninput = () => onCfgChange(false);
  epInp.oninput = () => onCfgChange(false);

  if (keyToggleBtn) {
    keyToggleBtn.onclick = () => {
      const showing = keyInp.type === 'text';
      keyInp.type = showing ? 'password' : 'text';
      keyToggleBtn.textContent = showing ? '👁' : '🙈';
    };
  }

  if (keyClearBtn) {
    keyClearBtn.onclick = async () => {
      const cleared = await clearStoredApiKey(llmCfg);
      Object.assign(llmCfg, cleared);
      vaultStorageMode = 'none';
      keyInp.value = '';
      keyInp.type = 'password';
      if (keyToggleBtn) keyToggleBtn.textContent = '👁';
      syncSettingsUI();
      setKeyStatus('Saved key erased from browser vault.');
    };
  }

  if (keyTestBtn) {
    keyTestBtn.onclick = async () => {
      const k = keyInp.value.trim();
      if (!k) {
        setKeyStatus('Paste your AI Studio key first.', 'err');
        keyInp.focus();
        return;
      }
      await persistNow();
      keyTestBtn.disabled = true;
      keyTestBtn.textContent = '…';
      setKeyStatus('Checking key against Gemini API (0 tokens)…');
      const modelId = resolveGeminiModelId(llmCfg);
      const res = await testGeminiApiKey(k, modelId);
      keyTestBtn.disabled = false;
      keyTestBtn.textContent = 'Test';
      if (res.ok) {
        setKeyStatus(`✓ Verified ${res.displayName} · Saved in vault`, 'ok');
      } else {
        setKeyStatus(`⚠ ${res.error}`, 'err');
      }
    };
  }

  // Hydrate persisted preferences & encrypted API key across sessions on boot
  loadAgentSettings().then(({ settings, storageMode }) => {
    Object.assign(llmCfg, settings);
    vaultStorageMode = storageMode;
    syncSettingsUI();
  });

  btn.onclick = () => {
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) openAgentPanel(true);
    else {
      panel.classList.add('hidden');
      btn.classList.remove('active');
    }
  };
  closeBtn.onclick = () => {
    panel.classList.add('hidden');
    btn.classList.remove('active');
  };
  settingsBtn.onclick = () => {
    const opening = settingsBox.classList.toggle('hidden') === false;
    // When opening settings with no key yet, surface the BYOK panel immediately if user wants Gemini 4
    if (opening && llmCfg.mode === 'builtin' && !llmCfg.apiKey) {
      llmCfg.mode = 'api';
      syncSettingsUI();
    }
  };

  // Prevent pointer clicks inside panel from dragging 3D orbit controls
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  const appendMessage = (role, text, trace = []) => {
    const msg = document.createElement('div');
    msg.className = `agent-msg ${role}`;
    msg.textContent = text;
    if (trace && trace.length > 0) {
      const list = document.createElement('div');
      list.className = 'agent-trace-list';
      for (const t of trace) {
        const pill = document.createElement('span');
        pill.className = `agent-trace-pill ${t.ok ? '' : 'warn'}`;
        pill.textContent = `${t.ok ? '✓' : '⚠'} ${t.summary}`;
        list.appendChild(pill);
      }
      msg.appendChild(list);
    }
    logEl.appendChild(msg);
    logEl.scrollTop = logEl.scrollHeight;
  };

  const agentApi = {
    pushUndoSnapshot,
    loadItemsList,
    syncItemMesh,
    revalidateAllItems,
    updateInspector,
    updateCartBadge,
    updateLeftRail,
    saveToStorage,
    setCameraView,
    setWallMode,
    applyLightingMood,
    swapRetainedDesk,
    runOptimizedSuggestion,
    undo,
    syncPresetSelectors,
    deleteItemByUid,
    nextUid,
    formatLen,
    formatArea,
  };

  const runPrompt = async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    appendMessage('user', trimmed);
    input.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = '...';
    try {
      const res = await runLayoutAgentCommand(trimmed, { state, api: agentApi }, llmCfg);
      appendMessage('assistant', res.reply, res.trace);
    } catch (err) {
      appendMessage('assistant', `Error running command: ${err.message || err}`);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Run';
      input.focus();
    }
  };

  // Populate 1-click Quick Prompt Chips
  chipsEl.innerHTML = '';
  for (const promptText of AGENT_QUICK_PROMPTS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'agent-chip';
    chip.textContent = promptText;
    chip.onclick = () => runPrompt(promptText);
    chipsEl.appendChild(chip);
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    runPrompt(input.value);
  };
}

// ======================== NAMED SAVE SLOTS (A / B / C COST COMPARISON) ========================
const SAVE_SLOTS_KEY = 'room_planner_save_slots_v1';

function computeItemsIkeaSummary(items) {
  let cost = 0;
  let count = 0;
  for (const it of items || []) {
    const c = ALL_CATALOG[it.catalogId];
    if (c && !c.retained && c.brand === 'IKEA') {
      cost += c.price;
      count++;
    }
  }
  return { cost, count };
}

let configFeedbackTimer = null;
function showConfigFeedback(msg, isError = false) {
  const el = document.getElementById('config-feedback');
  if (!el) return;
  el.textContent = msg;
  el.className = `config-feedback ${isError ? 'err' : 'ok'}`;
  clearTimeout(configFeedbackTimer);
  configFeedbackTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

let renderAllSavedPlansUI = () => {};

function openConfigModal() {
  document.getElementById('more-popover')?.classList.add('hidden');
  document.getElementById('left-rail')?.classList.remove('drawer-open');
  updateAutosaveStatusUI();
  renderAllSavedPlansUI();
  const modal = document.getElementById('config-modal');
  if (modal) modal.classList.remove('hidden');
  const inp = document.getElementById('save-config-name');
  if (inp && !inp.value.trim()) {
    const s = computeItemsIkeaSummary(state.items);
    inp.placeholder = `Name this layout (${s.count} IKEA · $${s.cost.toLocaleString()})…`;
  }
}

function initSaveSlotsUI() {
  savedConfigs = loadSavedConfigsList(ALL_CATALOG, DEFAULT_ROOM, LAYOUT_PRESETS);
  if (savedConfigs.length > 0 && !activeSavedConfigId) {
    activeSavedConfigId = savedConfigs[0].id;
  }

  // Secondary IndexedDB recovery for saved plans list if localStorage was wiped
  idbGet(SAVED_CONFIGS_KEY).then((idbList) => {
    if (Array.isArray(idbList) && idbList.length > savedConfigs.length) {
      const recovered = [];
      for (const entry of idbList) {
        const res = validateAndNormalizeConfig(entry, ALL_CATALOG, DEFAULT_ROOM);
        if (res.ok && !res.isBackup) {
          recovered.push({ id: entry.id || `cfg_${recovered.length + 1}`, ...res.config });
        }
      }
      if (recovered.length > 0) {
        savedConfigs = recovered;
        renderAllSavedPlansUI();
      }
    }
  });

  const persistLibrary = (skipCloudPush = false) => {
    persistSavedConfigsList(savedConfigs);
    renderAllSavedPlansUI();
    if (!skipCloudPush) scheduleGoogleCloudPush();
  };

  const escapeHtml = (str) =>
    String(str || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const loadConfigEntry = (entry, closeModal = false) => {
    if (!entry) return;
    activeSavedConfigId = entry.id;
    applyFullConfiguration(entry, true);
    renderAllSavedPlansUI();
    showConfigFeedback(`Loaded "${entry.name}" ✓`);
    if (closeModal) {
      document.getElementById('config-modal')?.classList.add('hidden');
    }
  };

  const importJsonString = (rawText, sourceLabel = 'JSON') => {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      showConfigFeedback(`Invalid JSON (${sourceLabel}): ${err.message}`, true);
      return false;
    }
    const res = validateAndNormalizeConfig(parsed, ALL_CATALOG, DEFAULT_ROOM);
    if (!res.ok) {
      showConfigFeedback(res.error || 'Could not load configuration.', true);
      return false;
    }

    if (res.isBackup) {
      // Merge imported backup plans into library without losing existing unique IDs
      const existingById = new Map(savedConfigs.map((c) => [c.id, c]));
      for (const plan of res.savedConfigs) {
        existingById.set(plan.id, plan);
      }
      savedConfigs = Array.from(existingById.values());
      persistLibrary();
      if (res.current) {
        applyFullConfiguration(res.current, true);
      }
      showConfigFeedback(`Restored backup with ${res.savedConfigs.length} saved plan(s) ✓`);
      return true;
    }

    // Single configuration import: load immediately AND add to saved library
    const newEntry = {
      id: `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      ...res.config,
    };
    savedConfigs.unshift(newEntry);
    activeSavedConfigId = newEntry.id;
    applyFullConfiguration(newEntry, true);
    persistLibrary();
    const warnSuffix = res.warnings.length > 0 ? ` (${res.warnings.length} item(s) skipped)` : '';
    showConfigFeedback(`Imported & loaded "${newEntry.name}"${warnSuffix} ✓`);
    return true;
  };

  const handleFileImport = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      importJsonString(String(reader.result || ''), file.name);
    };
    reader.onerror = () => showConfigFeedback(`Failed to read "${file.name}".`, true);
    reader.readAsText(file);
  };

  // Render BOTH the Left Rail compact Saved Plans list AND the Modal full library
  renderAllSavedPlansUI = () => {
    // 1. Left Rail Quick Switcher (top 3 saved plans)
    const railList = document.getElementById('save-slots-list');
    if (railList) {
      railList.innerHTML = '';
      const quickList = savedConfigs.slice(0, 3);
      if (quickList.length === 0) {
        railList.innerHTML = '<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:4px 0;">No saved plans yet</div>';
      } else {
        for (const cfg of quickList) {
          const s = computeItemsIkeaSummary(cfg.items);
          const row = document.createElement('div');
          row.className = `save-slot-row ${activeSavedConfigId === cfg.id ? 'active' : ''}`;
          row.innerHTML = `
            <button class="save-slot-load" title="Load ${escapeHtml(cfg.name)}">
              <strong>${escapeHtml(cfg.name)}</strong>
              <span class="save-slot-meta">${s.count} IKEA · $${s.cost.toLocaleString()}</span>
            </button>
            <button class="save-slot-save" title="Overwrite ${escapeHtml(cfg.name)} with current room">Update</button>
          `;
          row.querySelector('.save-slot-load').onclick = () => {
            loadConfigEntry(cfg, false);
            document.getElementById('left-rail')?.classList.remove('drawer-open');
          };
          row.querySelector('.save-slot-save').onclick = () => {
            const updated = { id: cfg.id, ...buildConfigSnapshot(state, cfg.name, getCurrentBudgetCap(), ALL_CATALOG) };
            const idx = savedConfigs.findIndex((c) => c.id === cfg.id);
            if (idx >= 0) savedConfigs[idx] = updated;
            activeSavedConfigId = cfg.id;
            persistLibrary();
            updateAutosaveStatusUI(`Updated "${cfg.name}" ✓`);
          };
          railList.appendChild(row);
        }
      }
    }

    // 2. Full Save & Load Modal Library
    const modalList = document.getElementById('saved-configs-list');
    const countEl = document.getElementById('saved-configs-count');
    if (countEl) countEl.textContent = String(savedConfigs.length);
    if (!modalList) return;

    modalList.innerHTML = '';
    if (savedConfigs.length === 0) {
      modalList.innerHTML = '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:16px 8px;">No saved configurations yet. Enter a name above and click <strong>Save Plan</strong>.</div>';
      return;
    }

    for (const cfg of savedConfigs) {
      const s = computeItemsIkeaSummary(cfg.items);
      const ts = formatSavedTimestamp(cfg.savedAt);
      const rW = cfg.room?.widthIn || DEFAULT_ROOM.widthIn;
      const rL = cfg.room?.lengthIn || DEFAULT_ROOM.lengthIn;
      const row = document.createElement('div');
      row.className = `cfg-row ${activeSavedConfigId === cfg.id ? 'active' : ''}`;
      row.innerHTML = `
        <div class="cfg-row-main">
          <div class="cfg-row-title">${escapeHtml(cfg.name)}</div>
          <div class="cfg-row-meta">${s.count} IKEA · $${s.cost.toLocaleString()} · ${formatLen(rW)}×${formatLen(rL)}${ts ? ` · ${ts}` : ''}</div>
        </div>
        <div class="cfg-row-actions">
          <button class="mini-btn load-btn" title="Load this configuration into 3D room">Load</button>
          <button class="mini-btn upd-btn" title="Overwrite this saved slot with your current room">Update</button>
          <button class="mini-btn dl-btn" title="Download this plan as .json">↓</button>
          <button class="mini-btn del-btn" title="Delete saved configuration">×</button>
        </div>
      `;

      row.querySelector('.load-btn').onclick = () => loadConfigEntry(cfg, true);
      row.querySelector('.upd-btn').onclick = () => {
        const updated = { id: cfg.id, ...buildConfigSnapshot(state, cfg.name, getCurrentBudgetCap(), ALL_CATALOG) };
        const idx = savedConfigs.findIndex((c) => c.id === cfg.id);
        if (idx >= 0) savedConfigs[idx] = updated;
        activeSavedConfigId = cfg.id;
        persistLibrary();
        showConfigFeedback(`Updated "${cfg.name}" with current layout ✓`);
      };
      row.querySelector('.dl-btn').onclick = () => {
        downloadJsonFile(cfg, slugifyFilename(cfg.name));
        showConfigFeedback(`Downloaded ${slugifyFilename(cfg.name)} ✓`);
      };
      row.querySelector('.del-btn').onclick = () => {
        savedConfigs = savedConfigs.filter((c) => c.id !== cfg.id);
        if (activeSavedConfigId === cfg.id) activeSavedConfigId = savedConfigs[0]?.id || null;
        persistLibrary();
        showConfigFeedback(`Deleted "${cfg.name}".`);
      };
      modalList.appendChild(row);
    }
  };

  // Wire buttons that open/close the Save & Load Modal
  const openBtnTop = document.getElementById('btn-save-load');
  const openBtnPop = document.getElementById('pop-save-load-btn');
  const openBtnRail = document.getElementById('rail-open-config-btn');
  if (openBtnTop) openBtnTop.onclick = openConfigModal;
  if (openBtnPop) openBtnPop.onclick = openConfigModal;
  if (openBtnRail) openBtnRail.onclick = openConfigModal;

  const closeModal = () => document.getElementById('config-modal')?.classList.add('hidden');
  document.getElementById('close-config-modal')?.addEventListener('click', closeModal);
  document.getElementById('cfg-done-btn')?.addEventListener('click', closeModal);
  document.getElementById('config-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'config-modal') closeModal();
  });

  // Save New Named Configuration form
  const saveForm = document.getElementById('save-config-form');
  const nameInp = document.getElementById('save-config-name');
  if (saveForm && nameInp) {
    saveForm.onsubmit = (e) => {
      e.preventDefault();
      const rawName = nameInp.value.trim() || `Room Plan #${savedConfigs.length + 1}`;
      const newEntry = {
        id: `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        ...buildConfigSnapshot(state, rawName, getCurrentBudgetCap(), ALL_CATALOG),
      };
      savedConfigs.unshift(newEntry);
      activeSavedConfigId = newEntry.id;
      activeConfigName = rawName;
      nameInp.value = '';
      persistLibrary();
      saveToStorage();
      showConfigFeedback(`Saved "${rawName}" ✓`);
    };
  }

  // Export current plan as .json
  document.getElementById('cfg-export-file-btn')?.addEventListener('click', () => {
    const snap = buildConfigSnapshot(state, activeConfigName || 'Room Studio Plan', getCurrentBudgetCap(), ALL_CATALOG);
    const dateTag = new Date().toISOString().slice(0, 10);
    const fname = `room-studio-${dateTag}.json`;
    downloadJsonFile(snap, fname);
    showConfigFeedback(`Downloaded ${fname} ✓`);
  });

  // Backup ALL saved plans + current state
  document.getElementById('cfg-backup-all-btn')?.addEventListener('click', () => {
    const snap = buildConfigSnapshot(state, activeConfigName || 'Current Plan', getCurrentBudgetCap(), ALL_CATALOG);
    const bundle = buildBackupBundle(snap, savedConfigs);
    const dateTag = new Date().toISOString().slice(0, 10);
    const fname = `room-studio-backup-${dateTag}.json`;
    downloadJsonFile(bundle, fname);
    showConfigFeedback(`Downloaded full backup (${savedConfigs.length} plans) ✓`);
  });

  // Import .json file picker
  const fileInp = document.getElementById('cfg-file-input');
  document.getElementById('cfg-import-file-btn')?.addEventListener('click', () => {
    if (fileInp) {
      fileInp.value = '';
      fileInp.click();
    }
  });
  fileInp?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleFileImport(file);
  });

  // Drag-and-drop .json file onto the Save & Load modal
  const dropZone = document.getElementById('config-drop-zone');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFileImport(file);
    });
  }

  // Copy Configuration JSON to clipboard (with sandbox-safe fallback!)
  document.getElementById('cfg-copy-json-btn')?.addEventListener('click', () => {
    const snap = buildConfigSnapshot(state, activeConfigName || 'Room Studio Plan', getCurrentBudgetCap(), ALL_CATALOG);
    const text = JSON.stringify(snap, null, 2);
    const onCopied = () => showConfigFeedback('Copied configuration JSON to clipboard ✓');
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(onCopied).catch(() => {
        fallbackCopyText(text);
        onCopied();
      });
    } else {
      fallbackCopyText(text);
      onCopied();
    }
  });

  // Paste JSON panel
  const pastePanel = document.getElementById('cfg-paste-panel');
  const pasteArea = document.getElementById('cfg-paste-textarea');
  document.getElementById('cfg-paste-toggle-btn')?.addEventListener('click', () => {
    if (!pastePanel) return;
    const opening = pastePanel.classList.toggle('hidden') === false;
    if (opening && pasteArea) pasteArea.focus();
  });
  document.getElementById('cfg-paste-cancel-btn')?.addEventListener('click', () => {
    pastePanel?.classList.add('hidden');
  });
  document.getElementById('cfg-paste-load-btn')?.addEventListener('click', () => {
    const txt = pasteArea?.value.trim() || '';
    if (!txt) {
      showConfigFeedback('Paste a Room Studio JSON string first.', true);
      return;
    }
    if (importJsonString(txt, 'clipboard')) {
      pasteArea.value = '';
      pastePanel?.classList.add('hidden');
    }
  });

  // ======================== PURE-GOOGLE DRIVE APPDATA CLOUD SYNC ========================
  // Syncs room configs & named plans privately in the signed-in user's Google Drive appDataFolder.
  // Gemini / LLM API keys are NEVER uploaded (strictly stripped & kept local-only in keyVault.js).
  const gdriveSession = {
    accessToken: null,
    expiresAt: 0,
    user: null,
    fileId: null,
    syncTimer: null,
    inFlight: false,
  };

  const gBadge = document.getElementById('gdrive-status-badge');
  const gOutBox = document.getElementById('gdrive-signed-out');
  const gInBox = document.getElementById('gdrive-signed-in');
  const gClientInp = document.getElementById('gdrive-client-id-input');
  const gSignInBtn = document.getElementById('gdrive-signin-btn');
  const gPushBtn = document.getElementById('gdrive-push-btn');
  const gPullBtn = document.getElementById('gdrive-pull-btn');
  const gSignOutBtn = document.getElementById('gdrive-signout-btn');
  const gAvatar = document.getElementById('gdrive-avatar');
  const gEmailEl = document.getElementById('gdrive-user-email');
  const gMetaEl = document.getElementById('gdrive-sync-meta');
  const topSaveBtn = document.getElementById('btn-save-load');

  const setGDriveBadge = (text, cls = '') => {
    if (gBadge) {
      gBadge.textContent = text;
      gBadge.className = `gdrive-badge${cls ? ` ${cls}` : ''}`;
    }
    if (topSaveBtn) {
      topSaveBtn.textContent = gdriveSession.accessToken ? 'Save · ☁' : 'Save';
    }
  };

  const syncGDriveUI = () => {
    const signedIn = !!(gdriveSession.accessToken && gdriveSession.user);
    gOutBox?.classList.toggle('hidden', signedIn);
    gInBox?.classList.toggle('hidden', !signedIn);
    if (signedIn) {
      if (gEmailEl) gEmailEl.textContent = gdriveSession.user.email || gdriveSession.user.name || 'Signed in';
      if (gAvatar) {
        if (gdriveSession.user.picture) {
          gAvatar.innerHTML = `<img src="${escapeHtml(gdriveSession.user.picture)}" alt="" referrerpolicy="no-referrer" />`;
        } else {
          gAvatar.textContent = (gdriveSession.user.name || gdriveSession.user.email || 'G')[0].toUpperCase();
        }
      }
    } else {
      const hint = loadGoogleUserHint();
      if (gBadge && hint?.email) {
        setGDriveBadge(`Reconnect (${hint.email.split('@')[0]})`);
      } else {
        setGDriveBadge('Not signed in');
      }
    }
  };

  const buildCurrentCloudBundle = () => {
    const snap = buildConfigSnapshot(state, activeConfigName || 'Current Plan', getCurrentBudgetCap(), ALL_CATALOG);
    return buildBackupBundle(snap, savedConfigs);
  };

  const pushStateToCloud = async (silent = false) => {
    if (!gdriveSession.accessToken || gdriveSession.inFlight) return false;
    if (Date.now() >= gdriveSession.expiresAt) {
      setGDriveBadge('Session expired · Re-sign in', 'err');
      gdriveSession.accessToken = null;
      syncGDriveUI();
      return false;
    }
    gdriveSession.inFlight = true;
    setGDriveBadge('☁ Syncing…', 'syncing');
    try {
      const bundle = buildCurrentCloudBundle();
      const res = await pushToGoogleDrive(gdriveSession.accessToken, bundle, gdriveSession.fileId);
      gdriveSession.fileId = res.fileId;
      const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      setGDriveBadge(`☁ Synced ${t}`, 'ok');
      if (gMetaEl) gMetaEl.textContent = `Last synced ${t} to hidden Drive appDataFolder · API key stays local-only`;
      if (!silent) showConfigFeedback('Synced room configs & saved plans to Google Drive ✓');
      return true;
    } catch (err) {
      setGDriveBadge('Sync error', 'err');
      if (!silent) showConfigFeedback(`Google Drive sync failed: ${err.message || err}`, true);
      return false;
    } finally {
      gdriveSession.inFlight = false;
    }
  };

  const pullStateFromCloud = async (applyCurrent = true, silent = false) => {
    if (!gdriveSession.accessToken) return { exists: false };
    setGDriveBadge('☁ Checking cloud…', 'syncing');
    const res = await pullFromGoogleDrive(gdriveSession.accessToken);
    if (!res.exists || !res.bundle) {
      return { exists: false };
    }
    gdriveSession.fileId = res.fileId;
    const norm = validateAndNormalizeConfig(res.bundle, ALL_CATALOG, DEFAULT_ROOM);
    if (!norm.ok) {
      throw new Error(norm.error || 'Cloud backup format unrecognized.');
    }

    if (norm.isBackup) {
      const mergedById = new Map(savedConfigs.map((c) => [c.id, c]));
      for (const cloudPlan of norm.savedConfigs) {
        const local = mergedById.get(cloudPlan.id);
        const localTs = local?.savedAt ? Date.parse(local.savedAt) : 0;
        const cloudTs = cloudPlan?.savedAt ? Date.parse(cloudPlan.savedAt) : 0;
        if (!local || cloudTs >= localTs) {
          mergedById.set(cloudPlan.id, cloudPlan);
        }
      }
      savedConfigs = Array.from(mergedById.values());
      persistLibrary(true);
      if (applyCurrent && norm.current) {
        applyFullConfiguration(norm.current, false, { skipCloudPush: true });
      }
    } else if (applyCurrent && norm.config) {
      applyFullConfiguration(norm.config, false, { skipCloudPush: true });
    }

    const t = formatSavedTimestamp(res.modifiedTime) || 'just now';
    setGDriveBadge(`☁ Synced (${t})`, 'ok');
    if (gMetaEl) gMetaEl.textContent = `Restored from hidden Drive appDataFolder (${t}) · API key stays local-only`;
    if (!silent) showConfigFeedback(`Pulled ${savedConfigs.length} plan(s) from Google Drive ✓`);
    return { exists: true };
  };

  scheduleGoogleCloudPush = () => {
    if (!gdriveSession.accessToken) return;
    clearTimeout(gdriveSession.syncTimer);
    gdriveSession.syncTimer = setTimeout(() => {
      pushStateToCloud(true);
    }, 2400);
  };

  const gToggleCidBtn = document.getElementById('gdrive-toggle-cid-btn');
  if (gClientInp) {
    const initialCid = getGoogleClientId();
    gClientInp.value = initialCid;
    if (!initialCid) gClientInp.classList.remove('hidden');
    gClientInp.addEventListener('input', () => setGoogleClientId(gClientInp.value));
    gClientInp.addEventListener('blur', () => setGoogleClientId(gClientInp.value));
  }
  gToggleCidBtn?.addEventListener('click', () => {
    gClientInp?.classList.toggle('hidden');
    if (gClientInp && !gClientInp.classList.contains('hidden')) gClientInp.focus();
  });

  gSignInBtn?.addEventListener('click', async () => {
    const cid = gClientInp ? setGoogleClientId(gClientInp.value) : getGoogleClientId();
    if (!cid) {
      showConfigFeedback('Paste your Google OAuth Web Client ID (….apps.googleusercontent.com) first.', true);
      gClientInp?.focus();
      return;
    }
    setGDriveBadge('Signing in…', 'syncing');
    gSignInBtn.disabled = true;
    try {
      const auth = await signInWithGoogleDrive({ clientId: cid });
      gdriveSession.accessToken = auth.accessToken;
      gdriveSession.expiresAt = auth.expiresAt;
      gdriveSession.user = auth.user;
      syncGDriveUI();

      // Pull existing Drive appDataFolder backup if present; otherwise seed cloud with local plans
      const pulled = await pullStateFromCloud(true, true);
      if (pulled.exists) {
        await pushStateToCloud(true);
        showConfigFeedback(`Signed in as ${auth.user.email} · Merged & synced with Google Drive ✓`);
      } else {
        await pushStateToCloud(true);
        showConfigFeedback(`Signed in as ${auth.user.email} · Saved initial cloud backup to Drive appData ✓`);
      }
    } catch (err) {
      setGDriveBadge('Not signed in', 'err');
      showConfigFeedback(err?.message || 'Google Sign-In failed.', true);
    } finally {
      gSignInBtn.disabled = false;
    }
  });

  gPushBtn?.addEventListener('click', () => pushStateToCloud(false));
  gPullBtn?.addEventListener('click', async () => {
    try {
      const res = await pullStateFromCloud(true, false);
      if (!res.exists) showConfigFeedback('No cloud backup found yet — click Sync Now to create one.');
    } catch (err) {
      setGDriveBadge('Pull failed', 'err');
      showConfigFeedback(`Pull failed: ${err.message || err}`, true);
    }
  });
  gSignOutBtn?.addEventListener('click', () => {
    clearTimeout(gdriveSession.syncTimer);
    signOutGoogleDrive(gdriveSession.accessToken);
    gdriveSession.accessToken = null;
    gdriveSession.expiresAt = 0;
    gdriveSession.user = null;
    gdriveSession.fileId = null;
    syncGDriveUI();
    showConfigFeedback('Signed out of Google Drive Sync. Local plans & local API key remain untouched.');
  });

  syncGDriveUI();
  renderAllSavedPlansUI();
}

// ======================== LIVE IKEA RENTON WA (#488) LOOKUP ========================
let rentonAbortCtrl = null;
let rentonLastQuery = '';

function escapeRentonHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function runLiveRentonQuery(rawQuery) {
  const q = String(rawQuery || '').trim();
  const statusEl = document.getElementById('renton-status-line');
  const gridEl = document.getElementById('renton-results-grid');
  const inStockOnly = document.getElementById('renton-instock-only')?.checked ?? true;
  if (!statusEl || !gridEl) return;

  if (!q) {
    statusEl.textContent = 'Enter a product name, 8-digit SKU, or click a category above to query live IKEA Renton, WA (#488) stock.';
    gridEl.innerHTML = '';
    return;
  }

  rentonLastQuery = q;
  if (rentonAbortCtrl) rentonAbortCtrl.abort();
  rentonAbortCtrl = new AbortController();

  statusEl.textContent = `Querying live IKEA Renton, WA (#488) for "${q}"…`;
  gridEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:24px 8px;font-size:12px;color:var(--text-muted);">Fetching live store stock, prices &amp; dimensions from Renton #488…</div>';

  try {
    const { items, totalMatched } = await searchLiveRentonInventory(q, {
      size: 40,
      inStockOnly,
      signal: rentonAbortCtrl.signal,
    });

    if (items.length === 0) {
      statusEl.textContent = `0 ${inStockOnly ? 'in-stock ' : ''}furniture matches at Renton #488 for "${q}".`;
      gridEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:22px 10px;font-size:12px;color:var(--text-muted);">
        No matching furniture found${inStockOnly ? ' currently in stock at Renton #488' : ''}.
        ${inStockOnly ? 'Try unchecking <strong>In stock at Renton #488 only</strong> or searching another product name / 8-digit SKU.' : 'Try a broader product name like <em>ALEX</em>, <em>BILLY</em>, <em>MICKE</em>, or <em>desk</em>.'}
      </div>`;
      return;
    }

    statusEl.textContent = `Showing ${items.length} live ${inStockOnly ? 'in-stock ' : ''}items at Renton, WA (#488) for "${q}"${totalMatched > items.length ? ` (${totalMatched.toLocaleString()} total matches)` : ''} — click "+ Place in 3D" to drop right into your room.`;
    gridEl.innerHTML = '';

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'renton-card';
      const stockHtml = getStockBadgeHTML(item.rentonStock);
      const priceHtml = item.prevPrice
        ? `<s>$${item.prevPrice}</s>$${item.price}`
        : `$${item.price}`;
      const imgHtml = item.imageUrl
        ? `<img src="${escapeRentonHtml(item.imageUrl)}" alt="${escapeRentonHtml(item.name)}" loading="lazy" />`
        : `<span style="font-size:11px;color:var(--text-muted);">No image</span>`;
      const skuText = item.skuFormatted ? ` · #${item.skuFormatted}` : '';
      const dimsText = formatDimsShort(item.w, item.d, item.h);

      card.innerHTML = `
        <div class="renton-card-img-wrap">
          ${imgHtml}
          ${stockHtml}
          <span class="renton-card-price">${priceHtml}</span>
        </div>
        <div class="renton-card-title">${escapeRentonHtml(item.name)}</div>
        <div class="renton-card-sub" title="${escapeRentonHtml(item.subtitle + skuText)}">${escapeRentonHtml(item.subtitle + skuText)}</div>
        <div class="renton-card-dims">${escapeRentonHtml(dimsText)}${item.wallMounted ? ' · Wall-mounted' : ''}</div>
        <div class="renton-card-foot">
          <button type="button" class="renton-place-btn">+ Place in 3D</button>
          ${item.pipUrl ? `<a class="renton-pip-link" href="${escapeRentonHtml(item.pipUrl)}" target="_blank" rel="noopener">IKEA ↗</a>` : ''}
        </div>
      `;

      card.querySelector('.renton-place-btn').onclick = () => {
        const reg = registerDynamicCatalogItem(item);
        if (!reg) return;
        renderCatalogCards();
        document.getElementById('renton-modal')?.classList.add('hidden');
        startPlacing(reg.id);
      };

      gridEl.appendChild(card);
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    statusEl.textContent = `Could not reach live IKEA Renton lookup (${err?.message || 'network error'}). Your built-in 300+ synced Renton catalog still works offline!`;
    gridEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px 10px;font-size:12px;color:var(--text-muted);">Live lookup requires internet access to IKEA’s public search service. You can still browse all 300+ pre-synced Renton #488 items offline in Buy Mode below.</div>';
  }
}

function openRentonLookupModal(initialQuery = '') {
  const modal = document.getElementById('renton-modal');
  const inp = document.getElementById('renton-search-input');
  if (!modal) return;
  modal.classList.remove('hidden');

  const q = String(initialQuery || '').trim();
  if (inp) {
    if (q) inp.value = q;
    inp.focus();
    inp.select();
  }
  if (q) {
    runLiveRentonQuery(q);
  } else if (!rentonLastQuery) {
    // Auto-load popular desks on first open so zero-labor browsing is instant
    if (inp) inp.value = 'desk';
    runLiveRentonQuery('desk');
  }
}

function initRentonLookupUI() {
  const btn = document.getElementById('btn-renton-lookup');
  if (btn) btn.onclick = () => openRentonLookupModal(state.searchQuery);

  const closeModal = () => document.getElementById('renton-modal')?.classList.add('hidden');
  document.getElementById('close-renton-modal')?.addEventListener('click', closeModal);
  document.getElementById('renton-done-btn')?.addEventListener('click', closeModal);
  document.getElementById('renton-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'renton-modal') closeModal();
  });

  const form = document.getElementById('renton-search-form');
  const inp = document.getElementById('renton-search-input');
  if (form && inp) {
    form.onsubmit = (e) => {
      e.preventDefault();
      runLiveRentonQuery(inp.value);
    };
  }

  document.querySelectorAll('#renton-quick-chips .renton-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const rq = chip.dataset.rq || '';
      if (inp) inp.value = rq;
      runLiveRentonQuery(rq);
    });
  });

  document.getElementById('renton-instock-only')?.addEventListener('change', () => {
    const q = inp?.value.trim() || rentonLastQuery;
    if (q) runLiveRentonQuery(q);
  });

  // Display sync timestamp & total built-in Renton catalog count in footer
  const foot = document.getElementById('renton-sync-foot');
  if (foot && RENTON_SYNC_META) {
    const syncDate = RENTON_SYNC_META.syncedAt ? new Date(RENTON_SYNC_META.syncedAt).toLocaleDateString() : 'live';
    foot.textContent = `Built-in catalog synced w/ Renton #488 (${IKEA_CATALOG.length} items · ${syncDate}) · Lookup queries live store inventory`;
  }
}

// ======================== RENDER LOOP ========================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate(now) {
  requestAnimationFrame(animate);

  if (cameraLerp) {
    camera.position.lerp(cameraLerp.pos, 0.14);
    controls.target.lerp(cameraLerp.target, 0.14);
    if (
      camera.position.distanceTo(cameraLerp.pos) < 0.025 &&
      controls.target.distanceTo(cameraLerp.target) < 0.025
    ) {
      camera.position.copy(cameraLerp.pos);
      controls.target.copy(cameraLerp.target);
      cameraLerp = null;
    }
  }

  controls.update();

  let anyPopping = false;
  for (const [, entry] of meshByUid) {
    if (entry.popStart !== null) {
      anyPopping = true;
      if (now < entry.popStart) continue;
      const t = Math.min(1, (now - entry.popStart) / 260);
      const overshoot = 1 + Math.sin(t * Math.PI) * 0.12;
      const s = t < 1 ? overshoot * (0.75 + 0.25 * t) : 1;
      entry.group.scale.set(s, s, s);
      if (t >= 1) {
        entry.group.scale.set(1, 1, 1);
        entry.popStart = null;
      }
    }
  }

  if (roomObj) {
    roomObj.updateWallVisibility(state.wallMode, camera.position, state.viewMode === 'fp');
  }

  renderActiveView(anyPopping);
  updateFloatingLabels();
}

// Boot!
initUI();
loadInitialState();
applyLightingMood();
if (hasWebGL) animate(performance.now());
