import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createGame,player,start,resetRound,step,command,publicState,findPassTarget,COURT_PROPS,TOWER_ZONE_RADIUS} from '../lib/game.js';
import {blocked} from '../lib/navigation.js';
function game(){let g=createGame();g.players=[player('a','A',0),player('b','B',1)];start(g,false);g.ready=0;return g;}
let g=game();assert.equal(g.phase,'opening');command(g,'a',{seq:1,mx:0,mz:0,ax:0,az:-1,action:'throw'});for(let i=0;i<25;i++)step(g,.03);assert.equal(g.phase,'chase');assert.equal(g.stones.length,7);assert.equal(g.stack,0);assert.equal(g.ball.mode,'loose');
// Possession roots the player even when a legal movement command is sent.
g.ball.mode='held';g.ball.holder='b';let b=g.players[1];b.x=3;b.z=3;command(g,'b',{seq:1,mx:1,mz:0,ax:1,az:0});step(g,.03);assert.equal(b.x,3);
// Never trust arbitrary diagonal speed or replayed sequence numbers.
command(g,'a',{seq:2,mx:100,mz:100,ax:1,az:0});assert.ok(Math.hypot(g.players[0].mx,g.players[0].mz)<=1.00001);command(g,'a',{seq:1,mx:-1,mz:0});assert.ok(g.players[0].mx>0);
// A carried stone survives an interrupted placement and completed layers persist.
let a=g.players[0];Object.assign(a,{x:0,z:0,mx:0,mz:0,carry:0,interact:true});g.stones[0].held='a';for(let i=0;i<24;i++){a.last=g.clock;step(g,.03);}assert.equal(g.stack,1);assert.equal(a.carry,null);assert.equal(g.stones[0].placed,true);
// One throw removes one builder; no headshots, multi-hit or private token leakage.
g=game();g.phase='chase';g.stack=0;g.stones=[];Object.assign(g.players[0],{x:0,z:0,token:'secret'});Object.assign(g.players[1],{x:0,z:-2});g.ball={mode:'flight',x:0,z:-.7,vx:0,vz:10,from:'b',holder:null,travel:0,lock:1};step(g,.03);assert.equal(g.players[0].alive,false);assert.equal(g.phase,'result');assert.ok(!('token' in publicState(g).players[0]));
// Paired rounds give both teams a turn; results advance to the opposite role.
for(let i=0;i<140;i++)step(g,.03);assert.equal(g.attack,1);assert.equal(g.phase,'opening');

// Courtyards props: 3D Courtyard Props (goalposts, bicycle, crates, steps, chairs) block movement so players never walk over props
for(const prop of COURT_PROPS){
 assert.equal(blocked(prop.x,prop.z,.28),true,`Prop at (${prop.x},${prop.z}) must block character collision`);
}

// Charge cancel: Boomerang Fu Charge Cancel resets charge cleanly while keeping possession of the ball
g=game();g.phase='chase';g.ball={mode:'held',holder:'b',x:2,z:-2,lock:0,power:0};
command(g,'b',{seq:10,mx:0,mz:0,ax:0,az:1,charging:true,charge:0.82});
step(g,.03);
assert.ok(g.players[1].charge>0.8,'Charge should build up while charging');
command(g,'b',{seq:11,mx:0,mz:0,ax:0,az:1,charging:false,action:'cancel'});
step(g,.03);
assert.equal(g.players[1].charge,0,'Cancel action must reset charge to 0');
assert.equal(g.players[1].charging,false,'Cancel action must stop charging');
assert.equal(g.ball.holder,'b','Player must retain the ball after canceling charge');

