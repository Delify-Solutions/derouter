from typing import TYPE_CHECKING, Any, Final, cast

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .mcp_end_user_permission import MCPEndUserPermissionGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    # Default to always-on. Only disable if the user explicitly sets default_on: false.
    # We check the raw guardrail dict because LitellmParams normalizes None → False,
    # making it impossible to distinguish "not set" from "explicitly false" via derouter_params.
    _raw_default_on: Final = cast(dict[str, Any], guardrail).get("derouter_params", {}).get("default_on")
    _default_on: Final = False if _raw_default_on is False else True

    _callback: Final = MCPEndUserPermissionGuardrail(
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=_default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_callback)
    return _callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.MCP_END_USER_PERMISSION.value: initialize_guardrail,
}

guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.MCP_END_USER_PERMISSION.value: MCPEndUserPermissionGuardrail,
}
