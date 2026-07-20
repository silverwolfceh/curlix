// ── Curlix frontend: dual storage (anonymous=localStorage, account=server) ──

const API_BASE = '';

// ── Password show/hide eye toggle ─────────────────────────────────────────────
const EYE_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7-3.5 7-10 7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_CLOSED = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-6.5 0-10-7-10-7a13.16 13.16 0 0 1 1.67-2.68"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><path d="M1 1l22 22"/></svg>';

function eyeToggle() {
  return `<button type="button" class="eye-btn" tabindex="-1" title="Show/hide">${EYE_CLOSED}</button>`;
}

function bindEyeToggles(root = document) {
  root.querySelectorAll('input[type="password"]').forEach(inp => {
    if (inp.dataset.eyeBound) return;
    inp.dataset.eyeBound = '1';
    // Wrap if not already wrapped
    if (!inp.parentElement.classList.contains('pw-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'pw-wrap';
      inp.parentNode.insertBefore(wrap, inp);
      wrap.appendChild(inp);
      wrap.insertAdjacentHTML('beforeend', eyeToggle());
    }
  });
  root.querySelectorAll('.eye-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const wrap = btn.parentElement;
      const inp = wrap.querySelector('input');
      if (!inp) return;
      const isPw = inp.type === 'password';
      inp.type = isPw ? 'text' : 'password';
      btn.innerHTML = isPw ? EYE_OPEN : EYE_CLOSED;
      btn.title = isPw ? 'Hide' : 'Show';
    });
  });
}


// ── Session & crypto ──────────────────────────────────────────────────────
//
// Anonymous: saved requests, history, env vars live in localStorage only.
// Logged in:  saved/history sync to server (plaintext, per user); env vars are
//             AES-GCM encrypted client-side with a key derived (PBKDF2) from the
//             account password. Server stores only ciphertext + iv.
// The env key is held in sessionStorage, so a new tab/reload that lost it must
// re-prompt the password to unlock env vars.

let _session = null;      // {user_id, username, env_salt} | null
let _envKey = null;       // CryptoKey | null (only when logged in & unlocked)
let _syncedThisSession = false; // prevent duplicate syncs on re-login

async function loadSession() {
  try {
    const r = await fetch(API_BASE + '/api/user/me');
    if (r.ok) { _session = await r.json(); return; }
  } catch (e) { console.warn('[session] load failed:', e); }
  _session = null;
}

function isLoggedIn() { return !!_session; }
function envLocked() { return isLoggedIn() && !_envKey; }

// base64 helpers
function bufToB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const buf = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
  return buf;
}

async function deriveEnvBits(password, saltB64) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64ToBuf(saltB64), iterations: 200000, hash: 'SHA-256' }, km, 256));
}

async function setEnvKeyFromPassword(password, saltB64) {
  const bits = await deriveEnvBits(password, saltB64);
  sessionStorage.setItem('curlix:env-key', bufToB64(bits));
  localStorage.setItem('curlix:env-key', bufToB64(bits));
  _envKey = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function loadEnvKeyIfPresent() {
  // Try sessionStorage first, fall back to localStorage (survives refresh)
  let b64 = sessionStorage.getItem('curlix:env-key') || localStorage.getItem('curlix:env-key');
  if (!b64) { console.warn('[env] no key found'); _envKey = null; return; }
  try {
    _envKey = await crypto.subtle.importKey('raw', b64ToBuf(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    console.log('[env] key loaded');
  } catch (e) { console.error('[env] key import failed:', e); _envKey = null; }
}

function clearEnvKey() {
  sessionStorage.removeItem('curlix:env-key');
  localStorage.removeItem('curlix:env-key');
  _envKey = null;
}

async function encryptStr(key, str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(str));
  return { iv: bufToB64(iv), value: bufToB64(new Uint8Array(ct)) };
}

async function decryptStr(key, ivB64, valueB64) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(ivB64) }, key, b64ToBuf(valueB64));
  return new TextDecoder().decode(pt);
}

function getApiHeaders(extra = {}) {
  const h = { ...extra };
  const adminToken = localStorage.getItem('curlix:admin-token');
  if (adminToken) h['Authorization'] = 'Bearer ' + adminToken;
  return h;
}

async function apiFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...getApiHeaders(opts.headers) };
  return fetch(url, { ...opts, headers });
}

// ── Environment variables ───────────────────────────────────────────────────

async function fetchEnvVars() {
  if (isLoggedIn()) {
    console.log('[env] fetching, _envKey=', !!_envKey);
    if (!_envKey) return [];
    try {
      const r = await apiFetch(API_BASE + '/api/env-vars');
      if (!r.ok) { console.warn('[env] fetch failed:', r.status); return []; }
      const data = await r.json();
      console.log('[env] got', data.length, 'server entries');
      const out = [];
      for (const e of data) {
        try { out.push({ k: e.key, v: e.iv ? await decryptStr(_envKey, e.iv, e.value) : e.value }); } catch (err) { console.error('[env] decrypt failed for', e.key, err); out.push({ k: e.key, v: '[decrypt error]' }); }
      }
      return out;
    } catch (e) { console.error('[env] fetch failed:', e); return []; }
  }
  // Anonymous: localStorage (plaintext, browser-only)
  try { return JSON.parse(localStorage.getItem('curlix:env') || '[]'); } catch { return []; }
}

async function persistEnvVars(env) {
  console.log('[env] persist called with', env.length, 'vars, isLoggedIn=', isLoggedIn(), '_envKey=', !!_envKey);
  if (isLoggedIn()) {
    if (!_envKey) { console.error('[env] cannot persist: env key not available'); return; }
    try {
      const enc = [];
      for (const e of env) {
        if (!e.k.trim()) continue;
        const { iv, value } = await encryptStr(_envKey, e.v || '');
        enc.push({ key: e.k, value, iv });
      }
      console.log('[env] encrypting', enc.length, 'vars');
      await apiFetch(API_BASE + '/api/env-vars', {
        method: 'PUT',
        body: JSON.stringify({ vars: enc }),
      });
      console.log('[env] synced', enc.length, 'vars to server');
    } catch (e) { console.error('[env] save failed:', e); }
    return;
  }
  try { localStorage.setItem('curlix:env', JSON.stringify(env)); } catch (e) { console.error('[env] save failed:', e); }
}

function getEnvMap() {
  const map = {};
  _envList.forEach(({ k, v }) => { map[k] = v; });
  return map;
}

let _envList = [];

function resolveVars(str) {
  const env = getEnvMap();
  return str.replace(/\{\{(\w+)\}\}/g, (_, name) => env[name] ?? `{{${name}}}`);
}

function addEnvRow(k = '', v = '') {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `
    <input type="text" placeholder="NAME" value="${escAttr(k)}" />
    <div class="pw-wrap">
      <input type="password" placeholder="value" value="${escAttr(v)}" />
      ${eyeToggle()}
    </div>
    <button class="btn-remove" title="Remove" onclick="removeEnvRow(this)">×</button>
  `;
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', persistEnvFromUI));
  document.getElementById('env-list').appendChild(row);
  bindEyeToggles(row);
  persistEnvFromUI();
}

function removeEnvRow(btn) {
  const row = btn.parentElement;
  const k = row.querySelector('input').value.trim();
  showConfirm('Delete variable?', k ? `Remove "${k}" from environment?` : 'Remove this variable?', () => {
    row.remove();
    persistEnvFromUI();
  });
}

// ── Confirm dialog (reusable) ─────────────────────────────────────────────────
let _confirmCb = null;
function showConfirm(title, msg, onOk, okText = 'Delete') {
  document.getElementById('confirm-title').textContent = title || 'Are you sure?';
  document.getElementById('confirm-msg').textContent = msg || '';
  const okBtn = document.getElementById('confirm-ok');
  okBtn.textContent = okText;
  _confirmCb = onOk;
  document.getElementById('confirm-dialog').classList.remove('hidden');
}
function closeConfirm(ok) {
  document.getElementById('confirm-dialog').classList.add('hidden');
  const cb = _confirmCb;
  _confirmCb = null;
  if (ok && cb) cb();
}

let _envPersistTimer = null;
function persistEnvFromUI() {
  const rows = document.querySelectorAll('.env-row');
  const env = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const k = inputs[0].value.trim();
    const v = inputs[1].value;
    if (k) env.push({ k, v });
  });
  _envList = env; // sync, so resolveVars() sees latest immediately
  clearTimeout(_envPersistTimer);
  _envPersistTimer = setTimeout(() => persistEnvVars(env), 400);
}

