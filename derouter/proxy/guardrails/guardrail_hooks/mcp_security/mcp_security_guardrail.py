"""
MCP Security Guardrail for DeRouter.

Validates that MCP servers referenced in request tools are registered
on the DeRouter gateway. Blocks or alerts when unregistered servers are found.
"""

from typing import Any, Final, Literal

from fastapi import HTTPException

from derouter._logging import verbose_proxy_logger
from derouter.integrations.custom_guardrail import (
    CustomGuardrail,
    log_guardrail_information,
)
from derouter.proxy._types import UserAPIKeyAuth
from derouter.responses.mcp.derouter_proxy_mcp_handler import (
    DEROUTER_PROXY_MCP_SERVER_URL_PREFIX,
)
from derouter.types.guardrails import GuardrailEventHooks


class MCPSecurityGuardrail(CustomGuardrail):
    def __init__(
        self,
        on_violation: Literal["block", "alert"] = "block",
        **kwargs,
    ):
        kwargs.setdefault("supported_event_hooks", list(self.get_supported_event_hooks()))
        super().__init__(**kwargs)
        self.on_violation = on_violation

    @classmethod
    def get_supported_event_hooks(cls) -> list[GuardrailEventHooks]:
        return [GuardrailEventHooks.pre_call]

    @log_guardrail_information
    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache: Any,
        data: dict,
        call_type: str,
    ) -> Exception | str | dict | None:
        if self.should_run_guardrail(data=data, event_type=GuardrailEventHooks.pre_call) is not True:
            return data

        unregistered: Final = self._find_unregistered_mcp_servers(data)
        if not unregistered:
            return data

        message: Final = (
            f"MCP Security: request references unregistered MCP server(s): "
            f"{', '.join(sorted(unregistered))}. "
            f"Only servers registered on this gateway are allowed."
        )

        if self.on_violation == "block":
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "Violated guardrail policy",
                    "guardrail": "mcp_security",
                    "unregistered_servers": sorted(unregistered),
                    "detection_message": message,
                },
            )
        else:
            verbose_proxy_logger.warning(message)

        return data

    @staticmethod
    def _extract_mcp_server_names_from_tools(tools: list[dict]) -> set[str]:
        """Extract MCP server names from tools with type=mcp and derouter_proxy server_url."""
        server_names: Final[set[str]] = set()
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            if tool.get("type") != "mcp":
                continue
            server_url = tool.get("server_url", "")
            if not isinstance(server_url, str):
                continue
            if server_url.startswith(DEROUTER_PROXY_MCP_SERVER_URL_PREFIX):
                name = server_url[len(DEROUTER_PROXY_MCP_SERVER_URL_PREFIX) :]
                if name:
                    server_names.add(name)
        return server_names

    @staticmethod
    def _find_unregistered_mcp_servers(data: dict) -> set[str]:
        """Check tools in data against the MCP server registry. Returns set of unregistered server names."""
        tools: Final = data.get("tools")
        if not tools or not isinstance(tools, list):
            return set()

        requested_servers: Final = MCPSecurityGuardrail._extract_mcp_server_names_from_tools(tools)
        if not requested_servers:
            return set()

        from derouter.proxy._experimental.mcp_server.mcp_server_manager import (
            global_mcp_server_manager,
        )

        registry: Final = global_mcp_server_manager.get_registry()
        registered_names: Final = set(registry.keys())

        return requested_servers - registered_names
