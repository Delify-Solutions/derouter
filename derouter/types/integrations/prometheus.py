import re
from collections.abc import Mapping, Sequence
from dataclasses import MISSING, dataclass, field, fields
from enum import Enum
from types import MappingProxyType
from typing import Any, ClassVar, Final, Literal, cast

import derouter


def _sanitize_prometheus_label_name(label: str) -> str:
    """
    Sanitize a label name to comply with Prometheus label name requirements.

    Prometheus label names must match: ^[a-zA-Z_][a-zA-Z0-9_]*$
    - First character: letter (a-z, A-Z) or underscore (_)
    - Subsequent characters: letters, digits (0-9), or underscores (_)

    Args:
        label: The label name to sanitize

    Returns:
        A sanitized label name that complies with Prometheus requirements
    """
    if not label:
        return "_"

    # Replace all invalid characters with underscores
    # Keep only letters, digits, and underscores
    sanitized = re.sub(r"[^a-zA-Z0-9_]", "_", label)

    # Ensure first character is valid (letter or underscore)
    if sanitized and not re.match(r"^[a-zA-Z_]", sanitized[0]):
        sanitized = "_" + sanitized

    # Handle empty string after sanitization
    if not sanitized:
        sanitized = "_"

    return sanitized


# v1: single translate pass + escape loop (avoids chained str.replace allocations).
_PROMETHEUS_LABEL_VALUE_TRANSLATE_V1: Final = str.maketrans("\n", " ", "\r\u2028\u2029")


def _sanitize_prometheus_label_value(value: Any | None) -> str | None:
    """
    Same semantics as :func:`_sanitize_prometheus_label_value`, implemented with
    ``str.translate`` plus a single escape pass instead of chained ``replace``.
    """
    if value is None:
        return None

    str_value: Final[str] = value if isinstance(value, str) else str(value)

    cleaned: Final = str_value.translate(_PROMETHEUS_LABEL_VALUE_TRANSLATE_V1)
    if "\\" not in cleaned and '"' not in cleaned:
        return cleaned

    parts: Final[list[str]] = []
    append: Final = parts.append
    for ch in cleaned:
        if ch == "\\":
            append("\\\\")
        elif ch == '"':
            append('\\"')
        else:
            append(ch)
    return "".join(parts)


@dataclass
class MetricValidationError:
    """Error for invalid metric name"""

    metric_name: str
    valid_metrics: tuple[str, ...]

    @property
    def message(self) -> str:
        return f"Invalid metric name: {self.metric_name}"


@dataclass
class LabelValidationError:
    """Error for invalid labels on a metric"""

    metric_name: str
    invalid_labels: list[str]
    valid_labels: list[str]

    @property
    def message(self) -> str:
        base_message: Final = f"Invalid labels for metric '{self.metric_name}': {self.invalid_labels}"
        if self.metric_name in PROMETHEUS_DEPLOYMENT_AND_LATENCY_CALLER_IDENTITY_METRICS and any(
            label in ("api_key_alias", "user_email") for label in self.invalid_labels
        ):
            mode: Final[object] = getattr(
                derouter,
                "prometheus_deployment_and_latency_caller_identity",
                "api_key_alias",
            )
            return (
                f"{base_message} (the caller-identity label on this metric is set by "
                f"prometheus_deployment_and_latency_caller_identity={mode!r})"
            )
        return base_message


@dataclass
class ValidationResults:
    """Container for all validation results"""

    metric_errors: list[MetricValidationError]
    label_errors: list[LabelValidationError]

    @property
    def has_errors(self) -> bool:
        return bool(self.metric_errors or self.label_errors)

    @property
    def all_error_messages(self) -> list[str]:
        messages: Final = [error.message for error in self.metric_errors]
        messages.extend([error.message for error in self.label_errors])
        return messages


