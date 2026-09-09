from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .zscaler_ai_guard import ZscalerAIGuard

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _zscaler_ai_guard_callback: Final = ZscalerAIGuard(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        policy_id=derouter_params.policy_id,
        send_user_api_key_alias=derouter_params.send_user_api_key_alias,
        send_user_api_key_user_id=derouter_params.send_user_api_key_user_id,
        send_user_api_key_team_id=derouter_params.send_user_api_key_team_id,
        timeout=derouter_params.timeout,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_zscaler_ai_guard_callback)

    return _zscaler_ai_guard_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.ZSCALER_AI_GUARD.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.ZSCALER_AI_GUARD.value: ZscalerAIGuard,
}
