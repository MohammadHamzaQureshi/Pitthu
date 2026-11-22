import bpy, math, os
from mathutils import Vector, Euler

# Reset scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

def make_mat(name, hex_col, roughness=0.78, specular=0.25):
    m = bpy.data.materials.new(name)
    rgb = [int(hex_col[i:i+2], 16) / 255.0 for i in (0, 2, 4)]
    m.diffuse_color = (*rgb, 1.0)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        bsdf.inputs['Roughness'].default_value = roughness
    return m

MATS = {
    'Skin': make_mat('Skin', 'C67D52', 0.72),
    'Shirt': make_mat('Shirt', '288984', 0.82),
    'Undershirt': make_mat('Undershirt', 'F5EBD6', 0.85),
    'Shorts': make_mat('Shorts', '2A3950', 0.84),
    'Shoe': make_mat('Shoe', 'F3E9D7', 0.78),
    'Sole': make_mat('Sole', 'C86D46', 0.88),
    'Laces': make_mat('Laces', 'FFFDF7', 0.80),
    'Hair': make_mat('Hair', '271C19', 0.65),
    'Brows': make_mat('Brows', '221714', 0.70),
    'Sclera': make_mat('Sclera', 'FFFDF9', 0.25),
    'Iris': make_mat('Iris', '4A2816', 0.20),
    'Pupil': make_mat('Pupil', '120D0A', 0.15),
    'EyeGlint': make_mat('EyeGlint', 'FFFFFF', 0.05),
    'Teeth': make_mat('Teeth', 'FFFDF8', 0.30),
    'Mouth': make_mat('Mouth', '7D352B', 0.60),
    'Cheek': make_mat('Cheek', 'D9765E', 0.78),
    'Wristband': make_mat('Wristband', 'D94B38', 0.65),
}

# Build 17-bone PittuRig armature facing +Y in Blender (+Z in glTF export)
arm_data = bpy.data.armatures.new('PittuRigData')
arm_obj = bpy.data.objects.new('PittuRig', arm_data)
bpy.context.collection.objects.link(arm_obj)
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode='EDIT')

bones_spec = [
    ('Root', None, (0, 0, 0), (0, 0, 0.15)),
    ('Hips', 'Root', (0, 0, 0.78), (0, 0, 0.92)),
    ('Spine', 'Hips', (0, 0, 0.92), (0, 0, 1.10)),
    ('Chest', 'Spine', (0, 0, 1.10), (0, 0, 1.28)),
    ('Head', 'Chest', (0, 0, 1.32), (0, 0, 1.95)),
    ('UpperArmL', 'Chest', (-0.20, 0, 1.22), (-0.36, 0, 1.02)),
    ('ForearmL', 'UpperArmL', (-0.36, 0, 1.02), (-0.48, 0, 0.84)),
    ('HandL', 'ForearmL', (-0.48, 0, 0.84), (-0.54, 0, 0.74)),
    ('UpperArmR', 'Chest', (0.20, 0, 1.22), (0.36, 0, 1.02)),
    ('ForearmR', 'UpperArmR', (0.36, 0, 1.02), (0.48, 0, 0.84)),
    ('HandR', 'ForearmR', (0.48, 0, 0.84), (0.54, 0, 0.74)),
    ('ThighL', 'Hips', (-0.15, 0, 0.76), (-0.16, 0, 0.42)),
    ('ShinL', 'ThighL', (-0.16, 0, 0.42), (-0.16, 0, 0.12)),
    ('FootL', 'ShinL', (-0.16, 0, 0.12), (-0.16, 0.18, 0.0)),
    ('ThighR', 'Hips', (0.15, 0, 0.76), (0.16, 0, 0.42)),
    ('ShinR', 'ThighR', (0.16, 0, 0.42), (0.16, 0, 0.12)),
    ('FootR', 'ShinR', (0.16, 0, 0.12), (0.16, 0.18, 0.0)),
]

for bname, parent, head, tail in bones_spec:
    eb = arm_data.edit_bones.new(bname)
    eb.head = Vector(head)
    eb.tail = Vector(tail)
    if parent:
        eb.parent = arm_data.edit_bones[parent]

bpy.ops.object.mode_set(mode='OBJECT')
print('PittuRig 17-bone armature authored.')
