import * as THREE from 'three';
import { IN_TO_M } from './catalog.js';
import { getWestWallXAtZ } from './collision.js';

function createWoodFloorTextures() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  // Warm honey bamboo/oak planks running North-South (along V / canvas Y)
  const plankCols = 16;
  const colW = canvas.width / plankCols;

  ctx.fillStyle = '#b98b58';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let col = 0; col < plankCols; col++) {
    const x = col * colW;
    let y = -Math.floor(rand() * 260);
    while (y < canvas.height) {
      const plankLen = 220 + Math.floor(rand() * 220);
      const toneShift = (rand() - 0.5) * 26;
      const r = Math.min(255, Math.max(0, 184 + toneShift));
      const g = Math.min(255, Math.max(0, 138 + toneShift * 0.85));
      const b = Math.min(255, Math.max(0, 88 + toneShift * 0.65));

      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x + 1, y + 1, colW - 2, plankLen - 2);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, y + 1, colW - 2, plankLen - 2);
      ctx.clip();
      for (let s = 0; s < 14; s++) {
        const gx = x + rand() * colW;
        const alpha = 0.04 + rand() * 0.07;
        ctx.strokeStyle = rand() > 0.5 ? `rgba(92,56,24,${alpha})` : `rgba(235,205,160,${alpha})`;
        ctx.lineWidth = 0.8 + rand() * 1.6;
        ctx.beginPath();
        ctx.moveTo(gx, y);
        ctx.bezierCurveTo(
          gx + (rand() - 0.5) * 5,
          y + plankLen * 0.33,
          gx + (rand() - 0.5) * 5,
          y + plankLen * 0.66,
          gx + (rand() - 0.5) * 3,
          y + plankLen
        );
        ctx.stroke();
      }
      ctx.restore();

      ctx.strokeStyle = 'rgba(72,44,20,0.34)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x + 0.5, y + 0.5, colW - 1, plankLen - 1);

      y += plankLen;
    }
  }

  const colorTex = new THREE.CanvasTexture(canvas);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.wrapS = THREE.RepeatWrapping;
  colorTex.wrapT = THREE.RepeatWrapping;
  // World-meter UV scale: 16 planks = 1.85m (~4.5" per plank)
  colorTex.repeat.set(1 / 1.85, 1 / 1.85);
  colorTex.anisotropy = 8;

  return colorTex;
}

function buildWallWithOpenings(widthM, heightM, thicknessM, openings, wallMat, trimMat) {
  const shape = new THREE.Shape();
  shape.moveTo(-widthM / 2, 0);
  shape.lineTo(widthM / 2, 0);
  shape.lineTo(widthM / 2, heightM);
  shape.lineTo(-widthM / 2, heightM);
  shape.closePath();

  for (const op of openings) {
    const hole = new THREE.Path();
    const x0 = op.cx - op.w / 2;
    const x1 = op.cx + op.w / 2;
    const y0 = op.y0;
    const y1 = op.y0 + op.h;
    hole.moveTo(x0, y0);
    hole.lineTo(x1, y0);
    hole.lineTo(x1, y1);
    hole.lineTo(x0, y1);
    hole.closePath();
    shape.holes.push(hole);
  }

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thicknessM,
    bevelEnabled: false,
  });
  geo.translate(0, 0, -thicknessM / 2);

  const group = new THREE.Group();
  const wallMesh = new THREE.Mesh(geo, wallMat);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  group.add(wallMesh);

  const baseH = 4.5 * IN_TO_M;
  const baseD = 0.55 * IN_TO_M;
  const floorOpenings = openings
    .filter((o) => o.y0 < baseH + 0.01)
    .map((o) => {
      const pad = typeof o.casingPadM === 'number' ? o.casingPadM : 0;
      return [o.cx - o.w / 2 - pad, o.cx + o.w / 2 + pad];
    })
    .sort((a, b) => a[0] - b[0]);

  let cursor = -widthM / 2 + 0.002;
  const segs = [];
  for (const [ox0, ox1] of floorOpenings) {
    if (ox0 > cursor + 0.01) segs.push([cursor, Math.min(widthM / 2 - 0.002, ox0)]);
    cursor = Math.max(cursor, ox1);
  }
  if (widthM / 2 - 0.002 > cursor + 0.01) segs.push([cursor, widthM / 2 - 0.002]);

  for (const [s0, s1] of segs) {
    const sw = s1 - s0;
    const bm = new THREE.Mesh(new THREE.BoxGeometry(sw, baseH - 0.002, baseD), trimMat);
    bm.position.set((s0 + s1) / 2, baseH / 2 + 0.001, thicknessM / 2 + baseD / 2 + 0.001);
    bm.receiveShadow = true;
    group.add(bm);
  }

  return group;
}