function renderEnv() {
  document.getElementById('env-list').innerHTML = '';
  _envList.forEach(({ k, v }) => addEnvRow(k, v));
}

// ── Settings (shared) ───────────────────────────────────────────────────────

let _settings = {};

async function loadSettings() {
  try {
    const r = await apiFetch(API_BASE + '/api/settings');
    if (!r.ok) return;
    _settings = await r.json();
  } catch (e) { console.warn('[settings] load failed:', e); }
}

async function saveSettingsData(data) {
  try {
    await apiFetch(API_BASE + '/api/settings', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    _settings = { ..._settings, ...data };
  } catch (e) { console.error('[settings] save failed:', e); }
}

function getSetting(key, def) {
  return _settings[key] !== undefined ? _settings[key] : def;
}

function getAiBase()       { return localStorage.getItem('curlix:ai-base') || ''; }
function getAiKey()        { return localStorage.getItem('curlix:ai-key') || ''; }
function getAiModel()      { return localStorage.getItem('curlix:ai-model') || ''; }
function getAiCall()       { return localStorage.getItem('curlix:ai-call') || ''; }
function getAiResponseStyle() { return localStorage.getItem('curlix:ai-response-style') || ''; }

// ── Saved requests ────────────────────────────────────────────────────────

async function fetchSavedRequests() {
  if (isLoggedIn()) {
    try {
      const r = await apiFetch(API_BASE + '/api/saved-requests');
      if (!r.ok) return [];
      return await r.json();
    } catch { return []; }
  }
  try { return JSON.parse(localStorage.getItem('curlix:saved') || '[]'); } catch { return []; }
}

async function createSavedRequest(data) {
  if (isLoggedIn()) {
    try {
      const r = await apiFetch(API_BASE + '/api/saved-requests', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return await r.json();
    } catch (e) { console.error('[request] create failed:', e); return null; }
  }
  let list;
  try { list = JSON.parse(localStorage.getItem('curlix:saved') || '[]'); } catch { list = []; }
  const id = Date.now();
  list.unshift({ id, ...data });
  localStorage.setItem('curlix:saved', JSON.stringify(list));
  return { id };
}

async function deleteSavedRequest(id) {
  if (isLoggedIn()) {
    try {
      await apiFetch(API_BASE + '/api/saved-requests/' + id, { method: 'DELETE' });
    } catch (e) { console.error('[request] delete failed:', e); }
    return;
  }
  try {
    const list = JSON.parse(localStorage.getItem('curlix:saved') || '[]').filter(r => String(r.id) !== String(id));
    localStorage.setItem('curlix:saved', JSON.stringify(list));
  } catch (e) { console.error('[request] delete failed:', e); }
}

// ── History ──────────────────────────────────────────────────────────────────

async function fetchHistory(limit = 100, offset = 0) {
  if (isLoggedIn()) {
    try {
      const r = await apiFetch(API_BASE + '/api/history?limit=' + limit + '&offset=' + offset);
      if (!r.ok) return [];
      return await r.json();
    } catch { return []; }
  }
  try { return JSON.parse(localStorage.getItem('curlix:history') || '[]'); } catch { return []; }
}

async function pushHistoryEntry(entry) {
  if (isLoggedIn()) {
    try {
      await apiFetch(API_BASE + '/api/history', {
        method: 'POST',
        body: JSON.stringify(entry),
      });
      renderHistory();
    } catch (e) { console.error('[history] push failed:', e); }
    return;
  }
  try {
    const list = JSON.parse(localStorage.getItem('curlix:history') || '[]');
    list.unshift({ id: Date.now(), ...entry });
    localStorage.setItem('curlix:history', JSON.stringify(list.slice(0, 200)));
    renderHistory();
  } catch (e) { console.error('[history] push failed:', e); }
}

// ── Local → Server sync (on login/register) ─────────────────────────────────

async function syncLocalToServer() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('curlix:saved') || '[]'); } catch { return []; } })();
  const history = (() => { try { return JSON.parse(localStorage.getItem('curlix:history') || '[]'); } catch { return []; } })();
  const env = (() => { try { return JSON.parse(localStorage.getItem('curlix:env') || '[]'); } catch { return []; } })();
  console.log('[sync] env from localStorage:', env.length, 'saved:', saved.length, 'history:', history.length);

  // Save each local saved request
  for (const item of saved) {
    try {
      await apiFetch(API_BASE + '/api/saved-requests', {
        method: 'POST',
        body: JSON.stringify({
          name: item.name || item.url || 'Untitled',
          method: item.method || 'GET',
          url: item.url || '',
          headers: item.headers || {},
          cookies: item.cookies || {},
          body: item.body || '',
          ai_desc: item.ai_desc || '',
        }),
      });
    } catch { /* skip individual failures */ }
  }

  // Save each local history entry
  for (const item of history) {
    try {
      await apiFetch(API_BASE + '/api/history', {
        method: 'POST',
        body: JSON.stringify({
          name: item.url || 'Untitled',
          method: item.method || 'GET',
          url: item.url || '',
          request_headers: item.headers || {},
          request_body: item.body || '',
          response_status: item.response_status || null,
          response_headers: item.response_headers || {},
          response_body: item.response_body || '',
          request_cookies: item.cookies || {},
        }),
      });
    } catch { /* skip individual failures */ }
  }

  // Persist env vars
  if (env.length) {
    await persistEnvVars(env);
  }

  // Clear localStorage — data is now on server
  localStorage.removeItem('curlix:saved');
  localStorage.removeItem('curlix:history');
  localStorage.removeItem('curlix:env');
  console.log('[sync] cleared localStorage items');
}

// ── Theme ───────────────────────────────────────────────────────────────────

(function initTheme() {
  const theme = localStorage.getItem('curlix:theme');
  if (theme === 'light') applyTheme('light');
})();

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    document.getElementById('theme-toggle').textContent = '☀️';
  } else {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('theme-toggle').textContent = '🌙';
  }
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  localStorage.setItem('curlix:theme', next);
  applyTheme(next);
}

// ── Sidebar toggle ────────────────────────────────────────────────────────
function applySidebarState(hidden) {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebar-toggle-btn');
  if (hidden) {
    sidebar.classList.add('sidebar-hidden');
  } else {
    sidebar.classList.remove('sidebar-hidden');
  }
  if (toggle) toggle.textContent = hidden ? '☰' : '☷';
}

function toggleSidebar() {
  const hidden = !document.getElementById('sidebar').classList.contains('sidebar-hidden');
  localStorage.setItem('curlix:sidebar-hidden', hidden ? '1' : '0');
  applySidebarState(hidden);
}

(function initSidebar() {
  const hidden = localStorage.getItem('curlix:sidebar-hidden') === '1';
  applySidebarState(hidden);

  // On mobile, tap outside sidebar to close it
  const main = document.querySelector('main');
  if (main) {
    main.addEventListener('click', e => {
      if (window.innerWidth > 768) return;
      const sidebar = document.getElementById('sidebar');
      if (!sidebar || sidebar.classList.contains('sidebar-hidden')) return;
      // Sidebar is visible
      const toggleBtn = document.getElementById('sidebar-toggle-btn');
      if (toggleBtn && (e.target === toggleBtn || toggleBtn.contains(e.target))) return;
      toggleSidebar();
    });
  }
})();

window.addEventListener('resize', () => {
  const hidden = document.getElementById('sidebar').classList.contains('sidebar-hidden');
  applySidebarState(hidden);
});

// ── Toast ───────────────────────────────────────────────────────────────────

function showToast(msg, type) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + (type || 'info');
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── Settings tab ────────────────────────────────────────────────────────────

const SETTINGS_TAB_ID = 'settings';

function openSettingsTab() {
  if (document.getElementById('panel-' + SETTINGS_TAB_ID)) {
    switchToTab(SETTINGS_TAB_ID);
    return;
  }
  createSettingsTabButton();
  createSettingsPanel();
  switchToTab(SETTINGS_TAB_ID);
  loadSettingsValues();
}

