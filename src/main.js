import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSydneyWindow } from './sydney-window.js';
import { createJacarandaBlossomGeometry } from './jacaranda-blossom.js';
import { createJacarandaWoodGeometry, releaseJacarandaWoodScratch } from './jacaranda-wood.js';
import { createJacarandaBarkMaterial } from './jacaranda-bark.js';
import { createEntryLantern } from './entry-lantern.js';
import { createBackgroundMusic } from './background-music.js';
import './style.css';

const music = createBackgroundMusic();

// All dimensions are in miniature-world metres. Positive Z is the front street.
const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
// PCF honours the light's filter radius; PCFSoft ignores it in Three r181.
renderer.shadowMap.type = THREE.PCFShadowMap;
// The sun, trees and bench are stationary between time transitions. Caching
// the 4096px shadow atlas avoids rebuilding it during every orbit frame.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.13;
renderer.setClearColor(0x000000, 0);
document.querySelector('#scene').appendChild(renderer.domElement);
// A tighter near plane gives the thin road paint and curb edges enough depth
// precision at this camera distance, preventing orbit-time z-fighting.
const camera = new THREE.PerspectiveCamera(34, 1, .4, 120);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = .24;
controls.enablePan = false;
controls.minDistance = 13;
controls.maxDistance = 36;
controls.minPolarAngle = .44;
controls.maxPolarAngle = Math.PI / 2 - .04;
controls.rotateSpeed = .65;
controls.zoomSpeed = .8;
const world = new THREE.Group();
scene.add(world);
const sydneyWindow = createSydneyWindow({
  modal: document.querySelector('#sydney-modal'),
  stage: document.querySelector('#sydney-stage'),
  closeButton: document.querySelector('#sydney-close')
});
const V = (x, y, z) => new THREE.Vector3(x, y, z);
let seed = 97423;
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const range = (a, b) => a + rand() * (b - a);
const pick = a => a[Math.floor(rand() * a.length)];
const clamp = THREE.MathUtils.clamp;
const materials = {};
function toon(name, color) {
  const data = new Uint8Array([108, 170, 221, 255]);
  const ramp = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return materials[name] = new THREE.MeshToonMaterial({ color, gradientMap: ramp });
}
const cream = toon('cream', '#f2e6ca');
const trim = toon('trim', '#fff7e6');
const inset = toon('inset', '#d8c9ae');
const roofMat = toon('roof', '#b2afa6');
const pavement = toon('pavement', '#c9c7bd');
const stone = toon('stone', '#e5dfcf');
const asphalt = toon('asphalt', '#8d9198');
const iron = new THREE.MeshStandardMaterial({ color: '#424c50', metalness: .65, roughness: .37 });
const silver = new THREE.MeshStandardMaterial({ color: '#d3d8d5', metalness: .7, roughness: .29 });
const purple = toon('purple', '#9b7cb3');
const purpleDark = toon('purpleDark', '#705783');
const terra = toon('terra', '#b3836c');
const green = toon('green', '#7e9274');
const leafDark = toon('leafDark', '#526b59');
const paper = toon('paper', '#e9dfc3');
const roadPaint = toon('roadPaint', '#e0d9c2');
roadPaint.polygonOffset=true;roadPaint.polygonOffsetFactor=-1;roadPaint.polygonOffsetUnits=-2;
const trunkMats = ['#4a352d', '#533c33', '#5c4339'].map(createJacarandaBarkMaterial);
const glass = new THREE.MeshStandardMaterial({ color: '#7894a4', emissive: '#ffd18b', emissiveIntensity: 0, metalness: .56, roughness: .22, envMapIntensity: .86 });
const glassDim = new THREE.MeshStandardMaterial({ color: '#657f90', emissive: '#efc387', emissiveIntensity: 0, metalness: .6, roughness: .24, envMapIntensity: .82 });
glass.name='window-glass';glassDim.name='window-glass-soft';
const windowWarm = new THREE.MeshStandardMaterial({ color: '#ffc077', emissive: '#ffac52', emissiveIntensity: 0, roughness: .48 });
const lampGlass = new THREE.MeshStandardMaterial({ color: '#f4e5bb', emissive: '#ffd296', emissiveIntensity: .1, roughness: .28 });
const hangingLampGlass = new THREE.MeshStandardMaterial({ color: '#f3d39c', emissive: '#ffba66', emissiveIntensity: .05, roughness: .40 });
const awningMat = toon('awning', '#9ba6a0');
const batchMap = new Map();
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
const sphereGeo = new THREE.IcosahedronGeometry(1, 1);
const dummy = new THREE.Object3D();
function batch(geo, mat, pos, scale, rot = [0, 0, 0], parent = world) {
  const key = geo.uuid + mat.uuid + parent.uuid;
  if (!batchMap.has(key)) batchMap.set(key, { geo, mat, parent, matrices: [] });
  dummy.position.set(...pos); dummy.scale.set(...scale); dummy.rotation.set(...rot); dummy.updateMatrix();
  batchMap.get(key).matrices.push(dummy.matrix.clone());
}
const box = (mat, x, y, z, sx, sy, sz, ry = 0, parent = world) => batch(boxGeo, mat, [x,y,z], [sx,sy,sz], [0,ry,0], parent);
function rod(a, b, r, mat = iron, parent = world) {
  dummy.position.copy(a).add(b).multiplyScalar(.5);
  dummy.quaternion.setFromUnitVectors(V(0,1,0), b.clone().sub(a).normalize());
  dummy.scale.set(r, a.distanceTo(b), r); dummy.updateMatrix();
  const key = cylGeo.uuid + mat.uuid + parent.uuid;
  if (!batchMap.has(key)) batchMap.set(key, { geo:cylGeo,mat,parent,matrices:[] });
  batchMap.get(key).matrices.push(dummy.matrix.clone());
}
function mesh(geo, mat, parent = world) { const m = new THREE.Mesh(geo,mat); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; }
function tube(points, radius, mat, parent=world, segments=36) { return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),segments,radius,5,false),mat,parent); }
function flushBatches() {
  for(const {geo,mat,parent,matrices} of batchMap.values()) {
    parent.updateWorldMatrix(true,false);
    const key=geo.uuid+mat.uuid;
    if(!combinedBatches.has(key))combinedBatches.set(key,{geo,mat,matrices:[]});
    matrices.forEach(v=>combinedBatches.get(key).matrices.push(v.clone().premultiply(parent.matrixWorld)));
  }
  for(const {geo,mat,matrices} of combinedBatches.values()){
    const m=new THREE.InstancedMesh(geo,mat,matrices.length);matrices.forEach((v,i)=>m.setMatrixAt(i,v));m.castShadow=true;m.receiveShadow=true;world.add(m);
  }
  combinedBatches.clear();
  batchMap.clear();
}
const combinedBatches=new Map();

// Soft, view-dependent glass reflections without any downloaded texture.
const envCanvas = document.createElement('canvas'); envCanvas.width=512; envCanvas.height=256;
const ec=envCanvas.getContext('2d'); const eg=ec.createLinearGradient(0,0,0,256);
eg.addColorStop(0,'#879cc2'); eg.addColorStop(.48,'#e9dfec'); eg.addColorStop(.53,'#faf0dc'); eg.addColorStop(1,'#a1a298'); ec.fillStyle=eg;ec.fillRect(0,0,512,256);
ec.fillStyle='#ffffff';ec.fillRect(68,52,42,85);ec.fillStyle='#b1a1ce';ec.fillRect(300,80,90,52);
const envTex=new THREE.CanvasTexture(envCanvas);envTex.mapping=THREE.EquirectangularReflectionMapping;
const pmrem=new THREE.PMREMGenerator(renderer);scene.environment=pmrem.fromEquirectangular(envTex).texture;pmrem.dispose();envTex.dispose();

// A complete square plinth: two slim roads, continuous paving, detailed curb.
// The gray base ends at y=0, exactly where the stone cap starts. Sharing
// x/z extents is safe only when their exposed side faces do not overlap.
box(toon('base', '#b0a9b2'),0,-.17,0,13.4,.34,13.4);
box(stone,0,.045,0,13.4,.09,13.4);
box(asphalt,0,.10,0,13.3,.04,13.3);
box(pavement,-.8,.19,-.8,11.55,.18,11.55);
box(stone,-.8,.29,-.8,11.42,.035,11.42);
// Two continuous curb beams meet exactly at the corner. The former row of
// 455 mm blocks left 25 mm gaps that shimmered at grazing orbit angles.
box(stone,-.905,.24,4.99,11.59,.20,.20);
box(stone,4.99,.24,-.805,.20,.20,11.79);
const seam = toon('seam','#b8b5ae');
seam.polygonOffset=true;seam.polygonOffsetFactor=-1;seam.polygonOffsetUnits=-1;
for(let n=-6.3;n<5;n+=.62){
  box(seam,n,.312,0,.009,.003,9.85);
  box(seam,-.8,.313,n,11.35,.003,.009);
}
for(let n=-5.9;n<4.5;n+=2.15){box(roadPaint,n,.134,5.89,.82,.008,.045);box(roadPaint,5.89,.134,n,.045,.008,.82);}
for(let i=0;i<5;i++)box(roadPaint,-5.2+i*.37,.136,5.75,.18,.006,1.16);
for(const [x,z] of [[3.7,5.13],[-3,5.13],[5.13,-2.9]]){
  box(iron,x,.141,z,.51,.025,.24);
  for(let j=0;j<7;j++)box(silver,x-.2+j*.066,.159,z,.018,.012,.20);
}
// Pavement service covers and an unobtrusive brass plinth label.
box(iron,-5.5,.321,-.4,.46,.018,.68);box(pavement,-5.5,.334,-.4,.40,.014,.60);
box(silver,0,-.14,6.708,1.65,.14,.012);

