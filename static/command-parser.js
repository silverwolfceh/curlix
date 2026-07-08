// ── Command parser (curl / bash / PowerShell / Node.js) ──────────────────────

function b64encode(str) {
  try { return btoa(unescape(encodeURIComponent(str))); } catch { return ''; }
}

function parseCookieHeader(str) {
  const c = {};
  str.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) c[k] = v;
  });
  return c;
}

// Tokenize a shell-like string (handles quotes, backslash escapes, line continuations)
function shellTokens(str) {
  const tokens = [], cur = ''; let i = 0;
  let inSingle = false, inDouble = false, curStr = '';
  const push = () => { if (curStr) { tokens.push(curStr); curStr = ''; } };
  while (i < str.length) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") { inSingle = false; i++; continue; }
      curStr += c; i++; continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < str.length) { curStr += str[i + 1]; i += 2; continue; }
      if (c === '"') { inDouble = false; i++; continue; }
      curStr += c; i++; continue;
    }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === '\\' && i + 1 < str.length && str[i + 1] === '\n') { i += 2; continue; }
    if (c === '\\' && i + 1 < str.length) { curStr += str[i + 1]; i += 2; continue; }
    if (/\s/.test(c)) { push(); i++; continue; }
    curStr += c; i++;
  }
  push();
  return tokens;
}

function normalizeWindowsCurl(text) {
  // Windows cmd.exe "Copy as cURL" uses ^ as escape char:
  //   ^"  -> " (quote), ^^ -> ^ (caret), ^& -> & (ampersand), etc.
  //   ^ at end of line -> line continuation (join lines).
  // Apply BEFORE shell tokenization so ^-quoting is understood.
  return text
    .replace(/\^\s*\n/g, ' ')   // ^ + whitespace + newline -> space (join lines)
    .replace(/\^(.)/g, '$1');     // ^X -> X (remove caret, keep next char)
}

function parseCurl(text) {
  text = normalizeWindowsCurl(text);
  const tokens = shellTokens(text);
  let idx = tokens.findIndex(t => /^curl$/i.test(t));
  if (idx === -1) idx = 0; else idx++;
  const req = { method: 'GET', url: '', headers: {}, cookies: {}, body: '' };
  const valOpts = new Set(['-X','--request','-H','--header','-d','--data','--data-raw','--data-binary','--data-ascii','--data-urlencode','-b','--cookie','--url','-u','--user','-A','--user-agent','-e','--referer','-F','--form','--form-string','-o','--output','-x','--proxy','-U','--proxy-user','-w','--write-out','--resolve','-m','--max-time','--connect-timeout','--retry','-UserAgent','-User-Agent','-ContentType','-Content-Type','-Method','-Uri','-Body','-Cookie']);
  for (let i = idx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-X' || t === '--request') { req.method = (tokens[++i] || 'GET').toUpperCase(); }
    else if (t === '-H' || t === '--header') {
      const h = tokens[++i] || '';
      const sep = h.indexOf(':');
      if (sep !== -1) {
        const k = h.slice(0, sep).trim();
        const v = h.slice(sep + 1).trim();
        if (/^cookie$/i.test(k)) Object.assign(req.cookies, parseCookieHeader(v));
        else req.headers[k] = v;
      }
    }
    else if (t === '-b' || t === '--cookie') {
      const c = tokens[++i] || '';
      if (c.includes('=')) Object.assign(req.cookies, parseCookieHeader(c));
    }
    else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
      const b = tokens[++i] || '';
      req.body = req.body ? req.body + '&' + b : b;
      if (req.method === 'GET') req.method = 'POST';
    }
    else if (t === '--url') { req.url = tokens[++i] || req.url; }
    else if (t === '-u' || t === '--user') {
      req.headers['Authorization'] = 'Basic ' + b64encode(tokens[++i] || '');
    }
    else if (t === '-A' || t === '--user-agent') { req.headers['User-Agent'] = tokens[++i] || ''; }
    else if (t === '-e' || t === '--referer') { req.headers['Referer'] = tokens[++i] || ''; }
    else if (valOpts.has(t)) { i++; }
    else if (t.startsWith('-')) { /* flag-only, skip */ }
    else if (!req.url) { req.url = t; }
  }
  return req;
}

// ── PowerShell parser ───────────────────────────────────────────────────────
// Handles Invoke-WebRequest / Invoke-RestMethod with:
//   -Uri, -Method, -Headers @{...}, -Body "...", -ContentType "..."
// Backtick escapes: `" -> ", `` -> `, etc.

