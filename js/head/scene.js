// Real-time head portrait: faceted metallic head, ribbon hair in the wind,
// glowing eyes, reeded-glass post-processing. No build step; three.js is
// vendored under js/vendor/three.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';

const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Palette (linear-ish HDR values; tone mapped in the final pass).
const PALETTE = {
  bgTop: new THREE.Color('#1a1f4a'),
  bgBottom: new THREE.Color('#030308'),
  glow: new THREE.Color('#e3260c'),
  face: new THREE.Color('#8d93ff'),
  hair: new THREE.Color('#9aa0c8'),
  sweater: new THREE.Color('#1a1c2a'),
  eye: new THREE.Color('#dfe9ff'),
  red: new THREE.Color('#ff2a08'),
  deepRed: new THREE.Color('#a10a00'),
  coolBlue: new THREE.Color('#7fb8d4'),
};

// ------------------------------------------------------------- shaders
const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BRIGHT_FRAG = /* glsl */`
  uniform sampler2D tInput; uniform float uThreshold; varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tInput, vUv).rgb;
    float l = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold * 2.0, l), 1.0);
  }
`;

// Dual-filter (Kawase) down / up sampling for a cheap, wide bloom.
const DOWN_FRAG = /* glsl */`
  uniform sampler2D tInput; uniform vec2 uTexel; varying vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec3 c = texture2D(tInput, vUv).rgb * 4.0;
    c += texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb;
    c += texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb;
    c += texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb;
    c += texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb;
    gl_FragColor = vec4(c / 8.0, 1.0);
  }
`;
const UP_FRAG = /* glsl */`
  uniform sampler2D tInput; uniform sampler2D tPrev; uniform vec2 uTexel; uniform float uMix; varying vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec3 c = vec3(0.0);
    c += texture2D(tInput, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
    c += texture2D(tInput, vUv + vec2(-o.x, o.y)).rgb * 2.0;
    c += texture2D(tInput, vUv + vec2(0.0, o.y * 2.0)).rgb;
    c += texture2D(tInput, vUv + vec2(o.x, o.y)).rgb * 2.0;
    c += texture2D(tInput, vUv + vec2(o.x * 2.0, 0.0)).rgb;
    c += texture2D(tInput, vUv + vec2(o.x, -o.y)).rgb * 2.0;
    c += texture2D(tInput, vUv + vec2(0.0, -o.y * 2.0)).rgb;
    c += texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
    gl_FragColor = vec4(c / 12.0 + texture2D(tPrev, vUv).rgb * uMix, 1.0);
  }
`;

