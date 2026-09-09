"""
Proxy model table model.

Canonical definition for ``derouter_proxymodeltable``. Re-exported from
``derouter.proxy._types`` for backwards compatibility.
"""

import json
from datetime import datetime

from pydantic import ConfigDict, model_validator

from derouter.types.llms.base import DeRouterPydanticObjectBase


class DeRouter_ProxyModelTable(DeRouterPydanticObjectBase):
    model_id: str
    model_name: str
    derouter_params: dict
    model_info: dict | None = None
    blocked: bool = False
    created_at: datetime | None = None
    created_by: str | None = None
    updated_at: datetime | None = None
    updated_by: str | None = None

    model_config = ConfigDict(protected_namespaces=())

    @model_validator(mode="before")
    @classmethod
    def check_potential_json_str(cls, values):
        if not isinstance(values, dict):
            return values
        if isinstance(values.get("derouter_params"), str):
            try:
                values["derouter_params"] = json.loads(values["derouter_params"])
            except json.JSONDecodeError:
                pass
        if isinstance(values.get("model_info"), str):
            try:
                values["model_info"] = json.loads(values["model_info"])
            except json.JSONDecodeError:
                pass
        return values

    @property
    def is_blocked(self) -> bool:
        return self.blocked

    @property
    def team_id(self) -> str | None:
        if self.model_info:
            return self.model_info.get("team_id")
        return None

    @property
    def team_public_model_name(self) -> str | None:
        if self.model_info:
            return self.model_info.get("team_public_model_name")
        return None
