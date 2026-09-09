from typing import TYPE_CHECKING, Final, Literal, Optional

import derouter
from derouter.proxy.guardrails.guardrail_hooks.mcp_security.mcp_security_guardrail import (
    MCPSecurityGuardrail,
)
from derouter.types.guardrails import SupportedGuardrailIntegrations

if TYPE_CHECKING:
    from derouter import Router
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(
    derouter_params: "LitellmParams",
    guardrail: "Guardrail",
    llm_router: Optional["Router"] = None,
):
    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("MCP Security: guardrail_name is required")

    on_violation: Final[Literal["block", "alert"]] = "block" if derouter_params.on_violation == "block" else "alert"

    mcp_security_guardrail: Final = MCPSecurityGuardrail(
        guardrail_name=guardrail_name,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on or False,
        on_violation=on_violation,
    )

    derouter.logging_callback_manager.add_derouter_callback(mcp_security_guardrail)
    return mcp_security_guardrail


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.MCP_SECURITY.value: initialize_guardrail,
}

guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.MCP_SECURITY.value: MCPSecurityGuardrail,
}