function createSettingsTabButton() {
  const btn = document.createElement('button');
  btn.className = 'req-tab';
  btn.id = 'tab-btn-' + SETTINGS_TAB_ID;
  btn.dataset.tabId = SETTINGS_TAB_ID;
  btn.innerHTML = `<span class="req-tab-label">&#9881; Settings</span><span class="req-tab-close" onclick="closeSettingsTab(event)">×</span>`;
  btn.addEventListener('click', e => {
    if (e.target.classList.contains('req-tab-close')) return;
    switchToTab(SETTINGS_TAB_ID);
  });
  const addBtn = document.querySelector('.req-tab-add');
  document.getElementById('req-tabbar').insertBefore(btn, addBtn);
}

function createSettingsPanel() {
  const panel = document.createElement('div');
  panel.className = 'req-panel';
  panel.id = 'panel-' + SETTINGS_TAB_ID;
  panel.innerHTML = `
    <div class="settings-page">

      <details class="settings-section" open>
        <summary class="settings-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>AI Settings
        </summary>
        <div class="settings-desc">Configure the OpenAI-compatible API used by AI Assist on each request tab.</div>
        <div class="settings-fields">
          <div class="settings-field">
            <label>API Base URL</label>
            <input id="ai-base" type="text" placeholder="https://api.openai.com/v1" />
          </div>
          <div class="settings-field">
            <label>API Key</label>
            <input id="ai-key" type="password" placeholder="sk-..." />
          </div>
          <div class="settings-field">
            <label>Model</label>
            <input id="ai-model" type="text" placeholder="gpt-4o-mini" />
          </div>
          <div class="settings-field">
            <label>Call AI API</label>
            <select id="ai-call">
              <option value="responses">Responses (/responses)</option>
              <option value="completions">Completions (/chat/completions)</option>
            </select>
          </div>
          <div class="settings-field">
            <label>Response Style</label>
            <select id="ai-response-style">
              <option value="strict_json">Strict JSON (recommended)</option>
              <option value="compact">Compact</option>
              <option value="detailed">Detailed</option>
            </select>
          </div>
        </div>
      </details>

      <details class="settings-section">
        <summary class="settings-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Authentication
        </summary>
        <div class="settings-desc">Credentials sent with every request via Basic Auth. Leave blank to disable.</div>
        <div class="settings-fields">
          <div class="settings-field">
            <label>NT ID</label>
            <input id="auth-ntid" type="text" placeholder="your-ntid" />
          </div>
          <div class="settings-field">
            <label>Password</label>
            <input id="auth-password" type="password" placeholder="password" />
          </div>
        </div>
      </details>

      <details class="settings-section">
        <summary class="settings-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Proxy
        </summary>
        <div class="settings-desc">HTTP proxy for outgoing requests (passed to the backend). Leave blank to use direct connection.</div>
        <div class="settings-fields">
          <div class="settings-field">
            <label>Proxy URL</label>
            <input id="proxy-url" type="text" placeholder="http://proxy.example.com:8080" />
          </div>
          <div class="settings-field">
            <label>Username</label>
            <input id="proxy-user" type="text" placeholder="optional" />
          </div>
          <div class="settings-field">
            <label>Password</label>
            <input id="proxy-pass" type="password" placeholder="optional" />
          </div>
        </div>
      </details>

      <details class="settings-section">
        <summary class="settings-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Account
        </summary>
        <div class="settings-desc" id="account-desc"></div>
        <div class="settings-fields" id="account-fields"></div>
      </details>

      <button class="btn-primary settings-save-btn" onclick="doSaveSettings()">Save settings</button>
      <span id="settings-saved-msg" class="settings-saved-msg hidden">Saved.</span>
    </div>
  `;
  document.getElementById('req-panels').appendChild(panel);
}

function closeSettingsTab(e) {
  e.stopPropagation();
  document.getElementById('tab-btn-' + SETTINGS_TAB_ID)?.remove();
  document.getElementById('panel-' + SETTINGS_TAB_ID)?.remove();
  if (tabs.length) switchToTab(tabs[tabs.length - 1].id);
}

async function loadSettingsValues() {
  // AI settings — frontend-only (localStorage), never loaded from server.
  // Server falls back to its own saved config when frontend values are empty.
  const aiIds = ['ai-base', 'ai-key', 'ai-model', 'ai-call', 'ai-response-style'];
  aiIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = localStorage.getItem('curlix:' + id) || '';
  });

  // Proxy / auth settings — loaded from server settings.
  const ids = ['auth-ntid', 'auth-password', 'proxy-url', 'proxy-user', 'proxy-pass'];
  const map = {
    'auth-ntid': 'auth_ntid', 'auth-password': 'auth_password',
    'proxy-url': 'proxy_url', 'proxy-user': 'proxy_user', 'proxy-pass': 'proxy_pass',
  };
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const dbKey = map[id];
    if (dbKey && _settings[dbKey] !== undefined) el.value = _settings[dbKey];
    else if (dbKey && _settings[dbKey.replace('_', '-')] !== undefined) el.value = _settings[dbKey.replace('_', '-')];
    else el.value = localStorage.getItem('curlix:' + id) || '';
  });

  // Account section (login/register/logout/unlock)
  renderAccountSection();
  renderHeaderAuth();
}

async function doSaveSettings() {
  // AI settings — frontend-only (localStorage), never sent to server.
  const aiIds = ['ai-base', 'ai-key', 'ai-model', 'ai-call', 'ai-response-style'];
  aiIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    localStorage.setItem('curlix:' + id, el.value || '');
  });

  // Proxy / auth settings — saved to server.
  const map = {
    'auth-ntid': 'auth_ntid', 'auth-password': 'auth_password',
    'proxy-url': 'proxy_url', 'proxy-user': 'proxy_user', 'proxy-pass': 'proxy_pass',
  };
  const data = {};
  Object.entries(map).forEach(([domId, key]) => {
    const el = document.getElementById(domId);
    if (!el || !el.value) return;
    data[key] = el.value;
  });
  await saveSettingsData(data);

  const msg = document.getElementById('settings-saved-msg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2000);
  showToast('Settings saved', 'success');
}

function aiCallLabel(v) {
  v = (v || '').toLowerCase();
  if (v === 'chat' || v === 'chat_completions' || v === 'completion' || v === 'completions') return 'Chat Completions';
  return 'Responses';
}

function aiStyleLabel(v) {
  v = (v || '').toLowerCase();
  if (v === 'compact') return 'Compact';
  if (v === 'detailed') return 'Detailed';
  return 'Strict JSON';
}

function refreshAiAssistHint(id) {
  const el = document.getElementById('ai-active-' + id);
  if (!el) return;
  el.textContent = 'Active: ' + aiCallLabel(getAiCall()) + ' • ' + aiStyleLabel(getAiResponseStyle());
}

function refreshAiAssistHints() {
  tabs.forEach(t => refreshAiAssistHint(t.id));
}

// ── Account (login / register / logout / unlock env) ───────────────────────

/* ── Burger menu ─────────────────────────────────────────────────────────── */

function toggleBurger(e) {
  e.stopPropagation();
  const menu = document.getElementById('burger-menu');
  if (menu.classList.contains('hidden')) {
    menu.classList.remove('hidden');
    document.addEventListener('click', closeBurger, { once: true });
  } else {
    closeBurger(e);
  }
}

function closeBurger() {
  document.getElementById('burger-menu').classList.add('hidden');
}

function renderBurgerAuth() {
  // No auth items in burger anymore — auth moved to header
  const divider = document.getElementById('burger-divider');
  if (divider) divider.classList.add('hidden');
  const auth = document.getElementById('burger-auth');
  if (auth) auth.innerHTML = '';
}

/* ── Auth modal ──────────────────────────────────────────────────────────── */

let _authMode = 'login'; // 'login' | 'register'

function openAuthDialog(mode) {
  _authMode = mode;
  closeBurger();
  const title = document.getElementById('auth-title');
  const submit = document.getElementById('auth-submit');
  const switchEl = document.getElementById('auth-switch');
  const hint = document.getElementById('auth-unlock-hint');
  title.textContent = mode === 'login' ? 'Log in' : 'Register';
  submit.textContent = mode === 'login' ? 'Log in' : 'Register';
  if (switchEl) {
    switchEl.innerHTML = mode === 'login'
      ? 'No account? <a href="#" onclick="openAuthDialog(\'register\');return false">Register</a>'
      : 'Already have an account? <a href="#" onclick="openAuthDialog(\'login\');return false">Log in</a>';
  }
  hint.classList.add('hidden');
  document.getElementById('auth-error').classList.add('hidden');
  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
  document.getElementById('auth-dialog').classList.remove('hidden');
  document.getElementById('auth-username').focus();
}

