import json
import logging
import asyncio
import uuid
import requests
from requests_kerberos import HTTPKerberosAuth, OPTIONAL
from requests_ntlm import HttpNtlmAuth
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
from urllib.parse import urlparse, urlunparse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from db import init_db, ensure_user, ensure_user_sync, get_settings, save_settings

app = FastAPI()
init_db()

# Auto-create default admin on first run
settings = get_settings()
admin = settings.get("admin")
if not admin:
    import hashlib, secrets
    salt = secrets.token_hex(16)
    pw_hash = f"{salt}${hashlib.sha256((salt + 'admin').encode()).hexdigest()}"
    settings["admin"] = {"username": "admin", "password_hash": pw_hash}
    save_settings(settings)
    logger.info("[main] Created default admin user")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── User resolution middleware ────────────────────────────────────────────────

@app.middleware("http")
async def resolve_user(request: Request, call_next):
    """Resolve user_id from cookie or header. Auto-create user. Set cookie."""
    # Skip user middleware for admin page and API endpoints
    if request.url.path == "/admin" or request.url.path.startswith("/api/"):
        return await call_next(request)

    user_id = request.cookies.get("opm_uid")
    if not user_id:
        header = request.headers.get("x-user-id", "")
        if header:
            user_id = header

    if not user_id:
        user_id = str(uuid.uuid4())

    resolved = ensure_user_sync(user_id)
    if resolved:
        user_id = resolved

    ensure_user(user_id)

    # Set BEFORE call_next so route handlers can access it
    request.state.user_id = user_id

    response = await call_next(request)
    existing_cookie = response.headers.get("set-cookie", "")
    if "opm_uid=" not in existing_cookie:
        response.set_cookie(
            key="opm_uid",
            value=user_id,
            path="/",
            httponly=True,
            samesite="lax",
            max_age=365 * 24 * 3600,
        )

    request.state.user_id = user_id
    return response


# ── Mount admin router ────────────────────────────────────────────────────────

from admin import router as admin_router
app.include_router(admin_router)


# ── Original v1 endpoints (kept for backward compat) ─────────────────────────

class ProxyRequest(BaseModel):
    url: str
    method: str = "GET"
    headers: dict = {}
    cookies: dict = {}
    body: str = ""
    use_proxy: bool = False
    proxy_url: Optional[str] = None
    proxy_user: Optional[str] = None
    proxy_pass: Optional[str] = None
    use_ntlm: bool = False
    ntlm_user: Optional[str] = None
    ntlm_pass: Optional[str] = None
    use_kerberos: bool = False
    kerberos_spn: Optional[str] = None


class AIFillRequest(BaseModel):
    description: str
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    model: str = "gpt-4o-mini"
    call_ai: str = "responses"
    response_style: str = "strict_json"
    proxy_url: Optional[str] = None
    proxy_user: Optional[str] = None
    proxy_pass: Optional[str] = None


SYSTEM_PROMPT = """You are an HTTP request builder. Given a natural language description or a curl command, return ONLY a valid JSON object with these exact fields:
{
  "url": "full URL including https://",
  "method": "GET|POST|PUT|PATCH|DELETE",
  "headers": {"Header-Name": "value"},
  "cookies": {"cookie-name": "value"},
  "body": "request body as string, empty string for GET"
}

Rules:
- Always include Content-Type in headers when body is non-empty
- Return ONLY the JSON object, no explanation, no markdown, no code blocks
- URL must be complete and valid
- If the input is a curl command, extract all -H headers into "headers", all -b / --cookie values into "cookies" as key/value pairs, the URL, method, and body exactly as given
- If a value is explicitly provided in the input (token, URL, header value, cookie value), use it exactly as-is — do NOT replace it with a placeholder
- Only use a {{PLACEHOLDER}} in UPPER_SNAKE_CASE for values that are truly missing or unknown. Examples: {{BASE_URL}}, {{AUTH_TOKEN}}, {{USER_ID}}
- Never invent or guess values that are not present in the input
- "cookies" must always be a flat object of name/value strings, never a raw cookie string"""


def _style_instruction(style: str) -> str:
    s = (style or "").strip().lower()
    if not s or s == "strict_json":
        return "Response style: strict_json. Output compact JSON only, no extra keys."
    if s == "compact":
        return "Response style: compact. Keep values minimal and concise."
    if s == "detailed":
        return "Response style: detailed. Include helpful headers/body details if explicitly requested."
    return f"Response style: {style}. Follow style while keeping JSON-only output."


