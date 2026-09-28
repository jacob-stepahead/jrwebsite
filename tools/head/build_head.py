"""Build the faceted head model: SDF -> mesh -> planes -> GLB.

    python3 tools/head/build_head.py [--out assets/3d/head.glb] [--fast]

Pipeline
  1. Polygonise each SDF (head, eyes, sweater) with marching cubes, evaluating
     the exact field only in a narrow band around the surface.
  2. Decimate, then cluster faces into planar regions (Variational Shape
     Approximation, L2,1 metric) so the surface reads as sculpted planes.
  3. Snap every vertex onto the planes of the regions it touches, decimate
     again (coplanar regions collapse almost for free), relabel.
  4. Bake ambient occlusion from the SDF, write a compact GLB.
"""
import argparse
import heapq
import json
import os
import struct
import sys
import time

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from skimage import measure
import fast_simplification

sys.path.insert(0, os.path.dirname(__file__))
import anatomy  # noqa: E402
import remesh  # noqa: E402
import hair as hair_mod  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


# ------------------------------------------------------------- polygonise
def eval_chunked(fn, pts, chunk=400_000):
    out = np.empty(len(pts), dtype=np.float64)
    for i in range(0, len(pts), chunk):
        out[i:i + chunk] = fn(pts[i:i + chunk])
    return out


def polygonise(fn, lo, hi, step, coarse=4):
    lo = np.asarray(lo, float)
    hi = np.asarray(hi, float)
    n = np.ceil((hi - lo) / step).astype(int) + 1
    # Coarse pass.
    cstep = step * coarse
    cn = np.ceil((hi - lo) / cstep).astype(int) + 2
    axes = [lo[i] + np.arange(cn[i]) * cstep for i in range(3)]
    cg = np.stack(np.meshgrid(*axes, indexing="ij"), -1).reshape(-1, 3)
    cv = eval_chunked(fn, cg).reshape(cn)
    # Upsample to the fine grid (trilinear) as the default everywhere.
    coords = [np.arange(n[i]) / coarse for i in range(3)]
    mg = np.meshgrid(*coords, indexing="ij")
    vol = ndimage.map_coordinates(cv, mg, order=1, mode="nearest")
    # Exact values in the narrow band.
    band = np.abs(vol) < cstep * 1.8
    idx = np.nonzero(band)
    pts = np.stack([lo[i] + idx[i] * step for i in range(3)], -1)
    vol[idx] = eval_chunked(fn, pts)
    verts, faces, _, _ = measure.marching_cubes(vol, 0.0, spacing=(step, step, step))
    verts = verts + lo
    faces = faces[:, ::-1].copy()  # outward for "negative inside" fields
    return verts, faces


def largest_component(v, f):
    import trimesh
    m = trimesh.Trimesh(v, f, process=True)
    parts = m.split(only_watertight=False)
    if len(parts) > 1:
        m = max(parts, key=lambda p: len(p.faces))
    if m.volume < 0:
        m.invert()
    return np.asarray(m.vertices), np.asarray(m.faces)


def decimate(v, f, target_faces):
    if len(f) <= target_faces:
        return v, f
    red = 1.0 - target_faces / len(f)
    v2, f2 = fast_simplification.simplify(v.astype(np.float32), f.astype(np.int32), target_reduction=red)
    return v2.astype(np.float64), f2.astype(np.int64)


def taubin(v, f, iters=6, lam=0.5, mu=-0.53):
    import trimesh
    m = trimesh.Trimesh(v, f, process=False)
    trimesh.smoothing.filter_taubin(m, lamb=lam, nu=mu, iterations=iters)
    return np.asarray(m.vertices), f