const FINAL_FRAG = /* glsl */`
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform vec2 uRes;
  uniform float uTime;
  uniform float uExposure;
  uniform float uBloom;
  uniform vec3 uBgTop, uBgBottom, uGlow;
  uniform float uGlowStrength;
  uniform vec2 uGlowPos;
  // Reeded glass
  uniform float uGlass;        // overall 0..1
  uniform float uGlassHead;    // how much the glass affects the head (vs background)
  uniform float uGlassEdge;    // split boundary in 0..1 screen x
  uniform float uGlassSide;    // +1: glass right of boundary, -1: left, 0: everywhere
  uniform float uFlutePx;
  uniform float uRefractPx;
  uniform float uGrain;
  uniform float uVignette;
  varying vec2 vUv;

  vec3 background(vec2 uv) {
    vec3 c = mix(uBgBottom, uBgTop, pow(clamp(uv.y, 0.0, 1.0), 0.9));
    vec2 p = (uv - uGlowPos) * vec2(uRes.x / uRes.y, 1.0);
    c += uGlow * uGlowStrength * exp(-dot(p, p) * 7.0);
    c += uGlow * uGlowStrength * 0.12 * exp(-dot(p, p) * 1.6);
    return c;
  }

  vec3 composite(vec2 uv, out float cover) {
    vec4 s = texture2D(tScene, uv);
    cover = s.a;
    return background(uv) * (1.0 - s.a) + s.rgb + texture2D(tBloom, uv).rgb * uBloom;
  }

  vec3 aces(vec3 x) {
    // Narkowicz ACES fit
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 17.0) * 43758.5453); }

  void main() {
    vec2 uv = vUv;
    float cover;
    vec3 base = composite(uv, cover);

    // Where does the glass apply?
    float region = uGlassSide == 0.0 ? 1.0 : smoothstep(-0.015, 0.015, (uv.x - uGlassEdge) * uGlassSide);
    float g = uGlass * region;
    vec3 col = base;
    if (g > 0.001) {
      float fx = gl_FragCoord.x / uFlutePx;
      float local = fract(fx) * 2.0 - 1.0;              // -1..1 across one flute
      float prof = sign(local) * pow(abs(local), 1.6);  // cylindrical-ish lens profile
      float strength = mix(1.0, uGlassHead, cover);
      vec2 off = vec2(prof * uRefractPx / uRes.x, 0.0) * strength;
      // Slight frost: two taps offset vertically, more toward flute edges.
      float frost = abs(local) * 1.5 / uRes.y;
      float c1, c2;
      vec3 r = composite(uv + off + vec2(0.0, frost), c1) * 0.5 + composite(uv + off - vec2(0.0, frost), c2) * 0.5;
      // Bright edge on one side of each flute, dark crease on the other.
      float hi = smoothstep(0.55, 1.0, local) * 0.10 + smoothstep(-0.2, 0.3, local) * smoothstep(0.9, 0.3, local) * 0.02;
      float lo = smoothstep(-0.55, -1.0, local) * 0.35;
      r = r * (1.0 - lo * mix(1.0, 0.6, cover)) + vec3(0.62, 0.66, 0.9) * hi * (0.35 + 0.65 * (1.0 - cover));
      col = mix(base, r, g);
    }

    col *= uExposure;
    // Vignette, heavier at the bottom so the bust fades into the page.
    vec2 q = uv - vec2(0.5, 0.55);
    float vig = smoothstep(1.05, 0.25, length(q * vec2(uRes.x / uRes.y * 0.75, 1.0)));
    col *= mix(1.0, vig, uVignette);
    col *= mix(0.25, 1.0, smoothstep(0.0, 0.28, uv.y));

    col = aces(col);
    col = pow(col, vec3(1.0 / 2.2));
    col += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ------------------------------------------------------------ helpers
function makeFullscreenPass(fragmentShader, uniforms) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT, fragmentShader, uniforms,
    depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { mat, scene };
}

function buildEnvironment(renderer) {
  // A small studio made of coloured softboxes; reflected by the metallic
  // planes of the face it produces the blue-violet / ember palette.
  const env = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(100, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {},
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vDir; void main(){
        float y = vDir.y;
        vec3 top = vec3(0.10, 0.13, 0.32);
        vec3 mid = vec3(0.025, 0.028, 0.06);
        vec3 bot = vec3(0.0);
        vec3 c = y > 0.0 ? mix(mid, top, pow(y, 0.7)) : mix(mid, bot, pow(-y, 0.5));
        gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  env.add(sky);
  const panel = (w, h, color, intensity, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(70, 26, PALETTE.red, 1.1, [0, -55, 30]);        // ember floor bounce, below-front
  panel(18, 70, PALETTE.red, 1.2, [70, 0, -40]);        // right rim
  panel(14, 60, PALETTE.deepRed, 1.2, [-70, 10, -45]);  // left rim
  panel(60, 20, PALETTE.coolBlue, 0.8, [-20, 75, 20]);  // cool top softbox
  panel(40, 60, new THREE.Color('#6b6cff'), 0.55, [-60, 15, 55]); // violet key, front-left
  panel(30, 50, new THREE.Color('#3f4fb0'), 0.3, [55, 20, 60]);  // soft front-right fill
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.035);
  pmrem.dispose();
  return rt.texture;
}

// Inject per-vertex AO (COLOR_0.r) and facet variation (COLOR_0.g).
function withVertexAO(material, { direct = 0.55, facetJitter = 0.0 } = {}) {
  material.vertexColors = false;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 color;\nvarying vec2 vAOF;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAOF = color.rg;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vAOF;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= 1.0 + (vAOF.g - 0.5) * ${facetJitter.toFixed(3)};`)
      .replace('#include <aomap_fragment>', `
        float ao = vAOF.r;
        reflectedLight.indirectDiffuse *= ao;
        reflectedLight.indirectSpecular *= ao * ao;
        reflectedLight.directDiffuse *= mix(${(1 - direct).toFixed(3)}, 1.0, ao);
        reflectedLight.directSpecular *= mix(${(1 - direct).toFixed(3)}, 1.0, ao);`);
  };
  return material;
}

