// Dual-Backend Progressive GPU Path Tracer for Room Studio 3D
// - Primary Backend (Chrome on M5 MacBook Pro / Desktop): Native WebGPU WGSL Compute Shader
// - Automatic Fallback Backend: WebGL2 RGBA32F DataTexture Fragment Path Tracer
// Features:
//   - Direct pixel-accurate curvilinear primary rays (Equidistant Fisheye, Architectural Panini,
//     Conformal Stereographic, and Rectilinear) — zero cubemap resampling blur or seams!
//   - Iterative flat BVH traversal (Möller–Trumbore + slab AABB)
//   - 4-bounce physically based GGX microfacet specular + Lambertian diffuse + Fresnel glass
//   - Next Event Estimation (NEE) soft area lights on North/East windows + ceiling & lamp fixtures
//   - 3D world-space brushed oak veneer & hardwood plank grain
//   - ACES Filmic tone mapping + sRGB gamma

import * as THREE from 'three';

// ======================== SHARED WGSL COMPUTE + BLIT SHADERS ========================
const WGSL_COMPUTE_SHADER = /* wgsl */ `
struct Uniforms {
  camPos: vec4<f32>,       // xyz = origin, w = aspect
  camRight: vec4<f32>,     // xyz = right,  w = halfFovRad (horizontal for fisheye, vertical tan for rect)
  camUp: vec4<f32>,        // xyz = up,     w = lensMode (-1=rect, 0=equidist, 1=panini, 2=stereo)
  camForward: vec4<f32>,   // xyz = fwd,    w = frameIndex (0 = reset)
  dims: vec4<f32>,         // x = width, y = height, z = isEvening, w = sppPerPass
  envParams: vec4<f32>,    // x = nodeCount, y = triCount, z = lightCount, w = exposure
  lights: array<vec4<f32>, 12>, // 4 lights * 3 vec4: [cx,cy,cz,axis], [halfU,halfV,0,0], [r,g,b,0]
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bvhNodes: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> triData: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> matData: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> accumBuf: array<vec4<f32>>;

fn pcgHash(input: u32) -> u32 {
  let state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn randFloat(seed: ptr<function, u32>) -> f32 {
  *seed = pcgHash(*seed);
  return f32(*seed) / 4294967295.0;
}

fn buildOrthonormalBasis(n: vec3<f32>) -> mat3x3<f32> {
  let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(n.y) < 0.99);
  let t = normalize(cross(up, n));
  let b = cross(n, t);
  return mat3x3<f32>(t, b, n);
}

fn sampleCosineHemisphere(n: vec3<f32>, u1: f32, u2: f32) -> vec3<f32> {
  let r = sqrt(max(0.0, u1));
  let phi = 6.2831853 * u2;
  let x = r * cos(phi);
  let y = r * sin(phi);
  let z = sqrt(max(0.0, 1.0 - u1));
  let basis = buildOrthonormalBasis(n);
  return normalize(basis * vec3<f32>(x, y, z));
}

fn sampleGGX(n: vec3<f32>, roughness: f32, u1: f32, u2: f32) -> vec3<f32> {
  let a = max(0.03, roughness * roughness);
  let phi = 6.2831853 * u2;
  let cosTheta = sqrt((1.0 - u1) / max(1e-5, 1.0 + (a * a - 1.0) * u1));
  let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  let hLocal = vec3<f32>(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
  let basis = buildOrthonormalBasis(n);
  return normalize(basis * hLocal);
}

fn generatePrimaryRay(ndc: vec2<f32>, outValid: ptr<function, bool>) -> vec3<f32> {
  let aspect = u.camPos.w;
  let mode = i32(round(u.camUp.w));
  *outValid = true;

  var camDir: vec3<f32>;
  if (mode < 0) {
    // Standard rectilinear perspective (camRight.w = tan(vFov / 2))
    let tanHalfV = u.camRight.w;
    camDir = normalize(vec3<f32>(ndc.x * aspect * tanHalfV, ndc.y * tanHalfV, -1.0));
  } else {
    let uu = ndc.x * aspect;
    let vv = ndc.y;
    let halfFov = u.camRight.w;
    if (mode == 0) {
      // True Equidistant Fisheye: r = f * theta
      let rho = length(vec2<f32>(uu, vv));
      let theta = rho * (halfFov / max(aspect, 0.001));
      if (theta >= 3.10) {
        *outValid = false;
        return vec3<f32>(0.0, 0.0, -1.0);
      }
      if (rho < 1e-5) {
        camDir = vec3<f32>(0.0, 0.0, -1.0);
      } else {
        let s = sin(theta) / rho;
        camDir = normalize(vec3<f32>(uu * s, vv * s, -cos(theta)));
      }
    } else if (mode == 1) {
      // Architectural Panini (d = 1): vertical lines stay straight!
      let k = (2.0 * tan(halfFov * 0.5)) / max(aspect, 0.001);
      let xPan = uu * k;
      let yPan = vv * k;
      let lam = 2.0 * atan(xPan * 0.5);
      if (abs(lam) >= 3.04) {
        *outValid = false;
        return vec3<f32>(0.0, 0.0, -1.0);
      }
      let tanPsi = yPan * 0.5 * (1.0 + cos(lam));
      camDir = normalize(vec3<f32>(sin(lam), tanPsi, -cos(lam)));
    } else {
      // Conformal Stereographic
      let rho = length(vec2<f32>(uu, vv));
      let k = tan(halfFov * 0.5) / max(aspect, 0.001);
      let theta = 2.0 * atan(rho * k);
      if (theta >= 3.10) {
        *outValid = false;
        return vec3<f32>(0.0, 0.0, -1.0);
      }
      if (rho < 1e-5) {
        camDir = vec3<f32>(0.0, 0.0, -1.0);
      } else {
        let s = sin(theta) / rho;
        camDir = normalize(vec3<f32>(uu * s, vv * s, -cos(theta)));
      }
    }
  }
  return normalize(
    u.camRight.xyz * camDir.x +
    u.camUp.xyz * camDir.y +
    u.camForward.xyz * (-camDir.z)
  );
}

fn intersectAABB(ro: vec3<f32>, invDir: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>, maxT: f32) -> f32 {
  let t0 = (bmin - ro) * invDir;
  let t1 = (bmax - ro) * invDir;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tNear = max(max(tmin.x, tmin.y), max(tmin.z, 0.0005));
  let tFar = min(min(tmax.x, tmax.y), min(tmax.z, maxT));
  return select(1e30, tNear, tFar >= tNear);
}

struct Hit {
  t: f32,
  triIdx: i32,
  matIdx: i32,
  normal: vec3<f32>,
};

fn traceBVH(ro: vec3<f32>, rd: vec3<f32>, maxT: f32, anyHit: bool) -> Hit {
  var hit: Hit;
  hit.t = maxT;
  hit.triIdx = -1;
  hit.matIdx = -1;
  hit.normal = vec3<f32>(0.0, 1.0, 0.0);

  let safeRd = vec3<f32>(
    select(rd.x, 1e-7, abs(rd.x) < 1e-7),
    select(rd.y, 1e-7, abs(rd.y) < 1e-7),
    select(rd.z, 1e-7, abs(rd.z) < 1e-7)
  );
  let invDir = 1.0 / safeRd;

  var stack: array<i32, 36>;
  var sp: i32 = 0;
  stack[0] = 0;
  sp = 1;

  while (sp > 0) {
    sp -= 1;
    let nodeIdx = stack[sp];
    let n0 = bvhNodes[nodeIdx * 2];
    let n1 = bvhNodes[nodeIdx * 2 + 1];
    let triCount = i32(round(n1.w));

    if (triCount > 0) {
      let firstTri = i32(round(n0.w));
      for (var i: i32 = 0; i < triCount; i++) {
        let tIdx = firstTri + i;
        let tv0 = triData[tIdx * 4];
        let te1 = triData[tIdx * 4 + 1].xyz;
        let te2 = triData[tIdx * 4 + 2].xyz;
        let pvec = cross(rd, te2);
        let det = dot(te1, pvec);
        if (abs(det) < 1e-7) { continue; }
        let invDet = 1.0 / det;
        let tvec = ro - tv0.xyz;
        let uu = dot(tvec, pvec) * invDet;
        if (uu < 0.0 || uu > 1.0) { continue; }
        let qvec = cross(tvec, te1);
        let vv = dot(rd, qvec) * invDet;
        if (vv < 0.0 || uu + vv > 1.0) { continue; }
        let tt = dot(te2, qvec) * invDet;
        if (tt > 0.0008 && tt < hit.t) {
          let mIdx = i32(round(tv0.w));
          if (anyHit) {
            // Skip clear glass in shadow occlusion rays so sunlight shines cleanly through glass cabinet doors!
            let m2 = matData[mIdx * 3 + 2];
            if (m2.x > 0.65) { continue; }
            hit.t = tt;
            hit.triIdx = tIdx;
            hit.matIdx = mIdx;
            return hit;
          }
          hit.t = tt;
          hit.triIdx = tIdx;
          hit.matIdx = mIdx;
          hit.normal = triData[tIdx * 4 + 3].xyz;
        }
      }
    } else {
      let leftIdx = i32(round(n0.w));
      let rightIdx = leftIdx + 1;
      let dL = intersectAABB(ro, invDir, bvhNodes[leftIdx * 2].xyz, bvhNodes[leftIdx * 2 + 1].xyz, hit.t);
      let dR = intersectAABB(ro, invDir, bvhNodes[rightIdx * 2].xyz, bvhNodes[rightIdx * 2 + 1].xyz, hit.t);
      if (dL < dR) {
        if (dR < hit.t && sp < 35) { stack[sp] = rightIdx; sp += 1; }
        if (dL < hit.t && sp < 35) { stack[sp] = leftIdx; sp += 1; }
      } else {
        if (dL < hit.t && sp < 35) { stack[sp] = leftIdx; sp += 1; }
        if (dR < hit.t && sp < 35) { stack[sp] = rightIdx; sp += 1; }
      }
    }
  }
  return hit;
}

fn skyRadiance(rd: vec3<f32>, isEvening: bool) -> vec3<f32> {
  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  if (isEvening) {
    let horizon = vec3<f32>(0.05, 0.065, 0.11);
    let zenith = vec3<f32>(0.015, 0.025, 0.06);
    return mix(horizon, zenith, t);
  }
  let horizon = vec3<f32>(0.88, 0.90, 0.93);
  let zenith = vec3<f32>(0.42, 0.66, 0.96);
  var sky = mix(horizon, zenith, pow(t, 0.7));
  let sunDir = normalize(vec3<f32>(0.45, 0.72, -0.52));
  let sunDot = max(0.0, dot(rd, sunDir));
  sky += vec3<f32>(1.0, 0.94, 0.82) * pow(sunDot, 48.0) * 3.5;
  return sky * 1.15;
}

fn woodGrainMod(pos: vec3<f32>, strength: f32, scale: f32) -> f32 {
  if (strength <= 0.001) { return 1.0; }
  let p = pos * (14.0 * scale);
  let wave = sin(p.x * 2.2 + sin(p.z * 0.8 + p.y * 0.6) * 2.4) * 0.5 + 0.5;
  let fine = sin(p.x * 9.5 + p.z * 1.3 + p.y * 3.1) * 0.5 + 0.5;
  let plank = select(1.0, 0.93, fract(pos.x * 6.5) < 0.045 && abs(pos.y) < 0.03);
  return (1.0 - strength * 0.55 + (wave * 0.65 + fine * 0.35) * strength) * plank;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let pxIdx = gid.y * w + gid.x;
  let frameIdx = u32(u.camForward.w);
  let spp = max(1u, u32(u.dims.w));
  let isEvening = u.dims.z > 0.5;
  let lightCount = i32(round(u.envParams.z));

  var colSum = vec3<f32>(0.0);

  for (var s: u32 = 0u; s < spp; s++) {
    var seed = pcgHash(pxIdx * 1973u + (frameIdx * spp + s) * 9277u + 17u);
    let jx = randFloat(&seed);
    let jy = randFloat(&seed);
    let uv = (vec2<f32>(f32(gid.x) + jx, f32(gid.y) + jy) / vec2<f32>(f32(w), f32(h)));
    let ndc = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);

    var valid = true;
    var rd = generatePrimaryRay(ndc, &valid);
    if (!valid) {
      colSum += vec3<f32>(0.03, 0.035, 0.045);
      continue;
    }
    var ro = u.camPos.xyz;
    var throughput = vec3<f32>(1.0);
    var radiance = vec3<f32>(0.0);

    for (var bounce: i32 = 0; bounce < 4; bounce++) {
      let hit = traceBVH(ro, rd, 1e20, false);
      if (hit.triIdx < 0) {
        radiance += throughput * skyRadiance(rd, isEvening);
        break;
      }

      let hitPos = ro + rd * hit.t;
      let frontFace = dot(rd, hit.normal) < 0.0;
      let n = select(-hit.normal, hit.normal, frontFace);

      let m0 = matData[hit.matIdx * 3];
      let m1 = matData[hit.matIdx * 3 + 1];
      let m2 = matData[hit.matIdx * 3 + 2];

      let grain = woodGrainMod(hitPos, m2.z, m2.w);
      let albedo = clamp(m0.xyz * grain, vec3<f32>(0.01), vec3<f32>(0.98));
      let roughness = clamp(m0.w, 0.04, 0.98);
      let emissive = m1.xyz;
      let metalness = clamp(m1.w, 0.0, 1.0);
      let transmission = m2.x;
      let ior = max(1.0, m2.y);

      radiance += throughput * emissive;

      // Glass / dielectric transmission & crisp Fresnel reflection (TONSTAD & IDANÄS glass doors!)
      if (transmission > 0.5) {
        let cosI = clamp(dot(-rd, n), 0.0, 1.0);
        let r0 = pow((1.0 - ior) / (1.0 + ior), 2.0);
        let fresnel = r0 + (1.0 - r0) * pow(1.0 - cosI, 5.0);
        if (randFloat(&seed) < clamp(fresnel * 1.45, 0.06, 0.92)) {
          rd = normalize(reflect(rd, n));
          ro = hitPos + n * 0.002;
          throughput *= vec3<f32>(0.96, 0.98, 1.0);
        } else {
          // Thin architectural cabinet glass pane: pass straight through with subtle glass tint
          ro = hitPos - n * 0.0025;
          throughput *= mix(vec3<f32>(1.0), vec3<f32>(0.91, 0.96, 0.97), 0.35);
        }
        continue;
      }

      // Direct Illumination (Next Event Estimation) from physical Window Portals + Ceiling/Lamp Softboxes!
      if (lightCount > 0 && roughness > 0.06) {
        let lIdx = min(lightCount - 1, i32(floor(randFloat(&seed) * f32(lightCount))));
        let l0 = u.lights[lIdx * 3];
        let l1 = u.lights[lIdx * 3 + 1];
        let l2 = u.lights[lIdx * 3 + 2];
        let lu = (randFloat(&seed) * 2.0 - 1.0) * l1.x;
        let lv = (randFloat(&seed) * 2.0 - 1.0) * l1.y;
        let axis = i32(round(l0.w));
        var lPos = l0.xyz;
        if (axis == 0) { lPos += vec3<f32>(lu, lv, 0.0); }
        else if (axis == 1) { lPos += vec3<f32>(0.0, lv, lu); }
        else { lPos += vec3<f32>(lu, 0.0, lv); }

        let toLight = lPos - hitPos;
        let dist2 = max(0.08, dot(toLight, toLight));
        let dist = sqrt(dist2);
        let lDir = toLight / dist;
        let ndl = dot(n, lDir);
        if (ndl > 0.001) {
          let shadowHit = traceBVH(hitPos + n * 0.003, lDir, dist - 0.04, true);
          if (shadowHit.triIdx < 0) {
            let area = 4.0 * l1.x * l1.y;
            let diffWeight = (1.0 - metalness) * (albedo / 3.14159265);
            let hVec = normalize(lDir - rd);
            let ndh = max(0.0, dot(n, hVec));
            let specPow = mix(128.0, 4.0, roughness * roughness);
            let specVal = pow(ndh, specPow) * (specPow + 8.0) / 25.1327;
            let f0 = mix(vec3<f32>(0.04), albedo, metalness);
            let brdf = diffWeight + f0 * specVal * 0.25;
            let atten = min(2.2, area / (dist2 + 0.35));
            radiance += throughput * brdf * l2.xyz * ndl * atten * f32(lightCount);
          }
        }
      }

      // Indirect bounce (GGX specular vs cosine-weighted diffuse)
      let f0 = mix(vec3<f32>(0.04), albedo, metalness);
      let cosV = clamp(dot(-rd, n), 0.0, 1.0);
      let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - cosV, 5.0);
      let specProb = clamp(mix(max(fresnel.x, max(fresnel.y, fresnel.z)), 0.92, metalness) * (1.0 - roughness * 0.55), 0.04, 0.95);

      if (randFloat(&seed) < specProb) {
        let hVec = sampleGGX(n, roughness, randFloat(&seed), randFloat(&seed));
        let nextRd = normalize(reflect(rd, hVec));
        if (dot(nextRd, n) <= 0.001) { break; }
        rd = nextRd;
        throughput *= fresnel / max(0.05, specProb);
      } else {
        rd = sampleCosineHemisphere(n, randFloat(&seed), randFloat(&seed));
        throughput *= (albedo * (1.0 - metalness)) / max(0.05, 1.0 - specProb);
      }

      ro = hitPos + n * 0.0025;
      // Fireflies clamp for silky fast convergence
      throughput = min(throughput, vec3<f32>(3.0));
      if (bounce >= 2) {
        let p = clamp(max(throughput.x, max(throughput.y, throughput.z)), 0.05, 0.95);
        if (randFloat(&seed) > p) { break; }
        throughput /= p;
      }
    }

    colSum += min(radiance, vec3<f32>(12.0));
  }

  let sampleAvg = colSum / f32(spp);
  if (frameIdx == 0u) {
    accumBuf[pxIdx] = vec4<f32>(sampleAvg, 1.0);
  } else {
    let prev = accumBuf[pxIdx];
    let n = prev.w + 1.0;
    accumBuf[pxIdx] = vec4<f32>(mix(prev.xyz, sampleAvg, 1.0 / n), n);
  }
}
`;

