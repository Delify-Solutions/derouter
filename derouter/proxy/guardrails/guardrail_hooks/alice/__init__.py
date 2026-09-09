from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .alice import AliceGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _alice_guardrail_callback: Final = AliceGuardrail(
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        unreachable_fallback=getattr(derouter_params, "unreachable_fallback", "fail_closed"),
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )

    derouter.logging_callback_manager.add_derouter_callback(_alice_guardrail_callback)
    return _alice_guardrail_callback


guardrail_initializer_registry: Final = {  # mutable-ok: module-level registry, built once and never mutated
    SupportedGuardrailIntegrations.ALICE.value: initialize_guardrail,
}


guardrail_class_registry: Final = {  # mutable-ok: module-level registry, built once and never mutated
    SupportedGuardrailIntegrations.ALICE.value: AliceGuardrail,
}