function closeAuthDialog() {
  document.getElementById('auth-dialog').classList.add('hidden');
}

function setAuthMode(mode) {
  _authMode = mode;
  openAuthDialog(mode);
}

async function doAuthSubmit() {
  const username = (document.getElementById('auth-username')?.value || '').trim();
  const password = (document.getElementById('auth-password')?.value || '');
  const errEl = document.getElementById('auth-error');
  errEl.classList.add('hidden');

  if (!username || !password) {
    errEl.textContent = 'Username and password required';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const url = API_BASE + (_authMode === 'register' ? '/api/user/register' : '/api/user/login');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (!r.ok) { errEl.textContent = d.detail || 'Failed'; errEl.classList.remove('hidden'); return; }
    await setEnvKeyFromPassword(password, d.env_salt);
    closeAuthDialog();
    showToast((_authMode === 'register' ? 'Registered' : 'Logged in') + ' as ' + d.username, 'success');
    // Sync local data to server
    if (!_syncedThisSession) {
      await syncLocalToServer();
      _syncedThisSession = true;
    }
    // Reload for clean state
    setTimeout(() => window.location.reload(), 300);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

/* ── Header auth state ───────────────────────────────────────────────────── */

function renderHeaderAuth() {
  const chip = document.getElementById('user-chip');
  const chipName = document.getElementById('user-chip-name');
  const logoutBtn = document.getElementById('logout-btn');
  const loginBtn = document.getElementById('login-btn');
  if (!chip || !logoutBtn) return;

  if (isLoggedIn()) {
    chip.classList.remove('hidden');
    chipName.textContent = _session.username;
    logoutBtn.classList.remove('hidden');
    if (loginBtn) loginBtn.classList.add('hidden');
    // Update admin button visibility
    const adminBtn = document.getElementById('admin-btn');
    if (adminBtn) adminBtn.style.display = 'none';
  } else {
    chip.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    if (loginBtn) loginBtn.classList.remove('hidden');
  }
  renderBurgerAuth();
}

/* ── Enhanced doLogout ───────────────────────────────────────────────────── */

async function doLogout() {
  try { await fetch(API_BASE + '/api/user/logout', { method: 'POST' }); } catch {}
  clearEnvKey();
  _session = null;
  _syncedThisSession = false; // allow re-sync on next login
  renderHeaderAuth();
  showToast('Logged out', 'success');
}

/* ── importFileClick ──────────────────────────────────────────────────────── */

function importFileClick() {
  closeBurger();
  document.getElementById('import-file').click();
}

/* ── Account section (settings) — unlock only ────────────────────────────── */

function hasSubtleCrypto() { return !!(window.crypto && window.crypto.subtle); }

function renderAccountSection() {
  const desc = document.getElementById('account-desc');
  const fields = document.getElementById('account-fields');
  if (!desc || !fields) return;

  if (!isLoggedIn()) {
    if (!hasSubtleCrypto()) {
      desc.innerHTML = 'Accounts need a secure context (HTTPS or localhost) to encrypt environment variables. Data stays in this browser only.';
      fields.innerHTML = '';
      return;
    }
    desc.innerHTML = 'Log in to sync requests &amp; history to the server (env vars encrypted). Without login, data stays in this browser only.';
    fields.innerHTML = `
      <div style="display:flex;gap:8px">
        <button class="btn-primary" onclick="openAuthDialog('login')">Log in</button>
        <button class="btn-small" onclick="openAuthDialog('register')">Register</button>
      </div>`;
    return;
  }

  if (envLocked()) {
    desc.innerHTML = 'Environment variables are locked — enter your password to unlock them.';
    fields.innerHTML = `
      <div class="settings-field">
        <label>Password</label>
        <div class="pw-wrap">
          <input id="unlock-password" type="password" placeholder="password" autocomplete="current-password" />
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn-primary" onclick="doUnlockEnv()">Unlock</button>
        <button class="btn-small" onclick="doLogout()">Log out</button>
      </div>`;
  } else {
    desc.innerHTML = 'Logged in as <b>' + escAttr(_session.username) + '</b>. Requests, history &amp; encrypted env vars sync to the server.';
    fields.innerHTML = '';
  }
  bindEyeToggles(fields);
}

async function doUnlockEnv() {
  const unlockEl = document.getElementById('unlock-password');
  if (!unlockEl) return;
  const password = unlockEl.value;
  if (!password) { showToast('Enter your password', 'error'); return; }
  try {
    await setEnvKeyFromPassword(password, _session.env_salt);
    _envList = await fetchEnvVars();
    renderEnv();
    renderAccountSection();
    showToast('Environment unlocked', 'success');
  } catch (e) { showToast('Unlock failed: ' + e.message, 'error'); }
}

// ── Multi-tab request system ────────────────────────────────────────────────

let tabCounter = 0;
let activeTabId = null;
const tabs = [];

function escAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function createTabPanel(id) {
  const panel = document.createElement('div');
  panel.className = 'req-panel';
  panel.id = 'panel-' + id;
  panel.innerHTML = `
    <div class="request-line">
      <select id="method-${id}">
        <option>GET</option>
        <option>POST</option>
        <option>PUT</option>
        <option>PATCH</option>
        <option>DELETE</option>
      </select>
      <input id="url-${id}" type="text" placeholder="https://httpbin.org/get" />
      <button id="send-btn-${id}" class="btn-primary" onclick="sendRequest('${id}')">&#10148; Send</button>
      <button id="save-btn-${id}" class="btn-small" onclick="saveRequest('${id}')" title="Save request">&#128190; Save</button>
    </div>

    <div class="req-options">
      <label class="req-option-label">
        <input type="checkbox" id="opt-proxy-${id}" />
        Use Proxy
      </label>
      <label class="req-option-label">
        <input type="checkbox" id="opt-ntlm-${id}" />
        Use NTLM
      </label>
      <label class="req-option-label">
        <input type="checkbox" id="opt-kerberos-${id}" />
        Use Kerberos
      </label>
    </div>

    <div class="section-label">
      Headers
      <button class="btn-small" onclick="addHeader('${id}')">+ Add</button>
      <button class="btn-small" onclick="addUAHeader('${id}')" title="Add User-Agent header">+ Add UA</button>
      <button class="btn-small" onclick="addAuthHeader('${id}')" title="Add Authorization header">+ Add Auth</button>
      <button class="btn-small collapse-btn" onclick="toggleSection('${id}', 'headers-list')" title="Collapse/expand">▾</button>
    </div>
    <div id="headers-list-${id}" class="headers-list"></div>

    <div class="section-label">
      Cookies
      <button class="btn-small" onclick="addCookie('${id}')">+ Add</button>
      <button class="btn-small collapse-btn" onclick="toggleSection('${id}', 'cookies-list')" title="Collapse/expand">▾</button>
    </div>
    <div id="cookies-list-${id}" class="headers-list"></div>

    <div class="section-label" id="body-label-${id}">Body</div>
    <textarea id="body-${id}" placeholder='{"key": "value"}'></textarea>
    <div class="file-upload-row" id="file-upload-row-${id}">
      <label class="btn-small file-pick-btn">📁 Choose file<input type="file" id="file-input-${id}" style="display:none" onchange="onFilePicked('${id}', this)"></label>
      <span class="file-name" id="file-name-${id}">no file</span>
      <input type="text" id="file-field-${id}" class="file-field-input" value="file" title="Form field name" />
      <button class="btn-small" id="file-clear-${id}" onclick="clearFile('${id}')" title="Remove file">✕</button>
    </div>
    <div class="section-label">
      <button class="btn-small" onclick="generatePython('${id}')" title="Generate python requests script">🐍 Try with requests</button>
    </div>

    <div id="response-panel-${id}" class="response-panel hidden">
      <div class="response-meta">
        <span id="status-badge-${id}" class="badge"></span>
        <span id="response-time-${id}" class="muted"></span>
      </div>
      <details class="resp-headers-details">
        <summary>Response Headers</summary>
        <div id="resp-headers-${id}" class="resp-headers"></div>
      </details>
      <pre id="response-body-${id}" class="response-body"></pre>
    </div>

    <div class="ai-assist">
      <button class="ai-assist-toggle" onclick="toggleAiAssist('${id}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>
        AI Assist
        <span id="ai-assist-caret-${id}" class="ai-caret">▾</span>
      </button>
      <div id="ai-assist-body-${id}" class="ai-assist-body">
        <div id="ai-active-${id}" class="ai-active-hint"></div>
        <textarea id="ai-desc-${id}" placeholder="Describe your request…"></textarea>
        <div class="ai-assist-actions">
          <button id="ai-fill-btn-${id}" class="btn-primary" onclick="rebuildWithAI('${id}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>Rebuild with AI</button>
          <span id="ai-error-${id}" class="error hidden"></span>
        </div>
        <div id="ai-log-${id}" class="ai-log hidden"></div>
      </div>
    </div>
  `;
  document.getElementById('req-panels').appendChild(panel);
  bindEyeToggles(panel);

  document.getElementById('method-' + id).addEventListener('change', () => updateBodyVisibility(id));
  updateBodyVisibility(id);
  addHeader(id, 'Content-Type', 'application/json');
  refreshAiAssistHint(id);
  // No auto-parse on paste; rebuild button handles command detection + AI fallback.
  const descEl = document.getElementById('ai-desc-' + id);
  if (descEl) {
    descEl.addEventListener('paste', () => {
      /* no auto-parse */
    });
  }
}

function createTabButton(id, label) {
  const btn = document.createElement('button');
  btn.className = 'req-tab';
  btn.id = 'tab-btn-' + id;
  btn.dataset.tabId = id;
  btn.innerHTML = `<span class="req-tab-label">${escAttr(label)}</span><span class="req-tab-close" onclick="closeTab(event,'${id}')">×</span>`;
  btn.addEventListener('click', (e) => {
    if (e.target.classList.contains('req-tab-close')) return;
    switchToTab(id);
  });
  const addBtn = document.querySelector('.req-tab-add');
  document.getElementById('req-tabbar').insertBefore(btn, addBtn);
}

function addRequestTab(req) {
  tabCounter++;
  const id = 't' + tabCounter;
  const label = req ? (req.name || req.url || 'Request ' + tabCounter) : 'Request ' + tabCounter;
  tabs.push({ id, label });
  createTabButton(id, label);
  createTabPanel(id);
  switchToTab(id);
  if (req) applyRequestToTab(id, req);
  return id;
}

function switchToTab(id) {
  activeTabId = id;
  document.querySelectorAll('.req-tab').forEach(b => b.classList.toggle('active', b.dataset.tabId === id));
  document.querySelectorAll('.req-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + id));
}

function closeTab(e, id) {
  e.stopPropagation();
  if (tabs.length === 1) return;
  const idx = tabs.findIndex(t => t.id === id);
  tabs.splice(idx, 1);
  document.getElementById('tab-btn-' + id).remove();
  document.getElementById('panel-' + id).remove();
  if (activeTabId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    switchToTab(next.id);
  }
}

function updateTabLabel(id, label) {
  const btn = document.getElementById('tab-btn-' + id);
  if (btn) btn.querySelector('.req-tab-label').textContent = label;
  const t = tabs.find(t => t.id === id);
  if (t) t.label = label;
}

// ── Per-tab helpers ─────────────────────────────────────────────────────────

function updateBodyVisibility(id) {
  const method = document.getElementById('method-' + id).value;
  const noBody = method === 'GET' || method === 'DELETE';
  document.getElementById('body-label-' + id).style.display = noBody ? 'none' : '';
  document.getElementById('body-' + id).style.display = noBody ? 'none' : '';
}

function addCookie(id, key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML = `
    <input type="text" placeholder="Cookie name" value="${escAttr(key)}" />
    <input type="text" placeholder="Value" value="${escAttr(value)}" />
    <button class="btn-remove" title="Remove" onclick="this.parentElement.remove()">×</button>
  `;
  document.getElementById('cookies-list-' + id).appendChild(row);
}

function getCookies(id) {
  const rows = document.getElementById('cookies-list-' + id).querySelectorAll('.header-row');
  const cookies = {};
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const k = inputs[0].value.trim();
    const v = inputs[1].value.trim();
    if (k) cookies[k] = v;
  });
  return cookies;
}

function parseCookies(raw) {
  const result = {};
  const parseStr = str => {
    str.split(';').forEach(part => {
      const eq = part.indexOf('=');
      if (eq === -1) return;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k) result[k] = v;
    });
  };
  if (typeof raw === 'string') {
    parseStr(raw);
  } else if (typeof raw === 'object' && raw !== null) {
    Object.entries(raw).forEach(([k, v]) => {
      if (k.includes('=') || k.includes(';')) {
        parseStr(k + (v ? '=' + v : ''));
      } else if (typeof v === 'string' && v.includes(';') && v.includes('=')) {
        parseStr(k + '=' + v);
      } else {
        result[k] = v;
      }
    });
  }
  return result;
}

