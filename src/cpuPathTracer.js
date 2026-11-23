// Multi-Core CPU Physically Based Path Tracer for Room Studio 3D Photo Mode
// Features:
//   - High-SPP supersampling presets (32 -> 512 spp) across up to 16 parallel Blob Web Workers
//   - All-lights soft area NEE on primary hits + luminance-weighted importance sampling on bounces
//   - R2 Golden-Ratio Quasi-Monte Carlo sub-pixel & area-light stratification
//   - Shared 8-bin SAH flat BVH + exact curvilinear Fisheye / Panini / Stereographic / Rectilinear optics
//   - Linear-HDR Firefly Despeckle + 3-pass G-Buffer Guided (Normal + Depth + Albedo) À-Trous Denoiser
//   - ACES Filmic tone mapping + sRGB encoding

export const CPU_PHOTO_PRESETS = {
  preview: {
    id: 'preview',
    label: 'Quick (960×540 · 32 spp)',
    width: 960,
    height: 540,
    spp: 32,
  },
  fast: {
    id: 'fast',
    label: 'HD Studio 8× (1280×720 · 128 spp)',
    width: 1280,
    height: 720,
    spp: 128,
  },
  hd: {
    id: 'hd',
    label: '1080p Studio (1920×1080 · 192 spp)',
    width: 1920,
    height: 1080,
    spp: 192,
  },
  ultra: {
    id: 'ultra',
    label: '1440p Master (2560×1440 · 256 spp)',
    width: 2560,
    height: 1440,
    spp: 256,
  },
  max: {
    id: 'max',
    label: '1080p Ultra-Clean (1920×1080 · 512 spp)',
    width: 1920,
    height: 1080,
    spp: 512,
  },
};

