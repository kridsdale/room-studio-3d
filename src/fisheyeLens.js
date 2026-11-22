// Curvilinear Super-Wide-Angle Lens Shader Rig for Eye-Level Interior Views
// Renders the 3D scene from the eye-level viewpoint into a 360° cubemap and reprojects
// it through a full-screen GLSL shader supporting:
//   - Equidistant Fisheye  (mode 0): r = f * theta  (zero rectilinear edge stretch up to 165°)
//   - Architectural Panini (mode 1): d = 1 cylindrical-stereographic (straight vertical walls + ultra-wide horizontal FOV!)
//   - Stereographic Lens   (mode 2): r = 2f * tan(theta / 2) (conformal — preserves circles & local angles)
// Includes 4x rotated-grid supersampling (RGSS) in shader + exact JS unproject/project mirrors
// so clicking/dragging furniture and 3D floating labels stay pixel-accurate at any FOV.

import * as THREE from 'three';

export const LENS_MODES = {
  equidistant: 0,
  panini: 1,
  stereographic: 2,
  rectilinear: -1,
};

const VERTEX_SHADER = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform samplerCube uCubeMap;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uAspect;
uniform float uHalfFovRad;
uniform int uMode;
uniform vec2 uInvRes;

varying vec2 vNdc;

// Map a screen NDC coordinate (x, y in [-1, 1]) to a camera-space unit ray (+X right, +Y up, -Z forward).
// Sets outValid = false only if the ray falls outside the hemisphere/lens circle (> 179 deg).
vec3 ndcToCamRay(vec2 ndc, out bool outValid, out float outEdgeRatio) {
  float u = ndc.x * uAspect;
  float v = ndc.y;
  outValid = true;
  outEdgeRatio = 0.0;

  if (uMode == 0) {
    // Equidistant Fisheye: theta = rho * (halfFov / aspect)
    float rho = length(vec2(u, v));
    float theta = rho * (uHalfFovRad / max(uAspect, 0.001));
    outEdgeRatio = theta / 1.5707963;
    if (theta >= 3.12) {
      outValid = false;
      return vec3(0.0, 0.0, 1.0);
    }
    if (rho < 1e-5) {
      return vec3(0.0, 0.0, -1.0);
    }
    float s = sin(theta) / rho;
    return normalize(vec3(u * s, v * s, -cos(theta)));
  } else if (uMode == 1) {
    // Architectural Panini (d = 1): straight vertical lines + curvilinear horizontal wrap!
    float k = (2.0 * tan(uHalfFovRad * 0.5)) / max(uAspect, 0.001);
    float xPan = u * k;
    float yPan = v * k;
    float lambda = 2.0 * atan(xPan * 0.5);
    outEdgeRatio = abs(lambda) / 1.5707963;
    if (abs(lambda) >= 3.05) {
      outValid = false;
      return vec3(0.0, 0.0, 1.0);
    }
    float tanPsi = yPan * 0.5 * (1.0 + cos(lambda));
    return normalize(vec3(sin(lambda), tanPsi, -cos(lambda)));
  } else {
    // Stereographic Fisheye (conformal): theta = 2 * atan((rho / aspect) * tan(halfFov / 2))
    float rho = length(vec2(u, v));
    float k = tan(uHalfFovRad * 0.5) / max(uAspect, 0.001);
    float theta = 2.0 * atan(rho * k);
    outEdgeRatio = theta / 1.5707963;
    if (theta >= 3.12) {
      outValid = false;
      return vec3(0.0, 0.0, 1.0);
    }
    if (rho < 1e-5) {
      return vec3(0.0, 0.0, -1.0);
    }
    float s = sin(theta) / rho;
    return normalize(vec3(u * s, v * s, -cos(theta)));
  }
}

vec4 sampleAt(vec2 ndc, out float edgeRatio) {
  bool valid;
  vec3 camDir = ndcToCamRay(ndc, valid, edgeRatio);
  if (!valid) {
    return vec4(0.04, 0.045, 0.055, 1.0);
  }
  vec3 worldDir = normalize(
    uCamRight * camDir.x +
    uCamUp * camDir.y +
    uCamForward * (-camDir.z)
  );
  return textureCube(uCubeMap, worldDir);
}