function footprint(expand=0, insetTop=0) {
  const x0=-2.8+insetTop-expand,z0=-2.6+insetTop-expand,x1=2.8-insetTop+expand,z1=2.8-insetTop+expand;
  const r=1.35+expand, cx=x1-r,cz=z1-r;
  const s=new THREE.Shape();s.moveTo(x0,z0);s.lineTo(x1,z0);s.lineTo(x1,cz);s.absarc(cx,cz,r,0,Math.PI/2,false);s.lineTo(x0,z1);s.closePath();return s;
}
function slab(shape,y,height,mat){const g=new THREE.ExtrudeGeometry(shape,{depth:height,bevelEnabled:false,curveSegments:28});g.rotateX(Math.PI/2);g.translate(0,y+height,0);return mesh(g,mat);}
slab(footprint(.10),.31,.19,inset);
slab(footprint(),.5,2.42,cream);
slab(footprint(),2.92,2.26,cream);
slab(footprint(0,.15),5.18,2.1,cream);
for(const y of [.56,2.82,2.94,5.12,5.27,7.28])slab(footprint(y>5.3?-.03:.09),y,.10,trim);
slab(footprint(-.03),7.38,.17,trim);
slab(footprint(-.23),7.49,.035,roofMat);
// A low curved parapet, rather than a large exposed roof.
function outline(expand=0,insetTop=0){const x0=-2.8+insetTop-expand,z0=-2.6+insetTop-expand,x1=2.8-insetTop+expand,z1=2.8-insetTop+expand,r=1.35+expand,cx=x1-r,cz=z1-r;const p=[V(x0,0,z0),V(x1,0,z0),V(x1,0,cz)];for(let i=1;i<=24;i++){let a=i/24*Math.PI/2;p.push(V(cx+r*Math.cos(a),0,cz+r*Math.sin(a)));}p.push(V(x0,0,z1),V(x0,0,z0));return p;}
const parapetPath=outline(-.035);
for(let i=1;i<parapetPath.length;i++){const a=parapetPath[i-1],b=parapetPath[i],mid=a.clone().add(b).multiplyScalar(.5);box(cream,mid.x,7.62,mid.z,a.distanceTo(b)+.035,.26,.13,-Math.atan2(b.z-a.z,b.x-a.x));}
tube(parapetPath.map(p=>p.clone().setY(7.77)),.065,trim);
// Pilasters, narrow cornices and shallow decorative corbels.
for(const x of [-2.67,1.20])for(const y of [1.73,4.02]){
  box(trim,x,y,2.823,.16,2.12,.12);box(inset,x,y-1.02,2.83,.23,.15,.18);
}
for(const z of [-2.45,1.13])for(const y of [1.73,4.02])box(trim,2.823,y,z,.12,2.12,.16);
for(let x=-2.55;x<1.1;x+=.44){box(trim,x,5.01,2.88,.12,.18,.18);box(trim,x,7.19,2.72,.11,.16,.14);}
for(let z=-2.5;z<1.05;z+=.44){box(trim,2.88,5.01,z,.18,.18,.12);box(trim,2.72,7.19,z,.14,.16,.11);}

const litPanes=[];
function facadeWindow(x,z,y,angle=0,w=.84,h=1.52,ground=false){
  const g=new THREE.Group();g.position.set(x,y,z);g.rotation.y=angle;world.add(g);
  box(inset,0,0,-.015,w+.20,h+.21,.10,0,g);
  box(windowWarm,0,0,.045,w-.10,h-.10,.042,0,g);
  const paneMat=litPanes.length%4===0&&!ground?glassDim:glass;
  const pane=mesh(new THREE.PlaneGeometry(w-.13,h-.13),paneMat,g);pane.position.z=.073;litPanes.push(pane);
  // Keep pane coordinates after static batching for lighting diagnostics.
  g.userData.glazing=[{center:[0,0,.073],width:w-.13,height:h-.13,material:paneMat}];
  for(const xx of [-w/2,w/2])box(trim,xx,0,.10,.075,h+.12,.10,0,g);
  for(const yy of [-h/2,h/2])box(trim,0,yy,.10,w+.12,.085,.10,0,g);
  box(trim,0,-h/2-.08,.10,w+.32,.12,.26,0,g);
  box(trim,0,h/2+.09,.07,w+.23,.10,.16,0,g);
  box(trim,0,0,.13,.042,h,.05,0,g);box(trim,0,ground?.22:.02,.13,w,.045,.05,0,g);
  if(!ground)box(trim,0,-.40,.13,w,.035,.05,0,g);
  // Interior lower shade gives windows depth in daylight, warm at night.
  if(ground){box(purpleDark,0,h/2-.17,.15,w-.05,.20,.035,0,g);}
  return g;
}
for(const x of [-1.92,-.35]){facadeWindow(x,2.83,1.66,0,1.08,1.75,true);facadeWindow(x,2.83,4.08,0,.91,1.68);}
for(const z of [-1.68,-.12]){facadeWindow(2.83,z,1.66,Math.PI/2,1.02,1.75,true);facadeWindow(2.83,z,4.08,Math.PI/2,.91,1.68);}
for(const x of [-1.91,-.35,1.03])facadeWindow(x,2.68,6.30,0,.69,1.48);
for(const z of [-1.79,-.35,1.02])facadeWindow(2.68,z,6.30,Math.PI/2,.69,1.48);
// Rear and left faces remain finished when the scene is rotated.
for(const y of [1.65,4.04,6.28])for(const x of [-1.7,.1,1.65])facadeWindow(x,-2.63+(y>5?.15:0),y,Math.PI,.68,1.42);
for(const y of [1.65,4.04,6.28])for(const z of [-1.6,.0,1.65])facadeWindow(-2.83+(y>5?.15:0),z,y,-Math.PI/2,.67,1.42);
facadeWindow(2.35,2.35,6.30,Math.PI/4,.64,1.48);

// White double entry doors, fitted tangentially to the curved corner.
const entry=new THREE.Group();entry.position.set(2.43,.5,2.43);entry.rotation.y=Math.PI/4;world.add(entry);
entry.userData.glazing=[];
box(inset,0,1.13,-.04,1.49,2.38,.14,0,entry);
box(windowWarm,0,1.23,.035,1.29,2.18,.075,0,entry);
for(const xx of [-.69,.69])box(trim,xx,1.14,.15,.105,2.32,.16,0,entry);
box(trim,0,2.30,.13,1.53,.13,.18,0,entry);
for(const xx of [-.33,.33]){
  box(trim,xx,.99,.13,.60,1.78,.11,0,entry);
  box(glass,xx,1.40,.195,.47,.80,.025,0,entry);
  box(inset,xx,.47,.195,.44,.45,.035,0,entry);
  box(trim,xx,.47,.22,.35,.36,.045,0,entry);
  box(trim,xx,1.98,.15,.60,.36,.10,0,entry);
  box(glass,xx,2.02,.21,.47,.25,.025,0,entry);
  entry.userData.glazing.push({center:[xx,1.40,.2075],width:.47,height:.80,material:glass},{center:[xx,2.02,.2225],width:.47,height:.25,material:glass});
  rod(V(xx+(xx<0?.18:-.18),.92,.26),V(xx+(xx<0?.18:-.18),1.12,.26),.018,silver,entry);
}
box(trim,0,1.14,.22,.05,2.26,.07,0,entry);
box(stone,0,-.015,.23,1.65,.13,.70,0,entry);
box(stone,0,-.105,.46,1.83,.08,.88,0,entry);

function textTexture(text,bg,fg,w=1024,h=256,font='500 100px Georgia'){
  const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);ctx.fillStyle=fg;ctx.font=font;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,w/2,h/2);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;
}
function sign(text,x,y,z,width,height,angle=0,bg='#f1e8d2',fg='#6a6671',font){const t=textTexture(text,bg,fg,1024,256,font);const m=mesh(new THREE.BoxGeometry(width,height,.045),new THREE.MeshStandardMaterial({map:t,roughness:.8}));m.position.set(x,y,z);m.rotation.y=angle;return m;}
sign('J A C A R A N D A',-1.08,2.63,2.947,2.7,.29);
sign('BOOKS  ·  COFFEE  ·  LITTLE THINGS',2.944,2.63,-.48,2.9,.23,Math.PI/2);
sign('OPEN / LATE',2.958,1.45,-2.08,.42,.54,Math.PI/2,'#8d7fa8','#f6ecd7','500 90px Georgia');
const no=mesh(new THREE.PlaneGeometry(.55,.15),new THREE.MeshStandardMaterial({map:textTexture('NO. 27','#efdfbf','#6c5e6e')}),entry);no.position.set(0,2.47,.17);

