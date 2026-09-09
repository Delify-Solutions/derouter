from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .hiddenlayer import HiddenlayerGuardrail, HiddenlayerGuardrailV2

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    api_id: Final = derouter_params.api_id if hasattr(derouter_params, "api_id") else None
    auth_url: Final = derouter_params.auth_url if hasattr(derouter_params, "auth_url") else None
    version: Final[int | None] = derouter_params.version if hasattr(derouter_params, "version") else None

    _hiddenlayer_callback: HiddenlayerGuardrail | HiddenlayerGuardrailV2
    if not version or version < 2:
        _hiddenlayer_callback = HiddenlayerGuardrail(
            api_base=derouter_params.api_base,
            api_id=api_id,
            api_key=derouter_params.api_key,
            auth_url=auth_url,
            guardrail_name=guardrail.get("guardrail_name", ""),
            event_hook=derouter_params.mode,
            default_on=derouter_params.default_on,
        )
    else:
        _hiddenlayer_callback = HiddenlayerGuardrailV2(
            api_base=derouter_params.api_base,
            api_id=api_id,
            api_key=derouter_params.api_key,
            auth_url=auth_url,
            guardrail_name=guardrail.get("guardrail_name", ""),
            event_hook=derouter_params.mode,
            default_on=derouter_params.default_on,
        )

    derouter.logging_callback_manager.add_derouter_callback(_hiddenlayer_callback)
    return _hiddenlayer_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.HIDDENLAYER.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.HIDDENLAYER.value: HiddenlayerGuardrail,
}
