from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .prompt_security import PromptSecurityGuardrail

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter
    from derouter.proxy.guardrails.guardrail_hooks.prompt_security import (
        PromptSecurityGuardrail,
    )

    _prompt_security_callback: Final = PromptSecurityGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
        file_sanitization_fail_open=getattr(derouter_params, "file_sanitization_fail_open", None),
        block_on_file_modify=getattr(derouter_params, "block_on_file_modify", None),
    )
    derouter.logging_callback_manager.add_derouter_callback(_prompt_security_callback)

    return _prompt_security_callback


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.PROMPT_SECURITY.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.PROMPT_SECURITY.value: PromptSecurityGuardrail,
}
