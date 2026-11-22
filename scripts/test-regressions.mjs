import assert from 'node:assert/strict';
import {createGame,player,start,resetRound,step,command,advance,COVER} from '../lib/game.js';
import {blocked,reachablePoint} from '../lib/navigation.js';
const tick=(g,seconds,dt=.025)=>{for(let t=0;t<seconds-1e-8;t+=dt)step(g,Math.min(dt,seconds-t));};
function pair(bot=true){const g=createGame();g.players=[player('a','A',0),player('d','D',1,bot)];start(g,false);return g;}
let retrievals=0,maxRetrieve=0;
for(const o of COVER)for(const [dx,dz] of [[0,0],[-.7,0],[.7,0],[0,-.45],[0,.45],[-1.3,0],[1.3,0],[0,-1.2],[0,1.2]])for(let k=0;k<8;k++){
 const g=pair(),p=g.players[1],angle=k*Math.PI/4;g.phase='chase';g.stones=[];g.ball={mode:'loose',holder:null,x:o.x+dx,z:o.z+dz,lock:0};Object.assign(p,reachablePoint({x:o.x+3*Math.cos(angle),z:o.z+3*Math.sin(angle)}));Object.assign(g.players[0],{x:9,z:6});
 let t=0;for(;t<8&&g.ball.holder!=='d';t+=.025)step(g,.025);assert.equal(g.ball.holder,'d',`Unreachable ball ${JSON.stringify({o,dx,dz,k,p})}`);maxRetrieve=Math.max(maxRetrieve,t);retrievals++;
}
// Fast shots must stop at cover, including muzzle shots aimed directly into a planter.
let impacts=0;for(const o of COVER)for(let k=0;k<8;k++){const g=pair(false),a=k*Math.PI/4;g.phase='chase';g.players[0].x=9;g.players[0].z=6;g.ball={mode:'flight',holder:null,x:o.x+2*Math.cos(a),z:o.z+2*Math.sin(a),vx:-10*Math.cos(a),vz:-10*Math.sin(a),travel:0,lock:1,from:'d'};for(let i=0;i<20&&g.ball.mode==='flight';i++)step(g,.05);assert.equal(g.ball.mode,'loose');assert.equal(blocked(g.ball.x,g.ball.z,.219),false);impacts++;}
// Every role swap clears all per-round transient state. The ready countdown cannot score or hit.
let g=pair(false);for(let round=0;round<6;round++){g.round=round;for(const p of g.players)Object.assign(p,{alive:false,carry:4,place:.63,held:4.9,interact:true,anim:.3,action:'throw',mx:1,mz:1});resetRound(g);assert.equal(g.attack,round%2);assert.equal(g.stack,7);assert.equal(g.time,60);assert.equal(g.attempts,3);for(const p of g.players){assert.equal(p.alive,true);assert.equal(p.carry,null);assert.equal(p.place,0);assert.equal(p.interact,false);assert.equal(p.action,'');assert.equal(p.held,0);assert.equal(p.anim,0);}command(g,g.striker,{round:round-1,seq:999999,action:'throw'});assert.notEqual(g.players.find(p=>p.id===g.striker).seq,999999);tick(g,2.4);assert.equal(g.clock,0);assert.equal(g.phase,'opening');assert.equal(g.time,60);}
// All three outcome reasons depend on their actual conditions, not stale flags.
g=pair(false);g.ready=0;g.phase='chase';g.time=.02;step(g,.025);assert.equal(g.outcome.reason,'timeout');assert.equal(g.outcome.out,0);assert.equal(g.scores[0],0);
g=pair(false);g.ready=0;tick(g,24.1);assert.equal(g.outcome.reason,'misses');assert.equal(g.history.length,1);assert.deepEqual(g.scores,[0,0]);
g=pair(false);g.ready=0;g.phase='chase';g.stack=6;g.stones=Array.from({length:7},(_,id)=>({id,x:0,z:0,placed:id<6,held:id===6?'a':null}));Object.assign(g.players[0],{x:0,z:0,carry:6,place:.64,interact:true});step(g,.025);assert.equal(g.outcome.reason,'rebuilt');assert.equal(g.stack,7);assert.equal(g.scores[0],1);tick(g,1);assert.equal(g.history.length,1);assert.equal(g.scores[0],1);
g=pair(false);g.last=5000;advance(g,4000);assert.equal(g.last,5000);
// Frame-rate variants, both team sizes, stationary and moving human, or all bots.
let matches=0,rounds=0,min=Infinity,max=0;const reasons={};
for(const dt of [1/60,.025,1/30,.05])for(const size of [2,3])for(const humanMode of ['none','idle','moving']){
 g=createGame();g.players=Array.from({length:size*2},(_,i)=>player('p'+i,'P'+i,+(i>=size),i!==0||humanMode==='none'));start(g,false);let elapsed=0,lastRound=-1;
 for(let i=0;i<700/dt&&g.phase!=='match';i++){
  if(g.round!==lastRound){assert.equal(g.phase,'opening');assert.ok(g.players.every(p=>p.alive&&p.carry===null));assert.equal(g.time,60);lastRound=g.round;}
  if(humanMode!=='none')command(g,'p0',{seq:i,round:g.round,ax:0,az:-1,mx:humanMode==='moving'?Math.sin(elapsed):0,mz:humanMode==='moving'?Math.cos(elapsed):0,action:g.striker==='p0'&&g.phase==='opening'?'throw':'',interact:false});
  const before=g.phase;step(g,dt);elapsed+=dt;
  if(before!=='result'&&g.phase==='result'){const o=g.outcome;assert.ok(o);if(o.reason==='eliminated')assert.equal(o.out,o.builders);if(o.reason==='rebuilt')assert.equal(g.stack,7);if(o.reason==='timeout')assert.ok(g.time<=0);if(o.reason==='misses')assert.equal(g.attempts,0);assert.equal(g.history.length,g.round+1);if(o.reason!=='misses'){min=Math.min(min,o.elapsed);max=Math.max(max,o.elapsed);}reasons[o.reason]=(reasons[o.reason]||0)+1;rounds++;}
 }
 assert.equal(g.phase,'match','Match must finish');assert.ok([4,6].includes(g.round));matches++;
}
console.log(JSON.stringify({pass:true,retrievals,maxRetrievalSeconds:+maxRetrieve.toFixed(2),coverImpacts:impacts,resetRounds:6,matches,completedRounds:rounds,chaseDurationSeconds:[+min.toFixed(2),+max.toFixed(2)],outcomes:reasons},null,2));
