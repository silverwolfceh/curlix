// ── v2.0: API-based storage (SQLite backend) ───────────────────────────────

const API_BASE = '';

// ── User identity (UUID) ────────────────────────────────────────────────────

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? m[2] : null;
}

function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = name + '=' + value + '; expires=' + expires + '; path=/; SameSite=Lax';
}

let _currentUserId = null;

async function initUserId() {
  let uid = getCookie('opm_uid');
  if (!uid) {
    const header = document.querySelector('meta[name="x-user-id"]')?.content;
    if (header) uid = header;
  }
  if (!uid) {
    uid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    setCookie('opm_uid', uid, 365);
  }
  _currentUserId = uid;
  // Check if user exists, auto-create if not
  try {
    const r = await fetch(API_BASE + '/api/user/info');
    if (!r.ok) {
      // Auto-create by calling switch-device
      const r2 = await fetch(API_BASE + '/api/switch-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: uid }),
      });
      if (r2.ok) {
        const d = await r2.json();
        _currentUserId = d.user_id;
        setCookie('opm_uid', d.user_id, 365);
      }
    }
  } catch (e) {
    console.warn('[user] init failed:', e);
  }
  return _currentUserId;
}

function getApiHeaders(extra = {}) {
  const h = { 'X-User-ID': _currentUserId, ...extra };
  const adminToken = localStorage.getItem('curlix:admin-token');
  if (adminToken) h['Authorization'] = 'Bearer ' + adminToken;
  return h;
}

async function apiFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...getApiHeaders(opts.headers) };
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) {
    // Token expired or not logged in — clear and redirect
    localStorage.removeItem('curlix:admin-token');
    window.location.href = '/admin';
    return null;
  }
  return r;
}

// ── Environment variables ───────────────────────────────────────────────────

async function fetchEnvVars() {
  try {
    const r = await apiFetch(API_BASE + '/api/env-vars');
    if (!r.ok) return [];
    const data = await r.json();
    return data.map(e => ({ k: e.key, v: e.value }));
  } catch { return []; }
}

