// three.js-вьювер каталога: GLB, режимы (текстуры / сетка / базовый цвет / нормали / шероховатость / металл / AO / без текстур / UV),
// панель карт из самого GLB, фон, счётчик треугольников, автофокус.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const CHANNEL_SHADER = {
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D map; uniform vec4 mask; uniform float fallback; uniform float hasMap; varying vec2 vUv;
    void main(){ float v = hasMap > 0.5 ? dot(texture2D(map, vUv), mask) : fallback; gl_FragColor = vec4(vec3(v), 1.0); }`,
};

export const MODE_NAMES = {
  tex: 'PBR: все карты', wire: 'сетка поверх текстур', base: 'Base Color без освещения', normal: 'рельеф по карте нормалей',
  rough: 'Roughness: светлое = матовое', metal: 'Metallic: светлое = металл', ao: 'Ambient Occlusion', emissive: 'Emissive', clay: 'серая глина, только геометрия', uv: 'UV-развёртка',
};

export class Viewer {
  constructor(container, { canvas, uvCanvas, hud } = {}) {
    this.container = container;
    this.canvas = canvas || container.querySelector('canvas.gl') || container.appendChild(Object.assign(document.createElement('canvas'), { className: 'gl' }));
    this.uvCanvas = uvCanvas || container.querySelector('canvas.uv');
    this.hud = hud || container.querySelector('.hud');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping; this.renderer.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1.6, 0.01, 100);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true; this.controls.autoRotate = true; this.controls.autoRotateSpeed = 1.0;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.7;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2d35, 0.6));
    this.key = new THREE.DirectionalLight(0xfff1dc, 1.6); this.key.position.set(2, 3, 2); this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0xbcd6ff, 0.8); this.rim.position.set(-3, 1, -2); this.scene.add(this.rim);
    this.grid = new THREE.GridHelper(2, 20, 0x3a3f4a, 0x262a33); this.scene.add(this.grid);
    this.root = null; this.meshes = []; this.mode = 'tex'; this.light = false; this.wires = [];
    this.alt = new Map(); // mesh -> {mode: material}
    this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(this.container);
    this.resize();
    // UV-развёртка рисуется тем же WebGL-рендерером в отдельной сцене: сотни тысяч рёбер за кадр, Canvas2D на таких объёмах тратил секунды
    this.uvScene = new THREE.Scene(); this.uvCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1); this.uvCam.position.z = 0.5; this.uvGroup = null;
    this._raf = () => { this._frame = requestAnimationFrame(this._raf); this.controls.update(); if (this.mode === 'uv') { if (this.uvGroup) this.renderer.render(this.uvScene, this.uvCam); } else this.renderer.render(this.scene, this.camera); };
    this._raf();
  }

  resize() {
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 500;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.mode === 'uv') this.drawUV();
  }

  async load(url, onProgress) {
    this.clear();
    const loader = new GLTFLoader();
    const gltf = await new Promise((res, rej) => loader.load(url, res, (e) => onProgress && onProgress(e), rej));
    this.root = gltf.scene; this.scene.add(this.root);
    this.meshes = []; this.root.traverse(o => { if (o.isMesh) { this.meshes.push(o); o.frustumCulled = false; } });
    // one material per mesh instance so modes can swap per mesh
    for (const m of this.meshes) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mt of mats) { mt.side = mt.alphaTest > 0 || mt.transparent ? THREE.DoubleSide : mt.side; if (mt.map) mt.map.anisotropy = 8; }
      m.userData.orig = m.material;
    }
    this.info = this.computeInfo();
    this.fit();
    this.setMode(this.mode);
    return this.info;
  }

  clear() {
    if (this.root) { this.scene.remove(this.root); this.root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); } }); }
    for (const w of this.wires) { this.scene.remove(w); w.geometry.dispose(); w.material.dispose(); }
    if (this.uvGroup) { this.uvScene.remove(this.uvGroup); this.uvGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); this.uvGroup = null; }
    this.wires = []; this.alt.clear(); this.root = null; this.meshes = []; this.info = null;
  }

  computeInfo() {
    let tris = 0, verts = 0;
    for (const m of this.meshes) { const g = m.geometry; verts += g.attributes.position.count; tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3; }
    const box = new THREE.Box3().setFromObject(this.root); const size = new THREE.Vector3(); box.getSize(size);
    return { tris: Math.round(tris), verts, meshes: this.meshes.length, size: [size.x, size.y, size.z], box, maps: this.collectMaps() };
  }

  fit() {
    if (!this.root) return;
    const box = new THREE.Box3().setFromObject(this.root); const c = box.getCenter(new THREE.Vector3()); const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
    const d = r / Math.sin(this.camera.fov * Math.PI / 360) * 1.15;
    this.camera.position.set(c.x + d * 0.62, c.y + d * 0.42, c.z + d * 0.68);
    this.camera.near = Math.max(d / 500, 1e-4); this.camera.far = d * 20; this.camera.updateProjectionMatrix();
    this.controls.target.copy(c); this.controls.update();
    this.grid.position.set(c.x, box.min.y, c.z); this.grid.scale.setScalar(Math.max(r, 0.5));
    this.key.position.set(c.x + r * 3, c.y + r * 4, c.z + r * 3); this.rim.position.set(c.x - r * 4, c.y + r, c.z - r * 3);
    this.controls.autoRotate = true;
  }

  // ---------- режимы
  altMaterial(mesh, mode) {
    const orig = Array.isArray(mesh.userData.orig) ? mesh.userData.orig[0] : mesh.userData.orig;
    const cache = this.alt.get(mesh) || {}; if (cache[mode]) return cache[mode];
    const common = { side: orig.side, transparent: false, alphaTest: orig.alphaTest || 0, alphaMap: orig.alphaMap || null };
    let mat;
    const channel = (tex, mask, fallback) => new THREE.ShaderMaterial({ ...CHANNEL_SHADER, side: orig.side,
      uniforms: { map: { value: tex || null }, mask: { value: new THREE.Vector4(...mask) }, fallback: { value: fallback }, hasMap: { value: tex ? 1 : 0 } } });
    switch (mode) {
      case 'base': mat = new THREE.MeshBasicMaterial({ ...common, map: orig.map || null, color: orig.map ? 0xffffff : orig.color, vertexColors: orig.vertexColors }); if (orig.map && orig.alphaTest) mat.alphaTest = orig.alphaTest; break;
      case 'normal': mat = new THREE.MeshStandardMaterial({ ...common, color: 0x9a9a9a, normalMap: orig.normalMap || null, normalScale: orig.normalScale, roughness: 0.55, metalness: 0 }); if (orig.map && orig.alphaTest) { mat.map = orig.map; mat.color.set(0xffffff); mat.onBeforeCompile = (s) => { s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', '#ifdef USE_MAP\n vec4 sampledDiffuseColor = texture2D( map, vMapUv ); diffuseColor.a *= sampledDiffuseColor.a;\n#endif'); }; } break;
      case 'rough': mat = channel(orig.roughnessMap, [0, 1, 0, 0], orig.roughness ?? 0.5); break;
      case 'metal': mat = channel(orig.metalnessMap, [0, 0, 1, 0], orig.metalness ?? 0); break;
      case 'ao': mat = channel(orig.aoMap, [1, 0, 0, 0], 1); break;
      case 'emissive': mat = new THREE.MeshBasicMaterial({ ...common, map: orig.emissiveMap || null, color: orig.emissiveMap ? 0xffffff : orig.emissive }); break;
      case 'clay': mat = new THREE.MeshStandardMaterial({ ...common, color: 0x9c9690, roughness: 0.85, metalness: 0 }); break;
      default: mat = orig;
    }
    cache[mode] = mat; this.alt.set(mesh, cache); return mat;
  }

  setMode(mode) {
    this.mode = mode;
    if (this.uvCanvas) this.uvCanvas.hidden = true; // 2D-канва больше не используется, UV рисует WebGL
    if (mode === 'uv') { this.drawUV(); this.updateHud(); return; }
    for (const w of this.wires) w.visible = mode === 'wire';
    if (mode === 'wire' && !this.wires.length) {
      for (const m of this.meshes) {
        const w = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ wireframe: true, color: 0x62c9ff, transparent: true, opacity: 0.55, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1 }));
        w.matrixAutoUpdate = false; m.updateWorldMatrix(true, false); w.matrix.copy(m.matrixWorld); w.frustumCulled = false; this.scene.add(w); this.wires.push(w);
      }
    }
    for (const m of this.meshes) m.material = (mode === 'tex' || mode === 'wire') ? m.userData.orig : this.altMaterial(m, mode);
    this.updateHud();
  }

  updateHud() {
    if (!this.hud || !this.info) return;
    const uvNote = this.mode === 'uv' && this.uvGroup ? (this.uvGroup.userData.hasUV ? ` · ${this.uvGroup.userData.edges.toLocaleString('ru-RU')} рёбер UV` : ' · у модели нет UV') : '';
    this.hud.textContent = `${MODE_NAMES[this.mode] || this.mode} · ${this.info.tris.toLocaleString('ru-RU')} тр. · ${this.info.verts.toLocaleString('ru-RU')} верш.${uvNote}`;
  }

  setBackground(light) {
    this.light = light; this.container.classList.toggle('light', light);
    this.grid.material.color.set(light ? 0xb9b6ae : 0x3a3f4a); this.scene.background = new THREE.Color(light ? 0xd9d6ce : 0x0f1115);
    if (this.mode === 'uv') this.drawUV();
  }

  // ---------- UV
  // Геометрия развёртки строится один раз на модель: квадрат 0–1, сетка 8×8 и рёбра треугольников в UV (общие рёбра один раз).
  buildUV() {
    if (this.uvGroup || !this.meshes.length) return this.uvGroup;
    const g = new THREE.Group();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x171a20 })); plane.position.set(0.5, 0.5, -0.02); g.add(plane);
    const gp = []; for (let i = 0; i <= 8; i++) { const t = i / 8; gp.push(t, 0, -0.01, t, 1, -0.01, 0, t, -0.01, 1, t, -0.01); }
    const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(gp, 3)), new THREE.LineBasicMaterial({ color: 0x2d313b })); g.add(grid);
    let edges = 0, hasUV = false; const chunks = [];
    for (const m of this.meshes) {
      const uv = m.geometry.attributes.uv; if (!uv) continue; hasUV = true;
      const idx = m.geometry.index; const n = idx ? idx.count : uv.count; const seen = new Set(); const arr = [];
      const push = (a, b) => { const lo = a < b ? a : b, hi = a < b ? b : a; const k = lo * 16777216 + hi; if (seen.has(k)) return; seen.add(k); arr.push(uv.getX(a), uv.getY(a), 0, uv.getX(b), uv.getY(b), 0); };
      for (let i = 0; i + 2 < n; i += 3) { const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, d = idx ? idx.getX(i + 2) : i + 2; push(a, b); push(b, d); push(d, a); }
      edges += arr.length / 6; chunks.push(arr);
    }
    let lines = null;
    if (hasUV) {
      const pos = new Float32Array(edges * 6); let o = 0; for (const c of chunks) { pos.set(c, o); o += c.length; }
      lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)), new THREE.LineBasicMaterial({ color: 0x62c9ff, transparent: true, opacity: Math.min(0.6, Math.max(0.18, 50000 / edges)) })); // плотные развёртки — прозрачнее, иначе сплошное пятно
      lines.frustumCulled = false; g.add(lines);
    }
    g.userData = { plane, grid, lines, hasUV, edges };
    this.uvScene.add(g); this.uvGroup = g; return g;
  }

  // Камера подгоняется так, чтобы квадрат 0–1 занимал ту же область, что раньше рисовала 2D-канва: min(W,H) − 40 по центру.
  drawUV() {
    const g = this.buildUV(); if (!g) return;
    const W = this.container.clientWidth || 800, H = this.container.clientHeight || 500; const s = Math.min(W, H) - 40, ox = (W - s) / 2, oy = (H - s) / 2;
    const cam = this.uvCam; cam.left = -ox / s; cam.right = (W - ox) / s; cam.top = 1 + oy / s; cam.bottom = 1 - (H - oy) / s; cam.updateProjectionMatrix();
    this.uvScene.background = new THREE.Color(this.light ? 0xd9d6ce : 0x0f1115);
    g.userData.plane.material.color.set(this.light ? 0xe8e5dd : 0x171a20); g.userData.grid.material.color.set(this.light ? 0xc5c2b9 : 0x2d313b);
    if (g.userData.lines) g.userData.lines.material.color.set(this.light ? 0x1a7fc0 : 0x62c9ff);
  }

  // ---------- карты из GLB
  collectMaps() {
    const seen = new Map(); const list = [];
    const kinds = [['map', 'Base Color', 'base', null], ['normalMap', 'Normal', 'normal', null], ['roughnessMap', 'Roughness', 'rough', 1], ['metalnessMap', 'Metallic', 'metal', 2], ['aoMap', 'AO', 'ao', 0], ['emissiveMap', 'Emissive', 'emissive', null]];
    for (const m of this.meshes) {
      const mats = Array.isArray(m.userData.orig) ? m.userData.orig : [m.userData.orig];
      for (const mt of mats) for (const [prop, label, mode, ch] of kinds) {
        const t = mt[prop]; if (!t || !t.image) continue;
        const key = (t.image.src || t.uuid) + ':' + (ch ?? 'rgb'); if (seen.has(key)) continue;
        const w = t.image.width || t.image.naturalWidth, h = t.image.height || t.image.naturalHeight;
        const cv = document.createElement('canvas'); const S = 256; cv.width = S; cv.height = S; const ctx = cv.getContext('2d');
        try {
          ctx.drawImage(t.image, 0, 0, S, S);
          if (ch != null) { const d = ctx.getImageData(0, 0, S, S); const p = d.data; for (let i = 0; i < p.length; i += 4) { p[i] = p[i + 1] = p[i + 2] = p[i + ch]; } ctx.putImageData(d, 0, 0); }
        } catch (e) { /* cross-origin image: leave blank */ }
        const entry = { kind: label, mode, width: w, height: h, canvas: cv, material: mt.name || '' };
        seen.set(key, entry); list.push(entry);
      }
    }
    return list;
  }

  screenshot() { this.renderer.render(this.scene, this.camera); return this.canvas.toDataURL('image/png'); }

  dispose() { cancelAnimationFrame(this._frame); this._ro.disconnect(); this.clear(); this.renderer.dispose(); }
}
