// Shared rules: used by practice and the authoritative room server.
import {COVER,COURT_PROPS,ALL_OBSTACLES,COURT_BOUNDS,clamp,blocked,coverContact,reachablePoint,waypoint} from './navigation.js';
export {COVER,COURT_PROPS,ALL_OBSTACLES,COURT_BOUNDS,clamp,waypoint} from './navigation.js';
const d=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);

// Restricted zone around the center stone tower (0,0) where defenders experience reduced speed & throw power
export const TOWER_ZONE_RADIUS=1.85;

// 6 Strategically balanced, symmetric power-up spawn pads outside the tower zone and obstacles
export const POWERUP_SPAWNS=[
 {x:-4.2,z:-2.8},
 {x: 4.2,z: 2.8},
 {x:-6.6,z:-0.8},
 {x: 6.6,z: 0.8},
 {x:-2.6,z:-3.9},
 {x: 2.6,z: 3.9}
];

export const POWERUP_TYPES=Object.freeze([
 Object.freeze({id:'chappal',name:'Chappal Dash',duration:5.0,color:'#38d6ff'}),
 Object.freeze({id:'genda',name:'Genda Shield',duration:8.0,color:'#ffa826'}),
 Object.freeze({id:'mirchi',name:'Mirchi Bomb',duration:5.5,color:'#ff4228'}),
 Object.freeze({id:'banta',name:'Nimbu Pani Fizz',duration:6.5,color:'#68ee44'}),
 Object.freeze({id:'judwaa',name:'Judwaa Split-Ball',duration:7.5,color:'#ffde38'}),
 Object.freeze({id:'kathputli',name:'Kathputli Decoy',duration:6.0,color:'#e85298'})
]);
Object.freeze(POWERUP_SPAWNS);POWERUP_SPAWNS.forEach(Object.freeze);

export function player(id,name,team,bot=false){
 return{
  id,name,team,bot,x:0,z:0,ax:0,az:-1,mx:0,mz:0,
  alive:true,carry:null,place:0,cool:0,held:0,charge:0,charging:false,
  seq:-1,action:'',last:0,anim:0,look:0,
  inTowerZone:false,buff:null,buffTime:0,buffMax:0,stun:0,stunVx:0,stunVz:0
 };
}

export function sanitizeTeamSize(v,fallback=3){
 const n=Math.floor(Number(v));
 return Number.isFinite(n)?clamp(n,2,4):fallback;
}

export function normalizeTeamSizes(raw,fallback=[3,3]){
 if(Array.isArray(raw)&&raw.length>=2){
  return [sanitizeTeamSize(raw[0],fallback[0]||3),sanitizeTeamSize(raw[1],fallback[1]||3)];
 }
 return [sanitizeTeamSize(fallback[0],3),sanitizeTeamSize(fallback[1],3)];
}

export function createGame(code='PRACTICE',teamSizes=[3,3]){
 const ts=normalizeTeamSizes(teamSizes,[3,3]);
 return{
  code,phase:'lobby',players:[],host:'',teamSizes:ts,round:0,targetRounds:6,roundDuration:60,
  attack:0,scores:[0,0],time:60,clock:0,last:0,stack:7,stones:[],attempts:3,
  ball:{x:0,z:4.6,y:0.24,vx:0,vz:0,vy:0,mode:'held',holder:null,lock:0,power:0,passTo:null,ricochets:0},
  twinBall:null,powerups:[],decoys:[],bursts:[],nextPowerupAt:4.2,powerupSeq:0,
  message:'Gather your friends',event:0,until:0,striker:null,lastScatterAt:-9,sfxSeq:0,sfxType:''
 };
}

const SFX_PRIORITY={
 towerZoneWarn:1,
 powerupExpire:2,
 powerupSpawn:3,
 pickup:4,
 pass:5,
 catch:5,
 throw:6,
 ricochet:6,
 powerupChappal:7,
 powerupGenda:7,
 powerupBanta:7,
 powerupJudwaa:7,
 powerupKathputli:7,
 powerupMirchi:8,
 shieldBlock:8,
 decoyPop:8,
 stonePlaced:9,
 playerOut:9,
 whistle:9,
 scatter:10,
 roundEnd:10,
 fanfare:10
};

function emitSfx(g,type){
 // Prevent low-priority ambient cues (like towerZoneWarn) from overwriting primary gameplay SFX in the same tick
 if(g._sfxTick===g.clock&&(SFX_PRIORITY[type]||5)<(SFX_PRIORITY[g.sfxType]||0))return;
 g._sfxTick=g.clock;
 g.sfxSeq=(g.sfxSeq||0)+1;
 g.sfxType=type;
}

const DEFENDER_SPAWN_X=Object.freeze({
 1:Object.freeze([0]),
 2:Object.freeze([-1.9,1.9]),
 3:Object.freeze([-2.2,0,2.2]),
 4:Object.freeze([-3.3,-1.1,1.1,3.3])
});
const SUPPORT_SPAWN_X=Object.freeze({
 0:Object.freeze([]),
 1:Object.freeze([-2.4]),
 2:Object.freeze([-2.4,2.4]),
 3:Object.freeze([-2.6,0,2.6])
});

export function resetRound(g){
 g.attack=g.round%2;
 const dur=g.roundDuration||60;
 Object.assign(g,{
  time:dur,attempts:3,stack:7,stones:[],phase:'opening',until:8,ready:2.5,clock:0,
  outcome:null,lastScatterAt:-9,twinBall:null,powerups:[],decoys:[],bursts:[],nextPowerupAt:4.2
 });
 // Preserve each team's exact roster & player count (2..4) across Attacking/Defending side swaps!
 const defTeam=1-g.attack;
 const defPlayers=g.players.filter(p=>p.team===defTeam);
 const defX=DEFENDER_SPAWN_X[clamp(defPlayers.length,1,4)]||DEFENDER_SPAWN_X[3];
 defPlayers.forEach((p,i)=>{
  Object.assign(p,{
   alive:true,carry:null,place:0,cool:0,charge:0,charging:false,explicitCharge:false,action:'',
   mx:0,mz:0,x:defX[i]??((i-(defPlayers.length-1)/2)*2.0),z:-3.8,ax:0,az:1,
   held:0,last:0,interact:false,anim:0,goalStone:null,
   inTowerZone:false,buff:null,buffTime:0,buffMax:0,stun:0,stunVx:0,stunVz:0
  });
 });
 const ps=g.players.filter(p=>p.team===g.attack);
 for(const p of ps){
  Object.assign(p,{
   alive:true,carry:null,place:0,cool:0,charge:0,charging:false,explicitCharge:false,action:'',
   mx:0,mz:0,x:0,z:5,ax:0,az:-1,
   held:0,last:0,interact:false,anim:0,goalStone:null,
   inTowerZone:false,buff:null,buffTime:0,buffMax:0,stun:0,stunVx:0,stunVz:0
  });
 }
 // In single-player practice, let 'you' take the opening striker shot whenever your team attacks
 const youStriker=ps.find(p=>p.id==='you');
 g.striker=(youStriker||ps[Math.floor(g.round/2)%ps.length]).id;
 let p=g.players.find(p=>p.id===g.striker);
 p.x=0;p.z=4.6;
 const nonStrikers=ps.filter(q=>q.id!==p.id);
 const supX=SUPPORT_SPAWN_X[clamp(nonStrikers.length,0,3)]||SUPPORT_SPAWN_X[2];
 nonStrikers.forEach((q,i)=>{
  q.x=supX[i]??((i-(nonStrikers.length-1)/2)*2.4);
  q.z=5;
 });
 g.ball={x:0,z:4.6,y:0.24,vx:0,vz:0,vy:0,mode:'held',holder:p.id,lock:0,from:null,power:0,passTo:null,ricochets:0};
 g.message='Knock down the seven stones';
 emitSfx(g,'whistle');
 g.event++;
}

const BOT_ROSTER=Object.freeze([
 Object.freeze({name:'Kabir',look:2}),
 Object.freeze({name:'Tara',look:1}),
 Object.freeze({name:'Mira',look:3}),
 Object.freeze({name:'Aadi',look:4}),
 Object.freeze({name:'Nila',look:5}),
 Object.freeze({name:'Dev',look:6}),
 Object.freeze({name:'Zoya',look:7}),
 Object.freeze({name:'Aarav',look:0})
]);

