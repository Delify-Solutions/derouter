from typing import TYPE_CHECKING, Final

import derouter
from derouter.proxy.guardrails.guardrail_hooks.openai.moderations import (
    OpenAIModerationGuardrail,
)
from derouter.types.guardrails import SupportedGuardrailIntegrations

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("OpenAI Moderation: guardrail_name is required")

    optional_params: Final = getattr(derouter_params, "optional_params", None)

    openai_moderation_guardrail: Final = OpenAIModerationGuardrail(
        guardrail_name=guardrail_name,
        **{
            **derouter_params.model_dump(exclude_none=True),
            "api_key": derouter_params.api_key,
            "api_base": derouter_params.api_base,
            "default_on": derouter_params.default_on,
            "event_hook": derouter_params.mode,
            "model": derouter_params.model,
            "streaming_end_of_stream_only": _get_config_value(
                derouter_params, optional_params, "streaming_end_of_stream_only"
            ),
            "streaming_sampling_rate": _get_config_value(derouter_params, optional_params, "streaming_sampling_rate"),
        },
    )

    derouter.logging_callback_manager.add_derouter_callback(openai_moderation_guardrail)

    return openai_moderation_guardrail


def _get_config_value(derouter_params, optional_params, attribute_name):
    if optional_params is not None:
        value: Final = getattr(optional_params, attribute_name, None)
        if value is not None:
            return value
    return getattr(derouter_params, attribute_name, None)


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.OPENAI_MODERATION.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.OPENAI_MODERATION.value: OpenAIModerationGuardrail,
}
