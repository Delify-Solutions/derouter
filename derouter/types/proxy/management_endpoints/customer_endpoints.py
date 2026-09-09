from pydantic import BaseModel, Field

from derouter.models.budget import DeRouter_BudgetTableFull
from derouter.models.end_user import DeRouter_EndUserTable


class CustomerResponse(DeRouter_EndUserTable):
    """Customer object returned by the /customer read+write endpoints.

    Nests the full budget response model so server-managed budget fields
    (budget_reset_at, created_at) survive response_model filtering, rather than
    the narrow write-allowlist shape DeRouter_EndUserTable carries for internal use.
    """

    derouter_budget_table: DeRouter_BudgetTableFull | None = None  # pyright: ignore


class BlockUsersResponse(BaseModel):
    blocked_users: list[DeRouter_EndUserTable]


class UnblockUsersResponse(BaseModel):
    blocked_users: list[str] = Field(description="User IDs that remain blocked after this unblock call")


class DeleteCustomersResponse(BaseModel):
    deleted_customers: int
    message: str