function setCookies(id, obj) {
  document.getElementById('cookies-list-' + id).innerHTML = '';
  Object.entries(obj || {}).forEach(([k, v]) => addCookie(id, k, v));
}

function addHeader(id, key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML = `
    <input type="text" placeholder="Header name" value="${escAttr(key)}" />
    <input type="text" placeholder="Value" value="${escAttr(value)}" />
    <button class="btn-remove" title="Remove" onclick="this.parentElement.remove()">×</button>
  `;
  document.getElementById('headers-list-' + id).appendChild(row);
}

function addUAHeader(id) {
  addHeader(id, 'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0');
}

function addAuthHeader(id) {
  addHeader(id, 'Authorization', 'Bearer {{AUTH_TOKEN}}');
}

function toggleSection(tabId, listPrefix) {
  const list = document.getElementById(listPrefix + '-' + tabId);
  if (!list) return;
  const hidden = list.classList.toggle('collapsed');
  const btn = list.previousElementSibling && list.previousElementSibling.querySelector('.collapse-btn');
  if (btn) btn.textContent = hidden ? '▸' : '▾';
}

function getHeaders(id) {
  const rows = document.getElementById('headers-list-' + id).querySelectorAll('.header-row');
  const headers = {};
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const k = inputs[0].value.trim();
    const v = inputs[1].value.trim();
    if (k) headers[k] = v;
  });
  return headers;
}

function setHeaders(id, obj) {
  document.getElementById('headers-list-' + id).innerHTML = '';
  Object.entries(obj || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([k, v]) => addHeader(id, k, v));
}

function toggleAiAssist(id) {
  const body = document.getElementById('ai-assist-body-' + id);
  const caret = document.getElementById('ai-assist-caret-' + id);
  const hidden = body.classList.toggle('hidden');
  caret.textContent = hidden ? '▸' : '▾';
}

// ── Send request ────────────────────────────────────────────────────────────

function pyRepr(s) {
  // Single-quoted Python string literal with basic escaping.
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
}

// ── File upload (multipart/form-data) ───────────────────────────────────────
// Per-tab attached file. When set, sendRequest builds a multipart body and
// sends raw bytes (base64) — overrides the text body textarea.
const _tabFiles = {}; // id -> File (or null)

function onFilePicked(id, input) {
  const f = input.files && input.files[0];
  if (!f) return;
  _tabFiles[id] = f;
  const nameEl = document.getElementById('file-name-' + id);
  if (nameEl) nameEl.textContent = f.name + ' (' + formatBytes(f.size) + ')';
}

function clearFile(id) {
  _tabFiles[id] = null;
  const input = document.getElementById('file-input-' + id);
  if (input) input.value = '';
  const nameEl = document.getElementById('file-name-' + id);
  if (nameEl) nameEl.textContent = 'no file';
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Build a multipart/form-data body from an attached file (+ optional text fields
// parsed from the body textarea as key=value lines). Returns {boundary, b64}.
async function buildMultipartBody(id) {
  const file = _tabFiles[id];
  if (!file) return null;
  const field = (document.getElementById('file-field-' + id) || {}).value || 'file';
  const boundary = '----CurlixBoundary' + Math.random().toString(16).slice(2);
  const enc = new TextEncoder();
  const CRLF = '\r\n';
  const parts = [];

  // Extra text fields: each non-empty line in body textarea as key=value.
  const bodyText = (document.getElementById('body-' + id) || {}).value || '';
  bodyText.split(/\r?\n/).forEach(line => {
    const eq = line.indexOf('=');
    if (eq === -1) return;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1);
    if (!k) return;
    parts.push(enc.encode('--' + boundary + CRLF +
      'Content-Disposition: form-data; name="' + k + '"' + CRLF + CRLF +
      v + CRLF));
  });

  // File part.
  const ct = file.type || 'application/octet-stream';
  const header = '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="' + field + '"; filename="' + file.name + '"' + CRLF +
    'Content-Type: ' + ct + CRLF + CRLF;
  parts.push(enc.encode(header));
  parts.push(new Uint8Array(await file.arrayBuffer()));
  parts.push(enc.encode(CRLF));
  parts.push(enc.encode('--' + boundary + '--' + CRLF));

  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return { boundary, b64: bytesToB64(out) };
}

// Case-insensitive header key lookup.
function findHeaderKey(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).find(k => k.toLowerCase() === lower);
}

