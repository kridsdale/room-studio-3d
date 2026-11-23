import * as THREE from 'three';
import { IN_TO_M, FINISH_SWATCHES } from './catalog.js';

function getSwatchColor(finishKey) {
  const sw = FINISH_SWATCHES[finishKey] || FINISH_SWATCHES.white;
  return new THREE.Color(sw.hex);
}

const woodTexCache = new Map();

function getWoodGrainTexture(hex) {
  if (woodTexCache.has(hex)) return woodTexCache.get(hex);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const cleanHex = String(hex || '#c9a679').replace('#', '');
  const r0 = parseInt(cleanHex.slice(0, 2), 16) || 201;
  const g0 = parseInt(cleanHex.slice(2, 4), 16) || 166;
  const b0 = parseInt(cleanHex.slice(4, 6), 16) || 121;
  ctx.fillStyle = `rgb(${r0},${g0},${b0})`;
  ctx.fillRect(0, 0, 256, 256);

  // Subtle vertical brushed oak/veneer grain streaks
  for (let i = 0; i < 160; i++) {
    const x = (i * 19.7 + (i % 7) * 3.1) % 256;
    const w = 1 + (i % 3);
    const delta = (i % 2 === 0 ? -1 : 1) * (5 + (i % 9));
    const r = Math.max(0, Math.min(255, r0 + delta));
    const g = Math.max(0, Math.min(255, g0 + Math.round(delta * 0.85)));
    const b = Math.max(0, Math.min(255, b0 + Math.round(delta * 0.7)));
    ctx.fillStyle = `rgba(${r},${g},${b},0.28)`;
    ctx.fillRect(x, 0, w, 256);
  }
  // Fine horizontal pores
  ctx.fillStyle = `rgba(${Math.max(0, r0 - 24)},${Math.max(0, g0 - 20)},${Math.max(0, b0 - 16)},0.12)`;
  for (let i = 0; i < 90; i++) {
    const x = (i * 37) % 256;
    const y = (i * 53) % 256;
    ctx.fillRect(x, y, 2, 10 + (i % 14));
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  woodTexCache.set(hex, tex);
  return tex;
}

function makeMaterial(finishKey, extra = {}) {
  const sw = FINISH_SWATCHES[finishKey] || FINISH_SWATCHES.white;
  const roughness = sw.fabric ? 0.88 : sw.metal ? 0.35 : sw.wood ? 0.56 : 0.44;
  const metalness = sw.metal ? 0.65 : 0.03;
  const map = sw.wood ? getWoodGrainTexture(sw.hex) : null;
  return new THREE.MeshStandardMaterial({
    color: map ? new THREE.Color('#ffffff') : getSwatchColor(finishKey),
    map,
    roughness,
    metalness,
    ...extra,
  });
}

function makeCabinetGlassMat() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xdbeaf0,
    roughness: 0.08,
    metalness: 0.06,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function createGeoRugTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 768;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e5dfd2';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const colors = ['#2b4c65', '#4c7591', '#8ba7b8', '#b89b66', '#8a4a3d', '#d8d2c5'];
  const cols = 6;
  const rows = 9;
  const cw = canvas.width / cols;
  const rh = canvas.height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw;
      const y = r * rh;
      ctx.fillStyle = colors[(r * 3 + c * 5) % colors.length];
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + cw, y);
      ctx.lineTo(x + cw / 2, y + rh);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = colors[(r * 2 + c * 7 + 2) % colors.length];
      ctx.beginPath();
      ctx.moveTo(x, y + rh);
      ctx.lineTo(x + cw, y + rh);
      ctx.lineTo(x + cw / 2, y);
      ctx.closePath();
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let cachedGeoRugTex = null;

function addBox(parent, w, h, d, mat, x = 0, y = 0, z = 0, cast = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

// Hardware knob / pull helper (solid oak cylinder, dark bronze round knob, knurled silver, or recessed finger pull)
function addCabinetHardware(parent, x, y, z, hwMode, defaultMode, mats) {
  const mode = !hwMode || hwMode === 'auto' ? defaultMode : hwMode;
  if (mode === 'none') return;
  if (mode === 'recessed') {
    addBox(parent, 0.011, 0.088, 0.005, mats.recessMat, x, y, z + 0.002, false);
    return;
  }
  if (mode === 'oak_knob') {
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.0095, 0.026, 12), mats.oakKnobMat);
    cyl.rotation.x = Math.PI / 2;
    cyl.position.set(x, y, z + 0.013);
    parent.add(cyl);
    return;
  }
  if (mode === 'silver_knob') {
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.021, 12), mats.silverMetal);
    cyl.rotation.x = Math.PI / 2;
    cyl.position.set(x, y, z + 0.0105);
    parent.add(cyl);
    return;
  }
  // dark_knob (IDANÄS turned dark bronze / matte black knob)
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.006, 0.014, 10), mats.darkMetal);
  stem.rotation.x = Math.PI / 2;
  stem.position.set(x, y, z + 0.007);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 10), mats.darkMetal);
  head.scale.set(1, 1, 0.72);
  head.position.set(x, y, z + 0.017);
  parent.add(stem, head);
}

// Dark-blue (or white) KUGGIS storage box with overlapping lid (Renton photo-2 & photo-5)
function addKuggisBox(parent, bw, bh, bd, x, y, z, colorHex = 0x263e57) {
  const boxMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.34, metalness: 0.04 });
  const lidMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.28, metalness: 0.05 });
  const lidH = Math.min(0.02, bh * 0.16);
  const bodyH = bh - lidH - 0.002;
  addBox(parent, bw - 0.006, bodyH, bd - 0.006, boxMat, x, y - lidH / 2, z, false);
  addBox(parent, bw, lidH, bd, lidMat, x, y + bh / 2 - lidH / 2, z, false);
  // Signature KUGGIS recessed thumb pull notch on front face
  const notchMat = new THREE.MeshStandardMaterial({ color: 0x162436, roughness: 0.7 });
  addBox(parent, Math.min(0.055, bw * 0.26), 0.012, 0.004, notchMat, x, y + bh * 0.12, z + bd / 2 - 0.001, false);
}

// Build a single framed / flush / shaker / fluted / glass door panel centered at (0,0,0) in local group
function buildDoorPanel(dw, dh, dt, doorMat, style, mats) {
  const g = new THREE.Group();
  const frameW = Math.min(0.048, dw * 0.18);
  const frameH = Math.min(0.048, dh * 0.12);
  const innerW = Math.max(0.02, dw - frameW * 2 - 0.002);
  const innerH = Math.max(0.02, dh - frameH * 2 - 0.002);

  if (style === 'glass' || style === 'bi_fold_glass') {
    // 4-sided perimeter rails + clear glass pane (strictly non-overlapping corners!)
    addBox(g, dw, frameH, dt, doorMat, 0, dh / 2 - frameH / 2, 0);
    addBox(g, dw, frameH, dt, doorMat, 0, -dh / 2 + frameH / 2, 0);
    addBox(g, frameW, innerH, dt, doorMat, -dw / 2 + frameW / 2, 0, 0);
    addBox(g, frameW, innerH, dt, doorMat, dw / 2 - frameW / 2, 0, 0);
    addBox(g, innerW, innerH, 0.005, mats.glassMat, 0, 0, 0, false);
    if (style === 'bi_fold_glass') {
      // Subtle center vertical stile & horizontal mullion bar for bi-fold look
      addBox(g, 0.016, innerH, dt * 0.75, doorMat, 0, 0, 0.001, false);
      addBox(g, innerW, 0.016, dt * 0.65, doorMat, 0, 0, -0.001, false);
    }
  } else if (style === 'shaker') {
    // Authentic recessed-panel Shaker door (outer stiles & rails + set-back center panel!)
    addBox(g, dw, frameH, dt, doorMat, 0, dh / 2 - frameH / 2, 0);
    addBox(g, dw, frameH, dt, doorMat, 0, -dh / 2 + frameH / 2, 0);
    addBox(g, frameW, innerH, dt, doorMat, -dw / 2 + frameW / 2, 0, 0);
    addBox(g, frameW, innerH, dt, doorMat, dw / 2 - frameW / 2, 0, 0);
    addBox(g, innerW + 0.002, innerH + 0.002, dt * 0.42, doorMat, 0, 0, -dt * 0.22);
  } else if (style === 'fluted') {
    // Back slab + crisp vertical ribbed wood slats across front face
    addBox(g, dw, dh, dt * 0.65, doorMat, 0, 0, -dt * 0.16);
    const ribCount = Math.max(5, Math.min(13, Math.round(dw / 0.032)));
    const pitch = (dw - 0.012) / ribCount;
    const ribW = pitch * 0.56;
    for (let i = 0; i < ribCount; i++) {
      const rx = -dw / 2 + 0.006 + (i + 0.5) * pitch;
      addBox(g, ribW, dh - 0.008, dt * 0.36, doorMat, rx, 0, dt * 0.36, false);
    }
  } else {
    // Clean flush slab door (TONSTAD / KALLAX flush wood veneer)
    addBox(g, dw, dh, dt, doorMat, 0, 0, 0);
  }
  return g;
}

// Mount a hinged door with true pivot on left ('left') or right ('right') edge so doorsOpen swings it outward!
function addHingedDoor(parent, dw, dh, dt, centerX, centerY, frontZ, hingeSide, openAngleRad, doorMat, style, hwMode, defaultHw, mats, knobYOffset = 0) {
  const pivot = new THREE.Group();
  const hingeX = hingeSide === 'left' ? centerX - dw / 2 : centerX + dw / 2;
  pivot.position.set(hingeX, centerY, frontZ);
  if (openAngleRad) {
    pivot.rotation.y = hingeSide === 'left' ? -openAngleRad : openAngleRad;
  }
  const localCx = hingeSide === 'left' ? dw / 2 : -dw / 2;
  const panel = buildDoorPanel(dw, dh, dt, doorMat, style, mats);
  panel.position.set(localCx, 0, 0);
  pivot.add(panel);

  const knobX = hingeSide === 'left' ? dw - Math.min(0.036, dw * 0.16) : -(dw - Math.min(0.036, dw * 0.16));
  addCabinetHardware(pivot, knobX, knobYOffset, dt / 2, hwMode, defaultHw, mats);
  parent.add(pivot);
  return pivot;
}

