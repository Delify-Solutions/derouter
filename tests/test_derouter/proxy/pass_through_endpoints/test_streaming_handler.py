import json
from collections.abc import Iterator
from datetime import datetime
from unittest.mock import MagicMock

import pytest

import derouter
from derouter.derouter_core_utils.derouter_logging import Logging as DeRouterLoggingObj
from derouter.proxy.pass_through_endpoints.llm_provider_handlers.vertex_passthrough_logging_handler import (
    VertexPassthroughLoggingHandler,
)
from derouter.proxy.pass_through_endpoints.streaming_handler import (
    PassThroughStreamingHandler,
)
from derouter.proxy.pass_through_endpoints.success_handler import (
    PassThroughEndpointLogging,
)
from derouter.types.passthrough_endpoints.pass_through_endpoints import EndpointType

MODEL = "gemini-stream-pricing-probe"
PROMPT_TOKENS = 1000
COMPLETION_TOKENS = 1000
GEMINI_INPUT_RATE = 1e-07
GEMINI_OUTPUT_RATE = 4e-07
VERTEX_INPUT_RATE = 1.5e-07
VERTEX_OUTPUT_RATE = 6e-07
GEMINI_COST = PROMPT_TOKENS * GEMINI_INPUT_RATE + COMPLETION_TOKENS * GEMINI_OUTPUT_RATE
VERTEX_COST = PROMPT_TOKENS * VERTEX_INPUT_RATE + COMPLETION_TOKENS * VERTEX_OUTPUT_RATE


@pytest.fixture(autouse=True)
def divergent_rate_cards(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setitem(
        derouter.model_cost,
        f"gemini/{MODEL}",
        {
            "input_cost_per_token": GEMINI_INPUT_RATE,
            "output_cost_per_token": GEMINI_OUTPUT_RATE,
            "derouter_provider": "gemini",
            "mode": "chat",
        },
    )
    monkeypatch.setitem(
        derouter.model_cost,
        f"vertex_ai/{MODEL}",
        {
            "input_cost_per_token": VERTEX_INPUT_RATE,
            "output_cost_per_token": VERTEX_OUTPUT_RATE,
            "derouter_provider": "vertex_ai",
            "mode": "chat",
        },
    )
    derouter.get_model_info.cache_clear()
    yield
    derouter.get_model_info.cache_clear()


def _chunks() -> list[str]:
    payload = {
        "candidates": [
            {
                "content": {"parts": [{"text": "hi"}], "role": "model"},
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": {
            "promptTokenCount": PROMPT_TOKENS,
            "candidatesTokenCount": COMPLETION_TOKENS,
            "totalTokenCount": PROMPT_TOKENS + COMPLETION_TOKENS,
        },
        "modelVersion": MODEL,
    }
    return [f"data: {json.dumps(payload)}"]


def _logging_obj() -> DeRouterLoggingObj:
    logging_obj = MagicMock(spec=DeRouterLoggingObj)
    logging_obj.model_call_details = {}
    logging_obj.optional_params = {}
    logging_obj.derouter_call_id = "test-call-id"
    return logging_obj


@pytest.mark.parametrize(
    "endpoint_type, expected_provider, expected_cost",
    [
        (EndpointType.GEMINI, "gemini", GEMINI_COST),
        (EndpointType.VERTEX_AI, "vertex_ai", VERTEX_COST),
    ],
)
def test_streaming_generate_content_bills_against_the_requested_provider(
    endpoint_type, expected_provider, expected_cost
):
    logging_obj = _logging_obj()

    _, kwargs = PassThroughStreamingHandler._build_passthrough_logging_result(
        derouter_logging_obj=logging_obj,
        passthrough_success_handler_obj=PassThroughEndpointLogging(),
        url_route="/v1/generateContent",
        request_body={},
        endpoint_type=endpoint_type,
        start_time=datetime.now(),
        raw_bytes=[chunk.encode("utf-8") for chunk in _chunks()],
        end_time=datetime.now(),
        model=MODEL,
    )

    assert kwargs["response_cost"] == pytest.approx(expected_cost)
    assert logging_obj.model_call_details["custom_llm_provider"] == expected_provider


def test_vertex_generate_content_payload_prices_gemini_urls_at_gemini_rates():
    logging_obj = _logging_obj()

    result = VertexPassthroughLoggingHandler._handle_logging_vertex_collected_chunks(
        derouter_logging_obj=logging_obj,
        passthrough_success_handler_obj=PassThroughEndpointLogging(),
        url_route=f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:streamGenerateContent",
        request_body={},
        endpoint_type=EndpointType.VERTEX_AI,
        start_time=datetime.now(),
        all_chunks=_chunks(),
        model=MODEL,
        end_time=datetime.now(),
    )

    assert result["kwargs"]["response_cost"] == pytest.approx(GEMINI_COST)
    assert logging_obj.model_call_details["custom_llm_provider"] == "gemini"
