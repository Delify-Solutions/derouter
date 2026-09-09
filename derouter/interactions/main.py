"""
DeRouter Interactions API - Main Module

Per OpenAPI spec (https://ai.google.dev/static/api/interactions.openapi.json):
- Create interaction: POST /{api_version}/interactions
- Get interaction: GET /{api_version}/interactions/{interaction_id}
- Delete interaction: DELETE /{api_version}/interactions/{interaction_id}

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
"""

import asyncio
import contextvars
from collections.abc import AsyncIterator, Coroutine, Iterator
from functools import partial
from typing import Any, Final

import httpx

import derouter
from derouter.interactions.background_cost_polling import (
    maybe_schedule_background_interaction_cost_polling,
    maybe_settle_background_interaction_before_delete,
)
from derouter.interactions.http_handler import interactions_http_handler
from derouter.interactions.utils import (
    InteractionsAPIRequestUtils,
    get_provider_interactions_api_config,
)
from derouter.derouter_core_utils.derouter_logging import Logging as DeRouterLoggingObj
from derouter.types.interactions import (
    CancelInteractionResult,
    DeleteInteractionResult,
    InteractionEnvironment,
    InteractionInput,
    InteractionsAPIResponse,
    InteractionsAPIStreamingResponse,
    InteractionTool,
)
from derouter.types.router import GenericDeRouterParams
from derouter.utils import client

# ============================================================
# SDK Methods - CREATE INTERACTION
# ============================================================


@client
async def acreate(
    # Model or Agent (one required per OpenAPI spec)
    model: str | None = None,
    agent: str | None = None,
    # Input (required)
    input: InteractionInput | None = None,
    # Tools (for model interactions)
    tools: list[InteractionTool] | None = None,
    # System instruction
    system_instruction: str | None = None,
    # Generation config
    generation_config: dict[str, Any] | None = None,
    # Streaming
    stream: bool | None = None,
    # Storage
    store: bool | None = None,
    # Background execution
    background: bool | None = None,
    # Agent execution environment ("remote", env id, or remote config object)
    environment: InteractionEnvironment | None = None,
    # Response format
    response_modalities: list[str] | None = None,
    response_format: dict[str, Any] | None = None,
    response_mime_type: str | None = None,
    # Continuation
    previous_interaction_id: str | None = None,
    # Extra params
    extra_headers: dict[str, Any] | None = None,
    extra_body: dict[str, Any] | None = None,
    timeout: float | httpx.Timeout | None = None,
    # DeRouter params
    custom_llm_provider: str | None = None,
    **kwargs,
) -> InteractionsAPIResponse | AsyncIterator[InteractionsAPIStreamingResponse]:
    """
    Async: Create a new interaction using Google's Interactions API.

    Per OpenAPI spec, provide either `model` or `agent`.

    Args:
        model: The model to use (e.g., "gemini-2.5-flash")
        agent: The agent to use (e.g., "deep-research-pro-preview-12-2025")
        input: The input content (string, content object, or list)
        tools: Tools available for the model
        system_instruction: System instruction for the interaction
        generation_config: Generation configuration
        stream: Whether to stream the response
        store: Whether to store the response for later retrieval
        background: Whether to run in background
        environment: Agent execution environment — ``"remote"``, an existing env id
            string, or a config object such as
            ``{"type": "remote", "sources": [...]}`` /
            ``{"type": "remote", "network": {...}}``
        response_modalities: Requested response modalities (TEXT, IMAGE, AUDIO)
        response_format: JSON schema for response format
        response_mime_type: MIME type of the response
        previous_interaction_id: ID of previous interaction for continuation
        extra_headers: Additional headers
        extra_body: Additional body parameters
        timeout: Request timeout
        custom_llm_provider: Override the LLM provider

    Returns:
        InteractionsAPIResponse or async iterator for streaming
    """
    local_vars: Final = locals()
    try:
        loop: Final = asyncio.get_event_loop()
        kwargs["acreate_interaction"] = True

        if custom_llm_provider is None and model:
            _, custom_llm_provider, _, _ = derouter.get_llm_provider(model=model, api_base=kwargs.get("api_base", None))
        elif custom_llm_provider is None:
            custom_llm_provider = "gemini"

        func: Final = partial(
            create,
            model=model,
            agent=agent,
            input=input,
            tools=tools,
            system_instruction=system_instruction,
            generation_config=generation_config,
            stream=stream,
            store=store,
            background=background,
            environment=environment,
            response_modalities=response_modalities,
            response_format=response_format,
            response_mime_type=response_mime_type,
            previous_interaction_id=previous_interaction_id,
            extra_headers=extra_headers,
            extra_body=extra_body,
            timeout=timeout,
            custom_llm_provider=custom_llm_provider,
            **kwargs,
        )

        ctx: Final = contextvars.copy_context()
        func_with_context: Final = partial(ctx.run, func)
        init_response: Final = await loop.run_in_executor(None, func_with_context)

        if asyncio.iscoroutine(init_response):
            response = await init_response
        else:
            response = init_response

        maybe_schedule_background_interaction_cost_polling(
            response=response,
            create_kwargs=kwargs,
            custom_llm_provider=custom_llm_provider,
        )

        return response
    except Exception as e:
        raise derouter.exception_type(
            model=model,
            custom_llm_provider=custom_llm_provider,
            original_exception=e,
            completion_kwargs=local_vars,
            extra_kwargs=kwargs,
        )


