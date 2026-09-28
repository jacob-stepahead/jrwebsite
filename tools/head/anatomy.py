"""Signed-distance sculpt of a stylised male head, neck and turtleneck.

Proportions follow the classical thirds (hairline -> brow -> nose base -> chin)
for an adult male head roughly 23.5 cm tall. The sculpt is deliberately a
little heroic (strong brow, square jaw) because the mesh is later reduced to
large flat planes, and planes read best when the forms underneath are bold.
"""
import numpy as np
from sdf import (ellipsoid, sphere, capsule, round_cone, box, plane, vesica2,
                 smin, smax, rot_x, rot_y, rot_z, mirror_x, length)

# Landmarks (cm). Only +x side listed for bilateral features.
EYE_C = np.array([3.15, 0.55, 6.55])     # eyeball centre
EYE_R = 1.22                              # eyeball radius
EYE_TILT = 7.0                            # degrees, outer corner up
EYE_OPEN_W = 1.55                         # half-width of lid opening
EYE_OPEN_H = 0.40                         # half-height of lid opening


def eye_local(p):
    """Coordinates relative to the right-hand eyeball, tilted with the lids."""
    q = mirror_x(p) - EYE_C
    return rot_z(q, -EYE_TILT)


def skull(p):
    m = mirror_x(p)
    # Cranial vault: long, slightly taller at the back.
    d = ellipsoid(p, (0, 3.2, -1.3), (7.45, 8.7, 9.3))
    d = smin(d, ellipsoid(p, (0, 4.6, -3.2), (7.05, 7.4, 7.4)), 2.0)
    # Forehead: broad and fairly upright.
    d = smin(d, ellipsoid(p, (0, 4.2, 2.6), (6.5, 6.2, 6.35)), 1.6)
    # Flatten the sides of the vault a touch (parietal planes).
    d = smax(d, plane(m, (1, 0, 0.05), 7.55), 1.2)
    # Temples: shallow hollows behind the outer brow.
    d = smax(d, -ellipsoid(m, (7.85, 3.0, 4.0), (1.0, 2.3, 2.5)), 1.2)
    return d


def midface(p):
    m = mirror_x(p)
    # Maxilla / cheek mass.
    d = ellipsoid(p, (0, -2.3, 3.2), (6.1, 5.6, 6.2))
    # Cheekbones (zygomatic body) and arch running back to the ear.
    d = smin(d, ellipsoid(m, (5.05, -0.7, 4.9), (2.25, 1.65, 2.6)), 1.3)
    d = smin(d, capsule(m, (5.6, -0.75, 4.2), (6.85, -0.9, 0.6), 0.8), 1.4)
    q = rot_x(m - np.array([5.55, -4.4, 1.6]), -12.0)
    d = smin(d, ellipsoid(q, (0, 0, 0), (1.25, 3.0, 2.1)), 1.5)  # masseter
    # Hollow of the cheek under the cheekbone.
    d = smin(d, ellipsoid(m, (4.3, -3.6, 5.6), (2.0, 2.2, 2.4)), 1.6)  # buccal fullness
    d = smax(d, -ellipsoid(m, (6.6, -4.2, 4.6), (1.0, 1.6, 1.5)), 1.4)
    return d


def jaw(p):
    m = mirror_x(p)
    gonion = (5.35, -6.9, -0.4)
    chin_side = (1.75, -10.25, 7.35)
    tmj = (6.25, -1.9, -0.9)
    d = round_cone(m, gonion, chin_side, 1.35, 1.25)       # mandible body
    d = smin(d, round_cone(m, tmj, gonion, 1.2, 1.35), 1.0)  # ramus
    # Fill between the two halves of the jaw.
    d = smin(d, ellipsoid(p, (0, -7.1, 3.1), (5.0, 3.9, 5.6)), 1.6)
    # Chin: squarish, slightly cleft.
    chin = ellipsoid(p, (0, -9.65, 7.55), (2.55, 1.75, 1.85))
    chin = smax(chin, -ellipsoid(p, (0, -9.6, 9.65), (0.28, 0.9, 0.35)), 0.4)
    d = smin(d, chin, 1.1)
    # Flat underside of the jaw so the neck line reads clearly.
    d = smax(d, plane(rot_x(p, -14.0), (0, -1, 0), 10.6), 0.9)
    return d