const WGSL_DISPLAY_SHADER = /* wgsl */ `
struct DispUniforms {
  dims: vec4<f32>, // x = width, y = height, z = exposure, w = 0
};

@group(0) @binding(0) var<uniform> d: DispUniforms;
@group(0) @binding(1) var<storage, read> accumBuf: array<vec4<f32>>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) idx: u32) -> VSOut {
  var pts = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var out: VSOut;
  let p = pts[idx];
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

fn acesFilm(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d0 = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d0) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let w = u32(d.dims.x);
  let h = u32(d.dims.y);
  let px = min(w - 1u, u32(clamp(in.uv.x, 0.0, 0.9999) * f32(w)));
  let py = min(h - 1u, u32(clamp(in.uv.y, 0.0, 0.9999) * f32(h)));
  let hdr = accumBuf[py * w + px].xyz * d.dims.z;
  let mapped = acesFilm(hdr);
  let srgb = pow(mapped, vec3<f32>(1.0 / 2.2));
  return vec4<f32>(srgb, 1.0);
}
`;

// ======================== WEBGL2 FLOAT-TEXTURE FALLBACK SHADERS ========================
const GLSL_QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const GLSL_RT_FS = /* glsl */ `
precision highp float;
precision highp int;

uniform sampler2D uPrevAccum;
uniform sampler2D uBvhTex;
uniform sampler2D uTriTex;
uniform sampler2D uMatTex;
uniform vec2 uBvhTexSize;
uniform vec2 uTriTexSize;
uniform vec2 uMatTexSize;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uAspect;
uniform float uHalfFovRad;
uniform int uLensMode;
uniform float uFrameIdx;
uniform float uIsEvening;
uniform vec2 uResolution;
uniform int uLightCount;
uniform vec4 uLights0[4];
uniform vec4 uLights1[4];
uniform vec4 uLights2[4];

varying vec2 vUv;

uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float randF(inout uint seed) {
  seed = pcgHash(seed);
  return float(seed) / 4294967295.0;
}

vec4 fetchTex(sampler2D tex, vec2 sz, int idx) {
  int w = int(sz.x);
  int y = idx / w;
  int x = idx - y * w;
  return texelFetch(tex, ivec2(x, y), 0);
}

mat3 buildBasis(vec3 n) {
  vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, n));
  vec3 b = cross(n, t);
  return mat3(t, b, n);
}

vec3 sampleCosHemi(vec3 n, float u1, float u2) {
  float r = sqrt(max(0.0, u1));
  float phi = 6.2831853 * u2;
  vec3 l = vec3(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1)));
  return normalize(buildBasis(n) * l);
}

vec3 sampleGGX(vec3 n, float rough, float u1, float u2) {
  float a = max(0.03, rough * rough);
  float phi = 6.2831853 * u2;
  float cosT = sqrt((1.0 - u1) / max(1e-5, 1.0 + (a * a - 1.0) * u1));
  float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  vec3 h = vec3(sinT * cos(phi), sinT * sin(phi), cosT);
  return normalize(buildBasis(n) * h);
}

vec3 genPrimaryRay(vec2 ndc, out bool valid) {
  valid = true;
  vec3 camDir;
  if (uLensMode < 0) {
    float tanHalfV = uHalfFovRad;
    camDir = normalize(vec3(ndc.x * uAspect * tanHalfV, ndc.y * tanHalfV, -1.0));
  } else {
    float uu = ndc.x * uAspect;
    float vv = ndc.y;
    if (uLensMode == 0) {
      float rho = length(vec2(uu, vv));
      float theta = rho * (uHalfFovRad / max(uAspect, 0.001));
      if (theta >= 3.10) { valid = false; return vec3(0.0, 0.0, -1.0); }
      camDir = rho < 1e-5 ? vec3(0.0, 0.0, -1.0) : normalize(vec3(uu * sin(theta) / rho, vv * sin(theta) / rho, -cos(theta)));
    } else if (uLensMode == 1) {
      float k = (2.0 * tan(uHalfFovRad * 0.5)) / max(uAspect, 0.001);
      float lam = 2.0 * atan(uu * k * 0.5);
      if (abs(lam) >= 3.04) { valid = false; return vec3(0.0, 0.0, -1.0); }
      float tanPsi = (vv * k) * 0.5 * (1.0 + cos(lam));
      camDir = normalize(vec3(sin(lam), tanPsi, -cos(lam)));
    } else {
      float rho = length(vec2(uu, vv));
      float k = tan(uHalfFovRad * 0.5) / max(uAspect, 0.001);
      float theta = 2.0 * atan(rho * k);
      if (theta >= 3.10) { valid = false; return vec3(0.0, 0.0, -1.0); }
      camDir = rho < 1e-5 ? vec3(0.0, 0.0, -1.0) : normalize(vec3(uu * sin(theta) / rho, vv * sin(theta) / rho, -cos(theta)));
    }
  }
  return normalize(uCamRight * camDir.x + uCamUp * camDir.y + uCamForward * (-camDir.z));
}

float hitAABB(vec3 ro, vec3 invD, vec3 bmin, vec3 bmax, float maxT) {
  vec3 t0 = (bmin - ro) * invD;
  vec3 t1 = (bmax - ro) * invD;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tN = max(max(tmin.x, tmin.y), max(tmin.z, 0.0005));
  float tF = min(min(tmax.x, tmax.y), min(tmax.z, maxT));
  return tF >= tN ? tN : 1e30;
}

bool traceScene(vec3 ro, vec3 rd, float maxT, bool anyHit, out float outT, out int outMat, out vec3 outN) {
  outT = maxT;
  outMat = -1;
  outN = vec3(0.0, 1.0, 0.0);
  vec3 safeRd = vec3(
    abs(rd.x) < 1e-7 ? 1e-7 : rd.x,
    abs(rd.y) < 1e-7 ? 1e-7 : rd.y,
    abs(rd.z) < 1e-7 ? 1e-7 : rd.z
  );
  vec3 invD = 1.0 / safeRd;

  int stack[32];
  int sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    int nodeIdx = stack[--sp];
    vec4 n0 = fetchTex(uBvhTex, uBvhTexSize, nodeIdx * 2);
    vec4 n1 = fetchTex(uBvhTex, uBvhTexSize, nodeIdx * 2 + 1);
    int triCount = int(n1.w + 0.5);
    if (triCount > 0) {
      int firstTri = int(n0.w + 0.5);
      for (int i = 0; i < 8; i++) {
        if (i >= triCount) break;
        int tIdx = firstTri + i;
        vec4 tv0 = fetchTex(uTriTex, uTriTexSize, tIdx * 4);
        vec3 te1 = fetchTex(uTriTex, uTriTexSize, tIdx * 4 + 1).xyz;
        vec3 te2 = fetchTex(uTriTex, uTriTexSize, tIdx * 4 + 2).xyz;
        vec3 pvec = cross(rd, te2);
        float det = dot(te1, pvec);
        if (abs(det) < 1e-7) continue;
        float invDet = 1.0 / det;
        vec3 tvec = ro - tv0.xyz;
        float uu = dot(tvec, pvec) * invDet;
        if (uu < 0.0 || uu > 1.0) continue;
        vec3 qvec = cross(tvec, te1);
        float vv = dot(rd, qvec) * invDet;
        if (vv < 0.0 || uu + vv > 1.0) continue;
        float tt = dot(te2, qvec) * invDet;
        if (tt > 0.0008 && tt < outT) {
          int mIdx = int(tv0.w + 0.5);
          if (anyHit) {
            vec4 m2 = fetchTex(uMatTex, uMatTexSize, mIdx * 3 + 2);
            if (m2.x > 0.65) continue;
            outT = tt;
            outMat = mIdx;
            return true;
          }
          outT = tt;
          outMat = mIdx;
          outN = fetchTex(uTriTex, uTriTexSize, tIdx * 4 + 3).xyz;
        }
      }
    } else {
      int leftIdx = int(n0.w + 0.5);
      int rightIdx = leftIdx + 1;
      float dL = hitAABB(ro, invD, fetchTex(uBvhTex, uBvhTexSize, leftIdx * 2).xyz, fetchTex(uBvhTex, uBvhTexSize, leftIdx * 2 + 1).xyz, outT);
      float dR = hitAABB(ro, invD, fetchTex(uBvhTex, uBvhTexSize, rightIdx * 2).xyz, fetchTex(uBvhTex, uBvhTexSize, rightIdx * 2 + 1).xyz, outT);
      if (dL < dR) {
        if (dR < outT && sp < 31) stack[sp++] = rightIdx;
        if (dL < outT && sp < 31) stack[sp++] = leftIdx;
      } else {
        if (dL < outT && sp < 31) stack[sp++] = leftIdx;
        if (dR < outT && sp < 31) stack[sp++] = rightIdx;
      }
    }
  }
  return outMat >= 0;
}

vec3 skyRad(vec3 rd) {
  float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  if (uIsEvening > 0.5) {
    return mix(vec3(0.05, 0.065, 0.11), vec3(0.015, 0.025, 0.06), t);
  }
  vec3 sky = mix(vec3(0.88, 0.90, 0.93), vec3(0.42, 0.66, 0.96), pow(t, 0.7));
  vec3 sunDir = normalize(vec3(0.45, 0.72, -0.52));
  sky += vec3(1.0, 0.94, 0.82) * pow(max(0.0, dot(rd, sunDir)), 48.0) * 3.5;
  return sky * 1.15;
}

float woodMod(vec3 pos, float strength, float sc) {
  if (strength <= 0.001) return 1.0;
  vec3 p = pos * (14.0 * sc);
  float w = sin(p.x * 2.2 + sin(p.z * 0.8 + p.y * 0.6) * 2.4) * 0.5 + 0.5;
  float f = sin(p.x * 9.5 + p.z * 1.3 + p.y * 3.1) * 0.5 + 0.5;
  float plank = (fract(pos.x * 6.5) < 0.045 && abs(pos.y) < 0.03) ? 0.93 : 1.0;
  return (1.0 - strength * 0.55 + (w * 0.65 + f * 0.35) * strength) * plank;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  uint seed = pcgHash(uint(px.y) * 4099u + uint(px.x) * 1973u + uint(uFrameIdx) * 9277u + 31u);
  vec2 jitter = vec2(randF(seed), randF(seed)) / uResolution;
  vec2 ndc = (vUv + jitter - 0.5 / uResolution) * 2.0 - 1.0;

  bool valid;
  vec3 rd = genPrimaryRay(ndc, valid);
  vec3 radiance = vec3(0.0);
  if (!valid) {
    radiance = vec3(0.03, 0.035, 0.045);
  } else {
    vec3 ro = uCamPos;
    vec3 throughput = vec3(1.0);
    for (int bounce = 0; bounce < 4; bounce++) {
      float tHit; int matIdx; vec3 nRaw;
      if (!traceScene(ro, rd, 1e20, false, tHit, matIdx, nRaw)) {
        radiance += throughput * skyRad(rd);
        break;
      }
      vec3 hitPos = ro + rd * tHit;
      vec3 n = dot(rd, nRaw) < 0.0 ? nRaw : -nRaw;

      vec4 m0 = fetchTex(uMatTex, uMatTexSize, matIdx * 3);
      vec4 m1 = fetchTex(uMatTex, uMatTexSize, matIdx * 3 + 1);
      vec4 m2 = fetchTex(uMatTex, uMatTexSize, matIdx * 3 + 2);

      vec3 albedo = clamp(m0.xyz * woodMod(hitPos, m2.z, m2.w), vec3(0.01), vec3(0.98));
      float rough = clamp(m0.w, 0.04, 0.98);
      float metal = clamp(m1.w, 0.0, 1.0);
      radiance += throughput * m1.xyz;

      if (m2.x > 0.5) {
        float cosI = clamp(dot(-rd, n), 0.0, 1.0);
        float ior = max(1.0, m2.y);
        float r0 = pow((1.0 - ior) / (1.0 + ior), 2.0);
        float fr = r0 + (1.0 - r0) * pow(1.0 - cosI, 5.0);
        if (randF(seed) < clamp(fr * 1.45, 0.06, 0.92)) {
          rd = normalize(reflect(rd, n));
          ro = hitPos + n * 0.002;
          throughput *= vec3(0.96, 0.98, 1.0);
        } else {
          ro = hitPos - n * 0.0025;
          throughput *= mix(vec3(1.0), vec3(0.91, 0.96, 0.97), 0.35);
        }
        continue;
      }

      if (uLightCount > 0 && rough > 0.06) {
        int lIdx = min(uLightCount - 1, int(floor(randF(seed) * float(uLightCount))));
        vec4 l0 = uLights0[0]; vec4 l1 = uLights1[0]; vec4 l2 = uLights2[0];
        if (lIdx == 1) { l0 = uLights0[1]; l1 = uLights1[1]; l2 = uLights2[1]; }
        else if (lIdx == 2) { l0 = uLights0[2]; l1 = uLights1[2]; l2 = uLights2[2]; }
        else if (lIdx == 3) { l0 = uLights0[3]; l1 = uLights1[3]; l2 = uLights2[3]; }
        float lu = (randF(seed) * 2.0 - 1.0) * l1.x;
        float lv = (randF(seed) * 2.0 - 1.0) * l1.y;
        int axis = int(l0.w + 0.5);
        vec3 lPos = l0.xyz + (axis == 0 ? vec3(lu, lv, 0.0) : axis == 1 ? vec3(0.0, lv, lu) : vec3(lu, 0.0, lv));
        vec3 toL = lPos - hitPos;
        float d2 = max(0.08, dot(toL, toL));
        float dist = sqrt(d2);
        vec3 lDir = toL / dist;
        float ndl = dot(n, lDir);
        if (ndl > 0.001) {
          float st; int sm; vec3 sn;
          if (!traceScene(hitPos + n * 0.003, lDir, dist - 0.04, true, st, sm, sn)) {
            float area = 4.0 * l1.x * l1.y;
            vec3 diffW = (1.0 - metal) * (albedo / 3.14159265);
            vec3 f0 = mix(vec3(0.04), albedo, metal);
            float spow = mix(128.0, 4.0, rough * rough);
            float sv = pow(max(0.0, dot(n, normalize(lDir - rd))), spow) * (spow + 8.0) / 25.1327;
            float atten = min(2.2, area / (d2 + 0.35));
            radiance += throughput * (diffW + f0 * sv * 0.25) * l2.xyz * ndl * atten * float(uLightCount);
          }
        }
      }

      vec3 f0 = mix(vec3(0.04), albedo, metal);
      float cosV = clamp(dot(-rd, n), 0.0, 1.0);
      vec3 fr = f0 + (vec3(1.0) - f0) * pow(1.0 - cosV, 5.0);
      float specP = clamp(mix(max(fr.x, max(fr.y, fr.z)), 0.92, metal) * (1.0 - rough * 0.55), 0.04, 0.95);
      if (randF(seed) < specP) {
        vec3 hv = sampleGGX(n, rough, randF(seed), randF(seed));
        vec3 nrd = normalize(reflect(rd, hv));
        if (dot(nrd, n) <= 0.001) break;
        rd = nrd;
        throughput *= fr / max(0.05, specP);
      } else {
        rd = sampleCosHemi(n, randF(seed), randF(seed));
        throughput *= (albedo * (1.0 - metal)) / max(0.05, 1.0 - specP);
      }
      ro = hitPos + n * 0.0025;
      throughput = min(throughput, vec3(3.0));
    }
    radiance = min(radiance, vec3(12.0));
  }

  if (uFrameIdx < 0.5) {
    gl_FragColor = vec4(radiance, 1.0);
  } else {
    vec4 prev = texture2D(uPrevAccum, vUv);
    float n = prev.a + 1.0;
    gl_FragColor = vec4(mix(prev.rgb, radiance, 1.0 / n), n);
  }
}
`;

