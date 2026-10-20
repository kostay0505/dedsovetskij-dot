// Определение типа карты по имени файла (та же логика, что в pipeline/process.py → detect_maps).
export const MAP_PATTERNS = [
  ['Normal', /(normal|nrm|nor|_n$|_nm$|_norm)/],
  ['Roughness', /(rough|rgh|_r$|_rough)/],
  ['Metallic', /(metal|mtl|_m$|metallic|metalness)/],
  ['AO', /(^ao$|_ao$|occlusion|ambient)/],
  ['ORM', /(_orm$|_arm$|occlusionroughnessmetallic)/],
  ['Emissive', /(emiss|emit|_e$|glow)/],
  ['Alpha', /(opacity|alpha|_mask$|transparen)/],
  ['BaseColor', /(basecolor|base_color|albedo|diffuse|diff|_col$|color|colour|_bc$|_d$|_c$)/],
];
export const IMG_EXT = ['.png', '.jpg', '.jpeg', '.tga', '.tif', '.tiff', '.bmp', '.exr', '.webp'];
export const MAP_LABELS = { BaseColor: 'Base Color (albedo)', Normal: 'Normal', Roughness: 'Roughness', Metallic: 'Metallic', AO: 'AO', ORM: 'ORM (packed)', Emissive: 'Emissive', Alpha: 'Alpha / opacity' };

/** names: [{name, size?}] → {sets:{setName:{kind:{name,directx}}}, warnings:[], files:[{name,kind,set,directx,warn}]} */
export function detectMaps(files) {
  const sets = {}; const warnings = []; const out = [];
  for (const f of files) {
    const name = f.name; const dot = name.lastIndexOf('.'); const stem = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
    const row = { name, size: f.size, kind: null, set: null, directx: false, warn: null };
    out.push(row);
    if (!IMG_EXT.includes(ext)) { row.warn = 'не картинка, будет пропущен'; warnings.push(`${name}: ${row.warn}`); continue; }
    const low = stem.toLowerCase(); let kind = null, m = null;
    for (const [k, re] of MAP_PATTERNS) { m = low.match(re); if (m) { kind = k; break; } }
    if (!kind) { row.warn = 'тип карты по имени не распознан (ожидаю basecolor/albedo, normal, roughness, metallic, ao)'; warnings.push(`${name}: ${row.warn}`); continue; }
    const setName = low.slice(0, m.index).replace(/[_\-. ]+$/, '') || low.slice(m.index + m[0].length).replace(/^[_\-. ]+/, '') || 'default';
    row.kind = kind; row.set = setName; row.directx = kind === 'Normal' && /(_dx|directx|_d3d)/.test(low);
    const entry = sets[setName] || (sets[setName] = {});
    if (entry[kind]) { row.warn = `карта ${kind} для набора «${setName}» уже есть (${entry[kind].name}), будет взята первая`; warnings.push(`${name}: ${row.warn}`); continue; }
    entry[kind] = { name, directx: row.directx };
  }
  for (const [s, e] of Object.entries(sets)) if (!e.BaseColor && !e.ORM && !e.Normal) warnings.push(`набор «${s}»: нет ни BaseColor, ни Normal`);
  return { sets, warnings, files: out };
}
