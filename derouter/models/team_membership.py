"""
Team membership table model.

Canonical definition for ``derouter_teammembership``. Re-exported from
``derouter.proxy._types`` for backwards compatibility.
"""

from derouter.models.budget import DeRouter_BudgetTable, DeRouter_BudgetTableFull
from derouter.types.llms.base import DeRouterPydanticObjectBase


class DeRouter_TeamMembership(DeRouterPydanticObjectBase):
    user_id: str
    team_id: str
    budget_id: str | None = None
    spend: float | None = 0.0
    total_spend: float | None = 0.0
    derouter_budget_table: DeRouter_BudgetTableFull | DeRouter_BudgetTable | None = None

    def safe_get_team_member_rpm_limit(self) -> int | None:
        if self.derouter_budget_table is not None:
            return self.derouter_budget_table.rpm_limit
        return None

    def safe_get_team_member_tpm_limit(self) -> int | None:
        if self.derouter_budget_table is not None:
            return self.derouter_budget_table.tpm_limit
        return None
