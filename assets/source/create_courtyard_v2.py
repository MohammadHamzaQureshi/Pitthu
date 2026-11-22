#!/usr/bin/env python3
"""
Authoring script for Pittu Courtyard v2 (public/models/pittu-courtyard-v2.glb).
Builds the 3D courtyard foundation, outer 3D architectural border framing the 32.13m x 24.90m
Nano Banana Pro courtyard (where the dashed stone circle is at exact (0, 0) and the playable pitch is 19.6m x 12.4m),
two detailed 3D beveled brick planters (COVER) with lush marigold-flowered shrubs, and 3D white tubular mini-goalposts.
"""
import json
import math
import os
import struct
import numpy as np


def srgb_to_linear(hex_str):
    hex_str = hex_str.lstrip('#')
    rgb = [int(hex_str[i:i+2], 16) / 255.0 for i in (0, 2, 4)]
    lin = [
        c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        for c in rgb
    ]
    return [round(lin[0], 6), round(lin[1], 6), round(lin[2], 6), 1.0]


MATERIALS = [
    ("SurroundingGround", "#C69862", 0.95, 0.0),
    ("CourtyardBase",     "#B4834E", 0.92, 0.0),
    ("DustyEarth",        "#DFAF71", 0.94, 0.0),
    ("ChalkLine",         "#FFF9EA", 0.88, 0.0),
    ("HouseTerracotta",   "#C96A46", 0.88, 0.0),
    ("HouseMint",         "#7EB292", 0.88, 0.0),
    ("HouseCream",        "#DFC17B", 0.88, 0.0),
    ("RoofTrim",          "#9B4E36", 0.86, 0.0),
    ("ChajjaConcrete",    "#C2AE95", 0.89, 0.0),
    ("WindowFrame",       "#E6D2B2", 0.82, 0.0),
    ("WindowGlass",       "#2F4543", 0.38, 0.1),
    ("WindowBars",        "#263032", 0.52, 0.35),
    ("WaterTank",         "#20252A", 0.48, 0.15),
    ("PlanterBrick",      "#B85A38", 0.86, 0.0),
    ("PlanterBrickDark",  "#964428", 0.88, 0.0),
    ("PlanterRim",        "#DFB788", 0.82, 0.0),
    ("PlanterSoil",       "#3E2B1D", 0.94, 0.0),
    ("FoliageDark",       "#2D5A2B", 0.84, 0.0),
    ("FoliageMid",        "#4A7F36", 0.82, 0.0),
    ("FoliageLight",      "#72A644", 0.80, 0.0),
    ("MarigoldGold",      "#F4A824", 0.75, 0.0),
    ("MarigoldOrange",    "#E86820", 0.75, 0.0),
    ("TreeTrunk",         "#684A30", 0.90, 0.0),
    ("GoalpostWhite",     "#F6F1E4", 0.55, 0.15),
]


