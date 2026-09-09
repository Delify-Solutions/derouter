"""
End-user table model.

Canonical definition for ``derouter_endusertable``. Re-exported from
``derouter.proxy._types`` for backwards compatibility.
"""

from typing import Literal

from pydantic import ConfigDict, model_validator

from derouter.models.budget import DeRouter_BudgetTable
from derouter.models.object_permission import DeRouter_ObjectPermissionTable
from derouter.types.llms.base import DeRouterPydanticObjectBase


class DeRouter_EndUserTable(DeRouterPydanticObjectBase):
    user_id: str
    blocked: bool
    alias: str | None = None
    spend: float = 0.0
    allowed_model_region: Literal["eu", "us"] | None = None
    default_model: str | None = None
    budget_id: str | None = None
    derouter_budget_table: DeRouter_BudgetTable | None = None
    object_permission_id: str | None = None
    object_permission: DeRouter_ObjectPermissionTable | None = None

    @model_validator(mode="before")
    @classmethod
    def set_model_info(cls, values):
        if values.get("spend") is None:
            values.update({"spend": 0.0})
        return values

    model_config = ConfigDict(protected_namespaces=())
