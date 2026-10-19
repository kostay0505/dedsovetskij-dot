// Вход по коду из письма (PocketBase OTP) и скачивание пакетов по файловому токену.
// Витрину отдаёт сам PocketBase, поэтому API — на том же origin. Для локального просмотра через другой порт
// можно задать <meta name="pb-url" content="http://127.0.0.1:8090">.
export const PB_URL = (document.querySelector('meta[name=pb-url]')?.content || location.origin).replace(/\/$/, '');
// Статическая витрина (сборка --static, напр. GitHub Pages): сервера нет — ни входа, ни скачивания, только просмотр.
export const STATIC = !!document.querySelector('meta[name=catalog-static]');
const KEY = 'pb_auth';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const auth = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
  set(v) { const before = JSON.stringify(this.get()); try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch {} if (JSON.stringify(v) !== before) document.dispatchEvent(new CustomEvent('pb-auth', { detail: v })); },
  get token() { return (this.get() || {}).token || ''; },
  get user() { return (this.get() || {}).record || null; },
  get isOwner() { return !!this.user && this.user.role === 'owner'; },
};

export async function api(path, { method = 'GET', body, auth: useAuth = true, form = false } = {}) {
  const headers = {}; if (useAuth && auth.token) headers.Authorization = auth.token; if (body && !form) headers['content-type'] = 'application/json';
  const r = await fetch(PB_URL + path, { method, headers, body: body == null ? undefined : form ? body : JSON.stringify(body) });
  const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) { const e = new Error((data && data.message) || r.statusText); e.status = r.status; e.data = data; throw e; }
  return data;
}

/** Проверить сохранённый токен (и обновить запись пользователя). */
export async function refresh() {
  if (!auth.token) return null;
  try { const d = await api('/api/collections/users/auth-refresh', { method: 'POST' }); auth.set({ token: d.token, record: d.record }); return d.record; }
  catch (e) { if (e.status === 401 || e.status === 403 || e.status === 404) auth.set(null); return null; }
}
export async function requestOtp(email) { return api('/api/collections/users/request-otp', { method: 'POST', body: { email }, auth: false }); }
export async function loginOtp(otpId, code) { const d = await api('/api/collections/users/auth-with-otp', { method: 'POST', body: { otpId, password: code }, auth: false }); auth.set({ token: d.token, record: d.record }); return d.record; }
export function logout() { auth.set(null); }
export async function fileToken() { return (await api('/api/files/token', { method: 'POST' })).token; }
export function fileUrl(collection, id, filename, token) { return `${PB_URL}/api/files/${collection}/${id}/${encodeURIComponent(filename)}${token ? '?token=' + token : ''}`; }

// ---------- окно входа
let dlg = null;
export function openLogin(note = '') {
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.className = 'login'; document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  }
  let otpId = null;
  const render = (step, msg = '') => {
    dlg.innerHTML = `<form method="dialog" class="panel login-form"><h3>Вход для сотрудников</h3>
      <div class="note">${esc(note || 'Код придёт на почту, которая есть в списке студии. Регистрации нет — доступ выдаёт владелец каталога.')}</div>
      ${step === 1 ? `<label>Почта<input name="email" type="email" required autocomplete="email" placeholder="you@studio.ru"></label>` : `<label>Код из письма<input name="code" inputmode="numeric" pattern="[0-9]{4,8}" required autocomplete="one-time-code" placeholder="6 цифр"></label>`}
      ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
      <div class="tb-row"><button class="tb primary" value="go">${step === 1 ? 'Получить код' : 'Войти'}</button><button class="tb" value="cancel" formnovalidate>Отмена</button>${step === 2 ? '<button class="tb" value="back" formnovalidate>Другая почта</button>' : ''}</div></form>`;
    const form = dlg.querySelector('form'); setTimeout(() => dlg.querySelector('input')?.focus(), 0);
    form.addEventListener('submit', async (e) => {
      const v = e.submitter && e.submitter.value; if (v === 'cancel') return; e.preventDefault();
      if (v === 'back') return render(1);
      try {
        if (step === 1) { const email = form.email.value.trim(); otpId = (await requestOtp(email)).otpId; render(2); }
        else { await loginOtp(otpId, form.code.value.trim()); dlg.close(); }
      } catch (err) { render(step, err.status === 400 ? 'Код не подошёл или устарел — запросите новый.' : (err.message || 'ошибка')); }
    });
  };
  render(1); if (!dlg.open) dlg.showModal();
}

