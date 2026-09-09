from .enkryptai import EnkryptAIGuardrails

__all__ = ["EnkryptAIGuardrails"]


from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _enkryptai_callback: Final = EnkryptAIGuardrails(
        guardrail_name=guardrail.get("guardrail_name", ""),
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        policy_name=derouter_params.policy_name,
        deployment_name=derouter_params.deployment_name,
        detectors=derouter_params.detectors,
        block_on_violation=derouter_params.block_on_violation,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_enkryptai_callback)

    return _enkryptai_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.ENKRYPTAI.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.ENKRYPTAI.value: EnkryptAIGuardrails,
}
