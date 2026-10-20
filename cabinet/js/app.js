// Кабинет владельца на PocketBase: модели, новая модель (job → воркер → Blender), текстуры, задачи, пользователи.
// Все изменения идут через коллекцию jobs; воркер на сервере применяет их к catalog/, заливает в PocketBase и пересобирает витрину.
import { Viewer } from '../../js/viewer.js?v=mvgmh7kp';
import { auth, api, PB_URL, openLogin, refresh, fileUrl } from '../../js/auth.js?v=mvgmh7kp';
import { detectMaps, MAP_LABELS } from './texdetect.js?v=mvgmh7kp';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n || 0).toLocaleString('ru-RU');
const fmtB = (n) => n == null ? '' : n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ';
const CAT = { scan: 'скан', sculpt: 'скульпт', hardsurface: 'hard surface', architecture: 'архитектура', botany: 'ботаника', fractal: 'фрактал', other: 'другое' };
const CATS = Object.keys(CAT);
const PLAT = { td: 'TouchDesigner', depence: 'Depence', notch: 'Notch' };
const EDIT = ['name_ru', 'name_en', 'description_ru', 'description_en', 'tags_ru', 'tags_en', 'category', 'origin', 'date'];
let toastT; function toast(msg) { let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 4000); }
let viewer = null; const killViewer = () => { if (viewer) { viewer.dispose(); viewer = null; } };
document.addEventListener('click', e => { if (e.target.closest('#themeBtn')) { const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); const n = cur === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', n); try { localStorage.setItem('theme', n); } catch {} } });

// ---------- PocketBase helpers
const records = (c, params) => api(`/api/collections/${c}/records?` + new URLSearchParams(params));
async function allRecords(c, params = {}) { const out = []; let page = 1; for (;;) { const d = await records(c, { ...params, page, perPage: 200 }); out.push(...d.items); if (page >= d.totalPages) break; page++; } return out; }
const createJob = (type, model, options = {}, form = null) => { if (form) { form.append('type', type); form.append('model', model || ''); form.append('status', 'queued'); form.append('options', JSON.stringify(options)); return api('/api/collections/jobs/records', { method: 'POST', body: form, form: true }); } return api('/api/collections/jobs/records', { method: 'POST', body: { type, model: model || '', status: 'queued', options } }); };
const modelBySlug = async (slug) => (await records('models', { filter: `slug = "${slug}"`, perPage: 1 })).items[0] || null;

/** Realtime-подписка на запись jobs/<id>: лог стримится в el, onDone(record) по done/failed. */
function streamJob(jobId, el, onDone) {
  el.hidden = false; el.innerHTML = '';
  let shown = 0; let closed = false;
  const paint = (rec) => {
    const lines = (rec.log || '').split('\n').filter(Boolean);
    for (let i = shown; i < lines.length; i++) { const d = document.createElement('div'); d.textContent = lines[i]; const l = lines[i]; if (/WARN|ПРОПУЩЕНО|would/.test(l)) d.className = 'warn'; if (/CAT_FAIL|!!|Error|Traceback|FAIL|ОШИБКА|■ failed/.test(l)) d.className = 'err'; if (/CAT_DONE .* OK|PASS|Готово|■ done/.test(l)) d.className = 'ok'; el.appendChild(d); }
    shown = lines.length; el.scrollTop = el.scrollHeight;
    if ((rec.status === 'done' || rec.status === 'failed') && !closed) { closed = true; es.close(); onDone && onDone(rec); }
  };
  const es = new EventSource(`${PB_URL}/api/realtime`);
  es.addEventListener('PB_CONNECT', async (e) => {
    const { clientId } = JSON.parse(e.data);
    await api('/api/realtime', { method: 'POST', body: { clientId, subscriptions: [`jobs/${jobId}`] } });
    paint(await api(`/api/collections/jobs/records/${jobId}`));
  });
  es.addEventListener(`jobs/${jobId}`, (e) => paint(JSON.parse(e.data).record));
  es.onerror = () => { /* EventSource переподключится сам */ };
  // страховка: опрос раз в 5 с, если realtime молчит
  const poll = setInterval(async () => { if (closed) return clearInterval(poll); try { paint(await api(`/api/collections/jobs/records/${jobId}`)); } catch {} }, 5000);
}

// ---------- вьювер
async function mountViewer(host, glbUrl) {
  killViewer();
  host.innerHTML = `<div class="viewer"><div class="toolbar" id="modes">
    ${['tex:Текстуры', 'wire:Сетка', 'base:Базовый цвет', 'normal:Нормали', 'rough:Шероховатость', 'metal:Металл', 'clay:Без текстур', 'uv:UV'].map((s, i) => { const [m, l] = s.split(':'); return `<button class="tb" data-mode="${m}" aria-pressed="${i === 0}">${l}</button>`; }).join('')}
    <span class="sp"></span><button class="tb" id="fitBtn">Автофокус</button><button class="tb" id="bgBtn">Светлый фон</button></div>
    <div class="canvas-wrap" id="cw"><canvas class="gl"></canvas><canvas class="uv" hidden></canvas><div class="hud"></div><div class="loading" id="loading">загрузка GLB…</div></div></div>
    <div class="maps" id="maps" style="margin-top:10px"></div>`;
  viewer = new Viewer($('#cw', host));
  host.addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) { viewer.setMode(b.dataset.mode); host.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); } if (e.target.id === 'fitBtn') viewer.fit(); if (e.target.id === 'bgBtn') { viewer.setBackground(!viewer.light); e.target.textContent = viewer.light ? 'Тёмный фон' : 'Светлый фон'; } });
  try {
    const info = await viewer.load(glbUrl); $('#loading', host).hidden = true;
    const maps = $('#maps', host); for (const mp of info.maps) { const b = document.createElement('button'); b.className = 'map'; b.dataset.mode = mp.mode; b.appendChild(mp.canvas); const s = document.createElement('span'); s.textContent = `${mp.kind} ${mp.width}×${mp.height}`; b.appendChild(s); maps.appendChild(b); }
    return info;
  } catch (e) { $('#loading', host).textContent = 'GLB не загрузился: ' + e.message; return null; }
}
const glbOf = (rec) => rec.glb ? fileUrl('models', rec.id, rec.glb) : null;
const previewOf = (rec) => rec.preview ? fileUrl('models', rec.id, rec.preview) + '?thumb=400x300' : '';

