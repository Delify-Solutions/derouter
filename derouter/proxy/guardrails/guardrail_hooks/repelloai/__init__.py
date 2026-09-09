from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import (
    GuardrailEventHooks,
    Mode,
    SupportedGuardrailIntegrations,
)

from .repelloai import RepelloAIGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def _event_hook_from_mode(
    mode: str | list[str] | Mode,
) -> GuardrailEventHooks | list[GuardrailEventHooks] | Mode:
    if isinstance(mode, Mode):
        return mode
    if isinstance(mode, list):
        return [GuardrailEventHooks(item) for item in mode]
    return GuardrailEventHooks(mode)


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail") -> RepelloAIGuardrail:
    import derouter

    _repelloai_callback: Final = RepelloAIGuardrail(
        guardrail_name=guardrail["guardrail_name"],
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        asset_id=derouter_params.asset_id,
        unreachable_fallback=derouter_params.unreachable_fallback,
        event_hook=_event_hook_from_mode(derouter_params.mode),
        default_on=derouter_params.default_on or False,
    )
    derouter.logging_callback_manager.add_derouter_callback(_repelloai_callback)

    return _repelloai_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.REPELLOAI.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.REPELLOAI.value: RepelloAIGuardrail,
}