function hairWindMaterial(base, uniforms) {
  base.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 color;
        uniform float uTime; uniform float uWind;
        varying vec2 vAOF;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vAOF = color.rg;
        float t = color.g;             // 0 at the root, 1 at the tip
        float seed = color.b * 6.2831;
        float w = pow(t, 1.7) * uWind;
        float ph = uTime * 1.9 + seed + position.y * 0.18;
        vec3 gust = vec3(
          sin(ph) * 0.9 + sin(ph * 2.3 + 1.7) * 0.35,
          sin(ph * 1.3 + 0.5) * 0.55,
          cos(ph * 0.8 + seed) * 0.6 - 0.35);
        // Push outward from the centre of the head a little as well.
        vec3 out_ = normalize(vec3(position.x, 0.25, min(position.z, 0.0) - 1.0));
        transformed += (gust + out_ * (0.4 + 0.3 * sin(uTime * 0.7 + seed))) * w;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vAOF;')
      .replace('#include <aomap_fragment>', `
        float ao = vAOF.r;
        reflectedLight.indirectDiffuse *= ao;
        reflectedLight.indirectSpecular *= ao;
        reflectedLight.directDiffuse *= mix(0.4, 1.0, ao);
        reflectedLight.directSpecular *= mix(0.4, 1.0, ao);`);
  };
  return base;
}

const damp = (a, b, lambda, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt));

