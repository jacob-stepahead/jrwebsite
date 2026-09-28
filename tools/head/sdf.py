"""Tiny vectorised signed-distance-field toolkit (numpy).

Every primitive takes `p` as an (..., 3) array and returns (...) distances.
Units are centimetres; +y is up, +z is where the face looks, +x is the
character's left.
"""
import numpy as np


def length(v):
    return np.sqrt(np.sum(v * v, axis=-1))


def ellipsoid(p, c, r):
    """Approximate SDF of an axis-aligned ellipsoid (iq's bound)."""
    q = (p - np.asarray(c, float)) / np.asarray(r, float)
    k0 = length(q)
    k1 = length(q / np.asarray(r, float))
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def sphere(p, c, r):
    return length(p - np.asarray(c, float)) - r


def capsule(p, a, b, r):
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    pa = p - a
    ba = b - a
    h = np.clip(np.sum(pa * ba, axis=-1) / np.dot(ba, ba), 0.0, 1.0)
    return length(pa - ba * h[..., None]) - r


def round_cone(p, a, b, r1, r2):
    """Capsule whose radius tapers linearly from r1 (at a) to r2 (at b)."""
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    pa = p - a
    ba = b - a
    h = np.clip(np.sum(pa * ba, axis=-1) / np.dot(ba, ba), 0.0, 1.0)
    return length(pa - ba * h[..., None]) - (r1 + (r2 - r1) * h)


def box(p, c, half, r=0.0):
    q = np.abs(p - np.asarray(c, float)) - (np.asarray(half, float) - r)
    outside = length(np.maximum(q, 0.0))
    inside = np.minimum(np.max(q, axis=-1), 0.0)
    return outside + inside - r


def plane(p, n, d):
    """Half-space n.p <= d is inside."""
    n = np.asarray(n, float)
    n = n / np.linalg.norm(n)
    return np.sum(p * n, axis=-1) - d


def vesica2(px, py, w, h):
    """2D almond (vesica) centred at origin, width 2w along x, height 2h along y."""
    # Circles of radius r whose centres sit at +-d on the y axis.
    r = (w * w + h * h) / (2.0 * h)
    d = r - h
    x = np.abs(px)
    y = np.abs(py)
    # Region selection per iq's sdVesica (rotated so the long axis is x).
    b = np.sqrt(np.maximum(r * r - d * d, 0.0))
    cond = (x - b) * d > y * b
    dist_corner = np.sqrt((x - b) ** 2 + y ** 2)
    dist_circle = np.sqrt(x ** 2 + (y + d) ** 2) - r
    return np.where(cond, dist_corner, dist_circle)


def smin(a, b, k):
    """Polynomial smooth minimum (union)."""
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b + (a - b) * h - k * h * (1.0 - h)


def smax(a, b, k):
    """Smooth maximum (intersection / subtraction when b is negated)."""
    return -smin(-a, -b, k)


def rot_x(p, deg, pivot=(0, 0, 0)):
    t = np.radians(deg)
    c, s = np.cos(t), np.sin(t)
    q = p - np.asarray(pivot, float)
    y = q[..., 1] * c - q[..., 2] * s
    z = q[..., 1] * s + q[..., 2] * c
    return np.stack([q[..., 0], y, z], axis=-1) + np.asarray(pivot, float)


def rot_y(p, deg, pivot=(0, 0, 0)):
    t = np.radians(deg)
    c, s = np.cos(t), np.sin(t)
    q = p - np.asarray(pivot, float)
    x = q[..., 0] * c + q[..., 2] * s
    z = -q[..., 0] * s + q[..., 2] * c
    return np.stack([x, q[..., 1], z], axis=-1) + np.asarray(pivot, float)


def rot_z(p, deg, pivot=(0, 0, 0)):
    t = np.radians(deg)
    c, s = np.cos(t), np.sin(t)
    q = p - np.asarray(pivot, float)
    x = q[..., 0] * c - q[..., 1] * s
    y = q[..., 0] * s + q[..., 1] * c
    return np.stack([x, y, q[..., 2]], axis=-1) + np.asarray(pivot, float)


def mirror_x(p):
    """Fold space so features defined for +x appear on both sides."""
    return np.stack([np.abs(p[..., 0]), p[..., 1], p[..., 2]], axis=-1)
