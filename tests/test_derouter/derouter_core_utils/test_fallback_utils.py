"""Tests for derouter.derouter_core_utils.fallback_utils."""

import pytest
import httpx

import derouter
from derouter.derouter_core_utils.core_helpers import process_response_headers
from derouter.derouter_core_utils.fallback_utils import (
    async_completion_with_fallbacks,
)


@pytest.mark.asyncio
async def test_fallback_dict_not_mutated(monkeypatch):
    fallback_dict = {"model": "fallback-model", "temperature": 0.2}
    original_fallback_dict = dict(fallback_dict)

    attempted_models: list[str] = []

    async def _fake_acompletion(*, model: str, **kwargs):
        attempted_models.append(model)
        if model == "primary-model":
            raise Exception("primary failed")
        return {"model": model, "temperature": kwargs.get("temperature")}

    monkeypatch.setattr(derouter, "acompletion", _fake_acompletion)

    # Call 1: primary fails, fallback dict succeeds
    response_1 = await async_completion_with_fallbacks(
        model="primary-model",
        kwargs={"fallbacks": [fallback_dict]},
    )
    assert response_1["model"] == "fallback-model"
    assert fallback_dict == original_fallback_dict

    # Call 2: re-use the same dict object; it should still work and remain unchanged
    response_2 = await async_completion_with_fallbacks(
        model="primary-model",
        kwargs={"fallbacks": [fallback_dict]},
    )
    assert response_2["model"] == "fallback-model"
    assert fallback_dict == original_fallback_dict

    assert attempted_models == [
        "primary-model",
        "fallback-model",
        "primary-model",
        "fallback-model",
    ]


@pytest.mark.asyncio
async def test_async_completion_with_fallbacks_sets_attempted_fallbacks_header():
    """
    When a fallback succeeds, the response must carry the
    `x-derouter-attempted-fallbacks` header so the proxy and other callers can
    detect that a fallback occurred. Without it,
    `_override_openai_response_model` stamps the requested model back over the
    fallback model used. See issue #28241.
    """
    response = await async_completion_with_fallbacks(
        model="openai/primary-llm",
        messages=[{"role": "user", "content": "hi"}],
        api_key="fake-key",
        mock_response=Exception("forced failure"),
        kwargs={
            "fallbacks": [
                {
                    "model": "openai/backup-llm",
                    "api_key": "fake-key",
                    "mock_response": "backup-resp",
                }
            ]
        },
    )

    hidden_params = getattr(response, "_hidden_params", None)
    assert isinstance(hidden_params, dict)
    headers = hidden_params.get("additional_headers") or {}
    assert headers.get("x-derouter-attempted-fallbacks") == 1


@pytest.mark.asyncio
async def test_async_completion_with_fallbacks_header_is_zero_when_primary_succeeds():
    """
    When the primary model succeeds on the first attempt, the header should be
    `0` (no fallback was used). This mirrors the existing router-level
    semantics in `async_function_with_fallbacks`.
    """
    response = await async_completion_with_fallbacks(
        model="openai/primary-llm",
        messages=[{"role": "user", "content": "hi"}],
        api_key="fake-key",
        mock_response="primary-resp",
        kwargs={
            "fallbacks": [
                {
                    "model": "openai/backup-llm",
                    "api_key": "fake-key",
                    "mock_response": "backup-resp",
                }
            ]
        },
    )

    hidden_params = getattr(response, "_hidden_params", None)
    assert isinstance(hidden_params, dict)
    headers = hidden_params.get("additional_headers") or {}
    assert headers.get("x-derouter-attempted-fallbacks") == 0
    assert response.choices[0].message.content == "primary-resp"


def test_process_response_headers_preserves_x_derouter_headers_when_internal():
    """
    `process_response_headers` must not add the `llm_provider-` prefix to
    DeRouter's own internal headers (anything starting with `x-derouter-`) when
    the caller has marked the input as DeRouter-owned. These are markers set by
    DeRouter (e.g. fallback / retry headers); the proxy and other callers look
    up the bare key.
    """
    result = process_response_headers(
        {
            "x-derouter-attempted-fallbacks": 1,
            "x-derouter-model-group": "gpt-4",
            "x-stainless-arch": "arm64",
        },
        preserve_derouter_internal_headers=True,
    )
    assert result["x-derouter-attempted-fallbacks"] == 1
    assert result["x-derouter-model-group"] == "gpt-4"
    assert result["llm_provider-x-stainless-arch"] == "arm64"


def test_process_response_headers_prefixes_x_derouter_from_raw_provider():
    """
    On raw upstream-provider headers (default `preserve_derouter_internal_headers=False`),
    a header whose name starts with `x-derouter-` MUST still get the
    `llm_provider-` prefix. Otherwise a malicious provider could return
    `x-derouter-attempted-fallbacks` and spoof a DeRouter-internal marker,
    bypassing the proxy model-override guard.
    """
    result = process_response_headers(
        {
            "x-derouter-attempted-fallbacks": 99,
            "x-stainless-arch": "arm64",
        }
    )
    assert "x-derouter-attempted-fallbacks" not in result
    assert result["llm_provider-x-derouter-attempted-fallbacks"] == 99
    assert result["llm_provider-x-stainless-arch"] == "arm64"


def test_process_response_headers_ignores_preserve_flag_for_httpx_headers():
    """
    Some providers store raw httpx.Headers directly in _hidden_params["additional_headers"]
    without a prior normalization pass. If preserve_derouter_internal_headers=True were
    honored for httpx.Headers inputs, a provider returning x-derouter-attempted-fallbacks
    could spoof it as a bare DeRouter-internal marker and make the proxy skip
    stamping the correct response model. The flag must be ignored for httpx.Headers.
    """
    raw = httpx.Headers(
        {
            "x-derouter-attempted-fallbacks": "1",
            "content-type": "application/json",
        }
    )
    result = process_response_headers(raw, preserve_derouter_internal_headers=True)
    assert "x-derouter-attempted-fallbacks" not in result
    assert result["llm_provider-x-derouter-attempted-fallbacks"] == "1"