def nose(p):
    m = mirror_x(p)
    # Bridge -> tip, a tapered prism feel from a round cone.
    d = round_cone(p, (0, 1.25, 8.45), (0, -2.85, 10.55), 0.62, 0.92)
    # Side planes of the nose to sharpen the bridge.
    sides = plane(rot_y(m, -24.0), (1, 0, 0), 0.72)
    d = smax(d, sides - 0.35, 0.5)
    d = smin(d, sphere(p, (0, -3.2, 10.55), 0.98), 0.55)             # tip
    d = smin(d, ellipsoid(m, (1.3, -3.85, 9.35), (0.78, 0.62, 0.8)), 0.45)  # alae
    # Base of the nose sits flat.
    d = smax(d, plane(rot_x(p, 12.0), (0, -1, 0), 4.25), 0.35)
    # Nostrils.
    d = smax(d, -ellipsoid(m, (0.6, -4.3, 9.9), (0.26, 0.13, 0.34)), 0.2)
    return d


def mouth(p):
    m = mirror_x(p)
    # Muzzle (orbicularis mass), then lips on top of it.
    d = ellipsoid(p, (0, -6.3, 7.45), (3.1, 2.55, 2.35))
    upper = ellipsoid(p, (0, -5.92, 9.52), (2.35, 0.52, 0.62))
    upper = smax(upper, -ellipsoid(p, (0, -5.35, 10.15), (0.28, 0.55, 0.3)), 0.2)  # cupid's bow
    lower = ellipsoid(p, (0, -6.88, 9.28), (2.05, 0.58, 0.68))
    d = smin(d, upper, 0.45)
    d = smin(d, lower, 0.45)
    # Mouth line.
    d = smax(d, -ellipsoid(p, (0, -6.38, 9.85), (2.45, 0.075, 1.1)), 0.12)
    # Corners of the mouth push in.
    d = smax(d, -sphere(m, (2.45, -6.45, 8.85), 0.34), 0.35)
    # Philtrum groove.
    d = smax(d, -capsule(p, (0, -4.5, 10.02), (0, -5.5, 9.98), 0.2), 0.25)
    return d


def ears(p):
    m = mirror_x(p)
    q = rot_x(m - np.array([7.55, -1.2, -1.15]), 14.0)
    q = rot_z(q, 5.0)    # top of the ear leans out a touch
    q = rot_y(q, 24.0)   # opens slightly forward
    # Ear "disc": a thin C-shaped plate, thickest at the rim (helix).
    disc = ellipsoid(q, (0.1, 0.1, 0), (0.55, 2.8, 1.75))
    rim = np.sqrt((np.sqrt((q[..., 1] / 2.55) ** 2 + (q[..., 2] / 1.35) ** 2) - 1.0) ** 2 * 1.9 ** 2
                  + (q[..., 0] - 0.35) ** 2) - 0.34
    rim = np.maximum(rim, q[..., 2] - 0.9)        # helix open toward the face
    d = smin(disc, rim, 0.2)
    lobe = ellipsoid(q, (0.2, -2.55, 0.35), (0.42, 0.75, 0.65))
    d = smin(d, lobe, 0.3)
    d = smax(d, -ellipsoid(q, (0.55, -0.35, 0.25), (0.35, 1.25, 0.8)), 0.25)  # concha
    d = smin(d, ellipsoid(q, (-0.35, -0.6, 0.8), (0.55, 0.9, 0.55)), 0.35)     # tragus/root
    return d


