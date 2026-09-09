from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .cato_networks import CatoNetworksGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter
    from derouter.proxy.guardrails.guardrail_hooks.cato_networks import (
        CatoNetworksGuardrail,
    )

    _cato_callback: Final = CatoNetworksGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
        inspect_embeddings=derouter_params.inspect_embeddings,
        ssl_verify=getattr(derouter_params, "ssl_verify", None),
    )
    derouter.logging_callback_manager.add_derouter_callback(_cato_callback)

    return _cato_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.CATO_NETWORKS.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.CATO_NETWORKS.value: CatoNetworksGuardrail,
}
