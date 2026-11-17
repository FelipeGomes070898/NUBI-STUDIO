"""Executa DENTRO do Blender (bpy). Lê um job JSON e renderiza uma tomada.

Uso:  blender -b -P blender_runner.py -- job.json     |     python -I blender_runner.py job.json

Job (campos): job, environment, seed, resolution, fps, samples, engine,
frame_start, frame_end, output_dir, output_prefix, camera{keyframes}, character{...}, orb{keyframes}
Imprime NUBI_JOB_DONE ao terminar.  Frames já existentes são pulados (recuperação).
"""
import json
import math
import os
import random
import sys

import bpy  # noqa: deve vir antes de bmesh/mathutils (módulo bpy)
import bmesh
from mathutils import Matrix, Vector, noise


def load_job():
    argv = sys.argv
    path = argv[argv.index("--") + 1] if "--" in argv else argv[-1]
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ----------------------------------------------------------------- utilidades
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def make_mat(name, color, emission=0.0, emit_color=None, roughness=0.7, alpha=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = roughness
    if emission > 0:
        b.inputs["Emission Color"].default_value = (*(emit_color or color), 1)
        b.inputs["Emission Strength"].default_value = emission
    return m


class Builder:
    """Acumula primitivas num único mesh (menos objetos, render mais rápido)."""

    def __init__(self, name, material):
        self.name, self.mat = name, material
        self.bm = bmesh.new()

    def sphere(self, loc, r, scale=(1, 1, 1), seg=14):
        mat = Matrix.Translation(loc) @ Matrix.Diagonal((*scale, 1))
        bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=max(6, seg // 2), radius=r, matrix=mat)

    def cone(self, loc, r1, r2, depth, seg=12, rot_z=0.0):
        mat = Matrix.Translation(loc + Vector((0, 0, depth / 2))) @ Matrix.Rotation(rot_z, 4, "Z")
        bmesh.ops.create_cone(self.bm, cap_ends=True, segments=seg, radius1=r1, radius2=r2, depth=depth, matrix=mat)

    def box(self, loc, size, rot_z=0.0):
        mat = Matrix.Translation(loc) @ Matrix.Rotation(rot_z, 4, "Z") @ Matrix.Diagonal((*size, 1))
        bmesh.ops.create_cube(self.bm, size=1.0, matrix=mat)

    def finish(self, smooth=True):
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        if smooth:
            for p in me.polygons:
                p.use_smooth = True
        ob = bpy.data.objects.new(self.name, me)
        ob.data.materials.append(self.mat)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def ground_height(x, y, seed):
    # chão mais plano ao longo da trilha (|y| pequeno)
    amp = 0.12 + 0.55 * min(1.0, max(0.0, (abs(y) - 1.5) / 6.0))
    return noise.noise(Vector((x * 0.18 + seed, y * 0.18, 0))) * amp


# --------------------------------------------------------- ambiente reutilizável
def build_environment(name, seed):
    """Preset 'mushroom_forest': clareira de cogumelos luminosos com arco de pedra."""
    rnd = random.Random(seed)
    if name != "mushroom_forest":
        raise ValueError(f"ambiente desconhecido: {name}")
    sc = bpy.context.scene

    # mundo: gradiente de entardecer
    w = bpy.data.worlds.new("NUBI_World")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    bg = nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], bg.inputs["Color"])
    nt.links.new(bg.outputs[0], out.inputs[0])
    e = ramp.color_ramp.elements
    e[0].position, e[0].color = 0.35, (1.0, 0.45, 0.35, 1)   # horizonte quente
    e[1].position, e[1].color = 0.8, (0.18, 0.12, 0.45, 1)   # céu violeta
    mid = e.new(0.52)
    mid.color = (0.85, 0.3, 0.6, 1)
    bg.inputs["Strength"].default_value = 0.9

    # chão com relevo + cor de trilha em vertex color
    n = 90
    size = 70.0
    me = bpy.data.meshes.new("Ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=n, y_segments=n, size=size / 2)
    for v in bm.verts:
        v.co.z = ground_height(v.co.x, v.co.y, seed)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    grass, dirt = Vector((0.07, 0.30, 0.22)), Vector((0.55, 0.38, 0.28))
    for i, v in enumerate(me.vertices):
        t = max(0.0, 1.0 - abs(v.co.y) / 1.7)
        t = t * t * (3 - 2 * t)
        c = grass.lerp(dirt, t)
        ca.data[i].color = (c.x, c.y, c.z, 1)
    gm = bpy.data.materials.new("GroundMat")
    gm.use_nodes = True
    gn = gm.node_tree.nodes
    attr = gn.new("ShaderNodeAttribute")
    attr.attribute_name = "Col"
    gn["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    gm.node_tree.links.new(attr.outputs["Color"], gn["Principled BSDF"].inputs["Base Color"])
    me.materials.append(gm)
    gob = bpy.data.objects.new("Ground", me)
    sc.collection.objects.link(gob)

    # cogumelos
    stems = Builder("Stems", make_mat("Stem", (0.95, 0.88, 0.75)))
    caps = {
        "pink": Builder("CapsPink", make_mat("CapPink", (0.9, 0.25, 0.55), 0.55, (1.0, 0.3, 0.6))),
        "violet": Builder("CapsViolet", make_mat("CapViolet", (0.45, 0.3, 0.9), 0.55, (0.55, 0.4, 1.0))),
        "teal": Builder("CapsTeal", make_mat("CapTeal", (0.1, 0.75, 0.7), 0.6, (0.2, 0.95, 0.85))),
    }
    spots = Builder("Spots", make_mat("Spot", (1, 1, 0.8), 2.0, (1.0, 0.95, 0.6)))
    placed = 0
    while placed < 46:
        x, y = rnd.uniform(-22, 22), rnd.uniform(2.6, 26)
        if abs(x - 6.5) < 3.2 and y < 6.5:        # área do arco
            continue
        big = rnd.random() < 0.28
        h = rnd.uniform(2.2, 4.2) if big else rnd.uniform(0.5, 1.4)
        r = h * rnd.uniform(0.45, 0.7)
        z = ground_height(x, y, seed)
        stems.cone(Vector((x, y, z - 0.1)), h * 0.09, h * 0.07, h, seg=10)
        key = rnd.choice(list(caps))
        caps[key].sphere(Vector((x, y, z + h)), r, (1, 1, 0.45), seg=16)
        for _ in range(4 if big else 2):
            a, rr = rnd.uniform(0, 6.28), rnd.uniform(0.2, 0.7) * r
            spots.sphere(Vector((x + math.cos(a) * rr, y + math.sin(a) * rr, z + h + r * 0.4)), r * 0.07)
        placed += 1
    stems.finish()
    for b in caps.values():
        b.finish()
    spots.finish()

    # árvores ao fundo (silhuetas violetas)
    trunk = Builder("Trunks", make_mat("Trunk", (0.16, 0.1, 0.2)))
    leaf = Builder("Leaves", make_mat("Leaf", (0.16, 0.22, 0.5), 0.1, (0.25, 0.35, 0.8)))
    for _ in range(30):
        x, y = rnd.uniform(-34, 34), rnd.uniform(24, 44)
        h = rnd.uniform(9, 15)
        trunk.cone(Vector((x, y, -0.5)), 0.5, 0.3, h, seg=8)
        for k in range(3):
            leaf.sphere(Vector((x + rnd.uniform(-1, 1), y, h - k * 1.5)), rnd.uniform(1.8, 2.8), (1, 1, 0.8), seg=10)
    trunk.finish()
    leaf.finish()

    # pedras e flores luminosas
    rock = Builder("Rocks", make_mat("Rock", (0.38, 0.34, 0.42), roughness=0.95))
    for _ in range(24):
        x, y = rnd.uniform(-16, 16), rnd.choice([rnd.uniform(-9, -2.4), rnd.uniform(2.4, 9)])
        rock.sphere(Vector((x, y, ground_height(x, y, seed))), rnd.uniform(0.2, 0.6), (1, rnd.uniform(.7, 1.1), .6), seg=8)
    rock.finish()
    flo = Builder("Flowers", make_mat("Flower", (1.0, 0.3, 0.7), 1.1, (1.0, 0.35, 0.75)))
    for _ in range(70):
        x, y = rnd.uniform(-12, 12), rnd.choice([rnd.uniform(-7, -1.9), rnd.uniform(1.9, 8)])
        flo.cone(Vector((x, y, ground_height(x, y, seed))), 0.07, 0.0, 0.35 + rnd.random() * .2, seg=6)
    flo.finish()
    fire = Builder("Fireflies", make_mat("Firefly", (1, 1, .6), 4.0, (1.0, 0.95, 0.5)))
    for _ in range(90):
        fire.sphere(Vector((rnd.uniform(-14, 14), rnd.uniform(-5, 20), rnd.uniform(0.4, 4.5))), 0.035, seg=6)
    fire.finish()

    # arco de pedra (portal) em x=6.5, y=3.2
    arch = Builder("Arch", make_mat("ArchStone", (0.5, 0.46, 0.55), roughness=0.9))
    ax, ay = 6.5, 3.2
    z0 = ground_height(ax, ay, seed)
    arch.box(Vector((ax - 1.4, ay, z0 + 1.6)), (0.55, 0.6, 3.2))
    arch.box(Vector((ax + 1.4, ay, z0 + 1.6)), (0.55, 0.6, 3.2))
    arch.box(Vector((ax, ay, z0 + 3.35)), (3.4, 0.65, 0.55))
    arch.finish(smooth=False)
    runes = Builder("Runes", make_mat("Rune", (0.3, 0.9, 1.0), 2.5, (0.3, 0.9, 1.0)))
    for k in range(5):
        runes.box(Vector((ax - 1.4 + 0.29 * (-1 if False else 0), ay - 0.32, z0 + 0.7 + k * 0.5)), (0.06, 0.02, 0.22))
        runes.box(Vector((ax + 1.4, ay - 0.32, z0 + 0.7 + k * 0.5)), (0.06, 0.02, 0.22))
    runes.finish(smooth=False)

    # luzes: sol de entardecer + preenchimento frio
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy, sun.color, sun.angle = 3.2, (1.0, 0.68, 0.5), math.radians(4)
    so = bpy.data.objects.new("Sun", sun)
    so.rotation_euler = (math.radians(62), math.radians(8), math.radians(-35))
    sc.collection.objects.link(so)
    fill = bpy.data.lights.new("Fill", "AREA")
    fill.energy, fill.color, fill.size = 700, (0.5, 0.62, 1.0), 14
    fo = bpy.data.objects.new("Fill", fill)
    fo.location = (-8, -10, 8)
    fo.rotation_euler = (math.radians(60), 0, math.radians(-35))
    sc.collection.objects.link(fo)
    return {"arch": (ax, ay, z0)}


# -------------------------------------------------------------- personagem 2D
def add_character(cfg, fps):
    """Plano com sequência PNG RGBA; sempre de frente para a câmera (billboard).
    Origem nos pés. Recebe luz/sombras da cena (integração de iluminação)."""
    sc = bpy.context.scene
    h = cfg["height"]
    wd = h * cfg["aspect"]
    me = bpy.data.meshes.new("CharPlane")
    fo = cfg.get("foot_offset", 0.0)   # pés ficam em z=0 (a imagem tem margem abaixo das botas)
    me.from_pydata([(-wd / 2, 0, -fo), (wd / 2, 0, -fo), (wd / 2, 0, h - fo), (-wd / 2, 0, h - fo)], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name="UV")
    for i, c in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[i].uv = c
    mat = bpy.data.materials.new("CharMat")
    mat.use_nodes = True
    nt = mat.node_tree
    nodes = nt.nodes
    nodes.clear()
    img = bpy.data.images.load(os.path.join(cfg["sequence_dir"], cfg["pattern"] % 1))
    img.source = "SEQUENCE"
    img.alpha_mode = "STRAIGHT"
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"
    tex.extension = "CLIP"
    tex.image_user.frame_duration = cfg["frames"]
    tex.image_user.frame_start = 1
    tex.image_user.frame_offset = 0
    tex.image_user.use_auto_refresh = True
    diff = nodes.new("ShaderNodeBsdfDiffuse")
    emis = nodes.new("ShaderNodeEmission")
    mix = nodes.new("ShaderNodeMixShader")
    tr = nodes.new("ShaderNodeBsdfTransparent")
    mixa = nodes.new("ShaderNodeMixShader")
    out = nodes.new("ShaderNodeOutputMaterial")
    L = nt.links.new
    L(tex.outputs["Color"], diff.inputs["Color"])
    L(tex.outputs["Color"], emis.inputs["Color"])
    emis.inputs["Strength"].default_value = 0.35       # preserva o desenho; resto vem da luz da cena
    mix.inputs[0].default_value = 0.35
    L(diff.outputs[0], mix.inputs[1])
    L(emis.outputs[0], mix.inputs[2])
    L(tex.outputs["Alpha"], mixa.inputs[0])
    L(tr.outputs[0], mixa.inputs[1])
    L(mix.outputs[0], mixa.inputs[2])
    L(mixa.outputs[0], out.inputs["Surface"])
    me.materials.append(mat)
    ob = bpy.data.objects.new("Character2D", me)
    sc.collection.objects.link(ob)
    ob.visible_shadow = True

    # sombra de contato suave sob os pés
    sm = bpy.data.meshes.new("ContactShadow")
    sm.from_pydata([(-0.6, -0.4, 0.02), (0.6, -0.4, 0.02), (0.6, 0.4, 0.02), (-0.6, 0.4, 0.02)], [], [(0, 1, 2, 3)])
    suv = sm.uv_layers.new(name="UV")
    for i, c in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
        suv.data[i].uv = c
    smat = bpy.data.materials.new("ContactShadowMat")
    smat.use_nodes = True
    sn = smat.node_tree.nodes
    sn.clear()
    tcn = sn.new("ShaderNodeTexCoord")
    grad = sn.new("ShaderNodeTexGradient")
    grad.gradient_type = "SPHERICAL"
    mp = sn.new("ShaderNodeMapping")
    mp.inputs["Location"].default_value = (-0.5, -0.5, 0)
    ramp = sn.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[0].color = 0.0, (0, 0, 0, 0)
    ramp.color_ramp.elements[1].position, ramp.color_ramp.elements[1].color = 0.5, (0, 0, 0, 1)
    ramp.color_ramp.interpolation = "EASE"
    # gradiente esférico vale 1 no centro -> inverte
    inv = sn.new("ShaderNodeMath")
    inv.operation = "SUBTRACT"
    inv.inputs[0].default_value = 1.0
    mul = sn.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = 0.55
    tb = sn.new("ShaderNodeBsdfTransparent")
    bk = sn.new("ShaderNodeBsdfDiffuse")
    bk.inputs["Color"].default_value = (0.02, 0.01, 0.05, 1)
    mx = sn.new("ShaderNodeMixShader")
    so_ = sn.new("ShaderNodeOutputMaterial")
    sl = smat.node_tree.links.new
    sl(tcn.outputs["UV"], mp.inputs["Vector"])
    sl(mp.outputs[0], grad.inputs["Vector"])
    sl(grad.outputs["Fac"], inv.inputs[1])
    sl(inv.outputs[0], ramp.inputs[0])
    sl(ramp.outputs["Color"], mul.inputs[0])
    sl(mul.outputs[0], mx.inputs[0])
    sl(tb.outputs[0], mx.inputs[1])
    sl(bk.outputs[0], mx.inputs[2])
    sl(mx.outputs[0], so_.inputs["Surface"])
    sm.materials.append(smat)
    sob = bpy.data.objects.new("ContactShadow", sm)
    sob.visible_shadow = False
    sc.collection.objects.link(sob)

    # trajetória (cada frame; interpolação linear => sem escorregar fora do planejado)
    for f, (x, y, z) in cfg["path"]:
        ob.location = (x, y, z)
        ob.scale = (1, 1, 1)
        ob.keyframe_insert("location", frame=f)
        sob.location = (x, y, z)
        sob.scale = (cfg.get("shadow_scale", 1.0),) * 3
        sob.keyframe_insert("location", frame=f)
    for o in (ob, sob):
        for fc in (o.animation_data.action.fcurves if hasattr(o.animation_data.action, "fcurves") else []):
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
    return ob


def lock_to_camera(ob, cam):
    c = ob.constraints.new("LOCKED_TRACK")
    c.target = cam
    c.track_axis = "TRACK_NEGATIVE_Y"
    c.lock_axis = "LOCK_Z"


# ----------------------------------------------------------------------- câmera
def _set_interp(obj, kind="BEZIER"):
    ad = obj.animation_data
    if not ad or not ad.action:
        return
    fcs = getattr(ad.action, "fcurves", None)
    if fcs is None:
        return
    for fc in fcs:
        for kp in fc.keyframe_points:
            kp.interpolation = kind


def add_camera(cfg, res):
    sc = bpy.context.scene
    cam_d = bpy.data.cameras.new("Cam")
    cam_d.sensor_width = 36
    cam_d.dof.use_dof = True
    cam = bpy.data.objects.new("Cam", cam_d)
    sc.collection.objects.link(cam)
    tgt = bpy.data.objects.new("CamTarget", None)
    sc.collection.objects.link(tgt)
    tr = cam.constraints.new("TRACK_TO")
    tr.target = tgt
    tr.track_axis = "TRACK_NEGATIVE_Z"
    tr.up_axis = "UP_Y"
    cam_d.dof.focus_object = tgt
    for k in cfg["keyframes"]:
        f = k["frame"]
        cam.location = k["location"]
        cam.keyframe_insert("location", frame=f)
        tgt.location = k["target"]
        tgt.keyframe_insert("location", frame=f)
        cam_d.lens = k["focal"]
        cam_d.keyframe_insert("lens", frame=f)
        cam_d.dof.aperture_fstop = k.get("fstop", 4.0)
        cam_d.dof.keyframe_insert("aperture_fstop", frame=f)
    for o in (cam, tgt):
        _set_interp(o, cfg.get("interp", "BEZIER"))
    _set_interp(cam_d, cfg.get("interp", "BEZIER"))
    sc.camera = cam
    return cam


# -------------------------------------------------------------------------- orbe
def add_orb(cfg):
    sc = bpy.context.scene
    me = bpy.data.meshes.new("Orb")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=0.22)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    mat = make_mat("OrbMat", (0.6, 0.95, 1.0), 10.0, (0.55, 0.95, 1.0))
    me.materials.append(mat)
    ob = bpy.data.objects.new("Orb", me)
    sc.collection.objects.link(ob)
    ld = bpy.data.lights.new("OrbLight", "POINT")
    ld.color = (0.55, 0.92, 1.0)
    ld.shadow_soft_size = 0.25
    lo = bpy.data.objects.new("OrbLight", ld)
    lo.parent = ob
    sc.collection.objects.link(lo)
    em = mat.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]
    for k in cfg["keyframes"]:
        f = k["frame"]
        ob.location = k["pos"]
        ob.scale = (k["scale"],) * 3
        ob.keyframe_insert("location", frame=f)
        ob.keyframe_insert("scale", frame=f)
        ld.energy = k["energy"]
        ld.keyframe_insert("energy", frame=f)
        if "color" in k:
            ld.color = k["color"]
            ld.keyframe_insert("color", frame=f)
        em.default_value = k["emit"]
        em.keyframe_insert("default_value", frame=f)
    for o in (ob,):
        _set_interp(o, "LINEAR")
    return ob