// Mount a dual-track sliding door pair (rear left track + front right track = zero z-fighting!)
function addSlidingDoorPair(parent, spanW, spanH, centerX, centerY, frontZ, doorMat, isGlass, doorsOpen, hwMode, mats) {
  const dt = 0.018;
  const doorW = spanW * 0.515; // slight authentic center overlap on separate tracks
  const doorH = spanH - 0.01;
  // Anodized track rails top & bottom
  addBox(parent, spanW, 0.008, 0.038, mats.trackMat, centerX, centerY - spanH / 2 + 0.004, frontZ - 0.012, false);
  addBox(parent, spanW, 0.008, 0.038, mats.trackMat, centerX, centerY + spanH / 2 - 0.004, frontZ - 0.012, false);

  const style = isGlass ? 'glass' : 'flush';
  // Left door on rear track
  const leftDoor = buildDoorPanel(doorW, doorH, dt, doorMat, style, mats);
  const leftX = centerX - spanW / 2 + doorW / 2 + 0.002;
  leftDoor.position.set(leftX, centerY, frontZ - 0.022);
  addCabinetHardware(leftDoor, -doorW / 2 + 0.024, 0, dt / 2, hwMode, 'recessed', mats);
  parent.add(leftDoor);

  // Right door on front track (slides left when doorsOpen!)
  const rightDoor = buildDoorPanel(doorW, doorH, dt, doorMat, style, mats);
  const slideShift = doorsOpen ? -(spanW - doorW) * 0.78 : 0;
  const rightX = centerX + spanW / 2 - doorW / 2 - 0.002 + slideShift;
  rightDoor.position.set(rightX, centerY, frontZ + 0.002);
  addCabinetHardware(rightDoor, doorW / 2 - 0.024, 0, dt / 2, hwMode, 'recessed', mats);
  parent.add(rightDoor);
}

// Add decorative styled books on a shelf
function addShelfBooks(parent, spanW, shelfTopY, shelfDepth, centerX, centerZ, seed, maxBooks = 7) {
  const palette = [0x3b5c78, 0x8a5443, 0xd4c9b2, 0x5b7561, 0x454952, 0xc99c57, 0x263e57];
  let bx = centerX - spanW / 2 + 0.028;
  for (let k = 0; k < maxBooks; k++) {
    const bw = 0.025 + ((k * 7 + seed) % 3) * 0.009;
    const bh = 0.165 + ((k * 5 + seed) % 4) * 0.022;
    const bd = Math.min(0.21, shelfDepth * 0.62);
    if (bx + bw > centerX + spanW / 2 - 0.03) break;
    const bMat = new THREE.MeshStandardMaterial({ color: palette[(k + seed) % palette.length], roughness: 0.78 });
    addBox(parent, bw, bh, bd, bMat, bx + bw / 2, shelfTopY + bh / 2 + 0.001, centerZ, false);
    bx += bw + 0.004;
  }
}

// Add stacked ceramic plates / bowls (Renton IDANÄS & TONSTAD display styling!)
function addDisplayBowls(parent, shelfTopY, cx, cz, variant = 0) {
  const darkBlueMat = new THREE.MeshStandardMaterial({ color: 0x243b52, roughness: 0.25, metalness: 0.1 });
  const creamMat = new THREE.MeshStandardMaterial({ color: 0xede9e0, roughness: 0.32 });
  const oakBowlMat = new THREE.MeshStandardMaterial({ color: 0xc29a68, roughness: 0.52 });
  if (variant === 0) {
    // Stacked dark-blue stoneware plates (IDANÄS photo-1/2)
    for (let i = 0; i < 3; i++) {
      const r = 0.115 - i * 0.014;
      const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.88, 0.014, 18), darkBlueMat);
      p.position.set(cx, shelfTopY + 0.008 + i * 0.015, cz);
      parent.add(p);
    }
  } else if (variant === 1) {
    // Cream sculptural ceramic vases (TONSTAD photo-7)
    const v = new THREE.Mesh(new THREE.SphereGeometry(0.068, 14, 12), creamMat);
    v.scale.set(1.1, 0.72, 1.1);
    v.position.set(cx, shelfTopY + 0.05, cz);
    const v2 = new THREE.Mesh(new THREE.SphereGeometry(0.054, 14, 12), creamMat);
    v2.scale.set(1.05, 0.75, 1.05);
    v2.position.set(cx, shelfTopY + 0.125, cz);
    parent.add(v, v2);
  } else {
    // Nested wooden salad bowls (TONSTAD photo-7/8)
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.068, 0.095, 18), oakBowlMat);
    b.position.set(cx, shelfTopY + 0.048, cz);
    parent.add(b);
  }
}

