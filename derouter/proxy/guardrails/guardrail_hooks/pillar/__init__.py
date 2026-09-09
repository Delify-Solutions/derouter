"""
Pillar Security Guardrail Integration for DeRouter
"""

from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .pillar import (
    PillarGuardrail,
    PillarGuardrailAPIError,
    PillarGuardrailMissingSecrets,
)

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("Pillar guardrail name is required")

    optional_params: Final = getattr(derouter_params, "optional_params", None)

    _pillar_callback: Final = PillarGuardrail(
        guardrail_name=guardrail_name,
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        on_flagged_action=getattr(derouter_params, "on_flagged_action", "monitor"),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
        async_mode=_get_config_value(derouter_params, optional_params, "async_mode"),
        persist_session=_get_config_value(derouter_params, optional_params, "persist_session"),
        include_scanners=_get_config_value(derouter_params, optional_params, "include_scanners"),
        include_evidence=_get_config_value(derouter_params, optional_params, "include_evidence"),
        fallback_on_error=_get_config_value(derouter_params, optional_params, "fallback_on_error"),
        timeout=_get_config_value(derouter_params, optional_params, "timeout"),
    )
    derouter.logging_callback_manager.add_derouter_callback(_pillar_callback)

    return _pillar_callback


def _get_config_value(derouter_params, optional_params, attribute_name):
    """Return guardrail configuration value prioritising optional params when present."""

    if optional_params is not None:
        value: Final = getattr(optional_params, attribute_name, None)
        if value is not None:
            return value
    return getattr(derouter_params, attribute_name, None)


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.PILLAR.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.PILLAR.value: PillarGuardrail,
}

__all__ = [
    "PillarGuardrail",
    "PillarGuardrailAPIError",
    "PillarGuardrailMissingSecrets",
]