export function start(g,fill=true,customSizes=null){
 if(customSizes)g.teamSizes=normalizeTeamSizes(customSizes,g.teamSizes||[3,3]);
 else g.teamSizes=normalizeTeamSizes(g.teamSizes,[3,3]);
 // Deduplicate any existing human player looks so every human has a unique character (0..7)
 const usedLooks=new Set();
 const usedNames=new Set();
 for(const p of g.players){
  let lk=Math.max(0,Math.floor(Number(p.look)||0))%8;
  if(usedLooks.has(lk)){
   for(let cand=0;cand<8;cand++){if(!usedLooks.has(cand)){lk=cand;break;}}
  }
  p.look=lk;
  usedLooks.add(lk);
  if(p.name)usedNames.add(p.name);
 }
 if(fill){
  for(let t=0;t<2;t++){
   const targetCount=g.teamSizes[t];
   for(let i=g.players.filter(p=>p.team===t).length;i<targetCount;i++){
    const b=BOT_ROSTER.find(cand=>!usedLooks.has(cand.look)&&!usedNames.has(cand.name))||
            BOT_ROSTER.find(cand=>!usedLooks.has(cand.look))||
            BOT_ROSTER[(t*4+i)%BOT_ROSTER.length];
    usedLooks.add(b.look);
    usedNames.add(b.name);
    g.players.push({...player('bot-'+t+'-'+i,b.name,t,true),look:b.look});
   }
  }
 }
 const t0=g.players.filter(p=>p.team===0).length;
 const t1=g.players.filter(p=>p.team===1).length;
 const minPerTeam=(fill||customSizes)?2:1;
 if(t0<minPerTeam||t0>4||t1<minPerTeam||t1>4||(!fill&&!customSizes&&t0!==t1)){
  throw Error('Each team requires between 2 and 4 players (2v2 up to 4v4). Enable practice teammates or add players.');
 }
 g.teamSizes=[t0,t1];
 g.round=0;g.scores=[0,0];g.history=[];
 resetRound(g);
}

export function findPassTarget(g,p,ax=p?.ax||0,az=p?.az||-1){
 if(!g||!p||g.phase!=='chase'||p.team===g.attack)return null;
 const al=Math.hypot(ax,az)||1,nx=ax/al,nz=az/al;
 let best=null,bestScore=0.85;
 for(const q of g.players){
  if(q.team!==p.team||q.id===p.id||!q.alive)continue;
  const dist=d(p,q);
  if(dist<0.4||dist>13.5)continue;
  const dx=(q.x-p.x)/dist,dz=(q.z-p.z)/dist;
  const align=dx*nx+dz*nz;
  if(align<=bestScore)continue;
  const enemyBlocking=g.players.some(e=>{
   if(e.team!==g.attack||!e.alive)return false;
   const ed=d(p,e);
   if(ed>=dist||ed<0.2)return false;
   const edx=(e.x-p.x)/ed,edz=(e.z-p.z)/ed;
   return (edx*nx+edz*nz)>0.94;
  });
  if(enemyBlocking)continue;
  const score=align-dist*0.004;
  if(score>bestScore){bestScore=score;best=q;}
 }
 return best;
}

export function command(g,id,i){
 const p=g.players.find(p=>p.id===id);
 if(!p||!i||typeof i!=='object'||!Number.isFinite(i.seq)||i.seq<=p.seq||(i.round!==undefined&&i.round!==g.round))return;
 p.seq=Math.min(i.seq,p.seq+100000);
 const num=v=>Number.isFinite(v)?clamp(v,-1,1):0;
 p.mx=num(i.mx);p.mz=num(i.mz);
 let l=Math.hypot(p.mx,p.mz);
 if(l>1){p.mx/=l;p.mz/=l;l=1;}
 let ax=num(i.ax),az=num(i.az),a=Math.hypot(ax,az);
 // During opening phase, only the striker adjusts aim; non-holders in chase face movement direction
 if(g.phase!=='opening'&&g.ball.holder!==p.id&&l>.12){
  p.ax=p.mx/l;p.az=p.mz/l;
 }else if(g.phase==='opening'&&p.id!==g.striker&&l>.12){
  p.ax=p.mx/l;p.az=p.mz/l;
 }else if(a>.1){
  p.ax=ax/a;p.az=az/a;
 }
 p.interact=!!i.interact;
 if(i.action==='cancel'){
  p.charge=0;p.charging=false;p.explicitCharge=false;p.action='cancel';
  p.last=g.clock;
  return;
 }
 p.charging=!!i.charging;
 if(Number.isFinite(i.charge)){
  p.charge=clamp(i.charge,0,1);
  p.explicitCharge=true;
 }
 p.action=(g.ready||0)<=0&&['opening','chase'].includes(g.phase)&&['throw','pass','drop','interact','cancel'].includes(i.action)?i.action:'';
 p.last=g.clock;
}

function finish(g,win,msg,reason){
 if(!['opening','chase'].includes(g.phase))return;
 if(win)g.scores[g.attack]++;
 const dur=g.roundDuration||60;
 g.phase='result';g.until=4;g.message=msg;
 g.twinBall=null;g.decoys=[];
 g.outcome={round:g.round+1,winner:win?g.attack:1-g.attack,reason,stones:g.stack,out:g.players.filter(p=>p.team===g.attack&&!p.alive).length,builders:g.players.filter(p=>p.team===g.attack).length,elapsed:Math.max(0,dur-g.time),point:!!win};
 g.history=[...(g.history||[]),g.outcome].slice(-8);
 emitSfx(g,win?'fanfare':'roundEnd');
 g.event++;
}

function obstacleNormal(x,z,vx,vz,r=.24){
 let bestDist=Infinity,nx=0,nz=0;
 for(const o of ALL_OBSTACLES){
  const hw=o.w/2+r,hh=o.h/2+r;
  const dx=x-o.x,dz=z-o.z;
  if(Math.abs(dx)<=hw+0.18&&Math.abs(dz)<=hh+0.18){
   const ox=hw-Math.abs(dx),oz=hh-Math.abs(dz);
   if(ox<oz&&ox<bestDist){bestDist=ox;nx=dx>=0?1:-1;nz=0;}
   else if(oz<=ox&&oz<bestDist){bestDist=oz;nx=0;nz=dz>=0?1:-1;}
  }
 }
 if(nx===0&&nz===0){
  const sp=Math.hypot(vx,vz)||1;
  return{nx:-vx/sp,nz:-vz/sp};
 }
 return{nx,nz};
}