async function persistEnvVars(env) {
  try {
    await apiFetch(API_BASE + '/api/env-vars', {
      method: 'PUT',
      body: JSON.stringify(env.filter(e => e.k.trim())),
    });
  } catch (e) { console.error('[env] save failed:', e); }
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
    <input type="text" placeholder="value" value="${escAttr(v)}" />
    <button class="btn-remove" title="Remove" onclick="this.parentElement.remove(); persistEnvFromUI()">×</button>
  `;
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', persistEnvFromUI));
  document.getElementById('env-list').appendChild(row);
  persistEnvFromUI();
}

function persistEnvFromUI() {
  const rows = document.querySelectorAll('.env-row');
  const env = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const k = inputs[0].value.trim();
    const v = inputs[1].value;
    if (k) env.push({ k, v });
  });
  _envList = env;
  persistEnvVars(env);
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

// ── Saved requests (per user) ───────────────────────────────────────────────

async function fetchSavedRequests() {
  try {
    const r = await apiFetch(API_BASE + '/api/saved-requests');
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function createSavedRequest(data) {
  try {
    const r = await apiFetch(API_BASE + '/api/saved-requests', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return await r.json();
  } catch (e) { console.error('[request] create failed:', e); return null; }
}

async function deleteSavedRequest(id) {
  try {
    await apiFetch(API_BASE + '/api/saved-requests/' + id, { method: 'DELETE' });
  } catch (e) { console.error('[request] delete failed:', e); }
}

// ── History (per user) ──────────────────────────────────────────────────────

async function fetchHistory(limit = 100, offset = 0) {
  try {
    const r = await apiFetch(API_BASE + '/api/history?limit=' + limit + '&offset=' + offset);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function pushHistoryEntry(entry) {
  try {
    await apiFetch(API_BASE + '/api/history', {
      method: 'POST',
      body: JSON.stringify(entry),
    });
    // Refresh history sidebar so the new entry shows up.
    renderHistory();
  } catch (e) { console.error('[history] push failed:', e); }
}

// ── Rename handle ───────────────────────────────────────────────────────────

async function renameHandle(newHandle) {
  try {
    const r = await apiFetch(API_BASE + '/api/user/rename', {
      method: 'POST',
      body: JSON.stringify({ handle: newHandle }),
    });
    if (r.ok) {
      _currentUserId = r.headers.get('x-user-id') || _currentUserId;
      return { ok: true };
    }
    const d = await r.json();
    return { ok: false, error: d.detail || 'Failed to rename' };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Switch device ───────────────────────────────────────────────────────────

async function switchDevice(identity) {
  try {
    const r = await apiFetch(API_BASE + '/api/switch-device', {
      method: 'POST',
      body: JSON.stringify({ identity }),
    });
    if (r.ok) {
      const d = await r.json();
      _currentUserId = d.user_id;
      setCookie('opm_uid', d.user_id, 365);
      return { ok: true };
    }
    const d = await r.json();
    return { ok: false, error: d.detail || 'Identity not found' };
  } catch (e) { return { ok: false, error: e.message }; }
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
  const showBtn = document.getElementById('sidebar-show');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (hidden) {
    sidebar.classList.add('sidebar-hidden');
    if (showBtn) showBtn.classList.remove('hidden');
    if (backdrop) backdrop.classList.add('hidden');
  } else {
    sidebar.classList.remove('sidebar-hidden');
    if (showBtn) showBtn.classList.add('hidden');
    // On mobile, show backdrop when sidebar open
    if (backdrop && window.matchMedia('(max-width: 768px)').matches) {
      backdrop.classList.remove('hidden');
    } else if (backdrop) {
      backdrop.classList.add('hidden');
    }
  }
  const toggle = document.getElementById('sidebar-toggle');
  if (toggle) toggle.textContent = hidden ? '▶' : '◀';
}

function toggleSidebar() {
  const hidden = !document.getElementById('sidebar').classList.contains('sidebar-hidden');
  localStorage.setItem('curlix:sidebar-hidden', hidden ? '1' : '0');
  applySidebarState(hidden);
}

(function initSidebar() {
  const hidden = localStorage.getItem('curlix:sidebar-hidden') === '1';
  applySidebarState(hidden);
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Identity
        </summary>
        <div class="settings-desc">Your device identity. Change your handle for easier recall.</div>
        <div class="settings-fields">
          <div class="settings-field">
            <label>Current Handle</label>
            <input id="user-handle" type="text" readonly />
          </div>
          <div class="settings-field">
            <label>Rename Handle</label>
            <div style="display:flex;gap:8px">
              <input id="user-new-handle" type="text" placeholder="my-custom-name" style="flex:1" />
              <button class="btn-primary" onclick="doRename()">Rename</button>
            </div>
          </div>
          <div class="settings-field">
            <label>Switch Device</label>
            <div style="display:flex;gap:8px">
              <input id="user-device-identity" type="text" placeholder="paste UUID or alias" style="flex:1" />
              <button class="btn-primary" onclick="doSwitchDevice()">Switch</button>
            </div>
          </div>
        </div>
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

  // User info
  try {
    const r = await apiFetch(API_BASE + '/api/user/info');
    if (r.ok) {
      const d = await r.json();
      document.getElementById('user-handle').value = d.handle || d.user_id;
    }
  } catch {}
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

// ── Rename / Switch ─────────────────────────────────────────────────────────

async function doRename() {
  const input = document.getElementById('user-new-handle');
  const handle = input.value.trim();
  if (handle.length < 3) { showToast('Handle must be at least 3 characters', 'error'); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(handle)) { showToast('Only letters, numbers, _ and - allowed', 'error'); return; }

  const btn = input.nextElementSibling;
  btn.disabled = true;
  btn.textContent = '…';

  const result = await renameHandle(handle);
  if (result.ok) {
    showToast('Handle renamed to ' + handle, 'success');
    document.getElementById('user-handle').value = handle;
    input.value = '';
  } else {
    showToast(result.error || 'Rename failed', 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Rename';
}

async function doSwitchDevice() {
  const input = document.getElementById('user-device-identity');
  const identity = input.value.trim();
  if (!identity) { showToast('Enter UUID or alias', 'error'); return; }

  const btn = input.nextElementSibling;
  btn.disabled = true;
  btn.textContent = '…';

  const result = await switchDevice(identity);
  if (result.ok) {
    showToast('Switched to ' + _currentUserId, 'success');
    // Reload page to pick up new identity
    setTimeout(() => window.location.reload(), 1000);
  } else {
    showToast(result.error || 'Switch failed', 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Switch';
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
      <button id="send-btn-${id}" class="btn-primary" onclick="sendRequest('${id}')">Send</button>
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
          <button id="ai-fill-btn-${id}" class="btn-primary" onclick="generateRequest('${id}')">Fill form</button>
          <span id="ai-error-${id}" class="error hidden"></span>
        </div>
        <div id="ai-log-${id}" class="ai-log hidden"></div>
      </div>
    </div>
  `;
  document.getElementById('req-panels').appendChild(panel);

  document.getElementById('method-' + id).addEventListener('change', () => updateBodyVisibility(id));
  updateBodyVisibility(id);
  addHeader(id, 'Content-Type', 'application/json');
  refreshAiAssistHint(id);
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
  Object.entries(obj || {}).forEach(([k, v]) => addHeader(id, k, v));
}

