// Страница модели: вьювер, панель карт, режимы, фон.
import { Viewer, MODE_NAMES } from './viewer.js?v=mvf765ag';
import { wireDownloads } from './auth.js?v=mvf765ag';
wireDownloads(document.getElementById('dl'), document.getElementById('authNote'));

const data = JSON.parse(document.getElementById('model-data').textContent);
const cw = document.getElementById('cw');
const viewer = new Viewer(cw, { canvas: document.getElementById('gl'), uvCanvas: document.getElementById('uvCanvas'), hud: document.getElementById('hud') });
window.__viewer = viewer;
const loading = document.getElementById('loading');
const modesBox = document.getElementById('modes');
const mapsBox = document.getElementById('maps');
let mode = 'tex';

function setMode(m) {
  mode = m; viewer.setMode(m);
  modesBox.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  mapsBox.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
}
modesBox.addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
mapsBox.addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(mode === b.dataset.mode ? 'tex' : b.dataset.mode); });
document.getElementById('fitBtn').addEventListener('click', () => viewer.fit());
let light = false; const bgBtn = document.getElementById('bgBtn');
bgBtn.addEventListener('click', () => { light = !light; bgBtn.setAttribute('aria-pressed', String(light)); bgBtn.textContent = light ? 'Тёмный фон' : 'Светлый фон'; viewer.setBackground(light); });
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const keys = { '1': 'tex', '2': 'wire', '3': 'base', '4': 'normal', '5': 'rough', '6': 'clay', '7': 'uv' };
  if (keys[e.key]) setMode(keys[e.key]); if (e.key === 'f') viewer.fit();
});

try {
  loading.hidden = false;
  const info = await viewer.load(data.glb, (e) => { if (e.total) loading.textContent = `загрузка GLB… ${Math.round(e.loaded / e.total * 100)}%`; else loading.textContent = `загрузка GLB… ${(e.loaded / 1e6).toFixed(1)} МБ`; });
  loading.hidden = true;
  document.getElementById('vTris').textContent = info.tris.toLocaleString('ru-RU');
  document.getElementById('vVerts').textContent = info.verts.toLocaleString('ru-RU');
  // карты из GLB
  const maps = info.maps;
  mapsBox.innerHTML = '';
  if (!maps.length) mapsBox.insertAdjacentHTML('afterend', '<div class="note">В превью-GLB карт нет: материал задан постоянными значениями.</div>');
  for (const mp of maps) {
    const b = document.createElement('button'); b.className = 'map'; b.dataset.mode = mp.mode; b.setAttribute('aria-pressed', 'false'); b.title = mp.material;
    b.appendChild(mp.canvas); const s = document.createElement('span'); s.textContent = `${mp.kind} ${mp.width}×${mp.height}`; b.appendChild(s); mapsBox.appendChild(b);
  }
  // кнопки режимов, для которых нет карт — заблокировать
  const has = new Set(maps.map(m => m.mode));
  for (const b of modesBox.querySelectorAll('[data-mode]')) {
    const m = b.dataset.mode;
    if (['normal', 'rough', 'metal', 'ao', 'emissive'].includes(m) && !has.has(m) && m !== 'rough') b.disabled = true;
  }
  if (data.initialMode) setMode(data.initialMode);
} catch (e) {
  loading.hidden = false; loading.textContent = 'не удалось загрузить GLB: ' + (e.message || e);
  console.error(e);
}