void main() {
  // 4x Rotated-Grid Supersampling (RGSS) for razor-sharp antialiased curvilinear edges
  vec2 px = uInvRes * 2.0; // pixel step in NDC space
  float e0, e1, e2, e3;
  vec4 c0 = sampleAt(vNdc + vec2(-0.375, -0.125) * px, e0);
  vec4 c1 = sampleAt(vNdc + vec2( 0.125, -0.375) * px, e1);
  vec4 c2 = sampleAt(vNdc + vec2(-0.125,  0.375) * px, e2);
  vec4 c3 = sampleAt(vNdc + vec2( 0.375,  0.125) * px, e3);
  vec4 color = 0.25 * (c0 + c1 + c2 + c3);

  // Subtle natural optical lens vignette only near extreme wide-angle corners
  float avgEdge = 0.25 * (e0 + e1 + e2 + e3);
  float vig = 1.0 - smoothstep(0.78, 1.48, avgEdge) * 0.14;
  color.rgb *= vig;

  gl_FragColor = vec4(color.rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class FisheyeLensRig {
  constructor(renderer, cubeResolution = 1024) {
    this.mode = 'equidistant'; // 'equidistant' | 'panini' | 'stereographic' | 'rectilinear'
    this.hFovDeg = 138;        // 90° .. 165° horizontal FOV

    const supportsHalfFloatRT =
      renderer.capabilities.isWebGL2 &&
      (renderer.extensions.has('EXT_color_buffer_half_float') ||
        renderer.extensions.has('EXT_color_buffer_float'));

    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(cubeResolution, {
      type: supportsHalfFloatRT ? THREE.HalfFloatType : THREE.UnsignedByteType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });

    this.cubeCamera = new THREE.CubeCamera(0.06, 42, this.cubeRenderTarget);

    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
      uniforms: {
        uCubeMap: { value: this.cubeRenderTarget.texture },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uCamForward: { value: new THREE.Vector3(0, 0, -1) },
        uAspect: { value: 16 / 9 },
        uHalfFovRad: { value: THREE.MathUtils.degToRad(this.hFovDeg * 0.5) },
        uMode: { value: LENS_MODES.equidistant },
        uInvRes: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      },
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.postScene.add(quad);

    // Cubemap cache tracking — rotating head in place or scrubbing FOV/lens needs ZERO cubemap re-render!
    this._dirty = true;
    this._lastCubePos = new THREE.Vector3(NaN, NaN, NaN);

    // Reusable scratch vectors (zero per-frame GC allocations)
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  isActive() {
    return this.mode !== 'rectilinear';
  }

  setMode(mode) {
    if (mode in LENS_MODES) {
      this.mode = mode;
      if (mode !== 'rectilinear') {
        this.material.uniforms.uMode.value = LENS_MODES[mode];
      }
    }
  }

  setHFovDeg(deg) {
    this.hFovDeg = Math.max(85, Math.min(165, Number(deg) || 138));
    this.material.uniforms.uHalfFovRad.value = THREE.MathUtils.degToRad(this.hFovDeg * 0.5);
  }

  invalidate() {
    this._dirty = true;
  }

  _extractBasis(camera) {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    this._right.set(e[0], e[1], e[2]).normalize();
    this._up.set(e[4], e[5], e[6]).normalize();
    // Camera looks down its local -Z axis
    this._fwd.set(-e[8], -e[9], -e[10]).normalize();
  }

  render(renderer, scene, camera, width, height, forceCubemap = false) {
    this._extractBasis(camera);

    const moved =
      !Number.isFinite(this._lastCubePos.x) ||
      this._lastCubePos.distanceToSquared(camera.position) > 4e-6;

    if (forceCubemap || this._dirty || moved) {
      this.cubeCamera.position.copy(camera.position);
      this.cubeCamera.updateMatrixWorld();

      // Update directional/point shadow maps once on face 0 and reuse across faces 1..5
      const prevShadowAuto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;

      this.cubeCamera.update(renderer, scene);

      renderer.shadowMap.autoUpdate = prevShadowAuto;
      this._lastCubePos.copy(camera.position);
      this._dirty = false;
    }

    const u = this.material.uniforms;
    u.uCamRight.value.copy(this._right);
    u.uCamUp.value.copy(this._up);
    u.uCamForward.value.copy(this._fwd);
    u.uAspect.value = width / Math.max(1, height);
    u.uHalfFovRad.value = THREE.MathUtils.degToRad(this.hFovDeg * 0.5);
    u.uMode.value = LENS_MODES[this.mode] ?? 0;
    u.uInvRes.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));

    renderer.setRenderTarget(null);
    renderer.render(this.postScene, this.postCamera);
  }

  // Exact JS inverse of the GLSL shader: screen NDC -> world ray (for THREE.Raycaster picking & drag!)
  unprojectRay(ndcX, ndcY, camera, aspect, outRay) {
    this._extractBasis(camera);
    const halfFovRad = THREE.MathUtils.degToRad(this.hFovDeg * 0.5);
    const u = ndcX * aspect;
    const v = ndcY;
    let cx = 0;
    let cy = 0;
    let cz = -1;

    if (this.mode === 'equidistant') {
      const rho = Math.hypot(u, v);
      const theta = rho * (halfFovRad / Math.max(aspect, 0.001));
      if (rho >= 1e-5) {
        const s = Math.sin(theta) / rho;
        cx = u * s;
        cy = v * s;
        cz = -Math.cos(theta);
      }
    } else if (this.mode === 'panini') {
      const k = (2 * Math.tan(halfFovRad * 0.5)) / Math.max(aspect, 0.001);
      const xPan = u * k;
      const yPan = v * k;
      const lambda = 2 * Math.atan(xPan * 0.5);
      const tanPsi = yPan * 0.5 * (1 + Math.cos(lambda));
      cx = Math.sin(lambda);
      cy = tanPsi;
      cz = -Math.cos(lambda);
    } else {
      // stereographic
      const rho = Math.hypot(u, v);
      const k = Math.tan(halfFovRad * 0.5) / Math.max(aspect, 0.001);
      const theta = 2 * Math.atan(rho * k);
      if (rho >= 1e-5) {
        const s = Math.sin(theta) / rho;
        cx = u * s;
        cy = v * s;
        cz = -Math.cos(theta);
      }
    }

    const len = Math.hypot(cx, cy, cz) || 1;
    cx /= len;
    cy /= len;
    cz /= len;

    outRay.origin.copy(camera.position);
    outRay.direction
      .set(0, 0, 0)
      .addScaledVector(this._right, cx)
      .addScaledVector(this._up, cy)
      .addScaledVector(this._fwd, -cz)
      .normalize();
    return outRay;
  }

  // Exact JS forward projection: 3D world point -> 2D screen pixel (for 3D labels & selection gizmo!)
  projectPoint(worldVec3, camera, aspect, viewW, viewH) {
    this._extractBasis(camera);
    const d = this._tmp.copy(worldVec3).sub(camera.position);
    const dist = d.length();
    if (dist < 1e-4) return null;
    d.divideScalar(dist);

    const dx = d.dot(this._right);
    const dy = d.dot(this._up);
    const dz = -d.dot(this._fwd); // -1 = straight ahead, +1 = directly behind

    const halfFovRad = THREE.MathUtils.degToRad(this.hFovDeg * 0.5);
    let u = 0;
    let v = 0;

    if (this.mode === 'equidistant') {
      const theta = Math.acos(Math.max(-1, Math.min(1, -dz)));
      if (theta > Math.PI * 0.92) return null;
      const rho = theta * (aspect / Math.max(halfFovRad, 1e-4));
      const xyLen = Math.hypot(dx, dy);
      if (xyLen > 1e-5) {
        u = (dx / xyLen) * rho;
        v = (dy / xyLen) * rho;
      }
    } else if (this.mode === 'panini') {
      const horiz = Math.hypot(dx, dz);
      const lambda = Math.atan2(dx, -dz);
      if (Math.abs(lambda) > Math.PI * 0.85) return null;
      const denom = 1 + Math.cos(lambda);
      if (denom < 0.05) return null;
      const k = (2 * Math.tan(halfFovRad * 0.5)) / Math.max(aspect, 0.001);
      const xPan = (2 * Math.sin(lambda)) / denom;
      const yPan = (2 * (dy / Math.max(horiz, 1e-4))) / denom;
      u = xPan / k;
      v = yPan / k;
    } else {
      // stereographic
      const theta = Math.acos(Math.max(-1, Math.min(1, -dz)));
      if (theta > Math.PI * 0.92) return null;
      const k = Math.tan(halfFovRad * 0.5) / Math.max(aspect, 0.001);
      const rho = Math.tan(theta * 0.5) / Math.max(k, 1e-5);
      const xyLen = Math.hypot(dx, dy);
      if (xyLen > 1e-5) {
        u = (dx / xyLen) * rho;
        v = (dy / xyLen) * rho;
      }
    }

    const ndcX = u / Math.max(aspect, 0.001);
    const ndcY = v;
    if (ndcX < -1.15 || ndcX > 1.15 || ndcY < -1.15 || ndcY > 1.15) return null;

    return {
      x: (ndcX * 0.5 + 0.5) * viewW,
      y: (-ndcY * 0.5 + 0.5) * viewH,
    };
  }
}