// Find a PowerShell parameter value: -Flag "value" or -Flag 'value' or -Flag bareword.
// Handles backtick escapes (`" -> ", `` -> `). Returns the value string or null.
function psParamValue(text, flag) {
  const re = new RegExp(flag + "\\s+", "i");
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return null;
  let val = '';
  if (text[i] === '"' || text[i] === "'") {
    const q = text[i];
    i++; // skip opening quote
    while (i < text.length) {
      const c = text[i];
      // PowerShell backtick escape: `" -> ", `` -> `, `$ -> $, etc.
      if (c === '`' && i + 1 < text.length) {
        val += text[i + 1];
        i += 2;
        continue;
      }
      // Standard backslash escape inside double quotes
      if (q === '"' && c === '\\' && i + 1 < text.length) {
        val += text[i + 1];
        i += 2;
        continue;
      }
      if (c === q) { i++; break; } // closing quote
      val += c;
      i++;
    }
  } else {
    // Bareword: read until whitespace or backtick line-continuation
    while (i < text.length && !/\s/.test(text[i])) {
      if (text[i] === '`' && i + 1 < text.length && text[i + 1] === '\n') { i += 2; continue; }
      val += text[i];
      i++;
    }
  }
  return val;
}

function psQuoted(text, flag) {
  return psParamValue(text, flag);
}

function psFlags(text, flag) {
  return psParamValue(text, flag);
}

// Parse a PowerShell hashtable @{ "key"="val"; 'key2'='val2' } using char-by-char.
// Handles nested braces, quoted strings with backtick escapes.
function psHeaders(text) {
  const headers = {};
  const re = /-Headers\s*@\{/i;
  const m = re.exec(text);
  if (!m) return headers;
  let i = m.index + m[0].length;
  // Brace matching with string awareness
  let depth = 1;
  let inStr = false, q = '';
  const entryStart = i;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (inStr) {
      if (c === '`' && i + 1 < text.length) { i += 2; continue; }
      if (c === '\\' && i + 1 < text.length) { i += 2; continue; }
      if (c === q) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  const block = text.slice(entryStart, i);
  // Parse key=value pairs from the block
  let j = 0;
  while (j < block.length) {
    // Skip whitespace and semicolons
    while (j < block.length && /[\s;]/.test(block[j])) j++;
    if (j >= block.length) break;
    // Parse key (quoted or bareword)
    let key = '';
    if (block[j] === '"' || block[j] === "'") {
      const q2 = block[j++];
      while (j < block.length && block[j] !== q2) {
        if (block[j] === '`' && j + 1 < block.length) { key += block[j + 1]; j += 2; continue; }
        if (block[j] === '\\' && j + 1 < block.length) { key += block[j + 1]; j += 2; continue; }
        key += block[j++];
      }
      j++; // skip closing quote
    } else {
      while (j < block.length && /[\w$.-]/.test(block[j])) key += block[j++];
    }
    // Skip whitespace and = sign
    while (j < block.length && /[\s=]/.test(block[j])) j++;
    // Parse value (quoted or bareword)
    let val = '';
    if (j < block.length && (block[j] === '"' || block[j] === "'")) {
      const q2 = block[j++];
      while (j < block.length && block[j] !== q2) {
        if (block[j] === '`' && j + 1 < block.length) {
          const next = block[j + 1];
          if (next === '"' || next === "'" || next === '`') { val += next; j += 2; continue; }
          val += next; j += 2; continue;
        }
        if (block[j] === '\\' && j + 1 < block.length) { val += block[j + 1]; j += 2; continue; }
        val += block[j++];
      }
      j++; // skip closing quote
    } else {
      while (j < block.length && block[j] !== ';' && block[j] !== '\n' && block[j] !== '}') val += block[j++];
      val = val.trim();
    }
    if (key) headers[key] = val;
  }
  return headers;
}

function parsePowerShell(text) {
  const req = { method: 'GET', url: '', headers: {}, cookies: {}, body: '' };
  const uri = psQuoted(text, '-Uri');
  if (uri) req.url = uri;
  const method = psFlags(text, '-Method');
  if (method) req.method = method.toUpperCase();
  Object.assign(req.headers, psHeaders(text));
  const body = psQuoted(text, '-Body');
  if (body) req.body = body;
  const contentType = psQuoted(text, '-ContentType') || psQuoted(text, '-Content-Type');
  if (contentType) req.headers['Content-Type'] = contentType;
  const ua = psQuoted(text, '-UserAgent') || psQuoted(text, '-User-Agent');
  if (ua) req.headers['User-Agent'] = ua;
  // $session.UserAgent = "..."
  const sua = text.match(/\.UserAgent\s*=\s*["']([^"']*)["']/i);
  if (sua && !req.headers['User-Agent']) req.headers['User-Agent'] = sua[1];
  const ck = req.headers['Cookie'] || req.headers['cookie'];
  if (ck) Object.assign(req.cookies, parseCookieHeader(ck));
  return req;
}

// ── JS object literal parser ─────────────────────────────────────────────────
// Parse a JS object literal string into a flat {key: value} map.
// Handles escaped quotes (\", \\), nested objects/arrays as raw text.
function parseJsObjectLiteral(text) {
  const obj = {};
  let i = 0;
  while (i < text.length && text[i] !== '{') i++;
  if (i >= text.length) return obj;
  i++; // skip {
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length || text[i] === '}') break;
    // Parse key
    let key = '';
    if (text[i] === '"' || text[i] === '\'') {
      const q = text[i++];
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\' && i + 1 < text.length) { key += text[i + 1]; i += 2; }
        else key += text[i++];
      }
      i++; // skip closing quote
    } else {
      while (i < text.length && /[\w$-]/.test(text[i])) key += text[i++];
    }
    while (i < text.length && /[\s:]/.test(text[i])) i++;
    if (i >= text.length) break;
    // Parse value
    let val = '';
    if (text[i] === '"' || text[i] === '\'') {
      const q = text[i++];
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\' && i + 1 < text.length) { val += text[i + 1]; i += 2; }
        else val += text[i++];
      }
      i++; // skip closing quote
    } else if (text[i] === '{' || text[i] === '[') {
      let depth = 1; val = text[i++];
      while (i < text.length && depth > 0) {
        if (text[i] === '{' || text[i] === '[') depth++;
        else if (text[i] === '}' || text[i] === ']') depth--;
        if (depth > 0) val += text[i];
        i++;
      }
    } else {
      while (i < text.length && text[i] !== ',' && text[i] !== '}') val += text[i++];
      val = val.trim();
    }
    if (key) obj[key] = val;
  }
  return obj;
}