function createWindowAssembly(wM, hM, depthM, opts = {}) {
  const { hasBlinds = false, hasSheerCurtains = false, curtainRodExtraM = 0.25, mullion = false } = opts;
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xf6f6f3, roughness: 0.45 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xdbeeff,
    roughness: 0.08,
    metalness: 0.05,
    transmission: 0.55,
    transparent: true,
    opacity: 0.45,
  });
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 0.75 });
  const ft = 0.045;

  const topF = new THREE.Mesh(new THREE.BoxGeometry(wM, ft, depthM + 0.012), frameMat);
  topF.position.set(0, hM / 2 - ft / 2, 0);
  const botF = new THREE.Mesh(new THREE.BoxGeometry(wM + 0.06, ft * 0.9, depthM + 0.05), frameMat);
  botF.position.set(0, -hM / 2 + (ft * 0.9) / 2, 0.02);
  // Fit side stiles strictly between top and bottom frame rails (zero corner overlap / z-fighting!)
  const sideH = hM - ft - ft * 0.9;
  const sideY = (ft * 0.9 - ft) / 2;
  const leftF = new THREE.Mesh(new THREE.BoxGeometry(ft, sideH, depthM + 0.012), frameMat);
  leftF.position.set(-wM / 2 + ft / 2, sideY, 0);
  const rightF = new THREE.Mesh(new THREE.BoxGeometry(ft, sideH, depthM + 0.012), frameMat);
  rightF.position.set(wM / 2 - ft / 2, sideY, 0);
  group.add(topF, botF, leftF, rightF);

  if (mullion) {
    const midV = new THREE.Mesh(new THREE.BoxGeometry(0.04, hM - ft * 2, depthM * 0.65), frameMat);
    const midH = new THREE.Mesh(new THREE.BoxGeometry(wM - ft * 2, 0.032, depthM * 0.5), frameMat);
    midH.position.set(0, 0.04, 0);
    group.add(midV, midH);
  }

  const glass = new THREE.Mesh(new THREE.PlaneGeometry(wM - ft * 2, hM - ft * 2), glassMat);
  glass.position.set(0, 0, -0.01);
  group.add(glass);

  const skyMat = new THREE.MeshBasicMaterial({ color: 0xeaf4ff, side: THREE.DoubleSide });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(wM - ft * 1.5, hM - ft * 1.5), skyMat);
  sky.position.set(0, 0, -depthM / 2 - 0.005);
  sky.name = 'windowSkyBackdrop';
  group.add(sky);

  if (hasBlinds) {
    const slatCount = 22;
    const slatMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.5 });
    for (let i = 0; i < slatCount; i++) {
      const sy = -hM / 2 + ft + ((i + 0.5) / slatCount) * (hM - ft * 2);
      const slat = new THREE.Mesh(new THREE.BoxGeometry(wM - ft * 2.2, 0.008, 0.028), slatMat);
      slat.position.set(0, sy, 0.01);
      slat.rotation.x = 0.25;
      group.add(slat);
    }
  }

  const rodW = wM + curtainRodExtraM * 2;
  const rodY = hM / 2 + 0.14;
  const rodZ = depthM / 2 + 0.075;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, rodW, 12), rodMat);
  rod.rotation.z = Math.PI / 2;
  rod.position.set(0, rodY, rodZ);
  group.add(rod);

  for (const sx of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 10), rodMat);
    fin.position.set((sx * rodW) / 2, rodY, rodZ);
    group.add(fin);
  }

  if (hasSheerCurtains) {
    const curtMat = new THREE.MeshStandardMaterial({
      color: 0xf8f8f5,
      roughness: 0.9,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
    });
    const curtH = hM + 0.22;
    const leftCurt = new THREE.Mesh(new THREE.BoxGeometry(0.22, curtH, 0.03), curtMat);
    leftCurt.position.set(-wM / 2 - 0.04, rodY - curtH / 2 - 0.02, rodZ);
    const rightCurt = new THREE.Mesh(new THREE.BoxGeometry(wM * 0.48, curtH, 0.03), curtMat);
    rightCurt.position.set(wM * 0.28, rodY - curtH / 2 - 0.02, rodZ);
    group.add(leftCurt, rightCurt);
  } else {
    const curtMat = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.88 });
    const curtH = hM + 0.22;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.2, curtH, 0.035), curtMat);
    panel.position.set(wM / 2 - 0.02, rodY - curtH / 2 - 0.02, rodZ);
    group.add(panel);
  }

  return group;
}

// Helper: create a 5-sided room polygon THREE.Shape in (X, Z) meters, optionally expanded outward by exact miter marginM
function makeRoomFloorShape(W, L, flareW, flareL, marginM = 0) {
  const halfW = W / 2;
  const halfL = L / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-halfW - marginM, -halfL - marginM);
  shape.lineTo(halfW + marginM, -halfL - marginM);
  shape.lineTo(halfW + marginM, halfL + marginM);
  if (flareW > 0.001 && flareL > 0.001) {
    const alpha = Math.atan2(flareW, flareL);
    const swOuterX = -halfW - flareW - marginM * ((1 + Math.sin(alpha)) / Math.cos(alpha));
    const kinkOuterZ = halfL - flareL - marginM * Math.tan(alpha / 2);
    shape.lineTo(swOuterX, halfL + marginM);
    shape.lineTo(-halfW - marginM, kinkOuterZ);
  } else {
    shape.lineTo(-halfW - marginM, halfL + marginM);
  }
  shape.closePath();
  return shape;
}

