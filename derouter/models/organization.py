"""
Organization table model.

Canonical definition for ``derouter_organizationtable``. Re-exported from
``derouter.proxy._types`` for backwards compatibility.
"""

from derouter.models.budget import DeRouter_BudgetTable
from derouter.models.object_permission import DeRouter_ObjectPermissionTable
from derouter.models.user import DeRouter_UserTable
from derouter.types.llms.base import DeRouterPydanticObjectBase


class DeRouter_OrganizationTable(DeRouterPydanticObjectBase):
    """Represents user-controllable params for a DeRouter_OrganizationTable record"""

    organization_id: str | None = None
    organization_alias: str | None = None
    budget_id: str
    spend: float = 0.0
    metadata: dict | None = None
    models: list[str] = []
    model_spend: dict | None = {}
    created_by: str
    updated_by: str
    users: list[DeRouter_UserTable] | None = None
    derouter_budget_table: DeRouter_BudgetTable | None = None
    object_permission: DeRouter_ObjectPermissionTable | None = None
    object_permission_id: str | None = None