function toggleAiAssist(id) {
  const body = document.getElementById('ai-assist-body-' + id);
  const caret = document.getElementById('ai-assist-caret-' + id);
  const hidden = body.classList.toggle('hidden');
  caret.textContent = hidden ? '▸' : '▾';
}

// ── Send request ────────────────────────────────────────────────────────────

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
  const payload = {
    url, method, headers, body: bodyText, cookies,
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

    // Push to server history
    pushHistoryEntry({
      user_id: _currentUserId,
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
        <input type="${isSecret ? 'password' : 'text'}" data-varname="${escAttr(name)}" placeholder="${escAttr(name)}" />
      `;
      container.appendChild(wrap);
    });
    document.getElementById('vars-dialog').classList.remove('hidden');
    container.querySelector('input')?.focus();
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

  aiLog(id, 'Sending request to ' + (apiBase || '(server default)') + ' (model: ' + (model || 'gpt-4o-mini') + ')');

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
    btn.textContent = 'Fill form';
  }
}

function showAiError(id, msg) {
  const el = document.getElementById('ai-error-' + id);
  el.textContent = msg;
  el.classList.remove('hidden');
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
    const entry = { method: item.method, url: item.url, headers: JSON.parse(item.request_headers || '{}'), cookies: JSON.parse(item.request_cookies || '{}'), body: item.request_body || '' };
    row.addEventListener('click', () => addRequestTab(entry));
    el.appendChild(row);
  });
}

async function clearHistory() {
  try {
    await apiFetch(API_BASE + '/api/history', { method: 'DELETE' });
    await renderHistory();
    showToast('History cleared', 'success');
  } catch (e) {
    showToast('Failed to clear history', 'error');
  }
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
    const req = { method: item.method, url: item.url, headers: JSON.parse(item.headers || '{}'), cookies: JSON.parse(item.cookies || '{}'), body: item.body || '', ai_desc: item.ai_desc || '' };
    row.addEventListener('click', () => addRequestTab(req));
    el.appendChild(row);
  });
}

async function doDeleteSavedRequest(id, e) {
  e.stopPropagation();
  await deleteSavedRequest(id);
  renderSidebar();
  showToast('Request deleted', 'success');
}

function saveRequest() {
  const url = document.getElementById('url-' + activeTabId).value.trim();
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

  const id = activeTabId;
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
  await initUserId();
  await loadSettings();
  _envList = await fetchEnvVars();
  renderEnv();
  await renderSidebar();
  await renderHistory();
  checkAdmin();
})();