export function buildRoom(roomConfig) {
  const root = new THREE.Group();
  root.name = 'RoomArchitecture';

  const W = roomConfig.widthIn * IN_TO_M;
  const L = roomConfig.lengthIn * IN_TO_M;
  const H = roomConfig.heightIn * IN_TO_M;
  const flareW = (roomConfig.swFlareWidthIn || 0) * IN_TO_M;
  const flareL = (roomConfig.swFlareLengthIn || 0) * IN_TO_M;
  const wallT = 4.5 * IN_TO_M;
  const stubH = 10 * IN_TO_M;

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xebe8e1,
    roughness: 0.88,
    metalness: 0.0,
  });
  const wallOuterMat = new THREE.MeshStandardMaterial({
    color: 0xd5d2cb,
    roughness: 0.92,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xf7f7f5,
    roughness: 0.45,
  });
  const woodFloorTex = createWoodFloorTextures();
  const floorMat = new THREE.MeshStandardMaterial({
    map: woodFloorTex,
    roughness: 0.56,
    metalness: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  // 1. EXACT 5-SIDED NON-RECTANGULAR FLOOR SLAB + PLINTH + RAYCAST HIT PLANE
  const floorShapeOuter = makeRoomFloorShape(W, L, flareW, flareL, wallT);
  const floorGeo = new THREE.ExtrudeGeometry(floorShapeOuter, { depth: 0.08, bevelEnabled: false });
  // Rotate +PI/2 around X: (sx, sy, sz) -> (sx, -sz, sy) so top sits at y=0 and bottom at y=-0.08, Z = sy!
  floorGeo.rotateX(Math.PI / 2);
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.receiveShadow = true;
  floorMesh.name = 'RoomFloor';
  root.add(floorMesh);

  const plinthMat = new THREE.MeshStandardMaterial({ color: 0xcbc7be, roughness: 0.9 });
  const plinthShape = makeRoomFloorShape(W, L, flareW, flareL, wallT + 0.015);
  const plinthGeo = new THREE.ExtrudeGeometry(plinthShape, { depth: 0.05, bevelEnabled: false });
  plinthGeo.rotateX(Math.PI / 2);
  const plinth = new THREE.Mesh(plinthGeo, plinthMat);
  plinth.position.y = -0.082;
  root.add(plinth);

  // Closet floor extension behind South wall (SE side — starts cleanly at z = L/2 + wallT with ZERO overlap with RoomFloor!)
  const closetD = roomConfig.closetDepthIn * IN_TO_M;
  const closetW = roomConfig.closetWidthIn * IN_TO_M;
  const closetRightX = W / 2 - roomConfig.closetOffsetFromEastIn * IN_TO_M;
  const closetCenterX = closetRightX - closetW / 2;

  const closetFloorShape = new THREE.Shape();
  const cfW = closetW + 0.25;
  const closetStartZ = L / 2 + wallT + 0.001;
  const closetEndZ = L / 2 + wallT + closetD + 0.04;
  closetFloorShape.moveTo(closetCenterX - cfW / 2, closetStartZ);
  closetFloorShape.lineTo(closetCenterX + cfW / 2, closetStartZ);
  closetFloorShape.lineTo(closetCenterX + cfW / 2, closetEndZ);
  closetFloorShape.lineTo(closetCenterX - cfW / 2, closetEndZ);
  closetFloorShape.closePath();
  const closetFloorGeo = new THREE.ExtrudeGeometry(closetFloorShape, { depth: 0.08, bevelEnabled: false });
  closetFloorGeo.rotateX(Math.PI / 2);
  const closetFloor = new THREE.Mesh(closetFloorGeo, floorMat);
  closetFloor.receiveShadow = true;
  root.add(closetFloor);

  // Invisible 5-sided floor hit plane for accurate raycasting even inside the flared SW corner!
  const hitShape = makeRoomFloorShape(W, L, flareW, flareL, 0.04);
  const hitGeo = new THREE.ShapeGeometry(hitShape);
  hitGeo.rotateX(Math.PI / 2);
  const hitPlane = new THREE.Mesh(
    hitGeo,
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  hitPlane.position.y = 0.002;
  hitPlane.name = 'FloorHitPlane';
  root.add(hitPlane);

  // 2. WALL GROUPS
  const wallEntries = [];
  function registerWall(name, inwardNormal, fullGroup, stubGroup) {
    const holder = new THREE.Group();
    holder.name = name;
    holder.add(fullGroup);
    holder.add(stubGroup);
    stubGroup.visible = false;
    root.add(holder);
    wallEntries.push({ name, inwardNormal, fullGroup, stubMesh: stubGroup });
  }

  // --- NORTH WALL (z = -L/2, inward normal = (0, 0, +1)) ---
  const nw = roomConfig.northWindow;
  const nwCenterX = -W / 2 + (nw.offsetFromWestIn + nw.widthIn / 2) * IN_TO_M;
  const nwOpening = {
    cx: nwCenterX,
    y0: nw.sillIn * IN_TO_M,
    w: nw.widthIn * IN_TO_M,
    h: nw.heightIn * IN_TO_M,
  };
  const northFull = buildWallWithOpenings(W + wallT * 2, H, wallT, [nwOpening], wallMat, trimMat);
  northFull.position.set(0, 0, -L / 2 - wallT / 2);

  const northWin = createWindowAssembly(nwOpening.w, nwOpening.h, wallT, {
    mullion: true,
    hasSheerCurtains: true,
    curtainRodExtraM: 0.22,
  });
  northWin.position.set(nwCenterX, nwOpening.y0 + nwOpening.h / 2, 0);
  northFull.add(northWin);

  const outlet = new THREE.Mesh(new THREE.BoxGeometry(2.75 * IN_TO_M, 4.5 * IN_TO_M, 0.008), trimMat);
  outlet.position.set(nwCenterX + 0.08, 10 * IN_TO_M, wallT / 2 + 0.004);
  northFull.add(outlet);

  const northStub = new THREE.Mesh(new THREE.BoxGeometry(W + wallT * 2, stubH, wallT), wallOuterMat);
  northStub.position.set(0, stubH / 2, -L / 2 - wallT / 2);
  northStub.receiveShadow = true;
  registerWall('NorthWall', new THREE.Vector3(0, 0, 1), northFull, northStub);

  // --- WEST WALL (Unified exact-mitered Straight + Angled SW Entry Wall + Triangular Overhead Soffit!) ---
  const westFullContainer = new THREE.Group();
  const westStubContainer = new THREE.Group();

  const straightWestLen = L - flareL;
  const straightCenterZ = -L / 2 + straightWestLen / 2;
  const baseH = 4.5 * IN_TO_M;
  const baseD = 0.55 * IN_TO_M;
  const swCornerWorldX = -W / 2 - flareW;

  if (flareW > 0.001 && flareL > 0.001) {
    const alpha = Math.atan2(flareW, flareL);
    const swOuterX = swCornerWorldX - wallT * ((1 + Math.sin(alpha)) / Math.cos(alpha));
    const kinkOuterZ = L / 2 - flareL - wallT * Math.tan(alpha / 2);

    const westPoly = new THREE.Shape();
    westPoly.moveTo(-W / 2, -L / 2);
    westPoly.lineTo(-W / 2, L / 2 - flareL);
    westPoly.lineTo(swCornerWorldX, L / 2);
    westPoly.lineTo(swCornerWorldX, L / 2 + wallT);
    westPoly.lineTo(swOuterX, L / 2 + wallT);
    westPoly.lineTo(-W / 2 - wallT, kinkOuterZ);
    westPoly.lineTo(-W / 2 - wallT, -L / 2);
    westPoly.closePath();

    const westFullGeo = new THREE.ExtrudeGeometry(westPoly, { depth: H, bevelEnabled: false });
    westFullGeo.rotateX(Math.PI / 2);
    const westFullMesh = new THREE.Mesh(westFullGeo, wallMat);
    westFullMesh.position.y = H;
    westFullMesh.castShadow = true;
    westFullMesh.receiveShadow = true;
    westFullContainer.add(westFullMesh);

    const westStubGeo = new THREE.ExtrudeGeometry(westPoly, { depth: stubH, bevelEnabled: false });
    westStubGeo.rotateX(Math.PI / 2);
    const westStubMesh = new THREE.Mesh(westStubGeo, wallOuterMat);
    westStubMesh.position.y = stubH;
    westStubMesh.receiveShadow = true;
    westStubContainer.add(westStubMesh);

    // Flush inner baseboards along straight West wall & angled SW wall (zero corner protrusion!)
    const bmStraight = new THREE.Mesh(new THREE.BoxGeometry(baseD, baseH, straightWestLen), trimMat);
    bmStraight.position.set(-W / 2 + baseD / 2, baseH / 2, straightCenterZ);
    bmStraight.receiveShadow = true;
    westFullContainer.add(bmStraight);

    const p1x = -W / 2;
    const p1z = L / 2 - flareL;
    const p2x = swCornerWorldX;
    const p2z = L / 2;
    const segLen = Math.hypot(flareW, flareL);
    const nx = flareL / segLen;
    const nz = flareW / segLen;
    const angleY = Math.atan2(nx, nz);

    const bmAngled = new THREE.Mesh(new THREE.BoxGeometry(segLen, baseH, baseD), trimMat);
    bmAngled.rotation.y = angleY;
    bmAngled.position.set((p1x + p2x) / 2 + nx * (baseD / 2), baseH / 2, (p1z + p2z) / 2 + nz * (baseD / 2));
    bmAngled.receiveShadow = true;
    westFullContainer.add(bmAngled);

    // Exact Triangular Overhead Soffit above the angled SW entry pocket (inset 2mm so zero z-fighting with walls/ceiling!)
    const soffitH = 10.5 * IN_TO_M;
    const sofShape = new THREE.Shape();
    sofShape.moveTo(-W / 2 + 0.002, L / 2 - 0.002);
    sofShape.lineTo(swCornerWorldX + 0.006, L / 2 - 0.002);
    sofShape.lineTo(-W / 2 + 0.002, L / 2 - flareL + 0.006);
    sofShape.closePath();
    const sofGeo = new THREE.ExtrudeGeometry(sofShape, { depth: soffitH, bevelEnabled: false });
    sofGeo.rotateX(Math.PI / 2);
    const soffitMesh = new THREE.Mesh(sofGeo, wallMat);
    soffitMesh.position.y = H - 0.002;
    soffitMesh.receiveShadow = true;
    westFullContainer.add(soffitMesh);
  } else {
    const westStraight = buildWallWithOpenings(L, H, wallT, [], wallMat, trimMat);
    westStraight.rotation.y = Math.PI / 2;
    westStraight.position.set(-W / 2 - wallT / 2, 0, 0);
    westFullContainer.add(westStraight);

    const westStraightStub = new THREE.Mesh(new THREE.BoxGeometry(wallT, stubH, L), wallOuterMat);
    westStraightStub.position.set(-W / 2 - wallT / 2, stubH / 2, 0);
    westStraightStub.receiveShadow = true;
    westStubContainer.add(westStraightStub);
  }

  registerWall('WestWall', new THREE.Vector3(1, 0, 0), westFullContainer, westStubContainer);

  // --- EAST WALL (x = +W/2, inward normal = (-1, 0, 0)) ---
  const ew = roomConfig.eastWindow;
  const ewCenterLocalX = L / 2 - (ew.offsetFromSouthIn + ew.widthIn / 2) * IN_TO_M;
  const ewOpening = {
    cx: ewCenterLocalX,
    y0: ew.sillIn * IN_TO_M,
    w: ew.widthIn * IN_TO_M,
    h: ew.heightIn * IN_TO_M,
  };
  const eastFull = buildWallWithOpenings(L, H, wallT, [ewOpening], wallMat, trimMat);
  eastFull.rotation.y = -Math.PI / 2;
  eastFull.position.set(W / 2 + wallT / 2, 0, 0);

  const eastWin = createWindowAssembly(ewOpening.w, ewOpening.h, wallT, {
    hasBlinds: true,
    hasSheerCurtains: false,
    curtainRodExtraM: 0.24,
  });
  eastWin.position.set(ewCenterLocalX, ewOpening.y0 + ewOpening.h / 2, 0);
  eastFull.add(eastWin);

  const eastStub = new THREE.Mesh(new THREE.BoxGeometry(wallT, stubH, L), wallOuterMat);
  eastStub.position.set(W / 2 + wallT / 2, stubH / 2, 0);
  eastStub.receiveShadow = true;
  registerWall('EastWall', new THREE.Vector3(-1, 0, 0), eastFull, eastStub);

  // --- SOUTH WALL (Spans from flared SW inner corner to SE outer edge, zero overlap with mitered West wall!) ---
  const southLeftX = flareW > 0.001 && flareL > 0.001 ? swCornerWorldX : -W / 2 - wallT;
  const southRightX = W / 2 + wallT;
  const southFullW = southRightX - southLeftX;
  const southCenterWorldX = (southLeftX + southRightX) / 2;
  const doorH = 80 * IN_TO_M;
  const entryW = roomConfig.entryDoorWidthIn * IN_TO_M;

  // World X coordinates of openings on South wall:
  const entryWorldCenterX = swCornerWorldX + (roomConfig.entryDoorOffsetFromWestIn + roomConfig.entryDoorWidthIn / 2) * IN_TO_M;

  // In southFull (rotated PI around Y, centered at southCenterWorldX): localX = -(worldX - southCenterWorldX)
  const entryCenterLocalX = -(entryWorldCenterX - southCenterWorldX);
  const closetCenterLocalX = -(closetCenterX - southCenterWorldX);

  const doorCasingIn = roomConfig.entryDoorCasingWidthIn || 2.75;
  const doorCasingM = doorCasingIn * IN_TO_M;
  const southOpenings = [
    { cx: entryCenterLocalX, y0: 0, w: entryW, h: doorH, hasCasing: true, casingPadM: doorCasingM + 0.002 },
    // Closet opening has no frame/moulding IRL (clean drywall return), so baseboard runs flush to edge!
    { cx: closetCenterLocalX, y0: 0, w: closetW, h: doorH, hasCasing: false, casingPadM: 0 },
  ];
  const southFull = buildWallWithOpenings(southFullW, H, wallT, southOpenings, wallMat, trimMat);
  southFull.rotation.y = Math.PI;
  southFull.position.set(southCenterWorldX, 0, L / 2 + wallT / 2);

  for (const op of southOpenings) {
    if (!op.hasCasing) continue;
    const cw = doorCasingM;
    const cd = 0.7 * IN_TO_M;
    const topC = new THREE.Mesh(new THREE.BoxGeometry(op.w + cw * 2, cw, cd), trimMat);
    topC.position.set(op.cx, op.h + cw / 2, wallT / 2 + cd / 2 + 0.001);
    const lC = new THREE.Mesh(new THREE.BoxGeometry(cw, op.h - 0.002, cd), trimMat);
    lC.position.set(op.cx - op.w / 2 - cw / 2, op.h / 2 + 0.001, wallT / 2 + cd / 2 + 0.001);
    const rC = new THREE.Mesh(new THREE.BoxGeometry(cw, op.h - 0.002, cd), trimMat);
    rC.position.set(op.cx + op.w / 2 + cw / 2, op.h / 2 + 0.001, wallT / 2 + cd / 2 + 0.001);
    southFull.add(topC, lC, rC);
  }

  // Light switch sits near the door-frame side of the exact 23" switch wall between closet & door frame
  const switchWallLeft = closetCenterLocalX + closetW / 2;
  const switchWallRight = entryCenterLocalX - entryW / 2 - doorCasingM;
  const midWallX = (switchWallLeft + switchWallRight) / 2;
  const switchPlate = new THREE.Mesh(new THREE.BoxGeometry(2.75 * IN_TO_M, 4.5 * IN_TO_M, 0.008), trimMat);
  switchPlate.position.set(switchWallRight - 4.5 * IN_TO_M, 42 * IN_TO_M, wallT / 2 + 0.005);
  southFull.add(switchPlate);

  // Frosted-Glass Entry Door (pivoted at flared SW West jamb, 12mm floor undercut so zero wood-floor z-fighting!)
  const entryDoorPivot = new THREE.Group();
  entryDoorPivot.position.set(entryCenterLocalX + entryW / 2, 0.012, wallT / 2);
  const doorLeafH = doorH - 0.016;
  const doorThick = 1.5 * IN_TO_M;
  const stileW = 4.5 * IN_TO_M;
  const railH = 5.5 * IN_TO_M;
  const frostedGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0xe6ecee,
    roughness: 0.55,
    transparent: true,
    opacity: 0.72,
  });
  const doorGroup = new THREE.Group();
  const dLeft = new THREE.Mesh(new THREE.BoxGeometry(stileW, doorLeafH, doorThick), trimMat);
  dLeft.position.set(-stileW / 2, doorLeafH / 2, 0);
  const dRight = new THREE.Mesh(new THREE.BoxGeometry(stileW, doorLeafH, doorThick), trimMat);
  dRight.position.set(-entryW + stileW / 2, doorLeafH / 2, 0);
  const innerDoorW = entryW - stileW * 2 - 0.002;
  const dTop = new THREE.Mesh(new THREE.BoxGeometry(innerDoorW, railH, doorThick), trimMat);
  dTop.position.set(-entryW / 2, doorLeafH - railH / 2, 0);
  const dBot = new THREE.Mesh(new THREE.BoxGeometry(innerDoorW, railH * 1.4, doorThick), trimMat);
  dBot.position.set(-entryW / 2, (railH * 1.4) / 2, 0);
  const dGlass = new THREE.Mesh(
    new THREE.BoxGeometry(innerDoorW, doorLeafH - railH * 2.4 - 0.004, 0.01),
    frostedGlassMat
  );
  dGlass.position.set(-entryW / 2, railH * 1.4 + (doorLeafH - railH * 2.4) / 2, 0);
  const knobMat = new THREE.MeshStandardMaterial({ color: 0xb8bdc2, metalness: 0.8, roughness: 0.25 });
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 12), knobMat);
  knob.position.set(-entryW + 0.075, 36 * IN_TO_M, doorThick / 2 + 0.03);
  doorGroup.add(dLeft, dRight, dTop, dBot, dGlass, knob);
  entryDoorPivot.add(doorGroup);

  // Max open angle matches the angled SW wall (~75.4 degrees inward!)
  const maxDoorOpenRad = flareW > 0 && flareL > 0 ? Math.atan2(flareL, flareW) - 0.04 : 1.42;
  entryDoorPivot.rotation.y = maxDoorOpenRad * 0.96;
  southFull.add(entryDoorPivot);

  // Reach-In Closet Interior Enclosure + Shelves + Rod + Existing Oak Dresser (non-overlapping corner joints!)
  const closetBoxGroup = new THREE.Group();
  closetBoxGroup.position.set(closetCenterLocalX, 0, -wallT / 2);
  const cInnerW = closetW + 0.22;
  const closetWallMat = new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.92 });
  const cBack = new THREE.Mesh(new THREE.BoxGeometry(cInnerW + 0.08, H - 0.08, 0.08), closetWallMat);
  cBack.position.set(0, (H - 0.08) / 2 + 0.002, -closetD - 0.04);
  const cLeft = new THREE.Mesh(new THREE.BoxGeometry(0.08, H - 0.08, closetD), closetWallMat);
  cLeft.position.set(-cInnerW / 2 - 0.04, (H - 0.08) / 2 + 0.002, -closetD / 2);
  const cRight = new THREE.Mesh(new THREE.BoxGeometry(0.08, H - 0.08, closetD), closetWallMat);
  cRight.position.set(cInnerW / 2 + 0.04, (H - 0.08) / 2 + 0.002, -closetD / 2);
  const cTop = new THREE.Mesh(new THREE.BoxGeometry(cInnerW + 0.16, 0.078, closetD + 0.08), closetWallMat);
  cTop.position.set(0, H - 0.039, -closetD / 2 - 0.04);
  closetBoxGroup.add(cBack, cLeft, cRight, cTop);

  const oakMat = new THREE.MeshStandardMaterial({ color: 0xb58654, roughness: 0.65 });
  const shelf1 = new THREE.Mesh(new THREE.BoxGeometry(cInnerW - 0.01, 0.03, closetD * 0.65), oakMat);
  shelf1.position.set(0, 74 * IN_TO_M, -closetD * 0.65);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, cInnerW - 0.01, 10), oakMat);
  rod.rotation.z = Math.PI / 2;
  rod.position.set(0, 65 * IN_TO_M, -closetD * 0.45);
  const closetDresser = new THREE.Mesh(
    new THREE.BoxGeometry(45 * IN_TO_M, 46 * IN_TO_M, 18.5 * IN_TO_M),
    oakMat
  );
  closetDresser.position.set(-0.04, 23 * IN_TO_M + 0.004, -closetD + 10.5 * IN_TO_M);
  closetBoxGroup.add(shelf1, rod, closetDresser);
  southFull.add(closetBoxGroup);

  const panelW = closetW / 4;
  const bifoldMat = new THREE.MeshStandardMaterial({ color: 0xf7f7f5, roughness: 0.42 });
  const blackKnobMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4 });

  function makeBifoldSide(sideSign) {
    const pivot1 = new THREE.Group();
    pivot1.position.set(closetCenterLocalX + sideSign * (closetW / 2), 0.012, wallT / 2);
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(panelW - 0.008, doorH - 0.024, 0.03), bifoldMat);
    p1.position.set(-sideSign * (panelW / 2), (doorH - 0.024) / 2, 0);
    p1.castShadow = true;
    pivot1.add(p1);

    const pivot2 = new THREE.Group();
    pivot2.position.set(-sideSign * panelW, 0, 0);
    const p2 = new THREE.Mesh(new THREE.BoxGeometry(panelW - 0.008, doorH - 0.024, 0.03), bifoldMat);
    p2.position.set(-sideSign * (panelW / 2), (doorH - 0.024) / 2, 0);
    p2.castShadow = true;
    const knob2 = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 8), blackKnobMat);
    knob2.position.set(-sideSign * (panelW * 0.55), 38 * IN_TO_M, 0.022);
    pivot2.add(p2, knob2);
    pivot1.add(pivot2);
    return { pivot1, pivot2, sideSign };
  }

  const bifoldLeft = makeBifoldSide(-1);
  const bifoldRight = makeBifoldSide(1);
  southFull.add(bifoldLeft.pivot1, bifoldRight.pivot1);

  const southStub = new THREE.Mesh(new THREE.BoxGeometry(southFullW, stubH, wallT), wallOuterMat);
  southStub.position.set(southCenterWorldX, stubH / 2, L / 2 + wallT / 2);
  southStub.receiveShadow = true;
  registerWall('SouthWall', new THREE.Vector3(0, 0, -1), southFull, southStub);

  // 3. CEILING + RECESSED LED LIGHT (5-sided shape matching room!)
  const ceilingGroup = new THREE.Group();
  ceilingGroup.name = 'RoomCeiling';
  const ceilGeo = new THREE.ShapeGeometry(makeRoomFloorShape(W, L, flareW, flareL, 0));
  ceilGeo.rotateX(Math.PI / 2);
  const ceilingMesh = new THREE.Mesh(
    ceilGeo,
    new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: 0.92, side: THREE.DoubleSide })
  );
  ceilingMesh.position.y = H + 0.001;
  ceilingGroup.add(ceilingMesh);

  const ledFixture = new THREE.Mesh(
    new THREE.CylinderGeometry(0.11, 0.11, 0.012, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff8e7 })
  );
  ledFixture.position.set(0.25, H - 0.007, L / 2 - 1.25);
  ceilingGroup.add(ledFixture);
  ceilingGroup.visible = false;
  root.add(ceilingGroup);

  // 4. ARCHITECTURAL FLOOR GRID (clipped cleanly to exact 5-sided non-rectangular floor!)
  const gridGroup = new THREE.Group();
  gridGroup.name = 'FloorGrid';
  const gridPoints = [];
  const halfWIn = roomConfig.widthIn / 2;
  const halfLIn = roomConfig.lengthIn / 2;
  const flareWIn = roomConfig.swFlareWidthIn || 0;
  const flareLIn = roomConfig.swFlareLengthIn || 0;

  // North-South lines (X fixed, clipped against angled SW wall if X < -halfWIn)
  for (let xIn = -Math.floor((halfWIn + flareWIn) / 12) * 12; xIn <= halfWIn; xIn += 12) {
    let zStartIn = -halfLIn;
    if (xIn < -halfWIn && flareWIn > 0) {
      const t = (-halfWIn - xIn) / flareWIn;
      zStartIn = halfLIn - flareLIn + t * flareLIn;
    }
    if (zStartIn < halfLIn) {
      gridPoints.push(xIn * IN_TO_M, 0.005, zStartIn * IN_TO_M, xIn * IN_TO_M, 0.005, halfLIn * IN_TO_M);
    }
  }
  // East-West lines (Z fixed, West endpoint follows getWestWallXAtZ!)
  for (let zIn = -Math.floor(halfLIn / 12) * 12; zIn <= halfLIn; zIn += 12) {
    const westXIn = getWestWallXAtZ(zIn, roomConfig);
    gridPoints.push(westXIn * IN_TO_M, 0.005, zIn * IN_TO_M, halfWIn * IN_TO_M, 0.005, zIn * IN_TO_M);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPoints, 3));
  const gridLines = new THREE.LineSegments(
    gridGeo,
    new THREE.LineBasicMaterial({ color: 0x263544, transparent: true, opacity: 0.34, depthWrite: false })
  );
  gridLines.renderOrder = 1;
  gridGroup.add(gridLines);
  root.add(gridGroup);

  // 5. DOOR SWING & CLOSET CLEARANCE ZONES (anchored to flared SW hinge, clean depth offset above floor!)
  const clearanceGroup = new THREE.Group();
  clearanceGroup.name = 'ClearanceZones';

  const hingeWorldX = swCornerWorldX + roomConfig.entryDoorOffsetFromWestIn * IN_TO_M;
  const hingeWorldZ = L / 2;
  const sweepAngle = maxDoorOpenRad;
  const arcShape = new THREE.Shape();
  arcShape.moveTo(0, 0);
  arcShape.absarc(0, 0, entryW, 0, sweepAngle, false);
  arcShape.lineTo(0, 0);
  const arcGeo = new THREE.ShapeGeometry(arcShape, 32);
  const arcMesh = new THREE.Mesh(
    arcGeo,
    new THREE.MeshBasicMaterial({
      color: 0xe69524,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
  );
  arcMesh.rotation.x = -Math.PI / 2;
  arcMesh.position.set(hingeWorldX, 0.008, hingeWorldZ);
  arcMesh.renderOrder = 2;
  clearanceGroup.add(arcMesh);

  const arcPts = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * sweepAngle;
    arcPts.push(new THREE.Vector3(hingeWorldX + Math.cos(a) * entryW, 0.011, hingeWorldZ - Math.sin(a) * entryW));
  }
  const arcLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(arcPts),
    new THREE.LineBasicMaterial({ color: 0xd97706, transparent: true, opacity: 0.65, depthWrite: false })
  );
  arcLine.renderOrder = 3;
  clearanceGroup.add(arcLine);

  const closetClearDepth = 15 * IN_TO_M;
  const closetClearMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(closetW, closetClearDepth),
    new THREE.MeshBasicMaterial({
      color: 0x2563eb,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
  );
  closetClearMesh.rotation.x = -Math.PI / 2;
  closetClearMesh.position.set(closetCenterX, 0.008, L / 2 - closetClearDepth / 2);
  closetClearMesh.renderOrder = 2;
  clearanceGroup.add(closetClearMesh);

  const cOutline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(closetW, closetClearDepth)),
    new THREE.LineBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.45, depthWrite: false })
  );
  cOutline.rotation.x = -Math.PI / 2;
  cOutline.position.set(closetCenterX, 0.011, L / 2 - closetClearDepth / 2);
  cOutline.renderOrder = 3;
  clearanceGroup.add(cOutline);

  root.add(clearanceGroup);

  function setClosetOpen(openFactor) {
    const a1 = openFactor * 1.38;
    const a2 = -openFactor * 2.68;
    bifoldLeft.pivot1.rotation.y = -a1;
    bifoldLeft.pivot2.rotation.y = -a2;
    bifoldRight.pivot1.rotation.y = a1;
    bifoldRight.pivot2.rotation.y = a2;
  }
  setClosetOpen(0.82);

  function setEntryDoorOpen(openFactor) {
    entryDoorPivot.rotation.y = openFactor * maxDoorOpenRad;
  }

  function updateWallVisibility(mode, cameraPos, showCeiling = false) {
    ceilingGroup.visible = showCeiling;
    if (mode === 'up') {
      for (const w of wallEntries) {
        w.fullGroup.visible = true;
        w.stubMesh.visible = false;
      }
      return;
    }
    if (mode === 'down') {
      for (const w of wallEntries) {
        w.fullGroup.visible = false;
        w.stubMesh.visible = true;
      }
      return;
    }
    const toCam = new THREE.Vector3(cameraPos.x, 0, cameraPos.z).normalize();
    for (const w of wallEntries) {
      const dot = w.inwardNormal.dot(toCam);
      const cut = dot < -0.2;
      w.fullGroup.visible = !cut;
      w.stubMesh.visible = cut;
    }
  }

  function setLightingMood(mood) {
    const skyColor = mood === 'day' ? 0xeaf4ff : 0x182232;
    root.traverse((obj) => {
      if (obj.name === 'windowSkyBackdrop' && obj.material) {
        obj.material.color.setHex(skyColor);
      }
    });
  }

  return {
    root,
    hitPlane,
    gridGroup,
    clearanceGroup,
    updateWallVisibility,
    setClosetOpen,
    setEntryDoorOpen,
    setLightingMood,
  };
}