function techTable(d) {
  const rows = [['Треугольники', fmt(d.polys)], ['Вершины', fmt(d.verts)], ['Объектов', fmt(d.objects)], ['Габариты, м', (d.dims_m || []).map(x => x.toFixed(3)).join(' × ')], ['UV-слои', `${d.uv_layers}${d.uv_generated ? ' (авто)' : ''}`],
    ['Материалы', (d.materials || []).map(x => x.name).join(', ') || '—'], ['Карты', (d.texture_maps || []).map(t => `${t.type} ${t.width}×${t.height}`).join(', ') || 'константы'], ['GLB', d.glb_bytes ? `${fmtB(d.glb_bytes)}, ${fmt(d.glb_tris)} тр.` : '—']];
  return `<div class="sum">${rows.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>` + ((d.warnings || []).length ? `<div class="warn-box">${d.warnings.map(esc).join('<br>')}</div>` : '');
}
async function packagesTable(rec) {
  const pk = (await records('packages', { filter: `model = "${rec.id}"`, perPage: 10 })).items;
  return `<table class="table"><tr><th>Платформа</th><th>На сервере</th><th>Размер</th><th>Заметка</th></tr>` + ['td', 'depence', 'notch'].map(k => { const p = pk.find(x => x.platform === k); const d = rec.data && rec.data.platforms && rec.data.platforms[k];
    return `<tr><td>${PLAT[k]}</td><td>${p ? `<a href="#" data-dl="${p.id}" data-file="${esc(p.file)}">${esc(p.file)}</a>` : d ? '<span class="badge pending">собран, не залит</span>' : '<span class="note">нет</span>'}</td><td class="mono">${p ? fmtB(p.size_bytes) : d ? fmtB(d.size_bytes) : ''}</td><td class="note small">${esc((d && d.notes || '').slice(0, 120))}</td></tr>`; }).join('') + `</table>`;
}
document.addEventListener('click', async e => { const a = e.target.closest('[data-dl]'); if (!a) return; e.preventDefault(); const t = (await api('/api/files/token', { method: 'POST' })).token; location.href = fileUrl('packages', a.dataset.dl, a.dataset.file, t); });

