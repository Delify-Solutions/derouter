from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .aim import AimGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter
    from derouter.proxy.guardrails.guardrail_hooks.aim import AimGuardrail

    _aim_callback: Final = AimGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
        inspect_embeddings=derouter_params.inspect_embeddings,
    )
    derouter.logging_callback_manager.add_derouter_callback(_aim_callback)

    return _aim_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.AIM.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.AIM.value: AimGuardrail,
}
