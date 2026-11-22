import * as THREE from 'three';
import { IN_TO_M, FINISH_SWATCHES } from './catalog.js';

function getSwatchColor(finishKey) {
  const sw = FINISH_SWATCHES[finishKey] || FINISH_SWATCHES.white;
  return new THREE.Color(sw.hex);
}

function makeMaterial(finishKey, extra = {}) {
  const sw = FINISH_SWATCHES[finishKey] || FINISH_SWATCHES.white;
  const roughness = sw.fabric ? 0.88 : sw.metal ? 0.35 : sw.wood ? 0.58 : 0.45;
  const metalness = sw.metal ? 0.65 : 0.03;
  return new THREE.MeshStandardMaterial({
    color: getSwatchColor(finishKey),
    roughness,
    metalness,
    ...extra,
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
  let idx = 0;
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
      idx++;
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

export function createFurnitureMesh(catalogEntry, finishKey, options = {}) {
  const { expanded = false } = options;
  const group = new THREE.Group();
  const w = catalogEntry.w * IN_TO_M;
  const d = (expanded && catalogEntry.expandedD ? catalogEntry.expandedD : catalogEntry.d) * IN_TO_M;
  const h = catalogEntry.h * IN_TO_M;

  const primaryMat = makeMaterial(finishKey || catalogEntry.defaultFinish);
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x242629, roughness: 0.38, metalness: 0.65 });
  const silverMetal = new THREE.MeshStandardMaterial({ color: 0xc2c7cc, roughness: 0.28, metalness: 0.78 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: 0.55 });
  const linenMat = new THREE.MeshStandardMaterial({ color: 0xf0ede6, roughness: 0.9 });
  const accentPillowMat = new THREE.MeshStandardMaterial({ color: 0xd9b84e, roughness: 0.88 });
  const woodAccent = new THREE.MeshStandardMaterial({ color: 0xc69e6b, roughness: 0.58 });
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.2, metalness: 0.3 });

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
  } else if (type === 'kallax') {
    const cols = catalogEntry.cols || 4;
    const rows = catalogEntry.rows || 2;
    const outerT = 0.038;
    const innerT = 0.018;
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
    // Add a couple of woven DRÖNA storage baskets in bottom row for authentic IKEA look!
    const binMat = new THREE.MeshStandardMaterial({ color: 0x8f887d, roughness: 0.92 });
    const cellW = innerW / cols;
    const cellH = innerH / rows;
    for (let c = 0; c < cols; c += 2) {
      const bx = -innerW / 2 + (c + 0.5) * cellW;
      addBox(group, cellW - 0.04, cellH - 0.035, d - 0.04, binMat, bx, outerT + cellH / 2 + 0.002, 0.005, false);
    }
  } else if (type === 'billy') {
    const bays = catalogEntry.bays || 1;
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
    const bookPalette = [0x3b5c78, 0x8a5443, 0xd4c9b2, 0x5b7561, 0x454952, 0xc99c57];
    for (let s = 1; s <= 5; s++) {
      const sy = 0.08 + (s / 6) * (h - 0.1);
      addBox(group, innerW - 0.002, t * 0.9, d - 0.028, primaryMat, 0, sy, 0.006);
      // Decorative books on alternating shelves
      if (s >= 2 && s <= 4) {
        for (let b = 0; b < bays; b++) {
          const bayCx = bays === 1 ? 0 : (b === 0 ? -w / 4 : w / 4);
          const bayW = w / bays - 0.08;
          let bx = bayCx - bayW / 2 + 0.03;
          for (let k = 0; k < 6; k++) {
            const bw = 0.028 + ((k * 7 + s) % 3) * 0.01;
            const bh = 0.17 + ((k * 5 + s) % 4) * 0.022;
            const bMat = new THREE.MeshStandardMaterial({
              color: bookPalette[(k + s + b * 2) % bookPalette.length],
              roughness: 0.78,
            });
            addBox(group, bw, bh, d * 0.62, bMat, bx + bw / 2, sy + t * 0.45 + bh / 2 + 0.002, 0.0, false);
            bx += bw + 0.005;
            if (bx > bayCx + bayW / 2 - 0.06) break;
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
