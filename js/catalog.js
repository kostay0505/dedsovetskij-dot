// Главная витрины: поиск, фасеты, сортировка, состояние в URL, карточки.
import MiniSearch from '../vendor/minisearch/index.js?v=mvf765ag';
import { CatalogSearch, highlight, CATEGORY_LABELS, PLATFORM_LABELS } from './search.js?v=mvf765ag';
import { termVariants } from './translit.js?v=mvf765ag';

const $ = (s) => document.querySelector(s);
const fmt = (n) => (n || 0).toLocaleString('ru-RU');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const [index, models, synonyms] = await Promise.all(['search-index.json', 'models.json', 'synonyms.json'].map(u => fetch(u).then(r => r.json())));
const engine = new CatalogSearch(MiniSearch, index, models, synonyms);
window.__catalog = { engine, models }; // для отладки и тестов из консоли

const facets = { platform: new Set(), category: new Set(), tag: new Set() };
const state = { q: '', sort: 'relevance' };

function readURL() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || ''; state.sort = p.get('sort') || 'relevance';
  for (const g of Object.keys(facets)) facets[g] = new Set((p.get(g) || '').split(',').filter(Boolean));
  $('#q').value = state.q; $('#sort').value = state.sort;
}
function writeURL() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q); if (state.sort !== 'relevance') p.set('sort', state.sort);
  for (const g of Object.keys(facets)) if (facets[g].size) p.set(g, [...facets[g]].join(','));
  const url = location.pathname + (p.toString() ? '?' + p.toString() : '');
  history.replaceState(null, '', url);
}

function chip(group, value, label, count, pressed, extra = '') {
  return `<button class="chip ${extra}" data-g="${group}" data-v="${esc(value)}" aria-pressed="${pressed}" ${count === 0 && !pressed ? 'disabled' : ''}>${esc(label)}<span class="n">${count}</span></button>`;
}

function render() {
  const res = engine.run(state.q, facets, state.sort);
  const { items, parsed } = res;
  const words = [...new Set(items.flatMap(i => i.terms).concat(parsed.words.flatMap(w => engine.expandWord(w))))];
  // карточки
  const box = $('#cards'); box.innerHTML = items.map(({ model: m }) => {
    const badges = ['td', 'depence', 'notch'].map(k => { const p = (m.platforms || {})[k]; const cls = !p ? '' : p.drive_url ? ' on' : ' pending'; const t = !p ? 'пакет не собран' : p.drive_url ? 'пакет на Диске' : 'пакет собран, на Диск ещё не выложен'; return `<span class="badge${cls}" title="${t}">${k.toUpperCase()}</span>`; }).join('');
    return `<a class="card" href="models/${esc(m.id)}.html" data-id="${esc(m.id)}">
      <img src="${esc(m.preview)}" alt="" loading="lazy">
      <div class="body"><div class="name">${highlight(m.name_ru, words)}</div><div class="name-en">${highlight(m.name_en, words)}</div>
      <div class="meta"><span class="mono">${fmt(m.polys)} тр.</span><span>${esc(CATEGORY_LABELS[m.category] || m.category)}</span></div>
      <div class="badges">${badges}</div></div></a>`;
  }).join('');
  // пусто
  const empty = $('#empty'); empty.hidden = items.length > 0;
  if (!items.length) {
    const active = Object.values(facets).some(s => s.size) || parsed.ops.length;
    empty.innerHTML = `<div>Ничего не найдено${state.q ? ' по запросу «' + esc(state.q) + '»' : ''}.</div>` +
      (res.suggestions.length ? `<div class="note">Может быть, вы искали:</div><div class="sugg">${res.suggestions.map(s => `<button class="chip small" data-sugg="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : '') +
      (active ? `<div class="sugg"><button class="chip small" id="clearAll">снять фильтры и операторы</button></div>` : '') +
      `<div class="note">Попробуйте «бюст», «skull», «растение», <code>tag:скан</code>, <code>polys&lt;50k</code>, <code>platform:depence</code>.</div>`;
  }
  // фасеты
  const f = res.facets;
  let html = `<span class="lbl">Платформа</span>` + ['td', 'depence', 'notch'].map(k => chip('platform', k, PLATFORM_LABELS[k], f.platform.get(k) || 0, facets.platform.has(k))).join('');
  const cats = [...new Set(models.map(m => m.category || 'other'))].sort((a, b) => (f.category.get(b) || 0) - (f.category.get(a) || 0));
  html += `<span class="lbl gap">Категория</span>` + cats.map(c => chip('category', c, CATEGORY_LABELS[c] || c, f.category.get(c) || 0, facets.category.has(c))).join('');
  $('#facets').innerHTML = html;
  const tags = [...f.tag.entries()].filter(([t, n]) => n > 0 || facets.tag.has(t)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  const shown = tags.slice(0, 28).concat(tags.slice(28).filter(([t]) => facets.tag.has(t)));
  $('#tagFacets').innerHTML = shown.length ? `<span class="lbl">Теги</span>` + shown.map(([t, n]) => chip('tag', t, t, n, facets.tag.has(t), 'small')).join('') : '';
  // счётчики
  $('#stats').innerHTML = `<span>${items.length} из ${res.total} ${plural(res.total)}${parsed.words.length ? ' · по запросу' : ''}${parsed.ops.length ? ' · операторы: ' + parsed.ops.map(o => '<code>' + esc(o.raw) + '</code>').join(' ') : ''}</span>` +
    (parsed.errors.length ? `<span class="err">${parsed.errors.map(esc).join('; ')}</span>` : '');
  writeURL();
}
const plural = (n) => (n % 10 === 1 && n % 100 !== 11) ? 'модель' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? 'модели' : 'моделей';

let timer; $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = $('#q').value.trim(); render(); }, 120); });
$('#q').addEventListener('keydown', e => { if (e.key === 'Escape') { $('#q').value = ''; state.q = ''; render(); } });
$('#sort').addEventListener('change', () => { state.sort = $('#sort').value; render(); });
$('#clear').addEventListener('click', () => { $('#q').value = ''; state.q = ''; state.sort = 'relevance'; $('#sort').value = 'relevance'; for (const g in facets) facets[g].clear(); render(); });
document.addEventListener('click', e => {
  const ch = e.target.closest('.chip[data-g]'); if (ch) { const set = facets[ch.dataset.g]; set.has(ch.dataset.v) ? set.delete(ch.dataset.v) : set.add(ch.dataset.v); render(); return; }
  const sg = e.target.closest('[data-sugg]'); if (sg) { $('#q').value = sg.dataset.sugg; state.q = sg.dataset.sugg; render(); return; }
  if (e.target.id === 'clearAll') { $('#clear').click(); }
});
window.addEventListener('popstate', () => { readURL(); render(); });
readURL(); render();