function scatter(g,ball,prevX=0,prevZ=1){
 const dur=g.roundDuration||60;
 g.phase='chase';g.time=dur;
 g.nextPowerupAt=g.clock+4.0;
 const pwr=ball&&Number.isFinite(ball.power)?clamp(ball.power,0,1):0.85;
 const isLightShot=ball&&ball.explicitCharge&&pwr<0.52;
 const knocked=isLightShot?(pwr<0.25?4:5):7;
 const remain=7-knocked;
 g.stack=remain;
 g.lastScatterAt=g.clock;

 const bvx=ball?.vx||0,bvz=ball?.vz||-10,bspeed=Math.hypot(bvx,bvz)||10;
 const dirX=bvx/bspeed,dirZ=bvz/bspeed;
 const perpX=-dirZ,perpZ=dirX;

 const colRadius=0.55;
 const rawLat=-(prevX*perpX+prevZ*perpZ);
 const sinImpact=clamp(rawLat/colRadius,-0.96,0.96);
 const cosImpact=Math.sqrt(Math.max(0.06,1-sinImpact*sinImpact));

 const contactX=(sinImpact*perpX-cosImpact*dirX)*0.48;
 const contactZ=(sinImpact*perpZ-cosImpact*dirZ)*0.48;

 const struckLayer=clamp(Math.floor(pwr*5.2)+1,1,6);
 const facetSeed=struckLayer*0.85+(g.round||0)*1.37+bspeed*0.41+(prevX*2.9-prevZ*1.7)+g.clock*1.9;
 const bevelTilt=Math.sin(facetSeed)*0.68+(Math.cos(facetSeed*1.7)>=0?0.34:-0.34);

 const glanceWeight=Math.pow(Math.abs(sinImpact),0.75);
 const effectiveLat=glanceWeight>0.22
  ? Math.sign(sinImpact)*(0.42+0.54*glanceWeight)+Math.sin(facetSeed)*0.18
  : clamp(bevelTilt,-0.92,0.92);

 const normalReflectMix=clamp(0.32+0.48*(1-pwr)+0.35*Math.abs(sinImpact)+0.22*Math.cos(facetSeed*1.3),0.22,0.95);
 const forwardCarry=Math.cos(normalReflectMix*Math.PI*0.72);
 const sideDeflect=Math.sign(effectiveLat||1)*Math.sqrt(Math.max(0.18,1-forwardCarry*forwardCarry));

 let rebDirX=dirX*forwardCarry+perpX*sideDeflect;
 let rebDirZ=dirZ*forwardCarry+perpZ*sideDeflect;
 const rebLen=Math.hypot(rebDirX,rebDirZ)||1;
 rebDirX/=rebLen;rebDirZ/=rebLen;

 const restitution=0.31+0.10*pwr+0.07*Math.abs(sinImpact);
 const reboundSpeed=bspeed*restitution;
 const launchVy=1.25+0.85*pwr+0.25*cosImpact;

 const spreadScale=0.96+pwr*0.68;
 g.stones=Array.from({length:7},(_,i)=>{
  if(i<remain){
   return{id:i,x:0,z:0,held:null,placed:true,placedAt:0,scatterAt:-9,peakY:0,spin:0};
  }
  const stoneAngle=i*Math.PI*2/7+0.32+sinImpact*0.35;
  const baseR=(1.25+(i%3)*0.56)*spreadScale;
  const impulsePush=(0.38+(i%3)*0.22)*(0.65+pwr*0.55);
  const tx=Math.cos(stoneAngle)*baseR+dirX*impulsePush-perpX*sinImpact*0.45;
  const tz=Math.sin(stoneAngle)*baseR+dirZ*impulsePush-perpZ*sinImpact*0.45;
  const pt=reachablePoint({x:clamp(tx,-7.5,7.5),z:clamp(tz,-4.8,4.8)},.35);
  return{
   id:i,x:pt.x,z:pt.z,held:null,placed:false,
   scatterAt:g.clock,
   fromY:0.28+i*0.135,
   peakY:0.68+(i%3)*0.34+pwr*0.68,
   spin:(i%2?1:-1)*(4.8+pwr*6.2)
  };
 });

 const startPt=reachablePoint({
  x:clamp(contactX+rebDirX*0.32,-9.4,9.4),
  z:clamp(contactZ+rebDirZ*0.32,-5.9,5.9)
 },.24);
 g.ball={
  x:startPt.x,
  z:startPt.z,
  y:0.58+0.20*pwr,
  vx:rebDirX*reboundSpeed,
  vz:rebDirZ*reboundSpeed,
  vy:launchVy,
  spin:(effectiveLat||0.5)*(9.0+pwr*6.0),
  mode:'loose',
  holder:null,
  lock:0.26,
  from:null,
  power:pwr,
  passTo:null,
  reboundAt:g.clock,
  ricochets:0
 };
 g.message=remain>0?`${knocked} stones knocked off! Rebuild the rest!`:'All 7 stones blasted! Rebuild the tower!';
 emitSfx(g,'scatter');
 g.event++;
}

// Detonate Mirchi Bomb spicy sneeze burst around player p
function triggerMirchiBurst(g,p){
 g.bursts=[...(g.bursts||[]).filter(b=>g.clock-b.at<1.2),{type:'mirchi',x:p.x,z:p.z,at:g.clock}];
 let hitCount=0;
 for(const q of g.players){
  if(q.team===p.team||!q.alive)continue;
  const dist=d(p,q);
  if(dist<=2.9){
   if(q.buff==='genda'){
    q.buff=null;q.buffTime=0;
    g.bursts.push({type:'genda',x:q.x,z:q.z,at:g.clock});
    continue;
   }
   const nx=(q.x-p.x)/Math.max(0.1,dist),nz=(q.z-p.z)/Math.max(0.1,dist);
   q.stun=0.85;
   q.stunVx=nx*4.8;
   q.stunVz=nz*4.8;
   q.place=0;q.charging=false;q.charge=0;
   if(g.ball.holder===q.id){
    Object.assign(g.ball,{mode:'loose',holder:null,from:q.id,lock:0.65,passTo:null,vx:nx*3.4,vz:nz*3.4,vy:2.1,y:0.68});
   }
   if(q.carry!==null){
    const st=g.stones[q.carry];
    if(st){
     const dropPt=reachablePoint({x:clamp(q.x+nx*0.55,-8.5,8.5),z:clamp(q.z+nz*0.55,-5.2,5.2)},.30);
     Object.assign(st,{held:null,x:dropPt.x,z:dropPt.z});
    }
    q.carry=null;
   }
   hitCount++;
  }
 }
 p.buff=null;p.buffTime=0;
 g.message=hitCount>0?`${p.name}'s Mirchi Bomb made ${hitCount} opponent${hitCount>1?'s':''} sneeze!`:`${p.name} popped a Mirchi Bomb!`;
 emitSfx(g,'powerupMirchi');
 g.event++;
}

// Spawn a balanced courtyard power-up on an unoccupied pad equidistant from active players
function spawnCourtyardPowerup(g){
 g.powerups=g.powerups||[];
 if(g.powerups.length>=2)return;
 const freePads=POWERUP_SPAWNS.filter(pad=>!g.powerups.some(pu=>Math.hypot(pu.x-pad.x,pu.z-pad.z)<1.2));
 if(!freePads.length)return;
 // Pick pad with best balance between nearest attacker and nearest defender (and not right under a player's feet)
 const attackers=g.players.filter(p=>p.team===g.attack&&p.alive);
 const defenders=g.players.filter(p=>p.team!==g.attack&&p.alive);
 let bestPad=freePads[0],bestScore=-999;
 for(const pad of freePads){
  const minAny=Math.min(...g.players.filter(p=>p.alive).map(p=>d(p,pad)),99);
  if(minAny<1.4)continue;
  const dAtt=attackers.length?Math.min(...attackers.map(p=>d(p,pad))):5;
  const dDef=defenders.length?Math.min(...defenders.map(p=>d(p,pad))):5;
  const fairness=-Math.abs(dAtt-dDef)*0.8+Math.min(dAtt,dDef)*0.25+Math.sin((g.powerupSeq+1)*2.1+pad.x)*0.35;
  if(fairness>bestScore){bestScore=fairness;bestPad=pad;}
 }
 const idx=((g.round||0)*2+(g.powerupSeq||0))%POWERUP_TYPES.length;
 const spec=POWERUP_TYPES[idx];
 g.powerupSeq=(g.powerupSeq||0)+1;
 g.powerups.push({
  uid:'pu-'+g.powerupSeq,
  type:spec.id,
  name:spec.name,
  color:spec.color,
  duration:spec.duration,
  x:bestPad.x,
  z:bestPad.z,
  spawnAt:g.clock
 });
 emitSfx(g,'powerupSpawn');
}

function activatePowerup(g,p,pu){
 g.bursts=[...(g.bursts||[]).filter(b=>g.clock-b.at<1.2),{type:pu.type,x:pu.x,z:pu.z,at:g.clock}];
 if(pu.type==='kathputli'){
  // Spawn an animated 3D decoy clone that visually matches the player (colors, cosmetics, animations)
  const perpX=-(p.az||-1),perpZ=(p.ax||0);
  const spawnPt=reachablePoint({
   x:clamp(p.x+(p.ax||0)*0.45+perpX*0.42,-9.0,9.0),
   z:clamp(p.z+(p.az||-1)*0.45+perpZ*0.42,-5.5,5.5)
  },.30);
  g.decoys=[...(g.decoys||[]).slice(-2),{
   id:'decoy-'+(++g.powerupSeq),
   ownerId:p.id,
   name:p.name,
   team:p.team,
   look:p.look,
   alive:true,
   carry:p.carry,
   place:0,
   anim:0,
   charge:0,
   charging:false,
   inTowerZone:false,
   buff:'kathputli',
   buffTime:pu.duration,
   buffMax:pu.duration,
   x:spawnPt.x,
   z:spawnPt.z,
   ax:p.ax||0,
   az:p.az||-1,
   mx:p.mx||0,
   mz:p.mz||0,
   spawnAt:g.clock,
   until:g.clock+pu.duration
  }];
  p.buff='kathputli';p.buffTime=pu.duration;p.buffMax=pu.duration;
  g.message=`${p.name} deployed a Kathputli Decoy!`;
  emitSfx(g,'powerupKathputli');
  g.event++;
  return;
 }
 p.buff=pu.type;
 p.buffTime=pu.duration;
 p.buffMax=pu.duration;
 if(pu.type==='mirchi'){
  const enemyNear=g.players.some(q=>q.team!==p.team&&q.alive&&d(p,q)<=2.85);
  if(enemyNear){
   triggerMirchiBurst(g,p);
   return;
  }
 }
 g.message=`${p.name} picked up ${pu.name}!`;
 const sfxMap={
  chappal:'powerupChappal',
  genda:'powerupGenda',
  mirchi:'powerupMirchi',
  banta:'powerupBanta',
  judwaa:'powerupJudwaa'
 };
 emitSfx(g,sfxMap[pu.type]||'pickup');
 g.event++;
}