@client
def create(
    # Model or Agent (one required per OpenAPI spec)
    model: str | None = None,
    agent: str | None = None,
    # Input (required)
    input: InteractionInput | None = None,
    # Tools (for model interactions)
    tools: list[InteractionTool] | None = None,
    # System instruction
    system_instruction: str | None = None,
    # Generation config
    generation_config: dict[str, Any] | None = None,
    # Streaming
    stream: bool | None = None,
    # Storage
    store: bool | None = None,
    # Background execution
    background: bool | None = None,
    # Agent execution environment ("remote", env id, or remote config object)
    environment: InteractionEnvironment | None = None,
    # Response format
    response_modalities: list[str] | None = None,
    response_format: dict[str, Any] | None = None,
    response_mime_type: str | None = None,
    # Continuation
    previous_interaction_id: str | None = None,
    # Extra params
    extra_headers: dict[str, Any] | None = None,
    extra_body: dict[str, Any] | None = None,
    timeout: float | httpx.Timeout | None = None,
    # DeRouter params
    custom_llm_provider: str | None = None,
    **kwargs,
) -> (
    InteractionsAPIResponse
    | Iterator[InteractionsAPIStreamingResponse]
    | Coroutine[object, object, InteractionsAPIResponse | AsyncIterator[InteractionsAPIStreamingResponse]]
):
    """
    Sync: Create a new interaction using Google's Interactions API.

    Per OpenAPI spec, provide either `model` or `agent`.

    Args:
        model: The model to use (e.g., "gemini-2.5-flash")
        agent: The agent to use (e.g., "deep-research-pro-preview-12-2025")
        input: The input content (string, content object, or list)
        tools: Tools available for the model
        system_instruction: System instruction for the interaction
        generation_config: Generation configuration
        stream: Whether to stream the response
        store: Whether to store the response for later retrieval
        background: Whether to run in background
        environment: Agent execution environment — ``"remote"``, an existing env id
            string, or a config object such as
            ``{"type": "remote", "sources": [...]}`` /
            ``{"type": "remote", "network": {...}}``
        response_modalities: Requested response modalities (TEXT, IMAGE, AUDIO)
        response_format: JSON schema for response format
        response_mime_type: MIME type of the response
        previous_interaction_id: ID of previous interaction for continuation
        extra_headers: Additional headers
        extra_body: Additional body parameters
        timeout: Request timeout
        custom_llm_provider: Override the LLM provider

    Returns:
        InteractionsAPIResponse or iterator for streaming
    """
    local_vars: Final = locals()

    try:
        derouter_logging_obj: Final[DeRouterLoggingObj] = kwargs.get("derouter_logging_obj")
        derouter_call_id: Final[str | None] = kwargs.get("derouter_call_id", None)
        _is_async: Final = kwargs.pop("acreate_interaction", False) is True

        derouter_params: Final = GenericDeRouterParams(**kwargs)

        # Routing logic:
        # - agent provided (no model, or model accidentally set to agent name) → gemini
        # - model provided → resolve provider via get_llm_provider (normal routing)
        if agent and model == agent:
            model = None
        if agent and not model:
            custom_llm_provider = custom_llm_provider or "gemini"
        elif model:
            model, custom_llm_provider, _, _ = derouter.get_llm_provider(
                model=model,
                custom_llm_provider=custom_llm_provider,
                api_base=derouter_params.api_base,
                api_key=derouter_params.api_key,
            )
        else:
            custom_llm_provider = custom_llm_provider or "gemini"

        interactions_api_config: Final = get_provider_interactions_api_config(
            provider=custom_llm_provider,
            model=model,
        )

        # Get optional params using utility (similar to responses API pattern)
        local_vars.update(kwargs)
        optional_params: Final = InteractionsAPIRequestUtils.get_requested_interactions_api_optional_params(local_vars)

        # Check if this is a bridge provider (derouter_responses) - similar to responses API
        # Either provider is explicitly "derouter_responses" or no config found (bridge to responses)
        if custom_llm_provider == "derouter_responses" or interactions_api_config is None:
            # Bridge to derouter.responses() for non-native providers
            from derouter.interactions.derouter_responses_transformation.handler import (
                DeRouterResponsesInteractionsHandler,
            )

            handler: Final = DeRouterResponsesInteractionsHandler()
            return handler.interactions_api_handler(
                model=model or "",
                input=input,
                optional_params=optional_params,
                custom_llm_provider=custom_llm_provider,
                _is_async=_is_async,
                stream=stream,
                **kwargs,
            )

        derouter_logging_obj.update_from_kwargs(
            kwargs=kwargs,
            model=model,
            optional_params=dict(optional_params),
            derouter_params={"derouter_call_id": derouter_call_id},
            custom_llm_provider=custom_llm_provider,
        )

        response: Final = interactions_http_handler.create_interaction(
            model=model,
            agent=agent,
            input=input,
            interactions_api_config=interactions_api_config,
            optional_params=optional_params,
            custom_llm_provider=custom_llm_provider,
            derouter_params=derouter_params,
            logging_obj=derouter_logging_obj,
            extra_headers=extra_headers,
            extra_body=extra_body,
            timeout=timeout,
            _is_async=_is_async,
            stream=stream,
        )

        return response
    except Exception as e:
        raise derouter.exception_type(
            model=model,
            custom_llm_provider=custom_llm_provider,
            original_exception=e,
            completion_kwargs=local_vars,
            extra_kwargs=kwargs,
        )