export function createFurnitureMesh(catalogEntry, finishKey, options = {}) {
  const {
    expanded = false,
    frontStyle = catalogEntry.defaultFrontStyle || null,
    frontFinish = null,
    hardware = 'auto',
    doorsOpen = false,
  } = options;
  const group = new THREE.Group();
  const w = catalogEntry.w * IN_TO_M;
  const d = (expanded && catalogEntry.expandedD ? catalogEntry.expandedD : catalogEntry.d) * IN_TO_M;
  const h = catalogEntry.h * IN_TO_M;

  const activeFinish = finishKey || catalogEntry.defaultFinish || 'white';
  const primaryMat = makeMaterial(activeFinish);
  const frontMat = frontFinish ? makeMaterial(frontFinish) : primaryMat;
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x242629, roughness: 0.38, metalness: 0.65 });
  const silverMetal = new THREE.MeshStandardMaterial({ color: 0xc2c7cc, roughness: 0.28, metalness: 0.78 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: 0.55 });
  const linenMat = new THREE.MeshStandardMaterial({ color: 0xf0ede6, roughness: 0.9 });
  const accentPillowMat = new THREE.MeshStandardMaterial({ color: 0xd9b84e, roughness: 0.88 });
  const woodAccent = new THREE.MeshStandardMaterial({ color: 0xc69e6b, roughness: 0.58 });
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.2, metalness: 0.3 });
  const pineInnerMat = new THREE.MeshStandardMaterial({ color: 0xd9b37c, roughness: 0.62 });
  const recessMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1d, roughness: 0.78 });
  const trackMat = new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.45, metalness: 0.35 });
  const glassMat = makeCabinetGlassMat();
  const oakKnobMat = makeMaterial(activeFinish === 'stainedOak' ? 'stainedOak' : 'oak');

  const cabMats = {
    darkMetal,
    silverMetal,
    whiteMat,
    pineInnerMat,
    recessMat,
    trackMat,
    glassMat,
    oakKnobMat,
  };

  const type = catalogEntry.meshType;

  if (type === 'retained_loveseat') {
    const armW = 7.8 * IN_TO_M;
    const armH = 23.5 * IN_TO_M;
    const seatH = 16.5 * IN_TO_M;
    const backT = 6.5 * IN_TO_M;
    const legH = 2.2 * IN_TO_M;
    const innerW = w - armW * 2 - 0.004;

    // Low dark feet
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addBox(group, 0.06, legH, 0.06, darkMetal, sx * (w / 2 - 0.07), legH / 2 + 0.001, sz * (d / 2 - 0.07));
      }
    }
    // Chunky signature armrests (outer left & right, clear of inner frame)
    addBox(group, armW, armH - legH, d, primaryMat, -w / 2 + armW / 2, legH + (armH - legH) / 2, 0);
    addBox(group, armW, armH - legH, d, primaryMat, w / 2 - armW / 2, legH + (armH - legH) / 2, 0);
    // Back frame strictly between armrests
    addBox(group, innerW, h * 0.78, backT, primaryMat, 0, legH + h * 0.39, -d / 2 + backT / 2);
    // Base frame strictly between armrests & in front of back frame
    const baseD = d - backT - 0.02;
    addBox(group, innerW, seatH * 0.48, baseD, primaryMat, 0, legH + seatH * 0.24, -d / 2 + backT + baseD / 2 + 0.002);
    // Plump seat cushion cleanly above base frame
    const cushionH = seatH * 0.45;
    const cushY = legH + seatH * 0.48 + 0.003 + cushionH / 2;
    addBox(group, innerW - 0.008, cushionH, baseD - 0.006, primaryMat, 0, cushY, -d / 2 + backT + baseD / 2 + 0.004);
    // Draped grey sherpa throw blanket (cleanly proud of cushion top & front!)
    const throwMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a3, roughness: 0.96 });
    const cushTopY = cushY + cushionH / 2;
    addBox(group, innerW - 0.04, 0.022, baseD - 0.03, throwMat, 0, cushTopY + 0.013, -d / 2 + backT + baseD / 2 + 0.015, false);
    addBox(group, innerW - 0.06, 0.16, 0.022, throwMat, 0, cushTopY - 0.08, d / 2 + 0.012, false);
    // Back pillow cushion cleanly in front of back frame
    const backCush = addBox(group, innerW - 0.04, h - seatH + 0.02, 0.17, primaryMat, 0, cushTopY + (h - seatH) / 2, -d / 2 + backT + 0.1);
    backCush.rotation.x = -0.12;
    // Subtle folded yellow/teal throw accent on right side (from IMG_3206)
    const accent = addBox(group, 0.24, 0.18, 0.16, accentPillowMat, w / 2 - armW - 0.14, cushTopY + 0.12, -0.05);
    accent.rotation.set(0.15, -0.25, 0.22);
  } else if (
    type === 'retained_wood_desk' ||
    type === 'retained_white_desk' ||
    type === 'ikea_desk' ||
    type === 'desk_42_monitor'
  ) {
    const topT = 0.032;
    const isWhite = type === 'retained_white_desk';
    const legMat = isWhite ? silverMetal : darkMetal;

    // Tabletop
    addBox(group, w, topT, d, primaryMat, 0, h - topT / 2, 0);
    // Standing T-frame legs (cleanly non-overlapping between feet, columns, and tabletop!)
    const footL = d * 0.84;
    const footH = 0.025;
    const colH = h - topT - footH - 0.002;
    for (const sx of [-1, 1]) {
      const lx = sx * (w / 2 - 0.14);
      addBox(group, 0.06, footH, footL, legMat, lx, footH / 2 + 0.001, 0);
      addBox(group, 0.055, colH, 0.07, legMat, lx, footH + 0.001 + colH / 2, -0.02);
    }
    // Under-desk crossbar strictly between leg columns
    addBox(group, w - 0.34, 0.04, 0.04, legMat, 0, h - topT - 0.024, -0.02);

    if (type === 'retained_wood_desk') {
      // Monitor riser + 27" monitor + open silver laptop (matches IMG_3201/3204!)
      addBox(group, 0.56, 0.08, 0.22, darkMetal, 0, h + 0.042, -d / 2 + 0.16);
      addBox(group, 0.08, 0.14, 0.03, darkMetal, 0, h + 0.152, -d / 2 + 0.14);
      addBox(group, 0.64, 0.38, 0.025, screenMat, 0, h + 0.32, -d / 2 + 0.175);
      // Silver laptop cleanly above tabletop
      addBox(group, 0.34, 0.012, 0.23, silverMetal, -0.22, h + 0.008, 0.1);
    } else if (type === 'retained_white_desk') {
      // 34" ultrawide curved-look monitor + turquoise lamp (matches IMG_3202!)
      addBox(group, 0.08, 0.14, 0.03, darkMetal, 0.06, h + 0.072, -d / 2 + 0.13);
      addBox(group, 0.8, 0.35, 0.028, screenMat, 0.06, h + 0.29, -d / 2 + 0.165);
      const tealMat = new THREE.MeshStandardMaterial({ color: 0x3f8f99, roughness: 0.35 });
      const lampBase = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 12), tealMat);
      lampBase.position.set(-w / 2 + 0.16, h + 0.112, -0.02);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.14, 0.2, 16), linenMat);
      shade.position.set(-w / 2 + 0.16, h + 0.32, -0.02);
      group.add(lampBase, shade);
    } else if (type === 'desk_42_monitor') {
      // True-scale 42" 16:9 4K display (36.7" W x 21.3" H = 0.932m x 0.541m!) + heavy VESA stand
      const monW = 36.7 * IN_TO_M;
      const monH = 21.3 * IN_TO_M;
      const monZ = -d / 2 + 0.14;
      // Heavy pedestal base & arm column
      addBox(group, 0.3, 0.016, 0.22, darkMetal, 0, h + 0.01, monZ + 0.02);
      addBox(group, 0.07, 0.34, 0.045, darkMetal, 0, h + 0.188, monZ - 0.025);
      // Slim dark bezel chassis
      addBox(group, monW + 0.018, monH + 0.018, 0.026, darkMetal, 0, h + 0.095 + monH / 2, monZ + 0.015);
      // Subtle glowing 4K display face cleanly proud of bezel front (zero z-fighting!)
      const glowScreenMat = new THREE.MeshStandardMaterial({
        color: 0x162230,
        emissive: 0x18324a,
        emissiveIntensity: 0.65,
        roughness: 0.16,
        metalness: 0.25,
      });
      addBox(group, monW, monH, 0.004, glowScreenMat, 0, h + 0.095 + monH / 2, monZ + 0.032, false);
      // Subtle tiled-window accent bars on screen front (cleanly offset + polygonOffset!)
      const uiBarMat = new THREE.MeshBasicMaterial({
        color: 0x3b82f6,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      const uiCodeMat = new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      addBox(group, monW * 0.45, monH * 0.72, 0.002, uiCodeMat, -monW * 0.24, h + 0.095 + monH / 2, monZ + 0.037, false);
      addBox(group, monW * 0.43, monH * 0.34, 0.002, uiCodeMat, monW * 0.24, h + 0.095 + monH * 0.68, monZ + 0.037, false);
      addBox(group, monW * 0.43, monH * 0.32, 0.002, uiBarMat, monW * 0.24, h + 0.095 + monH * 0.3, monZ + 0.037, false);
      // Desk mat + mechanical keyboard + mouse cleanly stacked with zero coplanarity
      const matSurf = new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.9 });
      addBox(group, 0.82, 0.005, 0.34, matSurf, 0, h + 0.0045, 0.14, false);
      addBox(group, 0.36, 0.018, 0.13, darkMetal, -0.06, h + 0.017, 0.16);
      addBox(group, 0.065, 0.022, 0.11, darkMetal, 0.22, h + 0.019, 0.16);
    }
  } else if (type === 'daybed') {
    const baseD = catalogEntry.d * IN_TO_M;
    const frameH = 14 * IN_TO_M;
    const railT = 0.045;
    // Back panel (full width)
    addBox(group, w, h, railT, primaryMat, 0, h / 2 + 0.001, -d / 2 + railT / 2);
    // Side arms cleanly in front of back panel (zero corner overlap!)
    const armD = baseD - railT - 0.002;
    addBox(group, railT, h * 0.9, armD, primaryMat, -w / 2 + railT / 2, h * 0.45 + 0.001, -d / 2 + railT + armD / 2 + 0.001);
    addBox(group, railT, h * 0.9, armD, primaryMat, w / 2 - railT / 2, h * 0.45 + 0.001, -d / 2 + railT + armD / 2 + 0.001);
    // Base + 3 drawers strictly between side arms & in front of back panel
    const innerW = w - railT * 2 - 0.004;
    const innerD = d - railT - 0.004;
    addBox(group, innerW, frameH, innerD, primaryMat, 0, frameH / 2 + 0.001, -d / 2 + railT + innerD / 2 + 0.002);
    const drawerW = (innerW - 0.06) / 3;
    for (let i = -1; i <= 1; i++) {
      addBox(group, drawerW - 0.015, frameH - 0.07, 0.016, primaryMat, i * drawerW, frameH / 2 + 0.001, d / 2 + 0.01);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), darkMetal);
      knob.position.set(i * drawerW, frameH / 2 + 0.02, d / 2 + 0.026);
      group.add(knob);
    }
    // Mattress(es) cleanly above base frame
    const mattH = 6.5 * IN_TO_M;
    addBox(group, innerW - 0.02, mattH, innerD - 0.025, linenMat, 0, frameH + 0.003 + mattH / 2, -d / 2 + railT + innerD / 2 + 0.002);
    // Throw cushions along back
    const pillowMat = new THREE.MeshStandardMaterial({ color: 0x7a8e94, roughness: 0.9 });
    for (const px of [-w * 0.28, 0, w * 0.28]) {
      const p = addBox(group, 0.44, 0.34, 0.14, px === 0 ? accentPillowMat : pillowMat, px, frameH + mattH + 0.175, -d / 2 + 0.15);
      p.rotation.x = -0.18;
    }
  } else if (type === 'bed' || type === 'slat_bed') {
    const sideH = 14 * IN_TO_M;
    const mattH = 9 * IN_TO_M;
    // Headboard
    addBox(group, w, h, 0.055, primaryMat, 0, h / 2 + 0.001, -d / 2 + 0.028);
    // Low footboard
    addBox(group, w, sideH, 0.04, primaryMat, 0, sideH / 2 + 0.001, d / 2 - 0.02);
    // Side rails strictly between headboard & footboard
    const railD = d - 0.098;
    addBox(group, 0.04, sideH * 0.75, railD, primaryMat, -w / 2 + 0.02, sideH * 0.52, 0.007);
    addBox(group, 0.04, sideH * 0.75, railD, primaryMat, w / 2 - 0.02, sideH * 0.52, 0.007);
    // Mattress
    addBox(group, w - 0.09, mattH, d - 0.11, whiteMat, 0, sideH * 0.65 + mattH / 2, 0.01);
    // Folded duvet blanket covering lower 65% (cleanly proud of mattress top & sides!)
    const duvetMat = new THREE.MeshStandardMaterial({ color: 0xd9dfe2, roughness: 0.92 });
    addBox(group, w - 0.05, mattH * 0.42, d * 0.64, duvetMat, 0, sideH * 0.65 + mattH + 0.012, d * 0.15);
    // Pillows
    const pCount = w > 1.25 ? 2 : 1;
    const pOffsets = pCount === 2 ? [-w * 0.22, w * 0.22] : [0];
    for (const px of pOffsets) {
      const p = addBox(group, Math.min(0.62, w * 0.38), 0.14, 0.42, linenMat, px, sideH * 0.65 + mattH + 0.08, -d / 2 + 0.3);
      p.rotation.x = 0.14;
    }
  } else if (type === 'kura_bed') {
    const post = 0.055;
    // 4 corner pine posts
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addBox(group, post, h, post, primaryMat, sx * (w / 2 - post / 2), h / 2 + 0.001, sz * (d / 2 - post / 2));
      }
    }
    // Top & bottom pine perimeter beams strictly BETWEEN corner posts (zero corner overlap!)
    const innerSpanW = w - post * 2 - 0.002;
    const innerSpanD = d - post * 2 - 0.002;
    for (const py of [0.14, h - 0.04]) {
      addBox(group, innerSpanW, 0.055, post, primaryMat, 0, py, -d / 2 + post / 2);
      addBox(group, innerSpanW, 0.055, post, primaryMat, 0, py, d / 2 - post / 2);
      addBox(group, post, 0.055, innerSpanD, primaryMat, -w / 2 + post / 2, py, 0);
      addBox(group, post, 0.055, innerSpanD, primaryMat, w / 2 - post / 2, py, 0);
    }
    // White KURA side panels strictly between posts
    addBox(group, innerSpanW - 0.004, h * 0.55, 0.02, whiteMat, 0, h * 0.48, -d / 2 + post / 2);
    addBox(group, innerSpanW - 0.004, h * 0.55, 0.02, whiteMat, 0, h * 0.48, d / 2 - post / 2);
    addBox(group, 0.02, h * 0.55, innerSpanD - 0.004, whiteMat, -w / 2 + post / 2, h * 0.48, 0);
    // Mattress low + quilt cleanly above mattress
    addBox(group, w - 0.12, 0.17, d - 0.12, linenMat, 0, 0.25, 0);
    const quiltMat = new THREE.MeshStandardMaterial({ color: 0x7c9cb0, roughness: 0.9 });
    addBox(group, w - 0.11, 0.05, d * 0.62, quiltMat, 0, 0.362, d * 0.14);
  } else if (type === 'sofa') {
    const armW = 0.22;
    const seatH = 0.42;
    const innerW = w - armW * 2 - 0.004;
    addBox(group, armW, 0.56, d, primaryMat, -w / 2 + armW / 2, 0.281, 0);
    addBox(group, armW, 0.56, d, primaryMat, w / 2 - armW / 2, 0.281, 0);
    addBox(group, innerW, h * 0.72, 0.18, primaryMat, 0, h * 0.36 + 0.001, -d / 2 + 0.09);
    const baseD = d - 0.184;
    addBox(group, innerW, 0.26, baseD, primaryMat, 0, 0.132, -d / 2 + 0.182 + baseD / 2);
    const cw = (innerW - 0.025) / 2;
    for (const sx of [-1, 1]) {
      addBox(group, cw, 0.16, baseD - 0.01, primaryMat, sx * (cw / 2 + 0.006), 0.264 + 0.08, -d / 2 + 0.184 + baseD / 2);
      const bc = addBox(group, cw, h - seatH + 0.04, 0.17, primaryMat, sx * (cw / 2 + 0.006), seatH + (h - seatH) / 2 + 0.01, -d / 2 + 0.25);
      bc.rotation.x = -0.12;
    }
  } else if (type === 'sectional') {
    const armW = 0.16;
    const backT = 0.18;
    const chaiseW = w * 0.37;
    const sofaD = 0.92;
    const seatH = 0.42;
    const innerW = w - armW * 2 - 0.004;
    // Outer armrests (cleanly non-overlapping with backrest & seats!)
    addBox(group, armW, 0.62, sofaD, primaryMat, -w / 2 + armW / 2, 0.311, -d / 2 + sofaD / 2);
    addBox(group, armW, 0.62, d * 0.7, primaryMat, w / 2 - armW / 2, 0.311, -d / 2 + d * 0.35);
    // Backrest strictly between armrests
    addBox(group, innerW, h, backT, primaryMat, 0, h / 2 + 0.001, -d / 2 + backT / 2);
    // Main sofa seat body strictly between armrests & in front of backrest
    const seatD = sofaD - backT - 0.004;
    addBox(group, innerW, seatH, seatD, primaryMat, 0, seatH / 2 + 0.001, -d / 2 + backT + seatD / 2 + 0.002);
    // Chaise extension cleanly abutting front of main body on right side (inside right arm!)
    const chaiseExtD = d - sofaD - 0.004;
    const chaiseSeatW = chaiseW - armW - 0.002;
    addBox(group, chaiseSeatW, seatH, chaiseExtD, primaryMat, w / 2 - armW - chaiseSeatW / 2 - 0.002, seatH / 2 + 0.001, -d / 2 + sofaD + chaiseExtD / 2 + 0.002);
    // 3 plush back cushions
    for (let i = -1; i <= 1; i++) {
      const bc = addBox(group, (innerW - 0.08) / 3, 0.38, 0.16, primaryMat, i * ((innerW - 0.04) / 3), seatH + 0.195, -d / 2 + backT + 0.09);
      bc.rotation.x = -0.14;
    }
  } else if (type === 'poang') {
    // Bentwood birch side frames + angled cushion
    for (const sx of [-1, 1]) {
      const fx = sx * (w / 2 - 0.03);
      addBox(group, 0.045, 0.035, d * 0.85, woodAccent, fx, 0.02, 0);
      addBox(group, 0.045, 0.5, 0.04, woodAccent, fx, 0.29, d * 0.36);
      const arm = addBox(group, 0.045, 0.035, d * 0.72, woodAccent, fx, 0.56, 0.02);
      arm.rotation.x = 0.08;
    }
    const seat = addBox(group, w - 0.11, 0.08, d * 0.62, primaryMat, 0, 0.38, 0.06);
    seat.rotation.x = -0.18;
    const back = addBox(group, w - 0.11, h * 0.66, 0.08, primaryMat, 0, 0.68, -d * 0.26);
    back.rotation.x = -0.3;
    const head = addBox(group, w - 0.14, 0.16, 0.1, primaryMat, 0, h - 0.1, -d * 0.38);
    head.rotation.x = -0.25;
  } else if (type === 'wingchair') {
    const legH = 0.18;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.015, legH, 8), woodAccent);
        leg.position.set(sx * (w * 0.36), legH / 2 + 0.001, sz * (d * 0.36));
        group.add(leg);
      }
    }
    const innerSeatW = w - 0.34;
    addBox(group, innerSeatW, 0.26, d * 0.82, primaryMat, 0, legH + 0.13, 0.02);
    addBox(group, 0.15, 0.42, d * 0.78, primaryMat, -w / 2 + 0.09, legH + 0.22, 0.04);
    addBox(group, 0.15, 0.42, d * 0.78, primaryMat, w / 2 - 0.09, legH + 0.22, 0.04);
    const back = addBox(group, w * 0.74, h - legH - 0.12, 0.16, primaryMat, 0, legH + (h - legH) / 2, -d * 0.34);
    back.rotation.x = -0.14;
    // Signature wings cleanly flanking backrest
    addBox(group, 0.08, 0.44, 0.22, primaryMat, -w * 0.39, h - 0.26, -d * 0.22);
    addBox(group, 0.08, 0.44, 0.22, primaryMat, w * 0.39, h - 0.26, -d * 0.22);
  } else if (type === 'office_chair') {
    // 5-star caster base radiating cleanly from a central hub (zero center spoke overlap!)
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.042, 0.036, 12), darkMetal);
    hub.position.set(0, 0.056, 0);
    group.add(hub);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spoke = addBox(group, 0.036, 0.028, 0.23, darkMetal, Math.sin(a) * 0.155, 0.055, Math.cos(a) * 0.155);
      spoke.rotation.y = a;
    }
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.36, 12), darkMetal);
    cyl.position.set(0, 0.254, 0);
    group.add(cyl);
    // Seat & tall mesh backrest
    addBox(group, w * 0.78, 0.08, d * 0.8, primaryMat, 0, 0.46, 0.02);
    const back = addBox(group, w * 0.74, h - 0.5, 0.055, primaryMat, 0, 0.48 + (h - 0.5) / 2, -d * 0.34);
    back.rotation.x = -0.1;
    // Armrests
    for (const sx of [-1, 1]) {
      addBox(group, 0.04, 0.2, 0.04, darkMetal, sx * (w * 0.42), 0.555, -0.02);
      addBox(group, 0.06, 0.03, 0.28, darkMetal, sx * (w * 0.42), 0.672, 0.02);
    }
  } else if (type === 'tonstad_cabinet') {
    // Authentic TONSTAD architectural bookcase, sliding glass/solid cabinet, hinged base, or 4-drawer dresser
    const style = frontStyle || catalogEntry.defaultFrontStyle || 'sliding_glass';
    const bays = catalogEntry.bays || (w > 1.35 ? 2 : 1);
    const t = 0.026; // thick brushed veneer outer shell
    const plinthH = 0.068;
    const bodyH = h - plinthH - t;
    const innerW = w - t * 2 - 0.002;
    const backT = 0.014;
    const innerD = d - backT - 0.036;

    // Recessed plinth toe-kick base
    addBox(group, w - 0.016, plinthH, d - 0.032, primaryMat, 0, plinthH / 2 + 0.001, -0.006);
    // Thick bottom deck & top cap
    addBox(group, w, t, d, primaryMat, 0, plinthH + t / 2, 0);
    addBox(group, w, t, d, primaryMat, 0, h - t / 2, 0);
    // Outer vertical side panels strictly between bottom deck & top cap
    const sideH = h - plinthH - t * 2 - 0.002;
    const sideCy = plinthH + t + sideH / 2;
    addBox(group, t, sideH, d, primaryMat, -w / 2 + t / 2, sideCy, 0);
    addBox(group, t, sideH, d, primaryMat, w / 2 - t / 2, sideCy, 0);
    // Full backboard strictly inside carcass
    addBox(group, innerW, sideH - 0.002, backT, primaryMat, 0, sideCy, -d / 2 + backT / 2 + 0.002);
    // Center vertical divider for 2-bay (64") double credenza
    if (bays === 2) {
      addBox(group, t * 0.9, sideH - 0.004, d - backT - 0.024, primaryMat, 0, sideCy, 0.002);
    }

    // Interior shelves & Renton-authentic contents (books, ceramic bowls, stacked dark-blue KUGGIS boxes!)
    const shelfCount = h > 1.7 ? 5 : h > 1.05 ? 2 : 1;
    if (style !== 'drawers_4') {
      for (let s = 1; s <= shelfCount; s++) {
        const sy = plinthH + t + (s / (shelfCount + 1)) * sideH;
        const shelfZ = -d / 2 + backT + innerD / 2 + 0.004;
        addBox(group, innerW - 0.004, 0.02, innerD, primaryMat, 0, sy, shelfZ);
      }
      // Populate interior props so glass doors & open-door peeks look rich and lived-in
      const bayW = innerW / bays;
      for (let b = 0; b < bays; b++) {
        const bayCx = bays === 1 ? 0 : (b === 0 ? -innerW / 4 : innerW / 4);
        if (h > 1.7) {
          // Tall bookcase shelves with curated books + dark-blue KUGGIS box on lower shelf
          for (let s = 1; s <= 4; s++) {
            const sy = plinthH + t + (s / (shelfCount + 1)) * sideH + 0.01;
            addShelfBooks(group, bayW - 0.04, sy, innerD, bayCx, -0.01, s * 3 + b, 8);
          }
          addKuggisBox(group, Math.min(0.32, bayW * 0.42), 0.145, Math.min(0.28, innerD * 0.8), bayCx - bayW * 0.2, plinthH + t + 0.075, 0.0);
          addKuggisBox(group, Math.min(0.32, bayW * 0.42), 0.145, Math.min(0.28, innerD * 0.8), bayCx + bayW * 0.2, plinthH + t + 0.075, 0.0);
        } else if (h > 1.05) {
          // Mid-height display cabinet (47¼" H) with stoneware & sculptural bowls
          const sy1 = plinthH + t + (1 / 3) * sideH + 0.01;
          const sy2 = plinthH + t + (2 / 3) * sideH + 0.01;
          addDisplayBowls(group, sy1, bayCx - bayW * 0.22, -0.01, 0);
          addDisplayBowls(group, sy1, bayCx + bayW * 0.2, -0.01, 2);
          addDisplayBowls(group, sy2, bayCx - bayW * 0.18, -0.01, 1);
          addShelfBooks(group, bayW * 0.44, sy2, innerD, bayCx + bayW * 0.2, -0.01, 5, 5);
        } else {
          // Lower base cabinet (35⅜" H): dark-blue KUGGIS boxes stacked on bottom & shelf (exact Renton photo-5!)
          const sy1 = plinthH + t + 0.002;
          const sy2 = plinthH + t + sideH * 0.5 + 0.012;
          const kw = Math.min(0.28, bayW * 0.4);
          const kd = Math.min(0.32, innerD * 0.78);
          addKuggisBox(group, kw, 0.14, kd, bayCx - bayW * 0.22, sy1 + 0.071, 0.01);
          addKuggisBox(group, kw, 0.14, kd, bayCx + bayW * 0.22, sy1 + 0.071, 0.01);
          addKuggisBox(group, kw, 0.14, kd, bayCx - bayW * 0.22, sy2 + 0.071, 0.01);
        }
      }
    }

    // Swappable Front Panels / Doors / Drawers
    const frontZ = d / 2 - 0.012;
    const baySpanW = (innerW - (bays === 2 ? t : 0)) / bays;

    if (style === 'sliding_glass' || style === 'sliding_solid') {
      for (let b = 0; b < bays; b++) {
        const bayCx = bays === 1 ? 0 : (b === 0 ? -innerW / 4 - t * 0.25 : innerW / 4 + t * 0.25);
        addSlidingDoorPair(
          group,
          baySpanW - 0.004,
          sideH - 0.004,
          bayCx,
          sideCy,
          frontZ,
          frontMat,
          style === 'sliding_glass',
          doorsOpen,
          hardware,
          cabMats
        );
      }
    } else if (style === 'hinged_doors' || style === 'shaker_doors' || style === 'fluted_doors') {
      const panelStyle = style === 'shaker_doors' ? 'shaker' : style === 'fluted_doors' ? 'fluted' : 'flush';
      const openRad = doorsOpen ? 1.32 : 0; // ~76 deg outward swing
      for (let b = 0; b < bays; b++) {
        const bayCx = bays === 1 ? 0 : (b === 0 ? -innerW / 4 - t * 0.25 : innerW / 4 + t * 0.25);
        const doorW = baySpanW / 2 - 0.005;
        addHingedDoor(
          group, doorW, sideH - 0.008, 0.018,
          bayCx - doorW / 2 - 0.002, sideCy, frontZ,
          'left', openRad, frontMat, panelStyle, hardware, 'oak_knob', cabMats, 0
        );
        addHingedDoor(
          group, doorW, sideH - 0.008, 0.018,
          bayCx + doorW / 2 + 0.002, sideCy, frontZ,
          'right', openRad, frontMat, panelStyle, hardware, 'oak_knob', cabMats, 0
        );
      }
    } else if (style === 'drawers_4') {
      const nDrawers = 4;
      const dh = (sideH - 0.016) / nDrawers;
      for (let b = 0; b < bays; b++) {
        const bayCx = bays === 1 ? 0 : (b === 0 ? -innerW / 4 - t * 0.25 : innerW / 4 + t * 0.25);
        for (let r = 0; r < nDrawers; r++) {
          const pullOut = doorsOpen && r === 2 ? 0.22 : 0;
          const cy = plinthH + t + 0.008 + (r + 0.5) * dh;
          const dw = baySpanW - 0.008;
          // Recessed dark shadow strip between drawers
          if (r > 0) {
            addBox(group, dw, 0.005, 0.01, recessMat, bayCx, plinthH + t + 0.008 + r * dh, frontZ - 0.006, false);
          }
          // Drawer front
          addBox(group, dw, dh - 0.008, 0.018, frontMat, bayCx, cy, frontZ + pullOut);
          // Interior drawer box visible when pulled out
          if (pullOut > 0.01) {
            const boxD = Math.min(d - 0.06, 0.36);
            const boxH = dh - 0.036;
            const bz = frontZ + pullOut - boxD / 2 - 0.01;
            addBox(group, dw - 0.03, 0.012, boxD, whiteMat, bayCx, cy - boxH / 2 + 0.006, bz, false);
            addBox(group, 0.014, boxH, boxD, pineInnerMat, bayCx - dw / 2 + 0.022, cy, bz, false);
            addBox(group, 0.014, boxH, boxD, pineInnerMat, bayCx + dw / 2 - 0.022, cy, bz, false);
            addBox(group, dw - 0.04, boxH, 0.014, pineInnerMat, bayCx, cy, bz - boxD / 2 + 0.007, false);
          }
          // Hardware (recessed top groove by default, or dual knobs if chosen)
          if (hardware === 'auto' || hardware === 'recessed') {
            addBox(group, Math.min(0.18, dw * 0.34), 0.012, 0.006, recessMat, bayCx, cy + dh * 0.34, frontZ + pullOut + 0.01, false);
          } else {
            addCabinetHardware(group, bayCx - dw * 0.26, cy, frontZ + pullOut + 0.009, hardware, 'oak_knob', cabMats);
            addCabinetHardware(group, bayCx + dw * 0.26, cy, frontZ + pullOut + 0.009, hardware, 'oak_knob', cabMats);
          }
        }
      }
    } else if (style === 'glass_top_drawers_bottom') {
      // Hybrid: lower 42% = 2 drawers, upper 58% = sliding glass doors!
      const splitY = plinthH + t + sideH * 0.42;
      addBox(group, innerW - 0.002, 0.022, d - backT - 0.02, primaryMat, 0, splitY, 0);
      const lowH = sideH * 0.42 - 0.014;
      const topH = sideH * 0.58 - 0.014;
      const dh = lowH / 2;
      for (let b = 0; b < bays; b++) {
        const bayCx = bays === 1 ? 0 : (b === 0 ? -innerW / 4 - t * 0.25 : innerW / 4 + t * 0.25);
        for (let r = 0; r < 2; r++) {
          const pullOut = doorsOpen && r === 1 ? 0.2 : 0;
          const cy = plinthH + t + (r + 0.5) * dh;
          const dw = baySpanW - 0.008;
          addBox(group, dw, dh - 0.008, 0.018, frontMat, bayCx, cy, frontZ + pullOut);
          addCabinetHardware(group, bayCx - dw * 0.24, cy, frontZ + pullOut + 0.009, hardware, 'oak_knob', cabMats);
          addCabinetHardware(group, bayCx + dw * 0.24, cy, frontZ + pullOut + 0.009, hardware, 'oak_knob', cabMats);
        }
        addSlidingDoorPair(
          group, baySpanW - 0.004, topH, bayCx, splitY + 0.011 + topH / 2, frontZ, frontMat, true, doorsOpen, hardware, cabMats
        );
      }
    }
    // else 'open_shelves': open bookcase!
  } else if (type === 'tonstad_hutch') {
    // Stacked TONSTAD Storage Combination (exact Renton $579 single & $838 asymmetric double hutch!)
    // Authentic stepped depth: lower 18⅝" D base (35⅜" H) + upper 14⅝" D hutch (43½" H) flush at rear!
    const style = frontStyle || catalogEntry.defaultFrontStyle || 'glass_over_doors';
    const bays = catalogEntry.bays || (w > 1.35 ? 2 : 1);
    const t = 0.026;
    const plinthH = 0.068;
    const baseH = 35.4 * IN_TO_M;
    const upperH = h - baseH;
    const upperD = Math.min(d - 0.08, 14.6 * IN_TO_M);
    const upperZ = -d / 2 + upperD / 2; // flush against back wall, leaving 4" oak counter ledge in front!

    // === LOWER BASE CABINET (full width w, full depth d, height baseH) ===
    const innerW = w - t * 2 - 0.002;
    const baseSideH = baseH - plinthH - t * 2 - 0.002;
    const baseSideCy = plinthH + t + baseSideH / 2;
    addBox(group, w - 0.016, plinthH, d - 0.032, primaryMat, 0, plinthH / 2 + 0.001, -0.006);
    addBox(group, w, t, d, primaryMat, 0, plinthH + t / 2, 0);
    addBox(group, w, t, d, primaryMat, 0, baseH - t / 2, 0);
    addBox(group, t, baseSideH, d, primaryMat, -w / 2 + t / 2, baseSideCy, 0);
    addBox(group, t, baseSideH, d, primaryMat, w / 2 - t / 2, baseSideCy, 0);
    addBox(group, innerW, baseSideH - 0.002, 0.014, primaryMat, 0, baseSideCy, -d / 2 + 0.009);
    if (bays === 2) {
      addBox(group, t * 0.9, baseSideH - 0.004, d - 0.036, primaryMat, 0, baseSideCy, 0.002);
    }

    const baseBayW = (innerW - (bays === 2 ? t : 0)) / bays;
    const baseFrontZ = d / 2 - 0.012;
    const baseIsDrawers = style === 'glass_over_drawers' || style === 'open_over_drawers';

    // Interior lower shelf + KUGGIS boxes
    if (!baseIsDrawers) {
      addBox(group, innerW - 0.004, 0.02, d - 0.056, primaryMat, 0, baseSideCy, -0.004);
      for (let b = 0; b < bays; b++) {
        const bayCx = bays === 1 ? 0 : (b === 0 ? -innerW / 4 - t * 0.25 : innerW / 4 + t * 0.25);
        addKuggisBox(group, Math.min(0.28, baseBayW * 0.38), 0.14, 0.3, bayCx - baseBayW * 0.22, plinthH + t + 0.072, 0.01);
        addKuggisBox(group, Math.min(0.28, baseBayW * 0.38), 0.14, 0.3, bayCx + baseBayW * 0.22, plinthH + t + 0.072, 0.01);
      }
      const openRad = doorsOpen ? 1.32 : 0;
      for (let b = 0; b < bays; b++) {
        const bayCx = bays === 1 ? 0 : (b === 0 ? -innerW / 4 - t * 0.25 : innerW / 4 + t * 0.25);
        const doorW = baseBayW / 2 - 0.005;
        addHingedDoor(
          group, doorW, baseSideH - 0.008, 0.018,
          bayCx - doorW / 2 - 0.002, baseSideCy, baseFrontZ,
          'left', openRad, frontMat, 'flush', hardware, 'oak_knob', cabMats, 0
        );
        addHingedDoor(
          group, doorW, baseSideH - 0.008, 0.018,
          bayCx + doorW / 2 + 0.002, baseSideCy, baseFrontZ,
          'right', openRad, frontMat, 'flush', hardware, 'oak_knob', cabMats, 0
        );
      }
    } else {
      const dh = (baseSideH - 0.016) / 4;
      for (let b = 0; b < bays; b++) {
        const bayCx = bays === 1 ? 0 : (b === 0 ? -innerW / 4 - t * 0.25 : innerW / 4 + t * 0.25);
        for (let r = 0; r < 4; r++) {
          const pullOut = doorsOpen && r === 2 ? 0.22 : 0;
          const cy = plinthH + t + 0.008 + (r + 0.5) * dh;
          const dw = baseBayW - 0.008;
          addBox(group, dw, dh - 0.008, 0.018, frontMat, bayCx, cy, baseFrontZ + pullOut);
          if (hardware === 'auto' || hardware === 'recessed') {
            addBox(group, Math.min(0.18, dw * 0.34), 0.012, 0.006, recessMat, bayCx, cy + dh * 0.34, baseFrontZ + pullOut + 0.01, false);
          } else {
            addCabinetHardware(group, bayCx - dw * 0.25, cy, baseFrontZ + pullOut + 0.009, hardware, 'oak_knob', cabMats);
            addCabinetHardware(group, bayCx + dw * 0.25, cy, baseFrontZ + pullOut + 0.009, hardware, 'oak_knob', cabMats);
          }
        }
      }
    }

    // === UPPER HUTCH SECTION (sits cleanly on top of baseH, flush at rear!) ===
    const asymLeftOnly = style === 'asymmetric_glass_left' && bays === 2;
    const upperW = asymLeftOnly ? w / 2 : w;
    const upperCx = asymLeftOnly ? -w / 4 : 0;
    const upperBays = asymLeftOnly ? 1 : bays;
    const uInnerW = upperW - t * 2 - 0.002;
    const uSideH = upperH - t * 2 - 0.004;
    const uBaseY = baseH + 0.002;
    const uSideCy = uBaseY + t + uSideH / 2;

    addBox(group, upperW, t, upperD, primaryMat, upperCx, uBaseY + t / 2, upperZ);
    addBox(group, upperW, t, upperD, primaryMat, upperCx, h - t / 2, upperZ);
    addBox(group, t, uSideH, upperD, primaryMat, upperCx - upperW / 2 + t / 2, uSideCy, upperZ);
    addBox(group, t, uSideH, upperD, primaryMat, upperCx + upperW / 2 - t / 2, uSideCy, upperZ);
    addBox(group, uInnerW, uSideH - 0.002, 0.014, primaryMat, upperCx, uSideCy, -d / 2 + 0.009);
    if (upperBays === 2) {
      addBox(group, t * 0.9, uSideH - 0.004, upperD - 0.036, primaryMat, upperCx, uSideCy, upperZ + 0.002);
    }

    // 2 upper interior display shelves + Renton stoneware/vases/books!
    const uShelfD = upperD - 0.05;
    for (let s = 1; s <= 2; s++) {
      const sy = uBaseY + t + (s / 3) * uSideH;
      addBox(group, uInnerW - 0.004, 0.02, uShelfD, primaryMat, upperCx, sy, upperZ - 0.004);
    }
    const uBaySpanW = (uInnerW - (upperBays === 2 ? t : 0)) / upperBays;
    for (let b = 0; b < upperBays; b++) {
      const bayCx = upperBays === 1 ? upperCx : (b === 0 ? upperCx - uInnerW / 4 - t * 0.25 : upperCx + uInnerW / 4 + t * 0.25);
      const sy0 = uBaseY + t + 0.001;
      const sy1 = uBaseY + t + (1 / 3) * uSideH + 0.01;
      const sy2 = uBaseY + t + (2 / 3) * uSideH + 0.01;
      addDisplayBowls(group, sy0, bayCx - uBaySpanW * 0.22, upperZ, 0);
      addDisplayBowls(group, sy1, bayCx + uBaySpanW * 0.16, upperZ, 2);
      addDisplayBowls(group, sy2, bayCx - uBaySpanW * 0.18, upperZ, 1);
      addDisplayBowls(group, sy2, bayCx + uBaySpanW * 0.2, upperZ, 1);
    }

    // Upper sliding doors (glass or solid) or open shelves
    const upperFrontZ = -d / 2 + upperD - 0.012;
    if (style !== 'open_over_doors' && style !== 'open_over_drawers') {
      const isGlass = style !== 'solid_sliding_over_doors';
      for (let b = 0; b < upperBays; b++) {
        const bayCx = upperBays === 1 ? upperCx : (b === 0 ? upperCx - uInnerW / 4 - t * 0.25 : upperCx + uInnerW / 4 + t * 0.25);
        addSlidingDoorPair(
          group, uBaySpanW - 0.004, uSideH - 0.004, bayCx, uSideCy, upperFrontZ, frontMat, isGlass, doorsOpen, hardware, cabMats
        );
      }
    }

    // If asymmetric Renton $838 combo: style the open right oak counter with stacked bowls & candle holders (photo-7/8!)
    if (asymLeftOnly) {
      addDisplayBowls(group, baseH + 0.001, w * 0.18, -0.02, 0);
      addDisplayBowls(group, baseH + 0.001, w * 0.34, 0.02, 2);
    }
  } else if (type === 'idanas_cabinet') {
    // Exact IKEA IDANÄS High Cabinet w/ Glass Doors & 1 Drawer (604.901.09, Renton Aisle 8 Bin 40, photo-1..4!)
    const style = frontStyle || catalogEntry.defaultFrontStyle || 'glass_drawer_shaker';
    const legH = 0.115; // 4.5" tapered solid corner legs
    const corniceH = 0.056; // 2-tier stepped crown cornice
    const t = 0.022;
    const innerW = w - t * 2 - 0.002;
    const bodyBottomY = legH;
    const bodyTopY = h - corniceH;
    const bodyH = bodyTopY - bodyBottomY;

    // 4 tapered corner legs
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lx = sx * (w / 2 - 0.024);
        const lz = sz * (d / 2 - 0.024);
        addBox(group, 0.036, legH, 0.036, primaryMat, lx, legH / 2 + 0.001, lz);
      }
    }
    // Lower apron rail between legs
    addBox(group, w - 0.08, 0.036, 0.022, primaryMat, 0, legH - 0.018, d / 2 - 0.024);
    addBox(group, w - 0.08, 0.036, 0.022, primaryMat, 0, legH - 0.018, -d / 2 + 0.024);

    // Main carcass shell (sides strictly between bottom deck & cornice base)
    addBox(group, w, t, d, primaryMat, 0, bodyBottomY + t / 2, 0);
    addBox(group, w, t, d, primaryMat, 0, bodyTopY - t / 2, 0);
    const sideH = bodyH - t * 2 - 0.002;
    const sideCy = bodyBottomY + t + sideH / 2;
    addBox(group, t, sideH, d, primaryMat, -w / 2 + t / 2, sideCy, 0);
    addBox(group, t, sideH, d, primaryMat, w / 2 - t / 2, sideCy, 0);
    addBox(group, innerW, sideH - 0.002, 0.012, primaryMat, 0, sideCy, -d / 2 + 0.008);

    // Signature 2-tier stepped IDANÄS crown cornice overhanging 1.4cm front & sides!
    addBox(group, w + 0.014, corniceH * 0.45, d + 0.012, primaryMat, 0, bodyTopY + corniceH * 0.225, 0.004);
    addBox(group, w + 0.032, corniceH * 0.55, d + 0.026, primaryMat, 0, bodyTopY + corniceH * 0.725, 0.01);

    // Vertical zoning matching photo-2 proportions:
    // Lower cabinet: 33% | Middle drawer: 10.5% | Upper vitrine: 56.5%
    const lowH = sideH * 0.33;
    const drawH = sideH * 0.105;
    const upH = sideH - lowH - drawH - 0.044;
    const yLowTop = bodyBottomY + t + lowH;
    const yDrawTop = yLowTop + 0.022 + drawH;

    // Horizontal rails separating lower doors / drawer / upper glass doors
    addBox(group, innerW, 0.022, d - 0.024, primaryMat, 0, yLowTop + 0.011, 0);
    addBox(group, innerW, 0.022, d - 0.024, primaryMat, 0, yDrawTop + 0.011, 0);

    // Interior adjustable shelves (1 lower + 2 upper)
    const shelfD = d - 0.048;
    addBox(group, innerW - 0.004, 0.018, shelfD, primaryMat, 0, bodyBottomY + t + lowH * 0.5, -0.006);
    const uShelf1 = yDrawTop + 0.022 + upH * 0.34;
    const uShelf2 = yDrawTop + 0.022 + upH * 0.68;
    addBox(group, innerW - 0.004, 0.018, shelfD, primaryMat, 0, uShelf1, -0.006);
    addBox(group, innerW - 0.004, 0.018, shelfD, primaryMat, 0, uShelf2, -0.006);
    // Exact photo-1/2 dark-blue stacked stoneware plates & bowl on upper shelves!
    addDisplayBowls(group, uShelf1 + 0.01, -innerW * 0.22, 0.0, 0);
    addDisplayBowls(group, uShelf1 + 0.01, innerW * 0.22, 0.0, 0);
    addDisplayBowls(group, uShelf2 + 0.01, 0, 0.0, 1);

    const frontZ = d / 2 - 0.011;
    const doorW = innerW / 2 - 0.004;
    const openRad = doorsOpen ? 1.3 : 0;

    // 1. Middle full-width drawer (slides open revealing warm pine sides & off-white bottom liner just like photo-4!)
    const drawPull = doorsOpen ? 0.22 : 0;
    const drawCy = yLowTop + 0.022 + drawH / 2;
    addBox(group, innerW - 0.006, drawH - 0.006, 0.018, frontMat, 0, drawCy, frontZ + drawPull);
    addCabinetHardware(group, -innerW * 0.25, drawCy, frontZ + drawPull + 0.009, hardware, 'dark_knob', cabMats);
    addCabinetHardware(group, innerW * 0.25, drawCy, frontZ + drawPull + 0.009, hardware, 'dark_knob', cabMats);
    if (drawPull > 0.01) {
      const boxD = d - 0.05;
      const boxH = drawH - 0.022;
      const bz = frontZ + drawPull - boxD / 2 - 0.01;
      addBox(group, innerW - 0.036, 0.01, boxD, linenMat, 0, drawCy - boxH / 2 + 0.006, bz, false);
      addBox(group, 0.014, boxH, boxD, pineInnerMat, -innerW / 2 + 0.024, drawCy, bz, false);
      addBox(group, 0.014, boxH, boxD, pineInnerMat, innerW / 2 - 0.024, drawCy, bz, false);
      addBox(group, innerW - 0.044, boxH, 0.014, pineInnerMat, 0, drawCy, bz - boxD / 2 + 0.007, false);
    }

    // 2. Lower double doors (Shaker or Glass)
    const lowerStyle = style === 'full_glass_drawer' || style === 'bi_fold_glass' ? 'glass' : 'shaker';
    const lowCy = bodyBottomY + t + lowH / 2;
    addHingedDoor(
      group, doorW, lowH - 0.008, 0.018, -doorW / 2 - 0.002, lowCy, frontZ,
      'left', openRad, frontMat, lowerStyle, hardware, 'dark_knob', cabMats, 0
    );
    addHingedDoor(
      group, doorW, lowH - 0.008, 0.018, doorW / 2 + 0.002, lowCy, frontZ,
      'right', openRad, frontMat, lowerStyle, hardware, 'dark_knob', cabMats, 0
    );

    // 3. Upper double doors (Glass, Solid Shaker, Bi-Fold Glass, or Open!)
    if (style !== 'open_drawer_shaker') {
      const upperStyle =
        style === 'solid_shaker_drawer'
          ? 'shaker'
          : style === 'bi_fold_glass'
          ? 'bi_fold_glass'
          : 'glass';
      const upCy = yDrawTop + 0.022 + upH / 2;
      addHingedDoor(
        group, doorW, upH - 0.008, 0.018, -doorW / 2 - 0.002, upCy, frontZ,
        'left', openRad * 0.85, frontMat, upperStyle, hardware, 'dark_knob', cabMats, -upH * 0.06
      );
      addHingedDoor(
        group, doorW, upH - 0.008, 0.018, doorW / 2 + 0.002, upCy, frontZ,
        'right', openRad * 0.85, frontMat, upperStyle, hardware, 'dark_knob', cabMats, -upH * 0.06
      );
    }
  } else if (type === 'kallax') {
    // Detailed KALLAX Modular Cube Grid with Renton-accurate Door, 2-Drawer, Divider Shelf, Glass & KUGGIS Inserts!
    const cols = catalogEntry.cols || 4;
    const rows = catalogEntry.rows || 2;
    const style = frontStyle || catalogEntry.defaultFrontStyle || 'lower_drawers_doors';
    const outerT = 0.038;
    const innerT = 0.016;
    // Thick outer frame (sides strictly between top & bottom!)
    addBox(group, w, outerT, d, primaryMat, 0, outerT / 2 + 0.001, 0);
    addBox(group, w, outerT, d, primaryMat, 0, h - outerT / 2, 0);
    addBox(group, outerT, h - outerT * 2 - 0.002, d, primaryMat, -w / 2 + outerT / 2, h / 2, 0);
    addBox(group, outerT, h - outerT * 2 - 0.002, d, primaryMat, w / 2 - outerT / 2, h / 2, 0);

    const innerW = w - outerT * 2;
    const innerH = h - outerT * 2;
    for (let c = 1; c < cols; c++) {
      const vx = -innerW / 2 + (c / cols) * innerW;
      addBox(group, innerT, innerH - 0.004, d - 0.006, primaryMat, vx, h / 2, 0);
    }
    for (let r = 1; r < rows; r++) {
      const hy = outerT + (r / rows) * innerH;
      // Distinct depth (-0.012) so vertical & horizontal interior dividers never z-fight at crossings!
      addBox(group, innerW - 0.004, innerT, d - 0.012, primaryMat, 0, hy, 0);
    }

    const cellW = innerW / cols;
    const cellH = innerH / rows;
    const cw = cellW - innerT - 0.006;
    const ch = cellH - innerT - 0.006;
    const insertFrontZ = d / 2 - 0.014;
    const openRad = doorsOpen ? 1.25 : 0;

    // Determine what insert goes into cubby (row r from bottom 0..rows-1, col c 0..cols-1)
    const getCellInsert = (r, c) => {
      const lowerHalf = r < Math.ceil(rows / 2);
      if (style === 'open_cubbies') return (r === rows - 1 && c % 2 === 0) ? 'books' : 'open';
      if (style === 'all_doors') return 'door';
      if (style === 'lower_doors') return lowerHalf ? 'door' : (r === rows - 1 && c % 2 === 0 ? 'books' : 'open');
      if (style === 'checkerboard') return (r + c) % 2 === 0 ? 'door' : (r >= rows - 2 ? 'books' : 'open');
      if (style === 'kuggis_bins') {
        if (r === 0) return c % 2 === 0 ? 'kuggis' : 'door';
        if (r === 1 && rows >= 3) return c % 2 === 1 ? 'kuggis' : 'drawers';
        return r === rows - 1 ? 'books' : 'open';
      }
      if (style === 'glass_and_drawers') {
        if (r === 0) return 'drawers';
        if (r === 1 && rows >= 4) return 'door';
        if (r >= rows - 2) return 'glass_door';
        return 'open';
      }
      if (style === 'lower_drawers_doors') {
        // Exact Batch 1 photo-9 & photo-10 oak-effect KALLAX look: alternating hinged doors & 2-drawer inserts on bottom half!
        if (lowerHalf) {
          return (c + r) % 2 === 1 ? 'drawers' : 'door';
        }
        return r === rows - 1 && c < Math.min(cols, 3) ? 'books' : 'open';
      }
      // 'renton_mix' (Exact Batch 2 photo-6 5x5 Renton display: shelf divider left, 2-drawer inserts right, KUGGIS/baskets bottom, books top!)
      if (r === 0) {
        if (c === 0) return 'kuggis';
        if (c >= cols - 2) return 'door';
        return 'basket';
      }
      if (r === 1) {
        if (c === 0) return 'shelf';
        if (c >= Math.max(1, cols - 3)) return 'drawers';
        return 'kuggis';
      }
      if (r === 2 && rows >= 5) {
        if (c >= cols - 3) return 'drawers';
        if (c === 0) return 'shelf';
        return 'open';
      }
      return (r >= rows - 2) ? 'books' : 'open';
    };

    const binMat = new THREE.MeshStandardMaterial({ color: 0x8f887d, roughness: 0.92 });
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = -innerW / 2 + (c + 0.5) * cellW;
        const cy = outerT + (r + 0.5) * cellH;
        const ins = getCellInsert(r, c);
        if (ins === 'door' || ins === 'glass_door') {
          // Thin inset liner box behind door (exact photo-9 open-door interior!)
          addBox(group, cw, ch, 0.01, frontMat, cx, cy, -d / 2 + 0.018, false);
          const hingeSide = c < cols / 2 ? 'left' : 'right';
          const swing = doorsOpen && (r === 0 || (r === 1 && c === 0)) ? openRad : 0;
          addHingedDoor(
            group, cw - 0.008, ch - 0.008, 0.016,
            cx, cy, insertFrontZ, hingeSide, swing,
            frontMat, ins === 'glass_door' ? 'glass' : 'flush',
            hardware, 'silver_knob', cabMats, 0
          );
        } else if (ins === 'drawers') {
          // Exact KALLAX 2-drawer insert (photo-10 & photo-6): two half-height drawers with knurled metal knobs!
          const dh = (ch - 0.012) / 2;
          for (let dr = 0; dr < 2; dr++) {
            const dy = cy + (dr === 0 ? -dh / 2 - 0.003 : dh / 2 + 0.003);
            const pull = doorsOpen && dr === 0 && r <= 2 && c === Math.min(cols - 1, 2) ? 0.17 : 0;
            addBox(group, cw - 0.008, dh - 0.005, 0.016, frontMat, cx, dy, insertFrontZ + pull);
            addCabinetHardware(group, cx, dy, insertFrontZ + pull + 0.008, hardware, 'silver_knob', cabMats);
            if (pull > 0.01) {
              // White melamine inner drawer box (exact photo-10!)
              const boxD = d - 0.06;
              const boxH = dh - 0.022;
              const bz = insertFrontZ + pull - boxD / 2 - 0.009;
              addBox(group, cw - 0.028, 0.01, boxD, whiteMat, cx, dy - boxH / 2 + 0.005, bz, false);
              addBox(group, 0.012, boxH, boxD, whiteMat, cx - cw / 2 + 0.02, dy, bz, false);
              addBox(group, 0.012, boxH, boxD, whiteMat, cx + cw / 2 - 0.02, dy, bz, false);
              addBox(group, cw - 0.036, boxH, 0.012, whiteMat, cx, dy, bz - boxD / 2 + 0.006, false);
            }
          }
        } else if (ins === 'shelf') {
          // Exact KALLAX 1-shelf divider insert (204.237.20 from Batch 2 photo-6!)
          addBox(group, cw - 0.004, 0.014, d - 0.036, frontMat, cx, cy, 0, false);
          addBox(group, 0.012, ch - 0.004, d - 0.036, frontMat, cx - cw / 2 + 0.008, cy, 0, false);
          addBox(group, 0.012, ch - 0.004, d - 0.036, frontMat, cx + cw / 2 - 0.008, cy, 0, false);
        } else if (ins === 'kuggis') {
          addKuggisBox(group, cw - 0.024, ch * 0.62, d - 0.044, cx, cy - ch * 0.17, 0.004);
        } else if (ins === 'basket') {
          addBox(group, cw - 0.022, ch - 0.024, d - 0.036, binMat, cx, cy, 0.004, false);
          addBox(group, 0.06, 0.014, 0.006, darkMetal, cx, cy + ch * 0.2, d / 2 - 0.014, false);
        } else if (ins === 'books') {
          addShelfBooks(group, cw - 0.02, cy - ch / 2 + 0.002, d - 0.04, cx, 0.0, r * 5 + c * 3, 6);
        }
      }
    }
  } else if (type === 'billy') {
    const bays = catalogEntry.bays || 1;
    const style = frontStyle || catalogEntry.defaultFrontStyle || 'open_shelves';
    const t = 0.02;
    const sideH = h - t - 0.002;
    // Top cap (full width & depth)
    addBox(group, w, t, d, primaryMat, 0, h - t / 2, 0);
    // Outer sides strictly below top cap (zero top corner overlap!)
    addBox(group, t, sideH, d, primaryMat, -w / 2 + t / 2, sideH / 2 + 0.001, 0);
    addBox(group, t, sideH, d, primaryMat, w / 2 - t / 2, sideH / 2 + 0.001, 0);
    // Backboard strictly inside sides & below top cap
    const innerW = w - t * 2 - 0.002;
    addBox(group, innerW, sideH - 0.002, 0.012, primaryMat, 0, sideH / 2 + 0.001, -d / 2 + 0.008);
    // Toe kick strictly between outer sides & in front of backboard
    addBox(group, innerW, 0.08, d - 0.026, primaryMat, 0, 0.041, 0.006);
    if (bays === 2) {
      addBox(group, t * 1.4, sideH - 0.084, d - 0.022, primaryMat, 0, 0.082 + (sideH - 0.084) / 2, 0.008);
    }
    for (let s = 1; s <= 5; s++) {
      const sy = 0.08 + (s / 6) * (h - 0.1);
      addBox(group, innerW - 0.002, t * 0.9, d - 0.028, primaryMat, 0, sy, 0.006);
      if (s >= 2 && s <= 4) {
        for (let b = 0; b < bays; b++) {
          const bayCx = bays === 1 ? 0 : (b === 0 ? -w / 4 : w / 4);
          const bayW = w / bays - 0.08;
          addShelfBooks(group, bayW, sy + t * 0.45, d - 0.03, bayCx, 0.0, s * 4 + b, 6);
        }
      }
    }
    // Optional OXBERG doors (half glass/panel, full glass, or full solid!)
    if (style !== 'open_shelves') {
      const openRad = doorsOpen ? 1.25 : 0;
      const frontZ = d / 2 + 0.008;
      const doorH = h - 0.095;
      const doorCy = 0.085 + doorH / 2;
      const bayW = w / bays;
      for (let b = 0; b < bays; b++) {
        const bayCx = bays === 1 ? 0 : (b === 0 ? -w / 4 : w / 4);
        const dw = bayW / 2 - 0.006;
        for (const side of ['left', 'right']) {
          const dcx = side === 'left' ? bayCx - dw / 2 - 0.002 : bayCx + dw / 2 + 0.002;
          if (style === 'oxberg_half_glass') {
            // Solid Shaker lower 42% + framed glass upper 58%
            const pivot = new THREE.Group();
            const hx = side === 'left' ? dcx - dw / 2 : dcx + dw / 2;
            const localCx = side === 'left' ? dw / 2 : -dw / 2;
            pivot.position.set(hx, doorCy, frontZ);
            if (openRad) pivot.rotation.y = side === 'left' ? -openRad : openRad;
            const lowH = doorH * 0.42;
            const upH = doorH * 0.58;
            const lowP = buildDoorPanel(dw, lowH, 0.017, frontMat, 'shaker', cabMats);
            lowP.position.set(localCx, -doorH / 2 + lowH / 2, 0);
            const upP = buildDoorPanel(dw, upH, 0.017, frontMat, 'glass', cabMats);
            upP.position.set(localCx, doorH / 2 - upH / 2, 0);
            pivot.add(lowP, upP);
            const kx = side === 'left' ? dw - 0.03 : -(dw - 0.03);
            addCabinetHardware(pivot, kx, -0.04, 0.009, hardware, 'silver_knob', cabMats);
            group.add(pivot);
          } else {
            const pStyle = style === 'oxberg_full_glass' ? 'glass' : 'shaker';
            addHingedDoor(
              group, dw, doorH, 0.017, dcx, doorCy, frontZ, side, openRad,
              frontMat, pStyle, hardware, 'silver_knob', cabMats, 0
            );
          }
        }
      }
    }
  } else if (type === 'helmer') {
    const wheelH = 0.045;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.018, 10), darkMetal);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx * (w / 2 - 0.03), 0.021, sz * (d / 2 - 0.03));
        group.add(wheel);
      }
    }
    const bodyH = h - wheelH;
    addBox(group, w, bodyH, d - 0.022, primaryMat, 0, wheelH + bodyH / 2, -0.011);
    const dh = (bodyH - 0.03) / 6;
    for (let r = 0; r < 6; r++) {
      const cy = wheelH + 0.015 + (r + 0.5) * dh;
      addBox(group, w - 0.014, dh - 0.01, 0.014, primaryMat, 0, cy, d / 2 - 0.009);
      // Label slot + curved steel pull cleanly proud of drawer face
      addBox(group, 0.045, 0.022, 0.004, whiteMat, 0, cy + 0.014, d / 2 + 0.002, false);
      addBox(group, 0.06, 0.008, 0.014, silverMetal, 0, cy - 0.012, d / 2 + 0.007, false);
    }
  } else if (type === 'eket_wall') {
    const y0 = (catalogEntry.mountHeightIn || 54) * IN_TO_M;
    const t = 0.018;
    const innerH = h - t * 2 - 0.002;
    // Outer frame (verticals & backboard strictly inside top/bottom — zero corner z-fighting!)
    addBox(group, w, t, d, primaryMat, 0, y0 + h - t / 2, 0);
    addBox(group, w, t, d, primaryMat, 0, y0 + t / 2, 0);
    addBox(group, t, innerH, d, primaryMat, -w / 2 + t / 2, y0 + h / 2, 0);
    addBox(group, t, innerH, d - 0.004, primaryMat, 0, y0 + h / 2, 0.002);
    addBox(group, t, innerH, d, primaryMat, w / 2 - t / 2, y0 + h / 2, 0);
    addBox(group, w - t * 2 - 0.004, innerH - 0.002, 0.012, primaryMat, 0, y0 + h / 2, -d / 2 + 0.008);
    // Small books + potted succulent inside the floating cubes
    const bookColors = [0x3d5a73, 0xc97b5d, 0x6b8273, 0xd4b26a];
    for (let k = 0; k < 4; k++) {
      const bMat = new THREE.MeshStandardMaterial({ color: bookColors[k], roughness: 0.78 });
      const bh = 0.19 + (k % 2) * 0.03;
      addBox(group, 0.032, bh, d * 0.58, bMat, -w / 2 + 0.055 + k * 0.038, y0 + t + bh / 2 + 0.002, 0.01, false);
    }
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.09, 12), linenMat);
    pot.position.set(w / 4, y0 + t + 0.047, 0.02);
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), new THREE.MeshStandardMaterial({ color: 0x4b7752, roughness: 0.75 }));
    leaf.position.set(w / 4, y0 + t + 0.125, 0.02);
    group.add(pot, leaf);
  } else if (type === 'alex' || type === 'dresser_wide' || type === 'dresser_tall') {
    addBox(group, w, h, d - 0.024, primaryMat, 0, h / 2 + 0.001, -0.012);
    const cols = type === 'dresser_wide' ? 2 : 1;
    const rows = type === 'alex' ? 5 : 3;
    const dw = (w - 0.03) / cols;
    const dh = (h - 0.06) / rows;
    for (let c = 0; c < cols; c++) {
      const cx = -w / 2 + 0.015 + (c + 0.5) * dw;
      for (let r = 0; r < rows; r++) {
        const cy = 0.04 + (r + 0.5) * dh;
        addBox(group, dw - 0.012, dh - 0.014, 0.016, primaryMat, cx, cy, d / 2 - 0.01);
        if (type === 'dresser_tall') {
          for (const kx of [-dw * 0.25, dw * 0.25]) {
            const kn = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8), darkMetal);
            kn.position.set(cx + kx, cy, d / 2 + 0.012);
            group.add(kn);
          }
        } else if (type === 'alex') {
          addBox(group, 0.06, 0.014, 0.006, darkMetal, cx, cy + dh * 0.28, d / 2 + 0.002, false);
        }
      }
    }
  } else if (type === 'besta') {
    const legH = 0.08;
    for (const sx of [-1, 0, 1]) {
      for (const sz of [-1, 1]) {
        addBox(group, 0.03, legH, 0.03, darkMetal, sx * (w * 0.44), legH / 2 + 0.001, sz * (d * 0.38));
      }
    }
    addBox(group, w, h - legH, d - 0.024, primaryMat, 0, legH + 0.001 + (h - legH) / 2, -0.012);
    const doorW = (w - 0.03) / 3;
    for (let i = -1; i <= 1; i++) {
      addBox(group, doorW - 0.012, h - legH - 0.025, 0.016, primaryMat, i * doorW, legH + 0.001 + (h - legH) / 2, d / 2 - 0.01);
    }
  } else if (type === 'trofast') {
    const t = 0.025;
    const innerH = h - t * 2 - 0.002;
    addBox(group, w, t, d, primaryMat, 0, h - t / 2, 0);
    addBox(group, w, t, d, primaryMat, 0, t / 2 + 0.001, 0);
    for (let c = 0; c <= 3; c++) {
      const vx = -w / 2 + t / 2 + (c / 3) * (w - t);
      addBox(group, t, innerH, d, primaryMat, vx, h / 2, 0);
    }
    const binColors = [0xf4f4f0, 0x8fa895, 0xd88c6a, 0xf4f4f0, 0x7b98ad, 0xf4f4f0];
    const colW = (w - t * 4) / 3;
    for (let c = 0; c < 3; c++) {
      const cx = -w / 2 + t + (c + 0.5) * colW + c * t;
      for (let r = 0; r < 3; r++) {
        const bh = (h - 0.14) / 3;
        const bMat = new THREE.MeshStandardMaterial({ color: binColors[(c * 3 + r) % binColors.length], roughness: 0.45 });
        addBox(group, colW - 0.014, bh - 0.02, d - 0.02, bMat, cx, 0.05 + (r + 0.5) * bh, 0.01);
      }
    }
  } else if (type === 'wardrobe') {
    addBox(group, w, h, d - 0.026, primaryMat, 0, h / 2 + 0.001, -0.013);
    for (const sx of [-1, 1]) {
      addBox(group, w / 2 - 0.012, h - 0.04, 0.018, primaryMat, sx * (w / 4), h / 2 + 0.001, d / 2 - 0.01);
      addBox(group, 0.016, 0.28, 0.02, darkMetal, sx * 0.04, h * 0.48, d / 2 + 0.011);
    }
  } else if (type === 'coffee_rect') {
    const leg = 0.05;
    addBox(group, w, 0.048, d, primaryMat, 0, h - 0.024, 0);
    addBox(group, w - leg * 2 - 0.006, 0.022, d - leg * 2 - 0.006, primaryMat, 0, h * 0.38, 0);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addBox(group, leg, h - 0.05, leg, primaryMat, sx * (w / 2 - leg / 2), (h - 0.05) / 2 + 0.001, sz * (d / 2 - leg / 2));
      }
    }
  } else if (type === 'coffee_round') {
    const r = w / 2;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.032, 32), primaryMat);
    top.position.set(0, h - 0.016, 0);
    top.castShadow = true;
    top.receiveShadow = true;
    group.add(top);
    const shelf = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.72, r * 0.72, 0.018, 28), primaryMat);
    shelf.position.set(0, h * 0.36, 0);
    group.add(shelf);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.014, h - 0.034, 10), primaryMat);
      leg.position.set(Math.cos(a) * r * 0.78, (h - 0.034) / 2 + 0.001, Math.sin(a) * r * 0.78);
      group.add(leg);
    }
  } else if (type === 'side_table') {
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xe6f2f5, roughness: 0.1, transparent: true, opacity: 0.6 });
    const innerSpanW = w - 0.058;
    const innerSpanD = d - 0.058;
    addBox(group, innerSpanW, 0.01, innerSpanD, glassMat, 0, h - 0.012, 0);
    addBox(group, innerSpanW, 0.016, innerSpanD, primaryMat, 0, h * 0.34, 0);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addBox(group, 0.024, h - 0.002, 0.024, primaryMat, sx * (w / 2 - 0.014), h / 2 + 0.001, sz * (d / 2 - 0.014));
      }
    }
  } else if (type === 'nightstand') {
    addBox(group, w, 0.028, d, primaryMat, 0, h - 0.014, 0);
    const legOff = 0.044;
    addBox(group, w - legOff * 2, 0.16, d - legOff * 2, primaryMat, 0, h - 0.11, 0);
    const kn = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 8), darkMetal);
    kn.position.set(0, h - 0.11, d / 2 - legOff + 0.012);
    group.add(kn);
    addBox(group, w - legOff * 2, 0.02, d - legOff * 2, primaryMat, 0, 0.16, 0);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addBox(group, 0.032, h - 0.03, 0.032, primaryMat, sx * (w / 2 - 0.024), (h - 0.03) / 2 + 0.001, sz * (d / 2 - 0.024));
      }
    }
  } else if (type === 'rug' || type === 'rug_woven' || type === 'rug_geo') {
    let mat = primaryMat.clone();
    if (type === 'rug_geo') {
      if (!cachedGeoRugTex) cachedGeoRugTex = createGeoRugTexture();
      mat = new THREE.MeshStandardMaterial({ map: cachedGeoRugTex, roughness: 0.96 });
    }
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    const rugH = Math.max(h, 0.012);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, rugH, d), mat);
    mesh.position.set(0, rugH / 2 + 0.004, 0);
    mesh.receiveShadow = true;
    group.add(mesh);
  } else if (type === 'floor_lamp') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 0.024, 24), primaryMat);
    base.position.set(0, 0.013, 0);
    const poleH = h - 0.275;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.015, poleH, 12), primaryMat);
    pole.position.set(0, 0.025 + poleH / 2, 0);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.24, 20, 1, true), primaryMat);
    shade.position.set(0.08, h - 0.16, 0);
    shade.rotation.z = -0.35;
    shade.material.side = THREE.DoubleSide;
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe9b3 })
    );
    bulb.position.set(0.09, h - 0.19, 0);
    bulb.name = 'lampBulb';
    const lampLight = new THREE.PointLight(0xffd28a, 0, 4.2, 1.8);
    lampLight.position.set(0.11, h - 0.25, 0);
    lampLight.name = 'furnitureLampLight';
    group.add(base, pole, shade, bulb, lampLight);
  } else if (type === 'orb_lamp') {
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(w / 2, 20, 18),
      new THREE.MeshStandardMaterial({
        color: 0xfffaf0,
        emissive: 0xffd28a,
        emissiveIntensity: 0.65,
        roughness: 0.35,
      })
    );
    orb.position.set(0, h / 2 + 0.002, 0);
    orb.name = 'lampBulb';
    const lampLight = new THREE.PointLight(0xffcf82, 0, 3.0, 1.8);
    lampLight.position.set(0, h / 2 + 0.05, 0);
    lampLight.name = 'furnitureLampLight';
    group.add(orb, lampLight);
  } else if (type === 'plant') {
    const potColor = finishKey === 'terracotta' ? 0xb56c55 : finishKey === 'white' ? 0xf2f0eb : 0xd3cabd;
    const potMat = new THREE.MeshStandardMaterial({ color: potColor, roughness: 0.72 });
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.125, 0.32, 18), potMat);
    pot.position.set(0, 0.161, 0);
    pot.castShadow = true;
    const soil = new THREE.Mesh(
      new THREE.CylinderGeometry(0.145, 0.145, 0.012, 16),
      new THREE.MeshStandardMaterial({ color: 0x3b2c20, roughness: 0.95 })
    );
    soil.position.set(0, 0.325, 0);
    group.add(pot, soil);

    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f6e49, roughness: 0.62, side: THREE.DoubleSide });
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x33593a, roughness: 0.7 });
    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * Math.PI * 2 + (i % 2) * 0.25;
      const stemH = 0.42 + (i % 3) * 0.24;
      const tilt = 0.22 + (i % 3) * 0.14;
      const stemPivot = new THREE.Group();
      stemPivot.position.set(0, 0.3, 0);
      stemPivot.rotation.y = angle;
      stemPivot.rotation.z = tilt;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.011, stemH, 6), stemMat);
      stem.position.set(0, stemH / 2, 0);
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), leafMat);
      leaf.scale.set(1.15, 0.14, 0.85);
      leaf.position.set(0, stemH, 0.04);
      leaf.rotation.x = 0.45;
      leaf.castShadow = true;
      stemPivot.add(stem, leaf);
      group.add(stemPivot);
    }
  } else {
    addBox(group, w, h, d, primaryMat, 0, h / 2, 0);
  }

  // Ensure every mesh participates cleanly in raycasting & shadows
  group.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = !catalogEntry.isRug;
      child.receiveShadow = true;
    }
  });

  return group;
}
