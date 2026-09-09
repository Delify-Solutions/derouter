"""
Access group table model.

Canonical definition for ``derouter_accessgrouptable``. Re-exported from
``derouter.proxy._types`` for backwards compatibility.
"""

from datetime import datetime

from derouter.types.llms.base import DeRouterPydanticObjectBase


class DeRouter_AccessGroupTable(DeRouterPydanticObjectBase):
    access_group_id: str
    access_group_name: str
    description: str | None = None
    access_model_names: list[str] = []
    access_mcp_server_ids: list[str] = []
    access_agent_ids: list[str] = []
    assigned_team_ids: list[str] = []
    assigned_key_ids: list[str] = []
    created_at: datetime | None = None
    created_by: str | None = None
    updated_at: datetime | None = None
    updated_by: str | None = None