# ============================================================
# SDK Methods - GET INTERACTION
# ============================================================


@client
async def aget(
    interaction_id: str,
    extra_headers: dict[str, Any] | None = None,
    timeout: float | httpx.Timeout | None = None,
    custom_llm_provider: str | None = None,
    **kwargs,
) -> InteractionsAPIResponse:
    """Async: Get an interaction by its ID."""
    local_vars: Final = locals()
    try:
        loop: Final = asyncio.get_event_loop()
        kwargs["aget_interaction"] = True

        func: Final = partial(
            get,
            interaction_id=interaction_id,
            extra_headers=extra_headers,
            timeout=timeout,
            custom_llm_provider=custom_llm_provider or "gemini",
            **kwargs,
        )

        ctx: Final = contextvars.copy_context()
        func_with_context: Final = partial(ctx.run, func)
        init_response: Final = await loop.run_in_executor(None, func_with_context)

        if asyncio.iscoroutine(init_response):
            response = await init_response
        else:
            response = init_response

        return response
    except Exception as e:
        raise derouter.exception_type(
            model=None,
            custom_llm_provider=custom_llm_provider or "gemini",
            original_exception=e,
            completion_kwargs=local_vars,
            extra_kwargs=kwargs,
        )


@client
def get(
    interaction_id: str,
    extra_headers: dict[str, Any] | None = None,
    timeout: float | httpx.Timeout | None = None,
    custom_llm_provider: str | None = None,
    **kwargs,
) -> InteractionsAPIResponse | Coroutine[object, object, InteractionsAPIResponse]:
    """Sync: Get an interaction by its ID."""
    local_vars: Final = locals()
    custom_llm_provider = custom_llm_provider or "gemini"

    try:
        derouter_logging_obj: Final[DeRouterLoggingObj] = kwargs.get("derouter_logging_obj")
        derouter_call_id: Final[str | None] = kwargs.get("derouter_call_id", None)
        _is_async: Final = kwargs.pop("aget_interaction", False) is True

        derouter_params: Final = GenericDeRouterParams(**kwargs)

        interactions_api_config: Final = get_provider_interactions_api_config(
            provider=custom_llm_provider,
        )

        if interactions_api_config is None:
            raise ValueError(f"Interactions API not supported for: {custom_llm_provider}")

        derouter_logging_obj.update_from_kwargs(
            kwargs=kwargs,
            model=None,
            optional_params={"interaction_id": interaction_id},
            derouter_params={"derouter_call_id": derouter_call_id},
            custom_llm_provider=custom_llm_provider,
        )

        return interactions_http_handler.get_interaction(
            interaction_id=interaction_id,
            interactions_api_config=interactions_api_config,
            custom_llm_provider=custom_llm_provider,
            derouter_params=derouter_params,
            logging_obj=derouter_logging_obj,
            extra_headers=extra_headers,
            timeout=timeout,
            _is_async=_is_async,
        )
    except Exception as e:
        raise derouter.exception_type(
            model=None,
            custom_llm_provider=custom_llm_provider,
            original_exception=e,
            completion_kwargs=local_vars,
            extra_kwargs=kwargs,
        )