# -------------------------------------------------------------------- VSA
def face_data(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    cr = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(cr, axis=1)
    n = cr / np.maximum(2 * area[:, None], 1e-12)
    cen = (a + b + c) / 3
    return n, area, cen


def face_adjacency(f):
    edges = {}
    adj = [[] for _ in range(len(f))]
    for fi, (a, b, c) in enumerate(f):
        for e in ((a, b), (b, c), (c, a)):
            key = (min(e), max(e))
            if key in edges:
                o = edges[key]
                adj[fi].append(o)
                adj[o].append(fi)
            else:
                edges[key] = fi
    return adj


def vsa(v, f, k, iters=18, compact=0.006, seed=7, weight=None):
    """Variational Shape Approximation with an L2,1 metric plus a small
    compactness term. `weight` (per face) scales the error so detailed areas
    get more, smaller planes."""
    n, area, cen = face_data(v, f)
    if weight is None:
        weight = np.ones(len(f))
    adj = face_adjacency(f)
    scale = np.ptp(v, axis=0).max()
    rng = np.random.default_rng(seed)
    # Farthest-point seeds, weighted toward detailed areas.
    seeds = [int(np.argmax(weight))]
    dist = np.linalg.norm(cen - cen[seeds[0]], axis=1) * weight
    for _ in range(k - 1):
        s = int(np.argmax(dist))
        seeds.append(s)
        dist = np.minimum(dist, np.linalg.norm(cen - cen[s], axis=1) * weight)
    labels = np.full(len(f), -1)
    proxies_n = n[seeds].copy()
    proxies_c = cen[seeds].copy()
    for it in range(iters):
        # Region growing from seeds.
        labels[:] = -1
        heap = []
        for i, s in enumerate(seeds):
            labels[s] = i
            for nb in adj[s]:
                e = err(nb, i, n, area, cen, proxies_n, proxies_c, compact, scale, weight)
                heapq.heappush(heap, (e, nb, i))
        while heap:
            e, fi, i = heapq.heappop(heap)
            if labels[fi] != -1:
                continue
            labels[fi] = i
            for nb in adj[fi]:
                if labels[nb] == -1:
                    heapq.heappush(heap, (err(nb, i, n, area, cen, proxies_n, proxies_c, compact, scale, weight), nb, i))
        # Orphans (disconnected bits) take their nearest labelled neighbour.
        for fi in np.nonzero(labels == -1)[0]:
            labels[fi] = 0
        # Refit proxies.
        wn = n * area[:, None]
        sums = np.zeros((k, 3))
        np.add.at(sums, labels, wn)
        proxies_n = sums / np.maximum(np.linalg.norm(sums, axis=1, keepdims=True), 1e-12)
        csum = np.zeros((k, 3))
        np.add.at(csum, labels, cen * area[:, None])
        asum = np.zeros(k)
        np.add.at(asum, labels, area)
        proxies_c = csum / np.maximum(asum[:, None], 1e-12)
        # New seeds: best-fitting face per region.
        fe = area * np.sum((n - proxies_n[labels]) ** 2, axis=1)
        order = np.lexsort((fe, labels))
        first = np.ones(len(order), bool)
        first[1:] = labels[order][1:] != labels[order][:-1]
        new_seeds = {labels[o]: int(o) for o in order[first]}
        seeds = [new_seeds.get(i, seeds[i]) for i in range(k)]
    return labels, proxies_n, proxies_c


def err(fi, i, n, area, cen, pn, pc, compact, scale, weight):
    dn = n[fi] - pn[i]
    dc = (cen[fi] - pc[i]) / scale
    return float(area[fi] * weight[fi] * (dn @ dn + compact * (dc @ dc) * 40.0))


def region_planes(v, f, labels, k):
    n, area, cen = face_data(v, f)
    sums = np.zeros((k, 3))
    np.add.at(sums, labels, n * area[:, None])
    pn = sums / np.maximum(np.linalg.norm(sums, axis=1, keepdims=True), 1e-12)
    csum = np.zeros((k, 3))
    np.add.at(csum, labels, cen * area[:, None])
    asum = np.zeros(k)
    np.add.at(asum, labels, area)
    pc = csum / np.maximum(asum[:, None], 1e-12)
    pd = np.sum(pn * pc, axis=1)
    return pn, pd


def flatten(v, f, labels, pn, pd, lam=0.02, strength=1.0, iters=4, max_move=0.45):
    """Move vertices onto the planes of their incident regions (least squares
    with a pull back toward the original position)."""
    pairs = np.unique(np.stack([f.ravel(), np.repeat(labels, 3)], 1), axis=0)
    vi, li = pairs[:, 0], pairs[:, 1]
    nn = pn[li]
    for _ in range(iters):
        M = np.zeros((len(v), 3, 3))
        b = np.zeros((len(v), 3))
        np.add.at(M, vi, nn[:, :, None] * nn[:, None, :])
        np.add.at(b, vi, nn * pd[li][:, None])
        M += lam * np.eye(3)[None]
        b += lam * v
        x = np.linalg.solve(M, b[..., None])[..., 0]
        dv = (x - v) * strength
        mag = np.linalg.norm(dv, axis=1, keepdims=True)
        dv *= np.minimum(1.0, max_move / np.maximum(mag, 1e-9))
        v = v + dv
    return v


def relabel(v_new, f_new, v_old, f_old, labels_old):
    _, _, cen_old = face_data(v_old, f_old)
    n_new, _, cen_new = face_data(v_new, f_new)
    tree = cKDTree(cen_old)
    _, nn = tree.query(cen_new, k=4)
    # Majority vote among near faces.
    lab = labels_old[nn]
    out = np.array([np.bincount(r).argmax() for r in lab])
    return out


# --------------------------------------------------------------------- AO
def sdf_normals(fn, p, h=0.02):
    ex = np.array([h, 0, 0]); ey = np.array([0, h, 0]); ez = np.array([0, 0, h])
    g = np.stack([fn(p + ex) - fn(p - ex), fn(p + ey) - fn(p - ey), fn(p + ez) - fn(p - ez)], -1)
    return g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)


