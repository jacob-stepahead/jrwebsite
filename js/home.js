// Homepage controller: loader, smooth scroll, scroll-driven 3D choreography,
// navigation state, reveals, cursor.
import Lenis from './vendor/lenis/lenis.mjs';

const root = document.documentElement;
const body = document.body;
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);
if (params.has('og')) root.classList.add('is-og'); // clean frame for social cards
const CAPTURE = params.has('capture'); // deterministic frame stepping for video export
if (CAPTURE) root.classList.add('is-capture');

// ---------------------------------------------------------------- scroll
let lenis = null;
if (!IS_TOUCH && !REDUCED && !CAPTURE) {
  lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 0.9, smoothWheel: true });
  const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
}
const scrollY = () => (lenis ? lenis.scroll : window.scrollY);

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const id = a.getAttribute('href').slice(1);
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  e.preventDefault();
  if (lenis) lenis.scrollTo(el, { duration: 1.6, offset: 0 });
  else el.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
  history.replaceState(null, '', id === 'home' ? location.pathname : `#${id}`);
});

// ------------------------------------------------------------ 3D stage
const stage = document.querySelector('.stage');
const canvas = document.getElementById('head-canvas');
const loaderBar = document.querySelector('.loader__bar');
let scene = null;

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

function finishLoading() {
  body.classList.remove('is-loading');
}

async function initScene() {
  if (!webglOK() || params.has('nowebgl')) throw new Error('WebGL unavailable');
  const { createHeadScene } = await import('./head/scene.js');
  scene = await createHeadScene(canvas, {
    modelUrl: 'assets/3d/head.glb',
    manual: CAPTURE,
    onProgress: (p) => loaderBar && loaderBar.style.setProperty('--progress', Math.max(0.05, p)),
  });
  window.__head = scene;
  applyScroll(true);
  loaderBar && loaderBar.style.setProperty('--progress', 1);
  if (CAPTURE) {
    finishLoading();
    window.__capture = {
      // One exact frame: scene time, page scroll, virtual cursor, startup levels.
      frame(t, y, mx, my, levels = {}) {
        window.scrollTo(0, y);
        applyScroll();
        scene.state.lock = { x: mx, y: my };
        if (paused) { scene.resume(); paused = false; }
        scene.renderAt(t, levels);
      },
    };
    window.__done = true;
    return;
  }
  // Let the bar finish, then fade the loader while the head "wakes up".
  setTimeout(() => {
    finishLoading();
    scene.play({ instant: params.has('instant') }).then(() => { window.__done = true; });
  }, 250);
}

initScene().catch((err) => {
  console.warn('[head] falling back to poster:', err);
  root.classList.add('no-webgl');
  finishLoading();
  window.__done = true;
});

// ---------------------------------------------------- scroll choreography
const sections = [...document.querySelectorAll('[data-scene]')];
const DEFAULTS = { x: 0, y: 0, turn: 0, glass: 0.3, glassHead: 0.15, side: -1, edge: 1.1, dim: 0 };
let keys = [];

function isNarrow() { return window.innerWidth < 769; }

function sceneFor(section) {
  const v = { ...DEFAULTS, ...JSON.parse(section.dataset.scene || '{}') };
  if (isNarrow()) {
    // On phones the head stays near the centre and text sits on top of it.
    v.x *= 0.25;
    if (section.id === 'about') v.dim = Math.max(v.dim, 0.62);
    if (section.id === 'statement') v.dim = Math.max(v.dim, 0.25);
    if (section.id === 'contact') v.dim = Math.max(v.dim, 0.45);
  }
  return v;
}

function measure() {
  const vh = window.innerHeight;
  keys = sections.map((s) => {
    const top = s.getBoundingClientRect().top + scrollY();
    return { at: Math.max(0, top - vh * 0.35), v: sceneFor(s), el: s };
  });
}

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

function stateAt(y) {
  const vh = window.innerHeight;
  let i = 0;
  while (i < keys.length - 1 && y >= keys[i + 1].at) i++;
  const a = keys[i].v;
  const next = keys[i + 1];
  if (!next) return { ...a };
  // Transition over the last ~70% of a viewport before the next key.
  const span = vh * 0.7;
  const t = smooth(Math.min(1, Math.max(0, (y - (next.at - span)) / span)));
  const b = next.v;
  const out = {};
  for (const k of Object.keys(a)) out[k] = lerp(a[k], b[k], t);
  if (a.side !== b.side) {
    // Glass changes sides: fade out, flip, fade back in.
    out.side = t < 0.5 ? a.side : b.side;
    out.edge = t < 0.5 ? a.edge : b.edge;
    out.glass = (t < 0.5 ? a.glass : b.glass) * Math.abs(1 - 2 * t);
  } else {
    out.side = a.side;
  }
  return out;
}