function parseNodeFetch(text) {
  const req = { method: 'GET', url: '', headers: {}, cookies: {}, body: '' };
  const urlM = text.match(/fetch\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/i);
  if (urlM) req.url = urlM[1] !== undefined ? urlM[1] : urlM[2] !== undefined ? urlM[2] : urlM[3];
  // Extract the options object (2nd arg of fetch) using brace matching.
  const commaIdx = text.indexOf(',', text.indexOf('('));
  if (commaIdx !== -1) {
    let i = commaIdx + 1;
    while (i < text.length && /[\s]/.test(text[i])) i++;
    if (i < text.length && text[i] === '{') {
      let depth = 0, start = i, inStr = false, q = '';
      while (i < text.length) {
        const c = text[i];
        if (inStr) {
          if (c === '\\' && i + 1 < text.length) { i += 2; continue; }
          if (c === q) inStr = false;
        } else {
          if (c === '"' || c === '\'') { inStr = true; q = c; }
          else if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
        }
        i++;
      }
      const optsText = text.slice(start, i);
      const opts = parseJsObjectLiteral(optsText);
      if (opts.method) req.method = opts.method.toUpperCase();
      if (opts.body) req.body = opts.body;
      if (opts.headers) {
        const hdrs = parseJsObjectLiteral(opts.headers);
        Object.assign(req.headers, hdrs);
      }
    }
  }
  return req;
}

function parseAxios(text) {
  const req = { method: 'GET', url: '', headers: {}, cookies: {}, body: '' };
  const m1 = text.match(/axios\.\s*(get|post|put|delete|patch|request)\s*\(\s*['"]([^'"]+)['"]/i);
  if (m1) {
    const meth = m1[1].toLowerCase();
    req.method = meth === 'request' ? 'GET' : meth.toUpperCase();
    req.url = m1[2];
  }
  const cfgM = text.match(/headers\s*:\s*\{([\s\S]*?)\}/i);
  if (cfgM) Object.assign(req.headers, parseJsObjectLiteral('{' + cfgM[1] + '}'));
  const bM = text.match(/data\s*:\s*(?:'([^']*)'|"([^"]*)")/i);
  if (bM) req.body = bM[1] !== undefined ? bM[1] : bM[2];
  if (req.method === 'GET') {
    if (/axios\.\s*post/i.test(text)) req.method = 'POST';
    else if (/axios\.\s*put/i.test(text)) req.method = 'PUT';
    else if (/axios\.\s*patch/i.test(text)) req.method = 'PATCH';
    else if (/axios\.\s*delete/i.test(text)) req.method = 'DELETE';
  }
  return req;
}

function detectCommandType(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^curl\b/i.test(t) || /\bcurl\b.*\s(--?|['"]?https?:)/i.test(t)) return 'curl';
  if (/Invoke-WebRequest|Invoke-RestMethod|^iwr\b|^irm\b/i.test(t)) return 'powershell';
  if (/^fetch\s*\(|\bfetch\s*\(/i.test(t)) return 'node-fetch';
  if (/require\s*\(\s*['"]axios['"]|axios\.(get|post|put|delete|patch|request)\s*\(/i.test(t)) return 'axios';
  return null;
}

function applyParsedRequest(id, req) {
  if (req.method) {
    document.getElementById('method-' + id).value = req.method.toUpperCase();
    updateBodyVisibility(id);
  }
  if (req.url) document.getElementById('url-' + id).value = req.url;
  if (req.headers) setHeaders(id, req.headers);
  if (req.cookies && Object.keys(req.cookies).length) setCookies(id, req.cookies);
  if (req.body !== undefined) document.getElementById('body-' + id).value = req.body;
}
