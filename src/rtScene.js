// Shared Scene Geometry, PBR Material Extractor & Flat Iterative BVH Builder
// Consumed identically by both the GPU Path Tracer (WebGPU WGSL / WebGL2 GLSL)
// and the Multi-Core CPU PBR Photo-Mode Path Tracer.

import * as THREE from 'three';
import { IN_TO_M } from './catalog.js';

const tmpV0 = new THREE.Vector3();
const tmpV1 = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpN0 = new THREE.Vector3();
const tmpN1 = new THREE.Vector3();
const tmpN2 = new THREE.Vector3();
const tmpE1 = new THREE.Vector3();
const tmpE2 = new THREE.Vector3();
const tmpFaceN = new THREE.Vector3();
const tmpNormMat = new THREE.Matrix3();
const tmpCol = new THREE.Color();

function shouldSkipObject(obj) {
  if (!obj.visible) return true;
  if (obj.userData?.isHelper || obj.userData?.isClearance || obj.userData?.isGrid || obj.userData?.isFootprint) {
    return true;
  }
  const nm = (obj.name || '').toLowerCase();
  if (
    nm.includes('grid') ||
    nm.includes('clearance') ||
    nm.includes('footprint') ||
    nm.includes('guide') ||
    nm.includes('skybackdrop') ||
    nm.includes('hitplane')
  ) {
    return true;
  }
  return false;
}

function classifyMaterial(mat, mesh) {
  const col = mat.color ? tmpCol.copy(mat.color) : tmpCol.setRGB(0.85, 0.85, 0.85);
  // Three.js Color stores linear RGB; convert gently or keep linear for PBR math!
  const r = Math.max(0.01, Math.min(1, col.r));
  const g = Math.max(0.01, Math.min(1, col.g));
  const b = Math.max(0.01, Math.min(1, col.b));

  const isTransparent = !!mat.transparent && (mat.opacity ?? 1) < 0.78;
  const isGlass = isTransparent && (mat.roughness ?? 0.5) < 0.35;
  let roughness = Math.max(0.04, Math.min(0.98, mat.roughness ?? (mat.isMeshBasicMaterial ? 0.6 : 0.55)));
  if (mat.roughnessMap && mat.roughnessMap.image instanceof HTMLCanvasElement) {
    try {
      const rImg = mat.roughnessMap.image;
      const rCtx = rImg.getContext('2d');
      const rPx = rCtx.getImageData(Math.floor(rImg.width * 0.5), Math.floor(rImg.height * 0.5), 1, 1).data;
      roughness = Math.max(0.04, Math.min(0.98, (rPx[0] / 255) * (mat.roughness ?? 1.0)));
    } catch (_) {}
  }
  const metalness = Math.max(0, Math.min(1, mat.metalness ?? 0.02));

  let emR = 0;
  let emG = 0;
  let emB = 0;
  if (mat.emissive && (mat.emissiveIntensity ?? 0) > 0.05) {
    const ei = mat.emissiveIntensity;
    emR = mat.emissive.r * ei * 2.2;
    emG = mat.emissive.g * ei * 2.2;
    emB = mat.emissive.b * ei * 2.2;
  } else if (mat.isMeshBasicMaterial && mesh.name === 'lampBulb') {
    emR = r * 5.0;
    emG = g * 4.2;
    emB = b * 3.0;
  }

  // Detect textured wood / hardwood floor so shaders render sharp procedural 3D oak grain!
  let woodStrength = 0;
  let woodScale = 1.0;
  let baseR = r;
  let baseG = g;
  let baseB = b;

  if (mat.map && mat.map.image) {
    // Sample 5x5 average color from canvas texture if available (procedural oak, TONSTAD veneer, rugs & floor!)
    const img = mat.map.image;
    if (img instanceof HTMLCanvasElement) {
      try {
        const ctx = img.getContext('2d');
        let srSum = 0, sgSum = 0, sbSum = 0, cnt = 0;
        for (let gy = 1; gy <= 5; gy++) {
          for (let gx = 1; gx <= 5; gx++) {
            const px = ctx.getImageData(
              Math.floor((img.width * gx) / 6),
              Math.floor((img.height * gy) / 6),
              1,
              1
            ).data;
            srSum += px[0] / 255;
            sgSum += px[1] / 255;
            sbSum += px[2] / 255;
            cnt++;
          }
        }
        const sr = cnt ? srSum / cnt : 0.7;
        const sg = cnt ? sgSum / cnt : 0.7;
        const sb = cnt ? sbSum / cnt : 0.7;
        // Convert sRGB sample -> linear
        baseR = Math.pow(sr, 2.2) * r;
        baseG = Math.pow(sg, 2.2) * g;
        baseB = Math.pow(sb, 2.2) * b;

        const kind = mat.map.userData?.kind;
        if (kind === 'tonstad_wood') {
          woodStrength = mat.map.userData.woodStrength ?? 0.22;
          woodScale = mat.map.userData.woodScale ?? 1.35;
        } else if (kind === 'rug_photo') {
          woodStrength = 0.06;
          woodScale = 3.5;
        } else if (kind === 'wood_basic') {
          woodStrength = 0.16;
          woodScale = 1.0;
        } else if (img.width === 512 && img.height === 512) {
          woodStrength = 0.24; // oak floor planks
          woodScale = 2.0;
        } else if (img.width === 256 && img.height === 256) {
          woodStrength = 0.16; // brushed IKEA oak veneer
          woodScale = 1.0;
        } else {
          woodStrength = 0.1; // geo rug
          woodScale = 3.0;
        }
      } catch (_) {}
    }
  }

  const transmission = isGlass ? 0.92 : isTransparent ? 0.5 : 0.0;
  const ior = isGlass ? 1.5 : 1.0;

  return {
    r: baseR,
    g: baseG,
    b: baseB,
    roughness,
    emR,
    emG,
    emB,
    metalness,
    transmission,
    ior,
    woodStrength,
    woodScale,
  };
}