function generatePython(id) {
  const method = (document.getElementById('method-' + id).value || 'GET').toUpperCase();
  const rawUrl = document.getElementById('url-' + id).value.trim();
  const url = resolveVars(rawUrl);
  if (!rawUrl) { alert('Please enter a URL.'); return; }

  const rawHeaders = getHeaders(id);
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).map(([k, v]) => [resolveVars(k), resolveVars(v)])
  );
  const rawCookies = getCookies(id);
  const cookies = Object.fromEntries(
    Object.entries(rawCookies).map(([k, v]) => [resolveVars(k), resolveVars(v)])
  );
  const body = document.getElementById('body-' + id).value;
  const attachedFile = _tabFiles[id];

  const useProxy = document.getElementById('opt-proxy-' + id).checked;
  const s = _settings;
  const proxyUrl = useProxy ? (s.proxy_url || '') : '';
  const proxyUser = useProxy ? (s.proxy_user || '') : '';
  const proxyPass = useProxy ? (s.proxy_pass || '') : '';

  const lines = [];
  lines.push('#!/usr/bin/env python3');
  lines.push('"""Auto-generated by Curlix — uses the requests library."""');
  lines.push('import requests');
  lines.push('import urllib3');
  lines.push('urllib3.disable_warnings()  # SSL verification off for corporate proxies');
  lines.push('');
  lines.push('url = ' + pyRepr(url));
  lines.push('method = ' + pyRepr(method));

  if (Object.keys(headers).length) {
    lines.push('headers = {');
    Object.entries(headers).forEach(([k, v]) => lines.push('    ' + pyRepr(k) + ': ' + pyRepr(v) + ','));
    lines.push('}');
  } else {
    lines.push('headers = {}');
  }

  if (Object.keys(cookies).length) {
    lines.push('cookies = {');
    Object.entries(cookies).forEach(([k, v]) => lines.push('    ' + pyRepr(k) + ': ' + pyRepr(v) + ','));
    lines.push('}');
  } else {
    lines.push('cookies = {}');
  }

  if (attachedFile) {
    // Strip Content-Type — requests sets the multipart boundary itself.
    const ctKey = findHeaderKey(headers, 'Content-Type');
    if (ctKey) delete headers[ctKey];
    const fieldName = (document.getElementById('file-field-' + id) || {}).value || 'file';
    lines.push('files = {' + pyRepr(fieldName) + ': (' + pyRepr(attachedFile.name) + ', open(' + pyRepr(attachedFile.name) + ', \'rb\'), ' + pyRepr(attachedFile.type || 'application/octet-stream') + ')}');
  } else if (body.trim()) {
    lines.push('body = ' + pyRepr(body));
  } else {
    lines.push('body = None');
  }

  if (proxyUrl) {
    let proxyStr = proxyUrl;
    if (proxyUser && proxyPass) {
      const m = proxyStr.match(/^(https?:\/\/)(.*)$/);
      if (m) proxyStr = m[1] + proxyUser + ':' + proxyPass + '@' + m[2];
    }
    lines.push('proxies = {');
    lines.push('    ' + pyRepr('http') + ': ' + pyRepr(proxyStr) + ',');
    lines.push('    ' + pyRepr('https') + ': ' + pyRepr(proxyStr) + ',');
    lines.push('}');
  } else {
    lines.push('proxies = None');
  }

  lines.push('');
  lines.push('resp = requests.request(');
  lines.push('    method=method,');
  lines.push('    url=url,');
  lines.push('    headers=headers,');
  lines.push('    cookies=cookies,');
  if (attachedFile) {
    lines.push('    files=files,');
  } else {
    lines.push('    data=body.encode() if body else None,');
  }
  lines.push('    proxies=proxies,');
  lines.push('    verify=False,');
  lines.push('    timeout=30,');
  lines.push('    allow_redirects=True,');
  lines.push(')');
  lines.push('');
  lines.push('print("HTTP", resp.status_code, resp.reason)');
  lines.push('for k, v in resp.headers.items():');
  lines.push('    print(f"{k}: {v}")');
  lines.push('print()');
  lines.push('print(resp.text)');
  lines.push('');

  const code = lines.join('\n');
  const blob = new Blob([code], { type: 'text/x-python' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'generated.py';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Generated generated.py', 'success');
}

async function sendRequest(id) {
  const method = document.getElementById('method-' + id).value;
  const url = resolveVars(document.getElementById('url-' + id).value.trim());
  if (!url) { alert('Please enter a URL.'); return; }

  const rawHeaders = getHeaders(id);
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).map(([k, v]) => [resolveVars(k), resolveVars(v)])
  );
  const bodyText = resolveVars(document.getElementById('body-' + id).value.trim());

  const urlShort = url.replace(/^https?:\/\//, '').split('?')[0];
  updateTabLabel(id, method + ' ' + (urlShort.length > 24 ? urlShort.slice(0, 24) + '…' : urlShort));

  const btn = document.getElementById('send-btn-' + id);
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Sending…';

  const panel = document.getElementById('response-panel-' + id);
  panel.classList.add('hidden');

  const useProxy    = document.getElementById('opt-proxy-' + id).checked;
  const useNtlm     = document.getElementById('opt-ntlm-' + id).checked;
  const useKerberos = document.getElementById('opt-kerberos-' + id).checked;

  const rawCookies = getCookies(id);
  const cookies = Object.fromEntries(
    Object.entries(rawCookies).map(([k, v]) => [resolveVars(k), resolveVars(v)])
  );

  // Read proxy/auth from settings
  const s = _settings;

  // If a file is attached, build multipart/form-data body (raw bytes).
  let bodyB64 = null;
  const attachedFile = _tabFiles[id];
  if (attachedFile) {
    try {
      const mp = await buildMultipartBody(id);
      if (mp) {
        bodyB64 = mp.b64;
        // Force Content-Type with our boundary (replace any existing).
        const existing = findHeaderKey(headers, 'Content-Type');
        if (existing) delete headers[existing];
        headers['Content-Type'] = 'multipart/form-data; boundary=' + mp.boundary;
      }
    } catch (e) {
      document.getElementById('response-body-' + id).textContent = 'File read error: ' + e.message;
      panel.classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Send';
      return;
    }
  }

  const payload = {
    url, method, headers, body: bodyB64 ? '' : bodyText, body_b64: bodyB64, cookies,
    use_proxy: useProxy,
    proxy_url: s.proxy_url || '',
    proxy_user: s.proxy_user || '',
    proxy_pass: s.proxy_pass || '',
    use_ntlm: useNtlm,
    ntlm_user: s.auth_ntid || s['auth-ntid'] || '',
    ntlm_pass: s.auth_password || s['auth-password'] || '',
    use_kerberos: useKerberos,
  };

  const t0 = Date.now();
  try {
    const proxyResp = await fetch(API_BASE + '/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const elapsed = Date.now() - t0;

    if (!proxyResp.ok) {
      const detail = await proxyResp.text();
      throw new Error('Proxy error ' + proxyResp.status + ': ' + detail);
    }

    const data = await proxyResp.json();

    document.getElementById('status-badge-' + id).textContent = data.status + ' ' + data.reason;
    document.getElementById('status-badge-' + id).className = 'badge ' + (data.status < 400 ? 'ok' : 'err');
    document.getElementById('response-time-' + id).textContent = elapsed + ' ms';

    // Push to history (server if logged in, else localStorage)
    pushHistoryEntry({
      name: urlShort,
      method, url,
      request_headers: rawHeaders,
      request_cookies: cookies,
      request_body: document.getElementById('body-' + id).value,
      response_status: data.status,
      response_headers: data.headers,
      response_body: data.body,
    });

    const respHeaderLines = Object.entries(data.headers).map(([k, v]) => k + ': ' + v);
    document.getElementById('resp-headers-' + id).textContent = respHeaderLines.join('\n');

    let display = data.body;
    try { display = JSON.stringify(JSON.parse(data.body), null, 2); } catch (_) {}
    document.getElementById('response-body-' + id).textContent = display;

    panel.classList.remove('hidden');
  } catch (err) {
    document.getElementById('status-badge-' + id).textContent = 'Error';
    document.getElementById('status-badge-' + id).className = 'badge err';
    document.getElementById('response-time-' + id).textContent = '';
    document.getElementById('resp-headers-' + id).textContent = '';
    document.getElementById('response-body-' + id).textContent = err.message;
    panel.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

// ── Missing vars dialog ─────────────────────────────────────────────────────

let _varsResolve = null;

function findMissingVars(data) {
  const env = getEnvMap();
  const found = new Set();
  const scan = s => { if (s) [...s.matchAll(/\{\{(\w+)\}\}/g)].forEach(m => found.add(m[1])); };
  scan(data.url);
  scan(data.body);
  Object.entries(data.headers || {}).forEach(([k, v]) => { scan(k); scan(v); });
  return [...found].filter(name => !(name in env));
}

function promptMissingVars(missing) {
  return new Promise(resolve => {
    _varsResolve = resolve;
    const container = document.getElementById('vars-fields');
    container.innerHTML = '';
    missing.forEach(name => {
      const wrap = document.createElement('div');
      wrap.className = 'vars-field';
      const isSecret = /password|token|secret|key|auth/i.test(name);
      wrap.innerHTML = `
        <label>{{${escAttr(name)}}}</label>
        <div class="pw-wrap">
          <input type="${isSecret ? 'password' : 'text'}" data-varname="${escAttr(name)}" placeholder="${escAttr(name)}" />
          ${isSecret ? eyeToggle() : ''}
        </div>
      `;
      container.appendChild(wrap);
    });
    document.getElementById('vars-dialog').classList.remove('hidden');
    container.querySelector('input')?.focus();
    bindEyeToggles(container);
  });
}

function closeVarsDialog(save) {
  if (save) {
    const inputs = document.querySelectorAll('#vars-fields input');
    const env = _envList;
    inputs.forEach(input => {
      const name = input.dataset.varname;
      const val = input.value;
      const idx = env.findIndex(e => e.k === name);
      if (idx >= 0) env[idx].v = val;
      else env.push({ k: name, v: val });
    });
    persistEnvVars(env);
    renderEnv();
  }
  document.getElementById('vars-dialog').classList.add('hidden');
  if (_varsResolve) { _varsResolve(save); _varsResolve = null; }
}

document.getElementById('vars-dialog').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeVarsDialog(false);
});

document.getElementById('vars-dialog').addEventListener('keydown', e => {
  if (e.key === 'Enter') closeVarsDialog(true);
  if (e.key === 'Escape') closeVarsDialog(false);
});

// ── AI fill ─────────────────────────────────────────────────────────────────

function aiLog(id, msg, type) {
  const log = document.getElementById('ai-log-' + id);
  if (!log) return;
  log.classList.remove('hidden');
  const ts = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'ai-log-line' + (type ? ' ai-log-' + type : '');
  line.textContent = '[' + ts + '] ' + msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function aiLogClear(id) {
  const log = document.getElementById('ai-log-' + id);
  if (!log) return;
  log.innerHTML = '';
  log.classList.add('hidden');
}

async function rebuildWithAI(id) {
  const desc = document.getElementById('ai-desc-' + id);
  const text = desc.value.trim();
  document.getElementById('ai-error-' + id).classList.add('hidden');
  aiLogClear(id);

  if (!text) { showAiError(id, 'Paste a command or describe your request first.'); return; }

  // Step 1: try local command parser
  const type = detectCommandType(text);
  if (type) {
    let parsed = null;
    try {
      if (type === 'curl') parsed = parseCurl(text);
      else if (type === 'powershell') parsed = parsePowerShell(text);
      else if (type === 'node-fetch') parsed = parseNodeFetch(text);
      else if (type === 'axios') parsed = parseAxios(text);
    } catch (e) { /* fall through to AI */ }
    if (parsed && parsed.url) {
      applyParsedRequest(id, parsed);
      aiLog(id, 'Detected ' + type + ' — parsed locally without AI.', 'ok');
      showToast('Parsed ' + type + ' command', 'success');
      return;
    }
    aiLog(id, 'Local parse incomplete — falling back to AI.', 'warn');
  }

  // Step 2: fall back to AI
  await generateRequest(id);
}
async function generateRequest(id) {
  const apiBase = getAiBase();
  const apiKey = getAiKey();
  const model = getAiModel();
  const callAi = getAiCall();
  const responseStyle = getAiResponseStyle();
  const description = document.getElementById('ai-desc-' + id).value.trim();

  document.getElementById('ai-error-' + id).classList.add('hidden');
  aiLogClear(id);

  if (!description) { showAiError(id, 'Please describe your request.'); return; }

  // api_base / api_key may be empty for non-admin users whose settings aren't
  // loaded (GET /api/settings is admin-only). Server falls back to saved
  // settings in /api/ai-fill, so don't block here.

  const btn = document.getElementById('ai-fill-btn-' + id);
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating…';

  const s = _settings;
  try {
    const t0 = Date.now();
    const resp = await fetch(API_BASE + '/api/ai-fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description, api_base: apiBase, api_key: apiKey, model,
        call_ai: callAi, response_style: responseStyle,
        proxy_url: s.proxy_url || null,
        proxy_user: s.proxy_user || null,
        proxy_pass: s.proxy_pass || null,
      }),
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    aiLog(id, 'Response received — HTTP ' + resp.status + ' (' + elapsed + 's)');

    if (!resp.ok) {
      let detail = await resp.text();
      try { detail = JSON.parse(detail)?.detail ?? detail; } catch (_) {}
      aiLog(id, 'Error: ' + detail, 'error');
      showAiError(id, 'HTTP ' + resp.status + ': ' + detail);
      return;
    }

    const data = await resp.json();
    aiLog(id, 'Parsed response — filling form fields');

    if (data.method) {
      document.getElementById('method-' + id).value = data.method.toUpperCase();
      updateBodyVisibility(id);
    }
    if (data.url) document.getElementById('url-' + id).value = data.url;
    if (data.headers) setHeaders(id, data.headers);
    if (data.cookies) setCookies(id, parseCookies(data.cookies));
    if (data.body !== undefined) document.getElementById('body-' + id).value = data.body;

    const missing = findMissingVars(data);
    if (missing.length > 0) {
      aiLog(id, 'Found ' + missing.length + ' placeholder(s) — prompting');
      await promptMissingVars(missing);
    }

    aiLog(id, 'Done.', 'ok');
  } catch (err) {
    aiLog(id, 'Fetch error: ' + err.message, 'error');
    showAiError(id, 'Request failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>Rebuild with AI';
  }
}

function showAiError(id, msg) {
  // const el = document.getElementById('ai-error-' + id);
  // el.textContent = msg;
  // el.classList.remove('hidden');
}

// ── History sidebar ─────────────────────────────────────────────────────────

async function renderHistory() {
  const list = await fetchHistory();
  const el = document.getElementById('history-list');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="history-empty">No requests yet</div>';
    return;
  }
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'saved-item';
    const statusClass = !item.response_status ? '' : item.response_status < 400 ? 'hist-ok' : 'hist-err';
    const statusText = item.response_status ? item.response_status : '—';
    row.innerHTML = `
      <span class="saved-item-method">${item.method}</span>
      <span class="saved-item-name" title="${escAttr(item.url)}">${escAttr(item.url)}</span>
      <span class="hist-status ${statusClass}">${statusText}</span>
    `;
    const entry = {
      method: item.method,
      url: item.url,
      headers: typeof item.request_headers === 'string' ? JSON.parse(item.request_headers) : (item.request_headers || {}),
      cookies: typeof item.request_cookies === 'string' ? JSON.parse(item.request_cookies) : (item.request_cookies || {}),
      body: item.request_body || '',
    };
    row.addEventListener('click', () => addRequestTab(entry));
    el.appendChild(row);
  });
}

