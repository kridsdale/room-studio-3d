// Multi-Core CPU Physically Based Path Tracer for Room Studio 3D Photo Mode
// Uses inline Blob Web Workers across all available CPU cores to trace the exact same
// flat BVH + PBR materials + curvilinear Fisheye / Panini / Stereographic / Rectilinear
// primary rays as the GPU Ray Tracer, streaming rendered tiles live to a preview canvas.

export const CPU_PHOTO_PRESETS = {
  preview: {
    id: 'preview',
    label: 'Quick (800×450 · 8 spp + Denoise)',
    width: 800,
    height: 450,
    spp: 8,
  },
  fast: {
    id: 'fast',
    label: 'HD Fast (1280×720 · 16 spp + Denoise)',
    width: 1280,
    height: 720,
    spp: 16,
  },
  hd: {
    id: 'hd',
    label: '1080p Studio (1920×1080 · 32 spp)',
    width: 1920,
    height: 1080,
    spp: 32,
  },
  ultra: {
    id: 'ultra',
    label: '1440p Print (2560×1440 · 64 spp)',
    width: 2560,
    height: 1440,
    spp: 64,
  },
};

// Shared pure-JS tile path tracer kernel (serialized into Blob Web Workers AND usable on main thread fallback)
function renderTileKernel(cfg, tileX, tileY, tileW, tileH) {
  const {
    bvhNodes,
    triData,
    matData,
    lights,
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
  const out = new Uint8ClampedArray(tileW * tileH * 4);
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

        // Inlined left AABB slab test
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

        // Inlined right AABB slab test
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
    const v = Math.max(0, x);
    return Math.min(1, Math.max(0, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14)));
  }

  const sunX = 0.45 / Math.hypot(0.45, 0.72, -0.52);
  const sunY = 0.72 / Math.hypot(0.45, 0.72, -0.52);
  const sunZ = -0.52 / Math.hypot(0.45, 0.72, -0.52);

  // Stratified grid dimensions for clean anti-aliasing & low-noise Monte Carlo
  const stratN = Math.max(1, Math.floor(Math.sqrt(spp)));
  const invStratN = 1.0 / stratN;
  const invW = 1.0 / width;
  const invH = 1.0 / height;
  const invSpp = 1.0 / spp;

  let pOut = 0;
  for (let ly = 0; ly < tileH; ly++) {
    const py = tileY + ly;
    for (let lx = 0; lx < tileW; lx++) {
      const px = tileX + lx;
      rng = (((px + 1) * 73856093) ^ ((py + 1) * 19349663) ^ 0x9e3779b9) >>> 0;
      if (rng === 0) rng = 1;

      let accR = 0;
      let accG = 0;
      let accB = 0;

      for (let s = 0; s < spp; s++) {
        // Stratified subpixel jitter
        const sx = (s % stratN + rand()) * invStratN;
        const sy = (Math.floor(s / stratN) % stratN + rand()) * invStratN;
        const ndcX = (px + sx) * invW * 2.0 - 1.0;
        const ndcY = 1.0 - (py + sy) * invH * 2.0;

        // Generate exact curvilinear or rectilinear primary camera ray
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
            break;
          }

          const hpX = roX + rdX * hitT;
          const hpY = roY + rdY * hitT;
          const hpZ = roZ + rdZ * hitT;

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

          // Clear dielectric glass (cabinet doors & windows): Fresnel reflection + crisp transmission
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

          // Next Event Estimation on primary & first indirect bounce (captures >95% of direct soft shadows at 2x speed)
          if (nLights > 0 && bounce <= 1) {
            const lIdx = Math.min(nLights - 1, Math.floor(rand() * nLights));
            const L = lights[lIdx];
            const su = (rand() * 2.0 - 1.0) * L.halfU;
            const sv = (rand() * 2.0 - 1.0) * L.halfV;
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
            const distSq = Math.max(0.08, toLX * toLX + toLY * toLY + toLZ * toLZ);
            const dist = Math.sqrt(distSq);
            const invD = 1.0 / dist;
            const ldX = toLX * invD;
            const ldY = toLY * invD;
            const ldZ = toLZ * invD;
            const ndl = nX * ldX + nY * ldY + nZ * ldZ;

            if (ndl > 0.001) {
              const occluded = traceBVH(
                hpX + nX * 0.0025,
                hpY + nY * 0.0025,
                hpZ + nZ * 0.0025,
                ldX,
                ldY,
                ldZ,
                dist - 0.03,
                true
              );
              if (!occluded) {
                const area = 4.0 * L.halfU * L.halfV;
                const geom = Math.min(3.5, (ndl * area * nLights) / (3.14159265 * distSq + 0.25));
                const diffScale = (1.0 - metal) * geom;
                let cR = albR * diffScale;
                let cG = albG * diffScale;
                let cB = albB * diffScale;

                // Direct microfacet specular highlight on polished oak / metal hardware
                const hx = ldX - rdX;
                const hy = ldY - rdY;
                const hz = ldZ - rdZ;
                const hl = Math.hypot(hx, hy, hz);
                if (hl > 1e-5) {
                  const ndh = Math.max(0, (nX * hx + nY * hy + nZ * hz) / hl);
                  const a2 = Math.max(0.004, rough * rough * rough * rough);
                  const denom = ndh * ndh * (a2 - 1.0) + 1.0;
                  const ggx = Math.min(4.5, a2 / Math.max(0.001, 3.14159265 * denom * denom));
                  const specAmt = ggx * geom * (0.04 + 0.96 * metal) * 0.35;
                  cR += (0.04 + (albR - 0.04) * metal) * specAmt;
                  cG += (0.04 + (albG - 0.04) * metal) * specAmt;
                  cB += (0.04 + (albB - 0.04) * metal) * specAmt;
                }

                radR += Math.min(8.0, tpR * cR * L.r);
                radG += Math.min(8.0, tpG * cG * L.g);
                radB += Math.min(8.0, tpB * cB * L.b);
              }
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

          // Choose GGX specular lobe vs cosine-weighted diffuse lobe
          const cosV = Math.min(1, Math.max(0, -(rdX * nX + rdY * nY + rdZ * nZ)));
          const omv = 1.0 - cosV;
          const omv2 = omv * omv;
          const f0Avg = 0.04 + ((albR + albG + albB) * 0.3333 - 0.04) * metal;
          const specProb = Math.min(0.95, Math.max(0.04, f0Avg + (1.0 - f0Avg) * omv2 * omv2 * omv * (1.0 - rough * 0.7)));

          let nextX, nextY, nextZ;
          if (rand() < specProb) {
            const u1 = rand();
            const u2 = rand();
            const a = Math.max(0.03, rough * rough);
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
              const w = Math.min(2.5, 1.0 / specProb);
              tpR *= Math.min(0.95, sR * w + (1.0 - metal) * 0.25);
              tpG *= Math.min(0.95, sG * w + (1.0 - metal) * 0.25);
              tpB *= Math.min(0.95, sB * w + (1.0 - metal) * 0.25);
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
            const diffW = (1.0 - metal) / Math.max(0.05, 1.0 - specProb);
            tpR *= Math.min(0.95, albR * diffW);
            tpG *= Math.min(0.95, albG * diffW);
            tpB *= Math.min(0.95, albB * diffW);
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
            const pSurv = Math.min(0.9, Math.max(0.15, Math.max(tpR, Math.max(tpG, tpB))));
            if (rand() > pSurv) break;
            const invP = 1.0 / pSurv;
            tpR *= invP;
            tpG *= invP;
            tpB *= invP;
          }
        }

        // Subtle optical vignette on wide-angle curvilinear edges matching fisheyeLens.js
        let vig = 1.0;
        if (lensMode >= 0 && edgeRatio > 0.78) {
          const tV = Math.min(1, (edgeRatio - 0.78) / 0.70);
          vig = 1.0 - tV * tV * (3.0 - 2.0 * tV) * 0.14;
        }

        accR += Math.min(10.0, radR * vig);
        accG += Math.min(10.0, radG * vig);
        accB += Math.min(10.0, radB * vig);
      }

      const rLin = aces(accR * invSpp * exposure);
      const gLin = aces(accG * invSpp * exposure);
      const bLin = aces(accB * invSpp * exposure);

      out[pOut++] = Math.min(255, Math.max(0, Math.round(Math.pow(rLin, 1.0 / 2.2) * 255)));
      out[pOut++] = Math.min(255, Math.max(0, Math.round(Math.pow(gLin, 1.0 / 2.2) * 255)));
      out[pOut++] = Math.min(255, Math.max(0, Math.round(Math.pow(bLin, 1.0 / 2.2) * 255)));
      out[pOut++] = 255;
    }
  }
  return out;
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
        const rgba = renderTileKernel(cfg, msg.x, msg.y, msg.w, msg.h);
        self.postMessage({
          type: 'tileDone',
          x: msg.x,
          y: msg.y,
          w: msg.w,
          h: msg.h,
          rgbaBuffer: rgba.buffer
        }, [rgba.buffer]);
      }
    };
  `;
  const blob = new Blob([src], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

// Fast 2-pass à-trous edge-preserving denoiser (~60ms at 1280x720): turns 8–32 spp Monte Carlo path tracing into velvet-smooth architectural renders while keeping cabinet edges sharp
function atrousPass(src, width, height, step, sigmaColor) {
  const dst = new Uint8ClampedArray(src.length);
  const inv2Sig2 = 1.0 / (2.0 * sigmaColor * sigmaColor);
  const kW = [0.25, 0.72, 1.0, 0.72, 0.25];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cOff = (y * width + x) * 4;
      const cr = src[cOff];
      const cg = src[cOff + 1];
      const cb = src[cOff + 2];

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumW = 0;

      for (let ky = -2; ky <= 2; ky++) {
        const ny = y + ky * step;
        if (ny < 0 || ny >= height) continue;
        const wy = kW[ky + 2];
        const rowOff = ny * width;
        for (let kx = -2; kx <= 2; kx++) {
          const nx = x + kx * step;
          if (nx < 0 || nx >= width) continue;
          const o = (rowOff + nx) * 4;
          const r = src[o];
          const g = src[o + 1];
          const b = src[o + 2];
          const dr = r - cr;
          const dg = g - cg;
          const db = b - cb;
          const dist2 = dr * dr + dg * dg + db * db;
          const w = wy * kW[kx + 2] * Math.exp(-dist2 * inv2Sig2);
          sumR += r * w;
          sumG += g * w;
          sumB += b * w;
          sumW += w;
        }
      }
      const invW = sumW > 1e-6 ? 1.0 / sumW : 1.0;
      dst[cOff] = Math.round(sumR * invW);
      dst[cOff + 1] = Math.round(sumG * invW);
      dst[cOff + 2] = Math.round(sumB * invW);
      dst[cOff + 3] = 255;
    }
  }
  return dst;
}

function bilateralDenoiseRGBA(src, width, height) {
  const pass1 = atrousPass(src, width, height, 1, 62);
  return atrousPass(pass1, width, height, 2, 42);
}

/**
 * Multi-core CPU PBR Photo-Mode Path Tracer.
 * Renders tiles from the center outward across Web Workers (with automatic main-thread fallback).
 * Returns { cancel(), promise } where promise resolves to { width, height, rgba, elapsedMs, threads, cancelled }.
 */
export function renderCPUPBRPhoto(rtScene, cameraState, options = {}, callbacks = {}) {
  const width = Math.max(160, Math.round(options.width || 1280));
  const height = Math.max(120, Math.round(options.height || 720));
  const spp = Math.max(4, Math.round(options.spp || 16));
  const tileSize = options.tileSize || 48;
  const exposure = rtScene.isEvening ? 1.18 : 1.06;

  // Build tile queue sorted from center outward so focal furniture renders first!
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
  const fullRgba = new Uint8ClampedArray(width * height * 4);
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
    lights: rtScene.lights,
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

  const blitTileIntoFull = (x, y, w, h, tileRgba) => {
    for (let row = 0; row < h; row++) {
      const srcOff = row * w * 4;
      const dstOff = ((y + row) * width + x) * 4;
      fullRgba.set(tileRgba.subarray(srcOff, srcOff + w * 4), dstOff);
    }
  };

  const finishAndDenoise = (threads, resolve) => {
    const denoised = bilateralDenoiseRGBA(fullRgba, width, height);
    if (callbacks.onTile) callbacks.onTile(0, 0, width, height, denoised);
    resolve({
      width,
      height,
      rgba: denoised,
      elapsedMs: Math.round(performance.now() - tStart),
      threads,
      cancelled: false,
    });
  };

  const promise = new Promise((resolve) => {
    resolveFn = resolve;

    const maxWorkers = Math.max(1, Math.min(options.maxWorkers || 12, navigator.hardwareConcurrency || 4, totalTiles));
    let nextTileIdx = 0;
    let doneTiles = 0;

    // Try multi-core Blob Web Workers first
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
            const tileRgba = new Uint8ClampedArray(msg.rgbaBuffer);
            blitTileIntoFull(msg.x, msg.y, msg.w, msg.h, tileRgba);
            doneTiles++;
            if (callbacks.onTile) callbacks.onTile(msg.x, msg.y, msg.w, msg.h, tileRgba);
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

    // Main-thread async chunked fallback (never blocks UI completely)
    const stepFallback = () => {
      if (cancelled) return;
      const t = tiles[nextTileIdx++];
      const tileRgba = renderTileKernel(cfg, t.x, t.y, t.w, t.h);
      blitTileIntoFull(t.x, t.y, t.w, t.h, tileRgba);
      doneTiles++;
      if (callbacks.onTile) callbacks.onTile(t.x, t.y, t.w, t.h, tileRgba);
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
          rgba: fullRgba,
          elapsedMs: Math.round(performance.now() - tStart),
          threads: 0,
          cancelled: true,
        });
      }
    },
    promise,
  };
}