export function buildRTScene(roots, room, lightingMood = 'day', wallMode = 'cutaway') {
  const tStart = performance.now();
  const matMap = new Map();
  const materials = [];

  const getMatIndex = (mat, mesh) => {
    const key = mat.uuid + (mesh.name === 'lampBulb' ? '_bulb' : '');
    if (matMap.has(key)) return matMap.get(key);
    const idx = materials.length;
    materials.push(classifyMaterial(mat, mesh));
    matMap.set(key, idx);
    return idx;
  };

  // Raw triangle arrays (temporary JS arrays before packing)
  const rawTris = [];
  const lampLights = [];

  const visit = (node) => {
    if (!node || shouldSkipObject(node)) return;

    // Collect active furniture point lights for evening emitters
    if (node.isPointLight && node.intensity > 0.05) {
      node.updateWorldMatrix(true, false);
      const p = new THREE.Vector3();
      node.getWorldPosition(p);
      lampLights.push({
        x: p.x,
        y: p.y,
        z: p.z,
        r: node.color.r * node.intensity * 1.4,
        g: node.color.g * node.intensity * 1.4,
        b: node.color.b * node.intensity * 1.4,
        radius: 0.14,
      });
    }

    if (node.isMesh && node.geometry && node.material && !node.isLine) {
      const mat = Array.isArray(node.material)
        ? (node.material[2]?.map?.userData?.kind === 'rug_photo' ? node.material[2] : node.material[0])
        : node.material;
      // Skip ultra-faint helper overlays / UI decals
      if (mat && !(mat.transparent && (mat.opacity ?? 1) < 0.08)) {
        const geo = node.geometry;
        const posAttr = geo.attributes.position;
        if (posAttr && posAttr.count >= 3) {
          node.updateWorldMatrix(true, false);
          const worldMat = node.matrixWorld;
          tmpNormMat.getNormalMatrix(worldMat);
          const normAttr = geo.attributes.normal;
          const idxAttr = geo.index;
          const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
          const matIdx = getMatIndex(mat, node);

          for (let t = 0; t < triCount; t++) {
            const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
            const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
            const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

            tmpV0.fromBufferAttribute(posAttr, i0).applyMatrix4(worldMat);
            tmpV1.fromBufferAttribute(posAttr, i1).applyMatrix4(worldMat);
            tmpV2.fromBufferAttribute(posAttr, i2).applyMatrix4(worldMat);

            tmpE1.subVectors(tmpV1, tmpV0);
            tmpE2.subVectors(tmpV2, tmpV0);
            tmpFaceN.crossVectors(tmpE1, tmpE2);
            const area2 = tmpFaceN.length();
            if (area2 < 1e-8) continue;
            tmpFaceN.divideScalar(area2);

            let nx = tmpFaceN.x;
            let ny = tmpFaceN.y;
            let nz = tmpFaceN.z;
            if (normAttr) {
              tmpN0.fromBufferAttribute(normAttr, i0).applyMatrix3(tmpNormMat).normalize();
              tmpN1.fromBufferAttribute(normAttr, i1).applyMatrix3(tmpNormMat).normalize();
              tmpN2.fromBufferAttribute(normAttr, i2).applyMatrix3(tmpNormMat).normalize();
              // Average smooth vertex normal aligned with geometric face normal
              const ax = tmpN0.x + tmpN1.x + tmpN2.x;
              const ay = tmpN0.y + tmpN1.y + tmpN2.y;
              const az = tmpN0.z + tmpN1.z + tmpN2.z;
              const al = Math.hypot(ax, ay, az);
              if (al > 1e-5) {
                nx = ax / al;
                ny = ay / al;
                nz = az / al;
              }
            }

            const minX = Math.min(tmpV0.x, tmpV1.x, tmpV2.x);
            const minY = Math.min(tmpV0.y, tmpV1.y, tmpV2.y);
            const minZ = Math.min(tmpV0.z, tmpV1.z, tmpV2.z);
            const maxX = Math.max(tmpV0.x, tmpV1.x, tmpV2.x);
            const maxY = Math.max(tmpV0.y, tmpV1.y, tmpV2.y);
            const maxZ = Math.max(tmpV0.z, tmpV1.z, tmpV2.z);

            rawTris.push({
              v0x: tmpV0.x, v0y: tmpV0.y, v0z: tmpV0.z,
              e1x: tmpE1.x, e1y: tmpE1.y, e1z: tmpE1.z,
              e2x: tmpE2.x, e2y: tmpE2.y, e2z: tmpE2.z,
              nx, ny, nz,
              matIdx,
              minX, minY, minZ, maxX, maxY, maxZ,
              cx: (minX + maxX) * 0.5,
              cy: (minY + maxY) * 0.5,
              cz: (minZ + maxZ) * 0.5,
            });
          }
        }
      }
    }

    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        visit(node.children[i]);
      }
    }
  };

  for (const r of roots) {
    if (r) visit(r);
  }

  // Fallback tiny ground triangle if scene is somehow empty
  if (rawTris.length === 0) {
    materials.push({ r: 0.8, g: 0.8, b: 0.8, roughness: 0.8, emR: 0, emG: 0, emB: 0, metalness: 0, transmission: 0, ior: 1, woodStrength: 0, woodScale: 1 });
    rawTris.push({
      v0x: -1, v0y: 0, v0z: -1, e1x: 2, e1y: 0, e1z: 0, e2x: 0, e2y: 0, e2z: 2,
      nx: 0, ny: 1, nz: 0, matIdx: 0,
      minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 0, maxZ: 1, cx: 0, cy: 0, cz: 0,
    });
  }

  // Build flat iterative binary BVH (binned midpoint split along longest centroid axis)
  const nTris = rawTris.length;
  const triIndices = new Int32Array(nTris);
  for (let i = 0; i < nTris; i++) triIndices[i] = i;

  // Max nodes <= 2 * nTris
  const maxNodes = Math.max(4, nTris * 2);
  // Each node: 8 floats = [minX, minY, minZ, leftOrFirst, maxX, maxY, maxZ, triCount]
  // Note: leftOrFirst and triCount are stored as exact integer-valued floats (safe up to 16M triangles!)
  const nodeBuf = new Float32Array(maxNodes * 8);
  let nodeCount = 1;

  const updateBounds = (nodeIdx, start, count) => {
    let minX = 1e9, minY = 1e9, minZ = 1e9;
    let maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (let i = start; i < start + count; i++) {
      const tr = rawTris[triIndices[i]];
      if (tr.minX < minX) minX = tr.minX;
      if (tr.minY < minY) minY = tr.minY;
      if (tr.minZ < minZ) minZ = tr.minZ;
      if (tr.maxX > maxX) maxX = tr.maxX;
      if (tr.maxY > maxY) maxY = tr.maxY;
      if (tr.maxZ > maxZ) maxZ = tr.maxZ;
    }
    const o = nodeIdx * 8;
    nodeBuf[o] = minX - 1e-4;
    nodeBuf[o + 1] = minY - 1e-4;
    nodeBuf[o + 2] = minZ - 1e-4;
    nodeBuf[o + 4] = maxX + 1e-4;
    nodeBuf[o + 5] = maxY + 1e-4;
    nodeBuf[o + 6] = maxZ + 1e-4;
  };

  // Iterative build stack with 8-bin Surface Area Heuristic (SAH) — 3-4x faster ray traversal inside enclosed rooms!
  const BINS = 8;
  const binCounts = new Int32Array(BINS);
  const binMinX = new Float32Array(BINS);
  const binMinY = new Float32Array(BINS);
  const binMinZ = new Float32Array(BINS);
  const binMaxX = new Float32Array(BINS);
  const binMaxY = new Float32Array(BINS);
  const binMaxZ = new Float32Array(BINS);
  const leftArea = new Float32Array(BINS - 1);
  const leftCounts = new Int32Array(BINS - 1);

  const buildStack = [{ nodeIdx: 0, start: 0, count: nTris }];
  while (buildStack.length > 0) {
    const { nodeIdx, start, count } = buildStack.pop();
    updateBounds(nodeIdx, start, count);
    const o = nodeIdx * 8;

    if (count <= 3 || nodeCount + 2 >= maxNodes) {
      nodeBuf[o + 3] = start;
      nodeBuf[o + 7] = count;
      continue;
    }

    const parentDx = nodeBuf[o + 4] - nodeBuf[o];
    const parentDy = nodeBuf[o + 5] - nodeBuf[o + 1];
    const parentDz = nodeBuf[o + 6] - nodeBuf[o + 2];
    const parentArea = Math.max(1e-6, parentDx * parentDy + parentDy * parentDz + parentDz * parentDx);
    let bestCost = count * parentArea; // cost of making a leaf
    let bestAxis = -1;
    let bestPos = 0;

    // Evaluate 8 SAH bins on each axis
    for (let axis = 0; axis < 3; axis++) {
      let cMin = 1e9;
      let cMax = -1e9;
      for (let i = start; i < start + count; i++) {
        const tr = rawTris[triIndices[i]];
        const c = axis === 0 ? tr.cx : axis === 1 ? tr.cy : tr.cz;
        if (c < cMin) cMin = c;
        if (c > cMax) cMax = c;
      }
      const span = cMax - cMin;
      if (span < 1e-5) continue;

      for (let b = 0; b < BINS; b++) {
        binCounts[b] = 0;
        binMinX[b] = 1e9; binMinY[b] = 1e9; binMinZ[b] = 1e9;
        binMaxX[b] = -1e9; binMaxY[b] = -1e9; binMaxZ[b] = -1e9;
      }
      const invSpan = BINS / span;
      for (let i = start; i < start + count; i++) {
        const tr = rawTris[triIndices[i]];
        const c = axis === 0 ? tr.cx : axis === 1 ? tr.cy : tr.cz;
        let b = Math.floor((c - cMin) * invSpan);
        if (b >= BINS) b = BINS - 1;
        else if (b < 0) b = 0;
        binCounts[b]++;
        if (tr.minX < binMinX[b]) binMinX[b] = tr.minX;
        if (tr.minY < binMinY[b]) binMinY[b] = tr.minY;
        if (tr.minZ < binMinZ[b]) binMinZ[b] = tr.minZ;
        if (tr.maxX > binMaxX[b]) binMaxX[b] = tr.maxX;
        if (tr.maxY > binMaxY[b]) binMaxY[b] = tr.maxY;
        if (tr.maxZ > binMaxZ[b]) binMaxZ[b] = tr.maxZ;
      }

      // Sweep left -> right
      let lMinX = 1e9, lMinY = 1e9, lMinZ = 1e9;
      let lMaxX = -1e9, lMaxY = -1e9, lMaxZ = -1e9;
      let lCnt = 0;
      for (let b = 0; b < BINS - 1; b++) {
        if (binCounts[b] > 0) {
          lCnt += binCounts[b];
          if (binMinX[b] < lMinX) lMinX = binMinX[b];
          if (binMinY[b] < lMinY) lMinY = binMinY[b];
          if (binMinZ[b] < lMinZ) lMinZ = binMinZ[b];
          if (binMaxX[b] > lMaxX) lMaxX = binMaxX[b];
          if (binMaxY[b] > lMaxY) lMaxY = binMaxY[b];
          if (binMaxZ[b] > lMaxZ) lMaxZ = binMaxZ[b];
        }
        leftCounts[b] = lCnt;
        if (lCnt > 0) {
          const dx = lMaxX - lMinX;
          const dy = lMaxY - lMinY;
          const dz = lMaxZ - lMinZ;
          leftArea[b] = dx * dy + dy * dz + dz * dx;
        } else {
          leftArea[b] = 0;
        }
      }

      // Sweep right -> left and compute exact SAH split cost
      let rMinX = 1e9, rMinY = 1e9, rMinZ = 1e9;
      let rMaxX = -1e9, rMaxY = -1e9, rMaxZ = -1e9;
      let rCnt = 0;
      for (let b = BINS - 1; b >= 1; b--) {
        if (binCounts[b] > 0) {
          rCnt += binCounts[b];
          if (binMinX[b] < rMinX) rMinX = binMinX[b];
          if (binMinY[b] < rMinY) rMinY = binMinY[b];
          if (binMinZ[b] < rMinZ) rMinZ = binMinZ[b];
          if (binMaxX[b] > rMaxX) rMaxX = binMaxX[b];
          if (binMaxY[b] > rMaxY) rMaxY = binMaxY[b];
          if (binMaxZ[b] > rMaxZ) rMaxZ = binMaxZ[b];
        }
        const lc = leftCounts[b - 1];
        if (lc > 0 && rCnt > 0) {
          const dx = rMaxX - rMinX;
          const dy = rMaxY - rMinY;
          const dz = rMaxZ - rMinZ;
          const rArea = dx * dy + dy * dz + dz * dx;
          const cost = 0.5 * parentArea + lc * leftArea[b - 1] + rCnt * rArea;
          if (cost < bestCost) {
            bestCost = cost;
            bestAxis = axis;
            bestPos = cMin + (span * b) / BINS;
          }
        }
      }
    }

    if (bestAxis < 0) {
      nodeBuf[o + 3] = start;
      nodeBuf[o + 7] = count;
      continue;
    }

    let i = start;
    let j = start + count - 1;
    while (i <= j) {
      const tr = rawTris[triIndices[i]];
      const c = bestAxis === 0 ? tr.cx : bestAxis === 1 ? tr.cy : tr.cz;
      if (c < bestPos) {
        i++;
      } else {
        const tmp = triIndices[i];
        triIndices[i] = triIndices[j];
        triIndices[j] = tmp;
        j--;
      }
    }

    let leftCount = i - start;
    if (leftCount === 0 || leftCount === count) {
      leftCount = count >> 1;
    }

    const leftIdx = nodeCount;
    nodeCount += 2;
    nodeBuf[o + 3] = leftIdx; // rightChild is ALWAYS leftIdx + 1!
    nodeBuf[o + 7] = 0;       // 0 = internal node

    buildStack.push({ nodeIdx: leftIdx + 1, start: start + leftCount, count: count - leftCount });
    buildStack.push({ nodeIdx: leftIdx, start, count: leftCount });
  }

  // Pack reordered triangles: 16 floats per triangle (4 vec4s) for clean alignment in WGSL, GLSL & JS!
  //   t0: [v0x, v0y, v0z, matIdx]
  //   t1: [e1x, e1y, e1z, 0]
  //   t2: [e2x, e2y, e2z, 0]
  //   t3: [nx,  ny,  nz,  0]
  const triData = new Float32Array(nTris * 16);
  for (let i = 0; i < nTris; i++) {
    const tr = rawTris[triIndices[i]];
    const o = i * 16;
    triData[o] = tr.v0x;
    triData[o + 1] = tr.v0y;
    triData[o + 2] = tr.v0z;
    triData[o + 3] = tr.matIdx;
    triData[o + 4] = tr.e1x;
    triData[o + 5] = tr.e1y;
    triData[o + 6] = tr.e1z;
    triData[o + 7] = 0;
    triData[o + 8] = tr.e2x;
    triData[o + 9] = tr.e2y;
    triData[o + 10] = tr.e2z;
    triData[o + 11] = 0;
    triData[o + 12] = tr.nx;
    triData[o + 13] = tr.ny;
    triData[o + 14] = tr.nz;
    triData[o + 15] = 0;
  }

  // Pack materials: 12 floats per material (3 vec4s)
  //   m0: [r, g, b, roughness]
  //   m1: [emR, emG, emB, metalness]
  //   m2: [transmission, ior, woodStrength, woodScale]
  const matData = new Float32Array(materials.length * 12);
  for (let i = 0; i < materials.length; i++) {
    const m = materials[i];
    const o = i * 12;
    matData[o] = m.r;
    matData[o + 1] = m.g;
    matData[o + 2] = m.b;
    matData[o + 3] = m.roughness;
    matData[o + 4] = m.emR;
    matData[o + 5] = m.emG;
    matData[o + 6] = m.emB;
    matData[o + 7] = m.metalness;
    matData[o + 8] = m.transmission;
    matData[o + 9] = m.ior;
    matData[o + 10] = m.woodStrength;
    matData[o + 11] = m.woodScale;
  }

  // Physical room area lights (North 59" window, East 24" window, and Ceiling / Lamp fixtures)
  const W = room.widthIn * IN_TO_M;
  const L = room.lengthIn * IN_TO_M;
  const H = room.heightIn * IN_TO_M;
  const nw = room.northWindow || { widthIn: 59, heightIn: 48, sillIn: 30, offsetFromWestIn: 26 };
  const ew = room.eastWindow || { widthIn: 24, heightIn: 44, sillIn: 34, offsetFromSouthIn: 17 };

  const nwCenterX = (-room.widthIn / 2 + nw.offsetFromWestIn + nw.widthIn / 2) * IN_TO_M;
  const nwCenterY = (nw.sillIn + nw.heightIn / 2) * IN_TO_M;
  const ewCenterZ = (room.lengthIn / 2 - ew.offsetFromSouthIn - ew.widthIn / 2) * IN_TO_M;
  const ewCenterY = (ew.sillIn + ew.heightIn / 2) * IN_TO_M;

  const isEvening = lightingMood === 'evening';
  const lights = [
    // Light 0: North 59" Window Portal (faces +Z into room)
    {
      cx: nwCenterX,
      cy: nwCenterY,
      cz: -L / 2 + 0.08,
      halfU: (nw.widthIn * 0.44) * IN_TO_M,
      halfV: (nw.heightIn * 0.44) * IN_TO_M,
      axis: 0, // Z-plane (u=X, v=Y)
      r: isEvening ? 0.35 : 4.2,
      g: isEvening ? 0.48 : 4.6,
      b: isEvening ? 0.85 : 5.2,
    },
    // Light 1: East 24" Window Portal (faces -X into room)
    {
      cx: W / 2 - 0.08,
      cy: ewCenterY,
      cz: ewCenterZ,
      halfU: (ew.widthIn * 0.44) * IN_TO_M,
      halfV: (ew.heightIn * 0.44) * IN_TO_M,
      axis: 1, // X-plane (u=Z, v=Y)
      r: isEvening ? 0.25 : 3.6,
      g: isEvening ? 0.35 : 3.4,
      b: isEvening ? 0.65 : 3.0,
    },
    // Light 2: Ceiling Flush-Mount Dome Softbox (faces -Y downward)
    {
      cx: 0,
      cy: H - 0.14,
      cz: -0.1,
      halfU: 0.32,
      halfV: 0.32,
      axis: 2, // Y-plane (u=X, v=Z)
      r: isEvening ? 4.4 : 1.35,
      g: isEvening ? 3.1 : 1.25,
      b: isEvening ? 1.85 : 1.1,
    },
  ];

  // Add up to 1 extra lamp emitter if placed & lit in evening mode
  if (isEvening && lampLights.length > 0) {
    const ll = lampLights[0];
    lights.push({
      cx: ll.x,
      cy: ll.y,
      cz: ll.z,
      halfU: 0.12,
      halfV: 0.12,
      axis: 2,
      r: 4.0,
      g: 2.7,
      b: 1.4,
    });
  }

  return {
    bvhNodes: nodeBuf.subarray(0, nodeCount * 8),
    nodeCount,
    triData,
    triCount: nTris,
    matData,
    matCount: materials.length,
    lights,
    isEvening,
    wallMode,
    buildMs: +(performance.now() - tStart).toFixed(1),
  };
}