# ------------------------------------------------------------------------ main
def main():
    job = load_job()
    sc = reset_scene()
    W, H = job["resolution"]
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = W, H, 100
    sc.render.fps = job["fps"]
    sc.frame_start, sc.frame_end = job["frame_start"], job["frame_end"]
    sc.render.engine = job.get("engine", "CYCLES")
    if sc.render.engine == "CYCLES":
        cy = sc.cycles
        cy.device = "CPU"
        cy.samples = job["samples"]
        cy.use_adaptive_sampling = True
        cy.use_denoising = True
        try:
            cy.denoiser = "OPENIMAGEDENOISE"
        except Exception:
            pass
        cy.max_bounces = 4
        cy.diffuse_bounces = 2
        cy.glossy_bounces = 2
        cy.transmission_bounces = 2
        cy.transparent_max_bounces = 4
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.image_settings.color_depth = "8"
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.view_settings.exposure = job.get("exposure", 0.0)

    info = build_environment(job["environment"], job.get("seed", 7))
    cam = add_camera(job["camera"], (W, H))
    if job.get("character"):
        ch = add_character(job["character"], job["fps"])
        lock_to_camera(ch, cam)
    if job.get("orb"):
        add_orb(job["orb"])
    if job.get("save_blend"):
        bpy.ops.wm.save_as_mainfile(filepath=job["save_blend"])

    out_dir = job["output_dir"]
    os.makedirs(out_dir, exist_ok=True)
    done = skipped = 0
    for f in range(job["frame_start"], job["frame_end"] + 1):
        path = os.path.join(out_dir, f"{job['output_prefix']}{f:04d}.png")
        if os.path.exists(path) and os.path.getsize(path) > 1000:
            skipped += 1
            continue
        sc.frame_set(f)
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        done += 1
        print(f"NUBI_FRAME {f}/{job['frame_end']}", flush=True)
    print(f"NUBI_JOB_DONE job={job.get('job')} rendered={done} skipped={skipped}")


main()
