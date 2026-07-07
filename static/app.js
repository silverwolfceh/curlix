// ── Environment variables ─────────────────────────────────────────────────────

const ENV_KEY = 'openpostman:env';

function loadEnv() {
  try { return JSON.parse(localStorage.getItem(ENV_KEY)) || []; }
  catch { return []; }
}

function persistEnv() {
  const rows = document.querySelectorAll('.env-row');
  const env = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const k = inputs[0].value.trim();
    const v = inputs[1].value;
    if (k) env.push({ k, v });
  });
  localStorage.setItem(ENV_KEY, JSON.stringify(env));
}

function getEnvMap() {
  const map = {};
  loadEnv().forEach(({ k, v }) => { map[k] = v; });
  return map;
}

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
    <button class="btn-remove" title="Remove" onclick="this.parentElement.remove(); persistEnv()">×</button>
  `;
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', persistEnv));
  document.getElementById('env-list').appendChild(row);
  persistEnv();
}

function renderEnv() {
  document.getElementById('env-list').innerHTML = '';
  loadEnv().forEach(({ k, v }) => addEnvRow(k, v));
}

// Sidebar tab switching
document.querySelectorAll('.sidebar-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('stab-' + btn.dataset.stab).classList.add('active');
  });
});

renderEnv();

// ── Theme ─────────────────────────────────────────────────────────────────────

(function initTheme() {
  const stored = localStorage.getItem('openpostman:theme');
  if (stored === 'light') applyTheme('light');
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
  localStorage.setItem('openpostman:theme', next);
  applyTheme(next);
}

// ── Settings tab ──────────────────────────────────────────────────────────────

const SETTINGS_TAB_ID = 'settings';

function openSettingsTab() {
  // If already open, just focus it
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

      <div class="settings-section">
        <div class="settings-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>AI Settings
        </div>
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
      </div>

      <div class="settings-section">
        <div class="settings-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Authentication
        </div>
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
      </div>

      <div class="settings-section">
        <div class="settings-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Proxy
        </div>
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
      </div>

      <button class="btn-primary settings-save-btn" onclick="saveSettings()">Save settings</button>
      <span id="settings-saved-msg" class="settings-saved-msg hidden">Saved.</span>
    </div>
  `;
  document.getElementById('req-panels').appendChild(panel);

}

function closeSettingsTab(e) {
  e.stopPropagation();
  document.getElementById('tab-btn-' + SETTINGS_TAB_ID)?.remove();
  document.getElementById('panel-' + SETTINGS_TAB_ID)?.remove();
  // Switch to last request tab
  if (tabs.length) switchToTab(tabs[tabs.length - 1].id);
}

const SETTINGS_KEYS = [
  'ai-base', 'ai-key', 'ai-model', 'ai-call', 'ai-response-style',
  'auth-ntid', 'auth-password',
  'proxy-url', 'proxy-user', 'proxy-pass',
];

function loadSettingsValues() {
  SETTINGS_KEYS.forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    const stored = localStorage.getItem('openpostman:' + key);
    if (stored !== null) el.value = stored;
  });
}

function saveSettings() {
  SETTINGS_KEYS.forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    localStorage.setItem('openpostman:' + key, el.value);
  });
  // Default AI settings fallback
  if (!localStorage.getItem('openpostman:ai-model')) {
    localStorage.setItem('openpostman:ai-model', 'gpt-4o-mini');
    document.getElementById('ai-model').value = 'gpt-4o-mini';
  }
  if (!localStorage.getItem('openpostman:ai-call')) {
    localStorage.setItem('openpostman:ai-call', 'responses');
    const el = document.getElementById('ai-call');
    if (el) el.value = 'responses';
  }
  if (!localStorage.getItem('openpostman:ai-response-style')) {
    localStorage.setItem('openpostman:ai-response-style', 'strict_json');
    const el = document.getElementById('ai-response-style');
    if (el) el.value = 'strict_json';
  }
  refreshAiAssistHints();
  const msg = document.getElementById('settings-saved-msg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2000);
}

// Helpers used by generateRequest — read from localStorage directly since
// the settings panel may not be open
function getAiBase()          { return localStorage.getItem('openpostman:ai-base') || ''; }
function getAiKey()           { return localStorage.getItem('openpostman:ai-key') || ''; }
function getAiModel()         { return localStorage.getItem('openpostman:ai-model') || 'gpt-4o-mini'; }
function getAiCall()          { return localStorage.getItem('openpostman:ai-call') || 'responses'; }
function getAiResponseStyle() { return localStorage.getItem('openpostman:ai-response-style') || 'strict_json'; }

function aiCallLabel(v) {
  return v === 'completions' ? 'Completions' : 'Responses';
}