class MeshBuilder:
    def __init__(self):
        self.buckets = {name: {"verts": [], "norms": [], "tris": [], "count": 0} for name, _, _, _ in MATERIALS}

    def _add_raw(self, mat, verts, norms, tris):
        b = self.buckets[mat]
        base = b["count"]
        v_arr = np.asarray(verts, dtype=np.float32)
        n_arr = np.asarray(norms, dtype=np.float32)
        t_arr = np.asarray(tris, dtype=np.uint32).reshape(-1, 3).copy()
        v0 = v_arr[t_arr[:, 0]]
        v1 = v_arr[t_arr[:, 1]]
        v2 = v_arr[t_arr[:, 2]]
        n_mean = n_arr[t_arr[:, 0]] + n_arr[t_arr[:, 1]] + n_arr[t_arr[:, 2]]
        cross = np.cross(v1 - v0, v2 - v0)
        flip = np.einsum("ij,ij->i", cross, n_mean) < 0
        t_arr[flip, 1], t_arr[flip, 2] = t_arr[flip, 2].copy(), t_arr[flip, 1].copy()

        b["verts"].append(v_arr)
        b["norms"].append(n_arr)
        b["tris"].append(t_arr + base)
        b["count"] += len(v_arr)

    def add_box(self, mat, cx, cy, cz, sx, sy, sz, rx=0.0, ry=0.0, rz=0.0):
        hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
        faces = [
            ([(-hx, -hy,  hz), ( hx, -hy,  hz), ( hx,  hy,  hz), (-hx,  hy,  hz)], (0, 0, 1)),
            ([( hx, -hy, -hz), (-hx, -hy, -hz), (-hx,  hy, -hz), ( hx,  hy, -hz)], (0, 0, -1)),
            ([( hx, -hy,  hz), ( hx, -hy, -hz), ( hx,  hy, -hz), ( hx,  hy,  hz)], (1, 0, 0)),
            ([(-hx, -hy, -hz), (-hx, -hy,  hz), (-hx,  hy,  hz), (-hx,  hy, -hz)], (-1, 0, 0)),
            ([(-hx,  hy,  hz), ( hx,  hy,  hz), ( hx,  hy, -hz), (-hx,  hy, -hz)], (0, 1, 0)),
            ([(-hx, -hy, -hz), ( hx, -hy, -hz), ( hx, -hy,  hz), (-hx, -hy,  hz)], (0, -1, 0)),
        ]
        verts, norms, tris = [], [], []
        R = self._rot_matrix(rx, ry, rz)
        for idx, (f_verts, f_norm) in enumerate(faces):
            rn = R @ np.array(f_norm, dtype=np.float32)
            for vx, vy, vz in f_verts:
                rv = R @ np.array([vx, vy, vz], dtype=np.float32) + np.array([cx, cy, cz], dtype=np.float32)
                verts.append(rv)
                norms.append(rn)
            b = idx * 4
            tris.extend([(b, b+1, b+2), (b, b+2, b+3)])
        self._add_raw(mat, verts, norms, tris)

    def add_cylinder(self, mat, cx, cy, cz, r_top, r_bot, height, segs=12, rx=0.0, ry=0.0, rz=0.0):
        hy = height * 0.5
        R = self._rot_matrix(rx, ry, rz)
        verts, norms, tris = [], [], []
        for i in range(segs):
            a0 = (i / segs) * math.tau
            a1 = ((i + 1) / segs) * math.tau
            c0, s0 = math.cos(a0), math.sin(a0)
            c1, s1 = math.cos(a1), math.sin(a1)
            p0 = (c0 * r_bot, -hy, s0 * r_bot)
            p1 = (c1 * r_bot, -hy, s1 * r_bot)
            p2 = (c1 * r_top,  hy, s1 * r_top)
            p3 = (c0 * r_top,  hy, s0 * r_top)
            n0 = (c0, (r_bot - r_top) / max(height, 1e-4), s0)
            n1 = (c1, (r_bot - r_top) / max(height, 1e-4), s1)
            b = len(verts)
            for p, n in [(p0, n0), (p1, n1), (p2, n1), (p3, n0)]:
                nl = math.hypot(*n) or 1.0
                verts.append(R @ np.array(p, dtype=np.float32) + np.array([cx, cy, cz], dtype=np.float32))
                norms.append(R @ (np.array(n, dtype=np.float32) / nl))
            tris.extend([(b, b+1, b+2), (b, b+2, b+3)])
        if r_top > 1e-4:
            b_center = len(verts)
            nt = R @ np.array([0, 1, 0], dtype=np.float32)
            verts.append(R @ np.array([0, hy, 0], dtype=np.float32) + np.array([cx, cy, cz], dtype=np.float32))
            norms.append(nt)
            for i in range(segs):
                a = (i / segs) * math.tau
                verts.append(R @ np.array([math.cos(a)*r_top, hy, math.sin(a)*r_top], dtype=np.float32) + np.array([cx, cy, cz], dtype=np.float32))
                norms.append(nt)
            for i in range(segs):
                tris.append((b_center, b_center + 1 + i, b_center + 1 + ((i + 1) % segs)))
        self._add_raw(mat, verts, norms, tris)

    def add_sphere(self, mat, cx, cy, cz, rx_rad, ry_rad, rz_rad, u_segs=10, v_segs=7):
        verts, norms, tris = [], [], []
        for iv in range(v_segs + 1):
            v = iv / v_segs
            phi = 0.02 + v * (math.pi - 0.04)
            sp, cp = math.sin(phi), math.cos(phi)
            for iu in range(u_segs + 1):
                u = iu / u_segs
                theta = u * math.tau
                ct, st = math.cos(theta), math.sin(theta)
                nx, ny, nz = ct * sp, cp, st * sp
                vx = cx + nx * rx_rad
                vy = cy + ny * ry_rad
                vz = cz + nz * rz_rad
                nl = math.hypot(nx / max(rx_rad, 1e-3), ny / max(ry_rad, 1e-3), nz / max(rz_rad, 1e-3)) or 1.0
                verts.append([vx, vy, vz])
                norms.append([(nx / max(rx_rad, 1e-3)) / nl, (ny / max(ry_rad, 1e-3)) / nl, (nz / max(rz_rad, 1e-3)) / nl])
        stride = u_segs + 1
        for iv in range(v_segs):
            for iu in range(u_segs):
                a = iv * stride + iu
                b = a + 1
                c = a + stride
                d = c + 1
                tris.extend([(a, c, b), (b, c, d)])
        self._add_raw(mat, verts, norms, tris)

    @staticmethod
    def _rot_matrix(rx, ry, rz):
        cx, sx = math.cos(rx), math.sin(rx)
        cy, sy = math.cos(ry), math.sin(ry)
        cz, sz = math.cos(rz), math.sin(rz)
        Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=np.float32)
        Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float32)
        Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], dtype=np.float32)
        return Ry @ Rx @ Rz


