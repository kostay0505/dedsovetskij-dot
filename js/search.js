// Поисковый движок витрины: MiniSearch + операторы + синонимы + транслит + фасеты.
// Без DOM — тот же код гоняется в Node для TESTLOG (scripts/search_test.mjs).
import { termVariants, ru2lat, lat2ru } from './translit.js?v=mvgmh7kp';

export const SEARCH_FIELDS = ['id', 'name_ru', 'name_en', 'description_ru', 'description_en', 'tags', 'origin', 'category', 'tr'];
export const BOOST = { id: 3, name_ru: 5, name_en: 5, tags: 3, category: 2, origin: 1, description_ru: 1, description_en: 1, tr: 2 };
export const CATEGORY_LABELS = { scan: 'скан', sculpt: 'скульпт', hardsurface: 'hard surface', architecture: 'архитектура', botany: 'ботаника', fractal: 'фрактал', other: 'другое' };
export const PLATFORM_LABELS = { td: 'TouchDesigner', depence: 'Depence', notch: 'Notch' };

/** Документ для индекса из model.json (то, что кладётся в search-index.json). */
export function toDoc(m) {
  const tags = [...(m.tags_ru || []), ...(m.tags_en || [])];
  const ru = [m.name_ru, ...(m.tags_ru || []), m.description_ru, m.origin].filter(Boolean).join(' ');
  const en = [m.name_en, ...(m.tags_en || []), m.id].filter(Boolean).join(' ');
  return {
    id: m.id, name_ru: m.name_ru || '', name_en: m.name_en || '', description_ru: m.description_ru || '', description_en: m.description_en || '',
    tags: tags.join(' '), origin: m.origin || '', category: m.category || 'other',
    tr: ru2lat(ru) + ' ' + lat2ru(en),
  };
}