// Pure-JS tile path tracer kernel (serialized into Blob Web Workers AND usable on main-thread fallback).
// Returns:
//   - previewRgba: Uint8ClampedArray(tileW * tileH * 4) for instant tile-by-tile preview
//   - hdrRad:      Float32Array(tileW * tileH * 3) linear HDR radiance for final G-buffer denoiser
//   - gNormDepth:  Float32Array(tileW * tileH * 4) primary normal.xyz + hitT
//   - gAlbedo:     Float32Array(tileW * tileH * 3) primary surface albedo (with wood grain)
function renderTileKernel(cfg, tileX, tileY, tileW, tileH) {
  const {
    bvhNodes,
    triData,
    matData,
    lights,
    lightCdf,
    lightProb,
    isEvening,
    exposure,
    width,
    height,
    spp,
    camPos,
    camRight,
    camUp,
    camForward,
    lensMode,
    halfFovVal,
  } = cfg;

  const aspect = width / Math.max(1, height);
  const nPix = tileW * tileH;
  const previewRgba = new Uint8ClampedArray(nPix * 4);
  const hdrRad = new Float32Array(nPix * 3);
  const gNormDepth = new Float32Array(nPix * 4);
  const gAlbedo = new Float32Array(nPix * 3);

  const stack = new Int32Array(44);
  const nLights = lights.length;

  let rng = 1;
  function rand() {
    let x = rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    rng = x >>> 0;
    return rng * 2.3283064365386963e-10;
  }

  let hitT = 1e30;
  let hitTri = -1;
  let hitMat = -1;
  let hitNx = 0;
  let hitNy = 1;
  let hitNz = 0;

  function traceBVH(roX, roY, roZ, rdX, rdY, rdZ, maxT, anyHit) {
    hitT = maxT;
    hitTri = -1;
    hitMat = -1;

    const invX = 1.0 / (rdX > -1e-7 && rdX < 1e-7 ? 1e-7 : rdX);
    const invY = 1.0 / (rdY > -1e-7 && rdY < 1e-7 ? 1e-7 : rdY);
    const invZ = 1.0 / (rdZ > -1e-7 && rdZ < 1e-7 ? 1e-7 : rdZ);

    let sp = 1;
    stack[0] = 0;

    while (sp > 0) {
      const nodeIdx = stack[--sp];
      const nOff = nodeIdx << 3;
      const triCount = bvhNodes[nOff + 7] | 0;

      if (triCount > 0) {
        const firstTri = bvhNodes[nOff + 3] | 0;
        const endTri = firstTri + triCount;
        for (let tIdx = firstTri; tIdx < endTri; tIdx++) {
          const tOff = tIdx << 4;
          const v0x = triData[tOff];
          const v0y = triData[tOff + 1];
          const v0z = triData[tOff + 2];
          const e1x = triData[tOff + 4];
          const e1y = triData[tOff + 5];
          const e1z = triData[tOff + 6];
          const e2x = triData[tOff + 8];
          const e2y = triData[tOff + 9];
          const e2z = triData[tOff + 10];

          const px = rdY * e2z - rdZ * e2y;
          const py = rdZ * e2x - rdX * e2z;
          const pz = rdX * e2y - rdY * e2x;

          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-7 && det < 1e-7) continue;
          const invDet = 1.0 / det;

          const tx = roX - v0x;
          const ty = roY - v0y;
          const tz = roZ - v0z;

          const u = (tx * px + ty * py + tz * pz) * invDet;
          if (u < 0.0 || u > 1.0) continue;

          const qx = ty * e1z - tz * e1y;
          const qy = tz * e1x - tx * e1z;
          const qz = tx * e1y - ty * e1x;

          const v = (rdX * qx + rdY * qy + rdZ * qz) * invDet;
          if (v < 0.0 || u + v > 1.0) continue;

          const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
          if (t > 0.0008 && t < hitT) {
            const mIdx = triData[tOff + 3] | 0;
            if (anyHit) {
              if (matData[mIdx * 12 + 8] > 0.65) continue;
              hitT = t;
              hitTri = tIdx;
              hitMat = mIdx;
              return true;
            }
            hitT = t;
            hitTri = tIdx;
            hitMat = mIdx;
            hitNx = triData[tOff + 12];
            hitNy = triData[tOff + 13];
            hitNz = triData[tOff + 14];
          }
        }
      } else {
        const leftIdx = bvhNodes[nOff + 3] | 0;
        const rightIdx = leftIdx + 1;

        const lOff = leftIdx << 3;
        let t0 = (bvhNodes[lOff] - roX) * invX;
        let t1 = (bvhNodes[lOff + 4] - roX) * invX;
        let tNear = t0 < t1 ? t0 : t1;
        let tFar = t0 > t1 ? t0 : t1;
        t0 = (bvhNodes[lOff + 1] - roY) * invY;
        t1 = (bvhNodes[lOff + 5] - roY) * invY;
        let mn = t0 < t1 ? t0 : t1;
        let mx = t0 > t1 ? t0 : t1;
        if (mn > tNear) tNear = mn;
        if (mx < tFar) tFar = mx;
        t0 = (bvhNodes[lOff + 2] - roZ) * invZ;
        t1 = (bvhNodes[lOff + 6] - roZ) * invZ;
        mn = t0 < t1 ? t0 : t1;
        mx = t0 > t1 ? t0 : t1;
        if (mn > tNear) tNear = mn;
        if (mx < tFar) tFar = mx;
        if (tNear < 0.0005) tNear = 0.0005;
        if (hitT < tFar) tFar = hitT;
        const dL = tFar >= tNear ? tNear : 1e30;

        const rOff = rightIdx << 3;
        t0 = (bvhNodes[rOff] - roX) * invX;
        t1 = (bvhNodes[rOff + 4] - roX) * invX;
        tNear = t0 < t1 ? t0 : t1;
        tFar = t0 > t1 ? t0 : t1;
        t0 = (bvhNodes[rOff + 1] - roY) * invY;
        t1 = (bvhNodes[rOff + 5] - roY) * invY;
        mn = t0 < t1 ? t0 : t1;
        mx = t0 > t1 ? t0 : t1;
        if (mn > tNear) tNear = mn;
        if (mx < tFar) tFar = mx;
        t0 = (bvhNodes[rOff + 2] - roZ) * invZ;
        t1 = (bvhNodes[rOff + 6] - roZ) * invZ;
        mn = t0 < t1 ? t0 : t1;
        mx = t0 > t1 ? t0 : t1;
        if (mn > tNear) tNear = mn;
        if (mx < tFar) tFar = mx;
        if (tNear < 0.0005) tNear = 0.0005;
        if (hitT < tFar) tFar = hitT;
        const dR = tFar >= tNear ? tNear : 1e30;

        if (dL < dR) {
          if (dR < hitT && sp < 42) stack[sp++] = rightIdx;
          if (dL < hitT && sp < 42) stack[sp++] = leftIdx;
        } else {
          if (dL < hitT && sp < 42) stack[sp++] = leftIdx;
          if (dR < hitT && sp < 42) stack[sp++] = rightIdx;
        }
      }
    }
    return hitTri >= 0;
  }

  function woodGrainMod(px, py, pz, strength, scale) {
    if (strength <= 0.001) return 1.0;
    const s = 14.0 * scale;
    const x = px * s;
    const y = py * s;
    const z = pz * s;
    const wave = Math.sin(x * 2.2 + Math.sin(z * 0.8 + y * 0.6) * 2.4) * 0.5 + 0.5;
    const fine = Math.sin(x * 9.5 + z * 1.3 + y * 3.1) * 0.5 + 0.5;
    const plank = scale > 1.5 ? Math.sin(z * 0.55) * Math.sin(z * 0.55) : 1.0;
    const g = (wave * 0.65 + fine * 0.35) * (0.85 + 0.15 * plank);
    return 1.0 - strength * 0.5 + strength * g;
  }

  function aces(x) {
    const v = x > 0 ? x : 0;
    const r = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
    return r < 0 ? 0 : r > 1 ? 1 : r;
  }

  // Evaluate direct area-light NEE for one light index with given importance weight invPdf
  function evalAreaLightNEE(
    lIdx, invPdf, hpX, hpY, hpZ, nX, nY, nZ, rdX, rdY, rdZ,
    albR, albG, albB, rough, metal, uA, uB
  ) {
    const L = lights[lIdx];
    const su = (uA * 2.0 - 1.0) * L.halfU;
    const sv = (uB * 2.0 - 1.0) * L.halfV;
    let lpX = L.cx;
    let lpY = L.cy;
    let lpZ = L.cz;
    if (L.axis === 0) {
      lpX += su;
      lpY += sv;
    } else if (L.axis === 1) {
      lpZ += su;
      lpY += sv;
    } else {
      lpX += su;
      lpZ += sv;
    }

    const toLX = lpX - hpX;
    const toLY = lpY - hpY;
    const toLZ = lpZ - hpZ;
    const distSq = Math.max(0.09, toLX * toLX + toLY * toLY + toLZ * toLZ);
    const dist = Math.sqrt(distSq);
    const invD = 1.0 / dist;
    const ldX = toLX * invD;
    const ldY = toLY * invD;
    const ldZ = toLZ * invD;
    const ndl = nX * ldX + nY * ldY + nZ * ldZ;
    if (ndl <= 0.001) return null;

    if (
      traceBVH(
        hpX + nX * 0.0025,
        hpY + nY * 0.0025,
        hpZ + nZ * 0.0025,
        ldX,
        ldY,
        ldZ,
        dist - 0.03,
        true
      )
    ) {
      return null;
    }

    const area = 4.0 * L.halfU * L.halfV;
    const geom = Math.min(3.2, (ndl * area * invPdf) / (3.14159265 * distSq + 0.28));
    const diffScale = (1.0 - metal) * geom;
    let cR = albR * diffScale;
    let cG = albG * diffScale;
    let cB = albB * diffScale;

    // Microfacet specular highlight (clamped smoothly to prevent fireflies)
    const hx = ldX - rdX;
    const hy = ldY - rdY;
    const hz = ldZ - rdZ;
    const hl = Math.hypot(hx, hy, hz);
    if (hl > 1e-5) {
      const ndh = Math.max(0, (nX * hx + nY * hy + nZ * hz) / hl);
      const a2 = Math.max(0.006, rough * rough * rough * rough);
      const denom = ndh * ndh * (a2 - 1.0) + 1.0;
      const ggx = Math.min(3.2, a2 / Math.max(0.002, 3.14159265 * denom * denom));
      const specAmt = ggx * geom * (0.04 + 0.96 * metal) * 0.32;
      cR += (0.04 + (albR - 0.04) * metal) * specAmt;
      cG += (0.04 + (albG - 0.04) * metal) * specAmt;
      cB += (0.04 + (albB - 0.04) * metal) * specAmt;
    }
    return [cR * L.r, cG * L.g, cB * L.b];
  }

  const sunLen = Math.hypot(0.45, 0.72, -0.52);
  const sunX = 0.45 / sunLen;
  const sunY = 0.72 / sunLen;
  const sunZ = -0.52 / sunLen;

  // R2 low-discrepancy plastic-constant sequence constants (vastly smoother convergence than raw white noise!)
  const R2_A1 = 0.7548776662466927;
  const R2_A2 = 0.5698402909980532;

  const invW = 1.0 / width;
  const invH = 1.0 / height;
  const invSpp = 1.0 / spp;

  let pIdx = 0;
  for (let ly = 0; ly < tileH; ly++) {
    const py = tileY + ly;
    for (let lx = 0; lx < tileW; lx++) {
      const px = tileX + lx;
      rng = (((px + 1) * 73856093) ^ ((py + 1) * 19349663) ^ 0x9e3779b9) >>> 0;
      if (rng === 0) rng = 1;

      // Cranley-Patterson per-pixel random shift for R2 QMC sub-pixel & area-light stratification
      const shiftX = rand();
      const shiftY = rand();
      const shiftLX = rand();
      const shiftLY = rand();

      let accR = 0;
      let accG = 0;
      let accB = 0;

      // Accumulated primary G-buffer averages (for crisp edge-stopping denoiser!)
      let gNx = 0, gNy = 0, gNz = 0, gDepth = 0;
      let gAlbR = 0, gAlbG = 0, gAlbB = 0;
      let gHits = 0;

      for (let s = 0; s < spp; s++) {
        // R2 quasi-random subpixel jitter
        const jx = (shiftX + (s + 1) * R2_A1) % 1.0;
        const jy = (shiftY + (s + 1) * R2_A2) % 1.0;
        const ndcX = (px + jx) * invW * 2.0 - 1.0;
        const ndcY = 1.0 - (py + jy) * invH * 2.0;

        let cdX = 0;
        let cdY = 0;
        let cdZ = -1;
        let valid = true;
        let edgeRatio = 0;

        if (lensMode < 0) {
          cdX = ndcX * aspect * halfFovVal;
          cdY = ndcY * halfFovVal;
          cdZ = -1.0;
          const il = 1.0 / Math.hypot(cdX, cdY, cdZ);
          cdX *= il;
          cdY *= il;
          cdZ *= il;
        } else {
          const u = ndcX * aspect;
          const v = ndcY;
          if (lensMode === 0) {
            const rho = Math.hypot(u, v);
            const theta = rho * (halfFovVal / Math.max(aspect, 0.001));
            edgeRatio = theta / 1.5707963;
            if (theta >= 3.10) {
              valid = false;
            } else if (rho > 1e-5) {
              const sc = Math.sin(theta) / rho;
              cdX = u * sc;
              cdY = v * sc;
              cdZ = -Math.cos(theta);
            }
          } else if (lensMode === 1) {
            const k = (2.0 * Math.tan(halfFovVal * 0.5)) / Math.max(aspect, 0.001);
            const xPan = u * k;
            const yPan = v * k;
            const lam = 2.0 * Math.atan(xPan * 0.5);
            edgeRatio = Math.abs(lam) / 1.5707963;
            if (Math.abs(lam) >= 3.04) {
              valid = false;
            } else {
              const tanPsi = yPan * 0.5 * (1.0 + Math.cos(lam));
              cdX = Math.sin(lam);
              cdY = tanPsi;
              cdZ = -Math.cos(lam);
              const il = 1.0 / Math.hypot(cdX, cdY, cdZ);
              cdX *= il;
              cdY *= il;
              cdZ *= il;
            }
          } else {
            const rho = Math.hypot(u, v);
            const k = Math.tan(halfFovVal * 0.5) / Math.max(aspect, 0.001);
            const theta = 2.0 * Math.atan(rho * k);
            edgeRatio = theta / 1.5707963;
            if (theta >= 3.10) {
              valid = false;
            } else if (rho > 1e-5) {
              const sc = Math.sin(theta) / rho;
              cdX = u * sc;
              cdY = v * sc;
              cdZ = -Math.cos(theta);
            }
          }
        }

        if (!valid) {
          accR += 0.03;
          accG += 0.035;
          accB += 0.045;
          continue;
        }

        let roX = camPos[0];
        let roY = camPos[1];
        let roZ = camPos[2];
        let rdX = camRight[0] * cdX + camUp[0] * cdY + camForward[0] * -cdZ;
        let rdY = camRight[1] * cdX + camUp[1] * cdY + camForward[1] * -cdZ;
        let rdZ = camRight[2] * cdX + camUp[2] * cdY + camForward[2] * -cdZ;
        const rdl = 1.0 / Math.hypot(rdX, rdY, rdZ);
        rdX *= rdl;
        rdY *= rdl;
        rdZ *= rdl;

        let radR = 0;
        let radG = 0;
        let radB = 0;
        let tpR = 1;
        let tpG = 1;
        let tpB = 1;
        let recordedPrimary = false;

        // 4-bounce physically based Monte Carlo path trace
        for (let bounce = 0; bounce < 4; bounce++) {
          if (!traceBVH(roX, roY, roZ, rdX, rdY, rdZ, 1e20, false)) {
            const tSky = Math.min(1, Math.max(0, rdY * 0.5 + 0.5));
            let sR, sG, sB;
            if (isEvening) {
              sR = 0.05 + (0.015 - 0.05) * tSky;
              sG = 0.065 + (0.025 - 0.065) * tSky;
              sB = 0.11 + (0.06 - 0.11) * tSky;
            } else {
              const pSky = Math.pow(tSky, 0.7);
              sR = (0.88 + (0.42 - 0.88) * pSky) * 1.15;
              sG = (0.90 + (0.66 - 0.90) * pSky) * 1.15;
              sB = (0.93 + (0.96 - 0.93) * pSky) * 1.15;
              const sDot = Math.max(0, rdX * sunX + rdY * sunY + rdZ * sunZ);
              if (sDot > 0.75) {
                const sunGlow = Math.pow(sDot, 48.0) * 3.5 * 1.15;
                sR += sunGlow;
                sG += sunGlow * 0.94;
                sB += sunGlow * 0.82;
              }
            }
            radR += tpR * sR;
            radG += tpG * sG;
            radB += tpB * sB;
            if (!recordedPrimary) {
              gDepth += 25.0;
              gAlbR += sR;
              gAlbG += sG;
              gAlbB += sB;
              gHits++;
              recordedPrimary = true;
            }
            break;
          }

          const primT = hitT;
          const hpX = roX + rdX * primT;
          const hpY = roY + rdY * primT;
          const hpZ = roZ + rdZ * primT;

          let nX = hitNx;
          let nY = hitNy;
          let nZ = hitNz;
          const ndotd = nX * rdX + nY * rdY + nZ * rdZ;
          if (ndotd > 0) {
            nX = -nX;
            nY = -nY;
            nZ = -nZ;
          }

          const mOff = hitMat * 12;
          const wood = woodGrainMod(hpX, hpY, hpZ, matData[mOff + 10], matData[mOff + 11]);
          const albR = Math.min(0.95, matData[mOff] * wood);
          const albG = Math.min(0.95, matData[mOff + 1] * wood);
          const albB = Math.min(0.95, matData[mOff + 2] * wood);
          const rough = matData[mOff + 3];
          const emR = matData[mOff + 4];
          const emG = matData[mOff + 5];
          const emB = matData[mOff + 6];
          const metal = matData[mOff + 7];
          const trans = matData[mOff + 8];

          if (emR > 0.001 || emG > 0.001 || emB > 0.001) {
            radR += tpR * emR;
            radG += tpG * emG;
            radB += tpB * emB;
          }

          // Clear dielectric glass: Fresnel reflection + crisp transmission
          if (trans > 0.6) {
            const cosI = Math.min(1, Math.max(0, -(rdX * nX + rdY * nY + rdZ * nZ)));
            const omc = 1.0 - cosI;
            const omc2 = omc * omc;
            const fresnel = 0.04 + 0.96 * omc2 * omc2 * omc;
            if (rand() < fresnel) {
              const dot2 = 2.0 * (rdX * nX + rdY * nY + rdZ * nZ);
              rdX = rdX - dot2 * nX;
              rdY = rdY - dot2 * nY;
              rdZ = rdZ - dot2 * nZ;
              roX = hpX + nX * 0.0015;
              roY = hpY + nY * 0.0015;
              roZ = hpZ + nZ * 0.0015;
              tpR *= 0.94;
              tpG *= 0.96;
              tpB *= 0.98;
            } else {
              roX = hpX + rdX * 0.0025;
              roY = hpY + rdY * 0.0025;
              roZ = hpZ + rdZ * 0.0025;
              tpR *= 0.93;
              tpG *= 0.96;
              tpB *= 0.97;
            }
            continue;
          }

          // Record primary G-buffer (normal, depth, albedo) on first solid surface hit
          if (!recordedPrimary) {
            gNx += nX;
            gNy += nY;
            gNz += nZ;
            gDepth += primT;
            gAlbR += albR;
            gAlbG += albG;
            gAlbB += albB;
            gHits++;
            recordedPrimary = true;
          }

          // Direct Next Event Estimation:
          // - On primary hit (bounce === 0): evaluate ALL room area lights with R2 QMC area jitter (eliminates light-selection noise completely!)
          // - On first indirect bounce (bounce === 1): luminance-weighted importance sampling (focuses rays on bright ceiling/lamp in Evening mode!)
          if (nLights > 0 && bounce === 0) {
            const uA = (shiftLX + (s + 1) * R2_A1) % 1.0;
            const uB = (shiftLY + (s + 1) * R2_A2) % 1.0;
            for (let li = 0; li < nLights; li++) {
              // Decorrelate light jitter per light index
              const luA = (uA + li * 0.37) % 1.0;
              const luB = (uB + li * 0.61) % 1.0;
              const contrib = evalAreaLightNEE(
                li, 1.0, hpX, hpY, hpZ, nX, nY, nZ, rdX, rdY, rdZ,
                albR, albG, albB, rough, metal, luA, luB
              );
              if (contrib) {
                radR += Math.min(6.0, tpR * contrib[0]);
                radG += Math.min(6.0, tpG * contrib[1]);
                radB += Math.min(6.0, tpB * contrib[2]);
              }
            }
          } else if (nLights > 0 && bounce === 1) {
            const uSel = rand();
            let li = nLights - 1;
            for (let k = 0; k < nLights; k++) {
              if (uSel <= lightCdf[k]) {
                li = k;
                break;
              }
            }
            const invPdf = 1.0 / Math.max(0.05, lightProb[li]);
            const contrib = evalAreaLightNEE(
              li, invPdf, hpX, hpY, hpZ, nX, nY, nZ, rdX, rdY, rdZ,
              albR, albG, albB, rough, metal, rand(), rand()
            );
            if (contrib) {
              radR += Math.min(4.0, tpR * contrib[0]);
              radG += Math.min(4.0, tpG * contrib[1]);
              radB += Math.min(4.0, tpB * contrib[2]);
            }
          }

          if (bounce === 3) break;

          // Build local orthonormal basis around surface normal n
          let upX = 0, upY = 1, upZ = 0;
          if (Math.abs(nY) >= 0.99) {
            upX = 1; upY = 0; upZ = 0;
          }
          let tX = upY * nZ - upZ * nY;
          let tY = upZ * nX - upX * nZ;
          let tZ = upX * nY - upY * nX;
          const tl = 1.0 / Math.hypot(tX, tY, tZ);
          tX *= tl; tY *= tl; tZ *= tl;
          const bX = nY * tZ - nZ * tY;
          const bY = nZ * tX - nX * tZ;
          const bZ = nX * tY - nY * tX;

          // Choose GGX specular lobe vs cosine-weighted diffuse lobe (smoothly clamped to avoid fireflies on matte plaster)
          const cosV = Math.min(1, Math.max(0, -(rdX * nX + rdY * nY + rdZ * nZ)));
          const omv = 1.0 - cosV;
          const omv2 = omv * omv;
          const f0Avg = 0.04 + ((albR + albG + albB) * 0.3333 - 0.04) * metal;
          const specProb =
            rough > 0.78 && metal < 0.1
              ? 0.0
              : Math.min(0.92, Math.max(0.06, f0Avg + (1.0 - f0Avg) * omv2 * omv2 * omv * (1.0 - rough * 0.75)));

          let nextX, nextY, nextZ;
          if (specProb > 0.0 && rand() < specProb) {
            const u1 = rand();
            const u2 = rand();
            const a = Math.max(0.035, rough * rough);
            const phi = 6.2831853 * u2;
            const cosT = Math.sqrt((1.0 - u1) / Math.max(1e-5, 1.0 + (a * a - 1.0) * u1));
            const sinT = Math.sqrt(Math.max(0, 1.0 - cosT * cosT));
            const lx = sinT * Math.cos(phi);
            const ly = sinT * Math.sin(phi);
            const hx = tX * lx + bX * ly + nX * cosT;
            const hy = tY * lx + bY * ly + nY * cosT;
            const hz = tZ * lx + bZ * ly + nZ * cosT;
            const dot2 = 2.0 * (rdX * hx + rdY * hy + rdZ * hz);
            nextX = rdX - dot2 * hx;
            nextY = rdY - dot2 * hy;
            nextZ = rdZ - dot2 * hz;
            if (nextX * nX + nextY * nY + nextZ * nZ <= 0) {
              const ru1 = rand();
              const ru2 = rand();
              const rr = Math.sqrt(ru1);
              const rphi = 6.2831853 * ru2;
              const rx = rr * Math.cos(rphi);
              const ry = rr * Math.sin(rphi);
              const rz = Math.sqrt(Math.max(0, 1.0 - ru1));
              nextX = tX * rx + bX * ry + nX * rz;
              nextY = tY * rx + bY * ry + nY * rz;
              nextZ = tZ * rx + bZ * ry + nZ * rz;
              tpR *= albR;
              tpG *= albG;
              tpB *= albB;
            } else {
              const sR = 0.04 + (albR - 0.04) * metal;
              const sG = 0.04 + (albG - 0.04) * metal;
              const sB = 0.04 + (albB - 0.04) * metal;
              const w = Math.min(1.8, 1.0 / specProb);
              tpR *= Math.min(0.92, sR * w + (1.0 - metal) * 0.22);
              tpG *= Math.min(0.92, sG * w + (1.0 - metal) * 0.22);
              tpB *= Math.min(0.92, sB * w + (1.0 - metal) * 0.22);
            }
          } else {
            const u1 = rand();
            const u2 = rand();
            const rr = Math.sqrt(u1);
            const phi = 6.2831853 * u2;
            const rx = rr * Math.cos(phi);
            const ry = rr * Math.sin(phi);
            const rz = Math.sqrt(Math.max(0, 1.0 - u1));
            nextX = tX * rx + bX * ry + nX * rz;
            nextY = tY * rx + bY * ry + nY * rz;
            nextZ = tZ * rx + bZ * ry + nZ * rz;
            const diffW = (1.0 - metal) / Math.max(0.08, 1.0 - specProb);
            tpR *= Math.min(0.92, albR * diffW);
            tpG *= Math.min(0.92, albG * diffW);
            tpB *= Math.min(0.92, albB * diffW);
          }

          const nl = 1.0 / Math.hypot(nextX, nextY, nextZ);
          rdX = nextX * nl;
          rdY = nextY * nl;
          rdZ = nextZ * nl;
          roX = hpX + nX * 0.002;
          roY = hpY + nY * 0.002;
          roZ = hpZ + nZ * 0.002;

          // Russian Roulette after bounce 1
          if (bounce >= 1) {
            const pSurv = Math.min(0.9, Math.max(0.18, Math.max(tpR, Math.max(tpG, tpB))));
            if (rand() > pSurv) break;
            const invP = 1.0 / pSurv;
            tpR *= invP;
            tpG *= invP;
            tpB *= invP;
          }
        }

        // Subtle optical vignette on extreme wide-angle corners
        let vig = 1.0;
        if (lensMode >= 0 && edgeRatio > 0.78) {
          const tV = Math.min(1, (edgeRatio - 0.78) / 0.70);
          vig = 1.0 - tV * tV * (3.0 - 2.0 * tV) * 0.14;
        }

        // Soft per-sample firefly clamp
        accR += Math.min(7.0, radR * vig);
        accG += Math.min(7.0, radG * vig);
        accB += Math.min(7.0, radB * vig);
      }

      const linR = accR * invSpp;
      const linG = accG * invSpp;
      const linB = accB * invSpp;

      const o3 = pIdx * 3;
      const o4 = pIdx * 4;
      hdrRad[o3] = linR;
      hdrRad[o3 + 1] = linG;
      hdrRad[o3 + 2] = linB;

      if (gHits > 0) {
        const invHts = 1.0 / gHits;
        const nl = Math.hypot(gNx, gNy, gNz) || 1.0;
        gNormDepth[o4] = gNx / nl;
        gNormDepth[o4 + 1] = gNy / nl;
        gNormDepth[o4 + 2] = gNz / nl;
        gNormDepth[o4 + 3] = gDepth * invHts;
        gAlbedo[o3] = gAlbR * invHts;
        gAlbedo[o3 + 1] = gAlbG * invHts;
        gAlbedo[o3 + 2] = gAlbB * invHts;
      } else {
        gNormDepth[o4] = 0;
        gNormDepth[o4 + 1] = 1;
        gNormDepth[o4 + 2] = 0;
        gNormDepth[o4 + 3] = 25.0;
        gAlbedo[o3] = linR;
        gAlbedo[o3 + 1] = linG;
        gAlbedo[o3 + 2] = linB;
      }

      // Preview sRGB pixel for live tile feedback
      const rTm = aces(linR * exposure);
      const gTm = aces(linG * exposure);
      const bTm = aces(linB * exposure);
      previewRgba[o4] = Math.min(255, Math.max(0, Math.round(Math.pow(rTm, 1.0 / 2.2) * 255)));
      previewRgba[o4 + 1] = Math.min(255, Math.max(0, Math.round(Math.pow(gTm, 1.0 / 2.2) * 255)));
      previewRgba[o4 + 2] = Math.min(255, Math.max(0, Math.round(Math.pow(bTm, 1.0 / 2.2) * 255)));
      previewRgba[o4 + 3] = 255;
      pIdx++;
    }
  }
  return { previewRgba, hdrRad, gNormDepth, gAlbedo };
}

