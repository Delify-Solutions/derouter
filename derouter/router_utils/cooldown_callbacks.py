"""
Callbacks triggered on cooling down deployments
"""

import copy
from typing import TYPE_CHECKING, Any, Final

import derouter
from derouter._logging import verbose_logger

if TYPE_CHECKING:
    from derouter.router import Router as _Router

    LitellmRouter = _Router
    from derouter.integrations.prometheus import PrometheusLogger
else:
    LitellmRouter = Any
    PrometheusLogger = Any


async def router_cooldown_event_callback(
    derouter_router_instance: LitellmRouter,
    deployment_id: str,
    exception_status: str | int,
    cooldown_time: float | None,
):
    """
    Callback triggered when a deployment is put into cooldown by derouter

    - Updates deployment state on Prometheus
    - Increments cooldown metric for deployment on Prometheus
    """
    verbose_logger.debug("In router_cooldown_event_callback - updating prometheus")
    _deployment: Final = derouter_router_instance.get_deployment(model_id=deployment_id)
    if _deployment is None:
        verbose_logger.warning(
            "in router_cooldown_event_callback but _deployment is None for deployment_id=%s. Doing nothing",
            deployment_id,
        )
        return
    _derouter_params: Final = _deployment["derouter_params"]
    temp_derouter_params = copy.deepcopy(_derouter_params)
    temp_derouter_params = dict(temp_derouter_params)
    _model_name: Final = _deployment.get("model_name", None) or ""
    _api_base: Final = derouter.get_api_base(model=_model_name, optional_params=temp_derouter_params) or ""
    model_info: Final = _deployment["model_info"]
    model_id: Final = model_info.id

    derouter_model_name: Final = temp_derouter_params.get("model") or ""
    llm_provider = ""
    try:
        _, llm_provider, _, _ = derouter.get_llm_provider(
            model=derouter_model_name,
            custom_llm_provider=temp_derouter_params.get("custom_llm_provider"),
        )
    except Exception:
        pass

    # get the prometheus logger from in memory loggers
    prometheusLogger: Final[PrometheusLogger | None] = _get_prometheus_logger_from_callbacks()

    if prometheusLogger is not None:
        prometheusLogger.set_deployment_complete_outage(
            derouter_model_name=_model_name,
            model_id=model_id,
            api_base=_api_base,
            api_provider=llm_provider,
        )

        prometheusLogger.increment_deployment_cooled_down(
            derouter_model_name=_model_name,
            model_id=model_id,
            api_base=_api_base,
            api_provider=llm_provider,
            exception_status=str(exception_status),
        )

    return


def _get_prometheus_logger_from_callbacks() -> PrometheusLogger | None:
    """
    Checks if prometheus is a initalized callback, if yes returns it
    """
    from derouter.integrations.prometheus import PrometheusLogger

    if PrometheusLogger is None:
        return None

    for _callback in derouter._async_success_callback:
        if isinstance(_callback, PrometheusLogger):
            return _callback
    for global_callback in derouter.callbacks:
        if isinstance(global_callback, PrometheusLogger):
            return global_callback

    return None
