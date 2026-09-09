from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .prompt_shield import AzureContentSafetyPromptShieldGuardrail
from .text_moderation import AzureContentSafetyTextModerationGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    if not derouter_params.api_key:
        raise ValueError("Azure Content Safety: api_key is required")
    if not derouter_params.api_base:
        raise ValueError("Azure Content Safety: api_base is required")

    azure_guardrail: Final = derouter_params.guardrail.split("/")[1]

    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("Azure Content Safety: guardrail_name is required")

    if azure_guardrail == "prompt_shield":
        azure_content_safety_guardrail: (
            AzureContentSafetyPromptShieldGuardrail | AzureContentSafetyTextModerationGuardrail
        ) = AzureContentSafetyPromptShieldGuardrail(
            guardrail_name=guardrail_name,
            **{
                **derouter_params.model_dump(exclude_none=True),
                "api_key": derouter_params.api_key,
                "api_base": derouter_params.api_base,
                "default_on": derouter_params.default_on,
                "event_hook": derouter_params.mode,
            },
        )
    elif azure_guardrail == "text_moderations":
        azure_content_safety_guardrail = AzureContentSafetyTextModerationGuardrail(
            guardrail_name=guardrail_name,
            **{
                **derouter_params.model_dump(exclude_none=True),
                "api_key": derouter_params.api_key,
                "api_base": derouter_params.api_base,
                "default_on": derouter_params.default_on,
                "event_hook": derouter_params.mode,
            },
        )
    else:
        raise ValueError(f"Azure Content Safety: {azure_guardrail} is not a valid guardrail")

    derouter.logging_callback_manager.add_derouter_callback(azure_content_safety_guardrail)
    return azure_content_safety_guardrail


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.AZURE_PROMPT_SHIELD.value: initialize_guardrail,
    SupportedGuardrailIntegrations.AZURE_TEXT_MODERATIONS.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.AZURE_PROMPT_SHIELD.value: AzureContentSafetyPromptShieldGuardrail,
    SupportedGuardrailIntegrations.AZURE_TEXT_MODERATIONS.value: AzureContentSafetyTextModerationGuardrail,
}
