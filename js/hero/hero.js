// 3D hero: Jacob's head, studio-lit, following the cursor behind fluted glass.
// Source file. The site loads the bundled build at js/hero.min.js —
// after editing this file run `npm run build` inside tools/.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FlutedGlassShader } from './fluted-glass.js';

// ---------------------------------------------------------------------------
// Settings: everything worth tuning lives here.
// ---------------------------------------------------------------------------
const SETTINGS = {
  // Height of the fitted model in world units (camera framing is based on it).
  headHeight: 2.0,
  // Pivot sits below the bounding-box centre so the head turns on the neck.
  pivotDrop: 0.18,
  // 'porcelain' | 'graphite' | 'original' (keep the GLB's own materials).
  material: 'porcelain',
  follow: { yaw: 0.5, pitch: 0.22, damping: 3.2, idleAfter: 2.6 },
  eyes: { color: '#ffd7a8', intensity: 3.2 },
  hair: { color: '#141210', roughness: 0.62 },
  bloom: { strength: 0.7, radius: 0.5, threshold: 1.15 },
  glass: {
    ribWidth: 22,      // CSS px per rib
    strength: 18,      // max refraction offset, CSS px
    dispersion: 2.2,   // chromatic split, CSS px
    amount: 1.0,       // glass outside the clear window
    clearRadius: [0.32, 0.46], // clear window around the face (x, y) in viewport heights
    softness: 0.55,
  },
  exposure: 0.92,
  maxDpr: 1.5,
};

const canvas = document.querySelector('.hero-canvas');
if (canvas) init(canvas);

