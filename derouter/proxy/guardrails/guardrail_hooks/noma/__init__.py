from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .noma import NomaGuardrail
from .noma_v2 import NomaV2Guardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    use_v2 = getattr(derouter_params, "use_v2", False)
    if isinstance(use_v2, str):
        use_v2 = use_v2.lower() == "true"
    if use_v2:
        return initialize_guardrail_v2(derouter_params=derouter_params, guardrail=guardrail)

    import derouter

    _noma_callback: Final = NomaGuardrail(
        guardrail_name=guardrail.get("guardrail_name", ""),
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        application_id=derouter_params.application_id,
        monitor_mode=derouter_params.monitor_mode,
        block_failures=derouter_params.block_failures,
        anonymize_input=derouter_params.anonymize_input,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_noma_callback)

    return _noma_callback


def initialize_guardrail_v2(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _noma_v2_callback: Final = NomaV2Guardrail(
        guardrail_name=guardrail.get("guardrail_name", ""),
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        application_id=derouter_params.application_id,
        monitor_mode=derouter_params.monitor_mode,
        block_failures=derouter_params.block_failures,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_noma_v2_callback)

    return _noma_v2_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.NOMA.value: initialize_guardrail,
    SupportedGuardrailIntegrations.NOMA_V2.value: initialize_guardrail_v2,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.NOMA.value: NomaGuardrail,
    SupportedGuardrailIntegrations.NOMA_V2.value: NomaV2Guardrail,
}
