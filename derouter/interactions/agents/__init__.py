"""
derouter.interactions.agents

Full CRUD SDK for provider-side managed agents (e.g. Gemini v1beta/agents).

    derouter.interactions.agents.create(name=..., ...)
    derouter.interactions.agents.list(api_key=...)
    derouter.interactions.agents.get(name=..., ...)
    derouter.interactions.agents.delete(name=..., ...)
    derouter.interactions.agents.list_versions(name=..., ...)

Async counterparts: acreate, alist, aget, adelete, alist_versions
"""

from derouter.interactions.agents.main import (
    acreate,
    adelete,
    aget,
    alist,
    alist_versions,
    create,
    delete,
    get,
    list,
    list_versions,
)

__all__ = [
    "acreate",
    "adelete",
    "aget",
    "alist",
    "alist_versions",
    "create",
    "delete",
    "get",
    "list",
    "list_versions",
]