const navFor = { home: 'home', statement: 'about', about: 'about', build: 'work', work: 'work', contact: 'contact' };
const navLinks = [...document.querySelectorAll('[data-nav]')];
const dots = [...document.querySelectorAll('[data-dot]')];
const bar = document.querySelector('[data-bar]');
let currentNav = '';
let paused = false;

function applyScroll(force = false) {
  if (!keys.length) measure();
  const y = scrollY();
  const s = stateAt(y);
  stage.style.setProperty('--dim', s.dim.toFixed(3));
  if (scene) {
    scene.setTarget({ x: s.x, y: s.y, turn: s.turn, glass: s.glass, glassHead: s.glassHead, glassEdge: s.edge, glassSide: s.side });
    if (force) Object.assign(scene.state.cur, { x: s.x, y: s.y, turn: s.turn, glass: s.glass, glassHead: s.glassHead, glassEdge: s.edge });
    // Nothing to see behind a fully black overlay: stop rendering.
    const hide = s.dim > 0.985;
    if (hide && !paused) { scene.pause(); paused = true; }
    else if (!hide && paused) { scene.resume(); paused = false; }
  }
  // Active nav item: the section under the middle of the viewport.
  const mid = y + window.innerHeight * 0.5;
  let active = sections[0].id;
  for (const sec of sections) {
    const top = sec.getBoundingClientRect().top + y;
    if (mid >= top) active = sec.id;
  }
  const nav = navFor[active] || 'home';
  if (nav !== currentNav) {
    currentNav = nav;
    navLinks.forEach((l) => l.classList.toggle('is-active', l.dataset.nav === nav));
    dots.forEach((d) => d.classList.toggle('is-active', d.dataset.dot === nav));
  }
  bar.classList.toggle('is-solid', y > window.innerHeight * 0.55);
  updateBuild();
}

// Kinetic "I build" lines fill in as you scroll through the pinned section.
const build = document.querySelector('[data-build]');
const buildLines = build ? [...build.querySelectorAll('.build__line')] : [];
const buildSmall = build ? [...build.querySelectorAll('.build__small')] : [];
function updateBuild() {
  if (!build) return;
  const sec = build.parentElement;
  const r = sec.getBoundingClientRect();
  const total = r.height - window.innerHeight;
  const p = Math.min(1, Math.max(0, -r.top / Math.max(total, 1)));
  const n = buildLines.length;
  buildLines.forEach((line, i) => {
    const a = 0.08 + (i / n) * 0.72, b = a + 0.72 / n;
    line.style.setProperty('--fill', Math.min(1, Math.max(0, (p - a) / (b - a))).toFixed(3));
  });
  const o = (a, b) => Math.min(1, Math.max(0, (p - a) / (b - a))).toFixed(3);
  if (buildSmall[0]) buildSmall[0].style.setProperty('--o', o(0.0, 0.08));
  if (buildSmall[1]) buildSmall[1].style.setProperty('--o', o(0.82, 0.9));
  if (buildSmall[2]) buildSmall[2].style.setProperty('--o', o(0.9, 0.98));
}

if (lenis) lenis.on('scroll', () => applyScroll());
window.addEventListener('scroll', () => { if (!lenis) applyScroll(); }, { passive: true });
window.addEventListener('resize', () => { measure(); applyScroll(true); });
window.addEventListener('load', () => { measure(); applyScroll(true); });
document.fonts && document.fonts.ready.then(() => { measure(); applyScroll(); });
measure();
applyScroll(true);

// --------------------------------------------------------------- reveal
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }
}, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el));

// --------------------------------------------------------------- cursor
const cursor = document.querySelector('.cursor');
if (cursor && matchMedia('(hover: hover) and (pointer: fine)').matches) {
  let x = -100, y = -100, cx = -100, cy = -100;
  window.addEventListener('pointermove', (e) => { x = e.clientX; y = e.clientY; }, { passive: true });
  document.addEventListener('pointerover', (e) => {
    cursor.classList.toggle('is-link', !!e.target.closest('a, button, [role="button"], input, textarea'));
  });
  window.addEventListener('pointerdown', () => cursor.classList.add('is-down'));
  window.addEventListener('pointerup', () => cursor.classList.remove('is-down'));
  document.addEventListener('pointerleave', () => cursor.classList.add('is-hidden'));
  document.addEventListener('pointerenter', () => cursor.classList.remove('is-hidden'));
  const tick = () => {
    cx += (x - cx) * 0.3; cy += (y - cy) * 0.3;
    cursor.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
    requestAnimationFrame(tick);
  };
  tick();
}

// Card glow follows the pointer.
document.querySelectorAll('.card').forEach((card) => {
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
    card.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
  });
});

// Copy email.
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'Copied';
      btn.classList.add('is-copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('is-copied'); }, 1800);
    } catch { location.href = `mailto:${btn.dataset.copy}`; }
  });
});
