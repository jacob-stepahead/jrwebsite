"""Turn a VSA partition into a clean polyhedral mesh.

Each planar region becomes one polygon whose corners are "anchor" vertices:
vertices where three or more regions meet, plus the few extra points a
Douglas-Peucker pass needs to keep region borders faithful. Borders between
anchors become straight edges, so facets read as crisp sculpted planes.
Regions with holes keep their dense triangulation (and all of their border
vertices become anchors, so neighbours stay crack-free).
"""
from collections import defaultdict

import numpy as np
import mapbox_earcut as earcut


def _merge_islands(f, labels):
    """Regions completely surrounded by a single other region are merged into
    it (they would otherwise punch a hole in that region)."""
    labels = labels.copy()
    for _ in range(4):
        edge_face = {}
        nb = defaultdict(set)
        for fi, (a, b, c) in enumerate(f):
            for e in ((a, b), (b, c), (c, a)):
                key = (min(e), max(e))
                if key in edge_face:
                    o = edge_face[key]
                    if labels[o] != labels[fi]:
                        nb[labels[fi]].add(labels[o])
                        nb[labels[o]].add(labels[fi])
                else:
                    edge_face[key] = fi
        changed = False
        for r, ns in nb.items():
            if len(ns) == 1:
                labels[labels == r] = next(iter(ns))
                changed = True
        if not changed:
            break
    # Compact label ids.
    _, labels = np.unique(labels, return_inverse=True)
    return labels


def _loops(f, labels, region_faces):
    """Ordered boundary loops (vertex lists + neighbour label per edge) of one region."""
    out_edges = {}
    for fi in region_faces:
        a, b, c = f[fi]
        for e in ((a, b), (b, c), (c, a)):
            out_edges[e] = fi
    nxt = {}
    for (a, b) in out_edges:
        if (b, a) not in out_edges:  # border half-edge
            if a in nxt:
                return None  # pinched region: two border edges leave one vertex
            nxt[a] = b
    loops = []
    seen = set()
    for start in nxt:
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        cur = nxt[start]
        guard = 0
        while cur != start:
            if cur in seen or cur not in nxt:
                return None
            loop.append(cur)
            seen.add(cur)
            cur = nxt[cur]
            guard += 1
            if guard > 100000:
                return None
        loops.append(loop)
    return loops


def _dp(points, idx, tol, keep):
    """Douglas-Peucker on a polyline; adds kept vertex ids to `keep`."""
    if len(idx) < 3:
        return
    a, b = points[idx[0]], points[idx[-1]]
    ab = b - a
    L = np.linalg.norm(ab)
    pts = points[idx[1:-1]]
    if L < 1e-9:
        d = np.linalg.norm(pts - a, axis=1)
    else:
        d = np.linalg.norm(np.cross(pts - a, ab / L), axis=1)
    i = int(np.argmax(d))
    if d[i] > tol:
        mid = i + 1
        keep.add(idx[mid])
        _dp(points, idx[:mid + 1], tol, keep)
        _dp(points, idx[mid:], tol, keep)


def _triangulate(v, poly, nrm):
    """Ear-clip a (roughly planar) 3D polygon; None if it can't be done cleanly."""
    P = v[poly]
    bases = []
    t1 = np.cross(nrm, [0, 1, 0] if abs(nrm[1]) < 0.9 else [1, 0, 0])
    t1 /= np.linalg.norm(t1)
    bases.append((t1, np.cross(nrm, t1), nrm))
    # Best-fit plane of the polygon itself.
    c = P - P.mean(axis=0)
    _, _, vt = np.linalg.svd(c, full_matrices=False)
    n2 = vt[2] if vt[2] @ nrm > 0 else -vt[2]
    bases.append((vt[0], np.cross(n2, vt[0]), n2))
    for t1, t2, n in bases:
        uv = np.stack([P @ t1, P @ t2], -1).astype(np.float64)
        tri = earcut.triangulate_float64(uv, np.array([len(poly)], dtype=np.uint32)).reshape(-1, 3)
        if len(tri) != len(poly) - 2:
            continue
        out = []
        ok = True
        for t in tri:
            a, b, cc = poly[t[0]], poly[t[1]], poly[t[2]]
            cr = np.cross(v[b] - v[a], v[cc] - v[a])
            if np.dot(cr, n) < 0:
                b, cc = cc, b
            out.append((a, b, cc))
        # Reject if the 2D polygon self-intersects (earcut output then covers
        # more or less area than the polygon itself).
        area_poly = abs(_shoelace(uv))
        area_tri = sum(abs(_tri_area(uv[t[0]], uv[t[1]], uv[t[2]])) for t in tri)
        if ok and abs(area_tri - area_poly) <= 1e-3 * max(area_poly, 1e-6) + 1e-6:
            return out
    return None


