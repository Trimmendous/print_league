"""Render the user's 3MF trophy body (not the separate, unassembled label plate).
Run with Blender --background --factory-startup --python tools/render_trophy.py.
Complex paint subdivisions use their dominant encoded material; simple painted
faces retain the original filament regions; gold is darkened for presentation.
"""
import os
import bpy, zipfile, xml.etree.ElementTree as ET, json, re, math, hashlib
from pathlib import Path
from mathutils import Vector
SOURCE = Path(os.environ.get('TROPHY_SOURCE', 'tools/assets/trophy-source.3mf'))
ROOT = Path(__file__).resolve().parents[1]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
ns={'m':'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'}
with zipfile.ZipFile(SOURCE) as z:
    xml=ET.fromstring(z.read('3D/Objects/Body22_1.model'))
    obj=xml.find('m:resources/m:object',ns)
    vertices=[tuple(float(v.get(k)) for k in ('x','y','z')) for v in obj.findall('.//m:vertex',ns)]
    triangles=obj.findall('.//m:triangle',ns)
    faces=[tuple(int(t.get(k)) for k in ('v1','v2','v3')) for t in triangles]
    colors=json.loads(z.read('Metadata/project_settings.config'))['filament_colour']
mesh=bpy.data.meshes.new('Original trophy geometry'); mesh.from_pydata(vertices, [], faces); mesh.update()
trophy=bpy.data.objects.new('Benchy trophy — original body', mesh); bpy.context.collection.objects.link(trophy)
for title, color in zip(['Ocean blue','Foam white','Benchy gold','Base black'], colors):
    mat=bpy.data.materials.new(title);mat.use_nodes=True
    # Richer presentation gold; the supplied printable model is unchanged.
    if title=='Benchy gold': color='#B27A20'
    rgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]
    linear=[c/12.92 if c<0.04045 else ((c+0.055)/1.055)**2.4 for c in rgb]
    bsdf=mat.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Base Color'].default_value=(*linear,1)
    bsdf.inputs['Roughness'].default_value=.28 if title=='Benchy gold' else .38
    bsdf.inputs['Metallic'].default_value=.62 if title=='Benchy gold' else .02
    trophy.data.materials.append(mat)
approx=0
for face,tri in zip(mesh.polygons,triangles):
    paint=tri.get('paint_color',''); mapping={'':2,'4':0,'8':1,'1C':3}
    if paint in mapping: face.material_index=mapping[paint]
    else:
        approx+=1
        tokens=re.findall('1C|4|8',paint)
        face.material_index=mapping[max(set(tokens),key=tokens.count)] if tokens else 2
    face.use_smooth=False
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=96
scene.cycles.use_denoising=True
scene.render.resolution_x=1080;scene.render.resolution_y=1290;scene.render.resolution_percentage=100
scene.render.film_transparent=True
scene.world.use_nodes=True
background=scene.world.node_tree.nodes.get('Background')
background.inputs['Color'].default_value=(.12,.12,.12,1)
background.inputs['Strength'].default_value=.35
scene.view_settings.view_transform='AgX'
def aim(obj, point): obj.rotation_euler=(Vector(point)-obj.location).to_track_quat('-Z','Y').to_euler()
# Front three-quarter perspective, elevated to reveal the deck and cabin depth.
bpy.ops.object.camera_add(location=(220,-220,170));cam=bpy.context.object;aim(cam,(0,0,0));cam.data.type='PERSP';cam.data.lens=72;scene.camera=cam
for title,loc,power,size in [('Key',(-100,-180,230),1000000,95),('Fill',(140,-60,80),180000,110),('Rim',(70,120,190),1000000,85)]:
    bpy.ops.object.light_add(type='AREA',location=loc);light=bpy.context.object;light.name=title;light.data.energy=power;light.data.shape='DISK';light.data.size=size;aim(light,(0,0,0))
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
scene.render.filepath=str(ROOT/'static/assets/benchy-trophy.png')
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'tools/assets/trophy.blend'))
bpy.ops.render.render(write_still=True)
(ROOT/'tools/assets/trophy-source.json').write_text(json.dumps({'source':SOURCE.name,'sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'creator_from_metadata':'3DDoc; local label modification','triangles':len(faces),'paint_subdivision_faces_approximated':approx,'presentation_gold':'#B27A20','camera':{'position':[220,-220,170],'lens_mm':72},'notes':'Body mesh only; support enforcer and separate unassembled label plate excluded. No print geometry modified.'},indent=2)+'\n')
