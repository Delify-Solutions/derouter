"""
The per-request context an MCP gateway handler needs.

Listing and executing MCP tools both need the caller's identity, their MCP auth
headers, and the request's trace/tag identifiers. Every gateway surface resolves
the same set from its own kwargs, so resolving it in one place keeps a new
surface from silently dropping a field: omitting the auth headers, for instance,
still executes the tool, just with no credentials.
"""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final

from typing_extensions import NotRequired, ReadOnly, TypedDict

if TYPE_CHECKING:
    from derouter.proxy._types import UserAPIKeyAuth


class _AuthCarryingMetadata(TypedDict):
    """The one key this module reads out of a request's ``metadata`` / ``derouter_metadata``."""

    user_api_key_auth: ReadOnly[NotRequired["UserAPIKeyAuth | None"]]


@dataclass(frozen=True, slots=True)
class MCPRequestContext:
    """Everything a gateway handler must forward to MCP tool listing and execution."""

    user_api_key_auth: "UserAPIKeyAuth | None"
    mcp_auth_header: str | None = None
    mcp_server_auth_headers: Mapping[str, Mapping[str, str]] | None = None
    oauth2_headers: Mapping[str, str] | None = None
    raw_headers: Mapping[str, str] | None = None
    request_tags: Sequence[str] | None = None
    derouter_trace_id: str | None = None
    derouter_call_id: str | None = None

    @classmethod
    def resolve(
        cls,
        kwargs: Mapping[str, Any],
        tools: Iterable[object] | None,
    ) -> "MCPRequestContext":
        """
        Build the context from a gateway handler's kwargs.

        ``user_api_key_auth`` is read from both metadata keys because routes differ:
        DEROUTER_METADATA_ROUTES (``/v1/messages``, ``/responses``) carry it in
        ``derouter_metadata`` while ``/chat/completions`` uses ``metadata``.
        """
        from derouter.responses.mcp.derouter_proxy_mcp_handler import (
            DeRouter_Proxy_MCP_Handler,
        )
        from derouter.responses.utils import ResponsesAPIRequestUtils

        derouter_metadata: Final[_AuthCarryingMetadata] = kwargs.get("derouter_metadata") or {}
        metadata: Final[_AuthCarryingMetadata] = kwargs.get("metadata") or {}
        user_api_key_auth: Final[UserAPIKeyAuth | None] = (
            kwargs.get("user_api_key_auth")
            or derouter_metadata.get("user_api_key_auth")
            or metadata.get("user_api_key_auth")
        )

        (
            mcp_auth_header,
            mcp_server_auth_headers,
            oauth2_headers,
            raw_headers,
        ) = ResponsesAPIRequestUtils.extract_mcp_headers_from_request(
            secret_fields=kwargs.get("secret_fields"),
            tools=tools,
        )

        return cls(
            user_api_key_auth=user_api_key_auth,
            mcp_auth_header=mcp_auth_header,
            mcp_server_auth_headers=mcp_server_auth_headers,
            oauth2_headers=oauth2_headers,
            raw_headers=raw_headers,
            request_tags=DeRouter_Proxy_MCP_Handler._get_parent_request_tags(dict(kwargs)),
            derouter_trace_id=kwargs.get("derouter_trace_id"),
            derouter_call_id=kwargs.get("derouter_call_id"),
        )
