"""Procedural hair: a sculpted volume ("cap") that covers the scalp, plus
ribbon locks that flow over it and lift off into the wind toward their tips.

Per-vertex data for the runtime wind shader is packed into COLOR_0 of the
locks mesh:
  R = ambient occlusion, G = position along the lock (0 root .. 1 tip),
  B = per-lock random seed, A = 1.
"""
import numpy as np
from scipy.spatial import cKDTree

from sdf import smax, smin, ellipsoid, mirror_x

CENTER = np.array([0.0, 3.4, -1.4])   # rough centre of the cranium

# Hairline: minimum elevation (deg) around CENTER as a function of azimuth
# (0 = straight ahead, 180 = straight back). A slightly squared-off front
# hairline with gentle temple recession, down to the nape at the back.
HL_AZ = np.array([0, 20, 38, 52, 66, 84, 104, 116, 128, 145, 165, 180])
HL_EL = np.array([27, 27, 25, 19, 9, 6, 5, -12, -34, -50, -58, -60])


def _sph(p):
    d = p - CENTER
    r = np.linalg.norm(d, axis=-1, keepdims=True)
    dn = d / np.maximum(r, 1e-9)
    el = np.degrees(np.arcsin(np.clip(dn[..., 1], -1, 1)))
    az = np.degrees(np.arctan2(np.abs(dn[..., 0]), dn[..., 2]))
    return dn, el, az


def hairline_field(p):
    """Positive inside the hair region (approx. cm along the scalp)."""
    _, el, az = _sph(p)
    return (el - np.interp(az, HL_AZ, HL_EL)) * np.pi / 180 * 8.5


def thickness(p):
    dn, _, _ = _sph(p)
    up = np.clip(dn[..., 1], 0, 1)
    front = np.clip(dn[..., 2], 0, 1)
    back = np.clip(-dn[..., 2], 0, 1)
    base = 0.5 + 1.25 * up + 0.8 * front * up + 0.45 * back
    # Thin out toward the hairline so the edge doesn't read as a helmet rim.
    edge = np.clip(hairline_field(p) / 2.2, 0.0, 1.0)
    return base * (0.25 + 0.75 * edge * edge * (3 - 2 * edge))


def make_cap_sdf(head_sdf):
    def cap(p):
        d = head_sdf(p) - thickness(p)
        # A little extra lift at the front of the crown (brushed-up fringe).
        m = mirror_x(p)
        d = smin(d, ellipsoid(m, (1.6, 9.6, 3.6), (4.2, 2.2, 3.6)), 1.4)
        d = smax(d, -hairline_field(p), 0.4)
        # Never let the hair volume grow into the face or below the nape.
        d = smax(d, -(p[..., 1] + 8.5), 0.5)
        return d
    return cap


# ------------------------------------------------------------------ locks
def _grad(fn, p, h=0.03):
    e = np.eye(3) * h
    g = np.stack([fn(p + e[i]) - fn(p - e[i]) for i in range(3)], -1)
    return g / np.maximum(np.linalg.norm(g, axis=-1, keepdims=True), 1e-9)


def _surface_points(fn, dirs, iters=80):
    p = CENTER + dirs * 2.0
    for _ in range(iters):
        p = p - dirs * fn(p)[:, None] * 0.8
    return p


def grow(head_sdf, n_locks=170, seed=11):
    cap = make_cap_sdf(head_sdf)
    rng = np.random.default_rng(seed)
    n = 8000
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    th = np.pi * (1 + 5 ** 0.5) * i
    dirs = np.stack([np.sin(phi) * np.sin(th), np.cos(phi), np.sin(phi) * np.cos(th)], -1)
    surf = _surface_points(cap, dirs)
    ok = (hairline_field(surf) > 0.12) & (np.abs(cap(surf)) < 0.05)
    cand = surf[ok]
    # Farthest point sampling, biased so the top and front get more locks.
    dn, _, _ = _sph(cand)
    edge = np.exp(-hairline_field(cand) / 1.2) * np.clip(dn[:, 2] + 0.3, 0, 1)
    bias = 1.0 + 0.6 * np.clip(dn[:, 1], 0, 1) + 0.4 * np.clip(dn[:, 2], 0, 1) + 0.8 * edge
    roots = [cand[np.argmax(cand[:, 2] + cand[:, 1])]]
    dist = np.linalg.norm(cand - roots[0], axis=1) * bias
    for _ in range(n_locks - 1):
        k = int(np.argmax(dist))
        roots.append(cand[k])
        dist = np.minimum(dist, np.linalg.norm(cand - cand[k], axis=1) * bias)
    locks = [_grow_one(cap, r, rng) for r in roots]
    return {"cap": cap, "locks": locks}