REQUESTED_MODEL: Final = "requested_model"
EXCEPTION_STATUS: Final = "exception_status"
EXCEPTION_CLASS: Final = "exception_class"
RATE_LIMIT_CATEGORY: Final = "rate_limit_category"
RATE_LIMIT_TYPE: Final = "rate_limit_type"
STATUS_CODE: Final = "status_code"
EXCEPTION_LABELS: Final = [EXCEPTION_STATUS, EXCEPTION_CLASS]
LATENCY_BUCKETS: Final = (
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.0,
    5.0,
    10.0,
    30.0,
    60.0,
    120.0,
    300.0,
    420.0,  # 7 minutes
    600.0,  # 10 minutes (typical default LLM request timeout)
    float("inf"),
)

# Batch jobs can run for minutes to hours; buckets span 1 min → 24 h.
BATCH_DURATION_BUCKETS: Final = (
    60.0,
    120.0,
    300.0,
    600.0,
    900.0,
    1800.0,
    3600.0,
    7200.0,
    14400.0,
    28800.0,
    43200.0,
    86400.0,
    float("inf"),
)


class UserAPIKeyLabelNames(Enum):
    END_USER = "end_user"
    USER = "user"
    USER_EMAIL = "user_email"
    USER_ALIAS = "user_alias"
    API_KEY_HASH = "hashed_api_key"
    API_KEY_ALIAS = "api_key_alias"
    TEAM = "team"
    TEAM_ALIAS = "team_alias"
    REQUESTED_MODEL = REQUESTED_MODEL
    v1_DEROUTER_MODEL_NAME = "model"
    v2_DEROUTER_MODEL_NAME = "derouter_model_name"
    TAG = "tag"
    MODEL_ID = "model_id"
    API_BASE = "api_base"
    API_PROVIDER = "api_provider"
    EXCEPTION_STATUS = EXCEPTION_STATUS
    EXCEPTION_CLASS = EXCEPTION_CLASS
    RATE_LIMIT_CATEGORY = RATE_LIMIT_CATEGORY
    RATE_LIMIT_TYPE = RATE_LIMIT_TYPE
    STATUS_CODE = "status_code"
    FALLBACK_MODEL = "fallback_model"
    ROUTE = "route"
    MODEL_GROUP = "model_group"
    CLIENT_IP = "client_ip"
    USER_AGENT = "user_agent"
    CALLBACK_NAME = "callback_name"
    STREAM = "stream"
    ORG_ID = "org_id"
    ORG_ALIAS = "org_alias"
    MCP_TOOL_NAME = "mcp_tool_name"
    MCP_SERVER_NAME = "mcp_server_name"
    SERVICE_TIER = "service_tier"


