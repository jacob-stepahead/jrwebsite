// Fluted (ribbed) glass: each vertical rib acts like a small cylindrical lens.
// Applied outside an elliptical clear window around the face, and across the
// whole frame while uFull rises (intro and scroll-out).

import { Vector2 } from 'three';

export const FlutedGlassShader = {
  name: 'FlutedGlassShader',
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new Vector2(1, 1) },
    uRib: { value: 22 },
    uStrength: { value: 18 },
    uDispersion: { value: 2 },
    uAmount: { value: 1 },
    uFull: { value: 1 },
    uCenter: { value: new Vector2(0.5, 0.56) },
    uRadius: { value: new Vector2(0.32, 0.46) },
    uSoft: { value: 0.55 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uRib;
    uniform float uStrength;
    uniform float uDispersion;
    uniform float uAmount;
    uniform float uFull;
    uniform vec2 uCenter;
    uniform vec2 uRadius;
    uniform float uSoft;
    uniform float uTime;
    varying vec2 vUv;

    void main() {
      float aspect = uRes.x / uRes.y;

      // Where the glass applies: outside the clear window, or everywhere when full.
      vec2 d = (vUv - uCenter) * vec2(aspect, 1.0) / uRadius;
      float window = smoothstep(1.0, 1.0 + uSoft, length(d));
      float k = clamp(max(window * uAmount, uFull), 0.0, 1.0);

      // Position across the rib, -1..1, and a cylinder-lens profile.
      float t = fract(vUv.x * uRes.x / uRib);
      float c = t * 2.0 - 1.0;
      float profile = c * sqrt(max(0.0, 1.0 - 0.3 * c * c));

      float shift = -profile * uStrength * k / uRes.x;
      float split = profile * uDispersion * k / uRes.x;
      float blur = k * 1.25 / uRes.x;

      vec3 col = vec3(0.0);
      for (int i = -2; i <= 2; i++) {
        vec2 uv = vUv + vec2(shift + float(i) * blur, 0.0);
        col.r += texture2D(tDiffuse, uv + vec2(split, 0.0)).r;
        col.g += texture2D(tDiffuse, uv).g;
        col.b += texture2D(tDiffuse, uv - vec2(split, 0.0)).b;
      }
      col /= 5.0;

      // Rib shading: a dark groove where ribs meet, a soft sheen on one flank.
      float groove = smoothstep(0.78, 1.0, abs(c));
      float sheen = smoothstep(0.1, 0.85, c) * (1.0 - groove);
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col *= 1.0 - 0.45 * groove * k;
      col += (0.006 + luma * 0.12) * sheen * k;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
