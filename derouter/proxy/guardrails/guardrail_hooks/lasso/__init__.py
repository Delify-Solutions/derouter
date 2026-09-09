from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .lasso import LassoGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _lasso_callback: Final = LassoGuardrail(
        guardrail_name=guardrail.get("guardrail_name", ""),
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        user_id=derouter_params.lasso_user_id,
        conversation_id=derouter_params.lasso_conversation_id,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_lasso_callback)

    return _lasso_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.LASSO.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.LASSO.value: LassoGuardrail,
}