def sdf_ao(fn, p, nrm, steps=6, dist=0.55, falloff=0.72):
    occ = np.zeros(len(p))
    w = 1.0
    for i in range(1, steps + 1):
        h = dist * i
        d = fn(p + nrm * h)
        occ += w * np.clip(h - d, 0, None) / h
        w *= falloff
    return np.clip(1.0 - 0.75 * occ, 0.0, 1.0)


# -------------------------------------------------------------------- GLB
def split_by_label(v, f, labels, pn, extra=None):
    """Duplicate vertices per region so each region gets its own flat normal."""
    key = f * (labels.max() + 1) + labels[:, None]
    uniq, inv = np.unique(key.ravel(), return_inverse=True)
    vid = uniq // (labels.max() + 1)
    lid = uniq % (labels.max() + 1)
    out_v = v[vid]
    out_n = pn[lid]
    out_f = inv.reshape(-1, 3)
    out_extra = {k: a[vid] for k, a in (extra or {}).items()}
    out_extra["region"] = lid
    return out_v, out_n, out_f, out_extra


class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.views = []
        self.accessors = []
        self.meshes = []
        self.nodes = []
        self.materials = []

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        self.views.append(v)
        return len(self.views) - 1

    def accessor(self, arr, ctype, typ, normalized=False, target=34962, minmax=False):
        arr = np.ascontiguousarray(arr)
        view = self._view(arr.tobytes(), target)
        acc = {"bufferView": view, "componentType": ctype, "count": int(arr.shape[0]), "type": typ}
        if normalized:
            acc["normalized"] = True
        if minmax:
            acc["min"] = arr.min(axis=0).tolist()
            acc["max"] = arr.max(axis=0).tolist()
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def material(self, name, **kw):
        m = {"name": name, "pbrMetallicRoughness": {
            "baseColorFactor": kw.get("color", [1, 1, 1, 1]),
            "metallicFactor": kw.get("metal", 0.0),
            "roughnessFactor": kw.get("rough", 1.0)}}
        if "emissive" in kw:
            m["emissiveFactor"] = kw["emissive"]
        self.materials.append(m)
        return len(self.materials) - 1

    def mesh(self, name, v, n, f, material, attrs=None):
        prim = {"attributes": {
            "POSITION": self.accessor(v.astype(np.float32), 5126, "VEC3", minmax=True),
            "NORMAL": self.accessor(n.astype(np.float32), 5126, "VEC3")},
            "material": material}
        for key, (arr, ctype, typ, norm) in (attrs or {}).items():
            prim["attributes"][key] = self.accessor(arr, ctype, typ, normalized=norm)
        idx = f.astype(np.uint16 if v.shape[0] < 65536 else np.uint32).ravel()
        prim["indices"] = self.accessor(idx[:, None] if False else idx, 5123 if idx.dtype == np.uint16 else 5125,
                                        "SCALAR", target=34963)
        self.meshes.append({"name": name, "primitives": [prim]})
        self.nodes.append({"name": name, "mesh": len(self.meshes) - 1})

    def write(self, path, extras=None):
        gl = {"asset": {"version": "2.0", "generator": "jrwebsite tools/head/build_head.py"},
              "scene": 0, "scenes": [{"nodes": list(range(len(self.nodes)))}],
              "nodes": self.nodes, "meshes": self.meshes, "materials": self.materials,
              "accessors": self.accessors, "bufferViews": self.views,
              "buffers": [{"byteLength": len(self.bin)}]}
        if extras:
            gl["extras"] = extras
        js = json.dumps(gl, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        binb = bytes(self.bin) + b"\0" * ((4 - len(self.bin) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(binb)
        with open(path, "wb") as fh:
            fh.write(struct.pack("<III", 0x46546C67, 2, total))
            fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
            fh.write(struct.pack("<II", len(binb), 0x004E4942) + binb)


# ------------------------------------------------------------------- main
def build_part(name, fn, lo, hi, step, dec1, k, dec2=None, weight_fn=None, compact=0.006, tol=0.16, log=print):
    t0 = time.time()
    v, f = polygonise(fn, lo, hi, step)
    v, f = largest_component(v, f)
    log(f"[{name}] marching cubes: {len(f)} faces ({time.time() - t0:.1f}s)")
    v, f = decimate(v, f, dec1)
    v, f = taubin(v, f, iters=24)
    log(f"[{name}] decimated to {len(f)}")
    _, _, cen = face_data(v, f)
    w = weight_fn(cen) if weight_fn else None
    labels, _, _ = vsa(v, f, k, compact=compact, weight=w)
    pn, pd = region_planes(v, f, labels, k)
    log(f"[{name}] VSA {k} regions ({time.time() - t0:.1f}s)")
    vf = flatten(v, f, labels, pn, pd)
    v2, f2, lab2, ndense = remesh.polyhedral(v, f, labels, pn, tol=tol, v_dp=vf)
    pn2, _ = region_planes(v2, f2, lab2, lab2.max() + 1)
    log(f"[{name}] polyhedral: {lab2.max() + 1} planes, {len(f2)} faces, {ndense} dense ({time.time() - t0:.1f}s)")
    return v2, f2, lab2, pn2


def face_detail_weight(c):
    """More, smaller planes on the face than on the back of the head."""
    ax = np.abs(c[:, 0])
    front = np.clip((c[:, 2] - 2.0) / 6.0, 0, 1)
    eyes = np.exp(-((ax - 3.1) ** 2 + (c[:, 1] - 0.5) ** 2) / 6.0)
    mouth = np.exp(-(c[:, 0] ** 2 / 8 + (c[:, 1] + 6.3) ** 2 / 3))
    return 1.0 + 1.6 * front + 1.2 * eyes + 0.8 * mouth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "assets", "3d", "head.glb"))
    ap.add_argument("--fast", action="store_true", help="coarser grid for quick iteration")
    ap.add_argument("--no-hair", action="store_true")
    args = ap.parse_args()
    q = 1.6 if args.fast else 1.0

    glb = GLB()
    m_face = glb.material("Face", color=[0.56, 0.60, 0.95, 1], metal=0.95, rough=0.4)
    m_eye = glb.material("Eye", color=[1, 1, 1, 1], emissive=[1, 1, 1])
    m_sweater = glb.material("Sweater", color=[0.05, 0.05, 0.06, 1], metal=0.0, rough=0.95)
    m_hair = glb.material("Hair", color=[0.55, 0.55, 0.62, 1], metal=1.0, rough=0.55)

    hair = None
    hair_sdf = None
    if not args.no_hair:
        t0 = time.time()
        hair = hair_mod.grow(anatomy.head_sdf)
        hair_sdf = hair_mod.locks_sdf(hair)
        print(f"[hair] grew {len(hair['locks'])} locks ({time.time() - t0:.1f}s)")

    def occluders(p):
        d = np.minimum(anatomy.head_sdf(p), anatomy.sweater_sdf(p))
        d = np.minimum(d, anatomy.eyeball_sdf(p))
        if hair_sdf is not None:
            d = np.minimum(d, hair_sdf(p))
        return d

    # Head.
    v, f, lab, pn = build_part("head", anatomy.head_sdf, (-9.2, -18.0, -11.5), (9.2, 13.2, 12.6),
                               0.13 * q, 90000, 340, weight_fn=face_detail_weight)
    nrm = sdf_normals(anatomy.head_sdf, v)
    ao = sdf_ao(occluders, v + nrm * 0.03, nrm)
    hv, hn, hf, hx = split_by_label(v, f, lab, pn, {"ao": ao})
    rnd = np.random.default_rng(3).random(lab.max() + 1)
    col = np.stack([hx["ao"], rnd[hx["region"]], np.zeros_like(hx["ao"]), np.ones_like(hx["ao"])], -1)
    glb.mesh("Face", hv, hn, hf, m_face, {"COLOR_0": ((col * 255).round().astype(np.uint8), 5121, "VEC4", True)})

    # Eyes: smooth spheres (they glow, so facets would be lost anyway).
    import trimesh
    for side, sx in (("R", 1), ("L", -1)):
        s = trimesh.creation.icosphere(subdivisions=3, radius=anatomy.EYE_R)
        c = anatomy.EYE_C * np.array([sx, 1, 1])
        glb.mesh(f"Eye_{side}", np.asarray(s.vertices) + c, np.asarray(s.vertex_normals), np.asarray(s.faces), m_eye)

    # Sweater.
    v, f, lab, pn = build_part("sweater", anatomy.sweater_sdf, (-24, -34.5, -12), (24, -7.5, 10.5),
                               0.22 * q, 40000, 150, 6000, compact=0.05)
    nrm = sdf_normals(anatomy.sweater_sdf, v)
    ao = sdf_ao(occluders, v + nrm * 0.05, nrm, dist=0.8)
    sv, sn, sf, sx_ = split_by_label(v, f, lab, pn, {"ao": ao})
    col = np.stack([sx_["ao"], np.zeros_like(sx_["ao"]), np.zeros_like(sx_["ao"]), np.ones_like(sx_["ao"])], -1)
    glb.mesh("Sweater", sv, sn, sf, m_sweater, {"COLOR_0": ((col * 255).round().astype(np.uint8), 5121, "VEC4", True)})

    # Hair: planar volume + flowing locks.
    if hair is not None:
        cap = hair["cap"]
        v, f, lab, pn = build_part("hair-cap", cap, (-10.5, -8.5, -13.5), (10.5, 15.5, 11.5),
                                   0.15 * q, 50000, 120, 7000)
        nrm = sdf_normals(cap, v)
        ao = sdf_ao(occluders, v + nrm * 0.05, nrm, dist=0.45)
        cv, cn, cf, cx = split_by_label(v, f, lab, pn, {"ao": ao})
        rnd = np.random.default_rng(5).random(lab.max() + 1)
        col = np.stack([cx["ao"], rnd[cx["region"]], np.zeros_like(cx["ao"]), np.ones_like(cx["ao"])], -1)
        glb.mesh("HairCap", cv, cn, cf, m_hair, {"COLOR_0": ((col * 255).round().astype(np.uint8), 5121, "VEC4", True)})
        lv, ln, lf, attrs = hair_mod.ribbons(hair, occluders)
        glb.mesh("Hair", lv, ln, lf, m_hair, attrs)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    glb.write(args.out, extras={"units": "cm", "neckPivot": [0, -6.0, -1.8],
                                "eyes": [anatomy.EYE_C.tolist(), (anatomy.EYE_C * [-1, 1, 1]).tolist()]})
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
