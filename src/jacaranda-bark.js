import * as THREE from 'three';

// Tree-local relief crosses the fused trunk / tube seams without relying on
// their different UV layouts. Only normals and roughness change, never albedo.
const barkFunctions = /* glsl */`
varying vec3 vBarkPosition;
uniform float barkRelief;

float barkHash(vec3 p) {
  p = fract(p * .1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float barkNoise(vec3 p) {
  vec3 cell = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(barkHash(cell), barkHash(cell + vec3(1, 0, 0)), f.x),
        mix(barkHash(cell + vec3(0, 1, 0)), barkHash(cell + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(barkHash(cell + vec3(0, 0, 1)), barkHash(cell + vec3(1, 0, 1)), f.x),
        mix(barkHash(cell + vec3(0, 1, 1)), barkHash(cell + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float barkDetailWeight(vec3 p) {
  // Fade subpixel detail rather than letting it sparkle during an orbit.
  vec3 footprint = fwidth(p);
  return 1.0 - smoothstep(.22, .85, max(footprint.x, max(footprint.y, footprint.z)));
}

void barkSurface(vec3 p, out float height, out vec2 slope) {
  vec3 broadGrain = p * vec3(8.5, 1.3, 8.5);
  vec3 ridges = p * vec3(22.0, 3.4, 22.0);
  // Slow lateral drift makes interrupted, winding grain rather than stripes.
  float drift = barkNoise(p * vec3(3.1, 1.7, 3.1));
  ridges.xz += vec2(drift, -drift) * .65;
  float grain = barkNoise(ridges);
  float fissure = 1.0 - smoothstep(.025, .13, abs(grain - .48));
  vec3 pores = p * vec3(48.0, 14.0, 48.0);
  float broad = .60 * (barkNoise(broadGrain) - .5);
  float grooved = .52 * grain - .38 * fissure;
  float fine = .22 * (barkNoise(pores) - .5);
  vec3 weight = vec3(barkDetailWeight(broadGrain), barkDetailWeight(ridges), barkDetailWeight(pores));
  height = dot(vec3(broad, grooved, fine), weight);
  // Differentiate only raw heights, then filter their slopes. Differentiating
  // the fwidth-based weights would require undefined higher-order derivatives.
  slope = vec2(dFdx(broad), dFdy(broad)) * weight.x
    + vec2(dFdx(grooved), dFdy(grooved)) * weight.y
    + vec2(dFdx(fine), dFdy(fine)) * weight.z;
}

vec3 barkSurfaceNormal(vec3 surface, vec3 surfaceNormal, vec2 slope, float faceSign) {
  // Surface-gradient bump mapping, with unnormalized derivatives so relief
  // stays in world units as the camera zooms in and out.
  vec3 dx = dFdx(surface), dy = dFdy(surface);
  vec3 r1 = cross(dy, surfaceNormal), r2 = cross(surfaceNormal, dx);
  float determinant = dot(dx, r1) * faceSign;
  vec3 gradient = sign(determinant) * (slope.x * r1 + slope.y * r2);
  return normalize(surfaceNormal - gradient / max(abs(determinant), 1e-8));
}
`;

export function createJacarandaBarkMaterial(color) {
  const material = new THREE.MeshStandardMaterial({ color, roughness: .93, metalness: 0, envMapIntensity: .14 });
  const relief = { value: .016 };
  material.userData.barkRelief = relief;
  material.onBeforeCompile = shader => {
    shader.uniforms.barkRelief = relief;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBarkPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBarkPosition = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${barkFunctions}`)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        #include <normal_fragment_maps>
        float woodHeight;
        vec2 woodSlope;
        barkSurface(vBarkPosition, woodHeight, woodSlope);
        normal = barkSurfaceNormal(-vViewPosition, normal, woodSlope * barkRelief, faceDirection);
        roughnessFactor = clamp(roughnessFactor + (woodHeight - .22) * barkRelief * 6.0, .86, .99);
      `);
  };
  material.customProgramCacheKey = () => 'jacaranda-bark-relief-v1';
  return material;
}