function release(g,p,pass){
 if(g.ball.holder!==p.id||p.cool>0)return;
 let x=p.ax,z=p.az;
 let pwr=pass?0.45:clamp(p.charge||0,0,1);
 const explicit=!!p.explicitCharge;
 let passTarget=null;
 if(g.phase==='chase'&&p.team!==g.attack){
  if(pass){
   let score=-9;
   for(const q of g.players.filter(q=>q.team===p.team&&q.id!==p.id&&q.alive)){
    let dist=d(p,q),s=((q.x-p.x)*x+(q.z-p.z)*z)/(dist||1)-dist*.01;
    if(s>score){score=s;passTarget=q;}
   }
  }else{
   passTarget=findPassTarget(g,p,x,z);
  }
  if(passTarget&&d(p,passTarget)>.05){
   let leadX=passTarget.x+passTarget.mx*0.22-p.x,leadZ=passTarget.z+passTarget.mz*0.22-p.z,dist=Math.hypot(leadX,leadZ)||1;
   x=leadX/dist;z=leadZ/dist;
  }
 }
 const isPass=!!(pass||passTarget);

 // Tower Restricted Zone penalty: defenders throwing (not passing) from inside the 1.85m tower ring have reduced throw power & speed
 const inRestricted=g.phase==='chase'&&p.team!==g.attack&&Math.hypot(p.x,p.z)<TOWER_ZONE_RADIUS;
 if(inRestricted&&!isPass){
  pwr*=0.42;
 }
 const isBanta=p.buff==='banta'&&!isPass;
 const isJudwaa=p.buff==='judwaa'&&!isPass&&g.phase==='chase';

 const baseSpd=isPass?11.8:(inRestricted?(7.6+pwr*2.2):(10+pwr*5.8));
 const spd=isBanta?baseSpd*1.18:baseSpd;

 // If Judwaa Split-Ball is active, split the throw into a tight 18-deg V-spread (main ball -9 deg, twin ball +9 deg)
 let mainX=x,mainZ=z;
 if(isJudwaa){
  const ang1=-0.155,c1=Math.cos(ang1),s1=Math.sin(ang1);
  mainX=x*c1-z*s1;mainZ=x*s1+z*c1;
  const ang2=0.155,c2=Math.cos(ang2),s2=Math.sin(ang2);
  const tx=x*c2-z*s2,tz=x*s2+z*c2;
  g.twinBall={
   x:p.x,z:p.z,y:0.92,vx:tx*spd,vz:tz*spd,vy:0.65+pwr*0.55,
   from:p.id,travel:0,lock:1,power:pwr,maxTravel:inRestricted?8.4:13.8
  };
  p.buff=null;p.buffTime=0;
  emitSfx(g,'powerupJudwaa');
 }else{
  emitSfx(g,isPass?'pass':'throw');
 }

 g.ball={
  x:p.x,z:p.z,y:0.92,vx:mainX*spd,vz:mainZ*spd,vy:0.65+pwr*0.55,
  mode:'flight',holder:null,from:p.id,travel:0,lock:1,power:pwr,
  explicitCharge:explicit,passTo:passTarget?passTarget.id:null,
  maxTravel:inRestricted&&!isPass?8.4:13.8,
  ricochets:isBanta?2:0
 };
 p.cool=.35;p.anim=.4;p.ax=x;p.az=z;p.held=0;p.charge=0;p.charging=false;p.explicitCharge=false;
}

function seg(px,pz,ax,az,bx,bz){
 let dx=bx-ax,dz=bz-az,t=clamp(((px-ax)*dx+(pz-az)*dz)/(dx*dx+dz*dz||1),0,1);
 return Math.hypot(px-ax-t*dx,pz-az-t*dz);
}