DEFINED_PROMETHEUS_METRICS = Literal[
    "derouter_llm_api_latency_metric",
    "derouter_llm_api_time_to_first_token_metric",
    "derouter_request_total_latency_metric",
    "derouter_overhead_latency_metric",
    "derouter_overhead_with_guardrails_latency_metric",
    "derouter_remaining_requests_metric",
    "derouter_remaining_tokens_metric",
    "derouter_proxy_total_requests_metric",
    "derouter_proxy_failed_requests_metric",
    "derouter_deployment_latency_per_output_token",
    "derouter_requests_metric",
    "derouter_spend_metric",
    "derouter_total_tokens_metric",
    "derouter_input_tokens_metric",
    "derouter_output_tokens_metric",
    "derouter_input_cached_tokens_metric",
    "derouter_input_cache_creation_tokens_metric",
    "derouter_input_audio_tokens_metric",
    "derouter_output_reasoning_tokens_metric",
    "derouter_output_audio_tokens_metric",
    "derouter_video_duration_seconds_metric",
    "derouter_images_generated_metric",
    "derouter_deployment_successful_fallbacks",
    "derouter_deployment_failed_fallbacks",
    "derouter_remaining_team_budget_metric",
    "derouter_team_max_budget_metric",
    "derouter_team_budget_remaining_hours_metric",
    "derouter_team_members_metric",
    "derouter_remaining_org_budget_metric",
    "derouter_org_max_budget_metric",
    "derouter_org_budget_remaining_hours_metric",
    "derouter_remaining_api_key_budget_metric",
    "derouter_api_key_max_budget_metric",
    "derouter_api_key_budget_remaining_hours_metric",
    "derouter_remaining_user_budget_metric",
    "derouter_user_max_budget_metric",
    "derouter_user_budget_remaining_hours_metric",
    "derouter_deployment_state",
    "derouter_deployment_failure_responses",
    "derouter_deployment_total_requests",
    "derouter_deployment_success_responses",
    "derouter_deployment_cooled_down",
    "derouter_pod_lock_manager_size",
    "derouter_in_memory_daily_spend_update_queue_size",
    "derouter_redis_daily_spend_update_queue_size",
    "derouter_in_memory_spend_update_queue_size",
    "derouter_redis_spend_update_queue_size",
    "derouter_request_queue_time_seconds",
    "derouter_guardrail_latency_seconds",
    "derouter_guardrail_errors_total",
    "derouter_guardrail_requests_total",
    # Cache metrics
    "derouter_cache_hits_metric",
    "derouter_cache_misses_metric",
    "derouter_cached_tokens_metric",
    # Provider prompt-caching metrics (e.g. OpenAI/Anthropic/Bedrock/Gemini)
    "derouter_provider_cache_read_input_tokens_metric",
    "derouter_provider_cache_creation_input_tokens_metric",
    "derouter_deployment_tpm_limit",
    "derouter_deployment_rpm_limit",
    "derouter_remaining_api_key_requests_for_model",
    "derouter_remaining_api_key_tokens_for_model",
    "derouter_api_key_rate_limit_allowed_metric",
    "derouter_api_key_rate_limit_used_metric",
    "derouter_team_rate_limit_allowed_metric",
    "derouter_team_rate_limit_used_metric",
    "derouter_llm_api_failed_requests_metric",
    "derouter_callback_logging_failures_metric",
    "derouter_in_flight_requests",
    # Managed batch metrics
    "derouter_managed_batch_created_total",
    "derouter_managed_file_size_bytes",
    "derouter_managed_batch_duration_seconds",
    "derouter_managed_file_created_total",
    "derouter_managed_file_deleted_total",
    "derouter_check_batch_cost_jobs_polled",
    "derouter_check_batch_cost_jobs_processed_total",
    "derouter_check_batch_cost_errors_total",
    "derouter_check_batch_cost_last_run_timestamp",
    # MCP tool call metrics
    "derouter_mcp_tool_calls_total",
    "derouter_mcp_tool_call_spend_metric",
]


PROMETHEUS_DEPLOYMENT_AND_LATENCY_CALLER_IDENTITY_METRICS: Final[frozenset[str]] = frozenset(
    {
        "derouter_deployment_total_requests",
        "derouter_deployment_success_responses",
        "derouter_deployment_failure_responses",
        "derouter_request_total_latency_metric",
        "derouter_llm_api_latency_metric",
        "derouter_llm_api_time_to_first_token_metric",
        "derouter_request_queue_time_seconds",
        "derouter_overhead_latency_metric",
        "derouter_deployment_latency_per_output_token",
    }
)

PROMETHEUS_DEPLOYMENT_AND_LATENCY_CALLER_IDENTITY_VALUES: Final[tuple[str, ...]] = (
    "api_key_alias",
    "user_email",
    "both",
)


def validate_prometheus_deployment_and_latency_caller_identity() -> str:
    """Return the configured caller-identity mode, raising on an invalid value."""
    caller_identity: Final[object] = getattr(
        derouter,
        "prometheus_deployment_and_latency_caller_identity",
        "api_key_alias",
    )
    if isinstance(caller_identity, str) and caller_identity in PROMETHEUS_DEPLOYMENT_AND_LATENCY_CALLER_IDENTITY_VALUES:
        return caller_identity
    accepted_values: Final = ", ".join(PROMETHEUS_DEPLOYMENT_AND_LATENCY_CALLER_IDENTITY_VALUES)
    raise ValueError(
        "Invalid prometheus_deployment_and_latency_caller_identity="
        f"{caller_identity!r}. Accepted values: {accepted_values}."
    )


