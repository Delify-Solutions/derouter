"""
Organization repository for database operations on DeRouter_OrganizationTable.
"""

from typing import TYPE_CHECKING, Any, Final

from derouter.models.organization import DeRouter_OrganizationTable
from derouter.repositories.base_repository import BaseRepository
from derouter.repositories.prisma_protocols import TableActions

if TYPE_CHECKING:
    from prisma import models as prisma_models


class OrganizationRepository(BaseRepository[DeRouter_OrganizationTable]):
    """Repository for organization database operations."""

    @property
    def table(self) -> TableActions["prisma_models.DeRouter_OrganizationTable"]:
        return self.prisma_client.db.derouter_organizationtable

    @property
    def model_class(self) -> type[DeRouter_OrganizationTable]:
        return DeRouter_OrganizationTable

    async def find_by_id(
        self, organization_id: str, id_field: str = "organization_id"
    ) -> DeRouter_OrganizationTable | None:
        return await super().find_by_id(organization_id, id_field)

    async def find_by_alias(self, organization_alias: str) -> DeRouter_OrganizationTable | None:
        """Find an organization by alias."""
        organizations: Final = await self.find_many(where={"organization_alias": organization_alias})
        return organizations[0] if organizations else None

    async def create_organization(
        self,
        organization_alias: str,
        budget_id: str,
        created_by: str,
        organization_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        models: list[str] | None = None,
        object_permission_id: str | None = None,
    ) -> DeRouter_OrganizationTable:
        """Create a new organization."""
        data: Final[dict[str, Any]] = {
            "organization_alias": organization_alias,
            "budget_id": budget_id,
            "created_by": created_by,
            "updated_by": created_by,
        }
        if organization_id is not None:
            data["organization_id"] = organization_id
        if metadata is not None:
            data["metadata"] = metadata
        if models is not None:
            data["models"] = models
        if object_permission_id is not None:
            data["object_permission_id"] = object_permission_id

        return await self.create(data)

    async def update_organization(
        self,
        organization_id: str,
        updated_by: str,
        organization_alias: str | None = None,
        budget_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        models: list[str] | None = None,
        object_permission_id: str | None = None,
    ) -> DeRouter_OrganizationTable | None:
        """Update an organization."""
        data: Final[dict[str, Any]] = {"updated_by": updated_by}
        if organization_alias is not None:
            data["organization_alias"] = organization_alias
        if budget_id is not None:
            data["budget_id"] = budget_id
        if metadata is not None:
            data["metadata"] = metadata
        if models is not None:
            data["models"] = models
        if object_permission_id is not None:
            data["object_permission_id"] = object_permission_id

        return await self.update(organization_id, data, id_field="organization_id")

    async def delete_organization(self, organization_id: str) -> DeRouter_OrganizationTable | None:
        """Delete an organization."""
        return await self.delete(organization_id, id_field="organization_id")

    async def update_spend(self, organization_id: str, spend: float) -> DeRouter_OrganizationTable | None:
        """Update organization spend."""
        return await self.update(organization_id, {"spend": spend}, id_field="organization_id")