// A single continuous second-storey balcony and fine scrolling ironwork.
const balconyShape=new THREE.Shape();balconyShape.moveTo(-2.90,2.77);balconyShape.lineTo(-2.90,3.40);balconyShape.lineTo(1.45,3.40);balconyShape.absarc(1.45,1.45,1.95,Math.PI/2,0,true);balconyShape.lineTo(3.40,-2.65);balconyShape.lineTo(2.76,-2.65);balconyShape.lineTo(2.76,1.45);balconyShape.absarc(1.45,1.45,1.31,0,Math.PI/2,false);balconyShape.closePath();
slab(balconyShape,2.97,.14,trim);
const railPath=[];for(let i=0;i<=20;i++)railPath.push(V(-2.9+4.35*i/20,0,3.4));for(let i=1;i<=24;i++){const a=Math.PI/2-i/24*Math.PI/2;railPath.push(V(1.45+1.95*Math.cos(a),0,1.45+1.95*Math.sin(a)));}for(let i=1;i<=20;i++)railPath.push(V(3.4,0,1.45-4.1*i/20));
for(const y of [3.18,3.88,3.94])tube(railPath.map(p=>p.clone().setY(y)),y===3.94?.035:.019,iron);
const railCurve=new THREE.CatmullRomCurve3(railPath);const railLen=railCurve.getLength();
for(let i=0;i<=Math.floor(railLen/.20);i++){const t=i/Math.floor(railLen/.20),p=railCurve.getPointAt(t),tan=railCurve.getTangentAt(t);rod(p.clone().setY(3.16),p.clone().setY(3.92),.014,iron);
  if(i%2===0){for(const flip of [-1,1]){const pts=[];for(let k=0;k<=20;k++){const a=k/20*Math.PI*1.8,r=.12*(1-k/28);pts.push(p.clone().addScaledVector(tan,flip*(.06+r*Math.sin(a))).setY(3.49+r*Math.cos(a)));}tube(pts,.009,iron,world,22);}}
}
// Sloped corrugated metal canopy, with a curved corner and visible supports.
const canopyPositions=[],canopyIndices=[];
for(let i=0;i<railPath.length;i++){
  const p=railPath[i];let n;
  if(i<=20)n=V(0,0,1);else if(i<=44)n=V(p.x-1.45,0,p.z-1.45).normalize();else n=V(1,0,0);
  const inner=p.clone().addScaledVector(n,-.65),outer=p.clone().addScaledVector(n,.12);
  canopyPositions.push(inner.x,5.27,inner.z,outer.x,5.01,outer.z);
  if(i<railPath.length-1){const a=i*2;canopyIndices.push(a,a+1,a+2,a+1,a+3,a+2);}
}
const canopyGeo=new THREE.BufferGeometry();canopyGeo.setAttribute('position',new THREE.Float32BufferAttribute(canopyPositions,3));canopyGeo.setIndex(canopyIndices);canopyGeo.computeVertexNormals();awningMat.side=THREE.DoubleSide;mesh(canopyGeo,awningMat);
for(let i=0;i<85;i++){
  const p=railCurve.getPointAt(i/84),tan=railCurve.getTangentAt(i/84),n=V(-tan.z,0,tan.x).normalize();
  rod(p.clone().addScaledVector(n,-.65).setY(5.285),p.clone().addScaledVector(n,.12).setY(5.025),.016,silver);
}
tube(railPath.map(p=>p.clone().setY(5.02)),.047,trim);
for(const t of [.015,.32,.66,.985]){const p=railCurve.getPointAt(t);rod(p.clone().setY(3.10),p.clone().setY(5.03),.025,iron);}
for(const x of [-2.6,.7]){rod(V(x,4.65,2.85),V(x,5.03,3.34),.022,iron);}

// Purple slatted bench with open gaps and silver feet.
const bench=new THREE.Group();bench.position.set(-1.40,.32,3.67);world.add(bench);
for(let i=0;i<5;i++)box(i%2?purple:purpleDark,0,.46,-.22+i*.105,1.67,.065,.075,0,bench);
for(let i=0;i<4;i++)box(purple,0,.69+i*.105,-.29-i*.016,1.67,.07,.065,0,bench);
for(const x of [-.62,.62]){
  rod(V(x,.06,.21),V(x,.46,.13),.035,silver,bench);rod(V(x,.06,-.30),V(x,1.03,-.36),.035,silver,bench);
  rod(V(x,.40,-.31),V(x,.40,.27),.035,silver,bench);rod(V(x,.68,-.27),V(x,.68,.22),.025,silver,bench);
  box(silver,x,.03,-.02,.13,.06,.61,0,bench);
}
function pot(x,z,s=.6,y=.32){const p=mesh(new THREE.CylinderGeometry(s*.42,s*.31,s*.65,12),terra);p.position.set(x,y+s*.325,z);const soil=toon('soil'+x+z,'#665950');batch(cylGeo,soil,[x,y+s*.66,z],[s*.36,.02,s*.36]);for(let i=0;i<13;i++){const a=range(0,Math.PI*2),r=range(.04,s*.32),tip=V(x+Math.sin(a)*r,y+s*range(.9,1.65),z+Math.cos(a)*r);rod(V(x,y+s*.6,z),tip,.012,leafDark);batch(sphereGeo,i%3?green:leafDark,tip.toArray(),[s*.12,s*.25,s*.07],[range(-.6,.6),a,range(-.3,.3)]);}}
pot(-2.65,3.15,.55);pot(.09,3.06,.42);pot(3.18,-2.17,.64);
// Small sidewalk poster / magazine rack leaves an open route to the entrance.
const rack=new THREE.Group();rack.position.set(.65,.32,3.40);rack.rotation.y=-.16;world.add(rack);
for(const x of [-.24,.24]){rod(V(x,0,-.17),V(x,1.13,0),.019,iron,rack);rod(V(x,0,.31),V(x,1.13,0),.019,iron,rack);}
for(const y of [.30,.58,.87]){box(iron,0,y,.08,.56,.045,.30,0,rack);for(let i=0;i<3;i++)box(i%2?paper:purple, -.17+i*.17,y+.12,.08,.15,.22,.035,-.05,rack);}
// A complete bicycle: two hoops, spokes, frame, pedals and handlebar.
const bike=new THREE.Group();bike.position.set(3.04,.34,-.98);bike.rotation.y=Math.PI/2;world.add(bike);
const tire=toon('tire','#484a4e');const bikeMat=toon('bike','#92a9a8');
for(const x of [-.59,.59]){
  const wheel=mesh(new THREE.TorusGeometry(.34,.026,6,40),tire,bike);wheel.position.set(x,.36,0);
  const rim=mesh(new THREE.TorusGeometry(.305,.012,5,32),silver,bike);rim.position.set(x,.36,.008);
  for(let i=0;i<12;i++){const a=i*Math.PI/6;rod(V(x,.36,.01),V(x+Math.cos(a)*.30,.36+Math.sin(a)*.30,.01),.005,silver,bike);}
}
for(const [a,b] of [[[-.59,.36,0],[-.20,.83,0]],[[-.20,.83,0],[.08,.36,0]],[[.08,.36,0],[-.59,.36,0]],[[-.20,.83,0],[.40,.86,0]],[[.40,.86,0],[.08,.36,0]],[[.40,.86,0],[.59,.36,0]]])rod(V(...a),V(...b),.022,bikeMat,bike);
rod(V(-.2,.72,0),V(-.25,.98,0),.018,silver,bike);box(tire,-.25,1.0,0,.25,.055,.14,0,bike);
rod(V(.40,.86,0),V(.36,1.12,0),.019,silver,bike);rod(V(.36,1.12,-.16),V(.36,1.12,.16),.018,silver,bike);
rod(V(.08,.36,-.11),V(.08,.36,.11),.02,silver,bike);box(iron,.08,.36,.13,.16,.025,.07,0,bike);
rod(V(.02,.36,0),V(.21,.02,.18),.012,iron,bike);