function ai(g,p){
 p.mx=p.mz=0;p.interact=false;p.action='';p.charging=false;
 if(!p.alive||(p.stun||0)>0)return;
 if(g.phase==='opening'){
  if(p.id===g.striker){
   const aimShift=Math.sin((g.round+1)*1.7+(g.attempts||1)*2.1)*0.055;
   const al=Math.hypot(aimShift,-1)||1;
   p.ax=aimShift/al;p.az=-1/al;p.charging=true;
   p.charge=clamp((p.charge||0)+0.04,0,1);
   if(g.clock>1){p.charge=0.85;p.action='throw';}
  }
  return;
 }
 if(g.phase!=='chase')return;
 let target;
 const b=g.ball;
 const holder=b.mode==='held'?g.players.find(q=>q.id===b.holder):null;

 // Opportunistically grab a nearby power-up if unencumbered and within 2.5m
 const builderStacking=g.players.some(q=>q.team===g.attack&&q.alive&&(q.place>0||Math.hypot(q.x,q.z)<1.2));
 const nearPu=!builderStacking?(g.powerups||[]).find(pu=>d(p,pu)<2.2&&!p.buff&&g.ball.holder!==p.id&&p.place<=0):null;

 if(p.team===g.attack){
  const mates=g.players.filter(q=>q.team===p.team&&q.alive),slot=mates.indexOf(p),angle=slot*Math.PI*2/Math.max(1,mates.length);
  const busy=mates.some(q=>q.id!==p.id&&(q.place>0||(q.carry!==null&&Math.hypot(q.x,q.z)<1.1)));
  if(nearPu&&p.carry===null){
   target=nearPu;
  }else if(p.carry!==null){
   target={x:Math.sin(angle)*(busy?1.65:.45),z:Math.cos(angle)*(busy?1.65:.45)};
   if(!busy&&d(p,target)<.22){p.interact=true;p.action='interact';}
  }else{
   const available=g.stones.filter(s=>!s.placed&&s.held===null);
   let stone=available.find(s=>s.id===p.goalStone);
   if(!stone){
    stone=available.filter(s=>!mates.some(q=>q.id!==p.id&&q.carry===null&&q.goalStone===s.id)).sort((a,b)=>d(p,a)-d(p,b))[0]||available[0];
    p.goalStone=stone?.id??null;
   }
   target=stone;
   if(stone&&d(p,stone)<.72){p.interact=true;p.action='interact';}
  }

  // 1. Evasive Juke & Planter Cover Seeking when a Defender holds the ball nearby and aims at builder!
  if(holder&&holder.team!==p.team&&p.place<=0.15){
   const hDist=d(p,holder);
   const toPx=(p.x-holder.x)/(hDist||1),toPz=(p.z-holder.z)/(hDist||1);
   const aimAlign=toPx*holder.ax+toPz*holder.az;
   if(hDist<4.0&&aimAlign>0.68&&(!holder.bot||p.held===0)&&p.carry===null){
    const jukeSign=Math.sin(g.clock*4.2+slot*2.3)>=0?1:-1;
    const perpX=-toPz*jukeSign,perpZ=toPx*jukeSign;
    let evasive={x:clamp(p.x+(toPx*0.65+perpX*1.35)*2.2,-8.8,8.8),z:clamp(p.z+(toPz*0.65+perpZ*1.35)*2.2,-5.8,5.8)};
    if(blocked(evasive.x,evasive.z)){
     evasive={x:clamp(p.x+(toPx*0.65-perpX*1.35)*2.2,-8.8,8.8),z:clamp(p.z+(toPz*0.65-perpZ*1.35)*2.2,-5.8,5.8)};
    }
    if(!(g.stack===6&&p.carry!==null&&Math.hypot(p.x,p.z)<1.1&&hDist>3.2)){
     target=reachablePoint(evasive,.3);
     p.interact=false;
    }
   }
  }

  // 2. High-reflex perpendicular dodge when ball is in flight
  if(b.mode==='flight'){
   const speed=Math.hypot(b.vx,b.vz)||1,vx=b.vx/speed,vz=b.vz/speed,dx=p.x-b.x,dz=p.z-b.z,along=dx*vx+dz*vz,side=dx*(-vz)+dz*vx;
   if(along>-.2&&along<4.6&&Math.abs(side)<0.88){
    let sign=Math.abs(side)<.08?(slot%2?1:-1):Math.sign(side);
    let escape={x:p.x-vz*sign*2.4,z:p.z+vx*sign*2.4};
    if(blocked(escape.x,escape.z))escape={x:p.x+vz*sign*2.4,z:p.z-vx*sign*2.4};
    target=reachablePoint(escape,.3);
    p.interact=false;
   }
  }
 }else if(g.ball.holder===p.id){
  // Defender holding the ball: if standing inside the restricted tower zone, prefer passing out to a teammate outside the ring!
  const inZone=Math.hypot(p.x,p.z)<TOWER_ZONE_RADIUS;
  const builderDecoys=(g.decoys||[]).filter(dc=>dc.team===g.attack);
  const allTargets=[...g.players.filter(q=>q.team===g.attack&&q.alive),...builderDecoys];
  let q=allTargets.sort((a,b)=>d(p,a)-d(p,b))[0];
  if(q){
   const mates=g.players.filter(m=>m.team===p.team&&m.id!==p.id&&m.alive);
   const outsideMate=mates.find(m=>Math.hypot(m.x,m.z)>=TOWER_ZONE_RADIUS&&d(p,m)>1.4&&d(p,m)<12.5);
   const betterMate=mates.find(m=>d(m,q)+2.0<d(p,q)&&d(p,m)>1.5&&d(p,m)<12.5);
   const passChoice=(inZone&&outsideMate&&d(p,q)>3.6)?outsideMate:(betterMate&&d(p,q)>5.2?betterMate:null);
   if(passChoice){
    let mdx=passChoice.x-p.x,mdz=passChoice.z-p.z,ml=Math.hypot(mdx,mdz)||1;
    p.ax=mdx/ml;p.az=mdz/ml;
    p.charging=true;
    p.charge=clamp((p.charge||0)+0.03,0,0.45);
    if(p.held>0.55)p.action='pass';
   }else{
    let dx=q.x-p.x+(q.mx||0)*.28,dz=q.z-p.z+(q.mz||0)*.28,l=Math.hypot(dx,dz)||1;
    p.ax=dx/l;p.az=dz/l;
    p.charging=true;
    p.charge=clamp((p.charge||0)+0.045,0,0.78);
    if(p.held>0.64)p.action=d(p,q)>8.6?'pass':'throw';
   }
  }
 }else if(g.ball.mode==='loose'){
  const defMates=g.players.filter(m=>m.team===p.team&&m.alive).sort((a,b)=>d(a,g.ball)-d(b,g.ball));
  if(defMates[0]?.id===p.id||d(p,g.ball)<2.6){
   const leadT=clamp(d(p,g.ball)*0.07,0,0.22);
   target=reachablePoint({
    x:clamp(g.ball.x+(g.ball.vx||0)*leadT,-9.2,9.2),
    z:clamp(g.ball.z+(g.ball.vz||0)*leadT,-5.7,5.7)
   },.3);
  }else if(nearPu){
   target=nearPu;
  }else{
   // Guard outside the restricted tower zone (r >= 2.1m) so defenders don't suffer the tower zone penalty
   const threats=g.players.filter(q=>q.team===g.attack&&q.alive).sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z));
   const primary=threats[0];
   if(primary){
    const slotIdx=defMates.indexOf(p);
    let gx=clamp(primary.x*0.65,-3.5,3.5),gz=clamp(primary.z*0.65,-3.0,3.0);
    const gr=Math.hypot(gx,gz);
    if(gr<TOWER_ZONE_RADIUS+0.22){
     const ang=gr>0.15?Math.atan2(gz,gx):(-Math.PI/2+(slotIdx-1)*1.15);
     gx=Math.cos(ang)*(TOWER_ZONE_RADIUS+0.25);
     gz=Math.sin(ang)*(TOWER_ZONE_RADIUS+0.25);
    }
    target=reachablePoint({x:gx,z:gz},.3);
   }else{
    target={x:0,z:-(TOWER_ZONE_RADIUS+0.28)};
   }
  }
 }else if(g.ball.mode==='flight'&&g.ball.passTo===p.id){
  target={x:b.x+b.vx*0.18,z:b.z+b.vz*0.18};
 }else if(nearPu){
  target=nearPu;
 }else{
  let threats=g.players.filter(q=>q.team===g.attack&&q.alive);
  let i=g.players.filter(q=>q.team===p.team).indexOf(p);
  if(threats.length&&i===0){
   let primary=threats[0];
   let gx=clamp(primary.x*0.65,-4.2,4.2),gz=clamp(primary.z*0.65,-3.6,3.6);
   const gr=Math.hypot(gx,gz);
   if(gr<TOWER_ZONE_RADIUS+0.22){
    const ang=gr>0.15?Math.atan2(gz,gx):(-Math.PI/2+(i-0.5)*1.1);
    gx=Math.cos(ang)*(TOWER_ZONE_RADIUS+0.25);
    gz=Math.sin(ang)*(TOWER_ZONE_RADIUS+0.25);
   }
   target={x:gx,z:gz};
  }else{
   const defCount=Math.max(2,g.players.filter(q=>q.team===p.team).length);let a=i*Math.PI*2/defCount+g.clock*.35;
   target={x:Math.cos(a)*3.8,z:Math.sin(a)*3.2};
  }
 }

 if(target){
  let next=waypoint(p,target),dx=next.x-p.x,dz=next.z-p.z,l=Math.hypot(dx,dz),atGoal=d(next,reachablePoint(target))<.01,stop=atGoal?(p.team===g.attack&&p.carry!==null?.16:.5):.01;
  if(l>stop){p.mx=dx/Math.max(l,.225);p.mz=dz/Math.max(l,.225);p.ax=p.mx;p.az=p.mz;}
 }
}

// Single-player movement step, shared by the server simulation (step())
// and the client's prediction/replay (netcode.js predictStep/replayLocal).
// This is the ONE place the movement rules live, so the client replay is
// exactly the server's movement by construction — no copied numbers that
// can drift. Rules: stationary during opening, while holding/charging the
// ball, while cool/anim/stun lock the player, or when dead. Speed is
// 4.5 m/s, 3.95 while carrying a stone, 6.2 with Chappal Dash, x0.58 in
// the Restricted Tower Zone. Collision is axis-separated blocked().
// Assumes an alive player (step() skips dead players before calling;
// replay flushes on death). Mutates p.x/p.z/p.ax/p.az/p.inTowerZone only.
export function movePlayerStep(p, g, dt) {
  if (!p || !p.alive) return;
  p.inTowerZone =
    g.phase === 'chase' && p.team !== g.attack && Math.hypot(p.x, p.z) < TOWER_ZONE_RADIUS;
  // Players remain stationary during the opening strike and while holding or charging the ball.
  if (
    g.phase === 'chase' &&
    g.ball.holder !== p.id &&
    p.cool === 0 &&
    p.anim === 0 &&
    !p.charging &&
    (p.stun || 0) <= 0
  ) {
    let moveSpd = p.carry !== null ? 3.95 : 4.5;
    if (p.buff === 'chappal') moveSpd = 6.2; // Chappal Dash speed boost + removes stone carry slowdown
    if (p.inTowerZone) moveSpd *= 0.58; // Restricted Tower Zone slows defenders by 42%
    let x = clamp(p.x + p.mx * moveSpd * dt, -9.55, 9.55),
      z = clamp(p.z + p.mz * moveSpd * dt, -6.05, 6.05);
    if (!blocked(x, p.z)) p.x = x;
    if (!blocked(p.x, z)) p.z = z;
    const ml = Math.hypot(p.mx, p.mz);
    if (ml > 0.12) {
      p.ax = p.mx / ml;
      p.az = p.mz / ml;
    }
  }
}