// ---------- страница: модели
async function pageModels() {
  killViewer();
  const models = await allRecords('models', { sort: 'slug' });
  const pk = await allRecords('packages', { fields: 'model,platform' });
  const view = $('#view');
  const render = (q) => {
    const list = models.filter(m => !q || [m.slug, m.name_ru, m.name_en, ...(m.tags || []), m.category].join(' ').toLowerCase().includes(q));
    $('#rows', view).innerHTML = list.map(m => `<tr>
      <td>${m.preview ? `<img src="${previewOf(m)}" alt="">` : ''}</td>
      <td><a class="name" href="#/model/${esc(m.slug)}">${esc(m.name_ru || m.slug)}</a><div class="note">${esc(m.slug)} · ${esc(CAT[m.category] || m.category)} · ${m.date || ''}</div></td>
      <td><span class="status ${m.status}">${m.status}</span>${(m.data && m.data.warnings || []).length ? ` <span class="badge pending" title="${esc((m.data.warnings || []).join('\n'))}">${m.data.warnings.length}⚠</span>` : ''}</td>
      <td class="mono">${fmt(m.polys)}</td>
      <td><div class="badges">${['td', 'depence', 'notch'].map(k => { const on = pk.some(p => p.model === m.id && p.platform === k); const built = m.data && m.data.platforms && m.data.platforms[k]; return `<span class="badge${on ? ' on' : built ? ' pending' : ''}" title="${on ? 'на сервере' : built ? 'собран, не залит' : 'нет пакета'}">${k.toUpperCase()}</span>`; }).join('')}</div></td>
      <td>${m.glb ? '<span class="badge on">GLB</span>' : '<span class="badge draft">нет GLB</span>'}</td>
      <td><div class="row"><button class="tb small" data-act="status" data-id="${esc(m.slug)}" data-to="${m.status === 'published' ? 'draft' : 'published'}">${m.status === 'published' ? 'Снять с публикации' : 'Опубликовать'}</button><button class="tb small" data-act="rebuild" data-id="${esc(m.slug)}">Пересобрать пакеты</button></div></td></tr>`).join('');
    $('#cnt', view).textContent = `${list.length} из ${models.length}`;
  };
  view.innerHTML = `<section class="panel"><div class="row"><input id="lq" class="in" type="search" placeholder="фильтр по списку: id, название, тег, категория" style="flex:1;min-width:240px"><span class="note" id="cnt"></span></div>
    <table class="table"><thead><tr><th></th><th>Модель</th><th>Статус</th><th>Тр.</th><th>Пакеты</th><th>Превью</th><th></th></tr></thead><tbody id="rows"></tbody></table>
    <div class="log" id="log" hidden></div></section>`;
  render(''); $('#lq', view).addEventListener('input', e => render(e.target.value.trim().toLowerCase()));
  view.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'status') { const j = await createJob('edit', b.dataset.id, { fields: { status: b.dataset.to } }); toast(`${b.dataset.id}: статус → ${b.dataset.to}, задача ${j.id}`); streamJob(j.id, $('#log', view), () => pageModels()); }
    if (b.dataset.act === 'rebuild') { const j = await createJob('rebuild', b.dataset.id, {}); toast('пересборка поставлена в очередь'); streamJob(j.id, $('#log', view), () => pageModels()); }
  });
}