// Shared, closed five-petal bells have an actual recessed throat and petal lip.
const flowerGeo=createJacarandaBlossomGeometry();
// Matte petals need diffuse lighting, not tens of thousands of per-fragment
// metallic/roughness BRDF evaluations. Keep the same palette and real shadows.
const flowerMat=new THREE.MeshLambertMaterial({color:'#ffffff',vertexColors:true,emissive:'#4f3475',emissiveIntensity:0});
const budGeo=new THREE.SphereGeometry(.018,6,5);
const budMat=new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.93});
const flowerColors=['#8860b3','#a078cc','#785ca9','#b189d9','#8b79c5','#735799'].map(c=>new THREE.Color(c));
const trees=[],crownTargets=[],branchBounds=[],adTargets=[];
const canopyShadowMat=new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false,depthTest:false});
// A cluster of small, low-poly canopy volumes follows the real blossom
// distribution. It is invisible in the beauty pass but gives the instanced
// crown a readable soft shadow without putting every flower in the shadow map.
function canopyShadowGeometry(flowers){
  // Small occupied cells preserve holes between sprays and produce dappled
  // shadows. Broad ellipsoids would turn these winding branches into blobs.
  const cells=new Map(),cell=.38;
  for(const {p} of flowers){
    const key=`${Math.floor(p.x/cell)},${Math.floor(p.y/cell)},${Math.floor(p.z/cell)}`;
    if(!cells.has(key))cells.set(key,{n:0,p:V(0,0,0)});
    const c=cells.get(key);c.n++;c.p.add(p);
  }
  const parts=[];
  for(const {n,p} of cells.values()){
    if(n<3)continue;
    p.multiplyScalar(1/n);
    const radius=Math.min(.23,.12+Math.sqrt(n)*.019),g=new THREE.IcosahedronGeometry(1,0);
    g.scale(radius,radius*.78,radius);g.translate(p.x,p.y,p.z);parts.push(g);
  }
  const result=mergeGeometries(parts);parts.forEach(g=>g.dispose());return result;
}
function taperedBranch(points,r0,r1,sides=8,segScale=11){
  const curve=new THREE.CatmullRomCurve3(points),length=curve.getLength(),segments=Math.max(4,Math.ceil(length*segScale)),frames=curve.computeFrenetFrames(segments,false),pos=[],uvs=[],idx=[],n=sides;
  for(let i=0;i<=segments;i++){const p=curve.getPointAt(i/segments),r=THREE.MathUtils.lerp(r0,r1,Math.pow(i/segments,.8));for(let j=0;j<n;j++){const a=j/n*Math.PI*2,v=p.clone().addScaledVector(frames.normals[i],Math.cos(a)*r).addScaledVector(frames.binormals[i],Math.sin(a)*r);pos.push(v.x,v.y,v.z);uvs.push(j/n,i/segments*length*1.25);}}
  for(let i=0;i<segments;i++)for(let j=0;j<n;j++){const a=i*n+j,b=i*n+(j+1)%n;idx.push(a,b,a+n,b,b+n,a+n);}
  // End caps avoid visible open branch ends from any angle.
  const start=curve.getPointAt(0),end=curve.getPointAt(1),si=pos.length/3;pos.push(...start.toArray(),...end.toArray());uvs.push(0,0,0,length*1.25);for(let j=0;j<n;j++){idx.push(si,(j+1)%n,j);idx.push(si+1,segments*n+j,segments*n+(j+1)%n);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setIndex(idx);g.computeVertexNormals();return g;
}
const upAxis=V(0,1,0),qAlign=new THREE.Quaternion(),qTwist=new THREE.Quaternion();
const treeSpecs=[
  {x:-4.55,z:3.42,h:7.0,lean:[-.25,.20],spread:2.20},
  {x:-2.55,z:4.32,h:5.9,lean:[-.28,.08],spread:1.75},
  {x:4.21,z:3.34,h:7.5,lean:[.22,.12],spread:2.15},
  {x:4.28,z:-.85,h:9.6,lean:[.12,-.32],spread:2.55},
  {x:3.60,z:-4.37,h:10.6,lean:[-.18,-.12],spread:2.70},
  {x:-.74,z:-4.55,h:11.0,lean:[-.30,.08],spread:2.90},
  {x:-4.60,z:-1.90,h:9.7,lean:[-.12,-.28],spread:2.55},
];
for(let ti=0;ti<treeSpecs.length;ti++){
  const spec=treeSpecs[ti],{x,z,h,spread}=spec;
  box(iron,x,.327,z,.97,.03,.97);
  batch(cylGeo,trunkMats[ti%3],[x,.347,z],[.28,.025,.28]);
  for(let j=0;j<7;j++){box(pavement,x-.40+j*.135,.347,z,.033,.012,.87);box(pavement,x,.349,z-.40+j*.135,.87,.012,.033);}
  const rootGroup=new THREE.Group();rootGroup.position.set(x,.34,z);world.add(rootGroup);rootGroup.userData.treeRoot=true;
  const crown=new THREE.Group();rootGroup.add(crown);
  const woodPaths=[],branchGeos=[],flowers=[],buds=[],scaffolds=[];
  const outward=ti===0||ti===6?V(-1,0,0):ti===1?V(0,0,1):ti===2||ti===3?V(1,0,0):V(0,0,-1);
  const side=V(-outward.z,0,outward.x),lx=spec.lean[0],lz=spec.lean[1];
  const outwardAngle=Math.atan2(outward.z,outward.x),twist=ti%2?1:-1;
  function outsideBuilding(p){
    if(p.y>7.95)return p;
    if(ti===0||ti===6)p.x=Math.min(p.x,-3.55-x);
    else if(ti===1)p.z=Math.max(p.z,3.80-z);
    else if(ti===2||ti===3)p.x=Math.max(p.x,3.75-x);
    else p.z=Math.min(p.z,-3.10-z);
    return p;
  }
  const forkY=Math.min(2.65,h*.34),forkP=outsideBuilding(V(lx,forkY,lz).addScaledVector(side,.12*twist));
  const trunkPoints=[V(0,0,0),V(0,.55,0).addScaledVector(outward,.05),V(lx*.5,forkY*.60,lz*.5).addScaledVector(side,-.10*twist),forkP];
  const trunkRadius=.23+h*.009;
  woodPaths.push({points:trunkPoints,r0:trunkRadius,r1:.18});
  for(let r=0;r<5;r++){
    const a=r*Math.PI*.4+ti;
    woodPaths.push({points:[V(Math.sin(a)*.40,.015,Math.cos(a)*.40),V(Math.sin(a)*.22,.16,Math.cos(a)*.22),V(0,.52,0)],r0:.075,r1:.105});
  }
  // Every blossom grows directly off a fine twiglet or flowering spray, with
  // its calyx nestled near the bark and its five-petal bell opening outward.
  function populateTwig(curve,count,tint,uStart=.14,maxOffset=.018){
    for(let fi=0;fi<count;fi++){
      const u=clamp(uStart+(fi/Math.max(1,count-1))*(1-uStart)+range(-.05,.05),uStart,1);
      const anchor=curve.getPointAt(u),tan=curve.getTangentAt(u).normalize();
      const ref=Math.abs(tan.y)>.9?V(1,0,0):upAxis;
      const n1=V().crossVectors(tan,ref).normalize(),n2=V().crossVectors(tan,n1).normalize();
      const a=fi*2.39996+range(-.35,.35);
      const radial=n1.multiplyScalar(Math.cos(a)).addScaledVector(n2,Math.sin(a));
      const offset=range(.002,maxOffset)*(.7+.3*Math.sin(u*Math.PI));
      const p=anchor.clone().addScaledVector(radial,offset);
      const dir=radial.clone().multiplyScalar(range(.72,1.04)).addScaledVector(tan,range(.30,.72)).add(V(0,range(-.34,.20),0)).normalize();
      flowers.push({p,dir,s:range(.82,1.24),roll:rand()*Math.PI*2,c:tint.clone().lerp(pick(flowerColors),.28)});
      if(fi===count-1||fi%10===0)buds.push({p:anchor.clone().addScaledVector(radial,.004),dir});
    }
  }
  // Each flower-bearing branch splits into tertiary sprays and fine twiglets so
  // blossoms form airy panicles anchored on real wood rather than floating curtains.
  function flowerBranch(points,radius,fullness=1){
    branchGeos.push(taperedBranch(points,radius,.005,8,10));
    const curve=new THREE.CatmullRomCurve3(points),sprays=4,tint=pick(flowerColors);
    for(let k=0;k<sprays;k++){
      const u=.14+k*.25+range(-.035,.035),base=curve.getPointAt(u),tangent=curve.getTangentAt(u);
      const a=Math.atan2(tangent.z,tangent.x)+(k%2?1:-1)*range(.46,.98),reach=range(.26,.54);
      const tip=outsideBuilding(base.clone().add(V(Math.cos(a)*reach,range(-.20,.32),Math.sin(a)*reach)));
      const mid=outsideBuilding(base.clone().lerp(tip,.52).add(V(0,range(.05,.13),0)));
      branchGeos.push(taperedBranch([base,mid,tip],.016,.0032,6,9));
      const spray=new THREE.CatmullRomCurve3([base,mid,tip]);
      populateTwig(spray,Math.round(range(7,10)*fullness),tint,.42,.016);
      for(let j=0;j<3;j++){
        const su=.28+j*.33+range(-.04,.04),tBase=spray.getPointAt(su),tTan=spray.getTangentAt(su);
        const ta=Math.atan2(tTan.z,tTan.x)+(j===2?range(-.26,.26):(j%2?1:-1)*range(.54,1.04)),tLen=range(.15,.28);
        const tTip=outsideBuilding(tBase.clone().add(V(Math.cos(ta)*tLen,range(-.10,.18),Math.sin(ta)*tLen)));
        const tMid=outsideBuilding(tBase.clone().lerp(tTip,.5).add(V(0,range(.02,.07),0)));
        branchGeos.push(taperedBranch([tBase,tMid,tTip],.0065,.002,5,8));
        populateTwig(new THREE.CatmullRomCurve3([tBase,tMid,tTip]),Math.round(range(10,15)*fullness),tint,.14,.018);
      }
    }
    const endBase=points[points.length-1],endTan=curve.getTangentAt(1);
    const endTip=outsideBuilding(endBase.clone().addScaledVector(endTan,.22).add(V(0,.06,0)));
    const endMid=outsideBuilding(endBase.clone().lerp(endTip,.5).add(V(0,.03,0)));
    branchGeos.push(taperedBranch([endBase,endMid,endTip],.007,.002,5,8));
    populateTwig(new THREE.CatmullRomCurve3([endBase,endMid,endTip]),Math.round(range(10,14)*fullness),tint,.12,.018);
  }
  // Asymmetric scaffold limbs divide early and fan around the house. There is
  // no repeated ladder of branches or single stem ending above its flowers.
  const offsets=[-1.36,1.20,-.72,.52],ends=[.72,.86,1.0,.93];
  for(let bi=0;bi<4;bi++){
    const a=outwardAngle+offsets[bi]+range(-.12,.12),turn=(bi%2?1:-1)*range(.38,.64);
    const top=h*(ends[bi]+range(-.025,.025)),reach=spread*range(.68,1.02);
    // Boughs overlap the living stem at staggered heights; their surfaces are
    // fused into the trunk, instead of resting four capped pipes on one cut.
    const trunkCurve=new THREE.CatmullRomCurve3(trunkPoints);
    const root=trunkCurve.getPointAt(.77+bi*.065),rise=top-root.y;
    const at=(distance,y,yaw=0)=>outsideBuilding(V(lx+Math.cos(a+yaw)*distance,y,lz+Math.sin(a+yaw)*distance));
    // The stem first bends away from the house, then turns across the crown.
    // Short, alternating bends avoid the long vertical rods of the old fan.
    const points=[root,at(reach*.24,root.y+rise*.27,-turn*.75),at(reach*.36,root.y+rise*.49,turn*.45),at(reach*.64,root.y+rise*.69,-turn*.24),at(reach*.70,top-.34,turn*.32),at(reach*1.12,top-.15,turn*.56)];
    const scaffold=new THREE.CatmullRomCurve3(points);
    scaffolds.push(scaffold);
    woodPaths.push({points,r0:trunkRadius*range(.52,.61),r1:.016});
    // Short flowering shoots along the upper scaffold keep the inner crown
    // connected with visible twigs instead of hanging flowers off thick boughs.
    for(let k=0;k<2;k++){
      const su=.36+k*.26+range(-.03,.03),sBase=scaffold.getPointAt(su),sDir=scaffold.getTangentAt(su);
      const sa=Math.atan2(sDir.z,sDir.x)+(k%2?-1:1)*range(.65,1.05),sLen=spread*range(.24,.34);
      const sMid=outsideBuilding(sBase.clone().add(V(Math.cos(sa)*sLen*.5,range(.14,.28),Math.sin(sa)*sLen*.5)));
      const sTip=outsideBuilding(sBase.clone().add(V(Math.cos(sa)*sLen,range(.16,.38),Math.sin(sa)*sLen)));
      flowerBranch([sBase,sMid,sTip],.024,.82);
    }
    for(let j=0;j<5;j++){
      const u=.30+j*.145+range(-.045,.045),base=scaffold.getPointAt(u),direction=scaffold.getTangentAt(u);
      const sa=Math.atan2(direction.z,direction.x)+(j%2?1:-1)*range(.54,1.12),length=spread*range(.40,.64);
      const bend=(j%2?1:-1)*range(.28,.52),lift=range(-.38,.80);
      const p1=outsideBuilding(base.clone().add(V(Math.cos(sa)*length*.32,lift*.45+.18,Math.sin(sa)*length*.32)));
      const p2=outsideBuilding(base.clone().add(V(Math.cos(sa+bend*.5)*length*.68,lift*.72+.06,Math.sin(sa+bend*.5)*length*.68)));
      const tip=outsideBuilding(base.clone().add(V(Math.cos(sa+bend)*length,lift,Math.sin(sa+bend)*length)));
      flowerBranch([base,p1,p2,tip],.050-u*.026,j===0?.92:1.12);
    }
    const tip=points[points.length-1];
    flowerBranch([scaffold.getPointAt(.83),scaffold.getPointAt(.94),tip],.023,1.0);
    // Back trees spread above the roof as well as out over the pavement.
    // These crossing, rising boughs connect the upper canopy into a frame.
    if(ti>=3&&bi!==0){
      const base=scaffold.getPointAt(.72),inwardAngle=outwardAngle+Math.PI+(bi-2)*.48;
      const run=spread*range(.82,1.18),rise=Math.max(.35,8.45-base.y)+range(.10,.32);
      const p1=outsideBuilding(base.clone().add(V(Math.cos(inwardAngle-.30)*run*.28,rise*.70,Math.sin(inwardAngle-.30)*run*.28)));
      const p2=outsideBuilding(base.clone().add(V(Math.cos(inwardAngle+.16)*run*.64,rise+.08,Math.sin(inwardAngle+.16)*run*.64)));
      const end=outsideBuilding(base.clone().add(V(Math.cos(inwardAngle)*run,rise+.18,Math.sin(inwardAngle)*run)));
      flowerBranch([base,p1,p2,end],.052,1.16);
    }
  }
  // Taller rear crowns need flowering shoots between their existing tiers.
  // A separate deterministic pass keeps every original tree and the later
  // street scatter unchanged; the foreground trees retain their exact blooms.
  if(ti>=3){
    const savedSeed=seed,budCount=buds.length;
    seed=(0x9e3779b9^Math.imul(ti+1,0x85ebca6b))>>>0;
    scaffolds.forEach((scaffold,bi)=>{
      for(let j=0;j<5;j++){
        const u=.38+j*.14+range(-.018,.018),base=scaffold.getPointAt(u),direction=scaffold.getTangentAt(u);
        const sideSign=(j+bi)%2?1:-1,angle=Math.atan2(direction.z,direction.x)+sideSign*range(.72,1.26);
        const length=spread*range(.36,.54),bend=sideSign*range(.18,.38),lift=range(.20,.62);
        const p1=outsideBuilding(base.clone().add(V(Math.cos(angle)*length*.33,lift*.40+.12,Math.sin(angle)*length*.33)));
        const p2=outsideBuilding(base.clone().add(V(Math.cos(angle+bend*.5)*length*.70,lift*.78+.10,Math.sin(angle+bend*.5)*length*.70)));
        const tip=outsideBuilding(base.clone().add(V(Math.cos(angle+bend)*length,lift,Math.sin(angle+bend)*length)));
        flowerBranch([base,p1,p2,tip],.031-u*.012,1.30);
      }
    });
    // These infill shoots are in full bloom. Retain the original bud layer
    // and its random sequence so no other planting or paving detail moves.
    buds.length=budCount;
    seed=savedSeed;
  }
  // One transform for trunk, twigs and blooms prevents the fork opening when
  // the crown moves. The grounded base is the pivot for this very small sway.
  const mainWood=mesh(createJacarandaWoodGeometry(woodPaths),trunkMats[ti%3],crown);
  mainWood.name=`tree-wood-${ti}`;
  mesh(mergeGeometries(branchGeos),trunkMats[ti%3],crown);
  branchGeos.forEach(g=>g.dispose());
  const flowerMesh=new THREE.InstancedMesh(flowerGeo,flowerMat,flowers.length);
  flowers.forEach((f,i)=>{
    dummy.position.copy(f.p);dummy.scale.setScalar(f.s);
    qAlign.setFromUnitVectors(upAxis,f.dir);qTwist.setFromAxisAngle(upAxis,f.roll);
    dummy.quaternion.copy(qAlign).multiply(qTwist);
    dummy.updateMatrix();flowerMesh.setMatrixAt(i,dummy.matrix);flowerMesh.setColorAt(i,f.c);
  });
  flowerMesh.name=`jacaranda-blossoms-${ti}`;flowerMesh.castShadow=false;flowerMesh.receiveShadow=true;flowerMesh.userData.treeIndex=ti;crown.add(flowerMesh);crownTargets.push(flowerMesh);
  const budMesh=new THREE.InstancedMesh(budGeo,budMat,buds.length);
  buds.forEach((b,i)=>{dummy.position.copy(b.p);dummy.scale.set(.65,1.35,.65);dummy.quaternion.setFromUnitVectors(upAxis,b.dir);dummy.updateMatrix();budMesh.setMatrixAt(i,dummy.matrix);budMesh.setColorAt(i,pick(flowerColors));});
  budMesh.castShadow=false;budMesh.receiveShadow=true;crown.add(budMesh);budMesh.userData.treeIndex=ti;crownTargets.push(budMesh);
  const canopyShadow=new THREE.Mesh(canopyShadowGeometry(flowers),canopyShadowMat);
  canopyShadow.name=`canopy-shadow-${ti}`;canopyShadow.userData.canopyShadow=true;canopyShadow.userData.treeIndex=ti;
  canopyShadow.castShadow=true;canopyShadow.receiveShadow=false;canopyShadow.renderOrder=-1;crown.add(canopyShadow);
  trees.push({root:rootGroup,crown,h,spec,phase:ti*1.9,flowers:flowers.length,flowerMesh});branchBounds.push({x,z,h});
}
releaseJacarandaWoodScratch();

// Small, stationary root occlusion only. Canopy shadows come entirely from
// the light's shadow map, including the part that falls outside the plinth.
function shadeTexture(){
  const c=document.createElement('canvas');c.width=c.height=64;
  const g=c.getContext('2d');
  const gradient=g.createRadialGradient(32,32,5,32,32,31);
  gradient.addColorStop(0,'rgba(43,37,46,.70)');
  gradient.addColorStop(.42,'rgba(43,37,46,.29)');
  gradient.addColorStop(1,'rgba(43,37,46,0)');
  g.fillStyle=gradient;g.fillRect(0,0,64,64);
  return new THREE.CanvasTexture(c);
}
const rootShadeMat=new THREE.MeshBasicMaterial({map:shadeTexture(),transparent:true,opacity:.22,depthWrite:false,toneMapped:false});
const rootShades=new THREE.InstancedMesh(new THREE.PlaneGeometry(1.35,1.35),rootShadeMat,trees.length);
trees.forEach((t,i)=>{dummy.position.set(t.spec.x,.354,t.spec.z);dummy.rotation.set(-Math.PI/2,0,0);dummy.scale.setScalar(1);dummy.updateMatrix();rootShades.setMatrixAt(i,dummy.matrix);});
rootShades.name='tree-root-occlusion';rootShades.renderOrder=1;world.add(rootShades);

// Small five-petal silhouettes, used on paving, ledges and in the air.
const petalShape=new THREE.Shape();petalShape.moveTo(0,-.047);petalShape.bezierCurveTo(.075,-.025,.061,.044,0,.055);petalShape.bezierCurveTo(-.045,.035,-.039,-.02,0,-.047);
const petalGeo=new THREE.ShapeGeometry(petalShape,4);
const petalMat=new THREE.MeshToonMaterial({color:'#bd9ade',side:THREE.DoubleSide,gradientMap:cream.gradientMap});
const litter=[];
for(let i=0;i<1550;i++){
  let x,z;
  if(i<1150){const t=pick(treeSpecs),a=rand()*Math.PI*2,r=Math.pow(rand(),1.6)*1.75;x=t.x+Math.cos(a)*r;z=t.z+Math.sin(a)*r;}else{x=range(-6.5,6.5);z=range(-6.5,6.5);}
  if(Math.abs(x)>6.58||Math.abs(z)>6.58)continue;
  if(x>-2.97&&x<3.08&&z>-2.75&&z<3.03)continue;
  litter.push({x,y:x>5.0||z>5.0?.145:.36,z,s:range(.45,1.1)});
}
for(let i=0;i<110;i++){const p=railCurve.getPointAt(rand()),t=railCurve.getTangentAt(rand()),n=V(-t.z,0,t.x);p.addScaledVector(n,range(-.53,.07));litter.push({x:p.x,y:5.05+Math.max(0,-.05+(3.4-Math.max(p.x,p.z))*.33),z:p.z,s:range(.50,.85)});}
for(const x of [-1.91,-.35,1.03])for(let i=0;i<5;i++)litter.push({x:x+range(-.35,.35),y:5.51,z:range(2.72,2.79),s:.65});
const groundPetals=new THREE.InstancedMesh(petalGeo,petalMat,litter.length);
litter.forEach((p,i)=>{dummy.position.set(p.x,p.y,p.z);dummy.rotation.set(-Math.PI/2,0,rand()*Math.PI*2);dummy.scale.setScalar(p.s);dummy.updateMatrix();groundPetals.setMatrixAt(i,dummy.matrix);groundPetals.setColorAt(i,pick(flowerColors));});groundPetals.receiveShadow=true;world.add(groundPetals);

// Human-scale lanterns: restrained pools of warm light, shadowed by branches.
const localLights=[];
function streetLamp(x,z,h=4.5){
  batch(cylGeo,iron,[x,.5,z],[.14,.30,.14]);rod(V(x,.45,z),V(x,h-.2,z),.039,iron);
  batch(cylGeo,iron,[x,h-.50,z],[.075,.09,.075]);
  box(lampGlass,x,h-.20,z,.26,.43,.26);
  for(const dx of [-.14,.14])for(const dz of [-.14,.14])rod(V(x+dx,h-.44,z+dz),V(x+dx,h+.03,z+dz),.015,iron);
  box(iron,x,h+.035,z,.37,.065,.37);const cap=mesh(new THREE.ConeGeometry(.29,.17,4),iron);cap.position.set(x,h+.15,z);cap.rotation.y=Math.PI/4;
  rod(V(x,h+.23,z),V(x,h+.34,z),.025,iron);
  const l=new THREE.PointLight('#ffd095',0,5.4,2);l.position.set(x,h-.26,z);localLights.push({light:l,power:27});world.add(l);
  return l;
}
const benchLight=streetLamp(-3.27,3.92,4.25);
streetLamp(4.40,1.08,4.6);streetLamp(-3.90,-4.82,4.8);
benchLight.castShadow=true;benchLight.shadow.mapSize.set(512,512);benchLight.shadow.bias=-.001;benchLight.shadow.normalBias=.035;benchLight.shadow.intensity=0;benchLight.shadow.radius=2;
// Mount on the free wall / pilaster beside each shop sign, leaving the
// lettering and the clickable postcard unobstructed.
for(const [id,x,z,angle] of [['front',.46,2.82,0],['side',2.90,1.13,Math.PI/2]]){
  const lantern=createEntryLantern(iron,hangingLampGlass,id);
  lantern.group.position.set(x,2.69,z);lantern.group.rotation.y=angle;
  world.add(lantern.group);localLights.push({light:lantern.light,power:8});
}
// Reuse the entrance light inside an actual hanging lantern, under the balcony.
const entryLantern=createEntryLantern(iron,hangingLampGlass);
entry.updateWorldMatrix(true,false);
entryLantern.group.position.copy(entry.localToWorld(V(.69,2.14,.24)));
entryLantern.group.rotation.y=Math.PI/4;world.add(entryLantern.group);
localLights.push({light:entryLantern.light,power:8});
// Under-canopy strips have real thickness, no light cones.
for(const [x,z,a] of [[-1.15,2.95,0],[2.95,-.55,Math.PI/2]])box(lampGlass,x,4.98,z,1.15,.035,.055,a);
const ambient=new THREE.HemisphereLight('#e8ecff','#b7a696',1.7);scene.add(ambient);
const sun=new THREE.DirectionalLight('#fff5e4',3.15);sun.name='sun-moon-light';sun.position.set(-14,37,16);sun.castShadow=true;
const shadowResolution=innerWidth<650?2048:4096;
sun.shadow.mapSize.set(shadowResolution,shadowResolution);sun.shadow.camera.left=-22;sun.shadow.camera.right=22;sun.shadow.camera.top=23;sun.shadow.camera.bottom=-20;sun.shadow.camera.near=.5;sun.shadow.camera.far=100;sun.shadow.normalBias=.025;sun.shadow.bias=-.00006;sun.shadow.radius=2;sun.shadow.intensity=.82;sun.shadow.camera.updateProjectionMatrix();scene.add(sun);sun.target.position.set(0,3,0);scene.add(sun.target);
const fill=new THREE.DirectionalLight('#c3c2ee',.55);fill.position.set(8,6,-7);scene.add(fill);
// The paper beneath the miniature is a real shadow receiver. Its surface is
// level with the bottom of the plinth, so shadows follow the curb and base
// down to the ground instead of floating over the road or ending at its edge.
const groundShadowMat=new THREE.ShadowMaterial({color:'#625b70',opacity:.32,depthWrite:false});
groundShadowMat.onBeforeCompile=shader=>{
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 vGroundShadowXZ;').replace('#include <begin_vertex>','#include <begin_vertex>\nvGroundShadowXZ = (modelMatrix * vec4(position, 1.0)).xz;');
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 vGroundShadowXZ;').replace('#include <tonemapping_fragment>','gl_FragColor.a *= 1.0 - smoothstep(17.0, 19.8, max(abs(vGroundShadowXZ.x), abs(vGroundShadowXZ.y)));\n#include <tonemapping_fragment>');
};
const shadowPlane=mesh(new THREE.PlaneGeometry(40,40),groundShadowMat);
shadowPlane.name='ground-shadow-catcher';shadowPlane.userData.shadowCatcher=true;
shadowPlane.rotation.x=-Math.PI/2;shadowPlane.position.y=-.345;shadowPlane.castShadow=false;
flushBatches();
// Bake static window trims, scrolling ironwork and signs into material groups.
// Moving tree branches and instanced flowers remain independent.
world.updateMatrixWorld(true);
const staticGroups=new Map(),staticMeshes=[];
world.traverse(o=>{if(!o.isMesh||o.isInstancedMesh||o===shadowPlane)return;let p=o.parent;while(p&&p!==world){if(p.userData.treeRoot||p.userData.hangingLantern)return;p=p.parent;}if(Array.isArray(o.material))return;const key=o.material.uuid;if(!staticGroups.has(key))staticGroups.set(key,{material:o.material,geometries:[]});const g=o.geometry.clone().applyMatrix4(o.matrixWorld);g.deleteAttribute('color');if(!g.index){const n=g.attributes.position.count;g.setIndex(Array.from({length:n},(_,i)=>i));}staticGroups.get(key).geometries.push(g);staticMeshes.push(o);});
for(const {material,geometries} of staticGroups.values()){const g=mergeGeometries(geometries);if(g)mesh(g,material);geometries.forEach(g=>g.dispose());}
staticMeshes.forEach(m=>{m.removeFromParent();m.geometry.dispose();});

// A small, tactile travel poster on the front wall. It stays outside the
// static bake so it can be picked by the raycaster and open the 3D window.
function sydneyPosterTexture(){
  const c=document.createElement('canvas');c.width=512;c.height=640;const g=c.getContext('2d');
  const sky=g.createLinearGradient(0,0,0,390);sky.addColorStop(0,'#4c578f');sky.addColorStop(.46,'#8d7ba9');sky.addColorStop(.76,'#d49faa');sky.addColorStop(1,'#f4c39a');g.fillStyle=sky;g.fillRect(0,0,512,640);
  const glow=g.createRadialGradient(320,355,10,320,355,210);glow.addColorStop(0,'#ffe4b188');glow.addColorStop(1,'#ffd1a100');g.fillStyle=glow;g.fillRect(0,100,512,330);
  g.fillStyle='#f2d3ae';g.globalAlpha=.22;for(let i=0;i<16;i++){g.beginPath();g.ellipse(70+i*37,130+(i*29)%110,55+(i*17)%60,9+(i%3)*4,0,0,Math.PI*2);g.fill();}g.globalAlpha=1;
  const water=g.createLinearGradient(0,378,0,580);water.addColorStop(0,'#9f92ae');water.addColorStop(.32,'#7783a4');water.addColorStop(1,'#424f70');g.fillStyle=water;g.fillRect(0,374,512,206);
  g.globalAlpha=.45;g.strokeStyle='#f4c48f';g.lineWidth=1.4;for(let i=0;i<27;i++){const y=392+i*6.5,x=228+Math.sin(i*1.7)*40;g.beginPath();g.moveTo(x,y);g.lineTo(x+70+(i%5)*12,y);g.stroke();}g.globalAlpha=1;
  // Distant city and warm windows.
  g.fillStyle='#5b5577';for(let i=0;i<22;i++){const w=10+(i%4)*5,h=14+(i*13)%30;g.fillRect(28+i*19,364-h,w,h);}
  g.fillStyle='#ffc981';for(let i=0;i<42;i++)g.fillRect(34+(i*31)%390,350+(i*17)%24,2,2);
  // Opera House.
  g.fillStyle='#ffe0c1';g.beginPath();g.moveTo(265,382);g.bezierCurveTo(270,330,284,298,298,275);g.bezierCurveTo(305,310,318,352,335,382);g.fill();g.beginPath();g.moveTo(310,382);g.bezierCurveTo(317,321,331,300,344,285);g.bezierCurveTo(354,320,365,355,381,382);g.fill();g.beginPath();g.moveTo(357,382);g.bezierCurveTo(365,334,376,317,388,302);g.bezierCurveTo(398,334,405,359,419,382);g.fill();g.fillStyle='#f3be93';g.fillRect(258,380,168,12);
  // Harbour Bridge.
  g.strokeStyle='#615a74';g.lineWidth=5;g.beginPath();g.moveTo(20,354);g.bezierCurveTo(95,262,175,262,235,354);g.stroke();g.lineWidth=2;g.beginPath();g.moveTo(6,365);g.lineTo(250,365);g.stroke();for(let i=0;i<9;i++){const x=42+i*19,y=304+Math.sin(i/8*Math.PI)*5;g.beginPath();g.moveTo(x,365);g.lineTo(x,307+(i%4)*3);g.stroke();}
  g.fillStyle='#ffc682';for(let i=0;i<11;i++)g.fillRect(8+i*21,362,2,2);
  // Jacaranda branches framing the poster.
  g.strokeStyle='#664b4b';g.lineWidth=4;g.beginPath();g.moveTo(-10,82);g.bezierCurveTo(50,94,98,130,146,158);g.stroke();g.lineWidth=2;g.beginPath();g.moveTo(52,102);g.bezierCurveTo(76,75,109,68,132,50);g.stroke();g.beginPath();g.moveTo(104,133);g.bezierCurveTo(125,156,157,166,181,174);g.stroke();
  g.strokeStyle='#6f5150';g.lineWidth=4;g.beginPath();g.moveTo(530,580);g.bezierCurveTo(470,560,430,525,388,500);g.stroke();g.lineWidth=2;g.beginPath();g.moveTo(438,531);g.bezierCurveTo(432,566,408,586,389,601);g.stroke();
  const blossom=(x,y,r)=>{g.fillStyle=(Math.floor(x+y)%3)?'#b694e6':'#ceb2f2';g.globalAlpha=.92;for(let i=0;i<5;i++){const a=i/5*Math.PI*2;g.beginPath();g.arc(x+Math.cos(a)*r*.55,y+Math.sin(a)*r*.55,r*.52,0,Math.PI*2);g.fill();}g.globalAlpha=1;};
  for(let i=0;i<55;i++){const t=i/54;const x=132*t+Math.sin(i*2.4)*20,y=52+63*t+Math.sin(i*1.7)*15;blossom(x,y,5+(i%4));}
  for(let i=0;i<50;i++){const t=i/49;const x=533-134*t+Math.sin(i*2.2)*18,y=581-70*t+Math.sin(i*1.4)*13;blossom(x,y,5+(i%4));}
  // Typography plaque.
  g.fillStyle='#f5ecd9';g.fillRect(0,548,512,92);
  g.fillStyle='#6f6677';g.textAlign='left';g.font='500 22px Georgia';g.fillText('SYDNEY',36,578);
  g.font='italic 34px Georgia';g.fillStyle='#86709f';g.fillText('Jacaranda Days',36,613);
  g.font='500 12px Arial';g.fillStyle='#9d928f';g.textAlign='right';g.fillText('NOVEMBER IN BLOOM  ↗',477,580);g.font='10px Arial';g.fillStyle='#b0a39c';g.fillText('TAP TO OPEN',477,608);
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return t;
}
const posterFrameMat=new THREE.MeshStandardMaterial({color:'#b49d7e',metalness:.32,roughness:.34});
const posterGroup=new THREE.Group();posterGroup.position.set(.72,1.56,2.955);world.add(posterGroup);
const posterFrameParts=[];
for(const [x,y,w,h] of [[0,.51,.87,.055],[0,-.51,.87,.055],[-.435,0,.055,1.02],[.435,0,.055,1.02]]){const geo=new THREE.BoxGeometry(w,h,.055);geo.translate(x,y,.025);posterFrameParts.push(geo);}
mesh(mergeGeometries(posterFrameParts),posterFrameMat,posterGroup);posterFrameParts.forEach(g=>g.dispose());
const posterTex=sydneyPosterTexture();
const posterBoard=new THREE.Mesh(new THREE.BoxGeometry(.79,1.00,.026),new THREE.MeshStandardMaterial({map:posterTex,emissiveMap:posterTex,emissive:'#8a7895',emissiveIntensity:.08,roughness:.34,metalness:.08}));
posterBoard.position.z=.055;posterBoard.castShadow=true;posterBoard.userData.interactive=true;posterGroup.add(posterBoard);adTargets.push(posterBoard);

const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
const maxFalling=260,falling=[];
const fallingMesh=new THREE.InstancedMesh(petalGeo,petalMat,maxFalling);fallingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);fallingMesh.frustumCulled=false;world.add(fallingMesh);
function freshPetal(treeIndex,burst=false){const t=treeSpecs[treeIndex];return {x:t.x+range(-1.25,1.25),y:t.h*range(.70,.98),z:t.z+range(-1.2,1.2),vy:range(.22,.52),vx:range(-.09,.13),rot:range(0,6.28),spin:range(.4,1.2),scale:range(.55,1),life:burst?1:0,active:true};}
for(let i=0;i<maxFalling;i++){const p=freshPetal(i%7);p.y=range(.4,9);p.active=i<42;falling.push(p);}
let lastBurst=-10;
function petalBurst(index){let count=0;for(let i=0;i<falling.length&&count<76;i++)if(!falling[i].active||i>42){falling[i]=freshPetal(index,true);count++;}lastBurst=clock.elapsedTime;toast('一阵花雨，落在悉尼的春天里');}
let toastTimer;
function toast(text){const el=document.querySelector('#toast');el.textContent=text;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),2300);}