export function step(g,dt){
 dt=clamp(dt,0,.05);
 if(g.phase==='opening'&&(g.ready||0)>0){
  const prevReady=g.ready;
  g.ready=Math.max(0,g.ready-dt);
  if(prevReady>0&&g.ready<=0)emitSfx(g,'whistle');
  for(const p of g.players){p.action='';p.mx=p.mz=0;p.interact=false;p.charging=false;p.charge=0;}
  return;
 }
 g.clock+=dt;
 if(g.phase==='result'){
  g.until-=dt;
  if(g.until<=0){
   g.round++;
   const minRounds=g.targetRounds||6;
   const maxRounds=Math.max(minRounds,g.maxRounds||6);
   if((g.round>=minRounds&&g.round%2===0&&g.scores[0]!==g.scores[1])||g.round>=maxRounds){
    g.phase='match';
    g.message=g.scores[0]===g.scores[1]?'A beautiful draw!':(g.scores[0]>g.scores[1]?'Team Teal':'Team Coral')+' wins!';
    emitSfx(g,'fanfare');
    g.event++;
   }else resetRound(g);
  }
  return;
 }
 if(!['opening','chase'].includes(g.phase))return;

 if(g.phase==='opening'){
  g.until-=dt;
  if(g.until<=0&&g.ball.mode==='held'){
   g.attempts--;
   if(!g.attempts){finish(g,false,'Three opening attempts missed.','misses');return;}
   g.until=8;g.event++;
  }
 }else{
  g.time-=dt;
  if(g.time<=0){finish(g,false,'Time is up. Defenders hold!','timeout');return;}
  // Periodically spawn balanced courtyard power-ups during chase phase
  if(g.clock>=(g.nextPowerupAt||4.2)){
   spawnCourtyardPowerup(g);
   g.nextPowerupAt=g.clock+9.5;
  }
 }

 g.ball.lock=Math.max(0,(g.ball.lock||0)-dt);

 // Update active Kathputli decoys with lifelike player movement & state sync
 if(g.decoys?.length){
  g.decoys=g.decoys.filter(dc=>g.clock<dc.until);
  for(const dc of g.decoys){
   const owner=g.players.find(q=>q.id===dc.ownerId);
   dc.buffTime=Math.max(0,dc.until-g.clock);
   if(owner)dc.carry=owner.carry;
   let tx=0,tz=0;
   if(dc.team===g.attack){
    // Lifelike builder decoy pathing: alternate between approaching the stack and juking toward loose stones
    const phaseT=(g.clock-dc.spawnAt)*1.35+dc.spawnAt;
    const looseStone=(g.stones||[]).find(s=>!s.placed&&s.held===null);
    if(Math.sin(phaseT)>0.25&&looseStone){
     tx=looseStone.x;tz=looseStone.z;
    }else{
     const orbitAng=phaseT*1.6;
     const rad=dc.carry!==null?0.65:1.45;
     tx=Math.cos(orbitAng)*rad;tz=Math.sin(orbitAng)*rad;
    }
   }else{
    const bTarget=g.players.filter(q=>q.team===g.attack&&q.alive).sort((a,b)=>d(dc,a)-d(dc,b))[0];
    if(bTarget){
     let gx=bTarget.x*0.72,gz=bTarget.z*0.72;
     const gr=Math.hypot(gx,gz);
     if(gr<TOWER_ZONE_RADIUS+0.25){
      const ang=Math.atan2(gz,gx);
      gx=Math.cos(ang)*(TOWER_ZONE_RADIUS+0.3);
      gz=Math.sin(ang)*(TOWER_ZONE_RADIUS+0.3);
     }
     tx=gx;tz=gz;
    }
   }
   const next=waypoint(dc,{x:tx,z:tz}),dx=next.x-dc.x,dz=next.z-dc.z,l=Math.hypot(dx,dz);
   const moveSpd=dc.carry!==null?3.95:4.5;
   if(l>0.16){
    dc.mx=dx/l;dc.mz=dz/l;dc.ax=dc.mx;dc.az=dc.mz;
    const nx=clamp(dc.x+dc.mx*moveSpd*dt,-9.5,9.5),nz=clamp(dc.z+dc.mz*moveSpd*dt,-6.0,6.0);
    if(!blocked(nx,dc.z))dc.x=nx;
    if(!blocked(dc.x,nz))dc.z=nz;
   }else{
    dc.mx=0;dc.mz=0;
   }
   dc.inTowerZone=g.phase==='chase'&&dc.team!==g.attack&&Math.hypot(dc.x,dc.z)<TOWER_ZONE_RADIUS;
  }
 }

 if(g.ball.mode==='loose'){
  const b=g.ball;
  const speed=Math.hypot(b.vx||0,b.vz||0);
  const isAirborne=(b.y||0.24)>0.245||Math.abs(b.vy||0)>0.05;
  if(speed>0.03||isAirborne){
   b.vy=(b.vy||0)-17.5*dt;
   b.y=(b.y??0.24)+b.vy*dt;
   if(b.y<=0.24){
    b.y=0.24;
    if(b.vy<-0.65){
     b.vy=-b.vy*0.54;
     b.vx=(b.vx||0)*0.86;
     b.vz=(b.vz||0)*0.86;
    }else{
     b.vy=0;
    }
   }
   const ax=b.x,az=b.z;
   let nx=ax+(b.vx||0)*dt,nz=az+(b.vz||0)*dt;
   const hitT=coverContact({x:ax,z:az},{x:nx,z:nz},.24);
   if(hitT!==null){
    const cx=ax+(nx-ax)*Math.max(0,hitT-.002);
    const cz=az+(nz-az)*Math.max(0,hitT-.002);
    const norm=obstacleNormal(cx,cz,b.vx||0,b.vz||0,.24);
    const vn=(b.vx||0)*norm.nx+(b.vz||0)*norm.nz;
    if(vn<0){
     const eWall=0.66;
     b.vx=(b.vx||0)-(1+eWall)*vn*norm.nx;
     b.vz=(b.vz||0)-(1+eWall)*vn*norm.nz;
    }
    const rem=Math.max(0,1-hitT)*dt;
    nx=cx+(b.vx||0)*rem;
    nz=cz+(b.vz||0)*rem;
   }
   if(Math.abs(nx)>9.45){
    nx=clamp(nx,-9.45,9.45);
    b.vx=-(b.vx||0)*0.65;
   }
   if(Math.abs(nz)>5.95){
    nz=clamp(nz,-5.95,5.95);
    b.vz=-(b.vz||0)*0.65;
   }
   b.x=nx;b.z=nz;
   if(b.y>0.26){
    const airDrag=Math.max(0,1-0.30*dt);
    b.vx=(b.vx||0)*airDrag;
    b.vz=(b.vz||0)*airDrag;
   }else{
    const curSpd=Math.hypot(b.vx||0,b.vz||0);
    const nextSpd=Math.max(0,curSpd-4.4*dt);
    const scale=curSpd>1e-5?nextSpd/curSpd:0;
    b.vx=(b.vx||0)*scale;
    b.vz=(b.vz||0)*scale;
   }
  }else{
   b.vx=0;b.vz=0;b.vy=0;b.y=0.24;
  }
  Object.assign(b,reachablePoint(b,.24));
 }

 for(const p of g.players){
  p.cool=Math.max(0,p.cool-dt);
  p.anim=Math.max(0,p.anim-dt);
  if(p.buffTime>0){
   p.buffTime=Math.max(0,p.buffTime-dt);
   if(p.buffTime<=0&&p.buff){
    p.buff=null;p.buffMax=0;
    emitSfx(g,'powerupExpire');
   }
  }
  if(p.stun>0){
   p.stun=Math.max(0,p.stun-dt);
   const sx=clamp(p.x+(p.stunVx||0)*dt,-9.55,9.55);
   const sz=clamp(p.z+(p.stunVz||0)*dt,-6.05,6.05);
   if(!blocked(sx,p.z))p.x=sx;
   if(!blocked(p.x,sz))p.z=sz;
   p.stunVx=(p.stunVx||0)*Math.max(0,1-4.5*dt);
   p.stunVz=(p.stunVz||0)*Math.max(0,1-4.5*dt);
  }
  if(p.bot)ai(g,p);
  else if(g.clock-p.last>1.5){p.mx=p.mz=0;p.interact=false;p.charging=false;}
  if(!p.alive)continue;

  // Check if defending player is inside the Restricted Tower Zone (r < 1.85m) during chase
  const wasInZone=!!p.inTowerZone;
  movePlayerStep(p,g,dt);
  if(p.inTowerZone&&!wasInZone&&!p.bot){
   emitSfx(g,'towerZoneWarn');
  }

  // Check courtyard power-up pickup in chase phase
  if(g.phase==='chase'&&(g.powerups?.length||0)>0){
   const puIdx=g.powerups.findIndex(pu=>d(p,pu)<0.92);
   if(puIdx>=0){
    const [picked]=g.powerups.splice(puIdx,1);
    activatePowerup(g,p,picked);
   }
  }

  // Armed Mirchi Bomb auto-detonates when an opponent enters the 2.85m spice radius!
  if(g.phase==='chase'&&p.buff==='mirchi'){
   if(g.players.some(q=>q.team!==p.team&&q.alive&&d(p,q)<=2.85)){
    triggerMirchiBurst(g,p);
   }
  }

  if(g.ball.holder===p.id){
   p.held+=dt;
   if(p.action==='cancel'){
    p.charge=0;p.charging=false;p.explicitCharge=false;
   }else if(p.charging){
    // Nimbu Pani Fizz (banta) charges stationary throws 2.8x faster!
    const chargeRate=p.buff==='banta'?4.6:1.65;
    p.charge=clamp((p.charge||0)+dt*chargeRate,0,1);
   }
   g.ball.x=p.x;g.ball.z=p.z;g.ball.y=0.92;g.ball.vx=0;g.ball.vz=0;g.ball.vy=0;
   if(g.phase==='chase'&&p.held>=5.5){
    Object.assign(g.ball,{mode:'loose',holder:null,from:p.id,lock:1,power:0,passTo:null,vx:p.ax*1.8,vz:p.az*1.8,vy:1.2,y:0.75});
    p.held=0;p.charge=0;p.charging=false;p.explicitCharge=false;
   }else if(['throw','pass'].includes(p.action)){
    release(g,p,p.action==='pass');
   }
  }else{
   p.charge=0;p.charging=false;p.explicitCharge=false;
  }

  // Defender loose-ball scoop (Nimbu Pani Fizz extends magnetic ball scoop radius to 2.05m!)
  const scoopRadius=p.buff==='banta'?2.05:0.78;
  if(g.phase==='chase'&&p.team!==g.attack&&g.ball.mode==='loose'&&(g.ball.y||0.24)<0.95&&!(g.ball.reboundAt&&g.clock-g.ball.reboundAt<0.22)&&d(p,g.ball)<scoopRadius&&!(g.ball.from===p.id&&g.ball.lock>0)&&(p.stun||0)<=0){
   g.ball.mode='held';g.ball.holder=p.id;g.ball.passTo=null;g.ball.vx=0;g.ball.vz=0;g.ball.vy=0;g.ball.y=0.92;p.held=0;p.charge=0;
   emitSfx(g,'catch');
   g.event++;
  }

  if(g.phase==='chase'&&p.team===g.attack&&(p.stun||0)<=0){
   if(p.action==='drop'&&p.carry!==null){
    let s=g.stones?.[p.carry];
    if(s)Object.assign(s,{held:null,x:p.x,z:p.z});
    p.carry=null;
   }
   // Nimbu Pani Fizz (banta) magnetically scoops loose stones within 1.85m; otherwise manual pickup within 1.05m when interact is pressed
   if(p.carry===null&&g.clock>=(p.justPlacedUntil||0)&&(p.interact||p.action==='interact'||p.buff==='banta')){
    const pickRad=p.buff==='banta'?1.85:(!p.bot?1.05:0.88);
    let bestS=null,bestDist=pickRad;
    for(const st of g.stones){
     if(!st.placed&&st.held===null){
      const dist=d(p,st);
      if(dist<bestDist){bestDist=dist;bestS=st;}
     }
    }
    if(bestS){p.carry=bestS.id;bestS.held=p.id;p.place=0;emitSfx(g,'pickup');g.event++;}
   }
   if(p.carry!==null){
    let s=g.stones?.[p.carry];
    if(!s){p.carry=null;}else{
    s.x=p.x;s.z=p.z;
    const distCenter=Math.hypot(p.x,p.z);
    const maxPlaceRad=p.bot?0.98:1.15;
    if(distCenter<maxPlaceRad&&p.interact&&Math.hypot(p.mx,p.mz)<0.15){
     if(!p.bot){
      for(const q of g.players){if(q.id!==p.id&&q.bot&&q.place>0)q.place=0;}
      if(distCenter>0.46){
       const pull=Math.min(distCenter-0.46,dt*2.4);
       p.x-=(p.x/distCenter)*pull;
       p.z-=(p.z/distCenter)*pull;
       s.x=p.x;s.z=p.z;
      }
      p.ax=-p.x/(distCenter||1);p.az=-p.z/(distCenter||1);
     }
     // Nimbu Pani Fizz stacks stones 2x faster!
     const placeRate=p.buff==='banta'?2.0:1.0;
     if(!g.players.some(q=>q.id!==p.id&&q.place>0))p.place+=dt*placeRate;
     if(p.place>=.65){
      s.placed=true;s.held=null;s.placedAt=g.clock;s.x=0;s.z=0;
      p.carry=null;p.place=0;p.justPlacedUntil=g.clock+0.35;g.stack++;
      // Judwaa Split-Ball bonus for Builders: locks a bonus loose stone onto the stack at the same time (up to 6/7)!
      if(p.buff==='judwaa'&&g.stack<6){
       const extra=g.stones.find(st=>!st.placed&&st.held===null);
       if(extra){
        extra.placed=true;extra.held=null;extra.placedAt=g.clock;extra.x=0;extra.z=0;
        g.stack++;
        p.buff=null;p.buffTime=0;
        g.message=`${p.name}'s Judwaa power locked 2 stones at once!`;
       }
      }
      emitSfx(g,'stonePlaced');
      g.event++;
      if(g.stack===7){finish(g,true,'PITTU! All seven stones rebuilt.','rebuilt');return;}
     }
    }else p.place=0;
    }
   }
  }
  p.action='';
 }

 // Step Judwaa phantom twin ball if active
 if(g.twinBall){
  const tb=g.twinBall;
  const ax=tb.x,az=tb.z,end={x:tb.x+tb.vx*dt,z:tb.z+tb.vz*dt},contact=coverContact(tb,end,.22);
  tb.x=end.x;tb.z=end.z;
  tb.travel+=Math.hypot(tb.x-ax,tb.z-az);
  let twinDone=false;
  if(g.phase==='chase'){
   // Check decoy hits first
   const decIdx=(g.decoys||[]).findIndex(dc=>dc.team===g.attack&&seg(dc.x,dc.z,ax,az,tb.x,tb.z)<0.48);
   if(decIdx>=0){
    const [hitDec]=g.decoys.splice(decIdx,1);
    g.bursts.push({type:'kathputli',x:hitDec.x,z:hitDec.z,at:g.clock});
    g.message=`${hitDec.name}'s Kathputli Decoy fooled the throw!`;
    emitSfx(g,'decoyPop');
    twinDone=true;
   }
   if(!twinDone){
    for(const p of g.players){
     if(!p.alive||p.team!==g.attack)continue;
     if(seg(p.x,p.z,ax,az,tb.x,tb.z)<0.42){
      if(p.buff==='genda'){
       p.buff=null;p.buffTime=0;
       g.bursts.push({type:'genda',x:p.x,z:p.z,at:g.clock});
       g.message=`${p.name}'s Genda Shield blocked the Judwaa ball!`;
       emitSfx(g,'shieldBlock');
      }else{
       p.alive=false;p.place=0;p.mx=p.mz=0;
       if(p.carry!==null){
        Object.assign(g.stones[p.carry],{held:null,x:p.x,z:p.z});
        p.carry=null;
       }
       g.message=p.name+' was tagged by the Judwaa Split-Ball!';
       emitSfx(g,'playerOut');
      }
      g.event++;twinDone=true;break;
     }
    }
   }
  }
  if(twinDone||contact!==null||tb.travel>(tb.maxTravel||13.8)||Math.abs(tb.x)>9.55||Math.abs(tb.z)>6.05){
   g.bursts.push({type:'judwaa',x:clamp(tb.x,-9.4,9.4),z:clamp(tb.z,-5.9,5.9),at:g.clock});
   g.twinBall=null;
  }
 }

 const b=g.ball;
 if(b.mode==='flight'){
  if(g.phase==='chase'&&b.passTo){
   const tp=g.players.find(q=>q.id===b.passTo&&q.alive&&q.team!==g.attack);
   if(tp){
    const dx=tp.x-b.x,dz=tp.z-b.z,dist=Math.hypot(dx,dz);
    if(dist>0.1&&dist<14.0){
     const spd=Math.hypot(b.vx,b.vz)||11.8;
     const tx=(dx/dist)*spd,tz=(dz/dist)*spd,blend=Math.min(1,dt*6.2);
     b.vx=b.vx*(1-blend)+tx*blend;
     b.vz=b.vz*(1-blend)+tz*blend;
    }
   }
  }
  let ax=b.x,az=b.z,end={x:b.x+b.vx*dt,z:b.z+b.vz*dt},contact=coverContact(b,end,.22);
  b.x=end.x;b.z=end.z;
  if(contact!==null){
   const t=Math.max(0,contact-.001);
   b.x=ax+(end.x-ax)*t;b.z=az+(end.z-az)*t;
  }
  b.travel+=Math.hypot(b.x-ax,b.z-az);
  if(g.phase==='opening'&&seg(0,0,ax,az,b.x,b.z)<.55){
   scatter(g,b,ax,az);return;
  }
  if(g.phase==='chase'){
   // Check if ball hits an active Kathputli Decoy clone first!
   const decIdx=(g.decoys||[]).findIndex(dc=>dc.team===g.attack&&seg(dc.x,dc.z,ax,az,b.x,b.z)<0.48);
   if(decIdx>=0){
    const [hitDec]=g.decoys.splice(decIdx,1);
    g.bursts.push({type:'kathputli',x:hitDec.x,z:hitDec.z,at:g.clock});
    b.mode='loose';b.passTo=null;b.vx*=-0.35;b.vz*=-0.35;b.vy=1.6;b.y=0.62;
    g.message=`${hitDec.name}'s Kathputli Decoy absorbed the throw!`;
    emitSfx(g,'decoyPop');
    g.event++;
   }else{
    for(const p of g.players){
     if(!p.alive||(p.id===b.from&&b.lock>0))continue;
     const hitRadius=p.team!==g.attack?(b.passTo===p.id?1.08:0.78):0.42;
     if(seg(p.x,p.z,ax,az,b.x,b.z)<hitRadius){
      if(p.team!==g.attack){
       b.mode='held';b.holder=p.id;b.passTo=null;b.vx=0;b.vz=0;b.vy=0;b.y=0.92;b.ricochets=0;p.held=0;p.charge=0;p.charging=false;
       g.message=p.name+' caught the pass!';
       emitSfx(g,'catch');
      }else if(p.buff==='genda'){
       // Genda Shield absorbs the hit and saves the builder!
       p.buff=null;p.buffTime=0;
       g.bursts.push({type:'genda',x:p.x,z:p.z,at:g.clock});
       const bSpd=Math.hypot(b.vx,b.vz)||10;
       const nx=(b.x-p.x)/Math.max(0.1,d(b,p)),nz=(b.z-p.z)/Math.max(0.1,d(b,p));
       b.vx=nx*bSpd*0.48;b.vz=nz*bSpd*0.48;b.vy=2.1;b.y=0.72;
       b.mode='loose';b.passTo=null;b.ricochets=0;
       g.message=`${p.name}'s Genda Shield blocked the hit!`;
       emitSfx(g,'shieldBlock');
      }else{
       p.alive=false;p.place=0;p.mx=p.mz=0;
       if(p.carry!==null){
        Object.assign(g.stones[p.carry],{held:null,x:p.x,z:p.z});
        p.carry=null;
       }
       const bSpd=Math.hypot(b.vx,b.vz)||10;
       const nx=(b.x-p.x)/Math.max(0.1,d(b,p)),nz=(b.z-p.z)/Math.max(0.1,d(b,p));
       b.vx=nx*bSpd*0.32;b.vz=nz*bSpd*0.32;b.vy=1.6;b.y=0.65;
       b.mode='loose';b.passTo=null;b.ricochets=0;g.message=p.name+' is out!';
       emitSfx(g,'playerOut');
      }
      g.event++;break;
     }
    }
   }
  }
  const maxTr=b.maxTravel||13.8;
  if(b.mode==='flight'&&(b.travel>maxTr||Math.abs(b.x)>9.55||Math.abs(b.z)>6.05||contact!==null)){
   // Nimbu Pani Fizz (banta) ricochet shot: bounces live off planters/walls up to 2 times!
   if(g.phase==='chase'&&(b.ricochets||0)>0&&(contact!==null||Math.abs(b.x)>9.55||Math.abs(b.z)>6.05)&&b.travel<=maxTr){
    b.ricochets--;
    if(contact!==null){
     const norm=obstacleNormal(b.x,b.z,b.vx||0,b.vz||0,.24);
     const vn=(b.vx||0)*norm.nx+(b.vz||0)*norm.nz;
     if(vn<0){
      b.vx=(b.vx||0)-1.92*vn*norm.nx;
      b.vz=(b.vz||0)-1.92*vn*norm.nz;
     }else{
      b.vx=-(b.vx||0);b.vz=-(b.vz||0);
     }
    }else{
     if(Math.abs(b.x)>9.55)b.vx=-(b.vx||0)*0.94;
     if(Math.abs(b.z)>6.05)b.vz=-(b.vz||0)*0.94;
    }
    b.x=clamp(b.x,-9.48,9.48);b.z=clamp(b.z,-5.98,5.98);
    Object.assign(b,reachablePoint(b,.24));
    g.bursts.push({type:'banta',x:b.x,z:b.z,at:g.clock});
    emitSfx(g,'ricochet');
   }else{
    if(contact!==null){
     const norm=obstacleNormal(b.x,b.z,b.vx||0,b.vz||0,.24);
     const vn=(b.vx||0)*norm.nx+(b.vz||0)*norm.nz;
     if(vn<0){
      b.vx=((b.vx||0)-1.55*vn*norm.nx)*0.26;
      b.vz=((b.vz||0)-1.55*vn*norm.nz)*0.26;
     }else{
      b.vx=-(b.vx||0)*0.22;b.vz=-(b.vz||0)*0.22;
     }
     b.vy=0.55;b.y=0.28;
    }else{
     if(Math.abs(b.x)>9.55)b.vx=-(b.vx||0)*0.28;
     else b.vx=(b.vx||0)*0.20;
     if(Math.abs(b.z)>6.05)b.vz=-(b.vz||0)*0.28;
     else b.vz=(b.vz||0)*0.20;
     b.vy=0.45;b.y=0.26;
    }
    b.x=clamp(b.x,-9.5,9.5);b.z=clamp(b.z,-6.0,6.0);b.mode='loose';b.passTo=null;b.ricochets=0;
    Object.assign(b,reachablePoint(b,.24));
    if(g.phase==='opening'){
     g.attempts--;
     if(!g.attempts){finish(g,false,'Three opening attempts missed.','misses');return;}
     let p=g.players.find(p=>p.id===g.striker);
     Object.assign(b,{mode:'held',holder:p.id,x:p.x,z:p.z,y:0.92,vx:0,vz:0,vy:0,power:0,passTo:null,ricochets:0});
     p.charge=0;p.charging=false;
     g.until=8;g.event++;
    }
   }
  }
 }
 if(g.phase==='chase'&&!g.players.some(p=>p.team===g.attack&&p.alive))
  finish(g,false,'Every builder has been hit.','eliminated');
}

export function advance(g,now){
 now=Math.max(now,g.last||0);
 let elapsed=clamp((now-(g.last||now))/1000,0,.5);
 for(let left=elapsed;left>0;left-=1/30)step(g,Math.min(left,1/30));
 g.last=now;
}

// Deterministic FNV-1a 32-bit state integrity checksum to detect client-side memory tampering
export function computeStateDigest(g){
 if(!g)return '00000000';
 const s=`${g.code||''}|${g.phase}|${g.round}|${(g.teamSizes||[3,3]).join('v')}|${g.scores?.[0]||0},${g.scores?.[1]||0}|${g.stack}|${g.attempts}|${(g.players||[]).map(p=>`${p.id}:${p.team}:${p.alive?1:0}:${p.carry??-1}:${p.buff||''}`).join(';')}`;
 let h=0x811c9dc5;
 for(let i=0;i<s.length;i++){
  h^=s.charCodeAt(i);
  h=Math.imul(h,0x01000193)>>>0;
 }
 return h.toString(16).padStart(8,'0');
}

export function publicState(g){
 const digest=computeStateDigest(g);
 return{...g,digest,players:g.players.map(({token,...p})=>p)};
}
