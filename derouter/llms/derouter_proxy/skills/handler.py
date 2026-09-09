"""
Handler for DeRouter database-backed skills operations.

This module contains the actual database operations for skills CRUD.
Used by the transformation layer and skills injection hook.
"""

import uuid
from collections.abc import Sequence
from typing import Final

from derouter._logging import verbose_logger
from derouter.caching.in_memory_cache import InMemoryCache
from derouter.llms.derouter_proxy.skills.constants import (
    DEROUTER_SKILL_ID_PREFIX,
    MAX_SKILLS_PER_SEARCH,
)
from derouter.proxy._types import DeRouter_SkillsTable, NewSkillRequest, UserAPIKeyAuth
from derouter.proxy.common_utils.resource_ownership import (
    get_primary_resource_owner_scope,
    get_resource_owner_scopes,
    is_proxy_admin,
    user_can_access_resource_owner,
)
from derouter.repositories.table_repositories import SkillsRepository

# Skills are looked up on every chat completion that has skills enabled
# (`SkillsInjectionHook` calls ``fetch_skill_from_db``). 60s LRU/TTL cache
# absorbs the hot read before it reaches Prisma. ``_NEGATIVE_SKILL_SENTINEL``
# lets us cache a true "skill does not exist" so repeated misses also
# avoid the DB — ``InMemoryCache`` returns ``None`` indistinguishably for
# "miss" and "cached as None".
_NEGATIVE_SKILL_SENTINEL: Final = "__derouter_skill_not_found__"
_SKILL_CACHE: Final = InMemoryCache(max_size_in_memory=10000, default_ttl=60)


def _prisma_skill_to_derouter(prisma_skill) -> DeRouter_SkillsTable:
    """Convert a Prisma skill record to DeRouter_SkillsTable.

    Handles Base64 decoding of file_content field — model_dump() converts
    Base64 fields to base64-encoded strings.
    """
    import base64

    data: Final = prisma_skill.model_dump()

    if data.get("file_content") is not None:
        if isinstance(data["file_content"], str):
            data["file_content"] = base64.b64decode(data["file_content"])

    return DeRouter_SkillsTable(**data)


