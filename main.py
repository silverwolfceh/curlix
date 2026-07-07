import json
import logging
import asyncio
import httpx
import requests
from requests_kerberos import HTTPKerberosAuth, OPTIONAL
from requests_ntlm import HttpNtlmAuth
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
from urllib.parse import urlparse, urlunparse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    api_base: str
    api_key: str
    model: str = "gpt-4o-mini"
    call_ai: str = "responses"  # responses | completions
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
    session.trust_env = False  # ignore system proxy settings
    session.verify = False  # ignore SSL certs
    if req.use_ntlm:
        session.auth = HttpNtlmAuth(req.ntlm_user, req.ntlm_pass)
    elif req.use_kerberos:
        session.auth = HTTPKerberosAuth(mutual_authentication=OPTIONAL)
    else:
        session.auth = None
    
    # Setting proxies
    proxies = {
        "http": _build_proxy_url(req.proxy_url, req.proxy_user, req.proxy_pass) if req.use_proxy and req.proxy_url else None,
        "https": _build_proxy_url(req.proxy_url, req.proxy_user, req.proxy_pass) if req.use_proxy and req.proxy_url else None
    }
    session.proxies = proxies
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
                # {"role": "system", "content": style_note},
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


app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=5555, reload=True)