const GLSL_TONEMAP_FS = /* glsl */ `
precision highp float;
uniform sampler2D uAccumTex;
uniform float uExposure;
varying vec2 vUv;

vec3 acesFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 hdr = texture2D(uAccumTex, vUv).rgb * uExposure;
  vec3 srgb = pow(acesFilm(hdr), vec3(1.0 / 2.2));
  gl_FragColor = vec4(srgb, 1.0);
}
`;

function packFloatDataTexture(floatArray) {
  const vec4Count = Math.max(1, Math.ceil(floatArray.length / 4));
  const width = Math.min(2048, vec4Count);
  const height = Math.ceil(vec4Count / width);
  const padded = new Float32Array(width * height * 4);
  padded.set(floatArray);
  const tex = new THREE.DataTexture(padded, width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, width, height };
}

export class GPURayTracer {
  constructor(threeRenderer, viewportEl) {
    this.threeRenderer = threeRenderer;
    this.viewportEl = viewportEl;
    this.backend = 'uninitialized'; // 'webgpu' | 'webgl2' | 'unavailable'
    this.active = false;
    this.samples = 0;
    this.targetSamples = 128;
    this.triCount = 0;
    this.nodeCount = 0;
    this.rtScene = null;
    this.width = 960;
    this.height = 540;
    this.lastRenderMs = 0;
    this._camSig = '';

    // WebGPU state
    this.gpuCanvas = null;
    this.gpuDevice = null;
    this.gpuCtx = null;
    this.gpuFormat = null;
    this.computePipeline = null;
    this.displayPipeline = null;
    this.uniformBuf = null;
    this.dispUniformBuf = null;
    this.bvhBuf = null;
    this.triBuf = null;
    this.matBuf = null;
    this.accumBuf = null;
    this.computeBG = null;
    this.displayBG = null;

    // WebGL2 fallback state
    this.glReady = false;
    this.glSceneRT = null;
    this.glSceneDisp = null;
    this.glCam = null;
    this.glMatRT = null;
    this.glMatDisp = null;
    this.glTargets = [null, null];
    this.glPing = 0;
    this.glBvhTex = null;
    this.glTriTex = null;
    this.glMatTex = null;
  }

