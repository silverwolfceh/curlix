"""Pydantic models shared across Curlix routers."""
from pydantic import BaseModel
from typing import Optional


class ProxyRequest(BaseModel):
    url: str
    method: str = "GET"
    headers: dict = {}
    cookies: dict = {}
    body: str = ""
    body_b64: Optional[str] = None  # base64-encoded raw bytes (file uploads / binary)
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


class LoginRequest(BaseModel):
    username: str
    password: str


class UserRegisterRequest(BaseModel):
    username: str
    password: str


class UserLoginRequest(BaseModel):
    username: str
    password: str


class RenameRequest(BaseModel):
    handle: str


class SwitchDeviceRequest(BaseModel):
    identity: str


class UserCreateRequest(BaseModel):
    username: str
    password: str
    role: str = "user"


class UserUpdateRequest(BaseModel):
    role: Optional[str] = None
    password: Optional[str] = None


class AdminUserUpdateRequest(BaseModel):
    role: str


class EnvVarsRequest(BaseModel):
    vars: list