function buildWorkerBlobUrl() {
  const src = `
    const renderTileKernel = ${renderTileKernel.toString()};
    let cfg = null;
    self.onmessage = function(ev) {
      const msg = ev.data;
      if (msg.type === 'init') {
        cfg = msg.cfg;
        self.postMessage({ type: 'ready' });
      } else if (msg.type === 'tile' && cfg) {
        const res = renderTileKernel(cfg, msg.x, msg.y, msg.w, msg.h);
        self.postMessage({
          type: 'tileDone',
          x: msg.x,
          y: msg.y,
          w: msg.w,
          h: msg.h,
          previewBuf: res.previewRgba.buffer,
          hdrBuf: res.hdrRad.buffer,
          normDepthBuf: res.gNormDepth.buffer,
          albedoBuf: res.gAlbedo.buffer
        }, [
          res.previewRgba.buffer,
          res.hdrRad.buffer,
          res.gNormDepth.buffer,
          res.gAlbedo.buffer
        ]);
      }
    };
  `;
  const blob = new Blob([src], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

// Step 1: Linear-HDR Firefly Despeckle (clips isolated hot outlier pixels > 2.6x their 3x3 neighborhood average)
function despeckleHDR(src, width, height) {
  const dst = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c3 = (y * width + x) * 3;
      const cr = src[c3];
      const cg = src[c3 + 1];
      const cb = src[c3 + 2];
      const cLum = cr * 0.2126 + cg * 0.7152 + cb * 0.0722;

      let nSum = 0;
      let nCnt = 0;
      let avgR = 0;
      let avgG = 0;
      let avgB = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const row = ny * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const o3 = (row + nx) * 3;
          const r = src[o3];
          const g = src[o3 + 1];
          const b = src[o3 + 2];
          avgR += r;
          avgG += g;
          avgB += b;
          nSum += r * 0.2126 + g * 0.7152 + b * 0.0722;
          nCnt++;
        }
      }
      const nAvg = nSum / Math.max(1, nCnt);
      if (cLum > Math.max(0.08, nAvg * 2.4)) {
        const inv = 1.0 / Math.max(1, nCnt);
        dst[c3] = avgR * inv;
        dst[c3 + 1] = avgG * inv;
        dst[c3 + 2] = avgB * inv;
      } else {
        dst[c3] = cr;
        dst[c3 + 1] = cg;
        dst[c3 + 2] = cb;
      }
    }
  }
  return dst;
}