class DeRouterSkillsHandler:
    """CRUD for skills stored in ``derouter_skillstable``."""

    @staticmethod
    async def _get_prisma_client():
        from derouter.proxy.proxy_server import prisma_client

        if prisma_client is None:
            raise ValueError("Prisma client is not initialized. Database connection required for DeRouter skills.")
        return prisma_client

    @staticmethod
    async def create_skill(
        data: NewSkillRequest,
        user_id: str | None = None,
        user_api_key_dict: UserAPIKeyAuth | None = None,
    ) -> DeRouter_SkillsTable:
        prisma_client: Final = await DeRouterSkillsHandler._get_prisma_client()

        skill_id: Final = f"{DEROUTER_SKILL_ID_PREFIX}{uuid.uuid4()}"
        owner: Final = get_primary_resource_owner_scope(user_api_key_dict) or user_id
        if owner is None:
            # Identity-less callers (no user_id / team_id / org_id /
            # api_key / token) can't be uniquely stamped on the row.
            # Stamping a placeholder would let any two such callers see
            # each other's skills via the shared owner. ValueError keeps
            # this module FastAPI-free per the project layering rule.
            raise ValueError("Unable to record skill ownership: caller has no identity scope.")

        skill_data: Final[dict[str, object]] = {
            "skill_id": skill_id,
            "display_title": data.display_title,
            "description": data.description,
            "instructions": data.instructions,
            "source": "custom",
            "created_by": owner,
            "updated_by": owner,
        }

        if data.metadata is not None:
            from derouter.derouter_core_utils.safe_json_dumps import safe_dumps

            skill_data["metadata"] = safe_dumps(data.metadata)

        if data.file_content is not None:
            from prisma.fields import Base64

            skill_data["file_content"] = Base64.encode(data.file_content)
        if data.file_name is not None:
            skill_data["file_name"] = data.file_name
        if data.file_type is not None:
            skill_data["file_type"] = data.file_type

        verbose_logger.debug("DeRouterSkillsHandler: Creating skill %s with title=%s", skill_id, data.display_title)

        new_skill: Final = await SkillsRepository(prisma_client).table.create(data=skill_data)
        return _prisma_skill_to_derouter(new_skill)

    @staticmethod
    async def list_skills(
        limit: int = 20,
        offset: int = 0,
        user_api_key_dict: UserAPIKeyAuth | None = None,
    ) -> list[DeRouter_SkillsTable]:
        prisma_client: Final = await DeRouterSkillsHandler._get_prisma_client()

        verbose_logger.debug("DeRouterSkillsHandler: Listing skills with limit=%s, offset=%s", limit, offset)

        owner_scopes: Final = (
            get_resource_owner_scopes(user_api_key_dict)
            if user_api_key_dict is not None and not is_proxy_admin(user_api_key_dict)
            else None
        )
        if owner_scopes is not None and not owner_scopes:
            return []

        skills: Final = await SkillsRepository(prisma_client).table.find_many(
            take=limit,
            skip=offset,
            order={"created_at": "desc"},
            where={"created_by": {"in": owner_scopes}} if owner_scopes else None,
        )
        return [_prisma_skill_to_derouter(s) for s in skills]

    @staticmethod
    async def list_skills_for_search(
        user_api_key_dict: UserAPIKeyAuth | None = None,
    ) -> Sequence[DeRouter_SkillsTable]:
        """Every skill the caller can access, for ranking. Same owner-scope filter as
        ``list_skills``, but unpaginated (up to ``MAX_SKILLS_PER_SEARCH``) since a query
        must be scored against the whole accessible set, not one page of it."""
        return await DeRouterSkillsHandler.list_skills(
            limit=MAX_SKILLS_PER_SEARCH,
            offset=0,
            user_api_key_dict=user_api_key_dict,
        )

    @staticmethod
    async def _load_skill(skill_id: str) -> object | None:
        """Cache-first read of the Prisma skill row. Owner-scope filtering
        happens on the cached row, so the cache is per-skill not per-caller.
        """
        cached: Final = _SKILL_CACHE.get_cache(skill_id)
        if cached == _NEGATIVE_SKILL_SENTINEL:
            return None
        if cached is not None:
            return cached

        prisma_client: Final = await DeRouterSkillsHandler._get_prisma_client()
        skill: Final = await SkillsRepository(prisma_client).table.find_unique(where={"skill_id": skill_id})
        _SKILL_CACHE.set_cache(skill_id, skill if skill is not None else _NEGATIVE_SKILL_SENTINEL)
        return skill

    @staticmethod
    async def get_skill(
        skill_id: str,
        user_api_key_dict: UserAPIKeyAuth | None = None,
    ) -> DeRouter_SkillsTable:
        verbose_logger.debug("DeRouterSkillsHandler: Getting skill %s", skill_id)

        skill: Final = await DeRouterSkillsHandler._load_skill(skill_id)
        # Same "not found" message for both "missing" and "cross-tenant"
        # so callers can't enumerate skill IDs they don't own.
        if skill is None or not user_can_access_resource_owner(getattr(skill, "created_by", None), user_api_key_dict):
            raise ValueError(f"Skill not found: {skill_id}")

        return _prisma_skill_to_derouter(skill)

    @staticmethod
    async def delete_skill(
        skill_id: str,
        user_api_key_dict: UserAPIKeyAuth | None = None,
    ) -> dict[str, str]:
        prisma_client: Final = await DeRouterSkillsHandler._get_prisma_client()
        verbose_logger.debug("DeRouterSkillsHandler: Deleting skill %s", skill_id)

        skill: Final = await DeRouterSkillsHandler._load_skill(skill_id)
        if skill is None or not user_can_access_resource_owner(getattr(skill, "created_by", None), user_api_key_dict):
            raise ValueError(f"Skill not found: {skill_id}")

        await SkillsRepository(prisma_client).table.delete(where={"skill_id": skill_id})
        _SKILL_CACHE.set_cache(skill_id, _NEGATIVE_SKILL_SENTINEL)

        return {"id": skill_id, "type": "skill_deleted"}

    @staticmethod
    async def fetch_skill_from_db(
        skill_id: str,
        user_api_key_dict: UserAPIKeyAuth | None = None,
    ) -> DeRouter_SkillsTable | None:
        """Skills-injection-hook helper: returns None instead of raising on
        not-found / not-authorized so the hook can silently skip."""
        try:
            return await DeRouterSkillsHandler.get_skill(skill_id, user_api_key_dict=user_api_key_dict)
        except ValueError:
            return None
        except Exception as e:
            verbose_logger.warning("DeRouterSkillsHandler: Error fetching skill %s: %s", skill_id, e)
            return None
