from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .guardrails_ai import GuardrailsAI

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    if derouter_params.guard_name is None:
        raise Exception(
            "GuardrailsAIException - Please pass the Guardrails AI guard name via 'derouter_params::guard_name'"
        )

    _guardrails_ai_callback: Final = GuardrailsAI(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
        guard_name=derouter_params.guard_name,
        guardrails_ai_api_input_format=getattr(derouter_params, "guardrails_ai_api_input_format", "llmOutput"),
    )
    derouter.logging_callback_manager.add_derouter_callback(_guardrails_ai_callback)

    return _guardrails_ai_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.GUARDRAILS_AI.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.GUARDRAILS_AI.value: GuardrailsAI,
}
