// Canvas fallback for devices without WebGL. Uses the v2 Blender-authored sprite sheet, 3D courtyard background render, and aligned ortho projection.
import {COVER,TOWER_ZONE_RADIUS,clamp,findPassTarget} from './game.js';

const INV_SQRT2 = 1 / Math.SQRT2;
const BUFF_HEX = {
 chappal:'#38d6ff',
 genda:'#ffa826',
 mirchi:'#ff4228',
 banta:'#68ee44',
 judwaa:'#ffde38',
 kathputli:'#e85298'
};

export async function makeFallback(el,onAim){
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');el.appendChild(canvas);
 const sprites=new Image();sprites.src='/models/pittu-sprites-v2.png';
 await sprites.decode().catch(()=>{});
 const bgImg=new Image();bgImg.src='/models/pittu-courtyard-bg-v2.png';
 await bgImg.decode().catch(()=>{});
 let w=1,h=1,lastW=0,lastH=0,lastDpr=0,u=1,ox=0,oy=0,zoomMode='auto',camX=0,camZ=0,curMult=1.0,targetMult=1.0;
 // Aligned orthographic projection matching Three(0,26,26) ortho width 28:
 // screen center + (x - camX)*u, (z - camZ)*u/sqrt(2) - y*u/sqrt(2)
 const pos=(x,z,y=0)=>[ox+(x-camX)*u,oy+((z-camZ)-y)*u*INV_SQRT2];
 function updateScale(){
  const aspect=(w||1)/(h||1);
  targetMult=(zoomMode==='close'||(zoomMode==='auto'&&aspect<0.95))?1.32:zoomMode==='wide'?0.90:1.0;
  const baseU=Math.min(w/28,h/21);
  u=baseU*curMult;ox=w*.5;oy=h*.54;
 }
 function resize(){
  w=el.clientWidth||1;h=el.clientHeight||1;
  let d=Math.min(window.devicePixelRatio||1,1.7);
  if(w!==lastW||h!==lastH||d!==lastDpr){
   lastW=w;lastH=h;lastDpr=d;
   canvas.width=Math.floor(w*d);canvas.height=Math.floor(h*d);
   canvas.style.width=w+'px';canvas.style.height=h+'px';
   ctx.setTransform(d,0,0,d,0,0);
  }
  updateScale();
 }
 let ro=new ResizeObserver(resize);ro.observe(el);resize();
 // Only hover-aim on desktop mouse so touch swipes don't hijack character facing!
 function point(e){if(e.pointerType&&e.pointerType!=='mouse')return;onAim((e.offsetX-ox)/u+camX,(e.offsetY-oy)/(u*INV_SQRT2)+camZ);}
 canvas.addEventListener('pointermove',point,{passive:true});canvas.addEventListener('pointerdown',point,{passive:true});

 function poly(points,col,stroke){ctx.beginPath();points.forEach((p,i)=>{const [x,y]=pos(...p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.closePath();ctx.fillStyle=col;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke();}}
 function box(x,z,b,d,t,col,side='#b78562',front='#c39671',y=0){
  poly([[x-b/2,z+d/2,y],[x+b/2,z+d/2,y],[x+b/2,z+d/2,y+t],[x-b/2,z+d/2,y+t]],front);
  poly([[x+b/2,z-d/2,y],[x+b/2,z+d/2,y],[x+b/2,z+d/2,y+t],[x+b/2,z-d/2,y+t]],side);
  poly([[x-b/2,z-d/2,y+t],[x+b/2,z-d/2,y+t],[x+b/2,z+d/2,y+t],[x-b/2,z+d/2,y+t]],col);
 }
 function ellipse(x,z,y,rx,ry,col){const p=pos(x,z,y);ctx.beginPath();ctx.ellipse(p[0],p[1],rx*u,ry*u,0,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();}
 function line(points,col,width=1){ctx.beginPath();points.forEach((p,i)=>{const [x,y]=pos(...p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.strokeStyle=col;ctx.lineWidth=width;ctx.stroke();}
 function bush(x,z,s=1){ellipse(x+.15,z+.25,0,.6*s,.18*s,'#657a5125');box(x,z,.7*s,.6*s,.5*s,'#cf8c64','#a9684c','#bb7956');for(let i=0;i<5;i++)ellipse(x+Math.sin(i*8)*.24*s,z+Math.cos(i*8)*.18*s,.8*s+Math.sin(i)*.12,.25*s,.29*s,i%2?'#88aa6c':'#5f8e63');}
 function tree(x,z){ellipse(x+1,z+.5,0,1.75,.75,'#57734b1a');box(x,z,.28,.28,3.3,'#8a6d4b','#755b3e','#82684c');for(let i=0;i<7;i++)ellipse(x+Math.sin(i*2)*.82,z+Math.cos(i*2)*.48,3.55+Math.cos(i)*.48,1.1,.86,i%2?'#92b475':'#6d9662');}
 function stone(x,z,y,i){ellipse(x,z,y-.05,.35-i*.018,.11,'#5e6961');ellipse(x,z,y,.36-i*.018,.12,'#9ba396');line([[x-.18,z-.04,y+.03],[x+.09,z-.06,y+.03]],'#d3d3bd',1);}

 const dustPoints=Array.from({length:220},(_,i)=>({x:Math.sin(i*85.31)*10.6,z:Math.cos(i*18.77)*7.5}));
 const puffs=[];
 const trail=[];

 function background(){
  let grad=ctx.createLinearGradient(0,0,w,h);grad.addColorStop(0,'#f2e3c6');grad.addColorStop(1,'#dfc9a2');ctx.fillStyle=grad;ctx.fillRect(0,0,w,h);
  if(bgImg.complete&&bgImg.naturalWidth){
   const bw=28*u,bh=21*u;
   ctx.drawImage(bgImg,ox-camX*u-bw*.5,oy-camZ*u*INV_SQRT2-bh*.54,bw,bh);
   return;
  }
  ellipse(0,1,-.5,12.8,6.2,'#7d865c20');
  box(0,0,22.5,16.5,.5,'#dec49a','#b88a62','#c4966c',-.5);
  for(let i=0;i<3;i++){
   const x=(i-1)*7.5,hHouse=i===1?4.2:3.8;
   box(x,-9.3,7.1,2.6,hHouse,['#e09878','#94b8a7','#e4ca86'][i],'#b48c68',['#e5a284','#9ec0b0','#e8d090'][i]);
   box(x,-9.3,7.35,2.8,.22,'#a85e47','#8f4c38','#9c553f',hHouse);
   box(x+.2,-7.6,6.1,.7,.12,'#c9b497','#a89378','#b8a388',2.95);
   box(x-1.9,-7.95,1.15,.04,1.95,'#3e5e5c','#3e5e5c','#3e5e5c');
   for(let dx of [.35,2.05]){
    box(x+dx,-7.92,1.08,.04,1.12,'#f2dec0','#f2dec0','#f2dec0',1.55);
    box(x+dx,-7.88,.86,.04,.90,'#3e5e5c','#3e5e5c','#3e5e5c',1.66);
    line([[x+dx,-7.84,1.68],[x+dx,-7.84,2.54]],'#2c3a3a',1.5);
   }
   if(i!==1)box(x+(i===0?1.2:-1.4),-9.4,.95,.95,.95,'#2f373d','#1f2529','#262d32',hHouse+.22);
  }
  tree(-11.8,-5.8);tree(11.8,-6);for(let x of [-9,-4.2,4.2,9])bush(x,-7.35,.78);
  line([[-9,-7.5,3.35],[0,-7.5,2.95],[9,-7.5,3.35]],'#8c7658',1.2);
  for(let i=0;i<9;i++){let x=-7.2+i*1.8,y=3.05+Math.abs(i-4)*.05;poly([[x-.28,-7.5,y],[x+.28,-7.5,y],[x+.26,-7.5,y-.55],[x-.26,-7.5,y-.55]],['#d46e53','#e5c467','#5d9a90'][i%3]);}
  ellipse(6.8,-7.4,.55,.36,.26,'#334c52');ellipse(8.0,-7.4,.55,.36,.26,'#334c52');
  line([[6.8,-7.4,.55],[7.25,-7.4,1.15],[7.95,-7.4,.55],[7.4,-7.4,.55],[7.25,-7.4,1.15]],'#334c52',2);
  for(const p of dustPoints)ellipse(p.x,p.z,0,.024,.014,'#c2a47635');
  line([[-9.8,-6.8,.03],[9.8,-6.8,.03],[9.8,6.8,.03],[-9.8,6.8,.03],[-9.8,-6.8,.03]],'#fff5d6',1.8);
  line([[-4,4.6,.04],[4,4.6,.04]],'#fff5d6',1.8);
  const center=pos(0,0);ctx.beginPath();ctx.ellipse(...center,1.08*u,1.08*u*INV_SQRT2,0,0,Math.PI*2);ctx.strokeStyle='#fff5d6';ctx.lineWidth=1.8;ctx.stroke();
  for(let x of [-7.4,7.4]){box(x,7.45,2.25,.58,.12,'#a85e47','#884b38','#96533e',.52);box(x,7.72,2.25,.12,.38,'#a85e47','#884b38','#96533e',.72);}
 }

 return{
  fallback:true,
  setZoomMode(m){zoomMode=m||'auto';updateScale();},
  getZoomMode(){return zoomMode;},
  update(g,me,time,dt=.016){
   const aspect=(w||1)/(h||1);
   targetMult=(zoomMode==='close'||(zoomMode==='auto'&&aspect<0.95))?1.32:zoomMode==='wide'?0.90:1.0;
   if(Math.abs(curMult-targetMult)>0.001){
    curMult+=(targetMult-curMult)*Math.min(1,dt*18);
    updateScale();
   }
   const mine=g.players.find(p=>p.id===me);
   const useClose=zoomMode==='close'||(zoomMode==='auto'&&aspect<0.95);
   const targetCamX=(mine&&useClose&&(g.phase==='opening'||g.phase==='chase'))?clamp(mine.x*0.38,-3.6,3.6):0;
   const targetCamZ=(mine&&useClose&&(g.phase==='opening'||g.phase==='chase'))?clamp(mine.z*0.35,-2.4,2.4):0;
   camX+=(targetCamX-camX)*Math.min(1,dt*22);
   camZ+=(targetCamZ-camZ)*Math.min(1,dt*22);
   background();

   // Restricted Tower Zone Ring (r = TOWER_ZONE_RADIUS = 1.85m)
   if(g.phase==='chase'){
    const anyDefInZone=g.players.some(q=>q.alive&&q.team!==g.attack&&q.inTowerZone);
    const [zx,zy]=pos(0,0);
    ctx.beginPath();ctx.ellipse(zx,zy,TOWER_ZONE_RADIUS*u,TOWER_ZONE_RADIUS*u*INV_SQRT2,0,0,Math.PI*2);
    ctx.fillStyle=anyDefInZone?'rgba(255,90,36,0.14)':'rgba(255,122,47,0.06)';ctx.fill();
    ctx.save();ctx.setLineDash([8,6]);
    ctx.strokeStyle=anyDefInZone?'#ff3b1f':'#ff8a38';ctx.lineWidth=2.4;ctx.stroke();
    ctx.restore();
   }

   // Center circle radial placement progress ring
   const placingBuilder=g.players.find(p=>p.place>0);
   if(placingBuilder){
    const [cx,cy]=pos(0,0),prog=Math.min(1,placingBuilder.place/.65);
    ctx.beginPath();ctx.ellipse(cx,cy,1.18*u,1.18*u*INV_SQRT2,0,-Math.PI/2,-Math.PI/2+prog*Math.PI*2);
    ctx.strokeStyle='#34b8a8';ctx.lineWidth=4.5;ctx.stroke();
   }
   // Highlight nearest loose stone for local builder
   if(mine&&mine.alive&&mine.team===g.attack&&mine.carry===null&&g.phase==='chase'){
    const near=g.stones.filter(s=>!s.placed&&s.held===null).sort((a,b)=>Math.hypot(mine.x-a.x,mine.z-a.z)-Math.hypot(mine.x-b.x,mine.z-b.z))[0];
    if(near&&Math.hypot(mine.x-near.x,mine.z-near.z)<1.6){
     const [sx,sy]=pos(near.x,near.z,.05);
     ctx.beginPath();ctx.ellipse(sx,sy,.52*u,.52*u*INV_SQRT2,0,0,Math.PI*2);
     ctx.strokeStyle='#ffe875';ctx.lineWidth=2.5;ctx.stroke();
    }
   }

   // Draw active Power-Up Burst Shockwaves
   for(const bData of (g.bursts||[])){
    const age=g.clock-bData.at;
    if(age>=0&&age<0.65){
     const prog=clamp(age/0.65,0,1);
     const [bx,by]=pos(bData.x,bData.z,.05);
     const rad=(0.4+prog*2.2)*u;
     ctx.beginPath();ctx.ellipse(bx,by,rad,rad*INV_SQRT2,0,0,Math.PI*2);
     ctx.strokeStyle=BUFF_HEX[bData.type]||'#ffaa38';
     ctx.globalAlpha=(1-prog)*0.85;ctx.lineWidth=3;ctx.stroke();ctx.globalAlpha=1;
    }
   }

   // Draw spawned Courtyard Power-Up Pads
   for(const pu of (g.powerups||[])){
    const [px,py]=pos(pu.x,pu.z,.05);
    const pulse=1+Math.sin(time*5.5)*0.08;
    ctx.beginPath();ctx.ellipse(px,py,.48*u*pulse,.48*u*INV_SQRT2*pulse,0,0,Math.PI*2);
    ctx.fillStyle=(pu.color||'#ffe066')+'33';ctx.fill();
    ctx.strokeStyle=pu.color||'#ffe066';ctx.lineWidth=2.5;ctx.stroke();
    const bob=Math.sin(time*3.8+pu.x)*0.08;
    ellipse(pu.x,pu.z,.48+bob,.22,.22,pu.color||'#ffe066');
    ctx.font='800 '+Math.max(8,u*.18)+'px sans-serif';ctx.textAlign='center';
    const lbl=pu.name.toUpperCase();
    const lw=ctx.measureText(lbl).width+10;
    ctx.fillStyle=pu.color||'#d88820';ctx.beginPath();ctx.roundRect(px-lw/2,py-u*1.05,lw,15,7);ctx.fill();
    ctx.fillStyle='#fff9e9';ctx.fillText(lbl,px,py-u*1.05+11);
   }

   // Update & draw subtle movement dust puffs
   for(let i=puffs.length-1;i>=0;i--){
    puffs[i].life-=dt;
    if(puffs[i].life<=0)puffs.splice(i,1);
    else{
     const pf=puffs[i],alpha=Math.max(0,pf.life/.35);
     ellipse(pf.x,pf.z,.05,.18+(1-alpha)*.18,.09+(1-alpha)*.09,`rgba(238,220,186,${(alpha*.42).toFixed(2)})`);
    }
   }

   const draw=[];
   // Per-planter depth-sorted layers to preserve true occlusion
   for(const o of COVER)draw.push({z:o.z,fn:()=>{box(o.x,o.z,o.w,o.h,.58,'#e3b98a','#a96848','#c27b57');for(let i=0;i<5;i++)ellipse(o.x-.56+i*.28,o.z,.86,.34,.24,i%2?'#88aa6c':'#5f8e63');}});
   let stacked=0;
   for(let i=0;i<7;i++){
    let s=g.stones[i];
    if(!s||s.placed){let y=.12+stacked++*.13;draw.push({z:.1,fn:()=>stone(0,0,y,i)});}
    else if(!s.held)draw.push({z:s.z,fn:()=>stone(s.x,s.z,.12,i)});
   }
   // Render both real players and Kathputli decoys identically in 2D fallback mode
   const allChars=[...g.players,...(g.decoys||[])];
   for(const p of allChars){
    if(p.alive===false)continue;
    const isLocal=p.id===me||p.ownerId===me;
    let moving=g.phase==='chase'&&g.ball.holder!==p.id&&!p.charging&&(p.anim||0)<=0&&Math.hypot(p.mx||0,p.mz||0)>.1;
    if(moving&&Math.random()<.28&&puffs.length<28)puffs.push({x:p.x-(p.ax||0)*.22+(Math.random()-.5)*.18,z:p.z-(p.az||-1)*.22+(Math.random()-.5)*.18,life:.35});
    draw.push({z:p.z,fn:()=>{
     const [x,y]=pos(p.x,p.z);
     ellipse(p.x+.06,p.z+.08,.01,.46,.22,'#5c4a3238');
     // Active Power-Up Aura Ring (shared by both player and decoy)
     if(p.buff&&(p.buffTime||0)>0){
      const expiring=p.buffTime<1.5;
      if(!expiring||Math.sin(time*28)>-0.25){
       ctx.beginPath();ctx.ellipse(x,y,.66*u,.66*u*INV_SQRT2,0,0,Math.PI*2);
       ctx.strokeStyle=BUFF_HEX[p.buff]||'#ffe066';ctx.lineWidth=2.6;ctx.stroke();
      }
     }
     ctx.beginPath();ctx.ellipse(x,y,.48*u,.48*u*INV_SQRT2,0,0,Math.PI*2);
     ctx.strokeStyle=p.inTowerZone?'#ff7828':(isLocal?'#fffbed':p.team?'#e26d52cc':'#28a89ccc');
     ctx.lineWidth=isLocal?2.8:2;ctx.stroke();
     let pose=moving?(Math.sin(time*13)>0?1:2):0,
         dir=((Math.round(Math.atan2(p.ax||0,p.az||-1)/(Math.PI/4))%8)+8)%8;
     if(sprites.complete&&sprites.naturalWidth>=1024){
      // Exact REDESIGN_RECOVERY.md foot-anchor projection: drawn size 2.24x2.8 world units, offset (-1.12, -2.16756)
      ctx.drawImage(sprites,(dir*3+pose)*128,p.team*160,128,160,x-1.12*u,y-2.16756*u,2.24*u,2.8*u);
     }else{
      ellipse(p.x,p.z,.7,.3,.38,p.team?'#df7159':'#298882');ellipse(p.x,p.z,1.35,.3,.3,'#c87e53');
     }
     if(p.carry!==null&&p.carry!==undefined)stone(p.x+(p.ax||0)*.35,p.z+(p.az||-1)*.35,1.0,p.carry);
     const title=isLocal?'YOU':p.name;ctx.font='700 '+Math.max(9,u*.22)+'px sans-serif';ctx.textAlign='center';
     const width=ctx.measureText(title).width+14;
     ctx.fillStyle=p.team?'#c85a42':'#1f726b';ctx.beginPath();ctx.roundRect(x-width/2,y-u*2.15,width,18,9);ctx.fill();
     ctx.fillStyle='#fff9e9';ctx.fillText(title,x,y-u*2.15+13);
    }});
   }
   for(const d of draw.sort((a,b)=>a.z-b.z))d.fn();

   // Render Judwaa Twin Ball if active
   if(g.twinBall){
    const tb=g.twinBall;
    ellipse(tb.x,tb.z,0,.22,.11,'#6b583938');
    ellipse(tb.x,tb.z,.78,.21,.21,'#ffdf38');
   }

   let p=g.players.find(p=>p.id===g.ball.holder),b=g.ball,bx=b.x+(p?p.ax*.4:0),bz=b.z+(p?p.az*.4:0),by=p?1.12:b.mode==='flight'?.82:Math.max(.22,b.y||.22);
   if(b.mode==='flight'){trail.push({x:bx,z:bz,y:by,t:.18});}
   for(let i=trail.length-1;i>=0;i--){
    trail[i].t-=dt;
    if(trail[i].t<=0)trail.splice(i,1);
    else{const tr=trail[i],a=tr.t/.18;ellipse(tr.x,tr.z,tr.y,.18*a,.18*a,`rgba(250,224,108,${(a*.55).toFixed(2)})`);}
   }
   ellipse(b.x,b.z,0,.24,.12,'#6b583938');ellipse(bx,bz,by,.22,.22,'#d9a136');ellipse(bx-.05,bz,by+.06,.13,.13,'#f6d365');
   if(mine&&b.holder===me){
    const passTarget=findPassTarget(g,mine,mine.ax,mine.az);
    if(passTarget){
     const [ptx,pty]=pos(passTarget.x,passTarget.z,.05);
     ctx.beginPath();ctx.ellipse(ptx,pty,.64*u,.64*u*INV_SQRT2,0,0,Math.PI*2);
     ctx.strokeStyle='#38f2d8';ctx.lineWidth=2.8;ctx.stroke();
    }
    const chg=clamp(mine.charge||0,0,1);
    const damp=mine.inTowerZone&&!passTarget?0.58:1;
    const len=passTarget?Math.min(7.5,Math.hypot(passTarget.x-mine.x,passTarget.z-mine.z)):(3.6+chg*3.4)*damp;
    const ex=mine.x+mine.ax*len,ez=mine.z+mine.az*len,px=-mine.az*.32,pz=mine.ax*.32,ax0=ex-mine.ax*.45,az0=ez-mine.az*.45;
    ctx.setLineDash([6,6]);line([[mine.x,mine.z,.05],[ex,ez,.05]],passTarget?'#38f2d8':'#fff9e5',2.6);ctx.setLineDash([]);
    line([[ax0+px,az0+pz,.05],[ex,ez,.05],[ax0-px,az0-pz,.05]],passTarget?'#38f2d8':'#ffe875',2.8);
   }
   if(!bgImg.complete||!bgImg.naturalWidth){tree(-12,6.4);tree(12,6.4);}
  },
  dispose(){ro.disconnect();canvas.remove();}
 };
}
