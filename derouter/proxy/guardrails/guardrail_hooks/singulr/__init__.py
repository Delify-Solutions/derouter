from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .singulr import SingulrGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(
    derouter_params: "LitellmParams",
    guardrail: "Guardrail",
):
    import derouter

    _cb: Final = SingulrGuardrail(
        singulr_api_base=getattr(derouter_params, "singulr_api_base", None) or derouter_params.api_base,
        singulr_api_key=getattr(derouter_params, "singulr_api_key", None) or derouter_params.api_key,
        singulr_application_id=getattr(derouter_params, "singulr_application_id", None),
        singulr_guardrail_id=getattr(derouter_params, "singulr_guardrail_id", None),
        block_on_error=getattr(derouter_params, "block_on_error", None),
        timeout=derouter_params.timeout,
        guardrail_name=guardrail.get(
            "guardrail_name",
            "",
        ),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(
        _cb,
    )

    return _cb


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.SINGULR.value: initialize_guardrail,
}

guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.SINGULR.value: SingulrGuardrail,
}
