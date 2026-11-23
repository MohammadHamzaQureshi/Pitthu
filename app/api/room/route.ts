// LOBBY-ONLY HTTP API — gameplay no longer goes through here.
// Create / join a room here (stored in D1). After that the client opens a
// WebSocket to the room's PitthuRoom Durable Object (worker/room-do.ts),
// which is the ONLY authoritative simulation: it holds state in memory,
// ticks at 30 Hz and broadcasts state. Per-tick `input` over HTTP was
// removed (410) — it caused lag: a full D1 read/write + revision check
// per input, with 409 collisions when players sent at the same time.
// Lobby ops below (config/switchTeam/start/lobby/leave/join) are forwarded
// to the Durable Object whenever it already owns the room, so there is
// never a second authoritative copy. If the DO is not deployed / has not
// loaded the room yet, the legacy D1 path below runs instead.
import {env} from 'cloudflare:workers';
import {createGame,player,start,command,advance,publicState,clamp,normalizeTeamSizes} from '../../../lib/game.js';
export const dynamic='force-dynamic';

const SEC_HEADERS={
 'Cache-Control':'no-store, no-cache, must-revalidate',
 'X-Content-Type-Options':'nosniff',
 'X-Frame-Options':'SAMEORIGIN',
 'Referrer-Policy':'strict-origin-when-cross-origin',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
const VALID_OPS=new Set(['create','join','start','lobby','leave','config','switchTeam']);
const ROOM_TTL_MS=7200000;
const json=(o:any,status=200)=>Response.json(o,{status,headers:SEC_HEADERS});

// --- Durable Object forwarding (single authority once the DO owns a room) ---
// v3: pin the Durable Object near the player who first touches the room.
// Cloudflare only honors { locationHint } on the FIRST get() that
// instantiates the object for a room code — later get() calls ignore it.
// The first touch is usually the creator's WebSocket upgrade
// (worker/index.ts, which also passes the hint) or the first lobby op
// forwarded here, so the hint is passed at BOTH places, derived from
// the request's Cloudflare metadata (req.cf.continent). 'AS' -> 'apac'
// is the one that matters for this game's players (India).
function locationHintForCf(cf:any):string|undefined{
 const c=typeof cf?.continent==='string'?cf.continent:'';
 if(c==='AS')return 'apac';
 if(c==='NA')return 'enam';
 if(c==='SA')return 'sam';
 if(c==='EU')return 'weur';
 if(c==='AF')return 'afr';
 if(c==='OC')return 'oc';
 return undefined;
}
function roomStub(code:string,req?:Request){
 const ns=(env as any).PITTHU_ROOM;
 if(!ns)return null;
 try{
  const hint=locationHintForCf((req as any)?.cf);
  const id=ns.idFromName(code);
  return hint?ns.get(id,{locationHint:hint}):ns.get(id);
 }catch{return null;}
}
async function doIsLoaded(code:string,req?:Request):Promise<boolean>{
 const stub=roomStub(code,req);if(!stub)return false;
 try{
  const r=await stub.fetch(new Request(`http://pitthu-room/loaded?code=${code}`));
  const d:any=await r.json();return !!d.loaded;
 }catch{return false;}
}
async function forwardToDO(code:string,body:any,req?:Request){
 const stub=roomStub(code,req);if(!stub)return null;
 const r=await stub.fetch(new Request(`http://pitthu-room/op?code=${code}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 const d:any=await r.json().catch(()=>({error:'Room service is unavailable.'}));
 return json(d,r.status);
}

function sanitizeName(raw:unknown):string{
 return String(raw||'Neighbour').replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF<>]/g,'').trim().slice(0,16)||'Neighbour';
}
function sanitizeLook(raw:unknown):number{
 const n=Number(raw);
 return Number.isFinite(n)?Math.max(0,Math.min(7,Math.floor(n))):0;
}

export async function POST(req:Request){
 try{
  if(Number(req.headers.get('content-length')||0)>4096)return json({error:'Request too large'},413);
  const rawText=await req.text();
  if(rawText.length>4096)return json({error:'Request too large'},413);
  let body:any;
  try{body=JSON.parse(rawText);}catch{return json({error:'Malformed request payload.'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Invalid request payload.'},400);
  const op=String(body.op||'');
  if(op==='input')return json({error:'Realtime input now goes over WebSocket to the room Durable Object (wss://<host>/ws?code=XXXXXX&token=...). HTTP polling was removed because it caused lag.'},410);
  if(!VALID_OPS.has(op))return json({error:'Unsupported room operation.'},400);

  const db=env.DB;
  if(!db)return json({error:'Room service is warming up. Try solo practice meanwhile.'},503);
  const now=Date.now(),name=sanitizeName(body.name),look=sanitizeLook(body.look);

  if(op==='create'){
   await db.prepare('DELETE FROM rooms WHERE updated<?').bind(now-ROOM_TTL_MS).run().catch(()=>{});
   const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
   for(let attempt=0;attempt<4;attempt++){
    const code=Array.from(crypto.getRandomValues(new Uint8Array(6))).map(x=>alphabet[x%alphabet.length]).join('');
    const token=crypto.randomUUID(),p={...player(crypto.randomUUID(),name,0),token,look};
    const g=createGame(code,body.teamSizes);g.players=[p];g.host=p.id;g.last=now;
    const ins=await db.prepare('INSERT OR IGNORE INTO rooms(code,state,revision,updated) VALUES (?,?,0,?)').bind(code,JSON.stringify(g),now).run();
    if(ins.meta.changes)return json({state:publicState(g),id:p.id,token});
   }
   return json({error:'Could not allocate room code. Please retry.'},503);
  }

  const code=String(body.code||'').toUpperCase();
  if(!/^[A-Z2-9]{6}$/.test(code))return json({error:'Enter a six-character room code.'},400);

  // If the Durable Object already owns this room, forward the lobby op to
  // it instead of mutating the stale D1 copy. If the DO is unreachable,
  // fall through to the legacy D1 path below.
  try{
   if(await doIsLoaded(code,req)){
    const forwarded=await forwardToDO(code,body,req);
    if(forwarded)return forwarded;
   }
  }catch(e:any){console.error('room DO forward',e.message);}

  const tok=typeof body.token==='string'&&body.token.length>0&&body.token.length<=64?body.token:'';

  for(let a=0;a<6;a++){
   const row=await db.prepare('SELECT state,revision,updated FROM rooms WHERE code=?').bind(code).first<any>();
   if(!row||now-row.updated>ROOM_TTL_MS)return json({error:'That room has expired or does not exist.'},404);
   let g=JSON.parse(row.state),me=tok?g.players.find((p:any)=>!p.bot&&p.token===tok&&p.token):null,issued:any={};

   if(op==='join'){
    if(me){
     if(g.phase==='lobby'){
      me.name=name;
      const taken=new Set(g.players.filter((p:any)=>p.id!==me.id).map((p:any)=>p.look));
      me.look=taken.has(look)?([0,1,2,3,4,5,6,7].find(c=>!taken.has(c))??look):look;
     }
     issued={id:me.id,token:me.token};
    }else{
     if(g.phase!=='lobby')return json({error:'This match has started. Join when the host returns to the lobby.'},409);
     const ts=normalizeTeamSizes(g.teamSizes,[3,3]);
     g.teamSizes=ts;
     const humans=g.players.filter((p:any)=>!p.bot);
     if(humans.length>=ts[0]+ts[1])return json({error:'This courtyard is full.'},409);
     const t0=humans.filter((p:any)=>p.team===0).length,t1=humans.length-t0;
     const canT0=t0<ts[0],canT1=t1<ts[1];
     const assignedTeam=(canT0&&canT1)?((t0/ts[0])<=(t1/ts[1])?0:1):(canT0?0:1);
     const taken=new Set(humans.map((p:any)=>p.look));
     const uniqueLook=taken.has(look)?([0,1,2,3,4,5,6,7].find(c=>!taken.has(c))??look):look;
     me={...player(crypto.randomUUID(),name,assignedTeam),token:crypto.randomUUID(),look:uniqueLook};
     g.players.push(me);
     if(!g.host||!g.players.some((p:any)=>!p.bot&&p.id===g.host))g.host=me.id;
     issued={id:me.id,token:me.token};
    }
   }

   if(!me)return json({error:'Your session has ended. Join again.'},401);

   advance(g,now);

   if(op==='config'){
    if(g.host!==me.id)return json({error:'Only the host can change match size.'},403);
    if(g.phase!=='lobby')return json({error:'Match size can only be changed in the lobby.'},409);
    const nextSizes=normalizeTeamSizes(body.teamSizes,g.teamSizes||[3,3]);
    const humans=g.players.filter((p:any)=>!p.bot);
    if(humans.length>nextSizes[0]+nextSizes[1]){
     return json({error:`${humans.length} players are in the room—increase team slots to fit everyone.`},409);
    }
    g.teamSizes=nextSizes;
    // Rebalance overflow if a team's cap was lowered below its current human count
    for(const t of [0,1]){
     const other=1-t;
     const tPlayers=humans.filter((p:any)=>p.team===t);
     while(tPlayers.length>nextSizes[t]){
      const moved=tPlayers.pop();
      if(moved&&humans.filter((p:any)=>p.team===other).length<nextSizes[other])moved.team=other;
     }
    }
    g.event=(g.event||0)+1;
   }

   if(op==='switchTeam'){
    if(g.phase!=='lobby')return json({error:'You can only switch teams in the lobby.'},409);
    const ts=normalizeTeamSizes(g.teamSizes,[3,3]);
    const targetTeam=me.team===0?1:0;
    const targetCount=g.players.filter((p:any)=>!p.bot&&p.team===targetTeam).length;
    if(targetCount>=ts[targetTeam])return json({error:`Team ${targetTeam?'Coral':'Teal'} is already full (${ts[targetTeam]}/${ts[targetTeam]}).`},409);
    me.team=targetTeam;
    g.event=(g.event||0)+1;
   }

   if(op==='start'){
    if(g.host!==me.id)return json({error:'Only the host can start.'},403);
    if(!['lobby','match'].includes(g.phase))return json({error:'A round is already playing.'},409);
    if(body.teamSizes)g.teamSizes=normalizeTeamSizes(body.teamSizes,g.teamSizes||[3,3]);
    else g.teamSizes=normalizeTeamSizes(g.teamSizes,[3,3]);
    g.players=g.players.filter((p:any)=>!p.bot);
    if(body.fill===false){
     const c0=g.players.filter((p:any)=>p.team===0).length;
     const c1=g.players.filter((p:any)=>p.team===1).length;
     if(c0<2||c1<2&&g.players.length>=4){
      const target0=clamp(Math.min(g.teamSizes[0],g.players.length-2),2,4);
      g.players.forEach((p:any,idx:number)=>{p.team=idx<target0?0:1;});
     }
    }
    start(g,body.fill!==false,g.teamSizes);
   }

   if(op==='lobby'){
    if(g.host!==me.id)return json({error:'Only the host can reset.'},403);
    g.phase='lobby';
    g.players=g.players.filter((p:any)=>!p.bot);
   }

   if(op==='leave'){
    const otherHumans=g.players.filter((p:any)=>!p.bot&&p.id!==me.id);
    if(['opening','chase','result'].includes(g.phase)&&otherHumans.length>0){
     // Preserve active match for remaining players by converting the departing player into a bot
     me.bot=true;
     delete me.token;
     if(g.host===me.id)g.host=otherHumans[0].id;
    }else{
     g.players=g.players.filter((p:any)=>p.id!==me.id&&!p.bot);
     if(g.host===me.id)g.host=g.players[0]?.id||'';
     g.phase='lobby';
    }
   }

   const result=await db.prepare('UPDATE rooms SET state=?,revision=revision+1,updated=? WHERE code=? AND revision=?').bind(JSON.stringify(g),now,code,row.revision).run();
   if(result.meta.changes)return json({state:publicState(g),...issued});
  }
  return json({error:'Room is busy. Retrying…'},409);
 }catch(e:any){
  console.error('room',e.message);
  return json({error:(e.message?.startsWith('Teams')||e.message?.startsWith('Each team'))?e.message:'The room could not be reached. Please try again.'},500);
 }
}