def _build_proxy_url(base: str, user: Optional[str], pwd: Optional[str]) -> str:
    if user and pwd:
        p = urlparse(base)
        host_port = p.hostname + (f":{p.port}" if p.port else "")
        base = urlunparse(p._replace(netloc=f"{user}:{pwd}@{host_port}"))
    return base


def _requests_call(req: ProxyRequest, auth) -> dict:
    """Sync helper for NTLM/Kerberos — runs in a thread via asyncio.to_thread."""
    proxies = None
    if req.use_proxy and req.proxy_url:
        purl = _build_proxy_url(req.proxy_url, req.proxy_user, req.proxy_pass)
        proxies = {"http": purl, "https": purl}
        logger.info("requests via proxy %s", req.proxy_url)

    resp = requests.request(
        method=req.method.upper(),
        url=req.url,
        headers=req.headers or {},
        cookies=req.cookies or {},
        data=req.body.encode() if req.body else None,
        auth=auth,
        proxies=proxies,
        verify=False,
        timeout=30,
        allow_redirects=True,
    )
    logger.info("requests HTTP %s", resp.status_code)
    return {
        "status": resp.status_code,
        "reason": resp.reason,
        "headers": dict(resp.headers),
        "body": resp.text,
    }


@app.post("/api/proxy")
async def proxy(req: ProxyRequest):
    session = requests.session()
    session.verify = False
    if req.use_ntlm:
        session.auth = HttpNtlmAuth(req.ntlm_user, req.ntlm_pass)
    elif req.use_kerberos:
        session.auth = HTTPKerberosAuth(mutual_authentication=OPTIONAL)
    else:
        session.auth = None

    # Only override proxies when an explicit proxy is requested; otherwise let
    # requests honor env (HTTP_PROXY/HTTPS_PROXY) — matches generated.py.
    if req.use_proxy and req.proxy_url:
        purl = _build_proxy_url(req.proxy_url, req.proxy_user, req.proxy_pass)
        session.proxies = {"http": purl, "https": purl}
    try:
        resp = await asyncio.to_thread(
            session.request,
            method=req.method.upper(),
            url=req.url,
            headers=req.headers or {},
            cookies=req.cookies or {},
            data=req.body.encode() if req.body else None,
            allow_redirects=True,
            timeout=30,
        )
    except requests.exceptions.RequestException as e:
        print(e, flush=True)
        raise HTTPException(status_code=502, detail=str(e))

    return {
        "status": resp.status_code,
        "reason": resp.reason,
        "headers": dict(resp.headers),
        "body": resp.text,
    }


def _ai_fill_call(req: AIFillRequest) -> str:
    """Sync — runs in a thread. Returns raw response JSON string."""

    base = req.api_base.rstrip("/")
    call_ai = (req.call_ai or "responses").strip().lower()
    strict_json = (req.response_style or "").strip().lower() == "strict_json"

    style_note = _style_instruction(req.response_style)
    user_text = req.description
    if strict_json:
        style_note += " Return only valid json object."

    headers = {
        "Authorization": f"Bearer {req.api_key}",
        "Content-Type": "application/json",
    }

    if call_ai in ("completion", "completions", "chat", "chat_completions"):
        url = f"{base}/chat/completions"

        payload = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_text},
            ],
        }

    else:
        url = f"{base}/responses"

        payload = {
            "model": req.model,
            "instructions": f"{SYSTEM_PROMPT}\n\n{style_note}",
            "input": user_text,
        }

    proxies = None
    if req.proxy_url:
        purl = _build_proxy_url(
            req.proxy_url,
            req.proxy_user,
            req.proxy_pass,
        )
        proxies = {
            "http": purl,
            "https": purl,
        }

    logger.info(
        "POST %s model=%s call_ai=%s",
        url,
        req.model,
        call_ai,
    )

    session = requests.Session()
    session.trust_env = False

    if proxies:
        session.proxies.update(proxies)

    resp = session.post(
        url,
        json=payload,
        headers=headers,
        verify=False,
        timeout=120,
    )

    # Fallback to Chat Completions if Responses path fails.
    if call_ai == "responses" and resp.status_code in (400, 404, 405, 415, 422, 500, 501):
        logger.warning(
            "/responses returned %s, retrying chat/completions",
            resp.status_code,
        )

        url = f"{base}/chat/completions"
        payload = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "system", "content": style_note},
                {"role": "user", "content": user_text},
            ],
        }

        resp = session.post(
            url,
            json=payload,
            headers=headers,
            verify=False,
            timeout=120,
        )

    logger.info(
        "HTTP %s %s",
        resp.status_code,
        resp.reason,
    )

    if not resp.ok:
        logger.error(resp.text[:1000])
        resp.raise_for_status()

    return resp.text