const presets={
  day:{ambient:1.7,sun:3.15,fill:.55,sky:'#e8ecff',ground:'#b7a696',sunColor:'#fff5e4',fillColor:'#c3c2ee',glass:'#809ca9',emissive:0,lamp:.10,local:0,exposure:1.13,flowerGlow:0,shadowStrength:.82,shadowSoftness:2,groundShadow:.32,sunPos:[-14,37,16]},
  dusk:{ambient:.86,sun:2.95,fill:.65,sky:'#cbb6d8',ground:'#8a665f',sunColor:'#ff8f3d',fillColor:'#a985bd',glass:'#a98a94',emissive:.7,lamp:3.6,local:.9,exposure:1.02,flowerGlow:.025,shadowStrength:.78,shadowSoftness:3.2,groundShadow:.34,sunPos:[-22,23,-8]},
  night:{ambient:.72,sun:.70,fill:.30,sky:'#98a1dc',ground:'#4b435e',sunColor:'#b7c5f2',fillColor:'#8d86ca',glass:'#58678e',emissive:.98,lamp:4.8,local:1.05,exposure:1.04,flowerGlow:.065,shadowStrength:.26,shadowSoftness:2.8,groundShadow:.20,sunPos:[14,41,-18]}
};
let currentTime='day',transition=1,startPreset=presets.day,targetPreset=presets.day;
const colorKeys=['sky','ground','sunColor','fillColor','glass','sunPos'];
const colorTemp=new THREE.Color();
function readLightState(){return {ambient:ambient.intensity,sun:sun.intensity,fill:fill.intensity,sky:'#'+ambient.color.getHexString(),ground:'#'+ambient.groundColor.getHexString(),sunColor:'#'+sun.color.getHexString(),fillColor:'#'+fill.color.getHexString(),glass:'#'+glass.color.getHexString(),emissive:windowWarm.emissiveIntensity,lamp:lampGlass.emissiveIntensity,local:localLights[0].light.intensity/localLights[0].power,exposure:renderer.toneMappingExposure,flowerGlow:flowerMat.emissiveIntensity,shadowStrength:sun.shadow.intensity,shadowSoftness:sun.shadow.radius,groundShadow:groundShadowMat.opacity,sunPos:sun.position.toArray()};}
function setTime(name){if(!presets[name])return;currentTime=name;startPreset=readLightState();targetPreset=presets[name];transition=0;document.querySelectorAll('[data-time]').forEach(b=>{b.classList.toggle('active',b.dataset.time===name);b.setAttribute('aria-pressed',String(b.dataset.time===name));});document.querySelector('#time-caption').textContent={day:'14:00',dusk:'18:30',night:'21:00'}[name];
  const app=document.querySelector('#app');app.classList.toggle('night',name==='night');app.classList.toggle('dusk',name==='dusk');
}
document.querySelectorAll('[data-time]').forEach(b=>b.addEventListener('click',()=>setTime(b.dataset.time)));
let resetTween=null;
function defaultPosition(){return innerWidth<650?V(27.4,14.5,35.4):V(18.7,10.4,25.0);}
function defaultTarget(){return innerWidth<650?V(0,4.6,0):V(.7,4.0,.7);}
function resetCamera(instant=false){const p=defaultPosition(),t=defaultTarget();if(instant){camera.position.copy(p);controls.target.copy(t);controls.update();}else{resetTween={p:camera.position.clone(),t:controls.target.clone(),endP:p,endT:t,progress:0};}}
document.querySelector('#reset').addEventListener('click',()=>{resetCamera();toast('回到初见的街角');});
function zoom(factor){const offset=camera.position.clone().sub(controls.target),d=clamp(offset.length()*factor,controls.minDistance,controls.maxDistance);camera.position.copy(controls.target).add(offset.setLength(d));controls.update();}
document.querySelector('#zoom-in').addEventListener('click',()=>zoom(.86));document.querySelector('#zoom-out').addEventListener('click',()=>zoom(1.16));
// Pointer moves consume their full rotation immediately. A small residual
// easing remains available for programmatic camera updates between gestures.
controls.addEventListener('start',()=>{resetTween=null;controls.dampingFactor=1;});
controls.addEventListener('end',()=>{controls.dampingFactor=.24;});
let pointerStart=null;const raycaster=new THREE.Raycaster();
function setRay(e){const rect=renderer.domElement.getBoundingClientRect();raycaster.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);}
renderer.domElement.addEventListener('pointerdown',e=>{pointerStart={x:e.clientX,y:e.clientY,t:performance.now()};});
renderer.domElement.addEventListener('pointermove',e=>{if(pointerStart)return;setRay(e);renderer.domElement.style.cursor=raycaster.intersectObjects(adTargets,false).length?'pointer':'';});
renderer.domElement.addEventListener('pointercancel',()=>{pointerStart=null;});
renderer.domElement.addEventListener('pointerup',e=>{const start=pointerStart;pointerStart=null;if(!start||Math.hypot(e.clientX-start.x,e.clientY-start.y)>7||performance.now()-start.t>650)return;setRay(e);if(raycaster.intersectObjects(adTargets,false).length){sydneyWindow.open();return;}const hits=raycaster.intersectObjects(crownTargets,false);if(hits.length)petalBurst(hits[0].object.userData.treeIndex);});
let postcardBackdrop=null,postcardBackdropContext=null,postcardBackdropDirty=true,postcardBackdropActive=false;
function resize(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.fov=w<650?49:34;controls.maxDistance=w<650?50:38;camera.setViewOffset(w,h,w<650?0:(w<1250?-w*.16:-w*.105),w<650?-h*.07:0,w,h);camera.updateProjectionMatrix();postcardBackdropDirty=true;}
window.addEventListener('resize',resize);resize();resetCamera(true);
const clock=new THREE.Clock();let frames=0,lastRender=0;
function animate(){requestAnimationFrame(animate);const elapsed=clock.getDelta(),dt=Math.min(elapsed,.05),time=clock.elapsedTime;
  // The translucent postcard needs a visible street backdrop, but that street
  // is stationary. Copy it once (and on resize) instead of drawing millions
  // of triangles behind a second WebGL scene on every animation frame.
  if(sydneyWindow.isOpen()){
    if(!postcardBackdropActive||postcardBackdropDirty){
      if(!postcardBackdrop){postcardBackdrop=document.createElement('canvas');postcardBackdrop.className='postcard-street-backdrop';postcardBackdrop.setAttribute('aria-hidden','true');postcardBackdrop.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';postcardBackdropContext=postcardBackdrop.getContext('2d');renderer.domElement.parentElement.appendChild(postcardBackdrop);}
      renderer.render(scene,camera);frames++;lastRender=time;
      postcardBackdrop.width=renderer.domElement.width;postcardBackdrop.height=renderer.domElement.height;
      postcardBackdropContext.drawImage(renderer.domElement,0,0);
      postcardBackdrop.style.display='block';renderer.domElement.style.visibility='hidden';
      postcardBackdropActive=true;postcardBackdropDirty=false;
    }
    return;
  }
  if(postcardBackdropActive){postcardBackdrop.style.display='none';renderer.domElement.style.visibility='';postcardBackdropActive=false;}
  controls.update();
  if(resetTween){resetTween.progress=Math.min(1,resetTween.progress+elapsed*1.75);const f=1-Math.pow(1-resetTween.progress,3);camera.position.lerpVectors(resetTween.p,resetTween.endP,f);controls.target.lerpVectors(resetTween.t,resetTween.endT,f);if(resetTween.progress===1)resetTween=null;}
  if(transition<1){
    transition=Math.min(1,transition+elapsed/2.8);
    const t=transition*transition*(3-2*transition),v={};
    for(const key of Object.keys(targetPreset)){if(!colorKeys.includes(key))v[key]=THREE.MathUtils.lerp(startPreset[key],targetPreset[key],t);}
    ambient.intensity=v.ambient;sun.intensity=v.sun;fill.intensity=v.fill;
    ambient.color.set(startPreset.sky).lerp(colorTemp.set(targetPreset.sky),t);
    ambient.groundColor.set(startPreset.ground).lerp(colorTemp.set(targetPreset.ground),t);
    sun.color.set(startPreset.sunColor).lerp(colorTemp.set(targetPreset.sunColor),t);
    fill.color.set(startPreset.fillColor).lerp(colorTemp.set(targetPreset.fillColor),t);
    sun.position.set(...startPreset.sunPos.map((value,i)=>THREE.MathUtils.lerp(value,targetPreset.sunPos[i],t)));
    sun.shadow.intensity=v.shadowStrength;sun.shadow.radius=v.shadowSoftness;
    renderer.shadowMap.needsUpdate=true;
    groundShadowMat.opacity=v.groundShadow;benchLight.shadow.intensity=.32*v.local;
    glass.color.set(startPreset.glass).lerp(colorTemp.set(targetPreset.glass),t);
    glassDim.color.set(startPreset.glass).lerp(colorTemp.set(targetPreset.glass),t).multiplyScalar(.88);
    windowWarm.emissiveIntensity=v.emissive;lampGlass.emissiveIntensity=v.lamp;hangingLampGlass.emissiveIntensity=v.lamp*.50;flowerMat.emissiveIntensity=v.flowerGlow;
    posterBoard.material.emissiveIntensity=.08+v.emissive*.06;renderer.toneMappingExposure=v.exposure;
    localLights.forEach(({light,power})=>light.intensity=power*v.local);
    // These are the visible opaque panes; the interior backing alone cannot
    // shine through them. Keep every room warm with modest brightness variety.
    glass.emissive.set('#ffd18b');glassDim.emissive.set('#efc387');
    glass.emissiveIntensity=v.emissive*1.35;glassDim.emissiveIntensity=v.emissive*1.12;
  }
  if(!reducedMotion){trees.forEach(t=>{t.crown.rotation.z=Math.sin(time*.52+t.phase)*.0032;t.crown.rotation.x=Math.sin(time*.39+t.phase)*.0021;});}
  for(let i=0;i<falling.length;i++){const p=falling[i];if(p.active&&!reducedMotion){p.y-=p.vy*dt;p.x+=(p.vx+Math.sin(time+p.rot)*.09)*dt;p.z+=Math.cos(time*.6+p.rot)*dt*.06;p.rot+=p.spin*dt;if(p.y<.38){if(i<42)Object.assign(p,freshPetal(i%7));else p.active=false;}}
    if(p.active){dummy.position.set(p.x,p.y,p.z);dummy.rotation.set(p.rot,Math.sin(p.rot*.6),p.rot*.6);dummy.scale.setScalar(p.scale);}else{dummy.position.set(0,-5,0);dummy.scale.setScalar(0);}dummy.updateMatrix();fallingMesh.setMatrixAt(i,dummy.matrix);
  }
  fallingMesh.instanceMatrix.needsUpdate=true;
  renderer.render(scene,camera);frames++;lastRender=time;
  if(frames===2)document.querySelector('#loading').classList.add('done');
}
animate();
// Read-only scene diagnostics and deterministic view helpers for local QA.
window.__JACARANDA__={
  ready:true,renderer,scene,camera,controls,trees,setTime,resetCamera,petalBurst,sydneyWindow,music,adTargets,posterBoard,
  inspect:()=>({trees:trees.length,flowers:trees.reduce((n,t)=>n+t.flowers,0),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,time:currentTime,lightPosition:sun.position.toArray(),transition,shadowAutoUpdate:renderer.shadowMap.autoUpdate,postcardBackdropCached:postcardBackdropActive,cameraNear:camera.near,camera:camera.position.toArray(),target:controls.target.toArray(),activePetals:falling.filter(p=>p.active).length,frames,lastRender}),
  view:(x,y,z)=>{resetTween=null;camera.position.set(x,y,z);controls.update();},
  crownScreen:(index)=>{const t=trees[index],p=V(t.spec.x,t.h*.85,t.spec.z).project(camera);return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};},
  posterScreen:()=>{const p=posterBoard.getWorldPosition(V(0,0,0)).project(camera);return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};}
};
