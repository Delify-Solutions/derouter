from typing import TYPE_CHECKING, Final, Optional

import derouter
from derouter.proxy.guardrails.guardrail_hooks.derouter_content_filter.content_filter import (
    ContentFilterGuardrail,
)
from derouter.types.guardrails import SupportedGuardrailIntegrations

if TYPE_CHECKING:
    from derouter import Router
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(
    derouter_params: "LitellmParams",
    guardrail: "Guardrail",
    llm_router: Optional["Router"] = None,
):
    """
    Initialize the Content Filter Guardrail.

    Args:
        derouter_params: Guardrail configuration parameters
        guardrail: Guardrail metadata

    Returns:
        Initialized ContentFilterGuardrail instance
    """
    guardrail_name: Final = guardrail.get("guardrail_name")

    if not guardrail_name:
        raise ValueError("Content Filter: guardrail_name is required")

    content_filter_guardrail: Final = ContentFilterGuardrail(
        guardrail_name=guardrail_name,
        guardrail_id=guardrail.get("guardrail_id"),
        policy_template=guardrail.get("policy_template"),
        patterns=derouter_params.patterns,
        blocked_words=derouter_params.blocked_words,
        blocked_words_file=derouter_params.blocked_words_file,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on or False,
        categories=getattr(derouter_params, "categories", None),
        severity_threshold=getattr(derouter_params, "severity_threshold", "medium"),
        llm_router=llm_router,
        image_model=getattr(derouter_params, "image_model", None),
        competitor_intent_config=getattr(derouter_params, "competitor_intent_config", None),
        end_session_after_n_fails=getattr(derouter_params, "end_session_after_n_fails", None),
        on_violation=getattr(derouter_params, "on_violation", None),
        realtime_violation_message=getattr(derouter_params, "realtime_violation_message", None),
    )

    derouter.logging_callback_manager.add_derouter_callback(content_filter_guardrail)

    return content_filter_guardrail


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.DEROUTER_CONTENT_FILTER.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.DEROUTER_CONTENT_FILTER.value: ContentFilterGuardrail,
}