async function clearHistory() {
  showConfirm('Clear history?', 'Delete all history entries? This cannot be undone.', async () => {
    try {
      if (isLoggedIn()) {
        await apiFetch(API_BASE + '/api/history', { method: 'DELETE' });
      } else {
        localStorage.removeItem('curlix:history');
      }
      await renderHistory();
      showToast('History cleared', 'success');
    } catch (e) {
      showToast('Failed to clear history', 'error');
    }
  }, 'Clear');
}

async function clearAllRequests() {
  showConfirm('Clear all requests?', 'Delete all saved requests? This cannot be undone.', async () => {
    try {
      if (isLoggedIn()) {
        const list = await fetchSavedRequests();
        for (const item of list) {
          await apiFetch(API_BASE + '/api/saved-requests/' + item.id, { method: 'DELETE' });
        }
      } else {
        localStorage.removeItem('curlix:saved');
      }
      renderSidebar();
      showToast('Requests cleared', 'success');
    } catch (e) {
      showToast('Failed to clear requests', 'error');
    }
  }, 'Clear');
}

// ── Saved requests sidebar ──────────────────────────────────────────────────

async function renderSidebar() {
  const list = await fetchSavedRequests();
  const el = document.getElementById('saved-list');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="history-empty">No saved requests</div>';
    return;
  }
  list.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'saved-item';
    row.innerHTML = `
      <span class="saved-item-method">${item.method}</span>
      <span class="saved-item-name" title="${escAttr(item.url)}">${escAttr(item.name)}</span>
      <button class="saved-item-del" title="Delete" onclick="doDeleteSavedRequest(${item.id}, event)">×</button>
    `;
    const req = {
      method: item.method,
      url: item.url,
      headers: typeof item.headers === 'string' ? JSON.parse(item.headers) : (item.headers || {}),
      cookies: typeof item.cookies === 'string' ? JSON.parse(item.cookies) : (item.cookies || {}),
      body: item.body || '',
      ai_desc: item.ai_desc || '',
    };
    row.addEventListener('click', () => addRequestTab(req));
    el.appendChild(row);
  });
}