// Step 2: G-Buffer Guided (Normal + Depth + Albedo + Radiance) À-Trous Edge-Stopping Denoiser
// Operates in linear HDR radiance space so walls, ceilings, and oak panels become velvet-smooth
// while cabinet doors, window mullions, furniture silhouettes, and wood grain stay razor-sharp!
function guidedAtrousPass(src, gNormDepth, gAlbedo, width, height, step, sigmaRad) {
  const dst = new Float32Array(src.length);
  const kW = [0.25, 0.72, 1.0, 0.72, 0.25];
  const inv2SigRad2 = 1.0 / (2.0 * sigmaRad * sigmaRad);
  const inv2SigAlb2 = 1.0 / (2.0 * 0.14 * 0.14);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const c3 = idx * 3;
      const c4 = idx * 4;

      const cr = src[c3];
      const cg = src[c3 + 1];
      const cb = src[c3 + 2];

      const cnx = gNormDepth[c4];
      const cny = gNormDepth[c4 + 1];
      const cnz = gNormDepth[c4 + 2];
      const cDepth = gNormDepth[c4 + 3];

      const car = gAlbedo[c3];
      const cag = gAlbedo[c3 + 1];
      const cab = gAlbedo[c3 + 2];

      // Adaptive depth threshold proportional to viewing distance
      const depthThresh = Math.max(0.08, cDepth * 0.08);
      const inv2SigD2 = 1.0 / (2.0 * depthThresh * depthThresh);

      let sumR = cr;
      let sumG = cg;
      let sumB = cb;
      let sumW = 1.0;

      for (let ky = -2; ky <= 2; ky++) {
        const ny = y + ky * step;
        if (ny < 0 || ny >= height) continue;
        const wy = kW[ky + 2];
        const rowOff = ny * width;
        for (let kx = -2; kx <= 2; kx++) {
          if (kx === 0 && ky === 0) continue;
          const nx = x + kx * step;
          if (nx < 0 || nx >= width) continue;

          const nIdx = rowOff + nx;
          const o4 = nIdx * 4;

          // Edge-stopping weight #1: surface normal alignment (keeps 90° wall/cabinet corners razor sharp!)
          const ndot = cnx * gNormDepth[o4] + cny * gNormDepth[o4 + 1] + cnz * gNormDepth[o4 + 2];
          if (ndot < 0.72) continue;
          const wN = ndot * ndot * ndot * ndot;

          // Edge-stopping weight #2: depth discontinuity (prevents bleeding foreground furniture onto walls!)
          const dd = gNormDepth[o4 + 3] - cDepth;
          const wD = Math.exp(-(dd * dd) * inv2SigD2);
          if (wD < 0.02) continue;

          // Edge-stopping weight #3: albedo / wood-grain contrast
          const o3 = nIdx * 3;
          const dar = gAlbedo[o3] - car;
          const dag = gAlbedo[o3 + 1] - cag;
          const dab = gAlbedo[o3 + 2] - cab;
          const wA = Math.exp(-(dar * dar + dag * dag + dab * dab) * inv2SigAlb2);

          // Edge-stopping weight #4: soft radiance similarity (preserves crisp shadow edges!)
          const r = src[o3];
          const g = src[o3 + 1];
          const b = src[o3 + 2];
          const dr = r - cr;
          const dg = g - cg;
          const db = b - cb;
          const wR = Math.exp(-(dr * dr + dg * dg + db * db) * inv2SigRad2);

          const w = wy * kW[kx + 2] * wN * wD * wA * wR;
          sumR += r * w;
          sumG += g * w;
          sumB += b * w;
          sumW += w;
        }
      }

      const invW = 1.0 / sumW;
      dst[c3] = sumR * invW;
      dst[c3 + 1] = sumG * invW;
      dst[c3 + 2] = sumB * invW;
    }
  }
  return dst;
}

