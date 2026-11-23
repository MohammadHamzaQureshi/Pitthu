import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import {COVER,TOWER_ZONE_RADIUS,clamp,findPassTarget} from './game.js';

function makeSoftShadowTex(size=128,innerAlpha=0.54){
 const c=document.createElement('canvas');c.width=c.height=size;
 const ctx=c.getContext('2d');
 const g=ctx.createRadialGradient(size/2,size/2,size*0.06,size/2,size/2,size*0.48);
 g.addColorStop(0,`rgba(48,28,14,${innerAlpha})`);
 g.addColorStop(0.55,`rgba(58,35,18,${(innerAlpha*0.46).toFixed(3)})`);
 g.addColorStop(1,'rgba(58,35,18,0)');
 ctx.fillStyle=g;ctx.fillRect(0,0,size,size);
 const tex=new T.CanvasTexture(c);
 tex.colorSpace=T.SRGBColorSpace;
 return tex;
}

const SKIN_TONES=['#c4784c','#ce855a','#b0663c','#d28b60','#be7246','#ca8054','#b86e44','#d48e64'];
const HAIR_TONES=['#201512','#3a2016','#241510','#161114','#281914','#321c15','#1c1412','#2c161e'];
const SHORTS_TONES=['#253549','#342946','#22282a','#584634','#1c2d42','#263e3a','#2e3829','#422638'];
const SHOE_TONES=['#f3e9d7','#f5ebd8','#e6f4f8','#f5ede0','#2c3844','#f4ebe2','#f2ece1','#f6e8f0'];
const SOLE_TONES=['#c86d46','#d89628','#209890','#c85238','#f4efe6','#b84058','#2296a0','#d83070'];

// Silently probe WebGL2 or WebGL1 without ever emitting console.error.
// On WebGL1 / OpenGL ES 2.0 GPUs (like Dell Inspiron 1525 Intel 965GM where MAX_VERTEX_TEXTURE_IMAGE_UNITS == 0),
// disables checkShaderErrors (preventing Shader Error 1282) and flags supportsGpuSkinning=false so SkinnedMesh
// is converted into 17 bone-parented standard THREE.Mesh objects that render in hardware WebGL1 with 0 vertex textures!
// Convert any NPOT image into a Power-Of-Two (1024x1024) mipmapped CanvasTexture so WebGL 1 / legacy integrated GPUs
// (like Intel GMA X3100 / 965GM) can generate hardware trilinear mipmaps without blurriness or shimmer!
function buildPotMipmapTexture(img,T,maxAniso=1,potW=1024,potH=1024){
 if(!img||!(img.naturalWidth||img.width))return null;
 const c=document.createElement('canvas');c.width=potW;c.height=potH;
 const ctx=c.getContext('2d');
 ctx.imageSmoothingEnabled=true;
 if('imageSmoothingQuality' in ctx)ctx.imageSmoothingQuality='high';
 ctx.drawImage(img,0,0,potW,potH);
 const tex=new T.CanvasTexture(c);
 tex.colorSpace=T.SRGBColorSpace;
 tex.generateMipmaps=true;
 if(T.ClampToEdgeWrapping){tex.wrapS=T.ClampToEdgeWrapping;tex.wrapT=T.ClampToEdgeWrapping;}
 if(T.LinearMipmapLinearFilter)tex.minFilter=T.LinearMipmapLinearFilter;
 if(T.LinearFilter)tex.magFilter=T.LinearFilter;
 tex.anisotropy=maxAniso;
 tex.needsUpdate=true;
 return tex;
}

function createSafeWebGLRenderer(T){
 if(typeof window!=='undefined'&&window.__FORCE_CANVAS_3D)return null;
 if(!T||!T.WebGLRenderer)return null;
 if(typeof window!=='undefined'&&!window.__pittuWebGLConsoleFiltered){
  window.__pittuWebGLConsoleFiltered=true;
  const origErr=console.error,origWarn=console.warn;
  console.error=(...args)=>{
   if(String(args[0]||'').includes('THREE.WebGL'))return;
   origErr.apply(console,args);
  };
  console.warn=(...args)=>{
   if(String(args[0]||'').includes('THREE.WebGL'))return;
   origWarn.apply(console,args);
  };
 }
 const canvas=document.createElement('canvas');
 const suppressEvt=e=>{try{e.preventDefault();e.stopImmediatePropagation();}catch{}};
 canvas.addEventListener('webglcontextcreationerror',suppressEvt,true);
 const origErr=console.error,origWarn=console.warn;
 try{
  console.error=()=>{};console.warn=()=>{};
  const attrs={antialias:true,alpha:false,depth:true,stencil:false,powerPreference:'high-performance',failIfMajorPerformanceCaveat:false};
  let gl=null,isWebGL2=false;
  try{
   gl=canvas.getContext('webgl2',attrs)||canvas.getContext('webgl2');
   if(gl&&!gl.isContextLost())isWebGL2=true;
   else gl=null;
  }catch{gl=null;}
  if(!gl){
   for(const ctxType of ['webgl','experimental-webgl']){
    try{
     gl=canvas.getContext(ctxType,{antialias:true,alpha:false,depth:true,stencil:false,failIfMajorPerformanceCaveat:false})||
        canvas.getContext(ctxType,{antialias:false,alpha:false,depth:true,stencil:false,failIfMajorPerformanceCaveat:false})||
        canvas.getContext(ctxType);
     if(gl&&!gl.isContextLost())break;
     gl=null;
    }catch{gl=null;}
   }
  }
  if(!gl||gl.isContextLost())return null;
  const maxVertTex=gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS)||0;
  const supportsGpuSkinning=isWebGL2&&maxVertTex>=4;
  const r=new T.WebGLRenderer({canvas,context:gl,antialias:true,alpha:false,powerPreference:'high-performance'});
  if(r.debug)r.debug.checkShaderErrors=false;
  r.userData={isWebGL2,supportsGpuSkinning};
  return r;
 }catch{
  return null;
 }finally{
  console.error=origErr;console.warn=origWarn;
  canvas.removeEventListener('webglcontextcreationerror',suppressEvt,true);
 }
}

// Convert THREE.SkinnedMesh primitives into 17 bone-parented standard THREE.Mesh objects using boneInverses
// so WebGL 1 GPUs without vertex texture fetch (like Dell Inspiron 1525 Intel 965GM) render the exact 3D GLB character models!
const FACE_Z_NUDGE={
 Cheek:0.014,Mouth:0.014,Sclera:0.015,
 Brows:0.024,Teeth:0.024,Iris:0.025,
 Pupil:0.033,EyeGlint:0.041
};
const FACE_POLY_OFFSET={
 Hair:[-1,-2],Cheek:[-2,-4],Mouth:[-2,-4],Sclera:[-2,-4],
 Brows:[-3,-6],Teeth:[-3,-6],Iris:[-3,-6],
 Pupil:[-4,-8],EyeGlint:[-5,-10]
};

function convertGltfToBoneMeshes(gltf,T){
 if(!gltf||!gltf.scene)return;
 gltf.scene.updateMatrixWorld(true);
 const skinned=[];
 gltf.scene.traverse(o=>{if(o.isSkinnedMesh)skinned.push(o);});
 if(!skinned.length)return;
 const vPos=new T.Vector3(),vNorm=new T.Vector3();
 for(const sm of skinned){
  const geo=sm.geometry;
  const posAttr=geo?.attributes?.position;
  const normAttr=geo?.attributes?.normal;
  const skinIdx=geo?.attributes?.skinIndex;
  const skinWgt=geo?.attributes?.skinWeight;
  const idxAttr=geo?.index;
  const bones=sm.skeleton?.bones;
  const boneInverses=sm.skeleton?.boneInverses;
  if(!posAttr||!skinIdx||!skinWgt||!bones||!boneInverses)continue;
  const mName=sm.material?.name||'';
  const zNudge=FACE_Z_NUDGE[mName]||0;
  const vCount=posAttr.count;
  const domBone=new Uint8Array(vCount);
  for(let v=0;v<vCount;v++){
   let bestB=skinIdx.getX(v),bestW=skinWgt.getX(v);
   if(skinWgt.getY(v)>bestW){bestW=skinWgt.getY(v);bestB=skinIdx.getY(v);}
   if(skinWgt.getZ(v)>bestW){bestW=skinWgt.getZ(v);bestB=skinIdx.getZ(v);}
   if(skinWgt.getW(v)>bestW){bestW=skinWgt.getW(v);bestB=skinIdx.getW(v);}
   domBone[v]=bestB;
  }
  const buckets=Array.from({length:bones.length},()=>[]);
  const idxCount=idxAttr?idxAttr.count:vCount;
  for(let i=0;i<idxCount;i+=3){
   const i0=idxAttr?idxAttr.getX(i):i;
   const i1=idxAttr?idxAttr.getX(i+1):i+1;
   const i2=idxAttr?idxAttr.getX(i+2):i+2;
   const b=domBone[i0]||0;
   if(buckets[b])buckets[b].push(i0,i1,i2);
  }
  for(let b=0;b<bones.length;b++){
   const tris=buckets[b];
   if(!tris||!tris.length||!bones[b]||!boneInverses[b])continue;
   const invMat=boneInverses[b];
   const pOut=new Float32Array(tris.length*3);
   const nOut=normAttr?new Float32Array(tris.length*3):null;
   for(let k=0;k<tris.length;k++){
    const vi=tris[k];
    vPos.fromBufferAttribute(posAttr,vi).applyMatrix4(invMat);
    pOut[k*3]=vPos.x;pOut[k*3+1]=vPos.y;pOut[k*3+2]=vPos.z+zNudge;
    if(normAttr&&nOut){
     vNorm.fromBufferAttribute(normAttr,vi);
     nOut[k*3]=vNorm.x;nOut[k*3+1]=vNorm.y;nOut[k*3+2]=vNorm.z;
    }
   }
   const subGeo=new T.BufferGeometry();
   subGeo.setAttribute('position',new T.BufferAttribute(pOut,3));
   if(nOut)subGeo.setAttribute('normal',new T.BufferAttribute(nOut,3));
   const subMesh=new T.Mesh(subGeo,sm.material);
   subMesh.castShadow=false;subMesh.receiveShadow=false;subMesh.frustumCulled=false;
   bones[b].add(subMesh);
  }
  if(sm.parent)sm.parent.remove(sm);
 }
}

function shadeHex(hex,mul=1,add=0){
 const c=parseInt(String(hex).replace('#',''),16)||0;
 const r=clamp(Math.round(((c>>16)&255)*mul+add),0,255);
 const g=clamp(Math.round(((c>>8)&255)*mul+add),0,255);
 const b=clamp(Math.round((c&255)*mul+add),0,255);
 return `rgb(${r},${g},${b})`;
}

