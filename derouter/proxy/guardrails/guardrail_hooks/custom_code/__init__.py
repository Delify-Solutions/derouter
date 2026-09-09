"""Custom code guardrail integration for DeRouter.

This module allows users to write custom guardrail logic using Python-like code
that runs in a sandboxed environment with access to DeRouter-provided primitives.

Pre-built custom code for common guardrails (e.g. response rejection detection)
is available in response_rejection_code.py.
"""

from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations

from .custom_code_guardrail import CustomCodeGuardrail
from .response_rejection_code import (
    DEFAULT_REJECTION_PHRASES,
    RESPONSE_REJECTION_GUARDRAIL_CODE,
)

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail") -> CustomCodeGuardrail:
    """
    Initialize a custom code guardrail.

    Args:
        derouter_params: Configuration parameters including the custom code
        guardrail: The guardrail configuration dict

    Returns:
        CustomCodeGuardrail instance
    """
    import derouter

    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("Custom code guardrail requires a guardrail_name")

    # Get the custom code from derouter_params
    custom_code: Final = getattr(derouter_params, "custom_code", None)
    if not custom_code:
        raise ValueError("Custom code guardrail requires 'custom_code' in derouter_params")

    custom_code_guardrail: Final = CustomCodeGuardrail(
        guardrail_name=guardrail_name,
        custom_code=custom_code,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )

    derouter.logging_callback_manager.add_derouter_callback(custom_code_guardrail)
    return custom_code_guardrail


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.CUSTOM_CODE.value: initialize_guardrail,
}

guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.CUSTOM_CODE.value: CustomCodeGuardrail,
}

__all__ = [
    "DEFAULT_REJECTION_PHRASES",
    "RESPONSE_REJECTION_GUARDRAIL_CODE",
    "CustomCodeGuardrail",
    "initialize_guardrail",
]