  async init() {
    if (this.backend !== 'uninitialized') return this.backend;

    // 1. Prefer native WebGPU WGSL Compute Shader (blazingly fast on Apple Silicon M5 Chrome!)
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (adapter) {
          const device = await adapter.requestDevice();
          const canvas = document.createElement('canvas');
          canvas.className = 'rt-overlay-canvas';
          canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;display:none;';
          this.viewportEl.appendChild(canvas);

          const ctx = canvas.getContext('webgpu');
          if (ctx) {
            const format = navigator.gpu.getPreferredCanvasFormat();
            ctx.configure({ device, format, alphaMode: 'opaque' });

            const compMod = device.createShaderModule({ code: WGSL_COMPUTE_SHADER });
            const dispMod = device.createShaderModule({ code: WGSL_DISPLAY_SHADER });

            this.computePipeline = device.createComputePipeline({
              layout: 'auto',
              compute: { module: compMod, entryPoint: 'main' },
            });
            this.displayPipeline = device.createRenderPipeline({
              layout: 'auto',
              vertex: { module: dispMod, entryPoint: 'vs' },
              fragment: { module: dispMod, entryPoint: 'fs', targets: [{ format }] },
              primitive: { topology: 'triangle-list' },
            });

            // 18 vec4s = 288 bytes uniform buffer
            this.uniformBuf = device.createBuffer({
              size: 18 * 16,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.dispUniformBuf = device.createBuffer({
              size: 16,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });

            this.gpuDevice = device;
            this.gpuCanvas = canvas;
            this.gpuCtx = ctx;
            this.gpuFormat = format;
            this.backend = 'webgpu';
            return this.backend;
          }
          canvas.remove();
        }
      } catch (err) {
        console.warn('WebGPU RT init fell back to WebGL2 RT:', err?.message || err);
      }
    }

    // 2. Fallback: WebGL2 Float-Texture Path Tracer via existing Three.js WebGLRenderer
    if (this.threeRenderer?.capabilities?.isWebGL2) {
      this._initWebGL2();
      this.backend = 'webgl2';
      return this.backend;
    }

    this.backend = 'unavailable';
    return this.backend;
  }