// ------------------------------------------------------------- main API
export async function createHeadScene(canvas, opts = {}) {
  const modelUrl = opts.modelUrl || 'assets/3d/head.glb';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.manual });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const maxDpr = opts.maxDpr || (IS_TOUCH ? 1.5 : 1.75);
  let dpr = Math.min(window.devicePixelRatio || 1, maxDpr);

  const scene = new THREE.Scene();
  scene.environment = buildEnvironment(renderer);
  scene.environmentIntensity = 1.0;

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
  camera.position.set(0, -8, 160);
  camera.lookAt(0, -1.5, 0);

  // Lights: ember key from below, red rims, cool top.
  const lights = [];
  const addLight = (light, base) => { light.userData.base = base; light.intensity = base; scene.add(light); lights.push(light); return light; };
  const under = addLight(new THREE.PointLight(PALETTE.red, 0, 0, 2), 700);
  under.position.set(0, -19, 16);
  const rimR = addLight(new THREE.SpotLight(PALETTE.red, 0, 0, Math.PI / 7, 0.6, 2), 4200);
  rimR.position.set(34, 10, -26);
  const rimL = addLight(new THREE.SpotLight(PALETTE.deepRed, 0, 0, Math.PI / 7, 0.7, 2), 3000);
  rimL.position.set(-34, 4, -24);
  const top = addLight(new THREE.SpotLight(PALETTE.coolBlue, 0, 0, Math.PI / 6, 0.8, 2), 1600);
  top.position.set(-8, 44, 12);
  addLight(new THREE.HemisphereLight(0x8fb4ff, 0x000000, 0), 0.12);
  // Violet key from the upper left: this is what makes the planes of the face read.
  const key = addLight(new THREE.DirectionalLight(0xb7b2ff, 0), 2.4);
  key.position.set(-22, 26, 40);
  // Faint warm fill from the right so the shadow side isn't a hole.
  const fill = addLight(new THREE.DirectionalLight(0xff6a3a, 0), 0.5);
  fill.position.set(30, -4, 24);
  for (const l of [rimR, rimL, top]) { l.target.position.set(0, 0, 0); scene.add(l.target); }

  // Model.
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().load(modelUrl, resolve, (e) => {
      if (opts.onProgress && e.total) opts.onProgress(e.loaded / e.total);
    }, reject);
  });
  const model = gltf.scene;
  const extras = gltf.parser.json.extras || {};
  const pivotPos = new THREE.Vector3(...(extras.neckPivot || [0, -6, -1.8]));

  const windUniforms = { uTime: { value: 0 }, uWind: { value: 1 } };
  const faceMat = withVertexAO(new THREE.MeshStandardMaterial({
    color: PALETTE.face, metalness: 0.9, roughness: 0.44, envMapIntensity: 1.0,
  }), { direct: 0.6, facetJitter: 0.05 });
  const capMat = withVertexAO(new THREE.MeshStandardMaterial({
    color: PALETTE.hair, metalness: 0.95, roughness: 0.5, envMapIntensity: 1.0,
  }), { direct: 0.5, facetJitter: 0.2 });
  const hairMat = hairWindMaterial(new THREE.MeshStandardMaterial({
    color: PALETTE.hair, metalness: 0.95, roughness: 0.42, envMapIntensity: 1.1,
  }), windUniforms);
  const sweaterMat = withVertexAO(new THREE.MeshStandardMaterial({
    color: PALETTE.sweater, metalness: 0.55, roughness: 0.62, envMapIntensity: 0.9,
  }), { direct: 0.7, facetJitter: 0.1 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: PALETTE.eye.clone().multiplyScalar(0.0) });

  const head = new THREE.Group();   // rotates for head-look
  head.position.copy(pivotPos);
  const body = new THREE.Group();   // breathes
  const meshes = {};
  model.traverse((o) => { if (o.isMesh) meshes[o.name] = o; });
  for (const [name, mesh] of Object.entries(meshes)) {
    mesh.removeFromParent();
    if (name === 'Face') mesh.material = faceMat;
    else if (name === 'HairCap') mesh.material = capMat;
    else if (name === 'Hair') mesh.material = hairMat;
    else if (name === 'Sweater') mesh.material = sweaterMat;
    else if (name.startsWith('Eye')) mesh.material = eyeMat;
    mesh.frustumCulled = false;
    if (name === 'Sweater') body.add(mesh);
    else { mesh.position.sub(pivotPos); head.add(mesh); }
  }
  const rig = new THREE.Group();
  rig.add(body, head);
  scene.add(rig);

  // Render targets.
  const rtOpts = { type: THREE.HalfFloatType, depthBuffer: true };
  const sceneRT = new THREE.WebGLRenderTarget(4, 4, { ...rtOpts, samples: IS_TOUCH ? 2 : 4 });
  const bloomLevels = 5;
  const downRTs = [], upRTs = [];
  for (let i = 0; i < bloomLevels; i++) {
    downRTs.push(new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false }));
    upRTs.push(new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false }));
  }
  const bright = makeFullscreenPass(BRIGHT_FRAG, { tInput: { value: null }, uThreshold: { value: 2.2 } });
  const down = makeFullscreenPass(DOWN_FRAG, { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const up = makeFullscreenPass(UP_FRAG, {
    tInput: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 1 },
  });
  const finalU = {
    tScene: { value: sceneRT.texture }, tBloom: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
    uExposure: { value: 0 }, uBloom: { value: 0.55 },
    uBgTop: { value: PALETTE.bgTop.clone() }, uBgBottom: { value: PALETTE.bgBottom.clone() },
    uGlow: { value: PALETTE.glow.clone() }, uGlowStrength: { value: 0.0 }, uGlowPos: { value: new THREE.Vector2(0.5, 0.1) },
    uGlass: { value: 0.35 }, uGlassHead: { value: 0.15 }, uGlassEdge: { value: 0.5 }, uGlassSide: { value: 0 },
    uFlutePx: { value: 14 }, uRefractPx: { value: 10 },
    uGrain: { value: IS_TOUCH ? 0.035 : 0.05 }, uVignette: { value: 0.65 },
  };
  const final = makeFullscreenPass(FINAL_FRAG, finalU);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ----------------------------------------------------------- state
  const state = {
    time: 0,
    mouse: new THREE.Vector2(0, 0),
    mouseTarget: new THREE.Vector2(0, 0),
    lastMove: -10,
    yaw: 0, pitch: 0,
    // Driven by the page (scroll):
    target: { x: 0, y: 0, turn: 0, glass: 0.35, glassHead: 0.15, glassEdge: 0.5, glassSide: 0, look: 1, eyes: 1, glow: 1, zoom: 1 },
    cur: { x: 0, y: 0, turn: 0, glass: 0.35, glassHead: 0.15, glassEdge: 0.5, look: 1, eyes: 1, glow: 1, zoom: 1 },
    intro: 0,          // 0..1 startup progress (driven by play())
    lightLevel: 0.1,
    eyeLevel: 0,
    exposure: 0,
    running: true,
    lock: null,        // {x, y}: pin the look direction (screenshots, video)
  };

  let width = 1, height = 1, frustumH = 46;
  function resize() {
    const vv = window.visualViewport;
    width = Math.max(1, Math.round(canvas.clientWidth || (vv ? vv.width : window.innerWidth)));
    height = Math.max(1, Math.round(canvas.clientHeight || (vv ? vv.height : window.innerHeight)));
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    const w = Math.round(width * dpr), h = Math.round(height * dpr);
    sceneRT.setSize(w, h);
    let bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    for (let i = 0; i < bloomLevels; i++) {
      downRTs[i].setSize(bw, bh);
      upRTs[i].setSize(bw, bh);
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
    finalU.uRes.value.set(w, h);
    finalU.uFlutePx.value = Math.max(8, Math.min(22, w * 0.0075)) ;
    finalU.uRefractPx.value = finalU.uFlutePx.value * 0.8;
    updateCamera();
  }

  function updateCamera() {
    const aspect = width / height;
    // Fit ~46 units of height; on narrow screens make sure the hair fits.
    frustumH = Math.max(46, 36 / aspect) / state.cur.zoom;
    const halfH = frustumH / 2, halfW = halfH * aspect;
    const cy = aspect < 0.8 ? -4 : -2.5;
    // target.x is a fraction of the viewport width (0.25 = a quarter to the right).
    const off = state.cur.x * 2 * halfW;
    camera.left = -halfW - off; camera.right = halfW - off;
    const offY = state.cur.y * 2 * halfH;
    camera.top = halfH + cy + offY; camera.bottom = -halfH + cy + offY; // +y moves the head down
    camera.updateProjectionMatrix();
  }

  function onPointer(e) {
    state.mouseTarget.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
    state.lastMove = state.time;
  }
  if (!IS_TOUCH) window.addEventListener('pointermove', onPointer, { passive: true });
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  window.addEventListener('resize', resize);
  resize();

  // ----------------------------------------------------------- frame
  function renderBloom() {
    bright.mat.uniforms.tInput.value = sceneRT.texture;
    renderer.setRenderTarget(downRTs[0]);
    renderer.render(bright.scene, orthoCam);
    for (let i = 1; i < bloomLevels; i++) {
      down.mat.uniforms.tInput.value = downRTs[i - 1].texture;
      down.mat.uniforms.uTexel.value.set(1 / downRTs[i - 1].width, 1 / downRTs[i - 1].height);
      renderer.setRenderTarget(downRTs[i]);
      renderer.render(down.scene, orthoCam);
    }
    let prev = downRTs[bloomLevels - 1];
    for (let i = bloomLevels - 2; i >= 0; i--) {
      up.mat.uniforms.tInput.value = prev.texture;
      up.mat.uniforms.tPrev.value = downRTs[i].texture;
      up.mat.uniforms.uTexel.value.set(1 / prev.width, 1 / prev.height);
      up.mat.uniforms.uMix.value = 1.0;
      renderer.setRenderTarget(upRTs[i]);
      renderer.render(up.scene, orthoCam);
      prev = upRTs[i];
    }
    return prev.texture;
  }

  function update(dt) {
    state.time += dt;
    const t = state.time;
    windUniforms.uTime.value = t;
    finalU.uTime.value = t % 100;

    // Smooth page-driven values.
    const c = state.cur, tg = state.target;
    for (const k of Object.keys(c)) c[k] = damp(c[k], tg[k], k === 'x' || k === 'y' || k === 'turn' ? 3.2 : 4.0, dt);
    finalU.uGlassSide.value = tg.glassSide;
    finalU.uGlass.value = c.glass;
    finalU.uGlassHead.value = c.glassHead;
    finalU.uGlassEdge.value = c.glassEdge;
    updateCamera();

    // Head look.
    const idle = t - state.lastMove > 2.5;
    let mx = state.mouseTarget.x, my = state.mouseTarget.y;
    if (state.lock) { mx = state.lock.x; my = state.lock.y; } else if (IS_TOUCH || idle || REDUCED_MOTION) {
      // Slow, subtle wander so the portrait never feels frozen.
      mx = Math.sin(t * 0.23) * 0.35 + Math.sin(t * 0.61) * 0.1;
      my = Math.sin(t * 0.17 + 1.3) * 0.18;
      if (REDUCED_MOTION) { mx *= 0.2; my *= 0.2; }
    }
    state.mouse.x = damp(state.mouse.x, mx, 2.6, dt);
    state.mouse.y = damp(state.mouse.y, my, 2.6, dt);
    const look = c.look * state.intro;
    const yaw = state.mouse.x * 0.42 * look + THREE.MathUtils.degToRad(c.turn);
    const pitch = -state.mouse.y * 0.16 * look;
    head.rotation.set(pitch, yaw, -state.mouse.x * 0.04 * look, 'YXZ');
    // Breathing.
    const br = Math.sin(t * 1.35) * 0.5 + 0.5;
    body.position.y = br * 0.14;
    body.scale.set(1 + br * 0.004, 1 + br * 0.006, 1 + br * 0.004);
    head.position.y = pivotPos.y + br * 0.12;
    head.rotation.x += (br - 0.5) * 0.012;

    // Lights, eyes, exposure (startup + page state).
    for (const l of lights) l.intensity = l.userData.base * state.lightLevel;
    const flicker = state.eyeLevel < 1 ? (0.75 + 0.25 * Math.sin(t * 60.0)) : 1;
    const eyeI = 3.6 * state.eyeLevel * c.eyes * flicker;
    eyeMat.color.copy(PALETTE.eye).multiplyScalar(eyeI);
    finalU.uGlowStrength.value = 0.32 * state.lightLevel * c.glow;
    finalU.uExposure.value = state.exposure;
  }

  function render() {
    renderer.setRenderTarget(sceneRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    finalU.tBloom.value = renderBloom();
    renderer.setRenderTarget(null);
    renderer.render(final.scene, orthoCam);
  }

  // Adaptive resolution: drop DPR if frames are consistently slow.
  let slowFor = 0, fastFor = 0;
  function adapt(dt) {
    if (dt > 0.2) return; // tab switch / hitch
    if (dt > 1 / 45) { slowFor += dt; fastFor = 0; } else if (dt < 1 / 58) { fastFor += dt; slowFor = 0; }
    if (slowFor > 2 && dpr > 0.75) { dpr = Math.max(0.75, dpr - 0.25); slowFor = 0; resize(); }
    if (fastFor > 8 && dpr < Math.min(window.devicePixelRatio || 1, maxDpr)) { dpr = Math.min(maxDpr, dpr + 0.25); fastFor = 0; resize(); }
  }

  let last = performance.now();
  let rafId = 0;
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!state.running) return;
    update(dt);
    render();
    adapt(dt);
  }

  // Startup: dark -> eyes flicker on -> lights ramp -> exposure up.
  function play({ instant = false } = {}) {
    if (instant || REDUCED_MOTION) {
      state.intro = 1; state.lightLevel = 1; state.eyeLevel = 1; state.exposure = 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const t0 = performance.now();
      const ease = (x) => x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
      const clamp01 = (x) => Math.min(1, Math.max(0, x));
      const step = () => {
        const s = (performance.now() - t0) / 1000;
        state.exposure = 0.18 + 0.82 * ease(clamp01((s - 1.5) / 1.6));
        state.eyeLevel = s < 0.9 ? 0 : s < 1.25 ? (Math.sin(s * 70) > 0 ? 0.6 : 0.05) : ease(clamp01((s - 1.25) / 0.35));
        state.lightLevel = 0.1 + 0.9 * ease(clamp01((s - 1.3) / 1.4));
        state.intro = ease(clamp01((s - 2.2) / 1.2));
        if (s < 3.5) requestAnimationFrame(step); else resolve();
      };
      step();
    });
  }

  // Deterministic stepping (used for screenshots / video capture).
  function renderAt(seconds, { intro = 1, lightLevel = intro, eyeLevel = intro, exposure = intro } = {}) {
    state.intro = intro; state.lightLevel = lightLevel; state.eyeLevel = eyeLevel; state.exposure = exposure;
    const steps = Math.max(1, Math.round((seconds - state.time) * 60));
    const dt = (seconds - state.time) / steps;
    for (let i = 0; i < steps; i++) update(dt);
    render();
  }

  document.addEventListener('visibilitychange', () => { last = performance.now(); });
  if (!opts.manual) rafId = requestAnimationFrame(loop);

  return {
    play,
    renderAt,
    state,
    setTarget(values) { Object.assign(state.target, values); },
    setMouse(x, y) { state.mouseTarget.set(x, y); state.lastMove = state.time; },
    pause() { state.running = false; },
    resume() { if (!state.running) { state.running = true; last = performance.now(); } },
    dispose() { cancelAnimationFrame(rafId); ro.disconnect(); renderer.dispose(); },
    renderer, scene, camera,
  };
}
