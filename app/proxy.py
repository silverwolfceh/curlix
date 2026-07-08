"""Proxy router: /api/proxy — sends HTTP requests server-side (avoids browser CORS).

Supports proxy, NTLM (Windows SSPI), Kerberos. SSL verification disabled for
corporate compatibility. Honors env proxies (HTTP_PROXY/HTTPS_PROXY) unless an
explicit proxy is requested — matches the generated.py script behavior.
"""
import asyncio
import logging
from urllib.parse import urlparse, urlunparse
from typing import Optional

import requests
from requests_kerberos import HTTPKerberosAuth, OPTIONAL
from requests_ntlm import HttpNtlmAuth
from fastapi import APIRouter, HTTPException

from .models import ProxyRequest

logger = logging.getLogger(__name__)
router = APIRouter()


def build_proxy_url(base: str, user: Optional[str], pwd: Optional[str]) -> str:
    """Embed proxy credentials into the proxy URL."""
    if user and pwd:
        p = urlparse(base)
        host_port = p.hostname + (f":{p.port}" if p.port else "")
        base = urlunparse(p._replace(netloc=f"{user}:{pwd}@{host_port}"))
    return base


@router.post("/api/proxy")
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
        purl = build_proxy_url(req.proxy_url, req.proxy_user, req.proxy_pass)
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
        logger.error("proxy FAIL: %s", e)
        raise HTTPException(status_code=502, detail=str(e))

    return {
        "status": resp.status_code,
        "reason": resp.reason,
        "headers": dict(resp.headers),
        "body": resp.text,
    }