  _initWebGL2() {
    this.glCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeo = new THREE.PlaneGeometry(2, 2);

    this.glMatRT = new THREE.ShaderMaterial({
      vertexShader: GLSL_QUAD_VS,
      fragmentShader: GLSL_RT_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrevAccum: { value: null },
        uBvhTex: { value: null },
        uTriTex: { value: null },
        uMatTex: { value: null },
        uBvhTexSize: { value: new THREE.Vector2(1, 1) },
        uTriTexSize: { value: new THREE.Vector2(1, 1) },
        uMatTexSize: { value: new THREE.Vector2(1, 1) },
        uCamPos: { value: new THREE.Vector3() },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uCamForward: { value: new THREE.Vector3(0, 0, -1) },
        uAspect: { value: 16 / 9 },
        uHalfFovRad: { value: 0.4 },
        uLensMode: { value: -1 },
        uFrameIdx: { value: 0 },
        uIsEvening: { value: 0 },
        uResolution: { value: new THREE.Vector2(640, 360) },
        uLightCount: { value: 3 },
        uLights0: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uLights1: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uLights2: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      },
    });

    this.glMatDisp = new THREE.ShaderMaterial({
      vertexShader: GLSL_QUAD_VS,
      fragmentShader: GLSL_TONEMAP_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uAccumTex: { value: null },
        uExposure: { value: 1.08 },
      },
    });

    this.glSceneRT = new THREE.Scene();
    this.glSceneRT.add(new THREE.Mesh(quadGeo, this.glMatRT));
    this.glSceneDisp = new THREE.Scene();
    this.glSceneDisp.add(new THREE.Mesh(quadGeo, this.glMatDisp));
    this.glReady = true;
  }

  setVisible(visible) {
    this.active = !!visible;
    if (this.gpuCanvas) {
      this.gpuCanvas.style.display = this.active ? 'block' : 'none';
    }
    if (this.active) {
      this.resetAccumulation();
    }
  }

  _ensureResolution(w, h) {
    const rw = Math.max(128, Math.round(w));
    const rh = Math.max(128, Math.round(h));
    if (this.width === rw && this.height === rh && (this.accumBuf || this.glTargets[0])) return;
    this.width = rw;
    this.height = rh;

    if (this.backend === 'webgpu' && this.gpuDevice) {
      this.gpuCanvas.width = rw;
      this.gpuCanvas.height = rh;
      if (this.accumBuf) this.accumBuf.destroy();
      this.accumBuf = this.gpuDevice.createBuffer({
        size: rw * rh * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this._rebuildWebGPUBindGroups();
    } else if (this.backend === 'webgl2' && this.glReady) {
      const hasFloatRT = this.threeRenderer.extensions.has('EXT_color_buffer_float');
      const rtOpts = {
        type: hasFloatRT ? THREE.FloatType : THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      };
      if (this.glTargets[0]) this.glTargets[0].dispose();
      if (this.glTargets[1]) this.glTargets[1].dispose();
      this.glTargets[0] = new THREE.WebGLRenderTarget(rw, rh, rtOpts);
      this.glTargets[1] = new THREE.WebGLRenderTarget(rw, rh, rtOpts);
      this.glPing = 0;
    }
    this.samples = 0;
  }

  _rebuildWebGPUBindGroups() {
    if (!this.gpuDevice || !this.bvhBuf || !this.triBuf || !this.matBuf || !this.accumBuf) return;
    this.computeBG = this.gpuDevice.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: { buffer: this.bvhBuf } },
        { binding: 2, resource: { buffer: this.triBuf } },
        { binding: 3, resource: { buffer: this.matBuf } },
        { binding: 4, resource: { buffer: this.accumBuf } },
      ],
    });
    this.displayBG = this.gpuDevice.createBindGroup({
      layout: this.displayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.dispUniformBuf } },
        { binding: 1, resource: { buffer: this.accumBuf } },
      ],
    });
  }

  uploadScene(rtScene) {
    this.rtScene = rtScene;
    this.triCount = rtScene.triCount;
    this.nodeCount = rtScene.nodeCount;
    this.samples = 0;

    if (this.backend === 'webgpu' && this.gpuDevice) {
      const makeBuf = (arr) => {
        const size = Math.max(16, Math.ceil(arr.byteLength / 16) * 16);
        const buf = this.gpuDevice.createBuffer({
          size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.gpuDevice.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, arr.byteLength);
        return buf;
      };
      if (this.bvhBuf) this.bvhBuf.destroy();
      if (this.triBuf) this.triBuf.destroy();
      if (this.matBuf) this.matBuf.destroy();
      this.bvhBuf = makeBuf(rtScene.bvhNodes);
      this.triBuf = makeBuf(rtScene.triData);
      this.matBuf = makeBuf(rtScene.matData);
      this._rebuildWebGPUBindGroups();
    } else if (this.backend === 'webgl2' && this.glReady) {
      if (this.glBvhTex) this.glBvhTex.dispose();
      if (this.glTriTex) this.glTriTex.dispose();
      if (this.glMatTex) this.glMatTex.dispose();
      const b = packFloatDataTexture(rtScene.bvhNodes);
      const t = packFloatDataTexture(rtScene.triData);
      const m = packFloatDataTexture(rtScene.matData);
      this.glBvhTex = b.tex;
      this.glTriTex = t.tex;
      this.glMatTex = m.tex;
      this.glMatRT.uniforms.uBvhTex.value = b.tex;
      this.glMatRT.uniforms.uBvhTexSize.value.set(b.width, b.height);
      this.glMatRT.uniforms.uTriTex.value = t.tex;
      this.glMatRT.uniforms.uTriTexSize.value.set(t.width, t.height);
      this.glMatRT.uniforms.uMatTex.value = m.tex;
      this.glMatRT.uniforms.uMatTexSize.value.set(m.width, m.height);
      this.glMatRT.uniforms.uIsEvening.value = rtScene.isEvening ? 1.0 : 0.0;
      const lc = Math.min(4, rtScene.lights.length);
      this.glMatRT.uniforms.uLightCount.value = lc;
      for (let i = 0; i < lc; i++) {
        const L = rtScene.lights[i];
        this.glMatRT.uniforms.uLights0.value[i].set(L.cx, L.cy, L.cz, L.axis);
        this.glMatRT.uniforms.uLights1.value[i].set(L.halfU, L.halfV, 0, 0);
        this.glMatRT.uniforms.uLights2.value[i].set(L.r, L.g, L.b, 0);
      }
    }
  }

  resetAccumulation() {
    this.samples = 0;
  }

  renderFrame(camera, cssWidth, cssHeight, lensConfig) {
    if (!this.active || !this.rtScene) return false;

    const camRight = new THREE.Vector3();
    const camUp = new THREE.Vector3();
    const camBack = new THREE.Vector3();
    camera.updateMatrixWorld();
    camera.matrixWorld.extractBasis(camRight, camUp, camBack);
    const camForward = camBack.clone().negate().normalize();
    camRight.normalize();
    camUp.normalize();

    const lensMode = lensConfig?.active ? lensConfig.modeInt : -1;
    const halfFovVal =
      lensMode >= 0
        ? THREE.MathUtils.degToRad((lensConfig.hFovDeg || 138) * 0.5)
        : Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));

    const sig = `${camera.position.x.toFixed(4)},${camera.position.y.toFixed(4)},${camera.position.z.toFixed(4)}|${camForward.x.toFixed(4)},${camForward.y.toFixed(4)},${camForward.z.toFixed(4)}|${lensMode}|${halfFovVal.toFixed(4)}|${cssWidth}x${cssHeight}`;
    const moved = sig !== this._camSig;
    this._camSig = sig;
    if (moved) {
      this.samples = 0;
    }

    // Scale internal resolution smartly: crisp full-res on WebGPU, balanced 0.65x on WebGL2 software fallback
    const dpr = this.backend === 'webgpu' ? Math.min(window.devicePixelRatio || 1, 1.5) : 0.65;
    const scale = moved ? dpr * 0.55 : dpr;
    const targetW = Math.min(1920, Math.max(320, Math.round(cssWidth * scale)));
    const targetH = Math.min(1200, Math.max(200, Math.round(cssHeight * scale)));
    this._ensureResolution(targetW, targetH);

    // Stop spending GPU cycles once converged!
    if (!moved && this.samples >= this.targetSamples) {
      if (this.backend === 'webgl2') {
        this._blitWebGL2();
      }
      return true;
    }

    // On slow software WebGL2 renderers, yield briefly between passes so UI & browser events stay snappy
    const nowMs = performance.now();
    if (!moved && this.backend === 'webgl2' && this.lastRenderMs > 150 && nowMs - (this._lastFinishMs || 0) < 45) {
      this._blitWebGL2();
      return true;
    }

    const t0 = nowMs;
    const aspect = cssWidth / Math.max(1, cssHeight);
    const exposure = this.rtScene.isEvening ? 1.18 : 1.06;

    if (this.backend === 'webgpu' && this.gpuDevice && this.computeBG && this.displayBG) {
      const sppPerPass = moved ? 1 : 2;
      const uData = new Float32Array(18 * 4);
      uData[0] = camera.position.x; uData[1] = camera.position.y; uData[2] = camera.position.z; uData[3] = aspect;
      uData[4] = camRight.x; uData[5] = camRight.y; uData[6] = camRight.z; uData[7] = halfFovVal;
      uData[8] = camUp.x; uData[9] = camUp.y; uData[10] = camUp.z; uData[11] = lensMode;
      uData[12] = camForward.x; uData[13] = camForward.y; uData[14] = camForward.z; uData[15] = this.samples;
      uData[16] = this.width; uData[17] = this.height; uData[18] = this.rtScene.isEvening ? 1 : 0; uData[19] = sppPerPass;
      const lc = Math.min(4, this.rtScene.lights.length);
      uData[20] = this.nodeCount; uData[21] = this.triCount; uData[22] = lc; uData[23] = exposure;
      for (let i = 0; i < lc; i++) {
        const L = this.rtScene.lights[i];
        const o = 24 + i * 12;
        uData[o] = L.cx; uData[o + 1] = L.cy; uData[o + 2] = L.cz; uData[o + 3] = L.axis;
        uData[o + 4] = L.halfU; uData[o + 5] = L.halfV; uData[o + 6] = 0; uData[o + 7] = 0;
        uData[o + 8] = L.r; uData[o + 9] = L.g; uData[o + 10] = L.b; uData[o + 11] = 0;
      }
      this.gpuDevice.queue.writeBuffer(this.uniformBuf, 0, uData);
      this.gpuDevice.queue.writeBuffer(this.dispUniformBuf, 0, new Float32Array([this.width, this.height, exposure, 0]));

      const enc = this.gpuDevice.createCommandEncoder();
      const cPass = enc.beginComputePass();
      cPass.setPipeline(this.computePipeline);
      cPass.setBindGroup(0, this.computeBG);
      cPass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
      cPass.end();

      const view = this.gpuCtx.getCurrentTexture().createView();
      const rPass = enc.beginRenderPass({
        colorAttachments: [{
          view,
          clearValue: { r: 0.05, g: 0.05, b: 0.06, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      rPass.setPipeline(this.displayPipeline);
      rPass.setBindGroup(0, this.displayBG);
      rPass.draw(3);
      rPass.end();
      this.gpuDevice.queue.submit([enc.finish()]);
      this.samples += sppPerPass;
    } else if (this.backend === 'webgl2' && this.glReady) {
      const readIdx = this.glPing;
      const writeIdx = 1 - this.glPing;
      const uni = this.glMatRT.uniforms;
      uni.uPrevAccum.value = this.glTargets[readIdx].texture;
      uni.uCamPos.value.copy(camera.position);
      uni.uCamRight.value.copy(camRight);
      uni.uCamUp.value.copy(camUp);
      uni.uCamForward.value.copy(camForward);
      uni.uAspect.value = aspect;
      uni.uHalfFovRad.value = halfFovVal;
      uni.uLensMode.value = lensMode;
      uni.uFrameIdx.value = this.samples;
      uni.uResolution.value.set(this.width, this.height);
      this.glMatDisp.uniforms.uExposure.value = exposure;

      this.threeRenderer.setRenderTarget(this.glTargets[writeIdx]);
      this.threeRenderer.render(this.glSceneRT, this.glCam);
      this.glPing = writeIdx;
      this._blitWebGL2();
      this.samples += 1;
    }

    this._lastFinishMs = performance.now();
    this.lastRenderMs = +(this._lastFinishMs - t0).toFixed(1);
    return true;
  }

  _blitWebGL2() {
    this.glMatDisp.uniforms.uAccumTex.value = this.glTargets[this.glPing].texture;
    this.threeRenderer.setRenderTarget(null);
    this.threeRenderer.render(this.glSceneDisp, this.glCam);
  }

  captureCanvasDataURL() {
    if (this.backend === 'webgpu' && this.gpuCanvas) {
      return this.gpuCanvas.toDataURL('image/png');
    }
    if (this.threeRenderer?.domElement) {
      return this.threeRenderer.domElement.toDataURL('image/png');
    }
    return null;
  }

  getStats() {
    return {
      backend: this.backend,
      samples: this.samples,
      targetSamples: this.targetSamples,
      triCount: this.triCount,
      width: this.width,
      height: this.height,
      lastRenderMs: this.lastRenderMs,
    };
  }
}
