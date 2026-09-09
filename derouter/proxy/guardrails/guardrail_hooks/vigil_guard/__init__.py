from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .vigil_guard import VigilGuardGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _vigil_guard_callback: Final = VigilGuardGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        unreachable_fallback=derouter_params.unreachable_fallback,
        timeout=derouter_params.timeout,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_vigil_guard_callback)
    return _vigil_guard_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.VIGIL_GUARD.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.VIGIL_GUARD.value: VigilGuardGuardrail,
}
