"""
Managed file, object, and vector store table models.

Canonical definitions for the ``derouter_managed*`` tables. Re-exported from
``derouter.proxy._types`` for backwards compatibility.
"""

from datetime import datetime
from typing import Any, Literal

from derouter.types.llms.base import DeRouterPydanticObjectBase
from derouter.types.llms.openai import OpenAIFileObject, ResponsesAPIResponse
from derouter.types.utils import DeRouterBatch, DeRouterFineTuningJob


class DeRouter_ManagedFileTable(DeRouterPydanticObjectBase):
    unified_file_id: str
    file_object: OpenAIFileObject | None = None
    model_mappings: dict[str, str]
    flat_model_file_ids: list[str]
    created_by: str | None = None
    team_id: str | None = None
    updated_by: str | None = None
    storage_backend: str | None = None
    storage_url: str | None = None


class DeRouter_ManagedObjectTable(DeRouterPydanticObjectBase):
    unified_object_id: str
    model_object_id: str
    file_purpose: Literal["batch", "fine-tune", "response", "container"]
    file_object: DeRouterBatch | DeRouterFineTuningJob | ResponsesAPIResponse
    created_by: str | None = None
    team_id: str | None = None
    org_id: str | None = None


class DeRouter_ManagedVectorStoreTable(DeRouterPydanticObjectBase):
    """Table for managing vector stores with target_model_names support."""

    unified_resource_id: str
    resource_object: Any | None = None
    model_mappings: dict[str, str]
    flat_model_resource_ids: list[str]
    created_by: str | None = None
    team_id: str | None = None
    updated_by: str | None = None
    storage_backend: str | None = None
    storage_url: str | None = None


class DeRouter_ManagedVectorStoresTable(DeRouterPydanticObjectBase):
    vector_store_id: str
    custom_llm_provider: str
    vector_store_name: str | None = None
    vector_store_description: str | None = None
    vector_store_metadata: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    derouter_credential_name: str | None = None
    derouter_params: dict[str, Any] | None = None
    team_id: str | None = None
    user_id: str | None = None
