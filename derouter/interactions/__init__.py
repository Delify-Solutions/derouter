"""
DeRouter Interactions API

This module provides SDK methods for Google's Interactions API.

Usage:
    import derouter

    # Create an interaction with a model
    response = derouter.interactions.create(
        model="gemini-2.5-flash",
        input="Hello, how are you?"
    )

    # Create an interaction with an agent
    response = derouter.interactions.create(
        agent="deep-research-pro-preview-12-2025",
        input="Research the current state of cancer research"
    )

    # Async version
    response = await derouter.interactions.acreate(...)

    # Get an interaction
    response = derouter.interactions.get(interaction_id="...")

    # Delete an interaction
    result = derouter.interactions.delete(interaction_id="...")

    # Cancel an interaction
    result = derouter.interactions.cancel(interaction_id="...")

    # Create a managed agent on the provider side
    result = derouter.interactions.agents.create(
        name="waverunner",
        custom_llm_provider="gemini",
        api_key="...",
        base_agent="gemini-2.5-flash",
        instructions="You are a helpful assistant.",
    )

Methods:
- create(): Sync create interaction
- acreate(): Async create interaction
- get(): Sync get interaction
- aget(): Async get interaction
- delete(): Sync delete interaction
- adelete(): Async delete interaction
- cancel(): Sync cancel interaction
- acancel(): Async cancel interaction

Sub-modules:
- agents: Provider-side agent creation (derouter.interactions.agents.create)
"""

from derouter.interactions import agents
from derouter.interactions.main import (
    acancel,
    acreate,
    adelete,
    aget,
    cancel,
    create,
    delete,
    get,
)

__all__ = [
    "acancel",
    "acreate",
    "adelete",
    "agents",
    "aget",
    "cancel",
    "create",
    "delete",
    "get",
]