function init(canvas) {
  const hero = canvas.closest('.hero');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  Object.assign(SETTINGS, { material: canvas.dataset.material || SETTINGS.material });

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch (err) {
    hero.classList.add('is-no-webgl');
    return;
  }

  const dpr = () => Math.min(window.devicePixelRatio || 1, SETTINGS.maxDpr);
  renderer.setPixelRatio(dpr());
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = SETTINGS.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#070708');
  scene.environment = buildStudioEnvironment(renderer);
  scene.environmentIntensity = 0.42;

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);

  addLights(scene);
  const backdrop = addBackdrop(scene);

  // pivot -> fitted model. Rotating the pivot turns the whole head.
  const pivot = new THREE.Group();
  scene.add(pivot);

  // --- post-processing: render -> bloom -> fluted glass -> tone map ------------
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: coarse ? 2 : 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), SETTINGS.bloom.strength, SETTINGS.bloom.radius, SETTINGS.bloom.threshold);
  composer.addPass(bloom);
  const glass = new ShaderPass(FlutedGlassShader);
  composer.addPass(glass);
  composer.addPass(new OutputPass());

  // --- state --------------------------------------------------------------
  const pointer = { x: 0, y: 0, lastMove: -Infinity };
  const look = { yaw: 0, pitch: 0 };
  const intro = { t: reduceMotion ? 1 : 0 };
  let mixer = null;
  let model = null;
  let scroll = 0;
  let visible = true;
  let running = false;
  const timer = new THREE.Timer();
  timer.connect(document);

  // --- sizing ---------------------------------------------------------------
  function resize() {
    const w = hero.clientWidth;
    const h = hero.clientHeight;
    const ratio = dpr();
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(ratio);
    composer.setSize(w, h);
    bloom.resolution.set(w * ratio, h * ratio);

    camera.aspect = w / h;
    // Fit the head by height on wide screens and by width on tall ones.
    const fitH = SETTINGS.headHeight / 0.62;
    const fitW = (SETTINGS.headHeight * 0.95) / 0.8;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const distH = fitH / (2 * tanHalf);
    const distW = fitW / (2 * tanHalf * camera.aspect);
    camera.position.set(0, 0.1, Math.max(distH, distW));
    camera.lookAt(0, 0.05, 0);
    camera.updateProjectionMatrix();

    const u = glass.uniforms;
    u.uRes.value.set(w * ratio, h * ratio);
    u.uRib.value = SETTINGS.glass.ribWidth * ratio;
    u.uStrength.value = SETTINGS.glass.strength * ratio;
    u.uDispersion.value = SETTINGS.glass.dispersion * ratio;
    u.uRadius.value.set(...SETTINGS.glass.clearRadius);
    u.uSoft.value = SETTINGS.glass.softness;
    render(0);
  }

  // --- model ----------------------------------------------------------------
  const modelUrl = pickModelUrl(canvas.dataset.model);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const progressEl = hero.querySelector('[data-hero-progress]');

  loader.load(
    modelUrl,
    (gltf) => {
      model = gltf.scene;
      fitModel(model);
      styleModel(model);
      pivot.add(model);
      if (gltf.animations.length) {
        mixer = new THREE.AnimationMixer(model);
        gltf.animations.forEach((clip) => mixer.clipAction(clip).play());
      }
      hero.classList.add('is-loaded');
      if (progressEl) progressEl.textContent = '100';
    },
    (event) => {
      if (progressEl && event.total) {
        progressEl.textContent = String(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    },
    () => {
      // No model yet (or it failed): keep the empty studio and say nothing.
      hero.classList.add('is-loaded', 'is-model-missing');
    }
  );

  function fitModel(object) {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = SETTINGS.headHeight / size.y;
    object.scale.setScalar(scale);
    object.position.copy(center).multiplyScalar(-scale);
    object.position.y += SETTINGS.pivotDrop * SETTINGS.headHeight;
    pivot.position.y = -SETTINGS.pivotDrop * SETTINGS.headHeight;
  }

  function styleModel(object) {
    const presets = {
      porcelain: () => new THREE.MeshPhysicalMaterial({
        color: '#b9b4ac', roughness: 0.46, metalness: 0, clearcoat: 0.22,
        clearcoatRoughness: 0.3, sheen: 0.35, sheenRoughness: 0.6, sheenColor: '#ffffff',
      }),
      graphite: () => new THREE.MeshPhysicalMaterial({
        color: '#17171a', roughness: 0.28, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.18,
      }),
    };
    const eyeMaterial = new THREE.MeshStandardMaterial({
      color: '#000000', emissive: SETTINGS.eyes.color, emissiveIntensity: SETTINGS.eyes.intensity, roughness: 0.2,
    });
    const hairMaterial = new THREE.MeshPhysicalMaterial({
      color: SETTINGS.hair.color, roughness: SETTINGS.hair.roughness, sheen: 0.6, sheenColor: '#5a4a3a',
    });
    const skin = presets[SETTINGS.material]?.();

    object.traverse((node) => {
      if (!node.isMesh) return;
      node.frustumCulled = false;
      const name = `${node.name} ${node.material?.name || ''}`;
      // Hair first, so "Eyebrows" / "Eyelashes" don't count as eyes.
      const isHair = /hair|brow|beard|lash/i.test(name);
      if (!isHair && /eye|iris|pupil/i.test(name)) node.material = eyeMaterial;
      else if (skin) node.material = isHair ? hairMaterial : skin;
    });
  }

  // --- input ----------------------------------------------------------------
  window.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    pointer.lastMove = timer.getElapsed();
  }, { passive: true });

  window.addEventListener('scroll', () => {
    scroll = Math.min(1, Math.max(0, window.scrollY / hero.clientHeight));
  }, { passive: true });

  window.addEventListener('resize', resize);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) start();
  }).observe(hero);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });

  // --- frame ----------------------------------------------------------------
  function update(dt) {
    const t = timer.getElapsed();
    const idle = t - pointer.lastMove > SETTINGS.follow.idleAfter;
    let tx = pointer.x;
    let ty = pointer.y;
    if (idle && !reduceMotion) {
      tx = Math.sin(t * 0.35) * 0.45;
      ty = Math.sin(t * 0.23 + 1.3) * 0.25;
    }
    const k = 1 - Math.exp(-dt * SETTINGS.follow.damping);
    look.yaw += (tx * SETTINGS.follow.yaw - look.yaw) * k;
    look.pitch += (ty * SETTINGS.follow.pitch - look.pitch) * k;

    if (model) intro.t = Math.min(1, intro.t + dt / 2.4);
    const e = easeOutCubic(intro.t);

    pivot.rotation.y = look.yaw + (1 - e) * -0.5;
    pivot.rotation.x = look.pitch;
    pivot.position.y = -SETTINGS.pivotDrop * SETTINGS.headHeight + scroll * 0.55
      + (reduceMotion ? 0 : Math.sin(t * 1.1) * 0.012);
    pivot.scale.setScalar(0.94 + 0.06 * e);

    // Backdrop strips drift slightly against the head for parallax.
    backdrop.position.x = -look.yaw * 0.35;

    const u = glass.uniforms;
    u.uTime.value = t;
    // Intro: the head starts fully behind the glass and the window clears.
    // Scrolling away pulls the glass back over it.
    u.uFull.value = Math.max(1 - e, smoothstep(0.15, 0.85, scroll));
    u.uAmount.value = SETTINGS.glass.amount;
    u.uCenter.value.set(0.5 + look.yaw * 0.08, 0.56 - look.pitch * 0.06);

    if (mixer) mixer.update(dt);
  }

  function render(dt) {
    update(dt);
    composer.render(dt);
  }

  function loop() {
    if (!visible || document.hidden) { running = false; return; }
    running = true;
    timer.update();
    render(Math.min(timer.getDelta(), 1 / 20));
    requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    timer.update();
    loop();
  }

  resize();
  start();
}

