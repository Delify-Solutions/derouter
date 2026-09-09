from typing import TYPE_CHECKING, Any, Final

from derouter._logging import redact_secrets, verbose_router_logger
from derouter.constants import MAX_EXCEPTION_MESSAGE_LENGTH
from derouter.router_utils.cooldown_handlers import (
    _async_get_cooldown_deployments_with_debug_info,
)
from derouter.types.integrations.slack_alerting import AlertType
from derouter.types.router import RouterRateLimitError

if TYPE_CHECKING:
    from opentelemetry.trace import Span as _Span

    from derouter.router import Router as _Router

    LitellmRouter = _Router
    Span = _Span | Any
else:
    LitellmRouter = Any
    Span = Any


async def send_llm_exception_alert(
    derouter_router_instance: LitellmRouter,
    request_kwargs: dict,
    error_traceback_str: str,
    original_exception,
):
    """
    Only runs if router.slack_alerting_logger is set
    Sends a Slack / MS Teams alert for the LLM API call failure. Only if router.slack_alerting_logger is set.

    Parameters:
        derouter_router_instance (_Router): The LitellmRouter instance.
        original_exception (Any): The original exception that occurred.

    Returns:
        None
    """
    if derouter_router_instance is None:
        return

    if not hasattr(derouter_router_instance, "slack_alerting_logger"):
        return

    if derouter_router_instance.slack_alerting_logger is None:
        return

    if "proxy_server_request" in request_kwargs:
        # Do not send any alert if it's a request from derouter proxy server request
        # the proxy is already instrumented to send LLM API call failures
        return

    derouter_debug_info: Final = getattr(original_exception, "derouter_debug_info", None)
    exception_str = str(original_exception)
    if derouter_debug_info is not None:
        exception_str += derouter_debug_info
    exception_str += f"\n\n{error_traceback_str[:MAX_EXCEPTION_MESSAGE_LENGTH]}"

    # Redact secrets before sending to external service (Slack / MS Teams)
    exception_str = redact_secrets(exception_str)

    await derouter_router_instance.slack_alerting_logger.send_alert(
        message=f"LLM API call failed: `{exception_str}`",
        level="High",
        alert_type=AlertType.llm_exceptions,
        alerting_metadata={},
    )


async def async_raise_no_deployment_exception(
    derouter_router_instance: LitellmRouter, model: str, parent_otel_span: Span | None
):
    """
    Raises a RouterRateLimitError if no deployment is found for the given model.
    """
    verbose_router_logger.info("get_available_deployment for model: %s, No deployment available", model)
    model_ids: Final = derouter_router_instance.get_model_ids(model_name=model)
    _cooldown_time: Final = derouter_router_instance.cooldown_cache.get_min_cooldown(
        model_ids=model_ids, parent_otel_span=parent_otel_span
    )
    _cooldown_list: Final = await _async_get_cooldown_deployments_with_debug_info(
        derouter_router_instance=derouter_router_instance,
        parent_otel_span=parent_otel_span,
    )
    verbose_router_logger.info(
        "No deployment found for model: %s, cooldown_list with debug info: %s", model, _cooldown_list
    )

    cooldown_list_ids: Final = [cooldown_model[0] for cooldown_model in (_cooldown_list or [])]
    return RouterRateLimitError(
        model=model,
        cooldown_time=_cooldown_time,
        enable_pre_call_checks=derouter_router_instance.enable_pre_call_checks,
        cooldown_list=cooldown_list_ids,
    )