function tonemapHDRToRGBA(hdr, width, height, exposure) {
  const nPix = width * height;
  const rgba = new Uint8ClampedArray(nPix * 4);
  for (let i = 0; i < nPix; i++) {
    const o3 = i * 3;
    const o4 = i * 4;
    let r = Math.max(0, hdr[o3] * exposure);
    let g = Math.max(0, hdr[o3 + 1] * exposure);
    let b = Math.max(0, hdr[o3 + 2] * exposure);
    r = Math.min(1, (r * (2.51 * r + 0.03)) / (r * (2.43 * r + 0.59) + 0.14));
    g = Math.min(1, (g * (2.51 * g + 0.03)) / (g * (2.43 * g + 0.59) + 0.14));
    b = Math.min(1, (b * (2.51 * b + 0.03)) / (b * (2.43 * b + 0.59) + 0.14));
    rgba[o4] = Math.min(255, Math.max(0, Math.round(Math.pow(r, 1.0 / 2.2) * 255)));
    rgba[o4 + 1] = Math.min(255, Math.max(0, Math.round(Math.pow(g, 1.0 / 2.2) * 255)));
    rgba[o4 + 2] = Math.min(255, Math.max(0, Math.round(Math.pow(b, 1.0 / 2.2) * 255)));
    rgba[o4 + 3] = 255;
  }
  return rgba;
}

