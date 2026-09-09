"""
Spend and error log table models.

Canonical definitions for ``derouter_spendlogs`` and ``derouter_errorlogs``.
Re-exported from ``derouter.proxy._types`` for backwards compatibility.
"""

from datetime import datetime

from pydantic import Json

from derouter._uuid import uuid
from derouter.types.llms.base import DeRouterPydanticObjectBase


class DeRouter_SpendLogs(DeRouterPydanticObjectBase):
    request_id: str
    api_key: str
    model: str | None = ""
    api_base: str | None = ""
    call_type: str
    spend: float | None = 0.0
    total_tokens: int | None = 0
    prompt_tokens: int | None = 0
    completion_tokens: int | None = 0
    startTime: str | datetime | None
    endTime: str | datetime | None
    user: str | None = ""
    metadata: Json | None = {}
    cache_hit: str | None = "False"
    cache_key: str | None = None
    request_tags: Json | None = None
    requester_ip_address: str | None = None
    messages: str | list | dict | None
    response: str | list | dict | None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class DeRouter_ErrorLogs(DeRouterPydanticObjectBase):
    request_id: str | None = str(uuid.uuid4())
    api_base: str | None = ""
    model_group: str | None = ""
    derouter_model_name: str | None = ""
    model_id: str | None = ""
    request_kwargs: dict | None = {}
    exception_type: str | None = ""
    status_code: str | None = ""
    exception_string: str | None = ""
    startTime: str | datetime | None
    endTime: str | datetime | None