def _shoelace(uv):
    x, y = uv[:, 0], uv[:, 1]
    return 0.5 * (np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _tri_area(a, b, c):
    return 0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]))


def polyhedral(v, f, labels, pn, tol=0.18, max_seg=None, v_dp=None):
    """Returns (vertices, faces, face_labels, n_fallbacks).

    `v` are the surface positions (used for output and triangulation);
    `v_dp` optional plane-snapped positions, on which region borders are
    straight, used to decide which border vertices to keep."""
    if v_dp is None:
        v_dp = v
    labels = _merge_islands(f, labels)
    k = labels.max() + 1
    # Region normals must be recomputed: merging renumbers the labels.
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    fn = np.cross(b - a, c - a)
    pn = np.zeros((k, 3))
    np.add.at(pn, labels, fn)
    pn /= np.maximum(np.linalg.norm(pn, axis=1, keepdims=True), 1e-12)
    vert_labels = defaultdict(set)
    for fi, tri in enumerate(f):
        for x in tri:
            vert_labels[x].add(labels[fi])
    anchors = {x for x, s in vert_labels.items() if len(s) >= 3}

    faces_of = defaultdict(list)
    for fi, l in enumerate(labels):
        faces_of[l].append(fi)

    loops_of = {}
    dense = set()
    for r in range(k):
        lp = _loops(f, labels, faces_of[r])
        if lp is None or len(lp) != 1:
            dense.add(r)
            for loop in (lp or []):
                anchors.update(loop)
            if lp is None:
                for fi in faces_of[r]:
                    anchors.update(f[fi].tolist())
        else:
            loops_of[r] = lp[0]

    # Split each loop into chains between anchors and simplify each chain once.
    done_chains = set()
    for r, loop in loops_of.items():
        n = len(loop)
        ai = [i for i, x in enumerate(loop) if x in anchors]
        if not ai:
            # No anchors (should be rare after island merge): seed three.
            ai = [0, n // 3, 2 * n // 3]
            anchors.update(loop[i] for i in ai)
        for j in range(len(ai)):
            s, e = ai[j], ai[(j + 1) % len(ai)]
            chain = loop[s:e + 1] if e > s else loop[s:] + loop[:e + 1]
            key = frozenset(chain)
            if key in done_chains:
                continue
            done_chains.add(key)
            _dp(v_dp, chain, tol, anchors)
            if max_seg:
                seg = np.linalg.norm(v[chain[0]] - v[chain[-1]])
                if seg > max_seg and len(chain) > 2:
                    anchors.add(chain[len(chain) // 2])

    # Make sure each polygon has at least 3 corners.
    for r, loop in loops_of.items():
        cnt = sum(1 for x in loop if x in anchors)
        if cnt < 3:
            n = len(loop)
            anchors.update(loop[i] for i in (0, n // 3, 2 * n // 3))

    out_f, out_l = [], []
    extra_v = []
    fans = 0
    for r in range(k):
        if r in dense or r not in loops_of:
            for fi in faces_of[r]:
                out_f.append(f[fi])
                out_l.append(r)
            continue
        poly = [x for x in loops_of[r] if x in anchors]
        tris = _triangulate(v, poly, pn[r])
        if tris is None:
            # Fan around an added centre vertex: always closes, never cracks.
            c = v[poly].mean(axis=0)
            extra_v.append(c)
            ci = len(v) + len(extra_v) - 1
            tris = [(poly[i], poly[(i + 1) % len(poly)], ci) for i in range(len(poly))]
            fans += 1
        for a, b, c in tris:
            out_f.append((a, b, c))
            out_l.append(r)
    out_f = np.array(out_f, dtype=np.int64)
    out_l = np.array(out_l, dtype=np.int64)
    if extra_v:
        v = np.concatenate([v, np.array(extra_v)], axis=0)
    # Drop unused vertices.
    used = np.unique(out_f)
    remap = -np.ones(len(v), dtype=np.int64)
    remap[used] = np.arange(len(used))
    return v[used], remap[out_f], out_l, len(dense) + fans