export async function makeWorld(el,onAim){
 const scene=new T.Scene();scene.background=new T.Color('#ce9f6a');scene.fog=new T.Fog('#ce9f6a',52,104);
 let renderer=createSafeWebGLRenderer(T);
 const isCanvas3D=!renderer;
 const isWebGL1=!!(renderer&&!renderer.userData?.supportsGpuSkinning);
 const maxDpr=isWebGL1?1.5:2.5;

 // Shared state referenced by both WebGLRenderer and our True-3D Canvas3DRenderer
 let bgImageEl=null,canopyImageEl=null;
 let bakedProps=[]; // Pre-rasterized 3D GLB props (planters, marigold shrubs & goalposts) for Canvas3DRenderer
 let latestGameRef=null,latestMeId='',latestTime=0;

 const camera=new T.OrthographicCamera(-12.5,12.5,8.4,-8.4,isWebGL1?16:0.1,isWebGL1?54:120);
 const camBaseOffset=new T.Vector3(0,26.0,21.5);
 const camFocus=new T.Vector3(0,0,-0.35);
 camera.position.copy(camBaseOffset).add(camFocus);camera.lookAt(camFocus);
 camera.updateMatrixWorld(true);
 camera.updateProjectionMatrix();

 scene.add(new T.HemisphereLight(0xfff6e8,0xa4835c,0.96));
 const sun=new T.DirectionalLight(0xffe2b2,1.32);
 sun.position.set(-11.5,22.5,11.2);sun.castShadow=!isWebGL1;
 sun.shadow.mapSize.set(isWebGL1?1024:2048,isWebGL1?1024:2048);
 Object.assign(sun.shadow.camera,{left:-18.5,right:18.5,top:18.5,bottom:-18.5,near:.1,far:68});
 sun.shadow.bias=-0.00035;
 sun.shadow.normalBias=.024;
 scene.add(sun);

 const rimLight=new T.DirectionalLight(0xa4cae0,0.28);
 rimLight.position.set(12,14,-10);
 scene.add(rimLight);
 const mats={};const mat=(col,rough=.85)=>mats[col]||(mats[col]=isWebGL1&&T.MeshLambertMaterial?new T.MeshLambertMaterial({color:col}):new T.MeshStandardMaterial({color:col,roughness:rough}));
 function mesh(geo,col,x=0,y=0,z=0,parent=scene,cast=!isWebGL1,receive=true){let m=new T.Mesh(geo,mat(col));m.position.set(x,y,z);m.castShadow=cast&&!isWebGL1;m.receiveShadow=receive&&!isWebGL1;parent.add(m);return m;}
 function ball(r,col,x,y,z,parent=scene){return mesh(new T.SphereGeometry(r,20,16),col,x,y,z,parent,!isWebGL1,!isWebGL1);}

 // Pre-rasterize the 4 static 3D courtyard obstacles/props from pittu-courtyard-v2.glb into crisp offscreen canvases
 // using the exact orthographic camera basis vectors so Canvas3DRenderer displays the real 3D GLB planters, marigolds & goalposts!
 function bakeCourtyardPropsFromGLB(courtScene){
  try{
   // Camera basis for camBaseOffset=(0,26.0,21.5) looking at (0,0,0):
   // Right=(1,0,0), Up=(0, 0.63726, -0.77065), ForwardFromScene=(0, 0.77065, 0.63726)
   const UY=0.63726,UZ=-0.77065,FY=0.77065,FZ=0.63726;
   const sunLen=Math.hypot(-11.5,22.5,11.2);
   const sx=-11.5/sunLen,sy=22.5/sunLen,sz=11.2/sunLen;
   const propDefs=[
    {id:'cover0',ax:-6.0,ay:0.205,az:2.5,zSort:2.5,wM:2.2,hM:1.8,match:(wx,wy,wz,mName)=>wy>=0.195&&wx<-3.5&&wx>-8.5&&wz>0.8&&wz<4.2&&mName!=='SurroundingGround'&&mName!=='DustyEarth'},
    {id:'cover1',ax:6.0,ay:0.205,az:-2.5,zSort:-2.5,wM:2.2,hM:1.8,match:(wx,wy,wz,mName)=>wy>=0.195&&wx>3.5&&wx<8.5&&wz<-0.8&&wz>-4.2&&mName!=='SurroundingGround'&&mName!=='DustyEarth'},
    {id:'goalL',ax:-9.15,ay:0.205,az:0.0,zSort:0.0,wM:1.4,hM:3.2,match:(wx,wy,wz,mName)=>mName==='GoalpostWhite'&&wx<0},
    {id:'goalR',ax:9.15,ay:0.205,az:0.0,zSort:0.0,wM:1.4,hM:3.2,match:(wx,wy,wz,mName)=>mName==='GoalpostWhite'&&wx>0}
   ];
   const buckets=propDefs.map(()=>[]);
   courtScene.updateMatrixWorld(true);
   const vA=new T.Vector3(),vB=new T.Vector3(),vC=new T.Vector3();
   const nA=new T.Vector3(),nB=new T.Vector3(),nC=new T.Vector3();
   courtScene.traverse(o=>{
    if(!o.isMesh||!o.geometry)return;
    const mName=o.material?.name||'';
    if(['SurroundingGround','DustyEarth','HouseTerracotta','HouseMint','HouseCream','RoofTrim','WindowFrame','WindowGlass','WindowBars','WaterTank','TreeTrunk','ChalkLine'].includes(mName))return;
    const pos=o.geometry.attributes.position;
    const norm=o.geometry.attributes.normal;
    const idx=o.geometry.index;
    if(!pos)return;
    const col=o.material?.color||new T.Color('#b85a38');
    // Convert linear material color back to sRGB for accurate 2D canvas shading
    const srgb=col.clone().convertLinearToSRGB();
    const rBase=Math.round(srgb.r*255),gBase=Math.round(srgb.g*255),bBase=Math.round(srgb.b*255);
    const count=idx?idx.count:pos.count;
    for(let i=0;i<count;i+=3){
     const i0=idx?idx.getX(i):i,i1=idx?idx.getX(i+1):i+1,i2=idx?idx.getX(i+2):i+2;
     vA.fromBufferAttribute(pos,i0).applyMatrix4(o.matrixWorld);
     vB.fromBufferAttribute(pos,i1).applyMatrix4(o.matrixWorld);
     vC.fromBufferAttribute(pos,i2).applyMatrix4(o.matrixWorld);
     const cx=(vA.x+vB.x+vC.x)/3,cy=(vA.y+vB.y+vC.y)/3,cz=(vA.z+vB.z+vC.z)/3;
     let bIdx=-1;
     for(let p=0;p<propDefs.length;p++){
      if(propDefs[p].match(cx,cy,cz,mName)){bIdx=p;break;}
     }
     if(bIdx<0)continue;
     let nx=0,ny=1,nz=0;
     if(norm){
      nA.fromBufferAttribute(norm,i0);nB.fromBufferAttribute(norm,i1);nC.fromBufferAttribute(norm,i2);
      nx=(nA.x+nB.x+nC.x)/3;ny=(nA.y+nB.y+nC.y)/3;nz=(nA.z+nB.z+nC.z)/3;
      const nl=Math.hypot(nx,ny,nz)||1;nx/=nl;ny/=nl;nz/=nl;
     }
     // Backface cull against camera view vector (0, FY, FZ)
     if(ny*FY+nz*FZ<-0.22)continue;
     const ndotl=Math.max(0,nx*sx+ny*sy+nz*sz);
     const hemi=0.52+0.26*(ny*0.5+0.5);
     const light=clamp(hemi+ndotl*0.52,0.38,1.22);
     const rr=clamp(Math.round(rBase*light),0,255);
     const gg=clamp(Math.round(gBase*light),0,255);
     const bb=clamp(Math.round(bBase*light),0,255);
     const fill=`rgb(${rr},${gg},${bb})`;
     const pd=propDefs[bIdx];
     const u0=vA.x-pd.ax,w0=-((vA.y-pd.ay)*UY+(vA.z-pd.az)*UZ);
     const u1=vB.x-pd.ax,w1=-((vB.y-pd.ay)*UY+(vB.z-pd.az)*UZ);
     const u2=vC.x-pd.ax,w2=-((vC.y-pd.ay)*UY+(vC.z-pd.az)*UZ);
     const depth=(cy-pd.ay)*FY+(cz-pd.az)*FZ;
     buckets[bIdx].push({u0,w0,u1,w1,u2,w2,depth,fill});
    }
   });
   const SCALE=115; // 115 pixels per world meter in offscreen cache
   bakedProps=propDefs.map((pd,idx)=>{
    const tris=buckets[idx];
    tris.sort((a,b)=>a.depth-b.depth);
    const cw=Math.ceil(pd.wM*SCALE),ch=Math.ceil(pd.hM*SCALE);
    const cv=document.createElement('canvas');cv.width=cw;cv.height=ch;
    const c2=cv.getContext('2d');
    const ox=cw*0.5,oy=ch*0.58;
    c2.lineJoin='round';
    for(let i=0;i<tris.length;i++){
     const t=tris[i];
     c2.fillStyle=t.fill;
     c2.strokeStyle=t.fill;
     c2.lineWidth=0.65;
     c2.beginPath();
     c2.moveTo(ox+t.u0*SCALE,oy+t.w0*SCALE);
     c2.lineTo(ox+t.u1*SCALE,oy+t.w1*SCALE);
     c2.lineTo(ox+t.u2*SCALE,oy+t.w2*SCALE);
     c2.closePath();
     c2.fill();
     c2.stroke();
    }
    return{...pd,canvas:cv,scale:SCALE,ox,oy};
   });
  }catch{}
 }

 const loader=new GLTFLoader();
 const texLoader=new T.TextureLoader();
 const maxAniso=renderer?(isWebGL1?Math.min(renderer.capabilities?.getMaxAnisotropy?.()||4,4):(renderer.capabilities?.getMaxAnisotropy?.()||8)):1;

 try{
  const courtGltf=await loader.loadAsync('/models/pittu-courtyard-v2.glb');
  courtGltf.scene.traverse(o=>{
   if(o.isMesh){
    if(isWebGL1&&T.MeshLambertMaterial&&o.material){
     const m=new T.MeshLambertMaterial({color:o.material.color});
     m.name=o.material.name||'';
     o.material=m;
    }
    o.castShadow=o.receiveShadow=!isWebGL1;
   }
  });
  scene.add(courtGltf.scene);
  if(isCanvas3D)bakeCourtyardPropsFromGLB(courtGltf.scene);
  else if(renderer&&!isWebGL1)renderer.shadowMap.needsUpdate=true;
 }catch(e){
  mesh(new T.BoxGeometry(72,.3,58),'#c69862',0,-.55,-2.615,scene,false,true);mesh(new T.BoxGeometry(33.2,.5,25.9),'#b4834e',0,-.2,-2.615,scene,false,true);mesh(new T.BoxGeometry(32.13,.2,24.90),'#dfaf71',0,.1,-2.615,scene,false,true);
  for(const o of COVER)mesh(new T.BoxGeometry(o.w,.52,o.h),'#b85a38',o.x,.46,o.z,scene,true,true);
  if(renderer)renderer.shadowMap.needsUpdate=true;
 }

 const cv=document.createElement('canvas');cv.width=cv.height=512;const cx=cv.getContext('2d');
 cx.fillStyle='#dcb276';cx.fillRect(0,0,512,512);
 const bumpCv=document.createElement('canvas');bumpCv.width=bumpCv.height=512;const bx=bumpCv.getContext('2d');
 bx.fillStyle='#808080';bx.fillRect(0,0,512,512);
 let seed=41;
 for(let i=0;i<9000;i++){
  seed=(seed*1664525+1013904223)>>>0;const x=seed%512;
  seed=(seed*1664525+1013904223)>>>0;const y=seed%512;
  cx.fillStyle=i%2?'#cfa468':'#e5bc82';cx.fillRect(x,y,2,2);
  bx.fillStyle=i%3===0?'#969696':(i%2?'#6c6c6c':'#8c8c8c');bx.fillRect(x,y,2,2);
 }
 const floorTex=new T.CanvasTexture(cv);floorTex.colorSpace=T.SRGBColorSpace;floorTex.generateMipmaps=true;if(T.LinearMipmapLinearFilter)floorTex.minFilter=T.LinearMipmapLinearFilter;if(T.LinearFilter)floorTex.magFilter=T.LinearFilter;floorTex.anisotropy=maxAniso;
 const bumpTex=new T.CanvasTexture(bumpCv);bumpTex.wrapS=bumpTex.wrapT=T.RepeatWrapping;bumpTex.repeat.set(6,5);
 const floorMat=isWebGL1&&T.MeshLambertMaterial?new T.MeshLambertMaterial({map:floorTex}):new T.MeshStandardMaterial({map:floorTex,bumpMap:bumpTex,bumpScale:0.015,roughness:.93,metalness:0});
 texLoader.load('/models/pittu-courtyard-bg-v2.png',(loadedTex)=>{
  bgImageEl=loadedTex.image||null;
  const potTex=(isWebGL1&&bgImageEl)?buildPotMipmapTexture(bgImageEl,T,maxAniso,1024,1024):null;
  if(potTex){
   loadedTex.dispose?.();
   floorMat.map=potTex;
  }else{
   loadedTex.colorSpace=T.SRGBColorSpace;
   loadedTex.anisotropy=maxAniso;
   floorMat.map=loadedTex;
  }
  floorMat.needsUpdate=true;
 },undefined,()=>{});
 const floor=mesh(new T.PlaneGeometry(32.13,24.90),'#ffffff',0,.205,-2.615,scene,false,true);floor.rotation.x=-Math.PI/2;floor.material=floorMat;floor.receiveShadow=true;

 const softAoTex=makeSoftShadowTex(128,0.48);
 const aoMat=new T.MeshBasicMaterial({map:softAoTex,transparent:true,depthWrite:false,opacity:0.74});
 for(const o of COVER){
  const ao=new T.Mesh(new T.PlaneGeometry(o.w*1.48,o.h*1.55),aoMat);
  ao.position.set(o.x+0.12,.212,o.z+0.10);ao.rotation.x=-Math.PI/2;scene.add(ao);
 }
 for(const gx of [-9.15,9.15]){
  const gAo=new T.Mesh(new T.PlaneGeometry(1.15,3.10),aoMat);
  gAo.position.set(gx,.212,0);gAo.rotation.x=-Math.PI/2;scene.add(gAo);
 }
 const towerAo=new T.Mesh(new T.PlaneGeometry(1.35,1.35),aoMat);
 towerAo.position.set(0.06,.214,0.05);towerAo.rotation.x=-Math.PI/2;scene.add(towerAo);

 let canopyMesh=null;
 const canopyCenterZ=-2.615+2.645*(21.5/26.0);
 texLoader.load('/models/pittu-courtyard-canopy-v2.png',(canopyTex)=>{
  canopyImageEl=canopyTex.image||null;
  const potCanopy=(isWebGL1&&canopyImageEl)?buildPotMipmapTexture(canopyImageEl,T,maxAniso,1024,1024):null;
  const finalCanopyTex=potCanopy||canopyTex;
  if(potCanopy)canopyTex.dispose?.();
  else{canopyTex.colorSpace=T.SRGBColorSpace;canopyTex.anisotropy=maxAniso;}
  const canopyMat=isWebGL1&&T.MeshLambertMaterial?new T.MeshLambertMaterial({map:finalCanopyTex,transparent:false,alphaTest:0.22,depthWrite:true}):new T.MeshStandardMaterial({map:finalCanopyTex,transparent:true,alphaTest:0.15,roughness:0.90,metalness:0,depthWrite:true});
  canopyMesh=new T.Mesh(new T.PlaneGeometry(32.13,24.90),canopyMat);
  canopyMesh.position.set(0,2.85,canopyCenterZ);
  canopyMesh.rotation.x=-Math.PI/2;
  canopyMesh.castShadow=true;
  canopyMesh.receiveShadow=false;
  scene.add(canopyMesh);
  if(renderer)renderer.shadowMap.needsUpdate=true;
 },undefined,()=>{});

 const moteCount=32;
 const moteGeo=new T.BufferGeometry();
 const motePos=new Float32Array(moteCount*3);
 for(let i=0;i<moteCount;i++){
  motePos[i*3]=(Math.random()-0.5)*20;
  motePos[i*3+1]=0.45+Math.random()*2.2;
  motePos[i*3+2]=(Math.random()-0.5)*13;
 }
 moteGeo.setAttribute('position',new T.BufferAttribute(motePos,3));
 const moteMat=new T.PointsMaterial({color:0xfff2c6,size:0.09,transparent:true,opacity:0.42,depthWrite:false});
 const motes=new T.Points(moteGeo,moteMat);
 scene.add(motes);

 const ring=mesh(new T.RingGeometry(1.04,1.12,64),'#fff7df',0,.23,0,scene,false,false);ring.rotation.x=-Math.PI/2;

 // Restricted Tower Zone Ring (r = TOWER_ZONE_RADIUS = 1.85m)
 const towerZoneGroup=new T.Group();
 towerZoneGroup.position.set(0,.224,0);
 const zoneDiscMat=new T.MeshBasicMaterial({color:'#ff7a2f',transparent:true,opacity:0.07,depthWrite:false,side:T.DoubleSide});
 const zoneDisc=new T.Mesh(new T.RingGeometry(1.13,TOWER_ZONE_RADIUS,48),zoneDiscMat);
 zoneDisc.rotation.x=-Math.PI/2;
 towerZoneGroup.add(zoneDisc);
 const zoneDashMat=new T.MeshBasicMaterial({color:'#ff8838',transparent:true,opacity:0.62,depthWrite:false,side:T.DoubleSide});
 const dashSegments=24;
 for(let i=0;i<dashSegments;i++){
  const a0=(i/dashSegments)*Math.PI*2;
  const segGeo=new T.RingGeometry(TOWER_ZONE_RADIUS-0.045,TOWER_ZONE_RADIUS+0.025,8,1,a0,Math.PI*2/(dashSegments*1.65));
  const segM=new T.Mesh(segGeo,zoneDashMat);
  segM.rotation.x=-Math.PI/2;
  towerZoneGroup.add(segM);
 }
 towerZoneGroup.visible=false;
 scene.add(towerZoneGroup);

 const placeProgressRing=mesh(new T.RingGeometry(1.14,1.28,48),'#28b8a8',0,.24,0,scene,false,false);placeProgressRing.rotation.x=-Math.PI/2;placeProgressRing.visible=false;
 const pickupRing=mesh(new T.RingGeometry(.46,.58,32),'#ffe680',0,.24,0,scene,false,false);pickupRing.rotation.x=-Math.PI/2;pickupRing.visible=false;
 const passRing=mesh(new T.RingGeometry(.58,.72,36),'#38f2d8',0,.245,0,scene,false,false);passRing.rotation.x=-Math.PI/2;passRing.visible=false;
 const scatterWaveRing=mesh(new T.RingGeometry(.35,.55,48),'#ffdf78',0,.245,0,scene,false,false);scatterWaveRing.rotation.x=-Math.PI/2;scatterWaveRing.visible=false;
 const chargeRing=mesh(new T.RingGeometry(.54,.68,36),'#ffaa3b',0,.245,0,scene,false,false);chargeRing.rotation.x=-Math.PI/2;chargeRing.visible=false;



 const stonePalette=['#5e655e','#6d746c','#565d58','#777d74','#626962','#70766e','#5a605a'];
 const stoneMeshes=Array.from({length:7},(_,i)=>{
  let rTop=.39-i*.022,rBot=.43-i*.022;
  let s=mesh(new T.CylinderGeometry(rTop,rBot,.135,9),stonePalette[i],0,.28+i*.135,0,scene,!isWebGL1,true);
  s.userData={rTop,rBot,col:stonePalette[i],idx:i};
  s.rotation.y=i*.45;return s;
 });

 const gameBall=ball(.24,'#f0b828',0,.8,4.5);
 const ballShadowMat=new T.MeshBasicMaterial({map:makeSoftShadowTex(64,0.68),transparent:true,depthWrite:false,opacity:0.72});
 const ballShadow=new T.Mesh(new T.PlaneGeometry(.72,.72),ballShadowMat);
 ballShadow.position.set(0,.228,4.5);ballShadow.rotation.x=-Math.PI/2;scene.add(ballShadow);

 // Judwaa Split-Ball 3D Twin Mesh + Shadow
 const twinBallMesh=ball(.23,'#ffdf38',0,.8,4.5);twinBallMesh.visible=false;
 const twinShadow=new T.Mesh(new T.PlaneGeometry(.66,.66),ballShadowMat);
 twinShadow.position.set(0,.228,4.5);twinShadow.rotation.x=-Math.PI/2;twinShadow.visible=false;scene.add(twinShadow);

 const trailCount=7;
 const trailSpheres=Array.from({length:trailCount},(_,i)=>{
  const m=new T.Mesh(new T.SphereGeometry(.18*(1-i/trailCount),10,8),new T.MeshBasicMaterial({color:0xffe47a,transparent:true,opacity:0.46*(1-i/trailCount)}));
  m.visible=false;scene.add(m);return m;
 });
 const trailPool=Array.from({length:trailCount},()=>new T.Vector3());
 let trailLen=0;

 const aimMat=new T.LineBasicMaterial({color:'#fff8df',linewidth:2});
 const aim=new T.Line(new T.BufferGeometry().setFromPoints([[0,.28,0],[0,.28,-4],[0,.28,-3.5],[0,.28,-4],[0,.28,-3.5]].map(p=>new T.Vector3(...p))),aimMat);
 scene.add(aim);

 // Pre-allocated Color objects to eliminate per-frame string parsing in update()
 const COL_ZONE_ALERT=new T.Color('#ff3b1f');
 const COL_ZONE_IDLE=new T.Color('#ff8a38');
 const COL_TOWER_RING=new T.Color('#ff7828');
 const COL_AIM_PASS=new T.Color('#38f2d8');
 const COL_AIM_ZONE=new T.Color('#ff8828');
 const COL_AIM_MAX=new T.Color('#ff3b1f');
 const COL_AIM_HIGH=new T.Color('#ff6b4a');
 const COL_AIM_MID=new T.Color('#ffe066');
 const COL_AIM_BASE=new T.Color('#fff8df');
 const COL_CHG_HIGH=new T.Color('#ff6b32');
 const COL_CHG_BASE=new T.Color('#ffbe3b');
 const BUFF_COLORS={
  chappal:new T.Color('#38d6ff'),
  genda:new T.Color('#ffa826'),
  mirchi:new T.Color('#ff4228'),
  banta:new T.Color('#68ee44'),
  judwaa:new T.Color('#ffde38'),
  kathputli:new T.Color('#e85298')
 };
 const BURST_COLORS={
  mirchi:new T.Color('#ff4224'),
  genda:new T.Color('#ffbe28'),
  banta:new T.Color('#58ee44'),
  judwaa:new T.Color('#ffde38'),
  kathputli:new T.Color('#f058a8')
 };

 const players=new Map();
 const powerupVisuals=new Map();
 const decoyVisuals=new Map();
 const burstMeshes=Array.from({length:6},()=>{
  const bm=new T.Mesh(new T.RingGeometry(0.32,0.52,36),new T.MeshBasicMaterial({color:'#ffaa38',transparent:true,opacity:0.85,side:T.DoubleSide,depthWrite:false}));
  bm.rotation.x=-Math.PI/2;bm.visible=false;scene.add(bm);return bm;
 });

 const playerShadowTex=makeSoftShadowTex(64,0.58);
 const footRingGeo=new T.RingGeometry(.44,.54,32);
 const pShadowGeo=new T.PlaneGeometry(.95,.95);
 const auraRingGeo=new T.RingGeometry(0.58,0.72,36);
 const shieldDomeGeo=new T.SphereGeometry(0.78,18,14);
 const decoyStoneGeo=new T.CylinderGeometry(.33,.37,.135,9);

 let charGltf=null,girlGltf=null;
 try{charGltf=await loader.loadAsync('/models/pittu-character-v2.glb');}catch(e){console.warn('Character model unavailable',e);}
 try{girlGltf=await loader.loadAsync('/models/pittu-character-girl-v2.glb');}catch{girlGltf=charGltf;}
 if(isWebGL1){
  convertGltfToBoneMeshes(charGltf,T);
  if(girlGltf&&girlGltf!==charGltf)convertGltfToBoneMeshes(girlGltf,T);
 }

 function tag(text,color){
  let a=document.createElement('canvas');a.width=256;a.height=64;let q=a.getContext('2d');
  q.fillStyle=color;q.beginPath();q.roundRect(4,6,248,48,22);q.fill();
  q.strokeStyle='#fff8e8';q.lineWidth=3;q.stroke();
  q.fillStyle='#fff9e9';q.font='800 22px sans-serif';q.textAlign='center';q.fillText(text.slice(0,18),128,39);
  let s=new T.Sprite(new T.SpriteMaterial({map:new T.CanvasTexture(a),depthTest:false}));s.scale.set(1.72,.43,1);s.position.y=2.25;
  s.userData={canvas:a,text,color};
  return s;
 }

 // Build distinctive 3D mesh for each of the 6 courtyard power-ups
 function createPowerupVisual(pu){
  const root=new T.Group();
  root.position.set(pu.x,0.22,pu.z);
  const padMat=new T.MeshBasicMaterial({color:pu.color||'#ffe066',transparent:true,opacity:0.82,side:T.DoubleSide,depthWrite:false});
  const pad=new T.Mesh(new T.RingGeometry(0.42,0.56,32),padMat);
  pad.rotation.x=-Math.PI/2;pad.position.y=0.02;root.add(pad);
  const innerPadMat=new T.MeshBasicMaterial({color:pu.color||'#ffe066',transparent:true,opacity:0.20,depthWrite:false});
  const innerPad=new T.Mesh(new T.CircleGeometry(0.40,28),innerPadMat);
  innerPad.rotation.x=-Math.PI/2;innerPad.position.y=0.015;root.add(innerPad);

  const icon=new T.Group();
  icon.position.y=0.58;
  root.add(icon);

  if(pu.type==='chappal'){
   for(const sx of [-0.14,0.14]){
    const sole=new T.Mesh(new T.BoxGeometry(0.18,0.045,0.38),mat('#2ec8f8',0.55));
    sole.position.set(sx,0,sx*0.2);sole.rotation.y=sx*0.4;
    const strap=new T.Mesh(new T.TorusGeometry(0.075,0.018,8,16,Math.PI),mat('#fffdf5',0.4));
    strap.position.set(sx,0.03,sx*0.2-0.03);strap.rotation.set(0.3,sx*0.4,0);
    icon.add(sole,strap);
   }
  }else if(pu.type==='genda'){
   const numFlowers=10;
   for(let i=0;i<numFlowers;i++){
    const a=(i/numFlowers)*Math.PI*2;
    const fl=new T.Mesh(new T.SphereGeometry(0.085,10,8),mat(i%2===0?'#ff9818':'#ffd228',0.6));
    fl.position.set(Math.cos(a)*0.26,Math.sin(a*2)*0.04,Math.sin(a)*0.26);
    icon.add(fl);
   }
   const dome=new T.Mesh(new T.SphereGeometry(0.30,16,12),new T.MeshBasicMaterial({color:'#ffbe38',transparent:true,opacity:0.28,depthWrite:false}));
   icon.add(dome);
  }else if(pu.type==='mirchi'){
   const body=new T.Mesh(new T.ConeGeometry(0.15,0.44,12),mat('#e82818',0.38));
   body.rotation.z=0.35;body.rotation.x=Math.PI;
   const topCap=new T.Mesh(new T.SphereGeometry(0.145,12,10),mat('#e82818',0.38));
   topCap.position.set(-0.07,0.18,0);
   const stem=new T.Mesh(new T.CylinderGeometry(0.025,0.045,0.14,8),mat('#3c9e28',0.6));
   stem.position.set(-0.11,0.28,0);stem.rotation.z=0.45;
   icon.add(body,topCap,stem);
  }else if(pu.type==='banta'){
   const body=new T.Mesh(new T.CylinderGeometry(0.12,0.13,0.32,14),mat('#3cd048',0.25));
   const neck=new T.Mesh(new T.CylinderGeometry(0.06,0.11,0.16,12),mat('#58ea64',0.25));
   neck.position.y=0.22;
   const marble=new T.Mesh(new T.SphereGeometry(0.055,10,8),mat('#c8f8ff',0.15));
   marble.position.y=0.36;
   icon.add(body,neck,marble);
  }else if(pu.type==='judwaa'){
   const b1=new T.Mesh(new T.SphereGeometry(0.15,14,12),mat('#ffd428',0.45));
   b1.position.set(-0.18,0.04,0);
   const b2=new T.Mesh(new T.SphereGeometry(0.15,14,12),mat('#ff9e18',0.45));
   b2.position.set(0.18,0.04,0);
   icon.add(b1,b2);
  }else{
   const skirt=new T.Mesh(new T.ConeGeometry(0.19,0.34,12),mat('#d82868',0.65));
   skirt.position.y=-0.05;
   const headM=new T.Mesh(new T.SphereGeometry(0.11,12,10),mat('#e09862',0.65));
   headM.position.y=0.18;
   const crown=new T.Mesh(new T.CylinderGeometry(0.12,0.10,0.09,10),mat('#ffbe28',0.45));
   crown.position.y=0.27;
   icon.add(skirt,headM,crown);
  }

  const lbl=tag(pu.name.toUpperCase(),pu.color||'#d88820');
  lbl.scale.set(1.45,0.36,1);
  lbl.position.y=1.18;
  root.add(lbl);
  scene.add(root);
  const entry={root,icon,pad,padMat,innerPadMat,lbl,pu};
  powerupVisuals.set(pu.uid,entry);
  return entry;
 }

 function removePowerupVisual(uid){
  const v=powerupVisuals.get(uid);if(!v)return;
  v.padMat?.dispose();v.innerPadMat?.dispose();
  v.lbl.material?.map?.dispose();v.lbl.material?.dispose();
  scene.remove(v.root);
  powerupVisuals.delete(uid);
 }

 // Shared character & decoy builder: ensures 100% identical appearance, materials, cosmetics, rings, shadows, and animations
 function buildCharacterEntry(p,me,isDecoy=false){
  let root=new T.Group();
  root.position.set(p.x,0.21,p.z);
  scene.add(root);
  const lookIdx=Math.max(0,Math.floor(Number(p.look)||0))%8;
  const isGirl=(lookIdx%2)===1;
  const sourceGltf=(isGirl&&girlGltf?.scene)?girlGltf:charGltf;
  let obj=sourceGltf?.scene?SkeletonUtils.clone(sourceGltf.scene):new T.Group();
  obj.rotation.y=Math.atan2(p.ax||0,p.az||-1);
  root.add(obj);
  const clonedMats=[];
   const makeCharMat=(hexCol,rough=0.78)=>{
    const m=(isWebGL1&&T.MeshLambertMaterial)?new T.MeshLambertMaterial({color:hexCol}):new T.MeshStandardMaterial({color:hexCol,roughness:rough,metalness:0});
    m.castShadow=!isWebGL1;
    m.receiveShadow=!isWebGL1;
    clonedMats.push(m);
    return m;
   };
   obj.traverse(m=>{
    if(m.isMesh){
     const mName=m.material?.name||'';
     if(isWebGL1&&T.MeshLambertMaterial){
      const nm=new T.MeshLambertMaterial({color:m.material?.color||'#ffffff'});
      nm.name=mName;
      m.material=nm;
     }else{
      m.material=m.material.clone();
      m.material.roughness=Math.max(m.material.roughness||0.78,0.78);
      m.material.metalness=0;
     }
     clonedMats.push(m.material);
     m.material.color.convertSRGBToLinear();
     m.material.transparent=false;
     m.material.opacity=1;
     if(mName==='Shirt')m.material.color.set(p.team?'#d95f43':'#1f7d77');
     if(mName==='Skin')m.material.color.set(SKIN_TONES[lookIdx]);
     if(mName==='Hair')m.material.color.set(HAIR_TONES[lookIdx]);
     if(mName==='Shorts')m.material.color.set(SHORTS_TONES[lookIdx]);
     if(mName==='Shoe')m.material.color.set(SHOE_TONES[lookIdx]);
     if(mName==='Sole')m.material.color.set(SOLE_TONES[lookIdx]);
     if(mName==='Wristband')m.material.color.set(lookIdx===4?'#f4b828':lookIdx===6?'#2296a0':lookIdx===7?'#d83070':(p.team?'#1f7d77':'#d95f43'));
     if(isWebGL1){
      if(T.FrontSide!==undefined)m.material.side=T.FrontSide;
      const pOff=FACE_POLY_OFFSET[mName];
      if(pOff){
       m.material.polygonOffset=true;
       m.material.polygonOffsetFactor=pOff[0];
       m.material.polygonOffsetUnits=pOff[1];
      }
      m.castShadow=false;
      m.receiveShadow=false;
     }else{
      m.castShadow=true;
      m.receiveShadow=true;
     }
     m.frustumCulled=false;
    }
   });
   // Batch static bone sub-meshes per bone on WebGL 1 using vertex colors to cut draw calls by ~70%
   if(isWebGL1&&obj.children){
    obj.traverse(boneNode=>{
     if(!boneNode.children||boneNode.children.length<2)return;
     const batchable=boneNode.children.filter(ch=>ch.isMesh&&ch.geometry?.attributes?.position&&!ch.geometry.index&&!FACE_POLY_OFFSET[ch.material?.name||'']);
     if(batchable.length<2)return;
     let totalVerts=0;
     for(const bm of batchable)totalVerts+=bm.geometry.attributes.position.count;
     const mergedPos=new Float32Array(totalVerts*3);
     const mergedNorm=new Float32Array(totalVerts*3);
     const mergedCol=new Float32Array(totalVerts*3);
     let offset=0;
     for(const bm of batchable){
      const pAttr=bm.geometry.attributes.position;
      const nAttr=bm.geometry.attributes.normal;
      const col=bm.material?.color||{r:1,g:1,b:1};
      mergedPos.set(pAttr.array,offset*3);
      if(nAttr)mergedNorm.set(nAttr.array,offset*3);
      for(let v=0;v<pAttr.count;v++){
       const ci=(offset+v)*3;
       mergedCol[ci]=col.r;mergedCol[ci+1]=col.g;mergedCol[ci+2]=col.b;
      }
      offset+=pAttr.count;
      boneNode.remove(bm);
      bm.geometry.dispose();
     }
     const bGeo=new T.BufferGeometry();
     bGeo.setAttribute('position',new T.BufferAttribute(mergedPos,3));
     bGeo.setAttribute('normal',new T.BufferAttribute(mergedNorm,3));
     bGeo.setAttribute('color',new T.BufferAttribute(mergedCol,3));
     const bMat=T.MeshLambertMaterial?new T.MeshLambertMaterial({color:0xffffff,vertexColors:true}):new T.MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:0.78,metalness:0});
     if(T.FrontSide!==undefined)bMat.side=T.FrontSide;
     clonedMats.push(bMat);
     const bMesh=new T.Mesh(bGeo,bMat);
     bMesh.castShadow=false;bMesh.receiveShadow=false;bMesh.frustumCulled=false;
     boneNode.add(bMesh);
    });
   }
  if(!sourceGltf?.scene){ball(.35,p.team?'#d95f43':'#1f7d77',0,.7,0,obj);ball(.29,'#c4784c',0,1.25,0,obj);}
  const mixer=sourceGltf?.animations?.length?new T.AnimationMixer(obj):null;
  const actions={};
  if(mixer){
   for(const clip of sourceGltf.animations){
    const act=mixer.clipAction(clip);
    if(['Throw','Place','Out'].includes(clip.name)){
     act.setLoop(T.LoopOnce,1);
     act.clampWhenFinished=true;
    }
    actions[clip.name]=act;
   }
   for(const loco of ['Idle','Run','Carry','Aim']){
    if(actions[loco]){
     actions[loco].enabled=true;
     actions[loco].setEffectiveWeight(loco==='Idle'?1:0);
     actions[loco].play();
    }
   }
  }
  const handR=obj.getObjectByName('HandR')||obj.getObjectByName('Hand.R')||null;
  const handL=obj.getObjectByName('HandL')||obj.getObjectByName('Hand.L')||null;
  const upperArmR=obj.getObjectByName('UpperArmR')||null;
  const forearmR=obj.getObjectByName('ForearmR')||null;
  const upperArmL=obj.getObjectByName('UpperArmL')||null;
  const forearmL=obj.getObjectByName('ForearmL')||null;
  const hips=obj.getObjectByName('Hips')||null;
  const spine=obj.getObjectByName('Spine')||null;
  const chest=obj.getObjectByName('Chest')||null;
  const head=obj.getObjectByName('Head')||null;
  const thighL=obj.getObjectByName('ThighL')||null;
  const shinL=obj.getObjectByName('ShinL')||null;
  const footL=obj.getObjectByName('FootL')||null;
  const thighR=obj.getObjectByName('ThighR')||null;
  const shinR=obj.getObjectByName('ShinR')||null;
  const footR=obj.getObjectByName('FootR')||null;

  // Attach unique 3D character cosmetics/headgear per lookIdx (0..5) so all 6 characters are visually distinct on the field!
  if(head){
   const accGroup=new T.Group();
   head.add(accGroup);
   if(lookIdx===1){
    // Look 1 (Tara): Round Tortoiseshell Glasses + High Ponytail Scrunchie
    const frameMat=makeCharMat('#4a2816',0.45);
    for(const sx of [-0.084,0.084]){
     const rim=new T.Mesh(new T.TorusGeometry(0.054,0.009,8,20),frameMat);
     rim.position.set(sx,0.26,0.222);
     accGroup.add(rim);
    }
    const bridge=new T.Mesh(new T.BoxGeometry(0.056,0.013,0.013),frameMat);
    bridge.position.set(0,0.268,0.226);
    const scrunchMat=makeCharMat(p.team?'#ff6e4a':'#28b8a8',0.65);
    const scrunch=new T.Mesh(new T.TorusGeometry(0.082,0.028,8,16),scrunchMat);
    scrunch.position.set(0,0.44,-0.12);scrunch.rotation.x=0.55;
    accGroup.add(bridge,scrunch);
   }else if(lookIdx===2){
    // Look 2 (Kabir): Sculpted 3D Tight Curly Hair Halo + Dual Wristbands
    const curlMat=makeCharMat(HAIR_TONES[2],0.75);
    const curlPts=[
     [0,0.49,0.08,0.095],[-0.10,0.47,0.07,0.088],[0.10,0.47,0.07,0.088],
     [-0.17,0.41,0.03,0.085],[0.17,0.41,0.03,0.085],[0,0.52,-0.02,0.10],
     [-0.12,0.50,-0.04,0.092],[0.12,0.50,-0.04,0.092],[-0.19,0.35,-0.04,0.082],
     [0.19,0.35,-0.04,0.082],[0,0.48,-0.14,0.095],[-0.11,0.44,-0.14,0.088],
     [0.11,0.44,-0.14,0.088],[0,0.43,0.15,0.078],[-0.08,0.42,0.14,0.074],[0.08,0.42,0.14,0.074]
    ];
    for(const [cx,cy,cz,cr] of curlPts){
     const cMesh=new T.Mesh(new T.SphereGeometry(cr,10,8),curlMat);
     cMesh.position.set(cx,cy,cz);
     accGroup.add(cMesh);
    }
    if(forearmR){
     const wbR=new T.Mesh(new T.CylinderGeometry(0.052,0.048,0.055,12),makeCharMat(p.team?'#1f7d77':'#d95f43',0.65));
     wbR.position.set(-0.07,-0.12,0.02);wbR.rotation.z=-0.42;
     forearmR.add(wbR);
    }
   }else if(lookIdx===3){
    // Look 3 (Mira): High Top-Knot Bun + Cream & Gold Sporty Sun Visor + Backpack Straps
    const bunMat=makeCharMat(HAIR_TONES[3],0.72);
    const bun=new T.Mesh(new T.SphereGeometry(0.135,12,10),bunMat);
    bun.position.set(0,0.54,-0.02);
    const bandMat=makeCharMat('#f6eedc',0.55);
    const visorBand=new T.Mesh(new T.CylinderGeometry(0.246,0.242,0.068,20),bandMat);
    visorBand.position.set(0,0.35,0.015);visorBand.rotation.x=-0.08;
    const brimMat=makeCharMat('#e8a828',0.48);
    const visorBrim=new T.Mesh(new T.CylinderGeometry(0.265,0.265,0.024,20,1,false,-Math.PI*0.38,Math.PI*0.76),brimMat);
    visorBrim.position.set(0,0.325,0.09);visorBrim.rotation.x=0.18;
    accGroup.add(bun,visorBand,visorBrim);
    if(chest){
     const strapMat=makeCharMat('#2c3540',0.8);
     for(const sx of [-0.115,0.115]){
      const st=new T.Mesh(new T.BoxGeometry(0.038,0.26,0.25),strapMat);
      st.position.set(sx,0.05,0);
      chest.add(st);
     }
    }
   }else if(lookIdx===4){
    // Look 4 (Aadi): Golden-Yellow Athletic Sweatband + Trailing Knot + Spiky Hair Tufts
    const hbMat=makeCharMat('#f4b828',0.55);
    const hBand=new T.Mesh(new T.CylinderGeometry(0.248,0.244,0.076,22),hbMat);
    hBand.position.set(0,0.34,0.012);hBand.rotation.x=-0.05;
    const knot=new T.Mesh(new T.SphereGeometry(0.044,8,8),hbMat);
    knot.position.set(0,0.32,-0.24);
    accGroup.add(hBand,knot);
   }else if(lookIdx===5){
    // Look 5 (Nila): Twin Shoulder Braids + Bright Orange-Gold Marigold Flower Behind Ear
    const braidMat=makeCharMat(HAIR_TONES[5],0.72);
    for(const side of [-1,1]){
     for(let k=0;k<4;k++){
      const bs=new T.Mesh(new T.SphereGeometry(0.058-k*0.005,8,8),braidMat);
      bs.position.set(side*0.185,0.16-k*0.062,0.03+k*0.016);
      accGroup.add(bs);
     }
    }
    const flCenter=new T.Mesh(new T.SphereGeometry(0.046,8,8),makeCharMat('#ff7210',0.55));
    flCenter.position.set(0.225,0.29,0.055);
    accGroup.add(flCenter);
    const petalMat=makeCharMat('#ffbe18',0.55);
    for(let k=0;k<6;k++){
     const ang=(k/6)*Math.PI*2;
     const pt=new T.Mesh(new T.SphereGeometry(0.036,8,6),petalMat);
     pt.position.set(0.23,0.29+Math.sin(ang)*0.055,0.055+Math.cos(ang)*0.055);
     accGroup.add(pt);
    }
   }else if(lookIdx===6){
    // Look 6 (Dev): Forward Sports Cap + Curved Dark Brim + Gold-Rimmed Aviator Shades
    const capCol=p.team?'#e8762a':'#2296a0';
    const capMat=makeCharMat(capCol,0.52);
    const capDome=new T.Mesh(new T.SphereGeometry(0.252,18,12,0,Math.PI*2,0,Math.PI*0.55),capMat);
    capDome.position.set(0,0.32,0.0);
    const brimMat=makeCharMat('#24303a',0.48);
    const capBrim=new T.Mesh(new T.CylinderGeometry(0.268,0.268,0.024,20,1,false,-Math.PI*0.38,Math.PI*0.76),brimMat);
    capBrim.position.set(0,0.335,0.095);capBrim.rotation.x=0.16;
    const badgeMat=makeCharMat('#fff6e0',0.4);
    const badge=new T.Mesh(new T.SphereGeometry(0.038,10,8),badgeMat);
    badge.position.set(0,0.41,0.225);
    const shadeMat=makeCharMat('#1a2630',0.25);
    const goldMat=makeCharMat('#f4c440',0.35);
    for(const sx of [-0.084,0.084]){
     const lens=new T.Mesh(new T.BoxGeometry(0.092,0.058,0.018),shadeMat);
     lens.position.set(sx,0.258,0.222);
     const rim=new T.Mesh(new T.BoxGeometry(0.10,0.066,0.014),goldMat);
     rim.position.set(sx,0.258,0.219);
     accGroup.add(lens,rim);
    }
    const bar=new T.Mesh(new T.BoxGeometry(0.056,0.012,0.014),goldMat);
    bar.position.set(0,0.272,0.224);
    accGroup.add(capDome,capBrim,badge,bar);
   }else if(lookIdx===7){
    // Look 7 (Zoya): Festive Magenta-Gold Bandana + Twin Space Buns + Gold Hoop Earrings
    const bunMat=makeCharMat(HAIR_TONES[7],0.7);
    const wrapMat=makeCharMat('#d83070',0.52);
    const goldMat=makeCharMat('#fac630',0.38);
    for(const sx of [-0.175,0.175]){
     const sBun=new T.Mesh(new T.SphereGeometry(0.105,12,10),bunMat);
     sBun.position.set(sx,0.49,-0.02);
     const sWrap=new T.Mesh(new T.TorusGeometry(0.078,0.022,8,16),wrapMat);
     sWrap.position.set(sx,0.45,-0.02);sWrap.rotation.x=0.45;sWrap.rotation.y=sx*0.8;
     accGroup.add(sBun,sWrap);
    }
    const band=new T.Mesh(new T.CylinderGeometry(0.248,0.244,0.068,20),wrapMat);
    band.position.set(0,0.345,0.012);band.rotation.x=-0.06;
    const gem=new T.Mesh(new T.SphereGeometry(0.032,8,8),goldMat);
    gem.position.set(0,0.345,0.242);
    accGroup.add(band,gem);
    for(const sx of [-0.23,0.23]){
     const hoop=new T.Mesh(new T.TorusGeometry(0.042,0.008,8,16),goldMat);
     hoop.position.set(sx,0.18,0.01);hoop.rotation.y=Math.PI*0.5;
     accGroup.add(hoop);
    }
   }
  }

  // Decoy matches the owner's display label and team badge color so defenders see zero visual difference
  const isLocalOwner=(!isDecoy&&p.id===me)||(isDecoy&&p.ownerId===me);
  const baseName=isLocalOwner?'YOU':p.name;
  const label=tag(baseName,p.team?'#c85a42':'#1f726b');root.add(label);
  const outLabel=isDecoy?null:tag(`${baseName} · OUT`,'#5a4c44');
  if(outLabel){outLabel.visible=false;root.add(outLabel);}
  const baseRingHex=isLocalOwner?'#fff9df':(p.team?'#e26d52':'#28a89c');
  const baseRingColor=new T.Color(baseRingHex);
  let rMat=new T.MeshBasicMaterial({color:baseRingHex,transparent:true,opacity:0.92,side:T.DoubleSide});
  let r=new T.Mesh(footRingGeo,rMat);r.position.set(0,.03,0);r.rotation.x=-Math.PI/2;root.add(r);
  let pShadowMat=new T.MeshBasicMaterial({map:playerShadowTex,transparent:true,depthWrite:false,opacity:0.64});
  let pShadow=new T.Mesh(pShadowGeo,pShadowMat);pShadow.position.set(0,.018,0);pShadow.rotation.x=-Math.PI/2;root.add(pShadow);

  // Active Power-Up Aura Visuals attached to character root
  const auraGroup=new T.Group();
  auraGroup.visible=false;
  const auraRingMat=new T.MeshBasicMaterial({color:'#ffe066',transparent:true,opacity:0.85,side:T.DoubleSide,depthWrite:false});
  const auraRing=new T.Mesh(auraRingGeo,auraRingMat);
  auraRing.rotation.x=-Math.PI/2;auraRing.position.y=0.04;
  const shieldDomeMat=new T.MeshBasicMaterial({color:'#ffaa28',transparent:true,opacity:0.24,depthWrite:false});
  const shieldDome=new T.Mesh(shieldDomeGeo,shieldDomeMat);
  shieldDome.position.y=0.95;shieldDome.visible=false;
  auraGroup.add(auraRing,shieldDome);
  root.add(auraGroup);

  let decoyStoneMesh=null;
  if(isDecoy){
   decoyStoneMesh=new T.Mesh(decoyStoneGeo,mat(stonePalette[0]));
   decoyStoneMesh.visible=false;
   root.add(decoyStoneMesh);
  }

  return{
   root,obj,label,outLabel,r,rMat,baseRingColor,baseRingHex,pShadow,pShadowMat,
   auraGroup,auraRing,auraRingMat,shieldDome,shieldDomeMat,decoyStoneMesh,
   mixer,actions,
   activeOneShot:null,wIdle:1,wRun:0,wCarry:0,wAim:0,
   hips,spine,chest,head,upperArmL,forearmL,handL,upperArmR,forearmR,handR,thighL,shinL,footL,thighR,shinR,footR,
   clonedMats,isGirl,look:lookIdx,team:p.team,isDecoy,
   prevX:p.x,prevZ:p.z,smoothSpeed:0,turnLean:0,pitchLean:0,pivotDip:0,headYaw:0
  };
 }

 function addPlayer(p,me){
  const entry=buildCharacterEntry(p,me,false);
  players.set(p.id,entry);
  return entry;
 }

 function disposeCharacterEntry(v){
  if(!v)return;
  if(v.mixer){v.mixer.stopAllAction();v.mixer.uncacheRoot(v.obj);}
  for(const m of v.clonedMats)m.dispose();
  v.label?.material?.map?.dispose();v.label?.material?.dispose();
  v.outLabel?.material?.map?.dispose();v.outLabel?.material?.dispose();
  v.rMat?.dispose();v.pShadowMat?.dispose();
  v.auraRingMat?.dispose();v.shieldDomeMat?.dispose();
  scene.remove(v.root);
 }

 function removePlayer(id){
  const v=players.get(id);if(!v)return;
  disposeCharacterEntry(v);
  players.delete(id);
 }

 const tmpEuler=new T.Euler();
 const tmpQuat=new T.Quaternion();
 const tmpTargetPos=new T.Vector3();
 function applyBoneOffset(bone,rx,ry,rz){
  if(!bone)return;
  tmpEuler.set(rx,ry,rz,'XYZ');
  tmpQuat.setFromEuler(tmpEuler);
  bone.quaternion.multiply(tmpQuat);
 }

 function updatePlayerAnimation(v,p,g,dt,time){
  if(!v.mixer)return;
  const wonRound=(g.phase==='result'&&g.outcome?.winner===p.team)||(g.phase==='match'&&g.scores[p.team]>g.scores[1-p.team]);
  const oneShot=!p.alive?'Out':wonRound?'Celebrate':(p.place||0)>0?'Place':(p.anim||0)>0?'Throw':null;

  if(oneShot!==v.activeOneShot){
   if(v.activeOneShot&&v.actions[v.activeOneShot]){
    v.actions[v.activeOneShot].fadeOut(oneShot==='Throw'?0.05:0.14);
   }
   if(oneShot&&v.actions[oneShot]){
    const act=v.actions[oneShot];
    act.reset();
    act.enabled=true;
    act.setEffectiveWeight(1);
    if(oneShot==='Throw')act.setDuration(0.38);
    if(oneShot==='Place')act.setDuration(0.65);
    act.fadeIn(oneShot==='Throw'?0.045:0.12).play();
   }
   v.activeOneShot=oneShot;
  }

  const throwBlendOut=(oneShot==='Throw'&&p.anim<0.13)?clamp(1-p.anim/0.13,0,1):0;
  const locoMask=oneShot?(oneShot==='Throw'?throwBlendOut:0):1;

  const moveT=clamp((v.smoothSpeed-0.025)/0.72,0,1);
  const smoothMove=moveT*moveT*(3-2*moveT);
  const isHoldingBall=g.ball.holder===p.id&&!oneShot;
  const isCarryingStone=p.carry!==null&&p.carry!==undefined&&!isHoldingBall;

  const targetAim=isHoldingBall?locoMask:0;
  const targetCarry=(!isHoldingBall&&isCarryingStone)?locoMask*clamp(0.35+smoothMove*0.65,0,1):0;
  const targetRun=(!isHoldingBall&&!isCarryingStone)?locoMask*smoothMove:0;
  const targetIdle=Math.max(0,locoMask-targetAim-targetCarry-targetRun);

  const blendRate=Math.min(1,dt*(oneShot==='Throw'?18:13));
  v.wIdle+=(targetIdle-v.wIdle)*blendRate;
  v.wRun+=(targetRun-v.wRun)*blendRate;
  v.wCarry+=(targetCarry-v.wCarry)*blendRate;
  v.wAim+=(targetAim-v.wAim)*blendRate;

  if(v.actions.Idle)v.actions.Idle.setEffectiveWeight(v.wIdle);
  if(v.actions.Run){
   v.actions.Run.setEffectiveWeight(v.wRun);
   v.actions.Run.timeScale=clamp(0.58+v.smoothSpeed*0.78,0.58,1.38);
  }
  if(v.actions.Carry){
   v.actions.Carry.setEffectiveWeight(v.wCarry);
   v.actions.Carry.timeScale=v.smoothSpeed<0.04?0.25:clamp(0.56+v.smoothSpeed*0.76,0.56,1.34);
  }
  if(v.actions.Aim)v.actions.Aim.setEffectiveWeight(v.wAim);

  v.mixer.update(dt);

  if(isHoldingBall&&(p.charge||0)>0.01){
   const c=clamp(p.charge||0,0,1);
   const easeC=c*c*(3-2*c);
   const pulse=c>=0.98?Math.sin(time*20)*0.018:0;
   applyBoneOffset(v.spine,-easeC*0.03,-easeC*0.05,0);
   applyBoneOffset(v.chest,-easeC*0.04,-easeC*0.07-pulse,0);
   applyBoneOffset(v.head,easeC*0.05,easeC*0.11,0);
   applyBoneOffset(v.upperArmR,-easeC*0.14,-easeC*0.08,-easeC*0.12+pulse);
   applyBoneOffset(v.forearmR,-easeC*0.14,0,0);
   applyBoneOffset(v.upperArmL,-easeC*0.12,0,easeC*0.08);
  }
  if(p.alive&&!isHoldingBall&&oneShot!=='Throw'&&Math.abs(v.headYaw)>0.005){
   applyBoneOffset(v.head,0,clamp(v.headYaw,-0.28,0.28),0);
   applyBoneOffset(v.chest,0,clamp(v.headYaw*0.35,-0.12,0.12),0);
  }
 }

 function stepCharacterLocomotion(v,p,g,dt,time,isLocal){
  const prevX=v.root.position.x,prevZ=v.root.position.z;
  // v3: remote players in online mode are already interpolated per frame
  // (sampleRenderState) — their render-copy player carries _interp, so
  // the visual root is set directly (posBlend 1) instead of lerping a
  // second time on top of the interpolation (the old dt*22 lerp added
  // ~50ms of lag and drift). The local player keeps the fast dt*48
  // lerp: it smooths the 20 Hz prediction steps into 60 fps motion.
  const posBlend=p._interp?1:(isLocal?Math.min(1,dt*48):Math.min(1,dt*22));
  tmpTargetPos.set(p.x,.21,p.z);
  v.root.position.lerp(tmpTargetPos,posBlend);
  const stepDist=Math.hypot(v.root.position.x-prevX,v.root.position.z-prevZ);
  const instSpeed=dt>0.0005?clamp(stepDist/(dt*4.5),0,1.25):0;
  const cmdMove=p.alive&&g.phase==='chase'&&g.ball.holder!==p.id&&!p.charging&&(p.anim||0)<=0&&(p.stun||0)<=0?Math.hypot(p.mx||0,p.mz||0):0;
  const rawMove=g.phase==='opening'||g.ball.holder===p.id||p.charging?0:Math.max(instSpeed,cmdMove);
  v.smoothSpeed+=(rawMove-v.smoothSpeed)*Math.min(1,dt*15);

  let angle=Math.atan2(p.ax||0,p.az||-1);
  let delta=Math.atan2(Math.sin(angle-v.obj.rotation.y),Math.cos(angle-v.obj.rotation.y));
  const turnRate=g.ball.holder===p.id||(p.anim||0)>0?22:16;
  v.obj.rotation.y+=delta*Math.min(1,dt*turnRate);
  v.headYaw+=(delta*0.65-v.headYaw)*Math.min(1,dt*14);

  const targetBank=p.alive?clamp(-delta*v.smoothSpeed*0.36,-0.14,0.14):0;
  const targetPitch=p.alive&&g.ball.holder!==p.id&&(p.anim||0)<=0?clamp(v.smoothSpeed*0.085,0,0.095):0;
  const cutSeverity=p.alive&&v.smoothSpeed>0.22?clamp((Math.abs(delta)-0.35)*0.045,0,0.048):0;
  v.turnLean+=(targetBank-v.turnLean)*Math.min(1,dt*12);
  v.pitchLean+=(targetPitch-v.pitchLean)*Math.min(1,dt*12);
  v.pivotDip+=(cutSeverity-v.pivotDip)*Math.min(1,dt*15);

  if((p.stun||0)>0){
   v.obj.position.y=Math.abs(Math.sin(time*24))*0.18;
   v.obj.rotation.z=Math.sin(time*28)*0.22;
   v.obj.rotation.x=-0.16;
  }else{
   v.obj.rotation.z=v.turnLean;
   v.obj.rotation.x=v.pitchLean;
   v.obj.position.y=-v.pivotDip;
  }

  if(p.alive&&p.buff&&(p.buffTime||0)>0){
   const expiring=p.buffTime<1.5;
   const blinkVisible=!expiring||Math.sin(time*28)>-0.25;
   v.auraGroup.visible=blinkVisible;
   v.auraRingMat.color.copy(BUFF_COLORS[p.buff]||BUFF_COLORS.kathputli);
   const aScale=p.buff==='mirchi'?2.2+Math.sin(time*12)*0.18:1.05+Math.sin(time*10)*0.08;
   v.auraRing.scale.set(aScale,aScale,1);
   v.shieldDome.visible=p.buff==='genda';
  }else{
   v.auraGroup.visible=false;
   v.shieldDome.visible=false;
  }

  v.label.visible=p.alive;
  if(v.outLabel)v.outLabel.visible=!p.alive;
  v.r.visible=true;
  if(v.rMat){
   v.rMat.color.copy(p.inTowerZone?COL_TOWER_RING:v.baseRingColor);
   v.rMat.opacity=p.alive?0.92:0.35;
  }
  v.lastPlayerState=p;
  updatePlayerAnimation(v,p,g,dt,time);
 }

 // True-3D Canvas3DRenderer for desktops where WebGL context creation is blocked (e.g. Intel 965GM OpenGL ES 2.0 sandbox)
 // Renders the exact THREE.Scene, OrthographicCamera, pre-baked 3D GLB planters/goalposts, 3D stones/balls/powerups,
 // 17-bone AnimationMixer-driven 3D Boy & Girl characters, and 3D overhead tree canopy with zero console errors!
 function createCanvas3DRenderer(){
  const domElement=document.createElement('canvas');
  const ctx=domElement.getContext('2d');
  let dpr=1,cssW=800,cssH=600,vpW=800,vpH=600;
  const vpMat=new T.Matrix4();
  const bPos=new T.Vector3();

  function proj(wx,wy,wz){
   const e=vpMat.elements;
   const nx=e[0]*wx+e[4]*wy+e[8]*wz+e[12];
   const ny=e[1]*wx+e[5]*wy+e[9]*wz+e[13];
   return{
    x:(nx*0.5+0.5)*vpW,
    y:(-ny*0.5+0.5)*vpH,
    depth:wy*0.77065+wz*0.63726
   };
  }

  function boneWorld(bone,ox=0,oy=0,oz=0){
   if(!bone)return{x:0,y:0,z:0};
   bPos.set(ox,oy,oz).applyMatrix4(bone.matrixWorld);
   return{x:bPos.x,y:bPos.y,z:bPos.z};
  }

  function drawGroundRing(wx,wy,wz,rInner,rOuter,color,alpha,pxX,pxZ,dashed=false,rotOffset=0){
   if(alpha<=0.01)return;
   const p=proj(wx,wy,wz);
   const rMid=(rInner+rOuter)*0.5;
   const lw=Math.max(1.5,(rOuter-rInner)*(pxX+pxZ)*0.5);
   ctx.save();
   ctx.globalAlpha=clamp(alpha,0,1);
   ctx.strokeStyle=color;
   ctx.lineWidth=lw;
   if(dashed){
    const perim=Math.PI*2*rMid*((pxX+pxZ)*0.5);
    const dashLen=Math.max(5,perim/36);
    ctx.setLineDash([dashLen,dashLen*0.68]);
    ctx.lineDashOffset=-rotOffset*40;
   }
   ctx.beginPath();
   ctx.ellipse(p.x,p.y,Math.max(1,rMid*pxX),Math.max(1,rMid*pxZ),0,0,Math.PI*2);
   ctx.stroke();
   ctx.restore();
  }

  function drawGroundDisc(wx,wy,wz,rInner,rOuter,color,alpha,pxX,pxZ){
   if(alpha<=0.01)return;
   const p=proj(wx,wy,wz);
   ctx.save();
   ctx.globalAlpha=clamp(alpha,0,1);
   ctx.fillStyle=color;
   ctx.beginPath();
   ctx.ellipse(p.x,p.y,Math.max(1,rOuter*pxX),Math.max(1,rOuter*pxZ),0,0,Math.PI*2);
   if(rInner>0.02){
    ctx.ellipse(p.x,p.y,Math.max(1,rInner*pxX),Math.max(1,rInner*pxZ),0,0,Math.PI*2,true);
   }
   ctx.fill('evenodd');
   ctx.restore();
  }

  function drawSoftShadow(wx,wy,wz,rxM,rzM,alpha,pxX,pxZ){
   if(alpha<=0.01)return;
   const p=proj(wx,wy,wz);
   const rx=Math.max(2,rxM*pxX),rz=Math.max(2,rzM*pxZ);
   ctx.save();
   ctx.translate(p.x,p.y);
   ctx.scale(1,rz/rx);
   const g=ctx.createRadialGradient(0,0,rx*0.08,0,0,rx);
   g.addColorStop(0,`rgba(42,24,11,${(alpha*0.62).toFixed(3)})`);
   g.addColorStop(0.58,`rgba(48,28,14,${(alpha*0.28).toFixed(3)})`);
   g.addColorStop(1,'rgba(48,28,14,0)');
   ctx.fillStyle=g;
   ctx.beginPath();ctx.arc(0,0,rx,0,Math.PI*2);ctx.fill();
   ctx.restore();
  }

  function drawCapsule2D(p0,p1,r0Px,r1Px,fillCol,outlineCol){
   const dx=p1.x-p0.x,dy=p1.y-p0.y,len=Math.hypot(dx,dy);
   const rAvg=(r0Px+r1Px)*0.5;
   if(len<0.5){
    ctx.fillStyle=fillCol;
    ctx.beginPath();ctx.arc(p0.x,p0.y,Math.max(1.5,rAvg),0,Math.PI*2);ctx.fill();
    return;
   }
   const nx=-dy/len,ny=dx/len;
   const ang=Math.atan2(dy,dx);
   ctx.beginPath();
   ctx.arc(p0.x,p0.y,Math.max(1,r0Px),ang+Math.PI*0.5,ang+Math.PI*1.5);
   ctx.lineTo(p1.x+nx*r1Px,p1.y+ny*r1Px);
   ctx.arc(p1.x,p1.y,Math.max(1,r1Px),ang-Math.PI*0.5,ang+Math.PI*0.5);
   ctx.closePath();
   // 3D cylindrical directional gradient across the limb
   const grad=ctx.createLinearGradient(p0.x-nx*rAvg,p0.y-ny*rAvg,p0.x+nx*rAvg,p0.y+ny*rAvg);
   grad.addColorStop(0,shadeHex(fillCol,1.12,8));
   grad.addColorStop(0.55,fillCol);
   grad.addColorStop(1,shadeHex(fillCol,0.78,-4));
   ctx.fillStyle=grad;
   ctx.fill();
   if(outlineCol){
    ctx.strokeStyle=outlineCol;
    ctx.lineWidth=Math.max(0.8,rAvg*0.14);
    ctx.stroke();
   }
  }

  function draw3DStone(m,pxX,pxY,pxZ){
   if(!m.visible)return;
   const wx=m.position.x,wy=m.position.y,wz=m.position.z;
   const rTop=m.userData?.rTop||0.34,rBot=m.userData?.rBot||0.38;
   const col=m.userData?.col||'#626962';
   const h=0.135;
   const pTop=proj(wx,wy+h*0.5,wz);
   const pBot=proj(wx,wy-h*0.5,wz);
   const rxT=rTop*pxX,rzT=rTop*pxZ;
   const rxB=rBot*pxX,rzB=rBot*pxZ;
   ctx.save();
   // Extruded cylinder side wall
   ctx.fillStyle=shadeHex(col,0.72,-6);
   ctx.strokeStyle='#2c231c';
   ctx.lineWidth=Math.max(1,pxX*0.025);
   ctx.beginPath();
   ctx.ellipse(pBot.x,pBot.y,rxB,rzB,0,0,Math.PI);
   ctx.lineTo(pTop.x-rxT,pTop.y);
   ctx.ellipse(pTop.x,pTop.y,rxT,rzT,0,Math.PI,0,true);
   ctx.closePath();
   ctx.fill();ctx.stroke();
   // Sunlit beveled top face
   const g=ctx.createLinearGradient(pTop.x-rxT,pTop.y-rzT,pTop.x+rxT,pTop.y+rzT);
   g.addColorStop(0,shadeHex(col,1.18,12));
   g.addColorStop(0.6,col);
   g.addColorStop(1,shadeHex(col,0.86,-4));
   ctx.fillStyle=g;
   ctx.beginPath();
   ctx.ellipse(pTop.x,pTop.y,rxT,rzT,0,0,Math.PI*2);
   ctx.fill();ctx.stroke();
   // Subtle inner stone ring highlight
   ctx.strokeStyle='rgba(255,250,235,0.25)';
   ctx.lineWidth=Math.max(0.8,pxX*0.018);
   ctx.beginPath();
   ctx.ellipse(pTop.x,pTop.y,rxT*0.72,rzT*0.72,0,0,Math.PI*2);
   ctx.stroke();
   ctx.restore();
  }

  function draw3DBall(meshObj,radiusM,baseHex,pxX){
   if(!meshObj.visible)return;
   const p=proj(meshObj.position.x,meshObj.position.y,meshObj.position.z);
   const r=Math.max(3,radiusM*pxX);
   ctx.save();
   const g=ctx.createRadialGradient(p.x-r*0.32,p.y-r*0.35,r*0.08,p.x,p.y,r);
   g.addColorStop(0,'#fffbe6');
   g.addColorStop(0.35,shadeHex(baseHex,1.08,10));
   g.addColorStop(0.78,baseHex);
   g.addColorStop(1,shadeHex(baseHex,0.68,-10));
   ctx.fillStyle=g;
   ctx.strokeStyle='#3a2412';
   ctx.lineWidth=Math.max(1,r*0.12);
   ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();ctx.stroke();
   ctx.restore();
  }

  function draw3DPowerup(pv,pxX,pxZ){
   const pu=pv.pu;if(!pu)return;
   const wx=pv.root.position.x,wy=pv.root.position.y,wz=pv.root.position.z;
   const scale=pv.root.scale.x||1;
   const padScale=pv.pad.scale.x||1;
   drawGroundDisc(wx,wy+0.015,wz,0,0.40*padScale*scale,pu.color||'#ffe066',0.22,pxX,pxZ);
   drawGroundRing(wx,wy+0.02,wz,0.42*padScale*scale,0.56*padScale*scale,pu.color||'#ffe066',0.85,pxX,pxZ);
   const iy=wy+pv.icon.position.y*scale;
   const pc=proj(wx,iy,wz);
   const r=0.28*scale*pxX;
   ctx.save();
   ctx.translate(pc.x,pc.y);
   const rot=pv.icon.rotation.y||0;
   if(pu.type==='chappal'){
    for(const s of [-1,1]){
     ctx.save();
     ctx.translate(s*r*0.42,s*r*0.12);
     ctx.rotate(s*0.32+Math.sin(rot)*0.18);
     ctx.fillStyle='#2ec8f8';ctx.strokeStyle='#154e68';ctx.lineWidth=1.5;
     ctx.beginPath();ctx.ellipse(0,0,r*0.36,r*0.64,0,0,Math.PI*2);ctx.fill();ctx.stroke();
     ctx.strokeStyle='#fffdf5';ctx.lineWidth=2.2;
     ctx.beginPath();ctx.arc(0,-r*0.08,r*0.26,Math.PI*1.1,Math.PI*1.9);ctx.stroke();
     ctx.restore();
    }
   }else if(pu.type==='genda'){
    ctx.fillStyle='rgba(255,190,56,0.28)';
    ctx.beginPath();ctx.arc(0,0,r*1.05,0,Math.PI*2);ctx.fill();
    for(let i=0;i<10;i++){
     const a=rot+(i/10)*Math.PI*2;
     const fx=Math.cos(a)*r*0.86,fy=Math.sin(a)*r*0.56;
     ctx.fillStyle=i%2===0?'#ff9818':'#ffd228';
     ctx.beginPath();ctx.arc(fx,fy,r*0.28,0,Math.PI*2);ctx.fill();
    }
   }else if(pu.type==='mirchi'){
    ctx.rotate(0.35+Math.sin(rot)*0.15);
    ctx.fillStyle='#e82818';ctx.strokeStyle='#5a110a';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.moveTo(-r*0.25,-r*0.65);ctx.quadraticCurveTo(r*0.45,0,0,r*0.85);ctx.quadraticCurveTo(-r*0.55,0,-r*0.25,-r*0.65);ctx.fill();ctx.stroke();
    ctx.strokeStyle='#3c9e28';ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(-r*0.18,-r*0.62);ctx.lineTo(-r*0.38,-r*0.98);ctx.stroke();
   }else if(pu.type==='banta'){
    ctx.fillStyle='#3cd048';ctx.strokeStyle='#17521d';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.roundRect(-r*0.42,-r*0.45,r*0.84,r*1.05,r*0.25);ctx.fill();ctx.stroke();
    ctx.fillStyle='#c8f8ff';
    ctx.beginPath();ctx.arc(0,-r*0.62,r*0.22,0,Math.PI*2);ctx.fill();
   }else if(pu.type==='judwaa'){
    for(const s of [-1,1]){
     const bx=Math.cos(rot+s*1.5)*r*0.55,by=Math.sin(rot+s*1.5)*r*0.28;
     ctx.fillStyle=s<0?'#ffd428':'#ff9e18';ctx.strokeStyle='#4a2c0a';ctx.lineWidth=1.4;
     ctx.beginPath();ctx.arc(bx,by,r*0.48,0,Math.PI*2);ctx.fill();ctx.stroke();
    }
   }else{
    ctx.fillStyle='#d82868';ctx.strokeStyle='#4a1025';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.moveTo(0,-r*0.25);ctx.lineTo(r*0.68,r*0.75);ctx.lineTo(-r*0.68,r*0.75);ctx.closePath();ctx.fill();ctx.stroke();
    ctx.fillStyle='#e09862';ctx.beginPath();ctx.arc(0,-r*0.45,r*0.36,0,Math.PI*2);ctx.fill();ctx.stroke();
    ctx.fillStyle='#ffbe28';ctx.fillRect(-r*0.34,-r*0.88,r*0.68,r*0.24);
   }
   ctx.restore();
   if(pv.lbl?.userData?.canvas){
    const lp=proj(wx,wy+1.18*scale,wz);
    const lw=1.45*pxX,lh=0.36*pxX;
    ctx.drawImage(pv.lbl.userData.canvas,lp.x-lw*0.5,lp.y-lh*0.5,lw,lh);
   }
  }

  // Render 17-bone articulated 3D Boy & Girl character from live THREE.AnimationMixer bone matrices!
  function draw3DCharacter(v,pxX,pxZ){
   const pState=v.lastPlayerState;
   v.root.updateWorldMatrix(true,true);
   const wx=v.root.position.x,wy=v.root.position.y,wz=v.root.position.z;

   // 1. Foot ring & active power-up aura ring
   const ringCol=pState?.inTowerZone?'#ff7828':v.baseRingHex;
   drawGroundRing(wx,wy+0.02,wz,0.44,0.54,ringCol,pState?.alive===false?0.35:0.92,pxX,pxZ);
   if(v.auraGroup.visible){
    const aScale=v.auraRing.scale.x||1;
    const aHex='#'+v.auraRingMat.color.getHexString();
    drawGroundRing(wx,wy+0.03,wz,0.56*aScale,0.72*aScale,aHex,0.85,pxX,pxZ);
   }

   const shirtCol=v.team?'#d95f43':'#1f7d77';
   const wristCol=v.look===4?'#f4b828':(v.team?'#1f7d77':'#d95f43');
   const skinCol=SKIN_TONES[v.look]||SKIN_TONES[0];
   const hairCol=HAIR_TONES[v.look]||HAIR_TONES[0];
   const shortsCol=SHORTS_TONES[v.look]||'#2a3950';
   const shoeCol=SHOE_TONES[v.look]||'#f3e9d7';
   const soleCol=SOLE_TONES[v.look]||'#c86d46';
   const creamCol='#f5ebd6';
   const outline=null;

   // Sample live 3D bone world positions driven by THREE.AnimationMixer
   const wHips=boneWorld(v.hips,0,0,0);
   const wSpine=boneWorld(v.spine,0,0,0);
   const wChest=boneWorld(v.chest,0,0,0);
   const wNeck=boneWorld(v.head,0,0.04,0);
   const wHeadCenter=boneWorld(v.head,0,0.25,0.02);
   const wHeadTop=boneWorld(v.head,0,0.43,0.0);
   const wHairBack=boneWorld(v.head,0,0.28,-0.07);

   const wThighL=boneWorld(v.thighL,0,0,0);
   const wMidThighL={x:(wThighL.x+boneWorld(v.shinL).x)*0.5,y:(wThighL.y+boneWorld(v.shinL).y)*0.5,z:(wThighL.z+boneWorld(v.shinL).z)*0.5};
   const wShinL=boneWorld(v.shinL,0,0,0);
   const wFootL=boneWorld(v.footL,0,0,0);
   const wToeL=boneWorld(v.footL,0,-0.03,0.16);

   const wThighR=boneWorld(v.thighR,0,0,0);
   const wMidThighR={x:(wThighR.x+boneWorld(v.shinR).x)*0.5,y:(wThighR.y+boneWorld(v.shinR).y)*0.5,z:(wThighR.z+boneWorld(v.shinR).z)*0.5};
   const wShinR=boneWorld(v.shinR,0,0,0);
   const wFootR=boneWorld(v.footR,0,0,0);
   const wToeR=boneWorld(v.footR,0,-0.03,0.16);

   const wShL=boneWorld(v.upperArmL,0,0,0);
   const wElbL=boneWorld(v.forearmL,0,0,0);
   const wSleeveL={x:wShL.x*0.52+wElbL.x*0.48,y:wShL.y*0.52+wElbL.y*0.48,z:wShL.z*0.52+wElbL.z*0.48};
   const wHandL=boneWorld(v.handL,0,-0.04,0.02);
   const wWristL={x:wElbL.x*0.28+wHandL.x*0.72,y:wElbL.y*0.28+wHandL.y*0.72,z:wElbL.z*0.28+wHandL.z*0.72};

   const wShR=boneWorld(v.upperArmR,0,0,0);
   const wElbR=boneWorld(v.forearmR,0,0,0);
   const wSleeveR={x:wShR.x*0.52+wElbR.x*0.48,y:wShR.y*0.52+wElbR.y*0.48,z:wShR.z*0.52+wElbR.z*0.48};
   const wHandR=boneWorld(v.handR,0,-0.04,0.02);

   // Build depth-sorted 3D body segments for this character so front limbs naturally cross over the torso
   const parts=[];

   function addLimb(w0,w1,r0M,r1M,col,bias=0){
    const p0=proj(w0.x,w0.y,w0.z),p1=proj(w1.x,w1.y,w1.z);
    parts.push({
     z:(p0.depth+p1.depth)*0.5+bias,
     draw:()=>drawCapsule2D(p0,p1,r0M*pxX,r1M*pxX,col,outline)
    });
   }

   // Left & Right Legs
   addLimb(wThighL,wMidThighL,0.105,0.095,shortsCol);
   addLimb(wMidThighL,wShinL,0.076,0.068,skinCol);
   addLimb(wShinL,wFootL,0.066,0.056,skinCol);
   // White sock cuff
   addLimb({x:wShinL.x*0.3+wFootL.x*0.7,y:wShinL.y*0.3+wFootL.y*0.7,z:wShinL.z*0.3+wFootL.z*0.7},wFootL,0.060,0.058,creamCol,0.002);
   addLimb(wFootL,wToeL,0.068,0.062,soleCol,-0.005);
   addLimb({x:wFootL.x,y:wFootL.y+0.025,z:wFootL.z},{x:wToeL.x,y:wToeL.y+0.022,z:wToeL.z},0.064,0.056,shoeCol,0.004);

   addLimb(wThighR,wMidThighR,0.105,0.095,shortsCol);
   addLimb(wMidThighR,wShinR,0.076,0.068,skinCol);
   addLimb(wShinR,wFootR,0.066,0.056,skinCol);
   addLimb({x:wShinR.x*0.3+wFootR.x*0.7,y:wShinR.y*0.3+wFootR.y*0.7,z:wShinR.z*0.3+wFootR.z*0.7},wFootR,0.060,0.058,creamCol,0.002);
   addLimb(wFootR,wToeR,0.068,0.062,soleCol,-0.005);
   addLimb({x:wFootR.x,y:wFootR.y+0.025,z:wFootR.z},{x:wToeR.x,y:wToeR.y+0.022,z:wToeR.z},0.064,0.056,shoeCol,0.004);

   // Pelvis / Shorts hip block
   addLimb(wHips,wSpine,0.175,0.165,shortsCol,0.005);

   // Torso / Camp-Collar Shirt
   const pSpine=proj(wSpine.x,wSpine.y,wSpine.z);
   const pNeck=proj(wNeck.x,wNeck.y,wNeck.z);
   const chestFwd=boneWorld(v.chest,0,0,1);
   const facingCam=(chestFwd.z-wChest.z)>-0.15;
   parts.push({
    z:(pSpine.depth+pNeck.depth)*0.5+0.01,
    draw:()=>{
     drawCapsule2D(pSpine,pNeck,0.175*pxX,0.195*pxX,shirtCol,outline);
     // Cream V-neck undershirt + camp collar when facing forward/side
     if(facingCam){
      const wVLeft=boneWorld(v.chest,0.075,0.17,0.12);
      const wVRight=boneWorld(v.chest,-0.075,0.17,0.12);
      const wVBot=boneWorld(v.chest,0,0.04,0.14);
      const pvL=proj(wVLeft.x,wVLeft.y,wVLeft.z);
      const pvR=proj(wVRight.x,wVRight.y,wVRight.z);
      const pvB=proj(wVBot.x,wVBot.y,wVBot.z);
      ctx.fillStyle=creamCol;
      ctx.strokeStyle=outline;
      ctx.lineWidth=Math.max(0.8,pxX*0.018);
      ctx.beginPath();
      ctx.moveTo(pvL.x,pvL.y);ctx.lineTo(pvR.x,pvR.y);ctx.lineTo(pvB.x,pvB.y);ctx.closePath();
      ctx.fill();ctx.stroke();
     }
    }
   });

   // Left & Right Arms + Contrast Wristband
   addLimb(wShL,wSleeveL,0.088,0.082,shirtCol,0.012);
   addLimb(wSleeveL,wElbL,0.064,0.058,skinCol,0.012);
   addLimb(wElbL,wHandL,0.058,0.052,skinCol,0.014);
   addLimb(wWristL,wHandL,0.065,0.062,wristCol,0.016);
   addLimb(wHandL,boneWorld(v.handL,0,-0.08,0.03),0.058,0.052,skinCol,0.018);

   addLimb(wShR,wSleeveR,0.088,0.082,shirtCol,0.012);
   addLimb(wSleeveR,wElbR,0.064,0.058,skinCol,0.012);
   addLimb(wElbR,wHandR,0.058,0.052,skinCol,0.014);
   addLimb(wHandR,boneWorld(v.handR,0,-0.08,0.03),0.058,0.052,skinCol,0.018);

   // Decoy carried stone if active
   if(v.decoyStoneMesh&&v.decoyStoneMesh.visible){
    const dsPos=new T.Vector3().setFromMatrixPosition(v.decoyStoneMesh.matrixWorld);
    const pDs=proj(dsPos.x,dsPos.y,dsPos.z);
    parts.push({
     z:pDs.depth+0.04,
     draw:()=>{
      const fakeStone={visible:true,position:dsPos,userData:{rTop:0.33,rBot:0.37,col:stonePalette[0]}};
      draw3DStone(fakeStone,pxX,pxX,pxZ);
     }
    });
   }

   // Neck
   addLimb(wChest,boneWorld(v.head,0,0.10,0),0.072,0.068,skinCol,0.015);

   // Girl Twin Pigtails (attached to Head bone in 3D space!)
   if(v.isGirl&&v.head){
    for(const side of [-1,1]){
     const wTie=boneWorld(v.head,side*0.23,0.23,-0.03);
     const wPigtailMid=boneWorld(v.head,side*0.31,0.15,-0.05);
     const wPigtailTip=boneWorld(v.head,side*0.34,0.04,-0.04);
     const pTie=proj(wTie.x,wTie.y,wTie.z);
     const pMid=proj(wPigtailMid.x,wPigtailMid.y,wPigtailMid.z);
     const pTip=proj(wPigtailTip.x,wPigtailTip.y,wPigtailTip.z);
     parts.push({
      z:pMid.depth,
      draw:()=>{
       drawCapsule2D(pTie,pMid,0.065*pxX,0.088*pxX,hairCol,outline);
       drawCapsule2D(pMid,pTip,0.085*pxX,0.048*pxX,hairCol,outline);
       ctx.fillStyle=shirtCol;
       ctx.beginPath();ctx.arc(pTie.x,pTie.y,Math.max(2,0.048*pxX),0,Math.PI*2);ctx.fill();
      }
     });
    }
   }

   // Back hair volume (drawn at wHairBack depth so it sits naturally behind face when facing camera, and in front when facing away!)
   const pHairBack=proj(wHairBack.x,wHairBack.y,wHairBack.z);
   parts.push({
    z:pHairBack.depth,
    draw:()=>{
     const rH=Math.max(3,0.255*pxX);
     ctx.fillStyle=hairCol;
     ctx.strokeStyle=outline;
     ctx.lineWidth=Math.max(1,pxX*0.022);
     ctx.beginPath();
     ctx.arc(pHairBack.x,pHairBack.y,rH,0,Math.PI*2);
     ctx.fill();ctx.stroke();
    }
   });

   // 3D Head Sphere + Sculpted Crown Hair + Facial Features
   const pHead=proj(wHeadCenter.x,wHeadCenter.y,wHeadCenter.z);
   const pTop=proj(wHeadTop.x,wHeadTop.y,wHeadTop.z);
   parts.push({
    z:pHead.depth+0.015,
    draw:()=>{
     const rHead=Math.max(4,0.235*pxX);
     // Ears
     for(const s of [-1,1]){
      const wEar=boneWorld(v.head,s*0.22,0.23,0.0);
      const pEar=proj(wEar.x,wEar.y,wEar.z);
      ctx.fillStyle=skinCol;ctx.strokeStyle=outline;ctx.lineWidth=Math.max(0.8,pxX*0.018);
      ctx.beginPath();ctx.arc(pEar.x,pEar.y,Math.max(1.5,0.055*pxX),0,Math.PI*2);ctx.fill();ctx.stroke();
     }
     // Shaded 3D Head Sphere
     const hg=ctx.createRadialGradient(pHead.x-rHead*0.28,pHead.y-rHead*0.32,rHead*0.08,pHead.x,pHead.y,rHead);
     hg.addColorStop(0,shadeHex(skinCol,1.15,10));
     hg.addColorStop(0.65,skinCol);
     hg.addColorStop(1,shadeHex(skinCol,0.80,-6));
     ctx.fillStyle=hg;
     ctx.strokeStyle=outline;
     ctx.lineWidth=Math.max(1,pxX*0.022);
     ctx.beginPath();
     ctx.arc(pHead.x,pHead.y,rHead,0,Math.PI*2);
     ctx.fill();ctx.stroke();

     // Facial features on the +Z front of the Head bone
     const headFwd=boneWorld(v.head,0,0.25,1.02);
     const fz=(headFwd.z-wHeadCenter.z);
     if(fz>-0.18){
      const visAlpha=clamp((fz+0.18)/0.38,0,1);
      ctx.save();
      ctx.globalAlpha=visAlpha;
      for(const s of [-1,1]){
       const wEye=boneWorld(v.head,s*0.086,0.255,0.205);
       const pEye=proj(wEye.x,wEye.y,wEye.z);
       const wBrow=boneWorld(v.head,s*0.092,0.335,0.205);
       const pBrow=proj(wBrow.x,wBrow.y,wBrow.z);
       const wCheek=boneWorld(v.head,s*0.138,0.185,0.175);
       const pCheek=proj(wCheek.x,wCheek.y,wCheek.z);

       // Rosy cheek blush
       ctx.fillStyle='rgba(217,118,94,0.55)';
       ctx.beginPath();ctx.ellipse(pCheek.x,pCheek.y,Math.max(1.2,0.042*pxX),Math.max(1,0.028*pxX),0,0,Math.PI*2);ctx.fill();

       // Sclera
       const rE=Math.max(1.5,0.046*pxX);
       ctx.fillStyle='#fffdf9';
       ctx.beginPath();ctx.ellipse(pEye.x,pEye.y,rE,rE*1.08,0,0,Math.PI*2);ctx.fill();
       // Iris & Pupil
       ctx.fillStyle='#4a2816';
       ctx.beginPath();ctx.arc(pEye.x,pEye.y,rE*0.68,0,Math.PI*2);ctx.fill();
       ctx.fillStyle='#120d0a';
       ctx.beginPath();ctx.arc(pEye.x,pEye.y,rE*0.42,0,Math.PI*2);ctx.fill();
       // Eye glint
       ctx.fillStyle='#ffffff';
       ctx.beginPath();ctx.arc(pEye.x-rE*0.22,pEye.y-rE*0.25,Math.max(0.7,rE*0.24),0,Math.PI*2);ctx.fill();

       // Eyebrow
       ctx.strokeStyle='#221714';
       ctx.lineWidth=Math.max(1.2,0.024*pxX);
       ctx.lineCap='round';
       ctx.beginPath();
       ctx.moveTo(pBrow.x-rE*0.8,pBrow.y+rE*0.1);
       ctx.quadraticCurveTo(pBrow.x,pBrow.y-rE*0.35,pBrow.x+rE*0.8,pBrow.y+rE*0.05);
       ctx.stroke();
      }
      // Smile & Teeth
      const wMouth=boneWorld(v.head,0,0.155,0.21);
      const pMouth=proj(wMouth.x,wMouth.y,wMouth.z);
      const rM=Math.max(1.5,0.052*pxX);
      ctx.fillStyle='#7d352b';
      ctx.beginPath();ctx.arc(pMouth.x,pMouth.y,rM,0,Math.PI);ctx.fill();
      ctx.fillStyle='#fffdf8';
      ctx.fillRect(pMouth.x-rM*0.65,pMouth.y,rM*1.3,rM*0.38);
      ctx.restore();
     }

     // Crown & Bangs Hair Cap on top of Head
     const rCrown=Math.max(4,0.245*pxX);
     const hairGrad=ctx.createRadialGradient(pTop.x-rCrown*0.25,pTop.y-rCrown*0.3,rCrown*0.1,pTop.x,pTop.y,rCrown);
     hairGrad.addColorStop(0,shadeHex(hairCol,1.35,14));
     hairGrad.addColorStop(0.6,hairCol);
     hairGrad.addColorStop(1,shadeHex(hairCol,0.75,-5));
     ctx.fillStyle=hairGrad;
     ctx.strokeStyle=outline;
     ctx.lineWidth=Math.max(1,pxX*0.02);
     ctx.beginPath();
     ctx.ellipse(pTop.x,pTop.y,rCrown,rCrown*0.68,0,0,Math.PI*2);
     ctx.fill();ctx.stroke();
     if(!v.isGirl){
      const wTuft=boneWorld(v.head,0.04,0.46,0.12);
      const pTuft=proj(wTuft.x,wTuft.y,wTuft.z);
      ctx.fillStyle=hairGrad;
      ctx.beginPath();
      ctx.arc(pTuft.x,pTuft.y,rCrown*0.42,0,Math.PI*2);
      ctx.fill();
     }
     // Draw unique per-look 3D headgear in Canvas3DRenderer too!
     if(v.look===1){
      for(const s of [-1,1]){
       const wG=boneWorld(v.head,s*0.084,0.26,0.22);
       const pG=proj(wG.x,wG.y,wG.z);
       ctx.strokeStyle='#4a2816';ctx.lineWidth=Math.max(1.4,0.022*pxX);
       ctx.beginPath();ctx.arc(pG.x,pG.y,Math.max(2,0.054*pxX),0,Math.PI*2);ctx.stroke();
      }
     }else if(v.look===2){
      for(const [cx,cy,cz] of [[-0.14,0.46,0.05],[0.14,0.46,0.05],[0,0.52,-0.02],[-0.16,0.40,-0.04],[0.16,0.40,-0.04]]){
       const wC=boneWorld(v.head,cx,cy,cz);
       const pC=proj(wC.x,wC.y,wC.z);
       ctx.fillStyle=hairGrad;
       ctx.beginPath();ctx.arc(pC.x,pC.y,rCrown*0.38,0,Math.PI*2);ctx.fill();
      }
     }else if(v.look===3){
      const wBun=boneWorld(v.head,0,0.55,-0.02);
      const pBun=proj(wBun.x,wBun.y,wBun.z);
      ctx.fillStyle=hairGrad;
      ctx.beginPath();ctx.arc(pBun.x,pBun.y,rCrown*0.56,0,Math.PI*2);ctx.fill();
      const wVis=boneWorld(v.head,0,0.35,0.08);
      const pVis=proj(wVis.x,wVis.y,wVis.z);
      ctx.fillStyle='#f6eedc';
      ctx.beginPath();ctx.ellipse(pVis.x,pVis.y,rCrown*0.98,rCrown*0.32,0,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#e8a828';
      ctx.beginPath();ctx.ellipse(pVis.x,pVis.y+rCrown*0.12,rCrown*0.92,rCrown*0.24,0,0,Math.PI);ctx.fill();
     }else if(v.look===4){
      const wHb=boneWorld(v.head,0,0.34,0.04);
      const pHb=proj(wHb.x,wHb.y,wHb.z);
      ctx.fillStyle='#f4b828';
      ctx.beginPath();ctx.ellipse(pHb.x,pHb.y,rCrown*0.98,rCrown*0.26,0,0,Math.PI*2);ctx.fill();
     }else if(v.look===5){
      const wFl=boneWorld(v.head,0.22,0.29,0.05);
      const pFl=proj(wFl.x,wFl.y,wFl.z);
      ctx.fillStyle='#ff9818';
      ctx.beginPath();ctx.arc(pFl.x,pFl.y,Math.max(2.5,0.075*pxX),0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#ffdf38';
      ctx.beginPath();ctx.arc(pFl.x,pFl.y,Math.max(1.2,0.035*pxX),0,Math.PI*2);ctx.fill();
     }else if(v.look===6){
      const wCap=boneWorld(v.head,0,0.36,0.08);
      const pCap=proj(wCap.x,wCap.y,wCap.z);
      ctx.fillStyle=v.team?'#e8762a':'#2296a0';
      ctx.beginPath();ctx.ellipse(pCap.x,pCap.y-rCrown*0.18,rCrown*1.02,rCrown*0.52,0,Math.PI,Math.PI*2);ctx.fill();
      ctx.fillStyle='#24303a';
      ctx.beginPath();ctx.ellipse(pCap.x,pCap.y+rCrown*0.05,rCrown*0.96,rCrown*0.24,0,0,Math.PI);ctx.fill();
     }else if(v.look===7){
      for(const s of [-1,1]){
       const wSb=boneWorld(v.head,s*0.18,0.49,-0.02);
       const pSb=proj(wSb.x,wSb.y,wSb.z);
       ctx.fillStyle=hairGrad;
       ctx.beginPath();ctx.arc(pSb.x,pSb.y,rCrown*0.44,0,Math.PI*2);ctx.fill();
      }
      const wBd=boneWorld(v.head,0,0.34,0.04);
      const pBd=proj(wBd.x,wBd.y,wBd.z);
      ctx.fillStyle='#d83070';
      ctx.beginPath();ctx.ellipse(pBd.x,pBd.y,rCrown*0.98,rCrown*0.26,0,0,Math.PI*2);ctx.fill();
     }
    }
   });

   parts.sort((a,b)=>a.z-b.z);
   for(let i=0;i<parts.length;i++)parts[i].draw();

   // Genda Shield golden dome if active
   if(v.shieldDome.visible){
    const pDome=proj(wx,wy+0.95,wz);
    const rD=0.78*pxX;
    ctx.save();
    const dg=ctx.createRadialGradient(pDome.x-rD*0.25,pDome.y-rD*0.25,rD*0.1,pDome.x,pDome.y,rD);
    dg.addColorStop(0,'rgba(255,235,130,0.12)');
    dg.addColorStop(0.75,'rgba(255,175,40,0.26)');
    dg.addColorStop(1,'rgba(255,150,20,0.52)');
    ctx.fillStyle=dg;
    ctx.strokeStyle='rgba(255,210,80,0.75)';
    ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(pDome.x,pDome.y,rD,0,Math.PI*2);ctx.fill();ctx.stroke();
    ctx.restore();
   }
  }

  return{
   isCanvas3D:true,
   domElement,
   shadowMap:{enabled:false,type:0,autoUpdate:false,needsUpdate:false},
   capabilities:{getMaxAnisotropy:()=>1},
   setPixelRatio(r){
    dpr=r||1;
    vpW=Math.max(1,Math.round(cssW*dpr));
    vpH=Math.max(1,Math.round(cssH*dpr));
    if(domElement.width!==vpW||domElement.height!==vpH){
     domElement.width=vpW;domElement.height=vpH;
    }
   },
   setSize(w,h){
    cssW=w||800;cssH=h||600;
    domElement.style.width=cssW+'px';
    domElement.style.height=cssH+'px';
    vpW=Math.max(1,Math.round(cssW*dpr));
    vpH=Math.max(1,Math.round(cssH*dpr));
    if(domElement.width!==vpW||domElement.height!==vpH){
     domElement.width=vpW;domElement.height=vpH;
    }
   },
   render(scn,cam){
    scn.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    vpMat.multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse);

    const e=vpMat.elements;
    const pxX=Math.abs(e[0]*0.5)*vpW;
    const pxY=Math.abs(e[5]*0.5)*vpH;
    const pxZ=Math.abs(e[9]*0.5)*vpH;

    ctx.save();
    ctx.fillStyle='#ce9f6a';
    ctx.fillRect(0,0,vpW,vpH);

    // 1. Full-bleed 32.13m x 24.90m Courtyard Background Texture mapped through OrthographicCamera
    const fTL=proj(-16.065,0.205,-15.065);
    const fBR=proj(16.065,0.205,9.835);
    if(bgImageEl&&bgImageEl.complete&&(bgImageEl.naturalWidth||bgImageEl.width)){
     ctx.drawImage(bgImageEl,fTL.x,fTL.y,fBR.x-fTL.x,fBR.y-fTL.y);
    }else{
     ctx.fillStyle='#dcb276';
     ctx.fillRect(fTL.x,fTL.y,fBR.x-fTL.x,fBR.y-fTL.y);
    }

    // 2. Ground Ambient Occlusion & Contact Shadows
    for(const o of COVER){
     drawSoftShadow(o.x+0.12,0.212,o.z+0.10,o.w*0.74,o.h*0.78,0.68,pxX,pxZ);
    }
    for(const gx of [-9.15,9.15]){
     drawSoftShadow(gx,0.212,0,0.58,1.55,0.58,pxX,pxZ);
    }
    drawSoftShadow(0.06,0.214,0.05,0.68,0.68,0.65,pxX,pxZ);
    for(const [,v] of players){
     drawSoftShadow(v.root.position.x,0.215,v.root.position.z,0.48,0.48,0.62,pxX,pxZ);
    }
    for(const [,dv] of decoyVisuals){
     drawSoftShadow(dv.root.position.x,0.215,dv.root.position.z,0.48,0.48,0.62,pxX,pxZ);
    }
    drawSoftShadow(ballShadow.position.x,0.22,ballShadow.position.z,0.36*ballShadow.scale.x,0.36*ballShadow.scale.y,ballShadowMat.opacity,pxX,pxZ);
    if(twinShadow.visible){
     drawSoftShadow(twinShadow.position.x,0.22,twinShadow.position.z,0.33,0.33,0.65,pxX,pxZ);
    }

    // 3. Courtyard Ground Rings, Restricted Tower Crease Zone & Builder Stack Guide Line
    drawGroundRing(0,0.23,0,1.04,1.12,'#fff7df',0.95,pxX,pxZ);
    if(towerZoneGroup.visible){
     const zCol='#'+zoneDashMat.color.getHexString();
     drawGroundDisc(0,0.224,0,1.13,TOWER_ZONE_RADIUS,zCol,zoneDiscMat.opacity,pxX,pxZ);
     drawGroundRing(0,0.225,0,TOWER_ZONE_RADIUS-0.045,TOWER_ZONE_RADIUS+0.025,zCol,zoneDashMat.opacity,pxX,pxZ,true,towerZoneGroup.rotation.y);
    }

    if(placeProgressRing.visible){
     const sc=placeProgressRing.scale.x||1;
     drawGroundRing(0,0.24,0,1.14*sc,1.28*sc,'#28b8a8',0.95,pxX,pxZ);
    }
    if(pickupRing.visible){
     drawGroundRing(pickupRing.position.x,0.24,pickupRing.position.z,0.46,0.58,'#ffe680',0.95,pxX,pxZ);
    }
    if(passRing.visible){
     const sc=passRing.scale.x||1;
     drawGroundRing(passRing.position.x,0.245,passRing.position.z,0.58*sc,0.72*sc,'#38f2d8',0.95,pxX,pxZ);
    }
    if(scatterWaveRing.visible){
     const sc=scatterWaveRing.scale.x||1;
     drawGroundRing(0,0.245,0,0.35*sc,0.55*sc,'#ffdf78',0.85,pxX,pxZ);
    }
    if(chargeRing.visible){
     const sc=chargeRing.scale.x||1;
     const cCol='#'+chargeRing.material.color.getHexString();
     drawGroundRing(chargeRing.position.x,0.245,chargeRing.position.z,0.54*sc,0.68*sc,cCol,0.92,pxX,pxZ);
    }
    for(const bm of burstMeshes){
     if(bm.visible){
      const sc=bm.scale.x||1;
      const bCol='#'+bm.material.color.getHexString();
      drawGroundRing(bm.position.x,0.26,bm.position.z,0.32*sc,0.52*sc,bCol,bm.material.opacity,pxX,pxZ);
     }
    }
    if(aim.visible){
     const pos=aim.geometry.attributes.position;
     const aCol='#'+aimMat.color.getHexString();
     ctx.save();
     ctx.strokeStyle=aCol;
     ctx.lineWidth=Math.max(2.2,0.055*pxX);
     ctx.lineCap='round';ctx.lineJoin='round';
     ctx.beginPath();
     for(let i=0;i<pos.count;i++){
      const pt=proj(pos.getX(i),pos.getY(i),pos.getZ(i));
      if(i===0)ctx.moveTo(pt.x,pt.y);else ctx.lineTo(pt.x,pt.y);
     }
     ctx.stroke();
     ctx.restore();
    }

    // 4. Depth-Sorted 3D Vertical Objects (Pre-baked 3D GLB Planters & Goalposts, 7 Stones, Power-Ups, Balls, and 17-Bone 3D Characters)
    const drawList=[];

    for(const bp of bakedProps){
     drawList.push({
      z:bp.zSort,
      draw:()=>{
       const p=proj(bp.ax,bp.ay,bp.az);
       const scaleX=pxX/bp.scale;
       const scaleY=pxX/bp.scale;
       ctx.drawImage(
        bp.canvas,
        p.x-bp.ox*scaleX,
        p.y-bp.oy*scaleY,
        bp.canvas.width*scaleX,
        bp.canvas.height*scaleY
       );
      }
     });
    }

    for(let i=0;i<7;i++){
     const sm=stoneMeshes[i];
     if(sm.visible){
      drawList.push({
       z:sm.position.z+sm.position.y*0.18,
       draw:()=>draw3DStone(sm,pxX,pxY,pxZ)
      });
     }
    }

    for(const [,pv] of powerupVisuals){
     drawList.push({
      z:pv.root.position.z+0.15,
      draw:()=>draw3DPowerup(pv,pxX,pxZ)
     });
    }

    for(let i=trailCount-1;i>=0;i--){
     const tr=trailSpheres[i];
     if(tr.visible){
      drawList.push({
       z:tr.position.z+tr.position.y*0.12,
       draw:()=>{
        const pt=proj(tr.position.x,tr.position.y,tr.position.z);
        const r=Math.max(1.5,0.18*(1-i/trailCount)*pxX);
        ctx.save();
        ctx.globalAlpha=0.44*(1-i/trailCount);
        ctx.fillStyle='#ffe47a';
        ctx.beginPath();ctx.arc(pt.x,pt.y,r,0,Math.PI*2);ctx.fill();
        ctx.restore();
       }
      });
     }
    }

    drawList.push({
     z:gameBall.position.z+gameBall.position.y*0.18,
     draw:()=>draw3DBall(gameBall,0.24,'#f0b828',pxX)
    });
    if(twinBallMesh.visible){
     drawList.push({
      z:twinBallMesh.position.z+twinBallMesh.position.y*0.18,
      draw:()=>draw3DBall(twinBallMesh,0.23,'#ffdf38',pxX)
     });
    }

    for(const [,v] of players){
     drawList.push({
      z:v.root.position.z+0.22,
      draw:()=>draw3DCharacter(v,pxX,pxZ)
     });
    }
    for(const [,dv] of decoyVisuals){
     drawList.push({
      z:dv.root.position.z+0.22,
      draw:()=>draw3DCharacter(dv,pxX,pxZ)
     });
    }

    drawList.sort((a,b)=>a.z-b.z);
    for(let i=0;i<drawList.length;i++)drawList[i].draw();

    // 5. 3D Floating Dust Motes
    const mPos=moteGeo.attributes.position;
    ctx.fillStyle='rgba(255,242,198,0.45)';
    for(let i=0;i<moteCount;i++){
     const mp=proj(mPos.getX(i),mPos.getY(i),mPos.getZ(i));
     ctx.beginPath();ctx.arc(mp.x,mp.y,Math.max(1.2,0.045*pxX),0,Math.PI*2);ctx.fill();
    }

    // 6. 3D Overhanging Tree Canopy Layer (at y = 2.85m for true orthographic foliage parallax!)
    if(canopyImageEl&&canopyImageEl.complete&&(canopyImageEl.naturalWidth||canopyImageEl.width)){
     const cTL=proj(-16.065,2.85,canopyCenterZ-12.45);
     const cBR=proj(16.065,2.85,canopyCenterZ+12.45);
     ctx.drawImage(canopyImageEl,cTL.x,cTL.y,cBR.x-cTL.x,cBR.y-cTL.y);
    }

    // 7. Crisp Overhead Player & Decoy Name Badges
    const allChars=[...players.values(),...decoyVisuals.values()];
    allChars.sort((a,b)=>a.root.position.z-b.root.position.z);
    for(const v of allChars){
     const spr=v.label.visible?v.label:(v.outLabel?.visible?v.outLabel:null);
     if(spr?.userData?.canvas){
      const lp=proj(v.root.position.x,v.root.position.y+2.25,v.root.position.z);
      const lw=1.72*pxX,lh=0.43*pxX;
      ctx.drawImage(spr.userData.canvas,lp.x-lw*0.5,lp.y-lh*0.5,lw,lh);
     }
    }

    ctx.restore();
   },
   dispose(){}
  };
 }

 if(!renderer){
  renderer=createCanvas3DRenderer();
 }else{
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,isWebGL1?1.5:maxDpr));
  renderer.outputColorSpace=T.SRGBColorSpace;
  renderer.shadowMap.enabled=!isWebGL1;
  if(!isWebGL1){
   renderer.shadowMap.type=T.PCFSoftShadowMap;
   renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
   renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=0.96;
  }
 }
 el.appendChild(renderer.domElement);

 const pointer=new T.Vector2(),ray=new T.Raycaster(),plane=new T.Plane(new T.Vector3(0,1,0),0),hit=new T.Vector3(),handWorld=new T.Vector3(),handLWorld=new T.Vector3();
 let aspect=1.5,zoomMode='auto';
 let lastW=0,lastH=0,lastDpr=0;
 let curHalfW=12.5,curHalfH=8.4,targetHalfW=12.5,targetHalfH=8.4,frustumInitialized=false;
 let cachedRect={left:0,top:0,width:0,height:0};

 function computeFrustumTargets(){
  if(zoomMode==='wide'){
   targetHalfW=aspect<0.95?10.6:Math.max(14.6,10.5*aspect);
   targetHalfH=targetHalfW/aspect;
  }else if(aspect<0.95){
   const maxPortraitH=zoomMode==='close'?8.0:9.2;
   targetHalfH=maxPortraitH;
   targetHalfW=clamp(targetHalfH*aspect,4.2,11.6);
   targetHalfH=targetHalfW/aspect;
  }else if(zoomMode==='close'){
   targetHalfW=clamp(7.8+aspect*3.8,8.8,11.6);
   targetHalfH=targetHalfW/aspect;
  }else{
   targetHalfH=8.15;
   targetHalfW=Math.max(12.0,targetHalfH*aspect);
   if(targetHalfW>14.6){targetHalfW=14.6;targetHalfH=targetHalfW/aspect;}
  }
  if(!frustumInitialized){
   curHalfW=targetHalfW;curHalfH=targetHalfH;
   camera.left=-curHalfW;camera.right=curHalfW;camera.top=curHalfH;camera.bottom=-curHalfH;
   camera.updateProjectionMatrix();
   frustumInitialized=true;
  }
 }

 const syncViewport=()=>{
  const w=el.clientWidth,h=el.clientHeight;
  if(!w||!h)return;
  const dpr=Math.min(window.devicePixelRatio||1,isWebGL1?1.5:maxDpr);
  if(w!==lastW||h!==lastH||dpr!==lastDpr){
   lastW=w;lastH=h;lastDpr=dpr;
   renderer.setPixelRatio(dpr);
   renderer.setSize(w,h);
  }
  const cr=renderer.domElement.getBoundingClientRect();
  cachedRect={left:cr.left||0,top:cr.top||0,width:cr.width||w,height:cr.height||h};
  aspect=w/h;
  computeFrustumTargets();
 };

 function point(e){
  if(e.pointerType&&e.pointerType!=='mouse')return;
  const w=cachedRect.width||lastW||1,h=cachedRect.height||lastH||1;
  pointer.set((e.clientX-cachedRect.left)/w*2-1,-(e.clientY-cachedRect.top)/h*2+1);
  ray.setFromCamera(pointer,camera);
  if(ray.ray.intersectPlane(plane,hit))onAim(hit.x,hit.z);
 }
 renderer.domElement.addEventListener('pointermove',point,{passive:true});
 renderer.domElement.addEventListener('pointerdown',point,{passive:true});

 const ro=new ResizeObserver(syncViewport);ro.observe(el);syncViewport();

 return{
  renderer,
  isCanvas3D,
  setZoomMode(m){zoomMode=m||'auto';computeFrustumTargets();},
  getZoomMode(){return zoomMode;},
  update(g,me,time,dt){
   latestGameRef=g;latestMeId=me;latestTime=time;
   if(Math.abs(curHalfW-targetHalfW)>0.0015||Math.abs(curHalfH-targetHalfH)>0.0015){
    const fBlend=Math.min(1,dt*18);
    curHalfW+=(targetHalfW-curHalfW)*fBlend;
    curHalfH+=(targetHalfH-curHalfH)*fBlend;
    camera.left=-curHalfW;camera.right=curHalfW;camera.top=curHalfH;camera.bottom=-curHalfH;
    camera.updateProjectionMatrix();
   }

   const mPos=moteGeo.attributes.position;
   for(let i=0;i<moteCount;i++){
    let y=mPos.getY(i)+Math.sin(time*1.4+i)*0.0025;
    let x=mPos.getX(i)+Math.cos(time*0.9+i*1.7)*0.003;
    if(x>10)x=-10;if(x<-10)x=10;
    mPos.setXY(i,x,y);
   }
   mPos.needsUpdate=true;

   // Update Restricted Tower Zone Ring visibility & pulse
   towerZoneGroup.visible=g.phase==='chase';
   if(towerZoneGroup.visible){
    let anyDefInZone=false;
    for(let i=0;i<g.players.length;i++){
     const q=g.players[i];
     if(q.alive&&q.team!==g.attack&&q.inTowerZone){anyDefInZone=true;break;}
    }
    towerZoneGroup.rotation.y=time*0.22;
    zoneDashMat.color.copy(anyDefInZone?COL_ZONE_ALERT:COL_ZONE_IDLE);
    zoneDashMat.opacity=anyDefInZone?(0.68+Math.sin(time*16)*0.22):0.52;
    zoneDiscMat.opacity=anyDefInZone?0.16:0.06;
   }

   // Sync spawned 3D Power-Ups on the courtyard
   const pList=g.powerups||[];
   if(powerupVisuals.size>0){
    for(const uid of powerupVisuals.keys()){
     let found=false;
     for(let i=0;i<pList.length;i++){if(pList[i].uid===uid){found=true;break;}}
     if(!found)removePowerupVisual(uid);
    }
   }
   for(let i=0;i<pList.length;i++){
    const pu=pList[i];
    const pv=powerupVisuals.get(pu.uid)||createPowerupVisual(pu);
    const age=Math.max(0,g.clock-(pu.spawnAt||0));
    const popScale=age<0.42?clamp((age/0.42)*1.15-Math.max(0,age-0.28)*0.9,0.05,1.15):1.0;
    pv.root.scale.setScalar(popScale);
    pv.icon.position.y=0.56+Math.sin(time*3.8+pu.x)*0.09;
    pv.icon.rotation.y=time*2.1+pu.z;
    const padPulse=1+Math.sin(time*5.5)*0.08;
    pv.pad.scale.set(padPulse,padPulse,1);
   }

   // Sync 3D Kathputli Decoy Clones — visually indistinguishable from the spawning player!
   const dList=g.decoys||[];
   if(decoyVisuals.size>0){
    for(const [did,dv] of decoyVisuals){
     let found=false;
     for(let i=0;i<dList.length;i++){if(dList[i].id===did){found=true;break;}}
     if(!found){
      disposeCharacterEntry(dv);
      decoyVisuals.delete(did);
     }
    }
   }
   for(let i=0;i<dList.length;i++){
    const dc=dList[i];
    let dv=decoyVisuals.get(dc.id);
    if(!dv){
     dv=buildCharacterEntry(dc,me,true);
     decoyVisuals.set(dc.id,dv);
    }
    stepCharacterLocomotion(dv,dc,g,dt,time,false);
    if(dv.decoyStoneMesh){
     if(dc.carry!==null&&dc.carry!==undefined){
      dv.decoyStoneMesh.visible=true;
      dv.decoyStoneMesh.position.set((dc.ax||0)*0.34,0.82,(dc.az||-1)*0.34);
      dv.decoyStoneMesh.rotation.y=Math.atan2(dc.ax||0,dc.az||-1);
     }else{
      dv.decoyStoneMesh.visible=false;
     }
    }
   }

   // Update 3D Power-Up Burst Shockwaves
   const bList=g.bursts||[];
   let bSlot=0;
   for(let i=0;i<bList.length&&bSlot<burstMeshes.length;i++){
    const bData=bList[i],age=g.clock-bData.at;
    if(age>=0&&age<0.65){
     const bm=burstMeshes[bSlot++],prog=clamp(age/0.65,0,1);
     bm.visible=true;
     bm.position.set(bData.x,0.26,bData.z);
     const maxScale=bData.type==='mirchi'?5.6:bData.type==='genda'?3.6:2.8;
     const s=0.6+prog*maxScale;
     bm.scale.set(s,s,1);
     bm.material.color.copy(BURST_COLORS[bData.type]||BURST_COLORS.kathputli);
     bm.material.opacity=(1-prog)*0.85;
    }
   }
   for(let i=bSlot;i<burstMeshes.length;i++)burstMeshes[i].visible=false;

   for(const [id,v] of players){
    let p=null;
    for(let i=0;i<g.players.length;i++){if(g.players[i].id===id){p=g.players[i];break;}}
    if(!p||(Math.max(0,Math.floor(Number(p.look)||0))%8)!==v.look)removePlayer(id);
   }
   for(let i=0;i<g.players.length;i++){
    const p=g.players[i];
    const v=players.get(p.id)||addPlayer(p,me);
    stepCharacterLocomotion(v,p,g,dt,time,p.id===me);
   }

   // Synchronized camera tracking in Zoom ('close') mode using rendered player root position
   const localV=players.get(me);
   const localP=g.players.find(p=>p.id===me);
   let targetX=0,targetZ=-0.35;
   if(localP&&(zoomMode==='close'||aspect<0.95)&&(g.phase==='opening'||g.phase==='chase')){
    const rx=localV?localV.root.position.x:localP.x;
    const rz=localV?localV.root.position.z:localP.z;
    const maxPanX=aspect<0.95?Math.max(3.6,10.8-curHalfW):3.6;
    targetX=clamp(rx*(aspect<0.95?0.72:0.38),-maxPanX,maxPanX);
    targetZ=clamp(rz*0.35-0.25,-2.6,2.4);
   }
   tmpTargetPos.set(targetX,0,targetZ);
   camFocus.lerp(tmpTargetPos,Math.min(1,dt*22));
   camera.position.set(camFocus.x+camBaseOffset.x,camBaseOffset.y,camFocus.z+camBaseOffset.z);

   const scatterAge=g.clock-(g.lastScatterAt??-9);
   if(scatterAge>=0&&scatterAge<0.55){
    scatterWaveRing.visible=true;
    const s=1+scatterAge*7.5;
    scatterWaveRing.scale.set(s,s,1);
   }else scatterWaveRing.visible=false;

   let placed=0;
   for(let i=0;i<7;i++){
    const m=stoneMeshes[i],s=g.stones[i];m.visible=true;
    if(!s||s.placed){
     const stackY=.28+placed*.135;
     const placeAge=s&&s.placedAt?g.clock-s.placedAt:99;
     const settleBounce=(placeAge>=0&&placeAge<0.35)?Math.sin((placeAge/0.35)*Math.PI)*0.18*(1-placeAge/0.35):0;
     m.position.set(0,stackY+settleBounce,0);
     m.rotation.set(0,i*.45,0);
     placed++;
    }else if(s.held){
     const holderEntry=players.get(s.held),p=g.players.find(p=>p.id===s.held);
     if(p&&p.place>0){
      const prog=clamp(p.place/0.65,0,1);
      const startX=p.x+p.ax*.32,startZ=p.z+p.az*.32,startY=0.72;
      const endY=.28+g.stack*.135;
      const arcY=startY*(1-prog)+endY*prog+Math.sin(prog*Math.PI)*0.38;
      m.position.set(startX*(1-prog),arcY,startZ*(1-prog));
      m.rotation.set(Math.sin(prog*Math.PI)*0.25,i*.45+prog*1.2,0);
     }else if(holderEntry?.handR&&holderEntry?.handL&&p){
      holderEntry.root.updateWorldMatrix(true,true);
      holderEntry.handR.getWorldPosition(handWorld);
      holderEntry.handL.getWorldPosition(handLWorld);
      m.position.set((handWorld.x+handLWorld.x)*0.5+p.ax*.10,(handWorld.y+handLWorld.y)*0.5-.02,(handWorld.z+handLWorld.z)*0.5+p.az*.10);
      m.rotation.set(0,Math.atan2(p.ax,p.az),0);
     }else if(p){
      m.position.set(p.x+p.ax*.38,1.05,p.z+p.az*.38);
     }
    }else{
     const age=g.clock-(s.scatterAt??-9);
     const dur=0.58;
     if(age>=0&&age<dur){
      const t=age/dur;
      const ease=1-Math.pow(1-t,2.2);
      const bounce=Math.abs(Math.sin(t*Math.PI*1.75))*Math.pow(1-t,0.75)*(s.peakY||0.85);
      const curY=(s.fromY||0.5)*(1-t)+0.28*t+bounce;
      m.position.set(s.x*ease,curY,s.z*ease);
      const sp=(s.spin||5)*(1-t);
      m.rotation.set(sp*1.2,i*.45+sp,sp*0.8);
     }else{
      tmpTargetPos.set(s.x,.28,s.z);
      m.position.lerp(tmpTargetPos,Math.min(1,dt*16));
      m.rotation.set(0,i*.45,0);
     }
    }
   }

   let p=localP;
   const placingBuilder=g.players.find(q=>q.place>0);
   placeProgressRing.visible=!!placingBuilder;
   if(placingBuilder){const s=1+.18*Math.sin(time*16);placeProgressRing.scale.set(s,s,1);}



   let nearStone=null,bestStoneDist=1.05;
   if(p&&p.alive&&p.team===g.attack&&p.carry===null&&g.phase==='chase'){
    for(let i=0;i<g.stones.length;i++){
     const st=g.stones[i];
     if(!st||st.placed||st.held!==null)continue;
     const dist=Math.hypot(p.x-st.x,p.z-st.z);
     if(dist<bestStoneDist){bestStoneDist=dist;nearStone=st;}
    }
   }
   if(nearStone){pickupRing.visible=true;pickupRing.position.set(nearStone.x,.24,nearStone.z);}else pickupRing.visible=false;

   // Render Judwaa Twin Ball if active
   if(g.twinBall){
    const tb=g.twinBall;
    const tArc=Math.sin(clamp((tb.travel||0)/10,0,1)*Math.PI)*0.24;
    twinBallMesh.visible=true;
    twinBallMesh.position.set(tb.x,.74+tArc,tb.z);
    twinBallMesh.rotation.x+=dt*14;
    twinShadow.visible=true;
    twinShadow.position.set(tb.x,.228,tb.z);
   }else{
    twinBallMesh.visible=false;
    twinShadow.visible=false;
   }

   let b=g.ball,h=g.players.find(p=>p.id===b.holder),holderEntry=b.holder?players.get(b.holder):null;
   const thrower=b.from?g.players.find(q=>q.id===b.from):null;
   const throwerEntry=b.from?players.get(b.from):null;

   function pushTrailPos(pos){
    for(let i=trailCount-1;i>0;i--)trailPool[i].copy(trailPool[i-1]);
    trailPool[0].copy(pos);
    if(trailLen<trailCount)trailLen++;
    for(let i=0;i<trailCount;i++){
     if(i<trailLen){trailSpheres[i].visible=true;trailSpheres[i].position.copy(trailPool[i]);}
     else trailSpheres[i].visible=false;
    }
   }

   if(b.mode==='held'&&holderEntry?.handR&&h){
    holderEntry.root.updateWorldMatrix(true,true);
    holderEntry.handR.getWorldPosition(handWorld);
    gameBall.position.set(handWorld.x+h.ax*.06,handWorld.y+.02,handWorld.z+h.az*.06);
    trailLen=0;
    for(const tr of trailSpheres)tr.visible=false;
   }else if(b.mode==='flight'){
    const arc=Math.sin(clamp((b.travel||0)/10,0,1)*Math.PI)*0.24;
    let targetBallX=b.x,targetBallY=.74+arc,targetBallZ=b.z;
    if(thrower&&thrower.anim>0.33&&throwerEntry?.handR&&(b.travel||0)<1.0){
     throwerEntry.root.updateWorldMatrix(true,true);
     throwerEntry.handR.getWorldPosition(handWorld);
     const releaseBlend=clamp((0.40-thrower.anim)/0.07,0,1);
     targetBallX=handWorld.x*(1-releaseBlend)+targetBallX*releaseBlend;
     targetBallY=handWorld.y*(1-releaseBlend)+targetBallY*releaseBlend;
     targetBallZ=handWorld.z*(1-releaseBlend)+targetBallZ*releaseBlend;
    }
    gameBall.position.set(targetBallX,targetBallY,targetBallZ);
    gameBall.rotation.x+=dt*14;
    gameBall.rotation.z-=dt*10;
    pushTrailPos(gameBall.position);
   }else{
    const looseY=Math.max(0.42,(b.y||0.24)+0.18);
    gameBall.position.set(b.x+(h?h.ax*.40:0),b.mode==='held'?1.25:looseY,b.z+(h?h.az*.40:0));
    const bSpd=Math.hypot(b.vx||0,b.vz||0);
    if(bSpd>0.05){
     gameBall.rotation.x+=(b.vz||0)*dt*3.8;
     gameBall.rotation.z-=(b.vx||0)*dt*3.8;
     gameBall.rotation.y+=(b.spin||0)*dt;
    }
    if(bSpd>2.6){
     pushTrailPos(gameBall.position);
    }else{
     trailLen=0;
     for(const tr of trailSpheres)tr.visible=false;
    }
   }
   const ballH=Math.max(0,gameBall.position.y-0.42);
   const shScale=clamp(1.05-ballH*0.28,0.52,1.05);
   ballShadow.position.set(gameBall.position.x,.228,gameBall.position.z);
   ballShadow.scale.set(shScale,shScale,1);
   ballShadowMat.opacity=clamp(0.72-ballH*0.30,0.22,0.72);

   if(h&&b.mode==='held'&&(h.charge||0)>0.02){
    chargeRing.visible=true;
    chargeRing.position.set(h.x,.245,h.z);
    const c=clamp(h.charge||0,0,1);
    const pulse=c>=0.98?Math.sin(time*18)*0.08:0;
    const cs=0.85+c*0.75+pulse;
    chargeRing.scale.set(cs,cs,1);
    chargeRing.material.color.copy(c>=0.98?COL_AIM_MAX:c>0.65?COL_CHG_HIGH:COL_CHG_BASE);
   }else chargeRing.visible=false;

   const passTarget=p&&b.holder===me?findPassTarget(g,p,p.ax,p.az):null;
   if(passTarget){
    passRing.visible=true;
    passRing.position.set(passTarget.x,.245,passTarget.z);
    const ps=1+.14*Math.sin(time*14);
    passRing.scale.set(ps,ps,1);
   }else passRing.visible=false;

   aim.visible=!!p&&b.holder===me;
   if(p&&aim.visible){
    const chg=clamp(p.charge||0,0,1);
    const damp=p.inTowerZone&&!passTarget?0.58:1;
    const len=passTarget?Math.min(7.5,Math.hypot(passTarget.x-p.x,passTarget.z-p.z)):(3.6+chg*3.4)*damp;
    aimMat.color.copy(passTarget?COL_AIM_PASS:p.inTowerZone?COL_AIM_ZONE:chg>=0.98?COL_AIM_MAX:chg>0.65?COL_AIM_HIGH:chg>0.25?COL_AIM_MID:COL_AIM_BASE);
    const pos=aim.geometry.attributes.position,ex=p.x+p.ax*len,ez=p.z+p.az*len,px=-p.az*.36,pz=p.ax*.36,bx=ex-p.ax*.52,bz=ez-p.az*.52;
    pos.setXYZ(0,p.x,.27,p.z);pos.setXYZ(1,ex,.27,ez);pos.setXYZ(2,bx+px,.27,bz+pz);pos.setXYZ(3,ex,.27,ez);pos.setXYZ(4,bx-px,.27,bz-pz);pos.needsUpdate=true;
   }

   if(!isWebGL1&&renderer.shadowMap)renderer.shadowMap.needsUpdate=true;
   renderer.render(scene,camera);
  },
  dispose(){
   ro.disconnect();
   renderer.domElement.removeEventListener('pointermove',point);
   renderer.domElement.removeEventListener('pointerdown',point);
   for(const id of [...players.keys()])removePlayer(id);
   for(const uid of [...powerupVisuals.keys()])removePowerupVisual(uid);
   for(const [,dv] of decoyVisuals)disposeCharacterEntry(dv);
   decoyVisuals.clear();
   footRingGeo.dispose();pShadowGeo.dispose();auraRingGeo.dispose();shieldDomeGeo.dispose();decoyStoneGeo.dispose();
   for(const bm of burstMeshes){bm.geometry.dispose();bm.material.dispose();}
   for(const m of Object.values(mats))m.dispose();
   floorTex.dispose();bumpTex.dispose();floorMat.dispose();
   softAoTex.dispose();aoMat.dispose();ballShadowMat.dispose();
   zoneDiscMat.dispose();zoneDashMat.dispose();
   moteGeo.dispose();moteMat.dispose();
   renderer.dispose();
   renderer.domElement.remove();
  }
 };
}
