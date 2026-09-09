"""
Organization membership table model.

Canonical definition for ``derouter_organizationmembership``. Re-exported from
``derouter.proxy._types`` for backwards compatibility.
"""

from datetime import datetime
from typing import Any

from pydantic import ConfigDict, model_validator

from derouter.models.budget import DeRouter_BudgetTable
from derouter.types.llms.base import DeRouterPydanticObjectBase


class DeRouter_OrganizationMembershipTable(DeRouterPydanticObjectBase):
    """Tracks which organizations a user belongs to and their spend within it."""

    user_id: str
    organization_id: str
    user_role: str | None = None
    spend: float = 0.0
    budget_id: str | None = None
    created_at: datetime
    updated_at: datetime
    user: Any | None = None
    derouter_budget_table: DeRouter_BudgetTable | None = None
    user_email: str | None = None

    model_config = ConfigDict(protected_namespaces=())

    @model_validator(mode="after")
    def populate_user_email(self) -> "DeRouter_OrganizationMembershipTable":
        if self.user_email is None and self.user is not None:
            if isinstance(self.user, dict):
                self.user_email = self.user.get("user_email")
            else:
                self.user_email = getattr(self.user, "user_email", None)
        return self
