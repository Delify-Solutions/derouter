from __future__ import annotations

from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import (
    GuardrailEventHooks,
    Mode,
    SupportedGuardrailIntegrations,
)

from .headroom import HeadroomGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def _coerce_event_hook(
    mode: str | list[str] | Mode,
) -> GuardrailEventHooks | list[GuardrailEventHooks] | Mode:
    if isinstance(mode, Mode):
        return mode
    if isinstance(mode, list):
        return [GuardrailEventHooks(item) for item in mode]
    return GuardrailEventHooks(mode)


def initialize_guardrail(derouter_params: LitellmParams, guardrail: Guardrail) -> HeadroomGuardrail:
    import derouter

    _callback: Final = HeadroomGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        model=derouter_params.model,
        guardrail_name=guardrail["guardrail_name"],
        event_hook=_coerce_event_hook(derouter_params.mode),
        default_on=derouter_params.default_on or False,
        unreachable_fallback=derouter_params.unreachable_fallback,
        timeout=derouter_params.timeout,
        ccr_retrieval=derouter_params.ccr_retrieval,
    )
    derouter.logging_callback_manager.add_derouter_callback(  # pyright: ignore[reportUnknownMemberType]
        _callback
    )
    return _callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.HEADROOM.value: initialize_guardrail,
}

guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.HEADROOM.value: HeadroomGuardrail,
}
