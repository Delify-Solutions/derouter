"""
Model repository for database operations on DeRouter_ProxyModelTable.
"""

import json
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, Final, Protocol

from derouter.models.model import DeRouter_ProxyModelTable
from derouter.proxy.common_utils.config_sync_pubsub import wrap_table_actions_for_config_sync
from derouter.proxy.common_utils.encrypt_decrypt_utils import (
    decrypt_value_helper,
    encrypt_value_helper,
)
from derouter.repositories.base_repository import BaseRepository
from derouter.repositories.prisma_protocols import TableActions

if TYPE_CHECKING:
    from prisma import models as prisma_models


class _PrismaModelDb(Protocol):
    @property
    def derouter_proxymodeltable(self) -> TableActions["prisma_models.DeRouter_ProxyModelTable"]: ...


class _PrismaClientView(Protocol):
    @property
    def db(self) -> _PrismaModelDb: ...


class ModelRepository(BaseRepository[DeRouter_ProxyModelTable]):
    """Repository for proxy model database operations with encryption support."""

    def __init__(self, prisma_client: object, encryption_key: str | None = None) -> None:
        super().__init__(prisma_client)
        self._encryption_key = encryption_key

    @property
    def table(self) -> TableActions["prisma_models.DeRouter_ProxyModelTable"]:
        client: Final[_PrismaClientView] = self.prisma_client
        return wrap_table_actions_for_config_sync(
            actions=client.db.derouter_proxymodeltable,
            table_name="derouter_proxymodeltable",
        )

    @property
    def model_class(self) -> type[DeRouter_ProxyModelTable]:
        return DeRouter_ProxyModelTable

    def _encrypt_derouter_params(self, derouter_params: Mapping[str, object]) -> Mapping[str, object]:
        """Encrypt sensitive values in derouter_params."""
        encrypted: Final = {}
        for key, value in derouter_params.items():
            if isinstance(value, str):
                encrypted[key] = encrypt_value_helper(value, new_encryption_key=self._encryption_key)
            else:
                encrypted[key] = value
        return encrypted

    def _decrypt_derouter_params(self, derouter_params: Mapping[str, object]) -> Mapping[str, object]:
        """Decrypt sensitive values in derouter_params."""
        decrypted: Final = {}
        for key, value in derouter_params.items():
            if isinstance(value, str):
                decrypted[key] = decrypt_value_helper(
                    value, key=key, exception_type="debug", return_original_value=True
                )
            else:
                decrypted[key] = value
        return decrypted

    def _to_model(self, record: Any) -> DeRouter_ProxyModelTable | None:
        """Convert a database record to a Model with decryption."""
        if record is None:
            return None

        data: Final = record.dict() if hasattr(record, "dict") else dict(record)

        if isinstance(data.get("derouter_params"), str):
            data["derouter_params"] = json.loads(data["derouter_params"])
        if isinstance(data.get("model_info"), str):
            data["model_info"] = json.loads(data["model_info"])

        if data.get("derouter_params"):
            data["derouter_params"] = self._decrypt_derouter_params(data["derouter_params"])

        return DeRouter_ProxyModelTable(**data)

    async def find_by_id(self, model_id: str, id_field: str = "model_id") -> DeRouter_ProxyModelTable | None:
        return await super().find_by_id(model_id, id_field)

    async def find_by_name(self, model_name: str) -> list[DeRouter_ProxyModelTable]:
        """Find models by name."""
        records: Final = await self.table.find_many(where={"model_name": model_name})
        return self._to_model_list(records)

    async def find_all(self) -> list[DeRouter_ProxyModelTable]:
        """Find all models."""
        records: Final = await self.table.find_many()
        return self._to_model_list(records)

    async def find_unblocked(self) -> list[DeRouter_ProxyModelTable]:
        """Find all models that are not blocked."""
        records: Final = await self.table.find_many(where={"blocked": False})
        return self._to_model_list(records)

    async def find_all_except(self, model_id: str) -> Sequence[DeRouter_ProxyModelTable]:
        """Find every model except the row currently being updated."""
        records: Final = await self.table.find_many(
            where={"model_id": {"not": model_id}}  # mutable-ok: Prisma requires plain dicts for query serialization
        )
        return tuple(self._to_model_list(records))

    async def find_by_team_id(self, team_id: str) -> list[DeRouter_ProxyModelTable]:
        """Find models associated with a specific team.

        Note: This filters in-memory since team_id is stored within derouter_params
        JSON. For large deployments with many models, consider adding a dedicated
        team_id column with a database index.
        """
        all_models: Final = await self.find_all()
        return [m for m in all_models if m.team_id == team_id]

    async def create_model(
        self,
        model_name: str,
        derouter_params: Mapping[str, object],
        created_by: str,
        model_id: str | None = None,
        model_info: Mapping[str, object] | None = None,
        blocked: bool = False,
    ) -> DeRouter_ProxyModelTable:
        """Create a new model with encryption."""
        encrypted_params: Final = self._encrypt_derouter_params(derouter_params)

        data: Final[dict[str, str | bool]] = {
            "model_name": model_name,
            "derouter_params": json.dumps(encrypted_params),
            "created_by": created_by,
            "updated_by": created_by,
            "blocked": blocked,
        }
        if model_id is not None:
            data["model_id"] = model_id
        if model_info is not None:
            data["model_info"] = json.dumps(model_info)

        record: Final = await self.table.create(data=data)
        model: Final = self._to_model(record)
        assert model is not None
        return model

    async def update_model(
        self,
        model_id: str,
        updated_by: str,
        model_name: str | None = None,
        derouter_params: Mapping[str, object] | None = None,
        model_info: Mapping[str, object] | None = None,
        blocked: bool | None = None,
    ) -> DeRouter_ProxyModelTable | None:
        """Update a model with encryption."""
        data: Final[dict[str, str | bool]] = {"updated_by": updated_by}
        if model_name is not None:
            data["model_name"] = model_name
        if derouter_params is not None:
            encrypted_params: Final = self._encrypt_derouter_params(derouter_params)
            data["derouter_params"] = json.dumps(encrypted_params)
        if model_info is not None:
            data["model_info"] = json.dumps(model_info)
        if blocked is not None:
            data["blocked"] = blocked

        record: Final = await self.table.update(where={"model_id": model_id}, data=data)
        return self._to_model(record)

    async def delete_model(self, model_id: str) -> DeRouter_ProxyModelTable | None:
        """Delete a model."""
        return await self.delete(model_id, id_field="model_id")

    async def block_model(self, model_id: str, updated_by: str) -> DeRouter_ProxyModelTable | None:
        """Block a model."""
        return await self.update_model(model_id, updated_by, blocked=True)

    async def unblock_model(self, model_id: str, updated_by: str) -> DeRouter_ProxyModelTable | None:
        """Unblock a model."""
        return await self.update_model(model_id, updated_by, blocked=False)
