export const COVER=[{x:-6,z:2.5,w:1.6,h:1.1},{x:6,z:-2.5,w:1.6,h:1.1}];
// 3D perimeter props and architectural colliders from pittu-courtyard-v2.glb
export const COURT_PROPS=[
 {x:-9.32,z:0.0,w:0.62,h:2.76},   // Left 3D mini-goalpost frame
 {x:9.32,z:0.0,w:0.62,h:2.76},    // Right 3D mini-goalpost frame
 {x:-9.45,z:-6.75,w:2.30,h:0.85}, // NW stacked crates & cricket bat
 {x:-6.35,z:-6.80,w:1.90,h:0.68}, // NW parked blue roadster bicycle
 {x:-4.20,z:-6.85,w:0.62,h:0.62}, // NW terracotta potted plant
 {x:-2.25,z:-6.72,w:1.68,h:0.82}, // N mint house left porch steps
 {x:-1.20,z:-6.78,w:0.58,h:0.58}, // N mint house potted plant L
 {x:0.55,z:-6.72,w:1.60,h:0.78},  // N mint house chair & bucket
 {x:2.45,z:-6.72,w:1.68,h:0.82},  // N mint house right porch steps
 {x:3.55,z:-6.78,w:0.58,h:0.58},  // N mint house potted plant R
 {x:4.45,z:-6.90,w:0.72,h:0.72},  // NE clothesline pole L
 {x:9.50,z:-6.92,w:2.15,h:0.85},  // NE brick planter & water drum
 {x:10.35,z:-4.95,w:0.65,h:0.65}, // NE clothesline pole R
 {x:-10.05,z:-0.75,w:0.90,h:3.50},// W house concrete steps, chair & plant
 {x:10.12,z:-0.85,w:0.72,h:4.10}, // E house potted plants & chajja wall
 {x:-5.80,z:6.62,w:6.20,h:0.76},  // S veranda left crates, chairs & plant
 {x:4.60,z:6.62,w:4.30,h:0.76}    // S veranda right plant, bat & crate
];
export const ALL_OBSTACLES=[...COVER,...COURT_PROPS];
export const COURT_BOUNDS={x:9.85,z:6.15};
export const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
export const blocked=(x,z,r=.28)=>Math.abs(x)>COURT_BOUNDS.x-r*.2||Math.abs(z)>COURT_BOUNDS.z-r*.2||ALL_OBSTACLES.some(o=>Math.abs(x-o.x)<o.w/2+r&&Math.abs(z-o.z)<o.h/2+r);
// Swept circle against inflated obstacle bounds; returns the first contact fraction.
export function coverContact(a,b,r=.22){let hit=null;for(const o of ALL_OBSTACLES){let lo=0,hi=1;for(const axis of ['x','z']){const half=(axis==='x'?o.w:o.h)/2+r,v=b[axis]-a[axis];if(Math.abs(v)<1e-9){if(a[axis]<o[axis]-half||a[axis]>o[axis]+half){hi=-1;break;}}else{let t1=(o[axis]-half-a[axis])/v,t2=(o[axis]+half-a[axis])/v;if(t1>t2)[t1,t2]=[t2,t1];lo=Math.max(lo,t1);hi=Math.min(hi,t2);}}if(lo<=hi&&lo<=1&&hi>=0&&(hit===null||lo<hit))hit=Math.max(0,lo);}return hit;}
export function reachablePoint(p,r=.36){let x=clamp(p.x,-9.55,9.55),z=clamp(p.z,-6.05,6.05);for(const o of ALL_OBSTACLES){const hw=o.w/2+r,hh=o.h/2+r;if(Math.abs(x-o.x)<hw&&Math.abs(z-o.z)<hh){const faces=[{gap:x-(o.x-hw),x:o.x-hw,z},{gap:o.x+hw-x,x:o.x+hw,z},{gap:z-(o.z-hh),x,z:o.z-hh},{gap:o.z+hh-z,x,z:o.z+hh}];faces.sort((a,b)=>a.gap-b.gap);({x,z}=faces[0]);}}return{x:clamp(x,-9.55,9.55),z:clamp(z,-6.05,6.05)};}
const corners=[...COVER,...COURT_PROPS.slice(0,2)].flatMap(o=>[-1,1].flatMap(sx=>[-1,1].map(sz=>({x:clamp(o.x+sx*(o.w/2+.38),-9.5,9.5),z:clamp(o.z+sz*(o.h/2+.38),-6.0,6.0)}))));
// Visibility graph around obstacle corners: small, deterministic, no steering oscillation.
export function waypoint(from,target){const end=reachablePoint(target);if(coverContact(from,end,.30)===null)return end;const nodes=[from,end,...corners],cost=nodes.map(()=>Infinity),prev=[],done=new Set();cost[0]=0;for(let i=0;i<nodes.length;i++){let at=-1;for(let j=0;j<nodes.length;j++)if(!done.has(j)&&(at<0||cost[j]<cost[at]))at=j;if(at<0||!Number.isFinite(cost[at]))break;if(at===1){let n=1;while(prev[n]!==0&&prev[n]!==undefined)n=prev[n];return nodes[n];}done.add(at);for(let j=1;j<nodes.length;j++)if(!done.has(j)&&coverContact(nodes[at],nodes[j],.30)===null){let c=cost[at]+Math.hypot(nodes[j].x-nodes[at].x,nodes[j].z-nodes[at].z);if(c<cost[j]){cost[j]=c;prev[j]=at;}}}return from;}

Object.freeze(COVER);COVER.forEach(Object.freeze);
Object.freeze(COURT_PROPS);COURT_PROPS.forEach(Object.freeze);
Object.freeze(ALL_OBSTACLES);ALL_OBSTACLES.forEach(Object.freeze);
Object.freeze(COURT_BOUNDS);