// ---------- шапка: кто вошёл
export function renderAuthBox() {
  const box = document.getElementById('authBox'); if (!box) return;
  if (STATIC) { box.innerHTML = ''; return; }
  const u = auth.user;
  const base = document.querySelector('script[src$="js/auth.js"]')?.getAttribute('src').replace(/js\/auth\.js$/, '') || './';
  box.innerHTML = u ? `<span class="note">${esc(u.email)}${u.role === 'owner' ? ' · владелец' : ''}</span>${u.role === 'owner' ? `<a class="tb" href="${base}cabinet/">Кабинет</a>` : ''}<button class="tb" id="logoutBtn">Выйти</button>`
    : `<button class="tb" id="loginBtn">Войти</button>`;
}
document.addEventListener('click', e => { if (e.target.id === 'loginBtn') openLogin(); if (e.target.id === 'logoutBtn') logout(); });
document.addEventListener('pb-auth', renderAuthBox);
renderAuthBox(); if (!STATIC) refresh().then(renderAuthBox);

// ---------- кнопки скачивания на странице модели
export function wireDownloads(dl, note) {
  if (!dl) return;
  const slug = dl.dataset.model;
  if (STATIC) {
    for (const a of dl.querySelectorAll('a[data-download]')) { a.classList.add('off'); a.title = 'временная витрина без сервера'; a.querySelector('small').textContent = (a.dataset.size > 0 ? fmt(+a.dataset.size) : '') + ' · после запуска сервера'; }
    if (note) { note.className = 'auth-note'; note.textContent = 'Это временная витрина только для просмотра. Скачивание пакетов появится для сотрудников после запуска сервера каталога.'; }
    dl.addEventListener('click', e => { if (e.target.closest('a[data-download]')) e.preventDefault(); });
    return;
  }
  let packages = null;
  const update = async () => {
    const u = auth.user; packages = null;
    if (u) { try { packages = (await api(`/api/collections/packages/records?filter=${encodeURIComponent(`model.slug = "${slug}"`)}&perPage=10`)).items; } catch (e) { packages = []; } }
    for (const a of dl.querySelectorAll('a[data-download]')) {
      const p = packages && packages.find(x => x.platform === a.dataset.platform);
      a.classList.toggle('off', !u || !p); a.title = !u ? 'нужен вход' : p ? 'скачать zip' : 'пакет ещё не загружен на сервер';
      a.querySelector('small').textContent = (a.dataset.size > 0 ? fmt(+a.dataset.size) : '') + (!u ? ' · войти' : p ? '' : ' · нет на сервере');
    }
    if (note) { note.className = 'auth-note' + (u ? ' ok' : ''); note.textContent = u ? `Вы вошли как ${u.email}. Ссылки ведут на файлы на сервере каталога (действуют несколько минут).` : 'Доступно сотрудникам студии: нужен вход по коду из письма (почта из списка владельца).'; }
  };
  dl.addEventListener('click', async (e) => {
    const a = e.target.closest('a[data-download]'); if (!a) return; e.preventDefault();
    if (!auth.user) return openLogin('Чтобы скачать пакет, войдите по коду из письма.');
    const p = packages && packages.find(x => x.platform === a.dataset.platform); if (!p) return;
    try { const t = await fileToken(); window.location.href = fileUrl('packages', p.id, p.file, t); }
    catch (err) { alert('не удалось получить ссылку: ' + err.message); }
  });
  document.addEventListener('pb-auth', update); update();
}
const fmt = (n) => n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ';
