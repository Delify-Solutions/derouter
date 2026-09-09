from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .pangea import PangeaHandler

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("Pangea guardrail name is required")

    _pangea_callback: Final = PangeaHandler(
        guardrail_name=guardrail_name,
        pangea_input_recipe=derouter_params.pangea_input_recipe,
        pangea_output_recipe=derouter_params.pangea_output_recipe,
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_pangea_callback)

    return _pangea_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.PANGEA.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.PANGEA.value: PangeaHandler,
}
