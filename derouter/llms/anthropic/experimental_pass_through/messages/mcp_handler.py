"""
MCP gateway support for the Anthropic `/v1/messages` API.

Mirrors ``derouter.responses.mcp.chat_completions_handler`` but speaks the
Anthropic Messages shapes: tools carry an ``input_schema``, the model asks for a
tool through a ``tool_use`` content block, and results are fed back as
``tool_result`` blocks in a user message.
"""

from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping, Sequence
from typing import Any, Final, NamedTuple

from derouter._logging import verbose_logger
from derouter.responses.mcp.request_context import MCPRequestContext
from derouter.types.llms.anthropic import (
    AnthropicMessagesTool,
    AnthropicMessagesToolResultParam,
    AnthropicMessagesUserMessageParam,
)
from derouter.types.llms.anthropic_messages.anthropic_response import (
    AnthropicMessagesResponse,
)

MAX_MCP_TOOL_USE_ITERATIONS: Final = 10


class _AnthropicMessagesCall(NamedTuple):
    fn: Callable[..., Awaitable[AnthropicMessagesResponse | Iterator[bytes] | AsyncIterator[object]]]


def _get_response_content(response: AnthropicMessagesResponse) -> Sequence[Mapping[str, object]]:
    content: Final = response.get("content")
    if not isinstance(content, list):
        return ()
    return tuple(block for block in content if isinstance(block, dict))


def _extract_tool_use_blocks(response: AnthropicMessagesResponse) -> Sequence[Mapping[str, object]]:
    """Return the ``tool_use`` content blocks the model emitted."""
    return tuple(block for block in _get_response_content(response) if block.get("type") == "tool_use")


def _get_stop_reason(response: AnthropicMessagesResponse) -> str | None:
    stop_reason: Final = response.get("stop_reason")
    return stop_reason if isinstance(stop_reason, str) else None


def _build_tool_result_message(tool_results: Sequence[Mapping[str, object]]) -> AnthropicMessagesUserMessageParam:
    """Turn executed tool results into the user message Anthropic expects."""
    return AnthropicMessagesUserMessageParam(
        role="user",
        content=tuple(
            AnthropicMessagesToolResultParam(
                type="tool_result",
                tool_use_id=str(result.get("tool_call_id") or ""),
                content=str(result.get("result") or ""),
            )
            for result in tool_results
        ),
    )


async def anthropic_messages_with_mcp(
    max_tokens: int,
    messages: Sequence[Mapping[str, object]],
    model: str,
    tools: Sequence[Mapping[str, object]] | None = None,
    **kwargs: Any,  # kwargs-ok: forwarded verbatim to derouter.anthropic_messages, which owns the param contract
) -> AnthropicMessagesResponse | Iterator[bytes] | AsyncIterator[object]:
    """
    Expand derouter_proxy MCP references for `/v1/messages` and run the tool loop.

    The MCP gateway owns the expansion so the reference resolves against the
    caller's own credentials and access control, rather than being handed to the
    upstream provider as a url it cannot reach.
    """
    import derouter
    from derouter.experimental_mcp_client.tools import (
        transform_mcp_tool_to_anthropic_tool,
    )
    from derouter.responses.mcp.derouter_proxy_mcp_handler import (
        DeRouter_Proxy_MCP_Handler,
    )

    mcp_references, other_tools = await DeRouter_Proxy_MCP_Handler._split_mcp_tools(tools)

    if not mcp_references:
        return await _AnthropicMessagesCall(fn=derouter.anthropic_messages).fn(
            max_tokens=max_tokens,
            messages=list(messages),
            model=model,
            tools=list(tools) if tools else None,
            _skip_mcp_handler=True,
            **kwargs,
        )

    context: Final = MCPRequestContext.resolve(kwargs=dict(kwargs), tools=tools)

    (
        deduplicated_mcp_tools,
        tool_server_map,
    ) = await DeRouter_Proxy_MCP_Handler._process_mcp_tools_without_openai_transform(
        context.user_api_key_auth,
        mcp_references,
        derouter_trace_id=context.derouter_trace_id,
        mcp_auth_header=context.mcp_auth_header,
        mcp_server_auth_headers=context.mcp_server_auth_headers,
        request_tags=list(context.request_tags) if context.request_tags else None,
    )

    anthropic_tools: Final[Sequence[AnthropicMessagesTool]] = tuple(
        transform_mcp_tool_to_anthropic_tool(mcp_tool) for mcp_tool in deduplicated_mcp_tools
    )
    all_tools: Final = [*anthropic_tools, *(other_tools or ())]

    should_auto_execute: Final = DeRouter_Proxy_MCP_Handler._should_auto_execute_tools(
        mcp_tools_with_derouter_proxy=mcp_references
    )
    stream: Final = bool(kwargs.pop("stream", False))

    base_call_args: Final[Mapping[str, object]] = {
        "max_tokens": max_tokens,
        "model": model,
        "tools": all_tools or None,
        "_skip_mcp_handler": True,
        **kwargs,
    }

    if not should_auto_execute:
        return await _AnthropicMessagesCall(fn=derouter.anthropic_messages).fn(
            messages=list(messages), stream=stream, **base_call_args
        )

    working_messages: Sequence[Mapping[str, object]] = tuple(messages)
    response: AnthropicMessagesResponse = await _AnthropicMessagesCall(fn=derouter.anthropic_messages).fn(
        messages=list(working_messages), stream=False, **base_call_args
    )

    for _ in range(MAX_MCP_TOOL_USE_ITERATIONS):
        if _get_stop_reason(response) != "tool_use":
            break

        tool_use_blocks = _extract_tool_use_blocks(response)
        if not tool_use_blocks:
            break

        tool_results = await DeRouter_Proxy_MCP_Handler._execute_tool_calls(
            tool_server_map=tool_server_map,
            tool_calls=list(tool_use_blocks),
            user_api_key_auth=context.user_api_key_auth,
            mcp_auth_header=context.mcp_auth_header,
            mcp_server_auth_headers=context.mcp_server_auth_headers,
            oauth2_headers=context.oauth2_headers,
            raw_headers=context.raw_headers,
            derouter_call_id=context.derouter_call_id,
            derouter_trace_id=context.derouter_trace_id,
            request_tags=list(context.request_tags) if context.request_tags else None,
        )

        # Every tool call was skipped, so there is nothing to feed back; a
        # tool_result message with empty content is rejected by Anthropic.
        if not tool_results:
            break

        working_messages = (
            *working_messages,
            {"role": "assistant", "content": list(_get_response_content(response))},
            _build_tool_result_message(tool_results),
        )
        response = await _AnthropicMessagesCall(fn=derouter.anthropic_messages).fn(
            messages=list(working_messages), stream=False, **base_call_args
        )
    else:
        verbose_logger.warning(
            "MCP tool loop hit its %s iteration cap for model %s; returning the last response",
            MAX_MCP_TOOL_USE_ITERATIONS,
            model,
        )

    if stream:
        from derouter.llms.anthropic.experimental_pass_through.messages.fake_stream_iterator import (
            FakeAnthropicMessagesStreamIterator,
        )

        return FakeAnthropicMessagesStreamIterator(response)
    return response
