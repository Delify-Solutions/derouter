from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .model_armor import ModelArmorGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter
    from derouter.proxy.guardrails.guardrail_hooks.model_armor import (
        ModelArmorGuardrail,
    )

    _model_armor_callback: Final = ModelArmorGuardrail(
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        template_id=derouter_params.template_id,
        project_id=derouter_params.project_id,
        location=derouter_params.location,
        credentials=derouter_params.credentials,
        api_endpoint=derouter_params.api_endpoint,
        default_on=derouter_params.default_on,
        mask_request_content=derouter_params.mask_request_content,
        mask_response_content=derouter_params.mask_response_content,
        fail_on_error=derouter_params.fail_on_error,
        skip_unscannable_attachments=derouter_params.skip_unscannable_attachments,
        sanitize_error_detail=derouter_params.sanitize_error_detail,
    )
    derouter.logging_callback_manager.add_derouter_callback(_model_armor_callback)

    return _model_armor_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.MODEL_ARMOR.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.MODEL_ARMOR.value: ModelArmorGuardrail,
}