def eye_region(p, d):
    """Brow ridge, sockets and lids carved into / added onto the face."""
    m = mirror_x(p)
    # Brow ridge: strong, slightly angled down toward the temples.
    brow = capsule(m, (0.55, 2.05, 8.75), (4.95, 1.95, 7.35), 0.72)
    d = smin(d, brow, 0.9)
    # Glabella fill so the brows connect over the nose.
    d = smin(d, ellipsoid(p, (0, 1.55, 8.55), (1.25, 0.9, 0.8)), 0.6)
    # Socket: carve a generous hollow around the eyeball.
    socket = ellipsoid(m, EYE_C + np.array([0.0, 0.05, 1.05]), (1.95, 1.35, 1.2))
    d = smax(d, -socket, 0.9)
    # Lids: a ball just larger than the eyeball, with an almond window cut in it.
    q = eye_local(p)
    opening = vesica2(q[..., 0] - 0.05, q[..., 1], EYE_OPEN_W, EYE_OPEN_H)
    lids = smax(length(q) - (EYE_R + 0.14), -opening, 0.08)
    d = smin(d, lids, 0.35)
    # Heavier upper lid for a focused look.
    d = smin(d, ellipsoid(q, (0.0, 0.85, 0.62), (1.55, 0.42, 0.62)), 0.35)
    # Keep the window clean: a tunnel through the opening, in front of the eye.
    tunnel = np.maximum(opening, -q[..., 2])
    tunnel = np.maximum(tunnel, q[..., 2] - 3.0)
    d = smax(d, -tunnel, 0.06)
    return d


def neck(p):
    m = mirror_x(p)
    d = round_cone(p, (0, -3.0, -2.2), (0, -19.0, -0.8), 5.1, 5.7)
    # Sternocleidomastoid ridges from behind the ear to the sternum.
    d = smin(d, capsule(m, (5.2, -3.8, -2.4), (1.3, -15.5, 3.6), 1.05), 1.2)
    # Throat / larynx.
    d = smin(d, ellipsoid(p, (0, -11.6, 3.4), (1.0, 1.35, 0.9)), 0.9)
    return d


def head_sdf(p):
    d = skull(p)
    d = smin(d, midface(p), 1.6)
    d = smin(d, jaw(p), 1.2)
    d = smin(d, mouth(p), 0.9)
    d = smin(d, nose(p), 0.55)
    d = eye_region(p, d)
    d = smin(d, ears(p), 0.45)
    d = smin(d, neck(p), 1.6)
    # Cut the neck off inside the collar.
    d = smax(d, plane(p, (0, -1, 0), 17.0), 0.1)
    return d


def eyeball_sdf(p):
    q = mirror_x(p) - EYE_C
    return length(q) - EYE_R


# ---------------------------------------------------------------- sweater
def sweater_sdf(p):
    m = mirror_x(p)
    # Collar frame: tilted so the roll sits lower at the front than the back.
    pivot = np.array([0.0, -10.2, -1.6])
    q = rot_x(p - pivot, 11.0)
    radial = np.sqrt(q[..., 0] ** 2 + q[..., 2] ** 2)
    y = q[..., 1]                      # 0 at the top of the tube, negative down
    t = np.clip(-y / 9.0, 0.0, 1.0)
    tube = radial - (6.45 + 0.6 * t)   # flares a little toward the base
    tube = np.maximum(tube, y)         # open at the top...
    lip = np.sqrt((radial - 6.05) ** 2 + y ** 2) - 1.05  # ...with a rolled lip
    collar = smin(tube, lip, 0.5)
    # Soft horizontal folds.
    collar = collar + 0.1 * np.sin(y * 2.3) * (y < -0.8) * (y > -6.0)
    # Shoulders / upper torso.
    torso = ellipsoid(p, (0, -28.0, -1.2), (19.0, 9.5, 8.6))
    torso = smin(torso, capsule(m, (4.0, -16.8, -1.8), (16.0, -19.6, -1.6), 4.2), 3.0)  # trapezius
    torso = smin(torso, sphere(m, (17.2, -22.4, -0.8), 4.6), 3.0)                       # deltoid
    torso = smin(torso, ellipsoid(p, (0, -22.5, 0.4), (10.5, 6.0, 7.2)), 2.5)
    d = smin(collar, torso, 1.4)
    # Hollow where the neck enters the collar (never seen, keeps it light).
    hole = np.maximum(radial - 5.35, -y - 6.5)
    d = smax(d, -hole, 0.2)
    d = smax(d, plane(p, (0, -1, 0), 34.0), 0.1)
    return d