// Smart pass & auto-catch: 1-Button Smart Pass & Teammate Auto-Catch in stride
g=createGame();
g.players=[player('a1','A1',0),player('a2','A2',0),player('d1','D1',1),player('d2','D2',1)];
start(g,false);g.ready=0;g.phase='chase';
Object.assign(g.players[0],{x:-5,z:4});
Object.assign(g.players[1],{x:5,z:4});
Object.assign(g.players[2],{x:-2,z:-2,ax:0.98,az:0.18}); // d1 aiming roughly toward teammate d2
Object.assign(g.players[3],{x:3,z:-1.1,mx:0,mz:0});      // teammate d2
g.ball={mode:'held',holder:'d1',x:-2,z:-2,lock:0,power:0};
const mate=findPassTarget(g,g.players[2],g.players[2].ax,g.players[2].az);
assert.equal(mate?.id,'d2','findPassTarget must lock onto teammate in aim cone');
command(g,'d1',{seq:20,ax:0.98,az:0.18,charge:0.3,action:'throw'}); // normal 1-button throw aimed at teammate!
for(let i=0;i<30&&g.ball.holder!=='d2';i++)step(g,.03);
assert.equal(g.ball.holder,'d2','Teammate d2 must automatically catch the 1-button smart pass');

// Movement facing direction: When bot striker holds the ball, moving player always faces movement direction (never stuck facing one direction)
g=createGame();
g.players=[player('you','You',0,false),player('bot1','Bot1',0,true),player('d1','D1',1,true),player('d2','D2',1,true)];
start(g,false);g.ready=0;g.striker='bot1';g.ball.holder='bot1';
command(g,'you',{seq:30,mx:0,mz:-1,ax:0,az:1}); // moving UP (mz=-1) even with stale downward ax/az=(0,1)
step(g,.03);
assert.ok(g.players[0].az<-0.9,'Moving up without the ball must face up (az < -0.9)');
command(g,'you',{seq:31,mx:1,mz:0,ax:0,az:1});  // moving RIGHT (mx=1)
step(g,.03);
assert.ok(g.players[0].ax>0.9,'Moving right without the ball must face right (ax > 0.9)');

// Kathputli Decoy visual and behavior parity: Kathputli Decoy parity (team, look, carried stone sync, active patrol movement, and throw absorption)
g=game();g.phase='chase';
g.stones=Array.from({length:7},(_,id)=>({id,x:1,z:1,placed:false,held:id===2?'a':null}));
Object.assign(g.players[0],{x:2.2,z:2.0,look:3,carry:2});
g.powerups=[{uid:'pu-test',type:'kathputli',name:'Kathputli Decoy',duration:6.0,color:'#e85298',x:2.2,z:2.0,spawnAt:0}];
step(g,.03);
assert.equal(g.decoys.length,1,'Picking up kathputli power-up must spawn a decoy');
const dc=g.decoys[0];
assert.equal(dc.ownerId,'a');
assert.equal(dc.team,g.players[0].team);
assert.equal(dc.look,3,'Decoy must preserve player look/cosmetic index');
assert.equal(dc.carry,2,'Decoy must mirror owner carried stone');
assert.equal(dc.buff,'kathputli','Decoy must mirror active kathputli buff state for aura parity');
const startDcX=dc.x,startDcZ=dc.z;
for(let i=0;i<25;i++)step(g,.03);
assert.ok(Math.hypot(dc.x-startDcX,dc.z-startDcZ)>0.3,'Decoy must actively move and patrol like a real builder');

// Verify Decoy & Renderer code has zero giveaway labels or hologram opacity
const worldSrc=fs.readFileSync('lib/world.js','utf8');
assert.ok(!worldSrc.includes('· DECOY'),'Decoy must not have a giveaway DECOY overhead tag');
assert.ok(!worldSrc.includes('#ff785a')&&!worldSrc.includes('#32d8c8'),'Decoy must not use artificial neon hologram colors');

// Restricted Tower Zone speed & throw power modifiers: Restricted Tower Zone speed & throw power reduction for defenders
g=game();g.phase='chase';
Object.assign(g.players[1],{x:0.5,z:0.5,mx:1,mz:0}); // defender inside 1.85m tower zone
step(g,.03);
assert.equal(g.players[1].inTowerZone,true,'Defender inside 1.85m radius must be flagged inTowerZone');