def _grow_one(cap, root, rng):
    dn, el, az = _sph(root[None])
    dn = dn[0]
    up = np.clip(dn[1], -1, 1)
    side = np.sign(root[0]) if abs(root[0]) > 0.3 else rng.choice([-1, 1])
    top = np.clip(up, 0, 1)
    front = np.clip(dn[2], 0, 1)
    # Swept back: long over the top, shorter at the sides and nape.
    back = np.clip(-dn[2], 0, 1) * (1 - top)
    length = (5.0 + 5.5 * top + 2.5 * front * top + 3.0 * back) * rng.uniform(0.85, 1.15)
    segs = 20
    step = length / segs
    # Flow direction: up-and-back off the forehead, back over the crown,
    # back-and-down at the sides; the wind flicks the ends outward.
    flow = np.array([0.25 * side * (1 - top), 0.35 * front * top - 0.45 * (1 - top), -1.0])
    wind = np.array([0.7 * side, 0.08 + 0.18 * top, -0.8])
    n0 = _grad(cap, root[None])[0]
    d = flow - n0 * (flow @ n0)
    d /= np.linalg.norm(d)
    pts, nrm = [root - n0 * 0.15], [n0]
    p = pts[0].copy()
    phase = rng.uniform(0, 6.28)
    curl = rng.uniform(0.08, 0.22)
    for s in range(1, segs + 1):
        t = s / segs
        g = _grad(cap, p[None])[0]
        target = flow * (1 - t ** 2) + wind * t ** 2
        target = target + np.cross(g, d) * np.sin(t * 4.0 + phase) * curl
        # Hug the hair volume near the root, free toward the tip.
        hug = (1 - t) ** 1.5
        tangential = target - g * (target @ g) * hug
        d = d * 0.65 + tangential / np.linalg.norm(tangential) * 0.35
        d /= np.linalg.norm(d)
        p = p + d * step
        clearance = 0.05 + 0.5 * t ** 2.5
        dist = cap(p[None])[0]
        if dist < clearance:
            p = p + g * (clearance - dist)
        pts.append(p.copy())
        nrm.append(g)
    width = rng.uniform(1.35, 2.3) * (0.8 + 0.3 * top) * (1 - 0.35 * back)
    return {"pts": np.array(pts), "nrm": np.array(nrm), "width": width, "seed": rng.random()}


def locks_sdf(hair):
    """Approximate SDF of cap + locks, for ambient occlusion."""
    samples, radii = [], []
    for s in hair["locks"]:
        pts = s["pts"]
        ts = np.linspace(0, 1, len(pts))
        for a, b, t in zip(pts[:-1], pts[1:], ts[:-1]):
            for u in (0.0, 0.33, 0.66):
                samples.append(a + (b - a) * u)
                radii.append(0.3 * s["width"] * (1 - t) + 0.05)
    tree = cKDTree(np.array(samples))
    radii = np.array(radii)
    cap = hair["cap"]

    def fn(p):
        dd, ii = tree.query(p, k=6)
        return np.minimum(np.min(dd - radii[ii], axis=-1), cap(p))
    return fn


def ribbons(hair, occluders, sides=6):
    V, N, F, C = [], [], [], []
    base = 0
    for s in hair["locks"]:
        pts, nrm = s["pts"], s["nrm"]
        m = len(pts)
        tang = np.gradient(pts, axis=0)
        tang /= np.linalg.norm(tang, axis=1, keepdims=True)
        up = nrm - tang * np.sum(nrm * tang, axis=1, keepdims=True)
        up /= np.maximum(np.linalg.norm(up, axis=1, keepdims=True), 1e-9)
        wdir = np.cross(tang, up)
        t = np.linspace(0, 1, m)
        # Wide just after the root, tapering to a point.
        w = s["width"] * np.minimum(1.0, 0.55 + t * 3.0) * (1 - t ** 2.6) + 0.07
        th = w * 0.16 + 0.03
        ang = np.linspace(0, 2 * np.pi, sides, endpoint=False)
        for j in range(m):
            for a in ang:
                ca, sa = np.cos(a), np.sin(a)
                V.append(pts[j] + wdir[j] * ca * w[j] * 0.5 + up[j] * sa * th[j] * 0.5)
                nn = wdir[j] * ca / (w[j] * 0.5) + up[j] * sa / (th[j] * 0.5)
                N.append(nn / np.linalg.norm(nn))
                C.append((t[j], s["seed"]))
        for j in range(m - 1):
            for k in range(sides):
                a0 = base + j * sides + k
                a1 = base + j * sides + (k + 1) % sides
                F.append((a0, a0 + sides, a1))
                F.append((a1, a0 + sides, a1 + sides))
        base += m * sides
    V, N, F, C = np.array(V), np.array(N), np.array(F), np.array(C)
    ao = np.clip(occluders(V + N * 0.3) / 0.7, 0.2, 1.0)
    col = np.stack([ao, C[:, 0], C[:, 1], np.ones(len(V))], -1)
    return V, N, F, {"COLOR_0": ((col * 255).round().astype(np.uint8), 5121, "VEC4", True)}
