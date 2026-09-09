from typing import TYPE_CHECKING, Final

from derouter.types.guardrails import SupportedGuardrailIntegrations
from derouter.types.proxy.guardrails.guardrail_hooks.ibm import IBMDetectorOptionalParams

from .ibm_detector import IBMGuardrailDetector

if TYPE_CHECKING:
    from derouter.types.guardrails import Guardrail, LitellmParams


def initialize_guardrail(derouter_params: "LitellmParams", guardrail: "Guardrail"):
    import derouter

    if not derouter_params.auth_token:
        raise ValueError("IBM Guardrails: auth_token is required")
    if not derouter_params.base_url:
        raise ValueError("IBM Guardrails: base_url is required")
    if not derouter_params.detector_id:
        raise ValueError("IBM Guardrails: detector_id is required")

    guardrail_name: Final = guardrail.get("guardrail_name")
    if not guardrail_name:
        raise ValueError("IBM Guardrails: guardrail_name is required")

    verify_ssl: Final = getattr(derouter_params, "verify_ssl", True)

    # Get optional params
    optional_params: Final = getattr(derouter_params, "optional_params", IBMDetectorOptionalParams())
    detector_params: Final = getattr(optional_params, "detector_params", {})
    extra_headers: Final = getattr(optional_params, "extra_headers", {})
    score_threshold: Final = getattr(optional_params, "score_threshold", None)
    block_on_detection: Final = getattr(optional_params, "block_on_detection", True)

    is_detector_server = derouter_params.is_detector_server
    if is_detector_server is None:
        is_detector_server = True

    ibm_guardrail: Final = IBMGuardrailDetector(
        guardrail_name=guardrail_name,
        auth_token=derouter_params.auth_token,
        base_url=derouter_params.base_url,
        detector_id=derouter_params.detector_id,
        is_detector_server=is_detector_server,
        detector_params=detector_params,
        extra_headers=extra_headers,
        score_threshold=score_threshold,
        block_on_detection=block_on_detection,
        verify_ssl=verify_ssl,
        default_on=derouter_params.default_on,
        event_hook=derouter_params.mode,
    )

    derouter.logging_callback_manager.add_derouter_callback(ibm_guardrail)
    return ibm_guardrail


guardrail_initializer_registry: Final = {
    SupportedGuardrailIntegrations.IBM_GUARDRAILS.value: initialize_guardrail,
}


guardrail_class_registry: Final = {
    SupportedGuardrailIntegrations.IBM_GUARDRAILS.value: IBMGuardrailDetector,
}


__all__ = ["IBMGuardrailDetector", "initialize_guardrail"]