def validate_caller_identity_settings(derouter_settings: Mapping[str, object]) -> None:
    """Store the caller-identity mode from derouter_settings and validate it together
    with prometheus_metrics_config, raising on an invalid value or on include_labels
    that request a label the selected mode removes."""
    if "prometheus_deployment_and_latency_caller_identity" not in derouter_settings:
        return
    derouter.prometheus_deployment_and_latency_caller_identity = (
        cast(  # cast-ok: validated on the next line, which raises on an invalid value
            'Literal["api_key_alias", "user_email", "both"]',
            derouter_settings["prometheus_deployment_and_latency_caller_identity"],
        )
    )
    caller_identity_mode: Final = validate_prometheus_deployment_and_latency_caller_identity()
    if caller_identity_mode != "user_email":
        return
    raw_metrics_config: Final = derouter_settings.get("prometheus_metrics_config")
    conflicting_metrics: Final = tuple(
        metric_name
        for metric_config in (raw_metrics_config if isinstance(raw_metrics_config, list) else ())
        if isinstance(metric_config, dict) and "api_key_alias" in (metric_config.get("include_labels") or ())
        for metric_name in (metric_config.get("metrics") or ())
        if metric_name in PROMETHEUS_DEPLOYMENT_AND_LATENCY_CALLER_IDENTITY_METRICS
    )
    if conflicting_metrics:
        conflicting_names: Final = ", ".join(conflicting_metrics)
        raise ValueError(
            "prometheus_metrics_config include_labels contains 'api_key_alias' for "
            f"{conflicting_names}, but prometheus_deployment_and_latency_caller_identity="
            "'user_email' replaces that label on these metrics. Use 'user_email' in "
            "include_labels or change the mode."
        )


def _resolve_deployment_and_latency_caller_identity_labels(
    metric_name: str,
    labels: Sequence[object],
) -> list[str]:  # mutable-ok: every caller must receive an independently mutable label list
    """Return a fresh label list with the configured caller identity schema."""
    if not all(isinstance(label, str) for label in labels):
        raise TypeError(f"Prometheus labels for {metric_name} must be strings")
    resolved_labels: Final = [label for label in labels if isinstance(label, str)]
    if metric_name not in PROMETHEUS_DEPLOYMENT_AND_LATENCY_CALLER_IDENTITY_METRICS:
        return resolved_labels

    caller_identity: Final = validate_prometheus_deployment_and_latency_caller_identity()

    alias_index: Final = resolved_labels.index(UserAPIKeyLabelNames.API_KEY_ALIAS.value)
    if caller_identity == "user_email":
        resolved_labels[alias_index] = UserAPIKeyLabelNames.USER_EMAIL.value
    elif caller_identity == "both":
        resolved_labels.insert(alias_index + 1, UserAPIKeyLabelNames.USER_EMAIL.value)

    return resolved_labels


