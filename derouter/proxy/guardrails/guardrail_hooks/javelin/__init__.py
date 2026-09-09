from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .javelin import JavelinGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    if derouter_params.guard_name is None:
        raise Exception(
            "JavelinGuardrailException - Please pass the Javelin guard name via 'derouter_params::guard_name'"
        )

    _javelin_callback: Final = JavelinGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        guardrail_name=guardrail.get("guardrail_name", ""),
        javelin_guard_name=derouter_params.guard_name,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on or False,
        api_version=derouter_params.api_version or "v1",
        config=derouter_params.config,
        metadata=derouter_params.metadata,
        application=derouter_params.application,
    )
    derouter.logging_callback_manager.add_derouter_callback(_javelin_callback)

    return _javelin_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.JAVELIN.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.JAVELIN.value: JavelinGuardrail,
}