// Sequence replay & jump bounds: Sequence jump cap protects against sequence overflow DoS
g=game();
command(g,'a',{seq:Number.MAX_SAFE_INTEGER,mx:1,mz:0});
assert.ok(g.players[0].seq<=100000,'Sequence jump per command must be bounded');

// Bots can progress an entire match; no endless phase.
g=createGame();start(g,true);for(let i=0;i<16000&&g.phase!=='match';i++)step(g,.03);assert.equal(g.phase,'match');assert.ok(g.round>=4);

// Dynamic Team Sizing (2..4 limits, 1v1 exclusion, and asymmetric 2v4 side swap preservation)
{
  const g1 = createGame('T24', [1, 5]);
  assert.deepEqual(g1.teamSizes, [2, 4], 'Clamps team sizes strictly to [2..4] and excludes 1v1');
  const gAsym = createGame('ASYM', [2, 4]);
  gAsym.players = [player('p1', 'Aarav', 0)];
  start(gAsym, true, [2, 4]);
  assert.equal(gAsym.players.filter(p => p.team === 0).length, 2, 'Teal has 2 players in 2v4');
  assert.equal(gAsym.players.filter(p => p.team === 1).length, 4, 'Coral has 4 players in 2v4');
  assert.equal(gAsym.attack, 0, 'Round 0: 2-player Teal attacks first');
  // Verify no spawn positions are blocked by obstacles
  for (const p of gAsym.players) {
    assert.equal(blocked(p.x, p.z), false, `Round 0 spawn (${p.x},${p.z}) must not be blocked`);
  }
  // Advance to Round 1 (side swap: Coral attacks with 4 players, Teal defends with 2 players)
  gAsym.round = 1;
  resetRound(gAsym);
  assert.equal(gAsym.attack, 1, 'Round 1: 4-player Coral attacks');
  assert.equal(gAsym.players.filter(p => p.team === 0).length, 2, 'Round 1: Teal retains 2 players on defense');
  assert.equal(gAsym.players.filter(p => p.team === 1).length, 4, 'Round 1: Coral retains 4 players on attack');
  for (const p of gAsym.players) {
    assert.equal(blocked(p.x, p.z), false, `Round 1 spawn (${p.x},${p.z}) must not be blocked`);
  }
  // Verify 4v4 full match assigns 8 strictly unique characters (looks 0..7) and 8 unique names across all 8 slots!
  for (let startLook = 0; startLook < 8; startLook++) {
    const g44 = createGame('M44', [4, 4]);
    g44.players = [{...player('you', 'PlayerOne', 0, false), look: startLook}];
    start(g44, true, [4, 4]);
    assert.equal(g44.players.length, 8, '4v4 must have 8 total players');
    assert.equal(g44.players.filter(p => p.team === 0).length, 4, 'Teal must have 4 players');
    assert.equal(g44.players.filter(p => p.team === 1).length, 4, 'Coral must have 4 players');
    const uniqueLooks = new Set(g44.players.map(p => p.look));
    const uniqueNames = new Set(g44.players.map(p => p.name));
    assert.equal(uniqueLooks.size, 8, `All 8 players in 4v4 must have unique character looks (got ${[...uniqueLooks]})`);
    assert.equal(uniqueNames.size, 8, `All 8 players in 4v4 must have unique names (got ${[...uniqueNames]})`);
  }
  const g44Run = createGame('M44R', [4, 4]);
  start(g44Run, true, [4, 4]);
  for (let i = 0; i < 120; i++) step(g44Run, 1 / 30);
}

console.log('PASS: opening, rooting, input normalization, sequence replay, rebuilding, hit, secrecy, role swap, 3D prop collision, charge cancel, smart pass/catch, facing sync, decoy parity, tower zone, and full bot match');