async function doDeleteSavedRequest(id, e) {
  e.stopPropagation();
  showConfirm('Delete request?', 'Delete this saved request?', async () => {
    await deleteSavedRequest(id);
    renderSidebar();
    showToast('Request deleted', 'success');
  });
}

function saveRequest(tabId) {
  const id = tabId || activeTabId;
  if (!id) { showToast('No request tab open', 'error'); return; }
  const url = document.getElementById('url-' + id).value.trim();
  document.getElementById('save-name').value = url || '';
  document.getElementById('save-dialog').classList.remove('hidden');
  setTimeout(() => document.getElementById('save-name').select(), 50);
}

function closeSaveDialog() {
  document.getElementById('save-dialog').classList.add('hidden');
}

async function confirmSave() {
  const name = document.getElementById('save-name').value.trim();
  if (!name) return;

  const id = activeTabId || (tabId ? tabId : null);
  const data = {
    name,
    method: document.getElementById('method-' + id).value,
    url: document.getElementById('url-' + id).value,
    headers: getHeaders(id),
    cookies: getCookies(id),
    body: document.getElementById('body-' + id).value,
    ai_desc: (document.getElementById('ai-desc-' + id) || {}).value || '',
  };

  const result = await createSavedRequest(data);
  if (result && result.id) {
    renderSidebar();
    closeSaveDialog();
    showToast('Request saved', 'success');
  }
}

document.getElementById('save-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmSave();
  if (e.key === 'Escape') closeSaveDialog();
});

document.getElementById('save-dialog').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSaveDialog();
});

document.getElementById('import-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') closeImportDialog('sidebar');
  if (e.key === 'Escape') closeImportDialog(false);
});

document.getElementById('import-dialog').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeImportDialog(false);
});

// ── Export / Import ─────────────────────────────────────────────────────────

async function exportAll() {
  const list = await fetchSavedRequests();
  if (!list.length) { alert('No saved requests to export.'); return; }
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'curlix-requests.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

let _pendingImport = null;

function importFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    let imported;
    try {
      imported = JSON.parse(e.target.result);
      if (!Array.isArray(imported)) throw new Error('Expected a JSON array');
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
      input.value = '';
      return;
    }

    // Normalize each request — parse stringified headers/cookies into objects.
    const toObj = v => {
      if (!v) return {};
      if (typeof v === 'object') return v;
      try { return JSON.parse(v) || {}; } catch (_) { return {}; }
    };
    _pendingImport = imported.map(req => ({
      name: req.name || '',
      method: req.method || 'GET',
      url: req.url || '',
      headers: toObj(req.headers),
      cookies: toObj(req.cookies),
      body: req.body || '',
      ai_desc: req.ai_desc || '',
      tags: req.tags,
    }));

    // Show name dialog.
    const countEl = document.getElementById('import-count');
    const nameEl = document.getElementById('import-name');
    const n = _pendingImport.length;
    countEl.textContent = n + ' request' + (n === 1 ? '' : 's') + ' ready to import.';
    const baseName = _pendingImport[0].name || file.name.replace(/\.json$/i, '') || 'Imported request';
    nameEl.value = n === 1 ? baseName : baseName + ' (batch)';
    document.getElementById('import-dialog').classList.remove('hidden');
    setTimeout(() => nameEl.select(), 50);
    input.value = '';
  };
  reader.readAsText(file);
}

async function closeImportDialog(action) {
  const dlg = document.getElementById('import-dialog');
  if (!dlg.classList.contains('hidden')) dlg.classList.add('hidden');
  if (!action || !_pendingImport) { _pendingImport = null; return; }

  const items = _pendingImport;
  _pendingImport = null;

  // Open as new request tabs.
  if (action === 'tabs') {
    items.forEach(req => addRequestTab(req));
    showToast(`Opened ${items.length} tab(s)`, 'success');
    return;
  }

  // Save to sidebar.
  const name = document.getElementById('import-name').value.trim() || 'Imported request';
  let created = 0;
  await Promise.all(items.map((req, i) => {
    const finalName = items.length === 1 ? name : `${name} ${i + 1}`;
    return createSavedRequest({ ...req, name: finalName }).then(r => { if (r && r.id) created++; });
  }));

  // Switch sidebar to Requests panel and refresh.
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('.sidebar-tab[data-stab="requests"]').classList.add('active');
  document.getElementById('stab-requests').classList.add('active');
  await renderSidebar();
  showToast(`Imported ${created} request(s) — saved to Requests in sidebar`, 'success');
}

// ── Apply request (used by history click) ────────────────────────────────────

function applyRequestToTab(id, req) {
  clearFile(id);
  document.getElementById('method-' + id).value = req.method || 'GET';
  updateBodyVisibility(id);
  document.getElementById('url-' + id).value = req.url || '';
  setHeaders(id, req.headers || {});
  setCookies(id, req.cookies || {});
  document.getElementById('body-' + id).value = req.body || '';
  const aiDesc = document.getElementById('ai-desc-' + id);
  if (aiDesc) aiDesc.value = req.ai_desc || '';
}

function applyRequest(req) {
  addRequestTab(req);
}

// ── Sidebar tab switching ───────────────────────────────────────────────────

document.querySelectorAll('.sidebar-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('stab-' + btn.dataset.stab).classList.add('active');
  });
});

// ── Admin button (conditional) ──────────────────────────────────────────────

async function checkAdmin() {
  try {
    const r = await fetch(API_BASE + '/api/admin/check');
    if (r.ok) {
      const d = await r.json();
      if (d.admin) {
        const btn = document.getElementById('admin-btn');
        if (btn) {
          btn.style.display = '';
          btn.addEventListener('click', () => { window.location.href = '/admin'; });
        }
      }
    }
  } catch {}
}

// ── Init ────────────────────────────────────────────────────────────────────

(async function init() {
  await loadSession();
  if (isLoggedIn()) await loadEnvKeyIfPresent();
  await loadSettings();
  _envList = await fetchEnvVars();
  console.log('[sync] init env count:', _envList.length);
  renderEnv();
  await renderSidebar();
  await renderHistory();
  renderHeaderAuth();
  checkAdmin();
  addRequestTab(null); // open a blank request tab on startup
  bindEyeToggles(); // attach eye toggles to all password fields

  // Enter key in auth dialog submits
  ['auth-username', 'auth-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doAuthSubmit(); }
    });
  });

  // Close auth dialog on backdrop click
  const authDialog = document.getElementById('auth-dialog');
  if (authDialog) {
    authDialog.addEventListener('click', e => {
      if (e.target === authDialog) closeAuthDialog();
    });
  }
})();