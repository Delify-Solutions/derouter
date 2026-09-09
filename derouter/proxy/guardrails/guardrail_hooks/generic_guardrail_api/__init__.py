from typing import TYPE_CHECKING, Any, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .generic_guardrail_api import GenericGuardrailAPI

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def _get_config_value(derouter_params: Any, optional_params: Any, attribute_name: str) -> Any | None:
    if optional_params is not None:
        value: Final = (
            optional_params.get(attribute_name)
            if isinstance(optional_params, dict)
            else getattr(optional_params, attribute_name, None)
        )
        if value is not None:
            return value
    return getattr(derouter_params, attribute_name, None)


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    optional_params: Final = getattr(derouter_params, "optional_params", None)

    _generic_guardrail_api_callback: Final = GenericGuardrailAPI(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        headers=getattr(derouter_params, "headers", None),
        additional_provider_specific_params=getattr(derouter_params, "additional_provider_specific_params", {}),
        unreachable_fallback=getattr(derouter_params, "unreachable_fallback", "fail_closed"),
        fail_on_error=getattr(derouter_params, "fail_on_error", True),
        extra_headers=getattr(derouter_params, "extra_headers", None),
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
        streaming_end_of_stream_only=_get_config_value(derouter_params, optional_params, "streaming_end_of_stream_only"),
        streaming_sampling_rate=_get_config_value(derouter_params, optional_params, "streaming_sampling_rate"),
        streaming_transform_mode=_get_config_value(derouter_params, optional_params, "streaming_transform_mode"),
    )

    derouter.logging_callback_manager.add_derouter_callback(_generic_guardrail_api_callback)
    return _generic_guardrail_api_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.GENERIC_GUARDRAIL_API.value: initialize_guardrail,
}

guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.GENERIC_GUARDRAIL_API.value: GenericGuardrailAPI,
}
