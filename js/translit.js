// Транслит в обе стороны: русская раскладка запроса ↔ латиница в данных и наоборот.
const RU = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const LAT = [['shch', 'щ'], ['sch', 'щ'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'], ['yu', 'ю'], ['ju', 'ю'], ['ya', 'я'], ['ja', 'я'], ['yo', 'ё'], ['jo', 'ё'], ['ye', 'е'], ['ck', 'к'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'], ['z', 'з'], ['i', 'и'], ['y', 'й'], ['j', 'й'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'к'], ['x', 'кс'], ['w', 'в'], ['q', 'к']];

export function ru2lat(s) {
  let out = '';
  for (const ch of s.toLowerCase()) out += ch in RU ? RU[ch] : ch;
  return out;
}

export function lat2ru(s) {
  s = s.toLowerCase(); let out = ''; let i = 0;
  while (i < s.length) {
    let hit = null;
    for (const [l, r] of LAT) { if (s.startsWith(l, i)) { hit = [l, r]; break; } }
    if (hit) { out += hit[1]; i += hit[0].length; } else { out += s[i]; i++; }
  }
  return out;
}

export const isCyrillic = (s) => /[а-яё]/i.test(s);
export const isLatin = (s) => /[a-z]/i.test(s);

/** Варианты одного слова запроса: само слово + транслит в другую сторону (+ «h» вместо «kh»). */
export function termVariants(term) {
  const v = new Set([term]);
  if (isCyrillic(term)) { const t = ru2lat(term); v.add(t); v.add(t.replace(/kh/g, 'h').replace(/ts/g, 'c')); }
  else if (isLatin(term)) v.add(lat2ru(term));
  return [...v].filter(Boolean);
}
