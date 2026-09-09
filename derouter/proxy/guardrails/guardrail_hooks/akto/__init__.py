from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .akto import AktoGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    _akto_callback: Final = AktoGuardrail(
        akto_base_url=getattr(derouter_params, "akto_base_url", None),
        akto_api_key=getattr(derouter_params, "akto_api_key", None),
        akto_account_id=getattr(derouter_params, "akto_account_id", None),
        akto_vxlan_id=getattr(derouter_params, "akto_vxlan_id", None),
        unreachable_fallback=getattr(derouter_params, "unreachable_fallback", "fail_closed"),
        guardrail_timeout=getattr(derouter_params, "guardrail_timeout", None),
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )

    derouter.logging_callback_manager.add_derouter_callback(_akto_callback)
    return _akto_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.AKTO.value: initialize_guardrail,
}

guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.AKTO.value: AktoGuardrail,
}
