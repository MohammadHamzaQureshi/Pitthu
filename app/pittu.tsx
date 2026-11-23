'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowRight,Volume2,VolumeX,HelpCircle,ArrowLeft,Copy,Check,Users,Play,X,RotateCcw,Link2,Camera} from 'lucide-react';
import {createGame,player,start,step,command,clamp,findPassTarget,POWERUP_TYPES,TOWER_ZONE_RADIUS,waypoint,normalizeTeamSizes} from '../lib/game.js';
import {blocked} from '../lib/navigation.js';
import {createSnapshotBuffer,pushSnapshot,sampleRenderState,createServerClock,clockUpdate,clockNow,reconcileLocal,INTERP_DELAY_MS} from '../lib/netcode.js';

const LOOKS=[
 'Aarav · Boy (Striker)',
 'Tara · Girl (Architect)',
 'Kabir · Boy (Sprinter)',
 'Mira · Girl (Strategist)',
 'Aadi · Boy (Ace)',
 'Nila · Girl (Dodger)',
 'Dev · Boy (Captain)',
 'Zoya · Girl (Blitzer)'
];
const BUFF_META:Record<string,{name:string,desc:string,color:string}>={
 chappal:{name:'CHAPPAL DASH',desc:'+38% Sprint & Zero Stone Slowdown',color:'#38d6ff'},
 genda:{name:'GENDA SHIELD',desc:'Blocks 1 Direct Hit / Mirchi Stun',color:'#ffa826'},
 mirchi:{name:'MIRCHI BOMB',desc:'Auto-Detonates Sneeze Knockback Near Foes',color:'#ff4228'},
 banta:{name:'NIMBU PANI FIZZ',desc:'Magnetic Scoop · Fast Stack/Charge & Ricochet',color:'#68ee44'},
 judwaa:{name:'JUDWAA SPLIT-BALL',desc:'Twin-Ball V-Throw / Double-Stone Lock',color:'#ffde38'},
 kathputli:{name:'KATHPUTLI DECOY',desc:'Active Decoy Clone Drawing Enemy Fire',color:'#e85298'}
};
const TEAM_FALLBACK_PORTRAIT=['/portraits/teal.png','/portraits/coral.png'];
function portraitFor(team:number,lookIdx=0){
 const idx=Math.max(0,Math.floor(Number(lookIdx)||0))%8;
 const t=team===1?1:0;
 return `/portraits/look-${t}-${idx}.png`;
}
function demo(ts=[3,3]){const g=createGame('PRACTICE',ts);g.players=[];start(g,true,ts);return g;}
function fmtClock(sec:number){const s=Math.max(0,Math.ceil(sec)),m=Math.floor(s/60),r=s%60;return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;}

// Compute compact HUD state signature so React only re-renders when a visible HUD value actually changes
function buildHudSignature(g:any,meId:string,localCharge:number){
 if(!g)return '';
 const me=g.players?.find((p:any)=>p.id===meId);
 const passId=me&&g.ball?.holder===meId?findPassTarget(g,me,me.ax,me.az)?.id||'':'';
 const aliveMask=(g.players||[]).map((p:any)=>`${p.id}:${p.team}:${p.look}:${p.alive?1:0}`).join(',');
 const effCharge=g.ball?.holder===meId?Math.round(clamp(Math.max(me?.charge||0,localCharge||0),0,1)*50):0;
 const buffTick=me?.buff?`${me.buff}:${Math.ceil((me.buffTime||0)*10)}`:'';
 const placeTick=me?.place?Math.round((me.place/0.65)*10):0;
 const nearLoose=me&&me.carry===null&&g.phase==='chase'&&me.team===g.attack&&(g.stones||[]).some((s:any)=>!s.placed&&s.held===null&&Math.hypot(me.x-s.x,me.z-s.z)<1.05)?1:0;
 const inCenter=me&&me.carry!==null&&g.phase==='chase'&&me.team===g.attack&&Math.hypot(me.x,me.z)<1.15?1:0;
 return `${g.phase}|${g.round}|${(g.teamSizes||[3,3]).join('v')}|${g.scores?.[0]}|${g.scores?.[1]}|${g.stack}|${g.attempts}|${Math.ceil(g.time||0)}|${Math.ceil(g.until||0)}|${Math.ceil(g.ready||0)}|${g.ball?.holder||''}|${g.striker||''}|${g.message||''}|${g.event||0}|${aliveMask}|${me?.carry??''}|${placeTick}|${nearLoose}|${inCenter}|${me?.inTowerZone?1:0}|${buffTick}|${effCharge}|${passId}`;
}

// Smooth 60fps visual dead-reckoning between 33ms server ticks in online
// multiplayer. The server (PitthuRoom Durable Object) broadcasts state at
// 30 Hz over WebSocket; this only fills in the gaps between broadcasts.
function stepOnlineVisuals(g:any,meId:string,ctrl:any,dt:number){
 if(!g||!['opening','chase'].includes(g.phase)||(g.ready||0)>0)return;
 for(const p of g.players||[]){
  if(!p.alive)continue;
  const isMe=p.id===meId;
  const mx=isMe?ctrl.mx:(p.mx||0),mz=isMe?ctrl.mz:(p.mz||0);
  if(isMe&&(g.ball?.holder===meId||!Math.hypot(mx,mz))){
   p.ax=ctrl.ax;p.az=ctrl.az;
  }
  if(g.phase==='chase'&&g.ball?.holder!==p.id&&(p.cool||0)<=0&&(p.anim||0)<=0&&!p.charging&&(p.stun||0)<=0){
   let spd=p.carry!==null?3.95:4.5;
   if(p.buff==='chappal')spd=6.2;
   if(p.inTowerZone)spd*=0.58;
   const nx=clamp(p.x+mx*spd*dt,-9.55,9.55),nz=clamp(p.z+mz*spd*dt,-6.05,6.05);
   if(!blocked(nx,p.z))p.x=nx;
   if(!blocked(p.x,nz))p.z=nz;
   const ml=Math.hypot(mx,mz);
   if(ml>0.12){p.ax=mx/ml;p.az=mz/ml;}
   p.inTowerZone=p.team!==g.attack&&Math.hypot(p.x,p.z)<TOWER_ZONE_RADIUS;
  }
 }
 if(g.ball?.mode==='flight'){
  g.ball.x=clamp(g.ball.x+(g.ball.vx||0)*dt,-9.55,9.55);
  g.ball.z=clamp(g.ball.z+(g.ball.vz||0)*dt,-6.05,6.05);
  g.ball.travel=(g.ball.travel||0)+Math.hypot((g.ball.vx||0)*dt,(g.ball.vz||0)*dt);
 }
}

