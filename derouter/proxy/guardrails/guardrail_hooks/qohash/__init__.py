from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .qohash import QostodianNexus

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _instance: Final = QostodianNexus(
        api_base=derouter_params.api_base,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
        additional_provider_specific_params=derouter_params.additional_provider_specific_params,
        extra_headers=getattr(derouter_params, "extra_headers", None),
    )

    derouter.logging_callback_manager.add_derouter_callback(_instance)

    return _instance


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.QOSTODIAN_NEXUS.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.QOSTODIAN_NEXUS.value: QostodianNexus,
}