def build_courtyard():
    mb = MeshBuilder()

    # 1. Warm Sunlit Earth Surround & Foundation matching the 32.13m x 24.90m Nano Banana Pro Courtyard (centered at z = -2.615)
    mb.add_box("SurroundingGround", 0.0, -0.55, -2.615, 76.0, 0.30, 62.0)
    mb.add_box("CourtyardBase",     0.0, -0.20, -2.615, 33.2, 0.50, 25.9)
    mb.add_box("DustyEarth",        0.0,  0.10, -2.615, 32.13, 0.20, 24.90)

    # Outer 3D Compound Border Frame around the 32.13m x 24.90m courtyard (so WIDE camera mode has rich 3D framing outside the texture)
    mb.add_box("HouseTerracotta", -10.5, 0.55, -15.35, 11.2, 0.90, 0.50)
    mb.add_box("HouseMint",         0.0, 0.65, -15.35,  9.8, 1.10, 0.50)
    mb.add_box("HouseCream",       10.5, 0.55, -15.35, 11.2, 0.90, 0.50)
    mb.add_box("RoofTrim",          0.0, 1.15, -15.35, 32.6, 0.14, 0.62)
    mb.add_box("ChajjaConcrete",    0.0, 0.45,  10.08, 32.6, 0.55, 0.48)
    mb.add_box("WindowFrame",     -16.3, 0.45,  -2.615, 0.48, 0.55, 25.4)
    mb.add_box("WindowFrame",      16.3, 0.45,  -2.615, 0.48, 0.55, 25.4)
    mb.add_box("WindowGlass",      -5.0, 0.45, -15.40,  1.2,  0.40, 0.52)
    mb.add_box("WindowBars",        5.0, 0.45, -15.40,  1.2,  0.40, 0.52)
    mb.add_cylinder("WaterTank",   -2.5, 1.45, -15.35,  0.45, 0.45, 0.60, segs=12)
    mb.add_cylinder("TreeTrunk",  -16.4, 0.70, -15.35,  0.25, 0.32, 1.10, segs=8)
    mb.add_cylinder("ChalkLine",    0.0, 0.206,  0.0,   0.12, 0.12, 0.01, segs=12)

    # 2. Two Detailed 3D Mid-Court Tactical Brick Planters (COVER: x = -6.0, z = 2.5 and x = 6.0, z = -2.5, w = 1.6, h = 1.1)
    # Styled directly after the Nano Banana Pro planter reference (courses of terracotta bricks, segmented sandstone coping slabs, dark soil, and lush marigold-flowered shrubs!)
    rng = np.random.RandomState(77)
    for cx, cz in [(-6.0, 2.5), (6.0, -2.5)]:
        mb.add_box("PlanterBrickDark", cx, 0.44, cz, 1.56, 0.48, 1.06)
        mb.add_box("PlanterSoil",      cx, 0.69, cz, 1.42, 0.06, 0.92)
        for row, py in enumerate([0.28, 0.44, 0.60]):
            n_front = 6
            for bi in range(n_front):
                bx_off = -0.64 + bi * 0.256 + (0.06 if row % 2 else -0.04)
                bx_off = max(-0.66, min(0.66, bx_off))
                b_mat = "PlanterBrick" if (bi + row) % 3 != 0 else "PlanterBrickDark"
                mb.add_box(b_mat, cx + bx_off, py, cz + 0.535, 0.22, 0.13, 0.04)
                mb.add_box(b_mat, cx - bx_off, py, cz - 0.535, 0.22, 0.13, 0.04)
            n_side = 4
            for bi in range(n_side):
                bz_off = -0.38 + bi * 0.25 + (0.04 if row % 2 else -0.04)
                bz_off = max(-0.40, min(0.40, bz_off))
                b_mat = "PlanterBrick" if (bi + row) % 2 == 0 else "PlanterBrickDark"
                mb.add_box(b_mat, cx - 0.785, py, cz + bz_off, 0.04, 0.13, 0.21)
                mb.add_box(b_mat, cx + 0.785, py, cz - bz_off, 0.04, 0.13, 0.21)

        for sx_slab in [-0.62, -0.21, 0.21, 0.62]:
            mb.add_box("PlanterRim", cx + sx_slab, 0.72, cz + 0.48, 0.39, 0.10, 0.22)
            mb.add_box("PlanterRim", cx + sx_slab, 0.72, cz - 0.48, 0.39, 0.10, 0.22)
        for sz_slab in [-0.22, 0.22]:
            mb.add_box("PlanterRim", cx - 0.72, 0.72, cz + sz_slab, 0.22, 0.10, 0.41)
            mb.add_box("PlanterRim", cx + 0.72, 0.72, cz + sz_slab, 0.22, 0.10, 0.41)

        bush_centers = [(-0.46, -0.04, 1.02), (0.0, 0.05, 1.08), (0.46, -0.03, 1.02)]
        for bx_c, bz_c, b_scale in bush_centers:
            for k in range(12):
                ang = (k / 12.0) * math.tau + rng.uniform(-0.2, 0.2)
                rad = rng.uniform(0.05, 0.26) * b_scale
                lx = cx + bx_c + math.cos(ang) * rad
                lz = cz + bz_c + math.sin(ang) * rad * 0.82
                ly = 0.78 + rng.uniform(0.02, 0.22) * b_scale
                fmat = "FoliageDark" if ly < 0.86 else ("FoliageMid" if ly < 0.94 else "FoliageLight")
                mb.add_sphere(fmat, lx, ly, lz, 0.13 * b_scale, 0.10 * b_scale, 0.12 * b_scale, u_segs=8, v_segs=6)
            for fl in range(5):
                fang = rng.uniform(-0.4, math.pi + 0.4)
                frad = rng.uniform(0.08, 0.24) * b_scale
                fx = cx + bx_c + math.cos(fang) * frad
                fz = cz + bz_c + math.sin(fang) * frad * 0.85
                fy = 0.88 + rng.uniform(0.04, 0.14) * b_scale
                m_col = "MarigoldGold" if fl % 2 == 0 else "MarigoldOrange"
                mb.add_sphere(m_col, fx, fy, fz, 0.042, 0.032, 0.042, u_segs=6, v_segs=5)

    # 2B. Warm Beveled Plinth Base Around Both Mid-Court Planters for Natural Ground Blending
    for cx, cz in [(-6.0, 2.5), (6.0, -2.5)]:
        mb.add_box("ChajjaConcrete", cx, 0.23, cz, 1.68, 0.055, 1.18)
        mb.add_box("CourtyardBase",  cx, 0.208, cz, 1.78, 0.022, 1.28)

    # 3. True 3D Tubular White Mini-Goalposts at x = -9.32, z = 0.0 and x = 9.32, z = 0.0 (matching COURT_PROPS[0..1])
    for side, gx in [(-1.0, -9.15), (1.0, 9.15)]:
        depth_x = gx + side * 0.42
        post_h = 1.22
        y_base = 0.205
        y_top = y_base + post_h
        z_half = 1.24
        # Front vertical goalposts
        mb.add_cylinder("GoalpostWhite", gx, y_base + post_h * 0.5, -z_half, 0.042, 0.046, post_h, segs=12)
        mb.add_cylinder("GoalpostWhite", gx, y_base + post_h * 0.5,  z_half, 0.042, 0.046, post_h, segs=12)
        # Top horizontal crossbar
        mb.add_cylinder("GoalpostWhite", gx, y_top, 0.0, 0.042, 0.042, z_half * 2.04, segs=12, rx=math.pi * 0.5)
        # Corner elbow joints
        mb.add_sphere("GoalpostWhite", gx, y_top, -z_half, 0.052, 0.052, 0.052, u_segs=8, v_segs=6)
        mb.add_sphere("GoalpostWhite", gx, y_top,  z_half, 0.052, 0.052, 0.052, u_segs=8, v_segs=6)
        # Rear ground frame & side ground struts
        mb.add_cylinder("ChajjaConcrete", depth_x, y_base + 0.025, 0.0, 0.032, 0.032, z_half * 2.0, segs=10, rx=math.pi * 0.5)
        mb.add_box("ChajjaConcrete", (gx + depth_x) * 0.5, y_base + 0.025, -z_half, abs(depth_x - gx), 0.045, 0.055)
        mb.add_box("ChajjaConcrete", (gx + depth_x) * 0.5, y_base + 0.025,  z_half, abs(depth_x - gx), 0.045, 0.055)
        # Diagonal back-stay struts from top corners to rear ground frame
        diag_len = math.hypot(post_h, abs(depth_x - gx))
        diag_tilt = math.atan2(abs(depth_x - gx), post_h) * (-side)
        mb.add_cylinder("GoalpostWhite", (gx + depth_x) * 0.5, y_base + post_h * 0.5, -z_half, 0.028, 0.028, diag_len, segs=10, rz=diag_tilt)
        mb.add_cylinder("GoalpostWhite", (gx + depth_x) * 0.5, y_base + post_h * 0.5,  z_half, 0.028, 0.028, diag_len, segs=10, rz=diag_tilt)

    # 4. Outer 3D Goalpost Anchor & Corner Pillar Trim
    for sx, gx in [(-1, -16.3), (1, 16.3)]:
        mb.add_box("GoalpostWhite", gx, 0.78, -2.615, 0.52, 0.12, 25.4)

    return mb


