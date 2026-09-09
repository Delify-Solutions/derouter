from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .crowdstrike_aidr import CrowdStrikeAIDRHandler, streaming_params_from_derouter_params

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("CrowdStrike AIDR guardrail name is required")

    streaming_params: Final = streaming_params_from_derouter_params(derouter_params)
    _crowdstrike_aidr_callback: Final = CrowdStrikeAIDRHandler(
        guardrail_name=guardrail_name,
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
        fail_on_error=derouter_params.fail_on_error,
        streaming_end_of_stream_only=streaming_params.streaming_end_of_stream_only,
        streaming_sampling_rate=streaming_params.streaming_sampling_rate,
    )
    derouter.logging_callback_manager.add_derouter_callback(_crowdstrike_aidr_callback)

    return _crowdstrike_aidr_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.CROWDSTRIKE_AIDR.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.CROWDSTRIKE_AIDR.value: CrowdStrikeAIDRHandler,
}
