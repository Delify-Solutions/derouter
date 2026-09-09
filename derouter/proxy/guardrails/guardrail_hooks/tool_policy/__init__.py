from typing import Final

import derouter
from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: LitellmParams, guardrail: Guardrail):
    from derouter.proxy.guardrails.guardrail_hooks.tool_policy.tool_policy_guardrail import (
        ToolPolicyGuardrail,
    )

    _callback: Final = ToolPolicyGuardrail(
        guardrail_name=guardrail.get("guardrail_name", "tool_policy"),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_callback)
    return _callback