@app.post("/api/ai-fill")
async def ai_fill(req: AIFillRequest):
    # Server-side fallback: fill missing AI config from saved settings.
    # Lets admin-configured key work for non-admin homepage users without
    # re-entering it. Client may send empty values when settings aren't loaded.
    s = get_settings()
    if not req.api_base:
        req.api_base = s.get("ai_base") or s.get("ai-base") or ""
    if not req.api_key:
        req.api_key = s.get("ai_key") or s.get("ai-key") or ""
    if not req.model or req.model == "gpt-4o-mini":
        req.model = s.get("ai_model") or s.get("ai-model") or req.model or "gpt-4o-mini"
    if not req.call_ai or req.call_ai == "responses":
        req.call_ai = s.get("ai_call") or s.get("ai-call") or req.call_ai or "responses"
    if not req.response_style or req.response_style == "strict_json":
        req.response_style = s.get("ai_response_style") or s.get("ai-response-style") or req.response_style or "strict_json"
    if not req.proxy_url:
        req.proxy_url = s.get("proxy_url") or None
        req.proxy_user = s.get("proxy_user") or None
        req.proxy_pass = s.get("proxy_pass") or None

    if not req.api_base:
        raise HTTPException(status_code=400, detail="API Base URL not configured. Admin must set it in Settings.")
    if not req.api_key:
        raise HTTPException(status_code=400, detail="API Key not configured. Admin must set it in Settings.")

    print(f"[ai-fill] received: api_base={req.api_base} model={req.model} call_ai={req.call_ai} style={req.response_style} proxy={req.proxy_url}", flush=True)
    try:
        raw = await asyncio.to_thread(_ai_fill_call, req)
    except requests.exceptions.Timeout:
        logger.error("AI-fill FAIL timed out after 120s")
        raise HTTPException(status_code=504, detail="AI API timed out after 120s.")
    except requests.exceptions.ConnectionError as e:
        logger.error("AI-fill FAIL connection error: %s", e)
        raise HTTPException(status_code=502, detail=f"Cannot connect: {e}")
    except requests.exceptions.HTTPError as e:
        logger.error("AI-fill FAIL HTTP error: %s", e)
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
    except Exception as e:
        logger.error("AI-fill FAIL unexpected error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

    data = json.loads(raw)

    choice0 = (data.get("choices") or [{}])[0]

    # Auto-detect response shape instead of trusting requested mode.
    if "output_text" in data or "output" in data:
        content = (data.get("output_text") or "").strip()
        if not content:
            out = data.get("output") or []
            texts = []
            for item in out:
                for c in (item.get("content") or []):
                    t = c.get("text")
                    if t:
                        texts.append(t)
            content = "\n".join(texts).strip()
    else:
        content = ((choice0.get("message") or {}).get("content") or "").strip() or (choice0.get("text") or "").strip()

    # Fallback for provider quirks / compatibility shims
    if not content:
        content = (choice0.get("text") or "").strip() or ((choice0.get("message") or {}).get("content") or "").strip()

    if content.startswith("```"):
        content = content.split("```")[1]
        if content.startswith("json"):
            content = content[4:]
        content = content.strip()

    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        logger.error("AI-fill FAIL model returned non-JSON: %s", content[:200])
        raise HTTPException(status_code=500, detail=f"Model returned non-JSON: {content}")

    logger.info("AI-fill OK done")
    return result


@app.get("/admin")
async def admin_redirect():
    from fastapi.responses import HTMLResponse
    html = open("static/admin.html", encoding="utf-8").read()
    return HTMLResponse(html, headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    })

app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=5555, reload=True)