/**
 * Multi-core CPU PBR Photo-Mode Path Tracer.
 * Renders tiles from the center outward across Web Workers (with automatic main-thread fallback),
 * then applies Linear-HDR Firefly Despeckle + 3-pass G-Buffer Guided À-Trous Denoising.
 * Returns { cancel(), promise } where promise resolves to { width, height, rgba, elapsedMs, threads, cancelled }.
 */
export function renderCPUPBRPhoto(rtScene, cameraState, options = {}, callbacks = {}) {
  const width = Math.max(160, Math.round(options.width || 1280));
  const height = Math.max(120, Math.round(options.height || 720));
  const spp = Math.max(4, Math.round(options.spp || 128));
  const tileSize = options.tileSize || 32;
  const exposure = rtScene.isEvening ? 1.24 : 1.06;

  // Build luminance-weighted CDF for bounce-1 light importance sampling
  const lights = rtScene.lights || [];
  const nL = lights.length;
  const lightProb = new Float32Array(Math.max(1, nL));
  const lightCdf = new Float32Array(Math.max(1, nL));
  let powerSum = 0;
  for (let i = 0; i < nL; i++) {
    const L = lights[i];
    const area = 4.0 * L.halfU * L.halfV;
    const lum = L.r * 0.2126 + L.g * 0.7152 + L.b * 0.0722;
    const p = Math.max(0.05, lum * area);
    lightProb[i] = p;
    powerSum += p;
  }
  let accP = 0;
  for (let i = 0; i < nL; i++) {
    lightProb[i] = powerSum > 0 ? lightProb[i] / powerSum : 1 / Math.max(1, nL);
    accP += lightProb[i];
    lightCdf[i] = i === nL - 1 ? 1.0 : accP;
  }

  // Build tile queue sorted from center outward so focal furniture resolves first!
  const tiles = [];
  const cx = width * 0.5;
  const cy = height * 0.5;
  for (let y = 0; y < height; y += tileSize) {
    const h = Math.min(tileSize, height - y);
    for (let x = 0; x < width; x += tileSize) {
      const w = Math.min(tileSize, width - x);
      const dx = x + w * 0.5 - cx;
      const dy = y + h * 0.5 - cy;
      tiles.push({ x, y, w, h, d2: dx * dx + dy * dy });
    }
  }
  tiles.sort((a, b) => a.d2 - b.d2);

  const totalTiles = tiles.length;
  const nPix = width * height;
  const fullHdr = new Float32Array(nPix * 3);
  const fullNormDepth = new Float32Array(nPix * 4);
  const fullAlbedo = new Float32Array(nPix * 3);
  const fullPreviewRgba = new Uint8ClampedArray(nPix * 4);
  const tStart = performance.now();

  let cancelled = false;
  let workers = [];
  let blobUrl = null;
  let resolveFn = null;

  const cleanupWorkers = () => {
    for (const w of workers) {
      try {
        w.terminate();
      } catch (_) {}
    }
    workers = [];
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch (_) {}
      blobUrl = null;
    }
  };

  const cfg = {
    bvhNodes: rtScene.bvhNodes,
    triData: rtScene.triData,
    matData: rtScene.matData,
    lights,
    lightCdf,
    lightProb,
    isEvening: !!rtScene.isEvening,
    exposure,
    width,
    height,
    spp,
    camPos: cameraState.pos,
    camRight: cameraState.right,
    camUp: cameraState.up,
    camForward: cameraState.forward,
    lensMode: cameraState.lensMode,
    halfFovVal: cameraState.halfFovVal,
  };

  const blitTileBuffers = (x, y, w, h, previewRgba, hdrRad, gNormDepth, gAlbedo) => {
    for (let row = 0; row < h; row++) {
      const dstRow = (y + row) * width + x;
      const srcRow = row * w;
      fullPreviewRgba.set(previewRgba.subarray(srcRow * 4, (srcRow + w) * 4), dstRow * 4);
      fullHdr.set(hdrRad.subarray(srcRow * 3, (srcRow + w) * 3), dstRow * 3);
      fullNormDepth.set(gNormDepth.subarray(srcRow * 4, (srcRow + w) * 4), dstRow * 4);
      fullAlbedo.set(gAlbedo.subarray(srcRow * 3, (srcRow + w) * 3), dstRow * 3);
    }
  };

  const finishAndDenoise = (threads, resolve) => {
    // Linear-HDR despeckle + 3-pass G-Buffer guided à-trous denoiser (steps 1, 2, 4)
    const clean = despeckleHDR(fullHdr, width, height);
    const p1 = guidedAtrousPass(clean, fullNormDepth, fullAlbedo, width, height, 1, 0.42);
    const p2 = guidedAtrousPass(p1, fullNormDepth, fullAlbedo, width, height, 2, 0.30);
    const p3 = guidedAtrousPass(p2, fullNormDepth, fullAlbedo, width, height, 4, 0.22);
    const finalRgba = tonemapHDRToRGBA(p3, width, height, exposure);
    if (callbacks.onTile) callbacks.onTile(0, 0, width, height, finalRgba);
    resolve({
      width,
      height,
      rgba: finalRgba,
      elapsedMs: Math.round(performance.now() - tStart),
      threads,
      cancelled: false,
    });
  };

  const promise = new Promise((resolve) => {
    resolveFn = resolve;

    const maxWorkers = Math.max(1, Math.min(options.maxWorkers || 16, navigator.hardwareConcurrency || 4, totalTiles));
    let nextTileIdx = 0;
    let doneTiles = 0;

    let useWorkers = typeof Worker !== 'undefined';
    if (useWorkers) {
      try {
        blobUrl = buildWorkerBlobUrl();
        for (let i = 0; i < maxWorkers; i++) {
          const worker = new Worker(blobUrl);
          workers.push(worker);
        }
      } catch (_) {
        cleanupWorkers();
        useWorkers = false;
      }
    }

    if (useWorkers && workers.length > 0) {
      const threads = workers.length;
      const dispatchNext = (worker) => {
        if (cancelled) return;
        if (nextTileIdx >= totalTiles) return;
        const t = tiles[nextTileIdx++];
        worker.postMessage({ type: 'tile', x: t.x, y: t.y, w: t.w, h: t.h });
      };

      for (const worker of workers) {
        worker.onmessage = (ev) => {
          if (cancelled) return;
          const msg = ev.data;
          if (msg.type === 'ready') {
            dispatchNext(worker);
          } else if (msg.type === 'tileDone') {
            const previewRgba = new Uint8ClampedArray(msg.previewBuf);
            const hdrRad = new Float32Array(msg.hdrBuf);
            const gNormDepth = new Float32Array(msg.normDepthBuf);
            const gAlbedo = new Float32Array(msg.albedoBuf);
            blitTileBuffers(msg.x, msg.y, msg.w, msg.h, previewRgba, hdrRad, gNormDepth, gAlbedo);
            doneTiles++;
            if (callbacks.onTile) callbacks.onTile(msg.x, msg.y, msg.w, msg.h, previewRgba);
            if (callbacks.onProgress) {
              callbacks.onProgress({
                pct: Math.round((doneTiles / totalTiles) * 100),
                doneTiles,
                totalTiles,
                threads,
                elapsedMs: Math.round(performance.now() - tStart),
              });
            }
            if (doneTiles >= totalTiles) {
              cleanupWorkers();
              finishAndDenoise(threads, resolve);
            } else {
              dispatchNext(worker);
            }
          }
        };
        worker.onerror = () => {
          if (!cancelled && doneTiles < totalTiles) {
            dispatchNext(worker);
          }
        };
        worker.postMessage({ type: 'init', cfg });
      }
      return;
    }

    // Main-thread async chunked fallback
    const stepFallback = () => {
      if (cancelled) return;
      const t = tiles[nextTileIdx++];
      const res = renderTileKernel(cfg, t.x, t.y, t.w, t.h);
      blitTileBuffers(t.x, t.y, t.w, t.h, res.previewRgba, res.hdrRad, res.gNormDepth, res.gAlbedo);
      doneTiles++;
      if (callbacks.onTile) callbacks.onTile(t.x, t.y, t.w, t.h, res.previewRgba);
      if (callbacks.onProgress) {
        callbacks.onProgress({
          pct: Math.round((doneTiles / totalTiles) * 100),
          doneTiles,
          totalTiles,
          threads: 1,
          elapsedMs: Math.round(performance.now() - tStart),
        });
      }
      if (doneTiles >= totalTiles) {
        finishAndDenoise(1, resolve);
      } else {
        setTimeout(stepFallback, 0);
      }
    };
    setTimeout(stepFallback, 0);
  });

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      cleanupWorkers();
      if (resolveFn) {
        resolveFn({
          width,
          height,
          rgba: fullPreviewRgba,
          elapsedMs: Math.round(performance.now() - tStart),
          threads: 0,
          cancelled: true,
        });
      }
    },
    promise,
  };
}