function aiStyleLabel(v) {
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

// ── Multi-tab request system ──────────────────────────────────────────────────

let tabCounter = 0;
let activeTabId = null;
const tabs = []; // { id, label }

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
    </div>
    <div id="headers-list-${id}" class="headers-list"></div>

    <div class="section-label">
      Cookies
      <button class="btn-small" onclick="addCookie('${id}')">+ Add</button>
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
        <textarea id="ai-desc-${id}" placeholder="Describe your request… e.g. POST a JSON body with name=Alice to httpbin.org/post"></textarea>
        <div class="ai-assist-actions">
          <button id="ai-fill-btn-${id}" class="btn-primary" onclick="generateRequest('${id}')">Fill form</button>
          <span id="ai-error-${id}" class="error hidden"></span>
        </div>
        <div id="ai-log-${id}" class="ai-log hidden"></div>
      </div>
    </div>
  `;
  document.getElementById('req-panels').appendChild(panel);

  // Wire up method change
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
  // Insert before the + button
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
  if (tabs.length === 1) return; // keep at least one
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

// ── Per-tab helpers ───────────────────────────────────────────────────────────

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
  // If AI returned a flat object already, check if any value contains '; ' — meaning
  // it packed multiple cookies into one entry. Flatten everything into a proper map.
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
      // If the key itself contains '=' it was packed as a raw string into the key
      if (k.includes('=') || k.includes(';')) {
        parseStr(k + (v ? '=' + v : ''));
      } else if (typeof v === 'string' && v.includes(';') && v.includes('=')) {
        // Value looks like "v1; key2=v2; key3=v3" — the whole cookie string ended up as one value
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

function toggleRespHeaders(id) {
  document.getElementById('resp-headers-' + id).classList.toggle('hidden');
}

function toggleAiAssist(id) {
  const body = document.getElementById('ai-assist-body-' + id);
  const caret = document.getElementById('ai-assist-caret-' + id);
  const hidden = body.classList.toggle('hidden');
  caret.textContent = hidden ? '▸' : '▾';
}

// ── Send request ──────────────────────────────────────────────────────────────

async function sendRequest(id) {
  const method = document.getElementById('method-' + id).value;
  const url = resolveVars(document.getElementById('url-' + id).value.trim());
  if (!url) { alert('Please enter a URL.'); return; }

  const rawHeaders = getHeaders(id);
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).map(([k, v]) => [resolveVars(k), resolveVars(v)])
  );
  const bodyText = resolveVars(document.getElementById('body-' + id).value.trim());

  // Update tab label to show URL
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

  const payload = {
    url, method, headers, body: bodyText, cookies,
    use_proxy:    useProxy,
    proxy_url:    localStorage.getItem('openpostman:proxy-url')  || '',
    proxy_user:   localStorage.getItem('openpostman:proxy-user') || '',
    proxy_pass:   localStorage.getItem('openpostman:proxy-pass') || '',
    use_ntlm:     useNtlm,
    ntlm_user:    localStorage.getItem('openpostman:auth-ntid')     || '',
    ntlm_pass:    localStorage.getItem('openpostman:auth-password')  || '',
    use_kerberos: useKerberos,
    kerberos_spn: localStorage.getItem('openpostman:auth-kerberos-spn') || '',
  };

  const t0 = Date.now();
  try {
    const proxyResp = await fetch('/api/proxy', {
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
    pushHistory({ method, url, headers: rawHeaders, body: document.getElementById('body-' + id).value, status: data.status });

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

// ── Missing vars dialog ───────────────────────────────────────────────────────

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
    const env = loadEnv();
    inputs.forEach(input => {
      const name = input.dataset.varname;
      const val = input.value;
      const idx = env.findIndex(e => e.k === name);
      if (idx >= 0) env[idx].v = val;
      else env.push({ k: name, v: val });
    });
    localStorage.setItem(ENV_KEY, JSON.stringify(env));
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

// ── AI fill (per tab) ─────────────────────────────────────────────────────────

function aiLog(id, msg, type) {
  console.log('[AI]', msg);
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

  console.log('[AI] generateRequest called', { id, apiBase, model, callAi, responseStyle, hasKey: !!apiKey, description });

  document.getElementById('ai-error-' + id).classList.add('hidden');
  aiLogClear(id);

  if (!apiBase) { console.warn('[AI] missing apiBase'); showAiError(id, 'API Base URL is required. Open Settings in the header.'); return; }
  if (!apiKey)  { console.warn('[AI] missing apiKey');  showAiError(id, 'API Key is required. Open Settings in the header.'); return; }
  if (!description) { console.warn('[AI] missing description'); showAiError(id, 'Please describe your request.'); return; }

  const btn = document.getElementById('ai-fill-btn-' + id);
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating…';

  aiLog(id, 'Sending request to ' + apiBase + ' (model: ' + model + ', api: ' + callAi + ', style: ' + responseStyle + ')');
  const useProxy = document.getElementById('opt-proxy-' + id).checked;
  const proxy = useProxy ? (localStorage.getItem('openpostman:proxy-url') || '') : null;
  try {
    const t0 = Date.now();
    const resp = await fetch('/api/ai-fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description, api_base: apiBase, api_key: apiKey, model,
        call_ai: callAi,
        response_style: responseStyle,
        proxy_url:  proxy,
        proxy_user: localStorage.getItem('openpostman:proxy-user') || null,
        proxy_pass: localStorage.getItem('openpostman:proxy-pass') || null,
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
      aiLog(id, 'Found ' + missing.length + ' placeholder(s) — prompting for values');
      await promptMissingVars(missing);
    }

    aiLog(id, 'Done.', 'ok');
  } catch (err) {
    console.error('[AI] fetch error:', err);
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

// ── History ───────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'openpostman:history';
const HISTORY_MAX = 100;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

function pushHistory(entry) {
  const list = loadHistory();
  list.unshift(entry);
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  renderHistory();
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  const el = document.getElementById('history-list');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="history-empty">No requests yet</div>';
    return;
  }
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'saved-item';
    const statusClass = !item.status ? '' : item.status < 400 ? 'hist-ok' : 'hist-err';
    const statusText = item.status ? item.status : '—';
    row.innerHTML = `
      <span class="saved-item-method">${item.method}</span>
      <span class="saved-item-name" title="${escAttr(item.url)}">${escAttr(item.url)}</span>
      <span class="hist-status ${statusClass}">${statusText}</span>
    `;
    row.addEventListener('click', () => applyRequest(item));
    el.appendChild(row);
  });
}

// ── Saved requests ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'openpostman:saved';

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

function persistSaved(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function currentRequest() {
  const id = activeTabId;
  return {
    method: document.getElementById('method-' + id).value,
    url: document.getElementById('url-' + id).value,
    headers: getHeaders(id),
    cookies: getCookies(id),
    body: document.getElementById('body-' + id).value,
  };
}

function applyRequestToTab(id, req) {
  document.getElementById('method-' + id).value = req.method || 'GET';
  updateBodyVisibility(id);
  document.getElementById('url-' + id).value = req.url || '';
  setHeaders(id, req.headers || {});
  setCookies(id, req.cookies || {});
  document.getElementById('body-' + id).value = req.body || '';
}

function applyRequest(req) {
  // Open in a new tab
  addRequestTab(req);
}

function renderSidebar() {
  const list = loadSaved();
  const el = document.getElementById('saved-list');
  el.innerHTML = '';
  list.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'saved-item';
    row.innerHTML = `
      <span class="saved-item-method">${item.method}</span>
      <span class="saved-item-name" title="${escAttr(item.url)}">${escAttr(item.name)}</span>
      <button class="saved-item-del" title="Delete" onclick="deleteRequest(${i}, event)">×</button>
    `;
    row.addEventListener('click', () => applyRequest(item));
    el.appendChild(row);
  });
}

function deleteRequest(i, e) {
  e.stopPropagation();
  const list = loadSaved();
  list.splice(i, 1);
  persistSaved(list);
  renderSidebar();
}

// Save dialog
function saveRequest() {
  const url = document.getElementById('url-' + activeTabId).value.trim();
  document.getElementById('save-name').value = url || '';
  document.getElementById('save-dialog').classList.remove('hidden');
  setTimeout(() => document.getElementById('save-name').select(), 50);
}

function closeSaveDialog() {
  document.getElementById('save-dialog').classList.add('hidden');
}

function confirmSave() {
  const name = document.getElementById('save-name').value.trim();
  if (!name) return;
  const list = loadSaved();
  const req = { name, ...currentRequest() };
  const existing = list.findIndex(r => r.name === name);
  if (existing >= 0) list[existing] = req;
  else list.push(req);
  persistSaved(list);
  renderSidebar();
  closeSaveDialog();
}

document.getElementById('save-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmSave();
  if (e.key === 'Escape') closeSaveDialog();
});

document.getElementById('save-dialog').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSaveDialog();
});

// ── Export / Import ───────────────────────────────────────────────────────────

function exportAll() {
  const list = loadSaved();
  if (!list.length) { alert('No saved requests to export.'); return; }
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'open-postman-requests.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!Array.isArray(imported)) throw new Error('Expected a JSON array');
      const list = loadSaved();
      imported.forEach(req => {
        if (!req.name) return;
        const idx = list.findIndex(r => r.name === req.name);
        if (idx >= 0) list[idx] = req;
        else list.push(req);
      });
      persistSaved(list);
      renderSidebar();
      alert(`Imported ${imported.length} request(s).`);
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
    input.value = '';
  };
  reader.readAsText(file);
}

// ── Init ──────────────────────────────────────────────────────────────────────

addRequestTab();
renderSidebar();
renderHistory();
