from typing import TYPE_CHECKING, Final

from derouter.proxy.guardrails.guardrail_hooks.onyx.onyx import OnyxGuardrail
from derouter.types.guardrails import SupportedGuardrailIntegrations

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _onyx_callback: Final = OnyxGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_onyx_callback)

    return _onyx_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.ONYX.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.ONYX.value: OnyxGuardrail,
}