// ---------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------

// A tiny black studio with softboxes and strip lights, baked into an
// environment map so the head picks up crisp studio reflections.
function buildStudioEnvironment(renderer) {
  const env = new THREE.Scene();
  env.background = new THREE.Color('#020203');
  const plane = new THREE.PlaneGeometry(1, 1);
  const panel = (hex, intensity, position, scale) => {
    const mesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex).multiplyScalar(intensity), side: THREE.DoubleSide,
    }));
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.lookAt(0, 0, 0);
    env.add(mesh);
  };
  panel('#ffffff', 5.0, [-3.2, 2.4, 3.2], [3.0, 2.2, 1]); // key softbox, front-left
  panel('#ffffff', 1.2, [3.4, 0.4, 2.6], [1.6, 3.2, 1]);  // fill, front-right
  panel('#ffe1c2', 9.0, [-3.6, 0.6, -2.6], [0.35, 6, 1]); // warm rim strip, back-left
  panel('#cfe0ff', 8.0, [3.6, 0.6, -2.6], [0.35, 6, 1]);  // cool rim strip, back-right
  panel('#ffffff', 2.0, [0, 5, 0.5], [3, 3, 1]);          // top
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, 0.03).texture;
  pmrem.dispose();
  return texture;
}

function addLights(scene) {
  const key = new THREE.DirectionalLight('#fff4ea', 1.5);
  key.position.set(-3.2, 2.2, 1.8);
  scene.add(key);
  const rimWarm = new THREE.DirectionalLight('#ffd2a6', 4.6);
  rimWarm.position.set(-3, 1, -3);
  scene.add(rimWarm);
  const rimCool = new THREE.DirectionalLight('#bcd4ff', 4.0);
  rimCool.position.set(3, 1, -3);
  scene.add(rimCool);
  scene.add(new THREE.HemisphereLight('#20242c', '#050505', 0.25));
}

// Visible strip lights and a soft glow behind the head. They are what the
// fluted glass refracts, so the ribs read even on a dark page.
function addBackdrop(scene) {
  const group = new THREE.Group();
  group.position.z = -2.4;
  scene.add(group);

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color('#15120f') } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; varying vec2 vUv; void main(){ float d = distance(vUv, vec2(0.5, 0.55)); gl_FragColor = vec4(uColor, smoothstep(0.42, 0.0, d) * 0.7); }',
    })
  );
  group.add(glow);

  const strip = (hex, intensity, x) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.045, 7),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(intensity), toneMapped: true })
    );
    mesh.position.set(x, 0.3, -0.2);
    group.add(mesh);
  };
  strip('#ffdcb8', 2.6, -1.75);
  strip('#d2e2ff', 2.2, 1.75);
  return group;
}

// Only same-origin relative paths may override the model (for local testing).
function pickModelUrl(fallback) {
  const param = new URLSearchParams(window.location.search).get('model');
  if (param && /^[\w\-./]+\.glb$/.test(param) && !param.includes('..') && !param.startsWith('/')) return param;
  return fallback;
}

function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