# ============================================================
# SDK Methods - DELETE INTERACTION
# ============================================================


@client
async def adelete(
    interaction_id: str,
    extra_headers: dict[str, Any] | None = None,
    timeout: float | httpx.Timeout | None = None,
    custom_llm_provider: str | None = None,
    **kwargs,
) -> DeleteInteractionResult:
    """Async: Delete an interaction by its ID."""
    local_vars: Final = locals()
    try:
        loop: Final = asyncio.get_event_loop()
        kwargs["adelete_interaction"] = True

        await maybe_settle_background_interaction_before_delete(interaction_id=interaction_id)

        func: Final = partial(
            delete,
            interaction_id=interaction_id,
            extra_headers=extra_headers,
            timeout=timeout,
            custom_llm_provider=custom_llm_provider or "gemini",
            **kwargs,
        )

        ctx: Final = contextvars.copy_context()
        func_with_context: Final = partial(ctx.run, func)
        init_response: Final = await loop.run_in_executor(None, func_with_context)

        if asyncio.iscoroutine(init_response):
            response = await init_response
        else:
            response = init_response

        return response
    except Exception as e:
        raise derouter.exception_type(
            model=None,
            custom_llm_provider=custom_llm_provider or "gemini",
            original_exception=e,
            completion_kwargs=local_vars,
            extra_kwargs=kwargs,
        )


@client
def delete(
    interaction_id: str,
    extra_headers: dict[str, Any] | None = None,
    timeout: float | httpx.Timeout | None = None,
    custom_llm_provider: str | None = None,
    **kwargs,
) -> DeleteInteractionResult | Coroutine[object, object, DeleteInteractionResult]:
    """Sync: Delete an interaction by its ID."""
    local_vars: Final = locals()
    custom_llm_provider = custom_llm_provider or "gemini"

    try:
        derouter_logging_obj: Final[DeRouterLoggingObj] = kwargs.get("derouter_logging_obj")
        derouter_call_id: Final[str | None] = kwargs.get("derouter_call_id", None)
        _is_async: Final = kwargs.pop("adelete_interaction", False) is True

        derouter_params: Final = GenericDeRouterParams(**kwargs)

        interactions_api_config: Final = get_provider_interactions_api_config(
            provider=custom_llm_provider,
        )

        if interactions_api_config is None:
            raise ValueError(f"Interactions API not supported for: {custom_llm_provider}")

        derouter_logging_obj.update_from_kwargs(
            kwargs=kwargs,
            model=None,
            optional_params={"interaction_id": interaction_id},
            derouter_params={"derouter_call_id": derouter_call_id},
            custom_llm_provider=custom_llm_provider,
        )

        return interactions_http_handler.delete_interaction(
            interaction_id=interaction_id,
            interactions_api_config=interactions_api_config,
            custom_llm_provider=custom_llm_provider,
            derouter_params=derouter_params,
            logging_obj=derouter_logging_obj,
            extra_headers=extra_headers,
            timeout=timeout,
            _is_async=_is_async,
        )
    except Exception as e:
        raise derouter.exception_type(
            model=None,
            custom_llm_provider=custom_llm_provider,
            original_exception=e,
            completion_kwargs=local_vars,
            extra_kwargs=kwargs,
        )