def export_glb(mb, out_path):
    gltf_materials = []
    for name, hex_col, rough, metal in MATERIALS:
        gltf_materials.append({
            "name": name,
            "pbrMetallicRoughness": {
                "baseColorFactor": srgb_to_linear(hex_col),
                "roughnessFactor": rough,
                "metallicFactor": metal,
            },
            "doubleSided": True,
        })

    buffer_views = []
    accessors = []
    primitives = []
    bin_chunks = []
    byte_offset = 0

    def append_bin(raw_bytes, target):
        nonlocal byte_offset
        pad = (4 - (len(raw_bytes) % 4)) % 4
        padded = raw_bytes + (b"\x00" * pad)
        bv_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": byte_offset,
            "byteLength": len(raw_bytes),
            "target": target,
        })
        bin_chunks.append(padded)
        byte_offset += len(padded)
        return bv_idx

    total_tris = 0
    for mat_idx, (name, _, _, _) in enumerate(MATERIALS):
        b = mb.buckets[name]
        if not b["verts"]:
            continue
        v_arr = np.vstack(b["verts"]).astype(np.float32)
        n_arr = np.vstack(b["norms"]).astype(np.float32)
        t_arr = np.vstack(b["tris"]).astype(np.uint16 if len(v_arr) < 65535 else np.uint32).reshape(-1)
        total_tris += len(t_arr) // 3

        v_bv = append_bin(v_arr.tobytes(), 34962)
        n_bv = append_bin(n_arr.tobytes(), 34962)
        i_bv = append_bin(t_arr.tobytes(), 34963)

        v_acc = len(accessors)
        accessors.append({
            "bufferView": v_bv,
            "componentType": 5126,
            "count": int(len(v_arr)),
            "type": "VEC3",
            "min": [float(x) for x in v_arr.min(axis=0)],
            "max": [float(x) for x in v_arr.max(axis=0)],
        })
        n_acc = len(accessors)
        accessors.append({
            "bufferView": n_bv,
            "componentType": 5126,
            "count": int(len(n_arr)),
            "type": "VEC3",
        })
        i_acc = len(accessors)
        accessors.append({
            "bufferView": i_bv,
            "componentType": 5123 if t_arr.dtype == np.uint16 else 5125,
            "count": int(len(t_arr)),
            "type": "SCALAR",
        })

        primitives.append({
            "attributes": {"POSITION": v_acc, "NORMAL": n_acc},
            "indices": i_acc,
            "material": mat_idx,
            "mode": 4,
        })

    gltf = {
        "asset": {"version": "2.0", "generator": "PittuCourtyardV2Generator"},
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [0]}],
        "nodes": [{"name": "PittuCourtyardV2", "mesh": 0}],
        "meshes": [{"name": "CourtyardBatchedMesh", "primitives": primitives}],
        "materials": gltf_materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": byte_offset}],
    }

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = (4 - (len(json_bytes) % 4)) % 4
    json_bytes += b" " * json_pad
    bin_bytes = b"".join(bin_chunks)

    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    with open(out_path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total_len))
        f.write(struct.pack("<I4s", len(json_bytes), b"JSON"))
        f.write(json_bytes)
        f.write(struct.pack("<I4s", len(bin_bytes), b"BIN\x00"))
        f.write(bin_bytes)

    print(f"Exported {out_path}: {total_len:,} bytes, {len(primitives)} material primitives, {total_tris:,} triangles.")


if __name__ == "__main__":
    os.makedirs("public/models", exist_ok=True)
    builder = build_courtyard()
    export_glb(builder, "public/models/pittu-courtyard-v2.glb")