export default function Pittu(){
 const [screen,setScreen]=useState('home'),[ui,setUI]=useState<any>(null),[name,setName]=useState(''),[look,setLook]=useState(0),[teamSizes,setTeamSizes]=useState<number[]>([3,3]),[code,setCode]=useState(''),[join,setJoin]=useState(false),[help,setHelp]=useState(false),[muted,setMuted]=useState(false),[camMode,setCamMode]=useState<'auto'|'close'|'wide'>('auto'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[copied,setCopied]=useState(false),[fill,setFill]=useState(true),[connection,setConnection]=useState(''),[resume,setResume]=useState<any>(null),[isTouch,setIsTouch]=useState(false),[pingMs,setPingMs]=useState<number|null>(null);
 const teamSizesRef=useRef<number[]>([3,3]);teamSizesRef.current=teamSizes;
 const container=useRef<HTMLDivElement>(null),game=useRef<any>(null),mode=useRef('home'),session=useRef<any>(null),myId=useRef(''),controls=useRef<any>({mx:0,mz:0,ax:0,az:-1,interact:false,charging:false,charge:0,action:'',seq:0}),keys=useRef<any>({}),world=useRef<any>(null),sound=useRef<any>(null),isMuted=useRef(false),helpOpen=useRef(false),seenRound=useRef(-1),seenSfxSeq=useRef(0),chargeStartedAt=useRef<number>(0),lastChargeTick=useRef<number>(0),lastPlaceTick=useRef<number>(0),camModeRef=useRef<'auto'|'close'|'wide'>('auto'),lastUiKey=useRef<string>(''),wsRef=useRef<WebSocket|null>(null),wsRetryRef=useRef(0),wsTimerRef=useRef<any>(null),wsSendTimerRef=useRef<any>(null),wsEverConnectedRef=useRef(false),snapBufRef=useRef<any>(null),serverClockRef=useRef<any>(null),predictedPosRef=useRef<any>(null),pingTickRef=useRef(0);
 const stickKnob=useRef<HTMLSpanElement>(null),aimKnob=useRef<HTMLSpanElement>(null),cancelBtnRef=useRef<HTMLButtonElement>(null),joystick=useRef<any>(null),aimStart=useRef<any>(null),touchInteract=useRef(false),touchInteractId=useRef<number|null>(null);
 if(!game.current)game.current=demo();helpOpen.current=help;

 function getAudioCtx(){
  if(isMuted.current)return null;
  try{
   sound.current ||= new (window.AudioContext||(window as any).webkitAudioContext)();
   if(sound.current.state==='suspended')sound.current.resume();
   return sound.current as AudioContext;
  }catch{return null;}
 }

 function playTone(freq:number,dur=0.14,type:OscillatorType='sine',vol=0.07,endFreq?:number,delay=0){
  const ctx=getAudioCtx();if(!ctx)return;
  try{
   const t0=ctx.currentTime+delay;
   const o=ctx.createOscillator(),g=ctx.createGain();
   o.type=type;
   o.frequency.setValueAtTime(freq,t0);
   if(endFreq)o.frequency.exponentialRampToValueAtTime(Math.max(20,endFreq),t0+dur);
   g.gain.setValueAtTime(0.0001,t0);
   g.gain.linearRampToValueAtTime(vol,t0+Math.min(0.015,dur*0.25));
   g.gain.exponentialRampToValueAtTime(0.0008,t0+dur);
   o.connect(g);g.connect(ctx.destination);
   o.start(t0);o.stop(t0+dur+0.02);
  }catch{}
 }

 function playNoise(dur=0.12,vol=0.06,filterFreq=1100,delay=0){
  const ctx=getAudioCtx();if(!ctx)return;
  try{
   const t0=ctx.currentTime+delay;
   const len=Math.max(1,Math.floor(ctx.sampleRate*dur));
   const buf=ctx.createBuffer(1,len,ctx.sampleRate);
   const data=buf.getChannelData(0);
   for(let i=0;i<len;i++)data[i]=(Math.random()*2-1)*Math.pow(1-i/len,1.4);
   const src=ctx.createBufferSource();src.buffer=buf;
   const flt=ctx.createBiquadFilter();flt.type='bandpass';flt.frequency.setValueAtTime(filterFreq,t0);flt.Q.setValueAtTime(1.8,t0);
   const g=ctx.createGain();g.gain.setValueAtTime(vol,t0);g.gain.exponentialRampToValueAtTime(0.001,t0+dur);
   src.connect(flt);flt.connect(g);g.connect(ctx.destination);
   src.start(t0);src.stop(t0+dur+0.02);
  }catch{}
 }

 function playSfx(kind:string,param=0){
  if(isMuted.current)return;
  switch(kind){
   case 'ui':
    playTone(540,0.06,'triangle',0.045,680);
    break;
   case 'cancel':
    playTone(340,0.11,'triangle',0.055,180);
    break;
   case 'chargeTick': {
    const f=280+clamp(param,0,1)*440;
    playTone(f,0.065,'triangle',0.038,f*1.06);
    if(param>=0.98)playTone(880,0.05,'sine',0.025,920);
    break;
   }
   case 'throw': {
    const p=clamp(param,0,1);
    playNoise(0.14+p*0.06,0.075+p*0.03,950+p*650);
    playTone(260+p*180,0.15,'triangle',0.075,115);
    break;
   }
   case 'pass':
    playTone(523.25,0.08,'triangle',0.06,659.25,0);
    playTone(659.25,0.11,'sine',0.065,880,0.055);
    break;
   case 'catch':
    playNoise(0.05,0.055,1600);
    playTone(587.33,0.09,'triangle',0.065,783.99,0);
    playTone(880,0.13,'sine',0.055,1046.5,0.045);
    break;
   case 'scatter':
    playTone(135,0.22,'sine',0.11,48,0);
    for(let i=0;i<7;i++){
     const dly=i*0.026+Math.random()*0.012;
     playNoise(0.065,0.065,1200+i*190,dly);
     playTone(380+((i*97)%340),0.07,'triangle',0.055,210+i*25,dly);
    }
    break;
   case 'pickup':
    playTone(440,0.07,'triangle',0.06,660,0);
    playNoise(0.04,0.04,1800,0);
    break;
   case 'placeTick':
    playTone(360+clamp(param,0,1)*260,0.055,'triangle',0.04,420+clamp(param,0,1)*260);
    break;
   case 'stonePlaced': {
    const notes=[293.66,329.63,392.00,440.00,523.25,587.33,659.25,783.99];
    const idx=clamp(Math.floor(param||1),0,7);
    const f=notes[idx];
    playNoise(0.045,0.05,1400,0);
    playTone(f,0.14,'triangle',0.075,f*1.02,0);
    playTone(f*1.5,0.18,'sine',0.05,f*1.5,0.04);
    break;
   }
   case 'playerOut':
    playNoise(0.14,0.09,650,0);
    playTone(210,0.22,'sawtooth',0.08,75,0);
    playTone(740,0.12,'sine',0.055,520,0.06);
    break;
   case 'whistle':
    playTone(1480,0.09,'sine',0.055,1560,0);
    playTone(1560,0.18,'sine',0.06,1420,0.10);
    break;
   case 'fanfare':
    [523.25,659.25,783.99,1046.5].forEach((f,i)=>{
     playTone(f,0.18,'triangle',0.07,f,i*0.09);
     playTone(f*0.5,0.18,'sine',0.045,f*0.5,i*0.09);
    });
    break;
   case 'roundEnd':
    playTone(440,0.16,'triangle',0.06,392,0);
    playTone(349.23,0.24,'triangle',0.065,293.66,0.14);
    break;
   // Power-Up & Restricted Zone Audio Suite
   case 'powerupSpawn':
    playTone(587.33,0.08,'sine',0.04,880,0);
    playTone(880,0.12,'triangle',0.045,1174.66,0.06);
    break;
   case 'powerupChappal':
    playNoise(0.16,0.065,1900,0);
    playTone(392,0.08,'triangle',0.06,587.33,0);
    playTone(587.33,0.12,'triangle',0.065,880,0.06);
    break;
   case 'powerupGenda':
    [440,554.37,659.25,880].forEach((f,i)=>playTone(f,0.18,'sine',0.055,f*1.01,i*0.04));
    break;
   case 'shieldBlock':
    playNoise(0.08,0.07,2100,0);
    playTone(783.99,0.14,'triangle',0.08,1046.5,0);
    playTone(1174.66,0.20,'sine',0.065,880,0.05);
    break;
   case 'powerupMirchi':
    playNoise(0.18,0.095,1250,0);
    playTone(520,0.09,'sawtooth',0.07,760,0);
    playTone(680,0.18,'sawtooth',0.085,190,0.08);
    break;
   case 'powerupBanta':
    // Crisp marble-stopper POP + sparkling soda fizz bubbles
    playTone(320,0.055,'sine',0.085,960,0);
    playNoise(0.18,0.065,2800,0.04);
    [784,987.77,1174.66,1567.98].forEach((f,i)=>playTone(f,0.07,'sine',0.045,f*1.08,0.05+i*0.035));
    break;
   case 'ricochet':
    playTone(660,0.07,'triangle',0.065,1120,0);
    playNoise(0.04,0.05,2400,0);
    break;
   case 'powerupJudwaa':
    playTone(523.25,0.12,'triangle',0.065,783.99,0);
    playTone(659.25,0.14,'sawtooth',0.055,1046.5,0.03);
    break;
   case 'powerupKathputli':
    [587.33,659.25,783.99,880,1046.5].forEach((f,i)=>playTone(f,0.08,'triangle',0.05,f,i*0.038));
    break;
   case 'decoyPop':
    playNoise(0.11,0.075,1750,0);
    playTone(740,0.10,'triangle',0.065,440,0);
    playTone(987.77,0.12,'sine',0.055,1318.5,0.05);
    break;
   case 'powerupExpire':
    playTone(587.33,0.09,'sine',0.04,440,0);
    playTone(440,0.12,'sine',0.038,329.63,0.08);
    break;
   case 'towerZoneWarn':
    playTone(220,0.09,'triangle',0.045,175,0);
    break;
   default:
    playTone(440,0.12,'sine',0.05,330);
  }
 }

 function cancelCharge(){
  if(chargeStartedAt.current>0||controls.current.charging||(controls.current.charge||0)>0||aimStart.current){
   chargeStartedAt.current=0;
   controls.current.charging=false;
   controls.current.charge=0;
   controls.current.action='cancel';
   if(aimStart.current)aimStart.current.canceled=true;
   if(aimKnob.current)aimKnob.current.style.transform='translate(0px,0px)';
   playSfx('cancel');
   return true;
  }
  return false;
 }
 function triggerBuilderAction(pointerId?:number){
  const g=game.current;
  const meP=g?.players?.find((p:any)=>p.id===myId.current);
  if(!g||!meP||!meP.alive||g.phase!=='chase'||meP.team!==g.attack)return;
  if(pointerId!==undefined){
   touchInteract.current=true;
   touchInteractId.current=pointerId;
  }
  controls.current.interact=true;
  controls.current.action='interact';
 }
 function syncKeyboardMotion(){
  const g=game.current;
  // Lock movement during the opening strike or while holding/charging the ball
  if(g?.phase==='opening'||g?.ball?.holder===myId.current||chargeStartedAt.current>0){
   controls.current.mx=0;controls.current.mz=0;
   controls.current.interact=false;
   return;
  }
  const k=keys.current;
  const keyMx=+(!!(k.KeyD||k.ArrowRight))-+(!!(k.KeyA||k.ArrowLeft)),keyMz=+(!!(k.KeyS||k.ArrowDown))-+(!!(k.KeyW||k.ArrowUp));
  if(!joystick.current){
   controls.current.mx=keyMx;controls.current.mz=keyMz;
   if((keyMx||keyMz)&&g?.ball?.holder!==myId.current){
    const l=Math.hypot(keyMx,keyMz)||1;
    controls.current.ax=keyMx/l;controls.current.az=keyMz/l;
   }
  }
  const holdingInteract=!!(k.KeyE||touchInteract.current);
  const meP=g?.players?.find((p:any)=>p.id===myId.current);
  // While holding HOLD TO STACK / E inside the center circle (< 1.15m) with a stone, brace stationary to stack cleanly
  if(meP&&meP.alive&&g?.phase==='chase'&&meP.team===g.attack&&meP.carry!==null&&holdingInteract&&Math.hypot(meP.x,meP.z)<1.15){
   controls.current.mx=0;controls.current.mz=0;
  }
  controls.current.interact=holdingInteract;
 }
 function syncRound(g:any){
  if(g.round!==seenRound.current){
   seenRound.current=g.round;
   chargeStartedAt.current=0;
   touchInteract.current=false;touchInteractId.current=null;joystick.current=null;
   if(stickKnob.current)stickKnob.current.style.transform='translate(0px,0px)';
   Object.assign(controls.current,{mx:0,mz:0,interact:false,charging:false,charge:0,action:'',ax:0,az:myId.current===g.striker?-1:1});
   syncKeyboardMotion();
  }
 }
 function accept(g:any){
  const oldRound=game.current?.round;
  syncRound(g);
  if(g.teamSizes)setTeamSizes(normalizeTeamSizes(g.teamSizes,[3,3]));
  // V2 netcode: reconcile the locally predicted position with the
  // authoritative one instead of snapping the render to it. Small
  // errors (<15 cm) are kept, medium ones blended, only large ones snap.
  // A round change resets prediction to the authoritative spawn.
  const authMe=g.players?.find((q:any)=>q.id===myId.current);
  if(authMe){
   if(oldRound!==undefined&&g.round!==oldRound)predictedPosRef.current={x:authMe.x,z:authMe.z};
   else if(predictedPosRef.current)predictedPosRef.current=reconcileLocal(predictedPosRef.current,authMe);
   else predictedPosRef.current={x:authMe.x,z:authMe.z};
  }
  game.current=g;
  lastUiKey.current=buildHudSignature(g,myId.current,controls.current.charge||0);
  setUI({...g});
  mode.current='online';
  setScreen(g.phase==='lobby'?'lobby':'play');
 }
 async function api(op:string,extra:any={}){let s=session.current||{};const r=await fetch('/api/room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...s,op,...extra})});const d=await r.json();if(!r.ok)throw Error(d.error||'Connection interrupted');return d;}
 // --- Realtime multiplayer over WebSocket (PitthuRoom Durable Object) ---
 // WS URL: wss://<host>/ws?code=XXXXXX&token=<uuid>  (also /api/room/ws).
 // Inputs are sent fire-and-forget (never awaited); the server ticks at
 // 30 Hz and broadcasts state. There is NO polling fallback — polling
 // was the lag source (full D1 write + 409 collisions per input).
 function wsUrl(){const s=session.current||{};const proto=window.location.protocol==='https:'?'wss':'ws';return `${proto}://${window.location.host}/ws?code=${encodeURIComponent(s.code||'')}&token=${encodeURIComponent(s.token||'')}`;}
 function connectWs(){
  if(typeof window==='undefined'||!session.current||mode.current!=='online')return;
  if(wsRef.current&&(wsRef.current.readyState===WebSocket.OPEN||wsRef.current.readyState===WebSocket.CONNECTING))return;
  if(wsTimerRef.current){clearTimeout(wsTimerRef.current);wsTimerRef.current=null;}
  let ws:WebSocket;
  try{ws=new WebSocket(wsUrl());}catch(e:any){
   setConnection('Realtime connection failed — the PitthuRoom Durable Object is not deployed yet. Deploy with wrangler deploy (see README). Polling fallback was removed because it caused lag.');
   return;
  }
  wsRef.current=ws;
  ws.onopen=()=>{wsRetryRef.current=0;wsEverConnectedRef.current=true;setConnection('');};
  ws.onmessage=(ev)=>{
   let m:any;try{m=JSON.parse(ev.data);}catch{return;}
   if(m.type==='pong'&&typeof m.clientTime==='number'){setPingMs(Math.max(0,Math.round(Date.now()-m.clientTime)));return;}
   if(m.type==='state'||m.type==='hello'){
    if(mode.current==='online'&&session.current){
     // V2 netcode: only accept in-order snapshots (tick + serverTime
     // now come from the server). A stale/out-of-order snapshot is
     // dropped instead of snapping the game backwards.
     if(typeof m.tick==='number'&&typeof m.serverTime==='number'){
      if(!snapBufRef.current)snapBufRef.current=createSnapshotBuffer();
      if(!serverClockRef.current)serverClockRef.current=createServerClock();
      if(!pushSnapshot(snapBufRef.current,{tick:m.tick,serverTime:m.serverTime,state:m.state}))return;
      clockUpdate(serverClockRef.current,m.serverTime,Date.now());
     }
     accept(m.state);setConnection('');
    }
   }
   else if(m.type==='error'){setConnection(m.error||'Realtime error.');}
  };
  ws.onclose=()=>{
   if(wsRef.current===ws)wsRef.current=null;
   if(mode.current!=='online'||!session.current)return;
   if(!wsEverConnectedRef.current){
    setConnection('Realtime connection failed — the PitthuRoom Durable Object may not be deployed yet. Deploy with wrangler deploy (see README). Polling fallback was removed because it caused lag.');
   }else{
    setConnection('Live connection lost — reconnecting…');
   }
   const delay=Math.min(500*Math.pow(2,wsRetryRef.current),5000);
   wsRetryRef.current++;
   wsTimerRef.current=setTimeout(()=>{if(mode.current==='online'&&session.current)connectWs();},delay);
  };
  ws.onerror=()=>{/* onclose follows and reports the failure */};
 }
 // Send a lobby op (config/switchTeam/start/lobby) over the live socket
 // when possible; returns false if there is no open socket (caller falls
 // back to the HTTP lobby API, which forwards to the Durable Object).
 function sendWsOp(op:string,extra:any={}){
  const ws=wsRef.current;
  if(ws&&ws.readyState===WebSocket.OPEN&&session.current){
   try{ws.send(JSON.stringify({type:'op',op,token:session.current.token,...extra}));return true;}catch{return false;}
  }
  return false;
 }
 function closeWs(){
  // Only the reconnect timer is cleared here. The 50ms input sender is
  // mount-lifetime (it no-ops unless mode==='online'), so it must NOT be
  // cleared — the next room needs it again.
  if(wsTimerRef.current){clearTimeout(wsTimerRef.current);wsTimerRef.current=null;}
  const ws=wsRef.current;wsRef.current=null;
  try{ws?.close();}catch{}
 }
 function updateTeamSizes(next:number[],syncServer=false){
  const clean=normalizeTeamSizes(next,teamSizesRef.current);
  teamSizesRef.current=clean;
  setTeamSizes(clean);
  playSfx('ui');
  if(mode.current==='home'&&game.current){
   game.current=demo(clean);
  }
  if(syncServer&&mode.current==='online'&&session.current){
   if(!sendWsOp('config',{teamSizes:clean}))api('config',{teamSizes:clean}).then(r=>accept(r.state)).catch((e:any)=>setError(e.message));
  }
 }
 async function switchMyTeam(){
  if(mode.current==='online'&&session.current){
   playSfx('ui');
   if(sendWsOp('switchTeam'))return;
   try{accept((await api('switchTeam')).state);}catch(e:any){setError(e.message);}
  }
 }
 async function online(op:string,rejoin?:any){setBusy(true);setError('');try{if(rejoin)session.current=rejoin;const r=await api(op,{name:name||'Neighbour',look,teamSizes:teamSizesRef.current,code:rejoin?.code||code});session.current={code:r.state.code,token:r.token||session.current?.token,id:r.id||session.current?.id};myId.current=session.current.id;sessionStorage.setItem('pittu-session',JSON.stringify(session.current));controls.current.seq=Math.max(controls.current.seq,r.state.players.find((p:any)=>p.id===myId.current)?.seq+1||0);seenSfxSeq.current=r.state.sfxSeq||0;mode.current='online';setScreen(r.state.phase==='lobby'?'lobby':'play');accept(r.state);setResume(null);connectWs();}catch(e:any){setError(e.message);if(rejoin){sessionStorage.removeItem('pittu-session');session.current=null;setResume(null);}}finally{setBusy(false);}}
 function practice(){const ts=normalizeTeamSizes(teamSizesRef.current,[3,3]);const g=createGame('PRACTICE',ts);g.targetRounds=6;g.maxRounds=8;g.roundDuration=75;const p={...player('you',name||'Aarav',0),look};g.players=[p];g.host=p.id;start(g,true,ts);g.ready=1.2;game.current=g;myId.current='you';session.current=null;mode.current='practice';chargeStartedAt.current=0;seenRound.current=g.round;seenSfxSeq.current=g.sfxSeq||0;controls.current={mx:0,mz:0,ax:0,az:-1,interact:false,charging:false,charge:0,action:'',seq:0};lastUiKey.current=buildHudSignature(g,'you',0);setScreen('play');setUI({...g});setError('');playSfx('whistle');}
 async function leave(){
  // Closing the socket tells the Durable Object to convert the player to
  // a bot (active match) or remove them (lobby) — no HTTP leave needed.
  // Only use the HTTP leave when no socket was ever connected.
  const hadWs=!!wsRef.current;closeWs();
  if(session.current&&!hadWs){api('leave').catch(()=>{});}
  sessionStorage.removeItem('pittu-session');session.current=null;myId.current='';mode.current='home';game.current=demo(teamSizesRef.current);setScreen('home');setError('');setConnection('');keys.current={};chargeStartedAt.current=0;playSfx('ui');}
 async function launch(){setBusy(true);try{if(sendWsOp('start',{fill,teamSizes:teamSizesRef.current}))return;accept((await api('start',{fill,teamSizes:teamSizesRef.current})).state);}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 async function lobby(){if(mode.current==='practice'){practice();return;}if(sendWsOp('lobby'))return;try{const r=await api('lobby');game.current=r.state;setUI(r.state);setScreen('lobby');}catch(e:any){setError(e.message);}}
 function cycleCamera(e?:React.MouseEvent<HTMLButtonElement>){
  if(e)e.currentTarget.blur();
  const cur=camModeRef.current;
  const next=cur==='auto'?'close':cur==='close'?'wide':'auto';
  camModeRef.current=next;
  setCamMode(next);
  world.current?.setZoomMode?.(next);
  playSfx('ui');
 }

 useEffect(()=>{
  try{
   setIsTouch(('ontouchstart' in window)||(navigator.maxTouchPoints>0));
   const s=sessionStorage.getItem('pittu-session');if(s)setResume(JSON.parse(s));
   const q=new URLSearchParams(location.search).get('room');if(q){setCode(q.toUpperCase());setJoin(true);}
  }catch{}
 },[]);
 useEffect(()=>{isMuted.current=muted;if(!muted)playSfx('ui');},[muted]);

 useEffect(()=>{
  let stepIdx=0;
  const scale=[261.63,293.66,329.63,392.00,440.00,523.25,587.33,659.25];
  const pattern=[0,2,4,3, 5,4,2,1, 0,3,4,6, 5,4,3,2];
  const timer=setInterval(()=>{
   if(isMuted.current)return;
   const ctx=sound.current as AudioContext|null;
   if(!ctx||ctx.state!=='running')return;
   const g=game.current;
   const isChase=mode.current!=='home'&&g?.phase==='chase';
   const beat=stepIdx%8;
   if(beat===0||beat===3||beat===4){
    playTone(beat===0?92:108,0.11,'sine',isChase?0.032:0.02,52);
   }
   if(beat===2||beat===6||(isChase&&beat===7)){
    playTone(beat===2?310:370,0.065,'triangle',isChase?0.022:0.013,260);
    playNoise(0.03,isChase?0.016:0.009,2200);
   }
   if(beat%2===0||(isChase&&beat===5)){
    const note=scale[pattern[(stepIdx>>1)%pattern.length]];
    playTone(note,0.22,'triangle',isChase?0.022:0.015,note*0.998);
    if(beat===0)playTone(note*0.5,0.34,'sine',0.014,note*0.5);
   }
   stepIdx=(stepIdx+1)%64;
  },220);
  return()=>clearInterval(timer);
 },[]);

 useEffect(()=>{
  let gone=false,raf=0,last=performance.now(),refresh=0,smoothDt=1/60;
  import('../lib/world.js').then(async({makeWorld})=>{
   if(!container.current)return;
   const w=await makeWorld(container.current,(x:number,z:number)=>{
    const p=game.current.players.find((p:any)=>p.id===myId.current);
    if(!p)return;
    const isMoving=Math.hypot(controls.current.mx||0,controls.current.mz||0)>0.12;
    if(game.current?.ball?.holder===myId.current||!isMoving){
     let dx=x-p.x,dz=z-p.z,d=Math.hypot(dx,dz)||1;
     controls.current.ax=dx/d;controls.current.az=dz/d;
    }
   });
   if(gone){w.dispose();return;}world.current=w;w.setZoomMode?.(camModeRef.current);setLoaded(true);
   function frame(now:number){
    const rawDt=clamp((now-last)/1000,0.001,0.05);last=now;
    smoothDt=Math.abs(rawDt-smoothDt)>0.018?rawDt:(smoothDt*0.8+rawDt*0.2);
    const dt=smoothDt;
    syncKeyboardMotion();
    if(chargeStartedAt.current>0&&game.current?.ball?.holder===myId.current&&!aimStart.current?.canceled){
     const meP=game.current?.players?.find((p:any)=>p.id===myId.current);
     const cDur=meP?.buff==='banta'?225:620;
     controls.current.charging=true;
     controls.current.charge=clamp((now-chargeStartedAt.current)/cDur,0,1);
     if(now-lastChargeTick.current>135){
      lastChargeTick.current=now;
      playSfx('chargeTick',controls.current.charge);
     }
    }
    if(mode.current!=='online'&&!(mode.current==='practice'&&helpOpen.current)){
     if(mode.current==='practice'){syncRound(game.current);command(game.current,'you',{...controls.current,seq:++controls.current.seq,round:game.current.round});}
     controls.current.action='';
     for(let rem=rawDt;rem>0;rem-=1/60)step(game.current,Math.min(rem,1/60));
     if(mode.current==='home'&&game.current.phase==='match')game.current=demo(teamSizesRef.current);
    }else if(mode.current==='online'){
     // V2 netcode: no mutation of game.current here. Local prediction +
     // interpolation happen once, on the render copy, just before
     // w.update() below. Doing it here too would move the player twice
     // per frame (that double-step was caught in review, not shipped).
    }
    if(mode.current!=='home'&&game.current.sfxSeq&&game.current.sfxSeq!==seenSfxSeq.current){
     seenSfxSeq.current=game.current.sfxSeq;
     playSfx(game.current.sfxType,game.current.sfxType==='stonePlaced'?game.current.stack:(game.current.ball?.power||0.7));
    }
    const localMe=game.current.players.find((p:any)=>p.id===myId.current);
    if(localMe&&localMe.place>0&&now-lastPlaceTick.current>140){
     lastPlaceTick.current=now;
     playSfx('placeTick',localMe.place/0.65);
    }
    let renderGame=game.current;
    if(mode.current==='online'&&snapBufRef.current&&serverClockRef.current){
     const renderTime=clockNow(serverClockRef.current,Date.now())-INTERP_DELAY_MS;
     const sampled=sampleRenderState(snapBufRef.current,renderTime);
     if(sampled.state){
      // Deep-enough copy: fresh player objects so stepOnlineVisuals /
      // world lerp never mutate the authoritative snapshot.
      renderGame={...sampled.state,players:(sampled.state.players||[]).map((q:any)=>({...q})),ball:sampled.state.ball?{...sampled.state.ball}:sampled.state.ball};
      const meR=renderGame.players.find((q:any)=>q.id===myId.current);
      if(meR&&predictedPosRef.current){meR.x=predictedPosRef.current.x;meR.z=predictedPosRef.current.z;}
      // Re-apply local dead-reckoning to the render copy only.
      stepOnlineVisuals(renderGame,myId.current,controls.current,dt);
      // stepOnlineVisuals moved the render copy's local player from the
      // predicted position; keep predictedPosRef in sync with it.
      const meR2=renderGame.players.find((q:any)=>q.id===myId.current);
      if(meR2)predictedPosRef.current={x:meR2.x,z:meR2.z};
     }
    }
    w.update(renderGame,myId.current,now/1000,dt);
    // Only trigger React state reconciliation when a HUD-displayed value has actually changed
    if(now-refresh>75){
     refresh=now;
     const nextKey=buildHudSignature(game.current,myId.current,controls.current.charge||0);
     if(nextKey!==lastUiKey.current){
      lastUiKey.current=nextKey;
      setUI({...game.current});
     }
    }
    raf=requestAnimationFrame(frame);
   }
   raf=requestAnimationFrame(frame);
  }).catch((e)=>{console.error(e);setError('3D rendering could not start. Try a browser with WebGL enabled.');});
  const down=(e:KeyboardEvent)=>{
   if((e.target as HTMLElement).matches('input'))return;if(mode.current==='home')return;if(helpOpen.current&&e.code!=='Escape')return;
   if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
   keys.current[e.code]=true;syncKeyboardMotion();
   if(!e.repeat){
    if(e.code==='KeyC'){
     cycleCamera();
     return;
    }
    if(e.code==='Space'){
     if(game.current?.ball?.holder===myId.current){
      chargeStartedAt.current=performance.now();
      controls.current.charging=true;
      controls.current.charge=0.05;
      controls.current.mx=0;controls.current.mz=0;
     }else if(game.current?.phase==='chase'){
      controls.current.action='throw';
     }
    }
    if(e.code==='KeyE'&&game.current?.phase==='chase')triggerBuilderAction();
    if(e.code==='KeyF'&&game.current?.phase==='chase')controls.current.action='pass';
    if(e.code==='KeyQ'||e.code==='ShiftLeft'||e.code==='ShiftRight'){
     if(!cancelCharge()&&e.code==='KeyQ')controls.current.action='drop';
    }
    if(e.code==='Escape'){
     if(!cancelCharge())setHelp(v=>!v);
    }
   }
  };
  const up=(e:KeyboardEvent)=>{
   keys.current[e.code]=false;syncKeyboardMotion();
   if(e.code==='Space'&&chargeStartedAt.current>0){
    const meP=game.current?.players?.find((p:any)=>p.id===myId.current);
    const cDur=meP?.buff==='banta'?225:620;
    controls.current.charge=clamp((performance.now()-chargeStartedAt.current)/cDur,0.05,1);
    chargeStartedAt.current=0;
    controls.current.charging=false;
    controls.current.action='throw';
   }
  };
  const globalPointerUp=(e:PointerEvent)=>{
   if(joystick.current&&joystick.current.id===e.pointerId){
    joystick.current=null;controls.current.mx=0;controls.current.mz=0;
    if(stickKnob.current)stickKnob.current.style.transform='translate(0px,0px)';
   }
   if(touchInteract.current&&(touchInteractId.current===null||touchInteractId.current===e.pointerId)){
    touchInteract.current=false;touchInteractId.current=null;
   }
  };
  const blur=()=>{keys.current={};chargeStartedAt.current=0;touchInteract.current=false;touchInteractId.current=null;joystick.current=null;if(stickKnob.current)stickKnob.current.style.transform='translate(0px,0px)';controls.current.mx=controls.current.mz=0;controls.current.interact=false;controls.current.charging=false;};
  window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);window.addEventListener('pointerup',globalPointerUp);window.addEventListener('pointercancel',globalPointerUp);
  return()=>{gone=true;cancelAnimationFrame(raf);world.current?.dispose();window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);window.removeEventListener('pointerup',globalPointerUp);window.removeEventListener('pointercancel',globalPointerUp);};
 },[]);

 useEffect(()=>{
  // Realtime input sender: every 50ms (20 Hz), fire-and-forget over the
  // WebSocket. Nothing is awaited, so input latency is one WS frame, not
  // a 90ms poll + round-trip + D1 write. A one-shot action (throw/pass/
  // interact) is cleared ONLY after a successful send, so it survives a
  // dropped socket and fires on reconnect instead of being lost.
  // Solo/practice mode is untouched — it steps locally in the frame loop.
  const t=setInterval(()=>{
   if(mode.current!=='online'||!session.current||!game.current)return;
   const ws=wsRef.current;
   if(!ws||ws.readyState!==WebSocket.OPEN){if(!wsRef.current)connectWs();return;}
   syncKeyboardMotion();
   if(++pingTickRef.current>=20){pingTickRef.current=0;try{ws.send(JSON.stringify({type:'ping',clientTime:Date.now()}));}catch{}}
   const sentAction=controls.current.action;
   const input={...controls.current,action:sentAction,seq:++controls.current.seq,round:game.current.round};
   try{ws.send(JSON.stringify({type:'input',input}));controls.current.action='';}
   catch{/* keep the action; it retries on the next 50ms tick */}
  },50);
  wsSendTimerRef.current=t;
  return()=>{clearInterval(t);};
 },[]);

 const me=ui?.players.find((p:any)=>p.id===myId.current),playing=screen==='play',held=ui?.ball.holder===myId.current,builder=me?.team===ui?.attack;
 const isOpening=ui?.phase==='opening';
 const moveLocked=isOpening||held||(me?.charging)||((me?.anim||0)>0);
 const isCharging=held&&(chargeStartedAt.current>0||(me?.charge||0)>0.02);
 const chargePct=held?Math.round(clamp(me?.charge||controls.current.charge||0,0,1)*100):0;
 const passMate=held&&me?findPassTarget(ui,me,me.ax,me.az):null;
 const activeBuff=me?.buff&&(me?.buffTime||0)>0?BUFF_META[me.buff]:null;
 const nearLooseStone=!!(builder&&ui?.phase==='chase'&&me?.carry===null&&(ui?.stones||[]).some((s:any)=>!s.placed&&s.held===null&&Math.hypot(me.x-s.x,me.z-s.z)<1.05));
 const inStackCircle=!!(builder&&ui?.phase==='chase'&&me?.carry!==null&&Math.hypot(me.x,me.z)<1.15);
 const objective=isOpening?(ui.striker===myId.current?'Stationary Striker: Aim & hold THROW (0–100%) to strike the 7 stones!':'Hold your starting position—chase begins as soon as the tower is hit!'):!me?.alive?'You’re out this round. Cheer your team on!':builder?(me.carry!==null?((me.place||0)>0?`Arranging stone on the stack (${Math.round(clamp(me.place/0.65,0,1)*100)}%)—keep holding!`:inStackCircle?'Inside center circle! Hold STACK (or hold E) to arrange the stone on the tower!':'Carry your stone into the glowing center circle, then hold STACK (or E).'):(nearLooseStone?'Stone in reach! Tap PICK UP (or press E) to grab it!':'Move to a scattered stone and tap PICK UP (or E). Grab power-ups & dodge!')):held?(me?.inTowerZone?'Inside Tower Crease Zone (Throw Power Reduced)! Pass to a teammate or step out before catching!':passMate?`Aimed at ${passMate.name}! Release THROW to pass directly to your teammate!`:chargePct>=99?'MAX POWER 100% READY! Release THROW to fire (or slide to ✕ CANCEL).':'Stationary Thrower: Hold & release THROW to strike (aim at a teammate to pass).'):(me?.inTowerZone?'Tower Crease Zone slows defenders! Guard just outside the orange ring!':'Chase the loose ball or guard outside the orange tower ring!');
 const actionKey=!me?.alive?'OUT':isOpening?(ui.striker===myId.current?(chargePct>0?'RELEASE / Q':'HOLD SPACE'):'HOLD POS'):builder?'E':held?(chargePct>0?'RELEASE / Q':'HOLD SPACE'):'MOVE';
 const actionText=!me?.alive?'WATCHING ROUND':isOpening?(ui.striker===myId.current?(chargePct>=99?'MAX 100% READY · RELEASE TO THROW':chargePct>0?`CHARGING ${chargePct}% · RELEASE TO THROW`:'STATIONARY · HOLD TO CHARGE THROW'):'HOLD STARTING POSITION'):builder?(me?.carry!==null?((me?.place||0)>0?`STACKING ${Math.round(clamp((me?.place||0)/0.65,0,1)*100)}%`:inStackCircle?'HOLD E · ARRANGE & STACK STONE':'CARRY STONE TO CENTER CIRCLE'):(nearLooseStone?'TAP E · PICK UP STONE':'MOVE TO A STONE · THEN PRESS E')):held?(passMate?`PASS TO ${passMate.name.toUpperCase()}`:chargePct>=99?'MAX 100% READY · RELEASE TO THROW':chargePct>0?`CHARGING ${chargePct}% · RELEASE TO THROW`:'STATIONARY · HOLD THROW'):'AUTO-CATCHES TEAM PASSES';

 async function copy(){try{await navigator.clipboard.writeText(ui.code);setCopied(true);setTimeout(()=>setCopied(false),1600);}catch{setError('Select and copy the room code above.');}}
 const tealPlayers=ui?.players.filter((p:any)=>p.team===0)||[],coralPlayers=ui?.players.filter((p:any)=>p.team===1)||[];

 function onStickDown(e:React.PointerEvent<HTMLDivElement>){
  e.stopPropagation();setIsTouch(true);getAudioCtx();
  if(game.current?.phase==='opening'||game.current?.ball?.holder===myId.current){
   controls.current.mx=0;controls.current.mz=0;
   return;
  }
  try{e.currentTarget.setPointerCapture(e.pointerId);}catch{}
  const r=e.currentTarget.getBoundingClientRect();
  const cx=r.left+r.width*.5,cy=r.top+r.height*.5;
  joystick.current={id:e.pointerId,cx,cy};
  updateStick(e.clientX,e.clientY,cx,cy);
 }
 function onStickMove(e:React.PointerEvent<HTMLDivElement>){
  if(!joystick.current||joystick.current.id!==e.pointerId)return;
  e.stopPropagation();
  if(game.current?.phase==='opening'||game.current?.ball?.holder===myId.current){
   controls.current.mx=0;controls.current.mz=0;
   if(stickKnob.current)stickKnob.current.style.transform='translate(0px,0px)';
   return;
  }
  updateStick(e.clientX,e.clientY,joystick.current.cx,joystick.current.cy);
 }
 function updateStick(clientX:number,clientY:number,cx:number,cy:number){
  const dx=clientX-cx,dy=clientY-cy,dist=Math.hypot(dx,dy),maxR=34;
  if(dist<4){
   controls.current.mx=0;controls.current.mz=0;
   if(stickKnob.current)stickKnob.current.style.transform='translate(0px,0px)';
   return;
  }
  const clamped=Math.min(dist,maxR),nx=dx/dist,ny=dy/dist,mag=clamped/maxR;
  controls.current.mx=nx*mag;controls.current.mz=ny*mag;
  if(game.current?.ball?.holder!==myId.current){
   controls.current.ax=nx;controls.current.az=ny;
  }
  if(stickKnob.current)stickKnob.current.style.transform=`translate(${(nx*clamped).toFixed(1)}px,${(ny*clamped).toFixed(1)}px)`;
 }
 function onStickUp(e:React.PointerEvent<HTMLDivElement>){
  if(!joystick.current||joystick.current.id!==e.pointerId)return;
  joystick.current=null;controls.current.mx=0;controls.current.mz=0;
  if(stickKnob.current)stickKnob.current.style.transform='translate(0px,0px)';
 }

 function onAimDown(e:React.PointerEvent<HTMLButtonElement>){
  e.stopPropagation();setIsTouch(true);getAudioCtx();
  try{e.currentTarget.setPointerCapture(e.pointerId);}catch{}
  const r=e.currentTarget.getBoundingClientRect();
  aimStart.current={id:e.pointerId,cx:r.left+r.width*.5,cy:r.top+r.height*.5,moved:false,canceled:false};
  if(game.current?.ball?.holder===myId.current){
   chargeStartedAt.current=performance.now();
   controls.current.charging=true;
   controls.current.charge=0.05;
   controls.current.mx=0;controls.current.mz=0;
  }
 }
 function onAimMove(e:React.PointerEvent<HTMLButtonElement>){
  if(!aimStart.current||aimStart.current.id!==e.pointerId)return;
  e.stopPropagation();
  if(cancelBtnRef.current){
   const cr=cancelBtnRef.current.getBoundingClientRect();
   if(cr.width>0&&e.clientX>=cr.left-14&&e.clientX<=cr.right+14&&e.clientY>=cr.top-14&&e.clientY<=cr.bottom+14){
    if(!aimStart.current.canceled){
     aimStart.current.canceled=true;
     controls.current.charging=false;
     controls.current.charge=0;
     controls.current.action='cancel';
     if(aimKnob.current)aimKnob.current.style.transform='translate(0px,0px)';
     playSfx('cancel');
    }
    return;
   }else if(aimStart.current.canceled){
    aimStart.current.canceled=false;
    if(game.current?.ball?.holder===myId.current){
     if(chargeStartedAt.current<=0)chargeStartedAt.current=performance.now();
     controls.current.charging=true;
    }
   }
  }
  const dx=e.clientX-aimStart.current.cx,dy=e.clientY-aimStart.current.cy,d=Math.hypot(dx,dy),maxR=28;
  if(d>6){
   aimStart.current.moved=true;
   controls.current.ax=dx/d;controls.current.az=dy/d;
   const c=Math.min(d,maxR);
   if(aimKnob.current)aimKnob.current.style.transform=`translate(${(dx/d*c).toFixed(1)}px,${(dy/d*c).toFixed(1)}px)`;
  }else{
   if(aimKnob.current)aimKnob.current.style.transform='translate(0px,0px)';
  }
 }
 function onAimUp(e:React.PointerEvent<HTMLButtonElement>){
  if(!aimStart.current||aimStart.current.id!==e.pointerId)return;
  const wasCanceled=!!aimStart.current.canceled;
  const meP=game.current?.players?.find((p:any)=>p.id===myId.current);
  const cDur=meP?.buff==='banta'?225:620;
  const currentHeldCharge=meP?.charge||controls.current.charge||0;
  const elapsedCharge=chargeStartedAt.current>0?clamp((performance.now()-chargeStartedAt.current)/cDur,0.08,1):currentHeldCharge;
  const finalCharge=clamp(Math.max(elapsedCharge,currentHeldCharge,0.08),0.08,1);
  chargeStartedAt.current=0;
  controls.current.charging=false;
  aimStart.current=null;
  if(aimKnob.current)aimKnob.current.style.transform='translate(0px,0px)';
  if(!wasCanceled&&game.current?.ball?.holder===myId.current){
   controls.current.charge=finalCharge;
   controls.current.action='throw';
  }else{
   controls.current.charge=0;
   controls.current.action='cancel';
  }
 }

 return <main className={'app '+screen+(isTouch?' touchDevice':'')} onContextMenu={e=>e.preventDefault()}>
  <div className={'world '+(screen==='home'?'homeWorld':'')} ref={container} onContextMenu={e=>{e.preventDefault();if(playing){if(!cancelCharge()&&game.current?.phase==='chase')controls.current.action='pass';}}} onPointerDown={e=>{getAudioCtx();if(playing&&e.pointerType==='mouse'&&(e.target as HTMLElement).tagName==='CANVAS'){if(e.button===2){e.preventDefault();cancelCharge();return;}if(e.button===0){if(game.current?.ball?.holder===myId.current){chargeStartedAt.current=performance.now();controls.current.charging=true;controls.current.charge=0.05;controls.current.mx=0;controls.current.mz=0;}else if(game.current?.phase==='chase'){controls.current.action='throw';}}}}} onPointerUp={e=>{if(playing&&e.pointerType==='mouse'&&e.button===0&&chargeStartedAt.current>0){const meP=game.current?.players?.find((p:any)=>p.id===myId.current);const cDur=meP?.buff==='banta'?225:620;controls.current.charge=clamp((performance.now()-chargeStartedAt.current)/cDur,0.08,1);chargeStartedAt.current=0;controls.current.charging=false;controls.current.action='throw';}}}/>

  <header className="topbar">
   <button className="brand" onMouseDown={e=>e.preventDefault()} onClick={()=>{if(playing||screen==='lobby')leave();}} aria-label="Pittu home">
    <span className="stoneLogo"><i/><i/><i/></span>PITTU<span className="brandDot">•</span>
   </button>
   <div className="toptools">
    {playing&&<button className="icon camBtn" aria-label="Toggle camera zoom" title={`Camera: ${camMode.toUpperCase()} (C)`} onMouseDown={e=>e.preventDefault()} onClick={cycleCamera}><Camera size={17}/><small>{camMode==='auto'?'AUTO':camMode==='close'?'ZOOM':'WIDE'}</small></button>}
    <button className="icon" aria-label={muted?'Turn sound on':'Mute sound'} onMouseDown={e=>e.preventDefault()} onClick={e=>{e.currentTarget.blur();setMuted(!muted);}}>{muted?<VolumeX size={19}/>:<Volume2 size={19}/>}</button>
    <button className="icon" aria-label="How to play" onMouseDown={e=>e.preventDefault()} onClick={e=>{e.currentTarget.blur();playSfx('ui');setHelp(true);}}><HelpCircle size={19}/></button>
   </div>
  </header>

  {!loaded&&<div className="loading"><span/>Opening the courtyard…</div>}

  {screen==='home'&&<>
   <section className="hero">
    <div className="brushTitleWrap">
     <h1 className="brushTitle">PITTU</h1>
     <span className="brushUnderline"/>
     <p className="heroSub">{`AFTER-SCHOOL COURTYARD · ${teamSizes[0]}v${teamSizes[1]} SEVEN STONES`}</p>
    </div>

    <div className="playcard">
     <div className="identityBar">
      <input id="nickname" aria-label="Your nickname" maxLength={16} value={name} onChange={e=>setName(e.target.value)} placeholder="Your nickname" autoComplete="off"/>
      <div className="lookrow">
       <button aria-label="Previous character" onClick={()=>{playSfx('ui');setLook((look+7)%8);}}>‹</button>
       <span><img src={portraitFor(0,look)} alt="" className="miniPortrait"/>{LOOKS[look]}</span>
       <button aria-label="Next character" onClick={()=>{playSfx('ui');setLook((look+1)%8);}}>›</button>
      </div>
     </div>

     <div className="teamSizeBox" role="group" aria-label="Custom team size selector">
      <div className="teamSizeHeader">
       <span className="teamSizeLabel">SQUAD FORMAT (2–4 PER TEAM)</span>
       <span className={'matchModeTag '+(teamSizes[0]===teamSizes[1]?'symTag':'asymTag')}>
        {teamSizes[0]===teamSizes[1]?`${teamSizes[0]}v${teamSizes[1]} BALANCED`:`${teamSizes[0]}v${teamSizes[1]} ASYMMETRIC`}
       </span>
      </div>
      <div className="presetRow">
       {([[2,2],[3,3],[4,4],[2,4],[3,4]] as [number,number][]).map(([a,b])=>{
        const active=teamSizes[0]===a&&teamSizes[1]===b;
        return <button key={`${a}v${b}`} type="button" className={'presetChip'+(active?' activePreset':'')} onClick={()=>updateTeamSizes([a,b])}>{`${a}v${b}`}</button>;
       })}
      </div>
      <div className="stepperGrid">
       <div className="teamStepper tealStepper">
        <span className="stepperName">TEAL</span>
        <div className="stepperControls">
         <button type="button" className="stepBtn" aria-label="Decrease Teal players" disabled={teamSizes[0]<=2} onClick={()=>updateTeamSizes([teamSizes[0]-1,teamSizes[1]])}>−</button>
         <b className="stepVal">{teamSizes[0]}</b>
         <button type="button" className="stepBtn" aria-label="Increase Teal players" disabled={teamSizes[0]>=4} onClick={()=>updateTeamSizes([teamSizes[0]+1,teamSizes[1]])}>+</button>
        </div>
       </div>
       <span className="vsDivider">VS</span>
       <div className="teamStepper coralStepper">
        <span className="stepperName">CORAL</span>
        <div className="stepperControls">
         <button type="button" className="stepBtn" aria-label="Decrease Coral players" disabled={teamSizes[1]<=2} onClick={()=>updateTeamSizes([teamSizes[0],teamSizes[1]-1])}>−</button>
         <b className="stepVal">{teamSizes[1]}</b>
         <button type="button" className="stepBtn" aria-label="Increase Coral players" disabled={teamSizes[1]>=4} onClick={()=>updateTeamSizes([teamSizes[0],teamSizes[1]+1])}>+</button>
        </div>
       </div>
      </div>
     </div>

     <button className="practiceHeroBtn" onClick={practice} disabled={!loaded}>
      <Play size={22} fill="currentColor"/>
      <span>{`PRACTICE (${teamSizes[0]}v${teamSizes[1]})`}</span>
     </button>

     <div className="duo">
      <button disabled={busy||!loaded} onClick={()=>{playSfx('ui');online('create');}}><Users size={16}/>CREATE ROOM</button>
      <button disabled={busy} onClick={()=>{playSfx('ui');setJoin(!join);}}><Link2 size={16}/>JOIN ROOM</button>
     </div>

     {join&&<form className="joinform" onSubmit={e=>{e.preventDefault();online('join');}}>
      <input aria-label="Room code" maxLength={6} placeholder="ROOM CODE" value={code} onChange={e=>setCode(e.target.value.toUpperCase())}/>
      <button type="submit" disabled={busy||code.length!==6}>JOIN</button>
     </form>}

     {resume&&<button className="resume" onClick={()=>online('join',resume)}>Rejoin courtyard {resume.code} →</button>}
    </div>
   </section>

   <div className="heroModelRender" aria-hidden="true">
    <img src="/portraits/hero.png" alt="Pittu courtyard characters"/>
   </div>

   <footer className="homeFooter">
    <span>{`Stationary Aim & Throw · 6 Courtyard Power-Ups · Tower Crease Zone · ${teamSizes[0]}v${teamSizes[1]} Squads`}</span>
    <button onClick={()=>{playSfx('ui');setHelp(true);}}>How to play <ArrowRight size={14}/></button>
   </footer>
  </>}

  {screen==='lobby'&&ui&&(()=>{
   const lobbySizes=normalizeTeamSizes(ui.teamSizes||teamSizes,[3,3]);
   const isHost=ui.host===myId.current;
   const t0Humans=ui.players.filter((p:any)=>!p.bot&&p.team===0).length;
   const t1Humans=ui.players.filter((p:any)=>!p.bot&&p.team===1).length;
   const canLaunchNoFill=t0Humans>=2&&t1Humans>=2;
   return <section className="lobby panel">
    <button className="back" onClick={leave}><ArrowLeft size={16}/>Back to courtyard</button>
    <div className="eyebrow">THE GANG’S GETTING TOGETHER</div>
    <h2>Your corner of the courtyard.</h2>
    <p>Share this six-character room code with your friends on phone or PC.</p>
    <button className="roomcode" onClick={copy}>{ui.code}{copied?<Check size={21}/>:<Copy size={21}/>}</button>

    <div className="teamSizeBox lobbySizeBox" role="group" aria-label="Lobby team size configuration">
     <div className="teamSizeHeader">
      <span className="teamSizeLabel">MATCH FORMAT (2–4 PER TEAM)</span>
      <span className={'matchModeTag '+(lobbySizes[0]===lobbySizes[1]?'symTag':'asymTag')}>
       {lobbySizes[0]===lobbySizes[1]?`${lobbySizes[0]}v${lobbySizes[1]} BALANCED`:`${lobbySizes[0]}v${lobbySizes[1]} ASYMMETRIC`}
      </span>
     </div>
     {isHost&&<div className="presetRow">
      {([[2,2],[3,3],[4,4],[2,4],[3,4]] as [number,number][]).map(([a,b])=>{
       const active=lobbySizes[0]===a&&lobbySizes[1]===b;
       return <button key={`${a}v${b}`} type="button" className={'presetChip'+(active?' activePreset':'')} onClick={()=>updateTeamSizes([a,b],true)}>{`${a}v${b}`}</button>;
      })}
     </div>}
     <div className="stepperGrid">
      <div className="teamStepper tealStepper">
       <span className="stepperName">TEAL</span>
       <div className="stepperControls">
        <button type="button" className="stepBtn" disabled={!isHost||lobbySizes[0]<=Math.max(2,t0Humans)} onClick={()=>updateTeamSizes([lobbySizes[0]-1,lobbySizes[1]],true)}>−</button>
        <b className="stepVal">{lobbySizes[0]}</b>
        <button type="button" className="stepBtn" disabled={!isHost||lobbySizes[0]>=4} onClick={()=>updateTeamSizes([lobbySizes[0]+1,lobbySizes[1]],true)}>+</button>
       </div>
      </div>
      <span className="vsDivider">VS</span>
      <div className="teamStepper coralStepper">
       <span className="stepperName">CORAL</span>
       <div className="stepperControls">
        <button type="button" className="stepBtn" disabled={!isHost||lobbySizes[1]<=Math.max(2,t1Humans)} onClick={()=>updateTeamSizes([lobbySizes[0],lobbySizes[1]-1],true)}>−</button>
        <b className="stepVal">{lobbySizes[1]}</b>
        <button type="button" className="stepBtn" disabled={!isHost||lobbySizes[1]>=4} onClick={()=>updateTeamSizes([lobbySizes[0],lobbySizes[1]+1],true)}>+</button>
       </div>
      </div>
     </div>
     <span className="teamSizeHint">Teams retain their exact player count ({lobbySizes[0]} vs {lobbySizes[1]}) when swapping Attack &amp; Defense each round.</span>
    </div>

    <div className="teams">
     {[0,1].map(team=>{
      const teamCap=lobbySizes[team];
      const teamList=ui.players.filter((p:any)=>p.team===team);
      return <div key={team} className={team?'coral':'teal'}>
       <div className="teamColHeader">
        <h3>Team {team?'Coral':'Teal'}</h3>
        <span className="teamCountBadge">{`${teamList.length}/${teamCap} SLOTS`}</span>
        {me&&me.team!==team&&teamList.length<teamCap&&<button type="button" className="switchTeamBtn" onClick={switchMyTeam}>Join {team?'Coral':'Teal'} →</button>}
       </div>
       {Array.from({length:teamCap},(_,i)=>{
        let p=teamList[i];
        const pSrc=p?portraitFor(team,p.look):portraitFor(team,(team*4+i)%8);
        return <div className="slot" key={i}>
         <img src={pSrc} alt="" className="slotPortrait"/>
         {p?p.name:(fill?'Practice Teammate Ready':'Waiting for a friend…')}
         {p?.id===myId.current&&<small>YOU</small>}
        </div>;
       })}
      </div>;
     })}
    </div>
    {!fill&&!canLaunchNoFill&&<div className="lobbyWarn">Each team needs at least 2 human players when practice teammates are off—or enable practice teammates below.</div>}
    {isHost?<>
     <label className="check"><input type="checkbox" checked={fill} onChange={e=>setFill(e.target.checked)}/>Fill empty spots with practice teammates</label>
     <button className="primary" onClick={launch} disabled={busy||(!fill&&!canLaunchNoFill)}>{`Let’s play (${lobbySizes[0]}v${lobbySizes[1]})`}<ArrowRight size={18}/></button>
    </>:<p className="waiting">Waiting for the host to start…</p>}
    <small>Everyone gets a turn to rebuild. Each team moves together as a unit when swapping sides.</small>
   </section>;
  })()}

  {playing&&ui&&(()=>{
   const activeSizes=normalizeTeamSizes(ui.teamSizes,[tealPlayers.length||3,coralPlayers.length||3]);
   const tealCount=Math.max(2,tealPlayers.length||activeSizes[0]);
   const coralCount=Math.max(2,coralPlayers.length||activeSizes[1]);
   return <>
   <div className="hudTop">
    <button className="icon leaveBtn" onMouseDown={e=>e.preventDefault()} onClick={leave} aria-label="Leave game"><ArrowLeft size={18}/></button>
    {playing&&pingMs!==null&&<span title="Ping — round-trip time to the game server" style={{fontSize:12,padding:'4px 8px',borderRadius:999,background:'rgba(0,0,0,0.35)',color:'#fff',whiteSpace:'nowrap'}}>{pingMs} ms</span>}

    <div className="teamCard tealCard">
     <b className="teamScore">{ui.scores[0]}</b>
     <div className={'teamPortraits'+(tealCount>=4?' compactPortraits':'')}>
      {Array.from({length:tealCount},(_,i)=>{
       const p=tealPlayers[i],alive=p?p.alive:true;
       return <div key={p?.id||i} className={'portraitSlot '+(alive?'':'eliminated')} title={p?`${p.name}${alive?'':' (Out)'}`:'Teal'}>
        <img src={portraitFor(0,p?p.look:i)} alt={p?.name||'Teal'}/>
        {!alive&&<span className="outCross">×</span>}
       </div>;
      })}
     </div>
     <span className="teamLabel">TEAL</span>
    </div>

    <div className="centerHud">
     <div className="timerPill">
      <span>{ui.round<(ui.targetRounds||6)?`ROUND ${ui.round+1} / ${ui.targetRounds||6}`:'OVERTIME'} · {`${tealCount}v${coralCount}`} · {mode.current==='practice'?'PRACTICE':ui.code}</span>
      <strong>
       {ui.phase==='opening'?(ui.ready>0?`READY ${Math.ceil(ui.ready)}`:`SHOT ${Math.ceil(ui.until)}s`):ui.phase==='result'?'ROUND OVER':ui.phase==='match'?'FINAL':fmtClock(ui.time)}
      </strong>
     </div>
     <div className="rebuildBar">
      <span className="rebuildLabel">{ui.phase==='opening'?`${ui.attempts} SHOTS`:'REBUILD'}</span>
      <div className="stoneSlots" aria-label={`${ui.stack} of 7 stones stacked`}>
       {Array.from({length:7},(_,i)=><i key={i} className={i<ui.stack?'filled':''}/>)}
      </div>
      <b className="rebuildCount">{ui.stack} / 7</b>
     </div>
    </div>

    <div className="teamCard coralCard">
     <span className="teamLabel">CORAL</span>
     <div className={'teamPortraits'+(coralCount>=4?' compactPortraits':'')}>
      {Array.from({length:coralCount},(_,i)=>{
       const p=coralPlayers[i],alive=p?p.alive:true;
       return <div key={p?.id||i} className={'portraitSlot '+(alive?'':'eliminated')} title={p?`${p.name}${alive?'':' (Out)'}`:'Coral'}>
        <img src={portraitFor(1,p?p.look:i+1)} alt={p?.name||'Coral'}/>
        {!alive&&<span className="outCross">×</span>}
       </div>;
      })}
     </div>
     <b className="teamScore">{ui.scores[1]}</b>
    </div>
   </div>

   <div className="statusBannerRow" role="status">
    {activeBuff&&<div className={'buffPill '+(me.buffTime<1.5?'expiring':'')} style={{borderColor:activeBuff.color}}>
     <span className="buffDot" style={{backgroundColor:activeBuff.color,color:activeBuff.color}}/>
     <span>{activeBuff.name} · {me.buffTime.toFixed(1)}s</span>
     <div className="buffBarWrap"><div className="buffBarFill" style={{width:`${clamp((me.buffTime/(me.buffMax||6))*100,0,100)}%`,backgroundColor:activeBuff.color}}/></div>
    </div>}
    {me?.inTowerZone&&<div className="zoneWarnPill">⚠ TOWER ZONE · DEFENDER SPEED &amp; THROW POWER REDUCED</div>}
   </div>

   <div className={'youBadge '+(me?.team?'coralYou':'tealYou')+(me&&!me.alive?' youOut':'')}>
    <div className="youAvatar">
     <img src={portraitFor(me?.team||0,me?.look??look)} alt="You"/>
     {me&&!me.alive&&<span className="outCross">×</span>}
    </div>
    <div className="youInfo">
     <strong>{me?.name||'YOU'} <span>YOU</span></strong>
     <small>{objective}</small>
    </div>
   </div>

   {!isTouch&&<div className="actionPromptPill">
    <kbd className="promptKey">{actionKey}</kbd>
    <span className="promptText">{actionText}</span>
    <span className={'promptIcon '+(builder?'stoneIcon':'ballIcon')} aria-hidden="true"><i/><i/><i/></span>
   </div>}

   <div className="touchControls">
    <div className={'stick '+(moveLocked?'stickLocked':'')} aria-label="Move joystick" onPointerDown={onStickDown} onPointerMove={onStickMove} onPointerUp={onStickUp} onPointerCancel={onStickUp}>
     <span ref={stickKnob}/>
    </div>
    <div className="touchRight">
     {builder&&ui.phase==='chase'?<>
      <button className={'actionButton '+((me?.carry!==null?(inStackCircle||(me?.place||0)>0):nearLooseStone)?'activeAim':'')} onPointerDown={e=>{e.stopPropagation();setIsTouch(true);getAudioCtx();try{e.currentTarget.setPointerCapture(e.pointerId);}catch{}triggerBuilderAction(e.pointerId);}} onPointerUp={e=>{e.stopPropagation();touchInteract.current=false;touchInteractId.current=null;}} onPointerCancel={()=>{touchInteract.current=false;touchInteractId.current=null;}}>
       <span>{me?.carry!==null?((me?.place||0)>0?`STACKING\n${Math.round(clamp((me?.place||0)/0.65,0,1)*100)}%`:inStackCircle?'HOLD TO\nSTACK':'CARRY TO\nCENTER'):(nearLooseStone?'TAP TO\nPICK UP':'MOVE TO\nSTONE')}</span>
      </button>
     </>:<>
      {held&&<button ref={cancelBtnRef} className={'smallAction cancelBtn '+(isCharging?'cancelActive':'')} style={{display:isCharging?'grid':'none'}} onPointerDown={e=>{e.stopPropagation();cancelCharge();}}>✕\nCANCEL</button>}
      <button className={'actionButton aimButton '+(held?(aimStart.current?.canceled?'canceledAim':'activeAim'):'')} onPointerDown={onAimDown} onPointerMove={onAimMove} onPointerUp={onAimUp} onPointerCancel={onAimUp}>
       <span ref={aimKnob}>{held?(aimStart.current?.canceled?'CANCELED\nRELEASE':passMate?`PASS TO\n${passMate.name.toUpperCase()}`:chargePct>=99?'MAX 100%\nRELEASE FIRE':chargePct>5?`POWER ${chargePct}%\nRELEASE FIRE`:'HOLD & DRAG\nTHROW'):(isOpening?'WAIT FOR\nSTRIKE':'AIM')}</span>
      </button>
     </>}
    </div>
   </div>

   {ui.phase==='opening'&&ui.ready>0&&<div className="roundResult" role="status">
    <span>ROUND {ui.round+1} · {builder?'YOUR TEAM BUILDS':'YOUR TEAM DEFENDS'}</span>
    <h2>{builder?'Knock it down. Build it back.':'Hold position until the strike.'}</h2>
    <p>Everyone holds starting positions until the tower is hit. Starting in {Math.ceil(ui.ready)}…</p>
   </div>}

   {ui.phase==='result'&&<div className="roundResult" role="status">
    <span>ROUND {ui.round+1} · TEAM {ui.outcome?.winner===0?'TEAL':'CORAL'} {ui.outcome?.point?'SCORES':'DEFENDS'}</span>
    <h2>{ui.message}</h2>
    <p>{ui.outcome?.reason==='misses'?'No chase started.':`${ui.stack}/7 stones rebuilt · ${ui.outcome?.out}/${ui.outcome?.builders} builders out · ${ui.outcome?.elapsed.toFixed(1)}s of play`}</p>
    <p>{builder?'Next: your team defends.':'Next: your team rebuilds.'} Swap in {Math.ceil(ui.until)}…</p>
   </div>}

   {ui.phase==='match'&&<section className="panel finish">
    <span className="eyebrow">ONE MORE ROUND?</span>
    <h2>{ui.message}</h2>
    <p>Teal {ui.scores[0]} — {ui.scores[1]} Coral</p>
    <details className="roundHistory">
     <summary>Round results</summary>
     {ui.history?.map((r:any)=><p key={r.round}>Round {r.round}: {r.reason==='rebuilt'?'Tower rebuilt':r.reason==='eliminated'?'All builders hit':r.reason==='misses'?'Three opening misses':'Time expired'} · {r.elapsed.toFixed(1)}s</p>)}
    </details>
    {mode.current==='practice'?<button className="primary" onClick={practice}><RotateCcw size={17}/>Play again</button>:ui.host===myId.current?<button className="primary" onClick={lobby}>Back to lobby</button>:<p>Waiting for the host…</p>}
    <button className="plain" onClick={leave}>Return home</button>
   </section>}
  </>;
  })()}

  {(error||connection)&&<div className="toast" role="alert">{error||connection}<button aria-label="Dismiss" onClick={()=>{setError('');setConnection('');}}><X size={15}/></button></div>}

  {help&&<div className="modalShade"><section className="panel help">
   <button className="close icon" aria-label="Close instructions" onClick={()=>setHelp(false)}><X size={20}/></button>
   <span className="eyebrow">THE GAME WE GREW UP WITH</span>
   <h2>A little aim.<br/>A lot of teamwork.</h2>
   <div className="lessons">
    <div><b>01</b><h3>Stationary Aim &amp; Throw</h3><p>Players remain stationary at their starting spots during the opening strike, and any player holding/aiming the ball is strictly rooted in place. Hold THROW (0–100%) and release to fire, or slide to <b>✕ CANCEL</b>.</p></div>
    <div><b>02</b><h3>Tower Crease Zone</h3><p>An orange dashed ring surrounds the center tower. Defenders who step inside this zone suffer <b>reduced movement speed and weakened throw power</b>—guard from outside the ring and use Smart Passes!</p></div>
    <div><b>03</b><h3>6 Courtyard Power-Ups</h3><p>Grab glowing power-ups on symmetric flank pads during the chase: <b>Chappal Dash</b>, <b>Genda Shield</b>, <b>Mirchi Bomb</b>, <b>Nimbu Pani Fizz</b> (magnetic scoop, fast stack/charge &amp; ricochet shots), <b>Judwaa Split-Ball</b>, and <b>Kathputli Decoy</b>!</p></div>
   </div>
   <p className="helpFoot">Rebuild all seven before time runs out across 6 rounds. Tap the Camera button (or press C) anytime to switch between Auto, Zoom, and Wide views.</p>
   <button className="primary" onClick={()=>setHelp(false)}>Got it. Let’s play<ArrowRight size={18}/></button>
  </section></div>}
 </main>;
}