// ---------- страница: одна модель
async function pageModel(slug) {
  killViewer();
  const rec = await modelBySlug(slug); if (!rec) { $('#view').innerHTML = `<div class="panel">модель ${esc(slug)} не найдена</div>`; return; }
  const d = rec.data || {}; const tags = await tagSuggestions();
  const view = $('#view');
  const field = (k, label, type = 'input', wide = false) => `<label class="${wide ? 'wide' : ''}">${label}${type === 'textarea' ? `<textarea name="${k}">${esc(d[k])}</textarea>` : `<input name="${k}" value="${esc(Array.isArray(d[k]) ? d[k].join(', ') : d[k])}">`}</label>`;
  view.innerHTML = `<section class="panel"><div class="row" style="justify-content:space-between"><h3>${esc(rec.name_ru || rec.slug)} <span class="note">· ${esc(rec.slug)}</span> <span class="status ${rec.status}">${rec.status}</span></h3>
    <div class="row"><a class="tb" href="#/models">← к списку</a><a class="tb" href="../models/${esc(rec.slug)}.html" target="_blank">страница на витрине ↗</a></div></div>
    <div class="stage"><div id="vhost"></div><div class="side"><div class="panel">${techTable(d)}</div></div></div></section>
  <section class="panel"><h2>Описание</h2><form class="form" id="editForm">
    ${field('name_ru', 'Название (рус)')}${field('name_en', 'Название (англ)')}
    ${field('description_ru', 'Описание (рус)', 'textarea', true)}${field('description_en', 'Описание (англ)', 'textarea', true)}
    ${field('tags_ru', 'Теги (рус, через запятую)')}${field('tags_en', 'Теги (англ, через запятую)')}
    <label>Категория<select name="category">${CATS.map(c => `<option value="${c}" ${d.category === c ? 'selected' : ''}>${CAT[c]}</option>`).join('')}</select></label>
    ${field('origin', 'Источник')}${field('date', 'Дата (ГГГГ-ММ-ДД)')}
    <div class="wide"><div class="note">Подсказки тегов (клик добавляет):</div><div class="tag-sugg">${tags.ru.slice(0, 40).map(t => `<button type="button" data-tag="ru" data-v="${esc(t)}">${esc(t)}</button>`).join('')}${tags.en.slice(0, 30).map(t => `<button type="button" data-tag="en" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>
    <div class="wide row"><button class="tb primary" type="submit">Сохранить (задача edit)</button><span class="note" id="saveNote"></span></div></form></section>
  <section class="panel"><h2>Пакеты</h2><div id="pk">…</div>
    <div class="row"><button class="tb" id="rebuildBtn">Пересобрать пакеты (из подготовленной сетки)</button><button class="tb" id="rebuildFullBtn">Переобработать из исходника</button>
      <button class="tb" id="statusBtn">${rec.status === 'published' ? 'Снять с публикации' : 'Опубликовать'}</button><a class="tb" href="#/textures/${esc(rec.slug)}">Заменить текстуры →</a><button class="tb danger" id="delBtn">Удалить из каталога</button></div>
    <div class="note">Все действия — задачи для воркера на сервере: он меняет catalog/, заливает модель и пакеты в PocketBase и пересобирает витрину.</div><div class="log" id="log" hidden></div></section>`;
  packagesTable(rec).then(h => { $('#pk', view).innerHTML = h; });
  const active = (await records('jobs', { filter: `model = "${slug}" && (status = "queued" || status = "running")`, sort: '-created', perPage: 1 })).items[0];
  if (active) { toast(`идёт ${active.type}…`); streamJob(active.id, $('#log', view), () => pageModel(slug)); }
  else if (glbOf(rec)) mountViewer($('#vhost', view), glbOf(rec)); else $('#vhost', view).innerHTML = '<div class="panel note">GLB ещё не залит</div>';
  const run = async (type, options) => { const j = await createJob(type, slug, options); streamJob(j.id, $('#log', view), () => pageModel(slug)); };
  $('#editForm', view).addEventListener('submit', async e => { e.preventDefault(); const fields = Object.fromEntries(new FormData(e.target).entries()); $('#saveNote', view).textContent = 'задача поставлена…'; await run('edit', { fields }); });
  view.addEventListener('click', async e => {
    const t = e.target.closest('[data-tag]'); if (t) { const inp = $(`input[name=tags_${t.dataset.tag}]`, view); const cur = inp.value.split(',').map(s => s.trim()).filter(Boolean); if (!cur.includes(t.dataset.v)) cur.push(t.dataset.v); inp.value = cur.join(', '); return; }
    if (e.target.id === 'rebuildBtn') run('rebuild', {});
    if (e.target.id === 'rebuildFullBtn') run('rebuild', { full: true });
    if (e.target.id === 'statusBtn') run('edit', { fields: { status: rec.status === 'published' ? 'draft' : 'published' } });
    if (e.target.id === 'delBtn') { if (!confirm(`Удалить ${slug} из каталога (catalog/, packages/ и PocketBase)?`)) return; const j = await createJob('delete', slug, {}); streamJob(j.id, $('#log', view), () => { location.hash = '#/models'; }); }
  });
}
async function tagSuggestions() { const ms = await allRecords('models', { fields: 'tags' }); const cnt = new Map(); for (const m of ms) for (const t of m.tags || []) cnt.set(t, (cnt.get(t) || 0) + 1); const sorted = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]); return { ru: sorted.filter(t => /[а-яё]/i.test(t)), en: sorted.filter(t => !/[а-яё]/i.test(t)) }; }

// ---------- drag-and-drop
async function filesFromDrop(dt) {
  const out = [];
  const walk = async (entry, prefix) => { if (entry.isFile) { const f = await new Promise(r => entry.file(r)); out.push(f); } else if (entry.isDirectory) { const reader = entry.createReader(); let batch; do { batch = await new Promise(r => reader.readEntries(r)); for (const en of batch) await walk(en, prefix + entry.name + '/'); } while (batch.length); } };
  for (const it of [...(dt.items || [])]) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) await walk(en, ''); }
  if (!out.length) for (const f of dt.files || []) out.push(f);
  return out;
}
function dropZone(el, onFiles) {
  const inp = el.querySelector('input'); el.addEventListener('click', () => inp.click()); inp.addEventListener('change', () => onFiles([...inp.files]));
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); }); el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', async e => { e.preventDefault(); el.classList.remove('over'); onFiles(await filesFromDrop(e.dataTransfer)); });
}
function renderDetect(host, files) {
  const d = detectMaps(files.map(f => ({ name: f.name, size: f.size })));
  host.innerHTML = `<div class="detect">${d.files.map(f => `<div class="${f.warn ? 'w' : ''}">${esc(f.name)} → ${f.kind ? `<b>${MAP_LABELS[f.kind]}</b> · набор «${esc(f.set)}»${f.directx ? ' · DirectX → будет перевёрнута' : ''}` : '—'}${f.warn ? ' ⚠ ' + esc(f.warn) : ''}</div>`).join('')}</div>` +
    (Object.keys(d.sets).length > 1 ? `<div class="warn-box">Наборов карт несколько (${Object.keys(d.sets).map(esc).join(', ')}): каждый ляжет на материал, в имени которого есть имя набора; остальные останутся с картами исходника.</div>` : '') +
    (d.warnings.length ? `<div class="warn-box">${d.warnings.map(esc).join('<br>')}</div>` : (files.length ? `<div class="note">Распознано ${d.files.filter(f => f.kind).length} карт в ${Object.keys(d.sets).length} набор(ах).</div>` : ''));
  return d;
}

// ---------- страница: новая модель
async function pageNew() {
  killViewer();
  const tags = await tagSuggestions(); const view = $('#view'); let srcFile = null, texFiles = [];
  view.innerHTML = `<section class="panel"><h2>Шаг 1 — исходник, текстуры и описание</h2>
    <div class="form">
      <div class="drop" id="dropSrc"><input type="file" accept=".blend,.fbx,.glb,.gltf,.obj"><b>Исходник</b><span>.blend / .fbx / .glb / .obj — перетащите сюда или кликните</span><span id="srcName" class="mono"></span></div>
      <div class="drop" id="dropTex"><input type="file" multiple webkitdirectory directory><b>Папка текстур</b><span>перетащите папку (или выберите) — карты определяются по именам файлов</span><span id="texCount" class="mono"></span></div>
      <div class="wide" id="detect"></div>
      <label>ID (латиница)<input name="id" placeholder="например HeadphonesHiPoly" required></label>
      <label>Категория<select name="category">${CATS.map(c => `<option value="${c}">${CAT[c]}</option>`).join('')}</select></label>
      <label>Название (рус)<input name="name_ru"></label><label>Название (англ)<input name="name_en"></label>
      <label class="wide">Описание (рус)<textarea name="description_ru"></textarea></label><label class="wide">Описание (англ)<textarea name="description_en"></textarea></label>
      <label>Теги (рус)<input name="tags_ru"></label><label>Теги (англ)<input name="tags_en"></label>
      <label>Источник<input name="origin" placeholder="скан / скульпт / Sketchfab …"></label><label>Дата<input name="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <div class="wide"><div class="note">Подсказки тегов:</div><div class="tag-sugg">${tags.ru.slice(0, 40).map(t => `<button type="button" data-tag="ru" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>
      <div class="wide row"><button class="tb primary" id="uploadBtn">Загрузить и посмотреть объекты</button><span class="note" id="upNote"></span></div>
    </div></section>
    <section class="panel" id="step2" hidden><h2>Шаг 2 — объекты и параметры</h2><div id="objs" class="chk"></div>
      <div class="row"><label class="small"><input type="checkbox" id="keepOrigin"> не центрировать (площадка/сцена)</label><label class="small"><input type="checkbox" id="noTd"> TD: реальный размер</label><label class="small">масштаб исходника <input id="scale" value="1" style="width:60px"></label><label class="small">пакеты <input id="platforms" value="td,depence,notch" style="width:140px"></label></div>
      <div class="row"><button class="tb primary" id="processBtn">Обработать</button><span class="note">воркер на сервере: Blender → сетка → карты → preview + GLB → три zip → проверка повторным импортом → заливка в PocketBase → витрина</span></div></section>
    <section class="panel" id="step3" hidden><h2>Шаг 3 — задача</h2><div class="log" id="log"></div></section>
    <section class="panel" id="step4" hidden><h2>Готово</h2><div class="stage"><div id="vhost"></div><div class="side"><div class="panel" id="tech"></div><div class="panel" id="pk"></div></div></div><div class="row"><a class="tb primary" id="toModel" href="#">Открыть карточку модели</a></div></section>`;
  dropZone($('#dropSrc', view), (files) => { srcFile = files.find(f => /\.(blend|fbx|glb|gltf|obj)$/i.test(f.name)) || files[0]; $('#srcName', view).textContent = srcFile ? `${srcFile.name} (${fmtB(srcFile.size)})` : ''; if (srcFile && !$('input[name=id]', view).value) $('input[name=id]', view).value = srcFile.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_\-]+/g, '_'); });
  dropZone($('#dropTex', view), (files) => { texFiles = files.filter(f => !/\.(blend|fbx|glb|gltf|obj)$/i.test(f.name)); $('#texCount', view).textContent = `${texFiles.length} файл(ов)`; renderDetect($('#detect', view), texFiles); });
  let inspectJob = null, id = null;
  view.addEventListener('click', async e => {
    const t = e.target.closest('[data-tag]'); if (t) { const inp = $('input[name=tags_ru]', view); const cur = inp.value.split(',').map(s => s.trim()).filter(Boolean); if (!cur.includes(t.dataset.v)) cur.push(t.dataset.v); inp.value = cur.join(', '); return; }
    if (e.target.id === 'uploadBtn') {
      if (!srcFile) return toast('нужен исходник'); id = $('input[name=id]', view).value.trim(); if (!id) return toast('нужен id');
      if (await modelBySlug(id) && !confirm(`Модель «${id}» уже есть — переобработать её?`)) return;
      const opts = { stage: 'inspect', id }; for (const k of EDIT) opts[k] = $(`[name=${k}]`, view).value;
      const fd = new FormData(); fd.append('source', srcFile, srcFile.name); for (const f of texFiles) fd.append('textures', f, f.name);
      $('#upNote', view).textContent = 'загрузка в PocketBase…'; e.target.disabled = true;
      try { inspectJob = await createJob('process', id, opts, fd); } catch (err) { $('#upNote', view).textContent = err.message; e.target.disabled = false; return; }
      $('#upNote', view).textContent = `задача ${inspectJob.id}: воркер читает список объектов…`; $('#step3', view).hidden = false;
      streamJob(inspectJob.id, $('#log', view), (rec) => {
        e.target.disabled = false; const ins = rec.result && rec.result.inspect; $('#step2', view).hidden = false;
        if (!ins) { $('#objs', view).innerHTML = '<div class="err">не удалось прочитать объекты; обработка возьмёт все видимые меши</div>'; return; }
        $('#objs', view).innerHTML = ins.objects.map(o => `<label><input type="checkbox" name="obj" value="${esc(o.name)}" ${o.hide_render || !o.in_scene ? '' : 'checked'}> ${esc(o.name)} · ${fmt(o.faces)} граней · мат.: ${esc(o.materials.join(', ') || '—')} · UV: ${o.uv.length}${o.colors ? ' · vcol ' + o.colors : ''}${o.modifiers.length ? ' · мод.: ' + o.modifiers.join(',') : ''}${o.hide_render ? ' · скрыт в рендере' : ''} · ${o.dims.join('×')}</label>`).join('') || '<div class="err">мешей нет</div>';
        $('#upNote', view).textContent = `объектов: ${ins.objects.length}, картинок в файле: ${(ins.images || []).length}. Отметьте, что брать, и нажмите «Обработать».`;
      });
    }
    if (e.target.id === 'processBtn') {
      if (!inspectJob) return; const objects = [...view.querySelectorAll('input[name=obj]:checked')].map(i => i.value);
      const opts = { fromJob: inspectJob.id, id, objects, keepOrigin: $('#keepOrigin', view).checked, noTdNormalize: $('#noTd', view).checked, scale: $('#scale', view).value, platforms: $('#platforms', view).value };
      for (const k of EDIT) opts[k] = $(`[name=${k}]`, view).value;
      const j = await createJob('process', id, opts); e.target.disabled = true; $('#step3', view).hidden = false;
      streamJob(j.id, $('#log', view), async (rec) => {
        e.target.disabled = false; if (rec.status !== 'done') { toast('обработка не удалась — смотрите лог'); return; }
        const m = await modelBySlug(id); $('#step4', view).hidden = false; $('#tech', view).innerHTML = techTable(m.data || {}); $('#pk', view).innerHTML = await packagesTable(m); $('#toModel', view).href = `#/model/${id}`;
        await mountViewer($('#vhost', view), glbOf(m)); $('#step4', view).scrollIntoView({ behavior: 'smooth' });
      });
    }
  });
}