class PrometheusMetricLabels:
    derouter_llm_api_latency_metric = [
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.SERVICE_TIER.value,
    ]

    derouter_llm_api_time_to_first_token_metric = [
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.SERVICE_TIER.value,
    ]

    derouter_request_total_latency_metric = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.SERVICE_TIER.value,
    ]

    derouter_request_queue_time_seconds = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    # Guardrail metrics - these use custom labels (guardrail_name, status, error_type, hook_type)
    # which are not part of UserAPIKeyLabelNames
    derouter_guardrail_latency_seconds: list[str] = []
    derouter_guardrail_errors_total: list[str] = []
    derouter_guardrail_requests_total: list[str] = []

    derouter_proxy_total_requests_metric = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.STATUS_CODE.value,
        UserAPIKeyLabelNames.USER_EMAIL.value,
        UserAPIKeyLabelNames.ROUTE.value,
        UserAPIKeyLabelNames.CLIENT_IP.value,
        UserAPIKeyLabelNames.USER_AGENT.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_proxy_failed_requests_metric = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.USER_EMAIL.value,
        UserAPIKeyLabelNames.EXCEPTION_STATUS.value,
        UserAPIKeyLabelNames.EXCEPTION_CLASS.value,
        # ``rate_limit_category`` / ``rate_limit_type`` are appended in
        # ``get_labels()`` when ``derouter.prometheus_emit_rate_limit_labels``
        # is True. Kept opt-in so existing dashboards keyed on this metric's
        # historical label set keep matching after upgrade.
        UserAPIKeyLabelNames.ROUTE.value,
        UserAPIKeyLabelNames.CLIENT_IP.value,
        UserAPIKeyLabelNames.USER_AGENT.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_deployment_latency_per_output_token = [
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
    ]

    derouter_overhead_latency_metric = [
        UserAPIKeyLabelNames.MODEL_GROUP.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
    ]

    derouter_overhead_with_guardrails_latency_metric = [
        UserAPIKeyLabelNames.MODEL_GROUP.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
    ]

    derouter_remaining_requests_metric = [
        UserAPIKeyLabelNames.MODEL_GROUP.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
    ]

    derouter_remaining_tokens_metric = [
        UserAPIKeyLabelNames.MODEL_GROUP.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
    ]

    derouter_requests_metric = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.USER_EMAIL.value,
        UserAPIKeyLabelNames.CLIENT_IP.value,
        UserAPIKeyLabelNames.USER_AGENT.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_spend_metric = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.USER_EMAIL.value,
        UserAPIKeyLabelNames.CLIENT_IP.value,
        UserAPIKeyLabelNames.USER_AGENT.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.SERVICE_TIER.value,
    ]

    derouter_input_tokens_metric = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.USER_EMAIL.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_total_tokens_metric = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.USER_EMAIL.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_output_tokens_metric = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.USER_EMAIL.value,
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    # Token-type detail metrics — reuse the same label set as
    # derouter_input_tokens_metric / derouter_output_tokens_metric so dashboards
    # can join across them. Only emitted when the underlying usage detail is
    # populated by the provider (e.g. Anthropic cache_read_input_tokens,
    # OpenAI prompt_tokens_details.cached_tokens, reasoning_tokens, audio_tokens).
    derouter_input_cached_tokens_metric = derouter_input_tokens_metric
    derouter_input_cache_creation_tokens_metric = derouter_input_tokens_metric
    derouter_input_audio_tokens_metric = derouter_input_tokens_metric
    derouter_output_reasoning_tokens_metric = derouter_output_tokens_metric
    derouter_output_audio_tokens_metric = derouter_output_tokens_metric

    derouter_video_duration_seconds_metric = derouter_output_tokens_metric
    derouter_images_generated_metric = derouter_output_tokens_metric

    derouter_deployment_state = [
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_deployment_tpm_limit = [
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_deployment_rpm_limit = derouter_deployment_tpm_limit

    derouter_deployment_cooled_down = [
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.EXCEPTION_STATUS.value,
    ]

    derouter_deployment_successful_fallbacks = [
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.FALLBACK_MODEL.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.EXCEPTION_STATUS.value,
        UserAPIKeyLabelNames.EXCEPTION_CLASS.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
    ]

    derouter_deployment_failed_fallbacks = derouter_deployment_successful_fallbacks

    derouter_remaining_team_budget_metric = [
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
    ]

    derouter_team_max_budget_metric = [
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
    ]

    derouter_team_budget_remaining_hours_metric = [
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
    ]

    derouter_team_members_metric = [
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
    ]

    derouter_remaining_org_budget_metric = [
        UserAPIKeyLabelNames.ORG_ID.value,
        UserAPIKeyLabelNames.ORG_ALIAS.value,
    ]

    derouter_org_max_budget_metric = [
        UserAPIKeyLabelNames.ORG_ID.value,
        UserAPIKeyLabelNames.ORG_ALIAS.value,
    ]

    derouter_org_budget_remaining_hours_metric = [
        UserAPIKeyLabelNames.ORG_ID.value,
        UserAPIKeyLabelNames.ORG_ALIAS.value,
    ]

    derouter_remaining_api_key_budget_metric = [
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
    ]

    derouter_api_key_max_budget_metric = derouter_remaining_api_key_budget_metric

    derouter_api_key_budget_remaining_hours_metric = derouter_remaining_api_key_budget_metric

    derouter_remaining_user_budget_metric = [
        UserAPIKeyLabelNames.USER.value,
    ]

    derouter_user_max_budget_metric = derouter_remaining_user_budget_metric

    derouter_user_budget_remaining_hours_metric = derouter_remaining_user_budget_metric

    derouter_remaining_api_key_requests_for_model = [
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
    ]

    derouter_remaining_api_key_tokens_for_model = [
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
    ]

    derouter_callback_logging_failures_metric = [
        UserAPIKeyLabelNames.CALLBACK_NAME.value,
    ]

    # Add deployment metrics
    derouter_deployment_failure_responses = [
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.EXCEPTION_STATUS.value,
        UserAPIKeyLabelNames.EXCEPTION_CLASS.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.CLIENT_IP.value,
        UserAPIKeyLabelNames.USER_AGENT.value,
    ]

    derouter_deployment_total_requests = [
        UserAPIKeyLabelNames.REQUESTED_MODEL.value,
        UserAPIKeyLabelNames.v2_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_BASE.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.CLIENT_IP.value,
        UserAPIKeyLabelNames.USER_AGENT.value,
    ]

    derouter_deployment_success_responses = derouter_deployment_total_requests

    derouter_remaining_api_key_requests_for_model = [
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
    ]

    derouter_remaining_api_key_tokens_for_model = [
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
    ]

    derouter_api_key_rate_limit_allowed_metric: ClassVar[tuple[str, ...]] = (
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.RATE_LIMIT_TYPE.value,
    )

    derouter_api_key_rate_limit_used_metric = derouter_api_key_rate_limit_allowed_metric

    derouter_team_rate_limit_allowed_metric: ClassVar[tuple[str, ...]] = (
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.RATE_LIMIT_TYPE.value,
    )

    derouter_team_rate_limit_used_metric = derouter_team_rate_limit_allowed_metric

    derouter_llm_api_failed_requests_metric = [
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
    ]

    # Buffer monitoring metrics - these typically don't need additional labels
    derouter_pod_lock_manager_size: list[str] = []

    derouter_in_memory_daily_spend_update_queue_size: list[str] = []

    derouter_redis_daily_spend_update_queue_size: list[str] = []

    derouter_in_memory_spend_update_queue_size: list[str] = []

    derouter_redis_spend_update_queue_size: list[str] = []

    # Cache metrics - track cache hits, misses, and tokens served from cache
    _cache_metric_labels = [
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.END_USER.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.MODEL_ID.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_cache_hits_metric = _cache_metric_labels
    derouter_cache_misses_metric = _cache_metric_labels
    derouter_cached_tokens_metric = _cache_metric_labels

    # Provider prompt-caching metrics - track tokens read/written to provider caches
    derouter_provider_cache_read_input_tokens_metric = _cache_metric_labels
    derouter_provider_cache_creation_input_tokens_metric = _cache_metric_labels

    # Metrics whose emission paths supply org context (used by get_labels)
    _org_label_metrics: ClassVar[frozenset] = frozenset(
        {
            "derouter_llm_api_latency_metric",
            "derouter_llm_api_time_to_first_token_metric",
            "derouter_request_total_latency_metric",
            "derouter_request_queue_time_seconds",
            "derouter_proxy_total_requests_metric",
            "derouter_proxy_failed_requests_metric",
            "derouter_deployment_latency_per_output_token",
            "derouter_requests_metric",
            "derouter_spend_metric",
            "derouter_input_tokens_metric",
            "derouter_total_tokens_metric",
            "derouter_output_tokens_metric",
            "derouter_video_duration_seconds_metric",
            "derouter_images_generated_metric",
        }
    )
    # Managed batch metrics
    _batch_user_labels = [
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.USER_EMAIL.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
    ]

    derouter_managed_batch_created_total = _batch_user_labels

    derouter_managed_file_size_bytes: list[str] = []  # labels: purpose, file_type, model, api_provider, user (custom)

    derouter_managed_batch_duration_seconds = [
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_managed_file_created_total = _batch_user_labels

    derouter_managed_file_deleted_total: list[str] = []  # only "result" label, added at metric creation

    derouter_check_batch_cost_jobs_polled: list[str] = []

    derouter_check_batch_cost_jobs_processed_total = [
        UserAPIKeyLabelNames.v1_DEROUTER_MODEL_NAME.value,
        UserAPIKeyLabelNames.API_PROVIDER.value,
    ]

    derouter_check_batch_cost_errors_total: list[str] = []  # label: error_type (custom)

    derouter_check_batch_cost_last_run_timestamp: list[str] = []

    # MCP tool call metrics
    derouter_mcp_tool_calls_total: list[str] = [
        UserAPIKeyLabelNames.MCP_TOOL_NAME.value,
        UserAPIKeyLabelNames.MCP_SERVER_NAME.value,
        UserAPIKeyLabelNames.API_KEY_HASH.value,
        UserAPIKeyLabelNames.API_KEY_ALIAS.value,
        UserAPIKeyLabelNames.TEAM.value,
        UserAPIKeyLabelNames.TEAM_ALIAS.value,
        UserAPIKeyLabelNames.USER.value,
        UserAPIKeyLabelNames.END_USER.value,
    ]

    derouter_mcp_tool_call_spend_metric: list[str] = list(derouter_mcp_tool_calls_total)

    @staticmethod
    def get_labels(label_name: DEFINED_PROMETHEUS_METRICS) -> list[str]:
        default_labels: Final = _resolve_deployment_and_latency_caller_identity_labels(
            metric_name=label_name,
            labels=getattr(PrometheusMetricLabels, label_name),
        )
        custom_labels: Final = []

        # Add custom metadata labels
        custom_labels.extend(
            [_sanitize_prometheus_label_name(metric) for metric in derouter.custom_prometheus_metadata_labels]
        )

        # Add custom tags labels
        custom_labels.extend([_sanitize_prometheus_label_name(f"tag_{tag}") for tag in derouter.custom_prometheus_tags])

        # Conditionally add stream label to derouter_proxy_total_requests_metric
        if (
            label_name == "derouter_proxy_total_requests_metric"
            and derouter.prometheus_emit_stream_label is True
            and UserAPIKeyLabelNames.STREAM.value not in default_labels
        ):
            custom_labels.append(UserAPIKeyLabelNames.STREAM.value)

        # Conditionally add unified rate-limit labels to
        # derouter_proxy_failed_requests_metric. Off by default so the metric's
        # historical label set is preserved across upgrade; enable via
        # ``derouter.prometheus_emit_rate_limit_labels`` once downstream
        # dashboards include the new labels in their matchers / aggregations.
        if label_name == "derouter_proxy_failed_requests_metric" and derouter.prometheus_emit_rate_limit_labels is True:
            for _rate_limit_label in (
                UserAPIKeyLabelNames.RATE_LIMIT_CATEGORY.value,
                UserAPIKeyLabelNames.RATE_LIMIT_TYPE.value,
            ):
                if _rate_limit_label not in default_labels and _rate_limit_label not in custom_labels:
                    custom_labels.append(_rate_limit_label)

        _user_budget_metrics: Final = {
            "derouter_remaining_user_budget_metric",
            "derouter_user_max_budget_metric",
            "derouter_user_budget_remaining_hours_metric",
        }
        if label_name in _user_budget_metrics and derouter.prometheus_user_budget_label_include_email_alias is True:
            for label in [
                UserAPIKeyLabelNames.USER_EMAIL.value,
                UserAPIKeyLabelNames.USER_ALIAS.value,
            ]:
                if label not in default_labels and label not in custom_labels:
                    custom_labels.append(label)

        if label_name in PrometheusMetricLabels._org_label_metrics:
            for label in [
                UserAPIKeyLabelNames.ORG_ID.value,
                UserAPIKeyLabelNames.ORG_ALIAS.value,
            ]:
                if label not in default_labels and label not in custom_labels:
                    custom_labels.append(label)

        return default_labels + custom_labels


_USER_API_KEY_LABEL_VALUE_INIT_ALIASES: Final[Mapping[str, str]] = MappingProxyType(
    {
        # Some tests / call sites use ``api_key_hash``; Prometheus field is ``hashed_api_key``.
        "api_key_hash": "hashed_api_key",
    }
)


@dataclass(frozen=True, init=False)
class UserAPIKeyLabelValues:
    """
    Prometheus metric label inputs (Python field names match historical Pydantic ``model_dump`` keys).

    Immutable value object: use ``dataclasses.replace()`` to derive a new instance.
    ``model_dump()`` is provided for call sites that still expect a Pydantic-like dict.
    """

    end_user: str | None = None
    user: str | None = None
    user_email: str | None = None
    user_alias: str | None = None
    hashed_api_key: str | None = None
    api_key_alias: str | None = None
    team: str | None = None
    team_alias: str | None = None
    model_group: str | None = None
    requested_model: str | None = None
    model: str | None = None
    derouter_model_name: str | None = None
    # Accept list/tuple at construction time; normalize to tuple in __post_init__.
    tags: tuple[str, ...] | list[str] = ()
    custom_metadata_labels: Mapping[str, str] = field(default_factory=dict)
    model_id: str | None = None
    api_base: str | None = None
    api_provider: str | None = None
    exception_status: str | None = None
    exception_class: str | None = None
    rate_limit_category: str | None = None
    rate_limit_type: str | None = None
    status_code: str | None = None
    fallback_model: str | None = None
    route: str | None = None
    client_ip: str | None = None
    user_agent: str | None = None
    stream: str | None = None
    org_id: str | None = None
    org_alias: str | None = None
    mcp_tool_name: str | None = None
    mcp_server_name: str | None = None
    service_tier: str | None = None

    # Added for test compatibility.
    def __init__(self, **kwargs: Any) -> None:
        """
        Match former Pydantic behavior: unknown keys are ignored; ``api_key_hash`` maps to
        ``hashed_api_key``. This supports ``**standard_logging_payload`` in tests.
        """
        field_names: Final = {f.name for f in fields(self)}
        merged: Final[dict[str, Any]] = {}
        for f in fields(self):
            if f.default_factory is not MISSING:
                merged[f.name] = f.default_factory()
            else:
                merged[f.name] = f.default

        for k, v in kwargs.items():
            if k in field_names:
                merged[k] = v
                continue
            canon = _USER_API_KEY_LABEL_VALUE_INIT_ALIASES.get(k)
            if canon is not None and canon in field_names:
                merged[canon] = v

        for f in fields(self):
            object.__setattr__(self, f.name, merged[f.name])
        self.__post_init__()

    def __post_init__(self) -> None:
        object.__setattr__(self, "tags", tuple(self.tags))
        if self.stream is not None:
            object.__setattr__(self, "stream", str(self.stream))
        _cmd: Final = dict(self.custom_metadata_labels)
        object.__setattr__(
            self,
            "custom_metadata_labels",
            MappingProxyType(_cmd),
        )

    def __repr__(self) -> str:
        # Perf: this object is constructed on every Prometheus logging path; verbose
        # dataclass/Pydantic-style repr is expensive and often pulled in accidentally
        # via f-strings / debug logging. Return empty so accidental stringification
        # stays cheap. (Dataclass default `str()` delegates to `__repr__`.)
        return ""

    def model_dump(self) -> dict[str, Any]:
        """Same shape as the former Pydantic ``model_dump()`` (plain dict, list tags)."""
        d: Final[dict[str, Any]] = {f.name: getattr(self, f.name) for f in fields(self)}
        d["tags"] = list(self.tags)
        d["custom_metadata_labels"] = dict(self.custom_metadata_labels)
        return d


@dataclass
class PrometheusMetricsConfig:
    """Configuration for filtering Prometheus metrics (parsed once from proxy config)."""

    group: str
    metrics: list[str]
    include_labels: list[str] | None = None


@dataclass
class PrometheusSettings:
    """Settings for Prometheus metrics configuration."""

    prometheus_metrics_config: list[PrometheusMetricsConfig] | None = None


class NoOpMetric:
    """A no-op metric that has the same interface as prometheus metrics but does nothing"""

    def __init__(self, *args, **kwargs) -> None:
        pass

    def labels(self, *args, **kwargs):
        return self

    def inc(self, *args, **kwargs) -> None:
        pass

    def set(self, *args, **kwargs) -> None:
        pass

    def observe(self, *args, **kwargs) -> None:
        pass
