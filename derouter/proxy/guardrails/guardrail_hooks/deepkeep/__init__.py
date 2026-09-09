from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .deepkeep import DeepKeepGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _deepkeep_guardrail_callback: Final = DeepKeepGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        firewall_id=getattr(derouter_params, "deepkeep_firewall_id", None),
        unreachable_fallback=getattr(derouter_params, "unreachable_fallback", "fail_closed"),
        extra_headers=getattr(derouter_params, "extra_headers", None),
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )

    derouter.logging_callback_manager.add_derouter_callback(_deepkeep_guardrail_callback)
    return _deepkeep_guardrail_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.DEEPKEEP.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.DEEPKEEP.value: DeepKeepGuardrail,
}
