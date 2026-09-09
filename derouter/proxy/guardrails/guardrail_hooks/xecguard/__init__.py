from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .xecguard import XecGuardGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(
    derouter_params: "LitellmParams",
    guardrail: "Guardrail",
):
    import derouter

    _cb: Final = XecGuardGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        xecguard_model=derouter_params.xecguard_model,
        policy_names=derouter_params.policy_names,
        block_on_error=derouter_params.block_on_error,
        grounding_strictness=derouter_params.grounding_strictness,
        guardrail_name=guardrail.get(
            "guardrail_name",
            "",
        ),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(
        _cb,
    )

    return _cb


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.XECGUARD.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.XECGUARD.value: XecGuardGuardrail,
}