// ---------- страница: текстуры
async function pageTextures(pre) {
  killViewer();
  const models = await allRecords('models', { sort: 'slug', fields: 'id,slug,name_ru,data' }); const view = $('#view'); let texFiles = [];
  view.innerHTML = `<section class="panel"><h2>Текстуры: заменить или добавить карты, переупаковать только пакеты (сетка не трогается)</h2>
    <div class="row"><label class="small">Модель <select id="selModel" class="in" style="width:auto"><option value="">—</option>${models.map(m => `<option value="${esc(m.slug)}" ${m.slug === pre ? 'selected' : ''}>${esc(m.name_ru || m.slug)} (${esc(m.slug)})</option>`).join('')}</select></label>
    <label class="small">пакеты <input id="platforms" class="in" value="td,depence,notch" style="width:140px"></label><label class="small"><input type="checkbox" id="keepReused" checked> не трогать пакеты «из готового экспорта»</label></div>
    <div id="cur"></div>
    <div class="drop" id="dropTex"><input type="file" multiple webkitdirectory directory><b>Новые карты</b><span>папка или файлы: basecolor/albedo, normal (_dx → перевернётся), roughness, metallic, ao, orm</span><span id="texCount" class="mono"></span></div>
    <div id="detect"></div><div class="row"><button class="tb primary" id="repackBtn" disabled>Переупаковать</button></div><div class="log" id="log" hidden></div></section>
    <section class="panel" id="after" hidden><h2>Результат</h2><div class="stage"><div id="vhost"></div><div class="side"><div class="panel" id="tech"></div></div></div></section>`;
  const showCur = () => {
    const slug = $('#selModel', view).value; const cur = $('#cur', view); const m = models.find(x => x.slug === slug); if (!m) { cur.innerHTML = ''; return; }
    const d = m.data || {};
    cur.innerHTML = `<div class="note">Текущие карты: ${(d.texture_maps || []).map(t => `<b>${esc(t.material)}</b> · ${t.type} ${t.width}×${t.height}`).join('; ') || 'карт нет — материал задан константами'}</div><div class="note">Материалы: ${(d.materials || []).map(x => `<b>${esc(x.name)}</b>`).join(', ')}. Если наборов карт несколько, имя набора в файле должно входить в имя материала.</div>`;
    $('#repackBtn', view).disabled = !texFiles.length;
  };
  $('#selModel', view).addEventListener('change', showCur); showCur();
  dropZone($('#dropTex', view), (files) => { texFiles = files; $('#texCount', view).textContent = `${files.length} файл(ов)`; renderDetect($('#detect', view), files); $('#repackBtn', view).disabled = !files.length || !$('#selModel', view).value; });
  $('#repackBtn', view).addEventListener('click', async e => {
    const slug = $('#selModel', view).value; const fd = new FormData(); for (const f of texFiles) fd.append('textures', f, f.name);
    e.target.disabled = true; const j = await createJob('textures', slug, { platforms: $('#platforms', view).value, keepReused: $('#keepReused', view).checked }, fd);
    streamJob(j.id, $('#log', view), async (rec) => { e.target.disabled = false; if (rec.status !== 'done') return toast('переупаковка не удалась'); const m = await modelBySlug(slug); $('#after', view).hidden = false; $('#tech', view).innerHTML = techTable(m.data || {}); await mountViewer($('#vhost', view), glbOf(m)); });
  });
}

