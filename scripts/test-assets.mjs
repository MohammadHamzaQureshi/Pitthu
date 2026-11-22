import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function parseGlb(filePath) {
  const buf = fs.readFileSync(filePath);
  const magic = buf.toString('utf8', 0, 4);
  assert.equal(magic, 'glTF', `${filePath}: invalid GLB magic`);
  const version = buf.readUInt32LE(4);
  const totalLen = buf.readUInt32LE(8);
  assert.equal(version, 2);
  assert.equal(totalLen, buf.length);
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.toString('utf8', 16, 20);
  assert.equal(jsonType, 'JSON');
  const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binLen = buf.readUInt32LE(20 + jsonLen);
  const binType = buf.toString('utf8', 24 + jsonLen, 28 + jsonLen);
  assert.equal(binType, 'BIN\x00');
  const bin = buf.subarray(28 + jsonLen, 28 + jsonLen + binLen);
  return { gltf, bin, byteLength: buf.length };
}

function readPngDims(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, `${filePath}: not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

// 1. Validate Character v2 GLB
const charGlb = parseGlb('public/models/pittu-character-v2.glb');
const { gltf } = charGlb;
assert.equal(gltf.skins.length, 1);
assert.equal(gltf.skins[0].joints.length, 17, 'PittuRig must have 17 bones');

const nodeNames = gltf.nodes.map(n => n.name);
for (const reqNode of ['PittuRig', 'Root', 'Hips', 'Spine', 'Chest', 'Head', 'UpperArmL', 'ForearmL', 'HandL', 'UpperArmR', 'ForearmR', 'HandR', 'ThighL', 'ShinL', 'FootL', 'ThighR', 'ShinR', 'FootR']) {
  assert.ok(nodeNames.includes(reqNode), `Missing required rig node: ${reqNode}`);
}

assert.equal(gltf.meshes.length, 1, 'Expected one merged character mesh');
assert.equal(gltf.meshes[0].primitives.length, 17, 'Expected 17 material primitives');
const matNames = gltf.materials.map(m => m.name);
assert.ok(matNames.includes('Shirt') && matNames.includes('Skin'), 'Shirt and Skin materials must exist');

// Check character mesh bounds: grounded at y=0, height ~2.0
let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const prim of gltf.meshes[0].primitives) {
  const posAcc = gltf.accessors[prim.attributes.POSITION];
  assert.ok(posAcc.min && posAcc.max);
  minX = Math.min(minX, posAcc.min[0]); maxX = Math.max(maxX, posAcc.max[0]);
  minY = Math.min(minY, posAcc.min[1]); maxY = Math.max(maxY, posAcc.max[1]);
  minZ = Math.min(minZ, posAcc.min[2]); maxZ = Math.max(maxZ, posAcc.max[2]);
}
assert.ok(Math.abs(minY) < 0.01, `Character must be grounded at y=0 (got minY=${minY})`);
assert.ok(maxY > 1.90 && maxY < 2.10, `Character height must be ~2.0 (got maxY=${maxY})`);

// Check 8 animation clips and durations
const expectedClips = ['Idle', 'Run', 'Carry', 'Aim', 'Throw', 'Place', 'Out', 'Celebrate'];
const clipNames = gltf.animations.map(a => a.name);
assert.deepEqual(clipNames, expectedClips);
const throwAnim = gltf.animations.find(a => a.name === 'Throw');
const placeAnim = gltf.animations.find(a => a.name === 'Place');
assert.ok(Math.abs(gltf.accessors[throwAnim.samplers[0].input].max[0] - 0.40) < 1e-4, 'Throw clip must be 0.4s');
assert.ok(Math.abs(gltf.accessors[placeAnim.samplers[0].input].max[0] - 0.65) < 1e-4, 'Place clip must be 0.65s');

// 2. Validate Courtyard v2 GLB
const courtGlb = parseGlb('public/models/pittu-courtyard-v2.glb');
assert.equal(courtGlb.gltf.meshes.length, 1);
assert.ok(courtGlb.gltf.meshes[0].primitives.length >= 15, 'Courtyard v2 should have batched material primitives');

// 3. Validate Sprite Atlas & Portraits
const atlas = readPngDims('public/models/pittu-sprites-v2.png');
assert.equal(atlas.width, 3072);
assert.equal(atlas.height, 320);

for (const [f, w, h] of [['teal.png', 256, 256], ['coral.png', 256, 256], ['hero.png', 640, 640]]) {
  const dims = readPngDims(path.join('public/portraits', f));
  assert.equal(dims.width, w);
  assert.equal(dims.height, h);
}

// 4. Validate Renderer & UI integration contracts
const worldCode = fs.readFileSync('lib/world.js', 'utf8');
assert.ok(worldCode.includes('SkeletonUtils.clone'), 'lib/world.js must use SkeletonUtils.clone');
assert.ok(worldCode.includes('AnimationMixer'), 'lib/world.js must use AnimationMixer');
assert.ok(worldCode.includes('HandR'), 'lib/world.js must attach held items to HandR');
assert.ok(worldCode.includes('pittu-character-v2.glb') && worldCode.includes('pittu-courtyard-v2.glb'));

const fallbackCode = fs.readFileSync('lib/world-fallback.js', 'utf8');
assert.ok(fallbackCode.includes('pittu-sprites-v2.png') && fallbackCode.includes('-2.16756'));

const uiCode = fs.readFileSync('app/pittu.tsx', 'utf8');
assert.ok(uiCode.includes('/portraits/teal.png') && uiCode.includes('/portraits/coral.png') && uiCode.includes('/portraits/hero.png'));
assert.ok(uiCode.includes('REBUILD') && uiCode.includes('PRACTICE'));

console.log(JSON.stringify({
  pass: true,
  characterV2Bytes: charGlb.byteLength,
  characterBounds: { width: +(maxX - minX).toFixed(3), height: +(maxY - minY).toFixed(3), depth: +(maxZ - minZ).toFixed(3) },
  bones: gltf.skins[0].joints.length,
  primitives: gltf.meshes[0].primitives.length,
  clips: clipNames,
  courtyardV2Bytes: courtGlb.byteLength,
  spriteAtlas: `${atlas.width}x${atlas.height}`,
}, null, 2));
