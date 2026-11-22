import bpy, os, math
from mathutils import Vector
bpy.ops.wm.open_mainfile(filepath=os.path.abspath('assets/source/pittu_character.blend'))
s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=12;s.cycles.use_denoising=True
s.render.resolution_x=128;s.render.resolution_y=160;s.render.resolution_percentage=100;s.render.film_transparent=True
s.render.image_settings.file_format='PNG';s.render.image_settings.color_mode='RGBA';s.world.use_nodes=True;s.world.node_tree.nodes['Background'].inputs[0].default_value=(.8,.85,.9,1);s.world.node_tree.nodes['Background'].inputs[1].default_value=.7
bpy.ops.object.camera_add(location=(0,-6,7.2));cam=bpy.context.object;cam.rotation_euler=((Vector((0,0,.8))-cam.location).to_track_quat('-Z','Y').to_euler());cam.data.type='ORTHO';cam.data.ortho_scale=2.2;s.camera=cam
bpy.ops.object.light_add(type='AREA',location=(-3,-4,7));bpy.context.object.data.energy=450;bpy.context.object.data.size=5
s.view_settings.view_transform='AgX';root=bpy.data.objects['Character'];out=os.path.abspath('.sites-runtime/sprites');os.makedirs(out,exist_ok=True)
for team in range(2):
 color=(.14,.48,.42,1) if team==0 else (.8,.28,.16,1)
 bpy.data.materials['Shirt'].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=color
 for direction in range(8):
  root.rotation_euler.z=-direction*math.pi/4
  for pose,walk in enumerate([0,.55,-.55]):
   for name,v in [('LegL',walk),('LegR',-walk),('ArmL',-walk*.7),('ArmR',walk*.7)]:bpy.data.objects[name].rotation_euler.x=v
   s.render.filepath=f'{out}/{team}-{direction}-{pose}.png';bpy.ops.render.render(write_still=True)
print('SPRITES_COMPLETE')
