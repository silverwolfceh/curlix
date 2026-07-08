"""LLM router: /api/ai-fill — convert natural language to a request object.

Calls an OpenAI-compatible API (Responses or Chat Completions endpoint).
Falls back to server-saved AI config when the client omits api_base/api_key,
so admin-configured credentials work for non-admin homepage users.
"""
import json
import asyncio
import logging
from typing import Optional

import requests
from fastapi import APIRouter, HTTPException

from .db import get_settings
from .models import AIFillRequest
from .proxy import build_proxy_url

logger = logging.getLogger(__name__)
router = APIRouter()


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
        purl = build_proxy_url(req.proxy_url, req.proxy_user, req.proxy_pass)
        proxies = {"http": purl, "https": purl}

    logger.info("POST %s model=%s call_ai=%s", url, req.model, call_ai)

    session = requests.Session()
    session.trust_env = False
    if proxies:
        session.proxies.update(proxies)

    resp = session.post(url, json=payload, headers=headers, verify=False, timeout=120)

    # Fallback to Chat Completions if Responses path fails.
    if call_ai == "responses" and resp.status_code in (400, 404, 405, 415, 422, 500, 501):
        logger.warning("/responses returned %s, retrying chat/completions", resp.status_code)
        url = f"{base}/chat/completions"
        payload = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                # {"role": "system", "content": style_note},
                {"role": "user", "content": user_text},
            ],
        }
        resp = session.post(url, json=payload, headers=headers, verify=False, timeout=120)

    logger.info("HTTP %s %s", resp.status_code, resp.reason)
    if not resp.ok:
        logger.error(resp.text[:1000])
        resp.raise_for_status()
    return resp.text


def _apply_server_fallback(req: AIFillRequest) -> None:
    """Fill missing AI config from server settings (in place)."""
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


def _extract_content(data: dict) -> str:
    """Parse the AI provider response into a content string."""
    choice0 = (data.get("choices") or [{}])[0]
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
    # Strip model artifacts: leading ^ and stray ^ at start of lines
    content = content.lstrip("^\n")
    content = "\n".join(line.lstrip("^") for line in content.split("\n"))
    return content


@router.post("/api/ai-fill")
async def ai_fill(req: AIFillRequest):
    _apply_server_fallback(req)

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
    content = _extract_content(data)

    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        logger.error("AI-fill FAIL model returned non-JSON: %s", content[:200])
        raise HTTPException(status_code=500, detail=f"Model returned non-JSON: {content}")

    logger.info("AI-fill OK done")

    # Clean model artifacts from values
    if isinstance(result, dict):
        if "body" in result and isinstance(result["body"], str):
            result["body"] = result["body"].lstrip("^ ")
        if "url" in result and isinstance(result["url"], str):
            result["url"] = result["url"].lstrip("^ ")
        if "headers" and isinstance(result["headers"], dict):
            result["headers"] = {k: v.lstrip("^ ") for k, v in result["headers"].items()}
    return result