export function miniSearchOptions() {
  return {
    fields: SEARCH_FIELDS, storeFields: ['id'],
    tokenize: (s) => s.toLowerCase().split(/[\s,.;:()«»"'\/\\\-–—+|]+/u).filter(Boolean),
    processTerm: (t) => t.toLowerCase().replace(/ё/g, 'е'),
    searchOptions: { prefix: true, fuzzy: (t) => (t.length >= 5 ? 0.2 : false), boost: BOOST, combineWith: 'AND' },
  };
}

// ---------- операторы
// tag:скан  platform:depence  category:scan  uv:yes|no  polys<50k  polys>10k  polys>=1000  date>2026-10  date<2026-10-10
const OP_RE = /^(tag|platform|category|uv|cat|p):(.+)$/i;
const NUM_RE = /^(polys|tris|verts)\s*(<=|>=|<|>|=)\s*(\d+(?:[.,]\d+)?)\s*(k|к|m|м)?$/i;
const DATE_RE = /^date\s*(<=|>=|<|>|=)\s*(\d{4}(?:-\d{2})?(?:-\d{2})?)$/i;

export function parseQuery(q) {
  const ops = []; const words = []; const errors = [];
  const tokens = (q || '').match(/"[^"]*"|\S+/g) || [];
  for (let t of tokens) {
    t = t.replace(/^"|"$/g, '');
    let m;
    if ((m = t.match(NUM_RE))) {
      const mult = /k|к/i.test(m[4] || '') ? 1000 : /m|м/i.test(m[4] || '') ? 1e6 : 1;
      ops.push({ k: m[1].toLowerCase() === 'verts' ? 'verts' : 'polys', op: m[2], v: parseFloat(m[3].replace(',', '.')) * mult, raw: t });
    } else if ((m = t.match(DATE_RE))) ops.push({ k: 'date', op: m[1], v: m[2], raw: t });
    else if ((m = t.match(OP_RE))) {
      let k = m[1].toLowerCase(); if (k === 'cat') k = 'category'; if (k === 'p') k = 'platform';
      ops.push({ k, v: m[2].toLowerCase().replace(/ё/g, 'е'), raw: t });
    } else if (/^(polys|tris|verts|date|tag|platform|category|uv)[:<>=]/i.test(t)) errors.push(`не понял оператор «${t}»`);
    else words.push(t.toLowerCase());
  }
  return { ops, words, errors };
}

function cmp(a, op, b) {
  switch (op) { case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b; default: return a === b; }
}

export function opsMatch(m, ops) {
  for (const o of ops) {
    if (o.k === 'polys' && !cmp(m.polys || 0, o.op, o.v)) return false;
    if (o.k === 'verts' && !cmp(m.verts || 0, o.op, o.v)) return false;
    if (o.k === 'date') { const d = (m.date || '').slice(0, o.v.length); if (!cmp(d, o.op, o.v)) return false; }
    if (o.k === 'platform') { const p = m.platforms || {}; const key = o.v === 'touchdesigner' ? 'td' : o.v; if (!p[key]) return false; }
    if (o.k === 'category') { const c = (m.category || 'other').toLowerCase(); const lbl = (CATEGORY_LABELS[c] || '').toLowerCase(); if (c !== o.v && lbl !== o.v && !c.startsWith(o.v) && !lbl.startsWith(o.v)) return false; }
    if (o.k === 'uv') { const yes = /^(yes|да|1|true)$/i.test(o.v); if (((m.uv_layers || 0) > 0) !== yes) return false; }
    if (o.k === 'tag') {
      const tags = [...(m.tags_ru || []), ...(m.tags_en || [])].map(t => t.toLowerCase().replace(/ё/g, 'е'));
      const vars = termVariants(o.v);
      if (!tags.some(t => vars.some(v => t === v || t.startsWith(v) || t.includes(v)))) return false;
    }
  }
  return true;
}

export function facetMatch(m, facets) {
  if (facets.platform && facets.platform.size && ![...facets.platform].every(k => (m.platforms || {})[k])) return false;
  if (facets.category && facets.category.size && !facets.category.has(m.category || 'other')) return false;
  if (facets.tag && facets.tag.size) {
    const tags = new Set([...(m.tags_ru || []), ...(m.tags_en || [])].map(t => t.toLowerCase()));
    if (![...facets.tag].every(t => tags.has(t))) return false;
  }
  return true;
}

export class CatalogSearch {
  /** @param MiniSearch конструктор MiniSearch; index — сериализованный индекс или null; models — массив model.json; synonyms — объект */
  constructor(MiniSearch, index, models, synonyms) {
    this.MiniSearch = MiniSearch;
    this.models = models; this.byId = new Map(models.map(m => [m.id, m]));
    this.ms = index ? MiniSearch.loadJSON(typeof index === 'string' ? index : JSON.stringify(index), miniSearchOptions()) : new MiniSearch(miniSearchOptions());
    if (!index) this.ms.addAll(models.map(toDoc));
    this.syn = buildSynonyms(synonyms || {});
  }

  /** Варианты слова: свои (с префиксом) и из синонимов (точные, без префикса — иначе «авто» ловит «автоматическая»). */
  expandWord(w) {
    const own = new Set(termVariants(w));
    const key = w.replace(/ё/g, 'е'); const syn = new Set();
    for (const s of this.syn.get(key) || []) for (const v of termVariants(s)) if (!own.has(v)) syn.add(v);
    return [...own, ...syn];
  }
  wordQuery(w) {
    const own = new Set(termVariants(w)); const all = this.expandWord(w);
    const node = (v, prefix) => (v.includes(' ') ? { combineWith: 'AND', queries: v.split(' '), prefix } : { queries: [v], prefix, combineWith: 'OR' });
    return { combineWith: 'OR', queries: all.map(v => node(v, own.has(v))) };
  }

  /** Полный поиск. Возвращает {items:[{model, score, terms}], facets, parsed, suggestions} */
  run(q, facets = {}, sort = 'relevance') {
    const parsed = parseQuery(q);
    let scored;
    if (parsed.words.length) {
      const query = { combineWith: 'AND', queries: parsed.words.map(w => this.wordQuery(w)) };
      const res = this.ms.search(query);
      scored = res.map(r => ({ model: this.byId.get(r.id), score: r.score, terms: r.terms })).filter(x => x.model);
    } else scored = this.models.map(m => ({ model: m, score: 0, terms: [] }));
    const base = scored.filter(x => opsMatch(x.model, parsed.ops));
    const items = base.filter(x => facetMatch(x.model, facets));
    sortItems(items, sort, parsed.words.length > 0);
    const facetCounts = {};
    for (const g of ['platform', 'category', 'tag']) {
      const other = { ...facets, [g]: new Set() };
      const pool = base.filter(x => facetMatch(x.model, other));
      const counts = new Map();
      for (const { model: m } of pool) {
        if (g === 'platform') for (const k of ['td', 'depence', 'notch']) if ((m.platforms || {})[k]) counts.set(k, (counts.get(k) || 0) + 1);
        if (g === 'category') { const c = m.category || 'other'; counts.set(c, (counts.get(c) || 0) + 1); }
        if (g === 'tag') for (const t of new Set((m.tags_ru || []).map(t => t.toLowerCase()))) counts.set(t, (counts.get(t) || 0) + 1);
      }
      facetCounts[g] = counts;
    }
    let suggestions = [];
    if (!items.length && parsed.words.length) {
      try { suggestions = this.ms.autoSuggest(parsed.words.join(' '), { prefix: true, fuzzy: 0.3 }).slice(0, 6).map(s => s.suggestion); } catch { suggestions = []; }
    }
    return { items, facets: facetCounts, parsed, suggestions, total: this.models.length };
  }
}

export function sortItems(items, sort, hasQuery) {
  const by = {
    relevance: (a, b) => (b.score - a.score) || a.model.name_ru.localeCompare(b.model.name_ru, 'ru'),
    name: (a, b) => a.model.name_ru.localeCompare(b.model.name_ru, 'ru'),
    date: (a, b) => (b.model.date || '').localeCompare(a.model.date || '') || a.model.name_ru.localeCompare(b.model.name_ru, 'ru'),
    polys_asc: (a, b) => (a.model.polys || 0) - (b.model.polys || 0),
    polys_desc: (a, b) => (b.model.polys || 0) - (a.model.polys || 0),
  };
  const f = by[sort] || (hasQuery ? by.relevance : by.name);
  items.sort(f);
  return items;
}

function buildSynonyms(syn) {
  const map = new Map();
  const add = (k, v) => { k = k.toLowerCase().replace(/ё/g, 'е'); if (!map.has(k)) map.set(k, new Set()); map.get(k).add(v.toLowerCase()); };
  for (const [k, vals] of Object.entries(syn)) {
    if (k.startsWith('_')) continue;
    for (const v of vals) { add(k, v); add(v, k); }
  }
  return map;
}

/** Подсветка найденных слов: оборачивает совпадения в <mark>. text — чистый текст, terms — слова из результата + слова запроса. */
export function highlight(text, terms) {
  if (!text) return '';
  const esc = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const list = [...new Set((terms || []).filter(t => t && t.length > 1))].sort((a, b) => b.length - a.length);
  if (!list.length) return esc(text);
  const re = new RegExp('(' + list.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'giu');
  return text.split(re).map((part, i) => (i % 2 ? '<mark>' + esc(part) + '</mark>' : esc(part))).join('');
}