// ---------- страница: задачи
async function pageJobs() {
  killViewer();
  const jobs = (await records('jobs', { sort: '-created', perPage: 50 })).items; const view = $('#view');
  view.innerHTML = `<section class="panel"><h2>Задачи воркера (последние 50)</h2><table class="table"><tr><th>Когда</th><th>Тип</th><th>Модель</th><th>Статус</th><th></th></tr>${jobs.map(j => `<tr><td class="mono small">${esc(j.created.slice(0, 19).replace('T', ' '))}</td><td>${esc(j.type)}</td><td>${esc(j.model)}</td><td><span class="status ${j.status}">${j.status}</span></td><td><button class="tb small" data-job="${j.id}">лог</button>${j.status === 'queued' ? ` <button class="tb small danger" data-cancel="${j.id}">снять</button>` : ''}</td></tr>`).join('')}</table><div class="log" id="log" hidden></div>
    ${jobs.some(j => j.status === 'queued') ? '<div class="warn-box">Есть задачи в «queued»: если они не берутся в работу, воркер не запущен (<code>npm run worker</code> / служба catalog-worker).</div>' : ''}</section>`;
  view.addEventListener('click', async e => { const b = e.target.closest('[data-job]'); if (b) streamJob(b.dataset.job, $('#log', view)); const c = e.target.closest('[data-cancel]'); if (c) { await api(`/api/collections/jobs/records/${c.dataset.cancel}`, { method: 'PATCH', body: { status: 'failed', log: 'снята вручную' } }); pageJobs(); } });
}

