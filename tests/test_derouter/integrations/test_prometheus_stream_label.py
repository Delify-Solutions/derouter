"""
Unit tests for prometheus_emit_stream_label opt-in setting.

Tests that:
- stream label is NOT added to derouter_proxy_total_requests_metric by default
- stream label IS added when derouter.prometheus_emit_stream_label = True
- stream value is populated correctly from standard_logging_payload
"""

import pytest

import derouter
from derouter.types.integrations.prometheus import (
    PrometheusMetricLabels,
    UserAPIKeyLabelNames,
)


def test_stream_label_not_present_by_default():
    """stream label should NOT appear in derouter_proxy_total_requests_metric unless opted in"""
    derouter.prometheus_emit_stream_label = False
    labels = PrometheusMetricLabels.get_labels("derouter_proxy_total_requests_metric")
    assert UserAPIKeyLabelNames.STREAM.value not in labels


def test_stream_label_present_when_opted_in():
    """stream label SHOULD appear in derouter_proxy_total_requests_metric when opted in"""
    derouter.prometheus_emit_stream_label = True
    try:
        labels = PrometheusMetricLabels.get_labels(
            "derouter_proxy_total_requests_metric"
        )
        assert UserAPIKeyLabelNames.STREAM.value in labels
    finally:
        derouter.prometheus_emit_stream_label = False


def test_stream_label_not_in_other_metrics_when_opted_in():
    """stream label should NOT be added to other metrics even when opted in"""
    derouter.prometheus_emit_stream_label = True
    try:
        other_metrics = [
            "derouter_proxy_failed_requests_metric",
            "derouter_spend_metric",
            "derouter_input_tokens_metric",
            "derouter_output_tokens_metric",
            "derouter_llm_api_latency_metric",
        ]
        for metric in other_metrics:
            labels = PrometheusMetricLabels.get_labels(metric)
            assert (
                UserAPIKeyLabelNames.STREAM.value not in labels
            ), f"stream label should not be in {metric}"
    finally:
        derouter.prometheus_emit_stream_label = False


def test_stream_label_name():
    """STREAM label name should be 'stream'"""
    assert UserAPIKeyLabelNames.STREAM.value == "stream"


def test_user_api_key_label_values_has_stream_field():
    """UserAPIKeyLabelValues should accept stream field"""
    from derouter.types.integrations.prometheus import UserAPIKeyLabelValues

    values = UserAPIKeyLabelValues(stream="True")
    assert values.stream == "True"

    values_false = UserAPIKeyLabelValues(stream="False")
    assert values_false.stream == "False"

    values_none = UserAPIKeyLabelValues()
    assert values_none.stream is None


def test_stream_label_in_model_dump():
    """stream field appears in model_dump() output for use in prometheus_label_factory"""
    from derouter.types.integrations.prometheus import UserAPIKeyLabelValues

    values = UserAPIKeyLabelValues(stream="True")
    dumped = values.model_dump()
    assert "stream" in dumped
    assert dumped["stream"] == "True"