# ============================================================
# SDK Methods - CANCEL INTERACTION
# ============================================================


@client
async def acancel(
    interaction_id: str,
    extra_headers: dict[str, Any] | None = None,
    timeout: float | httpx.Timeout | None = None,
    custom_llm_provider: str | None = None,
    **kwargs,
) -> CancelInteractionResult:
    """Async: Cancel an interaction by its ID."""
    local_vars: Final = locals()
    try:
        loop: Final = asyncio.get_event_loop()
        kwargs["acancel_interaction"] = True

        func: Final = partial(
            cancel,
            interaction_id=interaction_id,
            extra_headers=extra_headers,
            timeout=timeout,
            custom_llm_provider=custom_llm_provider or "gemini",
            **kwargs,
        )

        ctx: Final = contextvars.copy_context()
        func_with_context: Final = partial(ctx.run, func)
        init_response: Final = await loop.run_in_executor(None, func_with_context)

        if asyncio.iscoroutine(init_response):
            response = await init_response
        else:
            response = init_response

        return response
    except Exception as e:
        raise derouter.exception_type(
            model=None,
            custom_llm_provider=custom_llm_provider or "gemini",
            original_exception=e,
            completion_kwargs=local_vars,
            extra_kwargs=kwargs,
        )


@client
def cancel(
    interaction_id: str,
    extra_headers: dict[str, Any] | None = None,
    timeout: float | httpx.Timeout | None = None,
    custom_llm_provider: str | None = None,
    **kwargs,
) -> CancelInteractionResult | Coroutine[object, object, CancelInteractionResult]:
    """Sync: Cancel an interaction by its ID."""
    local_vars: Final = locals()
    custom_llm_provider = custom_llm_provider or "gemini"

    try:
        derouter_logging_obj: Final[DeRouterLoggingObj] = kwargs.get("derouter_logging_obj")
        derouter_call_id: Final[str | None] = kwargs.get("derouter_call_id", None)
        _is_async: Final = kwargs.pop("acancel_interaction", False) is True

        derouter_params: Final = GenericDeRouterParams(**kwargs)

        interactions_api_config: Final = get_provider_interactions_api_config(
            provider=custom_llm_provider,
        )

        if interactions_api_config is None:
            raise ValueError(f"Interactions API not supported for: {custom_llm_provider}")

        derouter_logging_obj.update_from_kwargs(
            kwargs=kwargs,
            model=None,
            optional_params={"interaction_id": interaction_id},
            derouter_params={"derouter_call_id": derouter_call_id},
            custom_llm_provider=custom_llm_provider,
        )

        return interactions_http_handler.cancel_interaction(
            interaction_id=interaction_id,
            interactions_api_config=interactions_api_config,
            custom_llm_provider=custom_llm_provider,
            derouter_params=derouter_params,
            logging_obj=derouter_logging_obj,
            extra_headers=extra_headers,
            timeout=timeout,
            _is_async=_is_async,
        )
    except Exception as e:
        raise derouter.exception_type(
            model=None,
            custom_llm_provider=custom_llm_provider,
            original_exception=e,
            completion_kwargs=local_vars,
            extra_kwargs=kwargs,
        )