// ---------- страница: пользователи
async function pageUsers() {
  killViewer();
  const users = await allRecords('users', { sort: 'email' }); const view = $('#view');
  view.innerHTML = `<section class="panel"><h2>Пользователи: кто может скачивать пакеты (staff) и управлять каталогом (owner)</h2>
    <table class="table"><tr><th>Почта</th><th>Роль</th><th>Создан</th><th></th></tr>${users.map(u => `<tr><td>${esc(u.email)}</td><td><select class="in" style="width:auto" data-role="${u.id}"><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>staff</option><option value="owner" ${u.role === 'owner' ? 'selected' : ''}>owner</option></select></td><td class="mono small">${esc(u.created.slice(0, 10))}</td><td>${u.id === auth.user.id ? '<span class="note">это вы</span>' : `<button class="tb small danger" data-del="${u.id}" data-email="${esc(u.email)}">удалить</button>`}</td></tr>`).join('')}</table>
    <form class="row" id="addUser"><input class="in" name="email" type="email" placeholder="почта коллеги" required style="width:280px"><select class="in" name="role" style="width:auto"><option value="staff">staff</option><option value="owner">owner</option></select><button class="tb primary">Добавить</button></form>
    <div class="note">Регистрации на витрине нет: пользователь появляется только здесь. Для входа он запрашивает код на свою почту. Удаление пользователя сразу закрывает ему скачивание.</div></section>`;
  $('#addUser', view).addEventListener('submit', async e => { e.preventDefault(); const fd = new FormData(e.target); const pw = crypto.randomUUID(); try { await api('/api/collections/users/records', { method: 'POST', body: { email: fd.get('email'), password: pw, passwordConfirm: pw, role: fd.get('role'), verified: true, emailVisibility: false } }); toast('добавлен'); pageUsers(); } catch (err) { toast('ошибка: ' + JSON.stringify(err.data && err.data.data || err.message)); } });
  view.addEventListener('change', async e => { const s = e.target.closest('[data-role]'); if (s) { await api(`/api/collections/users/records/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }); toast('роль обновлена'); } });
  view.addEventListener('click', async e => { const b = e.target.closest('[data-del]'); if (b && confirm(`Удалить ${b.dataset.email}?`)) { await api(`/api/collections/users/records/${b.dataset.del}`, { method: 'DELETE' }); pageUsers(); } });
}

// ---------- роутер + проверка роли
async function route() {
  await refresh();
  const view = $('#view');
  if (!auth.user || auth.user.role !== 'owner') {
    view.innerHTML = `<section class="panel gate"><h3>Только для владельца каталога</h3><div class="note">${auth.user ? `Вы вошли как ${esc(auth.user.email)} (роль ${esc(auth.user.role || 'staff')}), кабинет доступен роли owner.` : 'Войдите по коду из письма.'}</div>${auth.user ? '<button class="tb" id="logoutBtn">Выйти</button>' : '<button class="tb primary" id="loginBtn">Войти</button>'}</section>`;
    return;
  }
  const h = location.hash || '#/models'; const parts = h.slice(2).split('/');
  document.querySelectorAll('#tabs a').forEach(a => a.setAttribute('aria-pressed', String(a.getAttribute('href') === '#/' + parts[0] || (parts[0] === 'model' && a.getAttribute('href') === '#/models'))));
  if (parts[0] === 'models') return pageModels();
  if (parts[0] === 'model') return pageModel(decodeURIComponent(parts[1]));
  if (parts[0] === 'new') return pageNew();
  if (parts[0] === 'textures') return pageTextures(parts[1] ? decodeURIComponent(parts[1]) : '');
  if (parts[0] === 'jobs') return pageJobs();
  if (parts[0] === 'users') return pageUsers();
  location.hash = '#/models';
}
window.addEventListener('hashchange', route); document.addEventListener('pb-auth', route); route();
