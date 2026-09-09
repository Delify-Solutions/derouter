"""Gray Swan Cygnal guardrail integration for DeRouter."""

from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .grayswan import (
    GraySwanGuardrail,
    GraySwanGuardrailAPIError,
    GraySwanGuardrailMissingSecrets,
)

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail") -> GraySwanGuardrail:
    import derouter

    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("Gray Swan guardrail requires a guardrail_name")

    optional_params: Final = getattr(derouter_params, "optional_params", None)

    grayswan_guardrail: Final = GraySwanGuardrail(
        guardrail_name=guardrail_name,
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        on_flagged_action=_get_config_value(derouter_params, optional_params, "on_flagged_action"),
        violation_threshold=_get_config_value(derouter_params, optional_params, "violation_threshold"),
        reasoning_mode=_get_config_value(derouter_params, optional_params, "reasoning_mode"),
        categories=_get_config_value(derouter_params, optional_params, "categories"),
        policy_id=_get_config_value(derouter_params, optional_params, "policy_id"),
        streaming_end_of_stream_only=_get_config_value(derouter_params, optional_params, "streaming_end_of_stream_only")
        or False,
        streaming_sampling_rate=_get_config_value(derouter_params, optional_params, "streaming_sampling_rate") or 5,
        fail_open=_get_config_value(derouter_params, optional_params, "fail_open"),
        guardrail_timeout=_get_config_value(derouter_params, optional_params, "guardrail_timeout"),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )

    derouter.logging_callback_manager.add_derouter_callback(grayswan_guardrail)
    return grayswan_guardrail


def _get_config_value(derouter_params, optional_params, attribute_name):
    if optional_params is not None:
        value: Final = getattr(optional_params, attribute_name, None)
        if value is not None:
            return value
    return getattr(derouter_params, attribute_name, None)


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.GRAYSWAN.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.GRAYSWAN.value: GraySwanGuardrail,
}


__all__ = [
    "GraySwanGuardrail",
    "GraySwanGuardrailAPIError",
    "GraySwanGuardrailMissingSecrets",
    "initialize_guardrail",
]
