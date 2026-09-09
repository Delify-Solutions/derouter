from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .qualifire import QualifireGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _qualifire_callback: Final = QualifireGuardrail(
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        evaluation_id=getattr(derouter_params, "evaluation_id", None),
        prompt_injections=getattr(derouter_params, "prompt_injections", None),
        hallucinations_check=getattr(derouter_params, "hallucinations_check", None),
        grounding_check=getattr(derouter_params, "grounding_check", None),
        pii_check=getattr(derouter_params, "pii_check", None),
        content_moderation_check=getattr(derouter_params, "content_moderation_check", None),
        tool_selection_quality_check=getattr(derouter_params, "tool_selection_quality_check", None),
        assertions=getattr(derouter_params, "assertions", None),
        on_flagged=getattr(derouter_params, "on_flagged", "block"),
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )

    derouter.logging_callback_manager.add_derouter_callback(_qualifire_callback)

    return _qualifire_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.QUALIFIRE.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.QUALIFIRE.value: QualifireGuardrail,
}
