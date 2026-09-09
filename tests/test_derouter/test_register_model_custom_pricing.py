"""
Test that register_model() in completion() and embedding() passes all
custom pricing fields from kwargs and model_info, not just the base
input/output costs.

Previously, only input_cost_per_token, output_cost_per_token, and
derouter_provider were forwarded. Fields like cache_read_input_token_cost,
mode, and supports_prompt_caching were dropped, causing incorrect cost
calculations for DB-sourced models with prompt caching pricing.
"""

import copy
import os

import pytest


import derouter
from derouter.main import _build_custom_pricing_entry
from derouter.utils import _invalidate_model_cost_lowercase_map


def _snapshot_model_cost_entries(keys):
    return {key: copy.deepcopy(derouter.model_cost.get(key)) for key in keys}


def _restore_model_cost_entries(original_entries):
    for key, value in original_entries.items():
        if value is None:
            derouter.model_cost.pop(key, None)
        else:
            derouter.model_cost[key] = value
    _invalidate_model_cost_lowercase_map()


def test_build_custom_pricing_entry_includes_all_kwargs_fields():
    """All CustomPricingDeRouterParams fields present in kwargs should be
    included in the resulting entry dict."""
    kwargs = {
        "input_cost_per_token": 0.001,
        "output_cost_per_token": 0.002,
        "cache_read_input_token_cost": 0.00025,
        "cache_creation_input_token_cost": 0.005,
        "output_cost_per_reasoning_token": 0.01,
        "input_cost_per_audio_token": 0.003,
        "unrelated_kwarg": "should_be_ignored",
    }

    entry = _build_custom_pricing_entry(
        custom_llm_provider="openai",
        kwargs=kwargs,
    )

    assert entry["derouter_provider"] == "openai"
    assert entry["input_cost_per_token"] == 0.001
    assert entry["output_cost_per_token"] == 0.002
    assert entry["cache_read_input_token_cost"] == 0.00025
    assert entry["cache_creation_input_token_cost"] == 0.005
    assert entry["output_cost_per_reasoning_token"] == 0.01
    assert entry["input_cost_per_audio_token"] == 0.003
    assert "unrelated_kwarg" not in entry


def test_build_custom_pricing_entry_merges_model_info_metadata():
    """Fields from model_info (mode, supports_prompt_caching, max_tokens)
    should be merged into the entry when present."""
    kwargs = {
        "input_cost_per_token": 0.001,
        "output_cost_per_token": 0.002,
    }
    model_info = {
        "id": "deployment-123",
        "mode": "chat",
        "supports_prompt_caching": True,
        "max_tokens": 128000,
    }

    entry = _build_custom_pricing_entry(
        custom_llm_provider="openai",
        kwargs=kwargs,
        model_info=model_info,
    )

    assert entry["mode"] == "chat"
    assert entry["supports_prompt_caching"] is True
    assert entry["max_tokens"] == 128000


def test_build_custom_pricing_entry_setdefault_does_not_override_existing():
    """model_info uses setdefault, so it should not override a key that is
    already present in the entry dict. Currently CustomPricingDeRouterParams
    and the model_info keys (mode, supports_prompt_caching, max_tokens) do
    not overlap, but if they ever do, setdefault ensures the kwargs-sourced
    value wins."""
    kwargs = {
        "input_cost_per_token": 0.001,
        "output_cost_per_token": 0.002,
    }
    model_info = {
        "mode": "chat",
        "supports_prompt_caching": True,
        "max_tokens": 128000,
    }

    entry = _build_custom_pricing_entry(
        custom_llm_provider="openai",
        kwargs=kwargs,
        model_info=model_info,
    )

    assert entry["mode"] == "chat"
    assert entry["supports_prompt_caching"] is True
    assert entry["max_tokens"] == 128000

    # Verify setdefault behavior: if a model_info key already exists in
    # the entry (e.g. from a future CustomPricingDeRouterParams addition),
    # setdefault must not overwrite it.
    entry["mode"] = "embedding"  # simulate pre-existing value
    # Re-apply setdefault the same way _build_custom_pricing_entry does
    entry.setdefault("mode", model_info["mode"])
    assert entry["mode"] == "embedding"  # must NOT revert to "chat"


def test_build_custom_pricing_entry_skips_none_values():
    """Fields with None values in kwargs should not be included."""
    kwargs = {
        "input_cost_per_token": 0.001,
        "output_cost_per_token": None,  # explicitly None
        "cache_read_input_token_cost": None,
    }

    entry = _build_custom_pricing_entry(
        custom_llm_provider="openai",
        kwargs=kwargs,
    )

    assert entry["input_cost_per_token"] == 0.001
    assert "output_cost_per_token" not in entry
    assert "cache_read_input_token_cost" not in entry


def test_build_custom_pricing_entry_handles_no_model_info():
    """Should work correctly when model_info is None."""
    kwargs = {
        "input_cost_per_token": 0.001,
        "output_cost_per_token": 0.002,
    }

    entry = _build_custom_pricing_entry(
        custom_llm_provider="openai",
        kwargs=kwargs,
        model_info=None,
    )

    assert entry["derouter_provider"] == "openai"
    assert entry["input_cost_per_token"] == 0.001
    assert entry["output_cost_per_token"] == 0.002
    assert "mode" not in entry


def test_register_model_receives_cache_pricing_fields():
    """End-to-end: when register_model is called with a full pricing entry,
    the cache pricing fields should be present in derouter.model_cost."""
    model_key = "openai/test-custom-model-with-cache-pricing"

    derouter.register_model(
        {
            model_key: {
                "input_cost_per_token": 0.001,
                "output_cost_per_token": 0.002,
                "cache_read_input_token_cost": 0.00025,
                "supports_prompt_caching": True,
                "mode": "chat",
                "max_tokens": 8192,
                "derouter_provider": "openai",
            }
        }
    )

    registered = derouter.model_cost.get(model_key)
    assert registered is not None, f"{model_key} should be in model_cost"
    assert registered["cache_read_input_token_cost"] == 0.00025
    assert registered["supports_prompt_caching"] is True
    assert registered["mode"] == "chat"
    assert registered["max_tokens"] == 8192

    # Cleanup
    derouter.model_cost.pop(model_key, None)


def test_build_custom_pricing_entry_time_based():
    """Time-based pricing fields should be included correctly."""
    kwargs = {
        "input_cost_per_second": 0.01,
        "output_cost_per_second": 0.02,
    }

    entry = _build_custom_pricing_entry(
        custom_llm_provider="openai",
        kwargs=kwargs,
    )

    assert entry["derouter_provider"] == "openai"
    assert entry["input_cost_per_second"] == 0.01
    assert entry["output_cost_per_second"] == 0.02


def test_register_model_strips_none_derouter_provider():
    """``get_model_info`` returns ``derouter_provider: None`` for deployments
    registered without a provider (e.g. ``Router.add_deployment`` flows).
    ``register_model`` must not persist that None into ``model_cost``,
    otherwise ``_check_provider_match`` will drop custom pricing on
    subsequent cost lookups.

    Regression test for https://github.com/Delify-Solutions/derouter/issues/28336.
    """
    from derouter.utils import _check_provider_match

    model_key = "test-custom-pricing-no-provider-28336"
    derouter.model_cost.pop(model_key, None)

    try:
        derouter.register_model(
            {
                model_key: {
                    "input_cost_per_token": 0.001,
                    "output_cost_per_token": 0.002,
                }
            }
        )

        registered = derouter.model_cost.get(model_key)
        assert registered is not None, f"{model_key} should be in model_cost"
        # The key may be absent entirely, but if present it must not be None.
        assert (
            "derouter_provider" not in registered
            or registered["derouter_provider"] is not None
        )
        # Downstream consumers must accept this entry for any provider,
        # mirroring what the cost calculator does.
        assert _check_provider_match(registered, "openai") is True
        assert _check_provider_match(registered, "anthropic") is True
    finally:
        derouter.model_cost.pop(model_key, None)


def test_register_model_strips_none_derouter_provider_from_get_model_info(monkeypatch):
    """Directly exercise the strip in ``register_model``.

    The companion test above hits the ``except Exception`` branch where
    ``existing_model`` is an empty dict, so the ``pop`` is a no-op. This
    test patches ``get_model_info`` to return the failure mode the strip
    was added to handle, namely a populated dict whose ``derouter_provider``
    is ``None``. Without the strip, the merged entry in
    ``derouter.model_cost`` would carry ``derouter_provider: None`` and
    ``_check_provider_match`` would drop custom pricing.

    Regression test for https://github.com/Delify-Solutions/derouter/issues/28336.
    """
    from derouter import utils as derouter_utils
    from derouter.utils import _check_provider_match

    model_key = "test-strip-none-provider-from-get-model-info-28336"
    derouter.model_cost.pop(model_key, None)

    def _fake_get_model_info(model, *args, **kwargs):
        assert model == model_key
        return {
            "key": model_key,
            "derouter_provider": None,
            "mode": "chat",
            "max_tokens": 4096,
        }

    # ``register_model`` calls ``get_model_info.cache_clear`` via
    # ``_invalidate_model_cost_lowercase_map``, so the replacement must
    # expose a no-op ``cache_clear`` attribute.
    _fake_get_model_info.cache_clear = lambda: None
    monkeypatch.setattr(derouter_utils, "get_model_info", _fake_get_model_info)

    try:
        derouter.register_model(
            {
                model_key: {
                    "input_cost_per_token": 0.001,
                    "output_cost_per_token": 0.002,
                }
            }
        )

        registered = derouter.model_cost.get(model_key)
        assert registered is not None, f"{model_key} should be in model_cost"
        # The strip must have removed the None-valued provider that
        # ``get_model_info`` returned. The key may be absent entirely, but
        # it must never be present with value ``None``.
        assert "derouter_provider" not in registered or (
            registered["derouter_provider"] is not None
        ), (
            "register_model failed to strip derouter_provider=None returned "
            f"by get_model_info, got {registered.get('derouter_provider')!r}"
        )
        # Metadata from the patched ``get_model_info`` must still flow
        # through, so we know the strip did not nuke the rest of the entry.
        assert registered.get("mode") == "chat"
        assert registered.get("max_tokens") == 4096
        # And custom pricing from the registration call must be preserved.
        assert registered.get("input_cost_per_token") == 0.001
        assert registered.get("output_cost_per_token") == 0.002
        # Downstream _check_provider_match must accept any provider for
        # this entry, mirroring the cost calculator path.
        assert _check_provider_match(registered, "openai") is True
        assert _check_provider_match(registered, "anthropic") is True
    finally:
        derouter.model_cost.pop(model_key, None)


def test_register_model_inherits_builtin_cache_pricing_for_unmapped_key(monkeypatch):
    """Registering a custom override under a key shape that
    ``get_model_info`` cannot resolve (e.g. a triple provider prefix like
    ``bedrock/bedrock/bedrock/us.anthropic.claude-sonnet-4-6``; a double
    prefix now resolves like a routing prefix) must still inherit
    the built-in cache pricing for the underlying model.

    Before the fix ``register_model`` fell back to an empty ``existing_model``
    so the merged entry only carried the fields the user set explicitly
    (input/output cost). ``cache_creation_input_token_cost`` and
    ``cache_read_input_token_cost`` were absent, and the cost calculator
    silently charged 0 for every cache token, dropping the bulk of the bill
    for cache-heavy Anthropic traffic.

    Regression for the cache-pricing dropout under partial overrides.
    """
    from derouter.derouter_core_utils.llm_cost_calc.utils import generic_cost_per_token
    from derouter.types.utils import PromptTokensDetailsWrapper, Usage

    original_model_cost = derouter.model_cost
    monkeypatch.setenv("DEROUTER_LOCAL_MODEL_COST_MAP", "True")
    derouter.model_cost = derouter.get_model_cost_map(url="")

    builtin_key = "us.anthropic.claude-sonnet-4-6"
    registered_key = f"bedrock/bedrock/bedrock/{builtin_key}"
    builtin = derouter.model_cost[builtin_key]

    assert builtin["cache_creation_input_token_cost"] > 0
    assert builtin["cache_read_input_token_cost"] > 0

    try:
        derouter.register_model(
            {
                registered_key: {
                    "input_cost_per_token": builtin["input_cost_per_token"],
                    "output_cost_per_token": builtin["output_cost_per_token"],
                    "derouter_provider": "bedrock",
                }
            }
        )

        registered = derouter.model_cost[registered_key]
        assert (
            registered.get("cache_creation_input_token_cost")
            == builtin["cache_creation_input_token_cost"]
        )
        assert (
            registered.get("cache_read_input_token_cost")
            == builtin["cache_read_input_token_cost"]
        )
        assert registered["derouter_provider"] == "bedrock"

        usage = Usage(
            prompt_tokens=1100,
            completion_tokens=100,
            total_tokens=1200,
            prompt_tokens_details=PromptTokensDetailsWrapper(
                cached_tokens=800,
                text_tokens=100,
            ),
            cache_creation_input_tokens=200,
        )

        input_cost, output_cost = generic_cost_per_token(
            model=registered_key,
            usage=usage,
            custom_llm_provider="bedrock",
        )

        text_only_cost = builtin["input_cost_per_token"] * 100
        expected_input_cost = (
            text_only_cost
            + builtin["cache_read_input_token_cost"] * 800
            + builtin["cache_creation_input_token_cost"] * 200
        )
        assert abs(input_cost - expected_input_cost) < 1e-12
        assert abs(output_cost - builtin["output_cost_per_token"] * 100) < 1e-12
        assert input_cost > text_only_cost + 1e-12
    finally:
        derouter.model_cost.pop(registered_key, None)
        derouter.model_cost = original_model_cost
        os.environ.pop("DEROUTER_LOCAL_MODEL_COST_MAP", None)
        from derouter.utils import _invalidate_model_cost_lowercase_map

        _invalidate_model_cost_lowercase_map()


def test_register_model_warns_when_no_builtin_match_for_cache_pricing(caplog):
    """When a custom override is registered under a key that neither
    ``get_model_info`` nor any prefix/region variant can resolve to a
    built-in entry, ``register_model`` must warn that cache cost fields will
    default to 0 instead of silently producing an under-billed entry.
    """
    import logging

    from derouter._logging import verbose_logger

    registered_key = "bedrock/totally-made-up-model-alias-xyz"
    derouter.model_cost.pop(registered_key, None)

    try:
        with caplog.at_level(logging.WARNING, logger=verbose_logger.name):
            derouter.register_model(
                {
                    registered_key: {
                        "input_cost_per_token": 0.001,
                        "output_cost_per_token": 0.002,
                        "derouter_provider": "bedrock",
                    }
                }
            )

        assert any(
            registered_key in record.message
            and "cache_creation_input_token_cost" in record.message
            for record in caplog.records
        ), "expected a warning naming the unmapped key and the cache cost fields"
    finally:
        derouter.model_cost.pop(registered_key, None)


def test_register_model_no_warning_without_custom_pricing(caplog):
    """LIT-6318: an entry with no custom pricing (e.g. router deployment
    metadata) never drives cost calculation, so registering it under an
    unmatched key must not emit the missing-cache-pricing warning.
    """
    import logging

    from derouter._logging import verbose_logger

    registered_key = "azure/lit6318-deployment-without-pricing"
    derouter.model_cost.pop(registered_key, None)

    try:
        with caplog.at_level(logging.WARNING, logger=verbose_logger.name):
            derouter.register_model(
                {
                    registered_key: {
                        "derouter_provider": "azure",
                        "base_model": "azure/text-embedding-3-large",
                    }
                }
            )

        assert not any("register_model" in record.message for record in caplog.records), (
            "entry without custom pricing must register silently"
        )
    finally:
        derouter.model_cost.pop(registered_key, None)


def test_register_model_no_warning_for_tiered_pricing_without_cache_costs(caplog):
    """LIT-6318: tiered pricing bills cache reads at the tier's input rate when
    cache costs are omitted, so a tiered entry must not trigger the
    cache-defaults-to-0 warning.
    """
    import logging

    from derouter._logging import verbose_logger

    registered_key = "bedrock/lit6318-tiered-priced-model"
    derouter.model_cost.pop(registered_key, None)

    try:
        with caplog.at_level(logging.WARNING, logger=verbose_logger.name):
            derouter.register_model(
                {
                    registered_key: {
                        "derouter_provider": "bedrock",
                        "tiered_pricing": [
                            {
                                "range": [0, 200000],
                                "input_cost_per_token": 1e-06,
                                "output_cost_per_token": 5e-06,
                            }
                        ],
                    }
                }
            )

        assert not any("register_model" in record.message for record in caplog.records), (
            "tiered pricing entry must register silently"
        )
    finally:
        derouter.model_cost.pop(registered_key, None)


def test_router_deployment_without_custom_pricing_registers_silently(caplog):
    """LIT-6318: the router registers every deployment under its hashed id and
    its backend key. Deployments without custom pricing are costed at request
    time from the underlying model name, so startup must not warn about them.
    """
    import logging

    from derouter import Router
    from derouter._logging import verbose_logger

    deployment_model = "azure/lit6318-my-deployment-name"
    deployment_id = "lit6318-no-pricing-deployment"
    snapshot = _snapshot_model_cost_entries([deployment_model, deployment_id])

    try:
        with caplog.at_level(logging.WARNING, logger=verbose_logger.name):
            Router(
                model_list=[
                    {
                        "model_name": "indexing",
                        "derouter_params": {
                            "model": deployment_model,
                            "api_base": "https://example.openai.azure.com",
                            "api_key": "fake-key",
                        },
                        "model_info": {
                            "id": deployment_id,
                            "base_model": "azure/text-embedding-3-large",
                        },
                    }
                ]
            )

        register_warnings = [record.message for record in caplog.records if "register_model" in record.message]
        assert not register_warnings, register_warnings
    finally:
        _restore_model_cost_entries(snapshot)


def test_router_custom_priced_deployment_warning_names_model_not_hash(caplog):
    """LIT-6318: when a custom-priced deployment genuinely lacks cache pricing
    and no built-in entry matches, the warning must name the deployment's
    model rather than its opaque hashed id.
    """
    import logging

    from derouter import Router
    from derouter._logging import verbose_logger

    deployment_model = "bedrock/lit6318-totally-made-up-model"
    deployment_id = "lit6318-custom-priced-deployment-hash"
    snapshot = _snapshot_model_cost_entries([deployment_model, deployment_id])

    try:
        with caplog.at_level(logging.WARNING, logger=verbose_logger.name):
            Router(
                model_list=[
                    {
                        "model_name": "made-up",
                        "derouter_params": {
                            "model": deployment_model,
                            "aws_region_name": "us-east-1",
                            "input_cost_per_token": 1e-06,
                            "output_cost_per_token": 5e-06,
                        },
                        "model_info": {"id": deployment_id},
                    }
                ]
            )

        register_warnings = [record.message for record in caplog.records if "register_model" in record.message]
        assert register_warnings, "expected a warning for missing cache pricing"
        for message in register_warnings:
            assert deployment_id not in message, message
            assert deployment_model in message, message
    finally:
        _restore_model_cost_entries(snapshot)


def test_register_model_router_add_deployment_custom_pricing_applies():
    """End-to-end regression for https://github.com/Delify-Solutions/derouter/issues/28336.

    ``Router.add_deployment`` registers custom pricing without passing
    ``derouter_provider``. Cost calculation must still pick up the custom
    pricing instead of falling back to the default provider price.
    """
    from derouter import Router

    model_key = "router-add-deployment-custom-pricing-28336"
    deployment_model = f"openai/{model_key}"
    derouter.model_cost.pop(model_key, None)
    derouter.model_cost.pop(deployment_model, None)

    router = Router(
        model_list=[
            {
                "model_name": model_key,
                "derouter_params": {
                    "model": deployment_model,
                    "api_key": "fake-key-for-registration",
                    "input_cost_per_token": 0.00042,
                    "output_cost_per_token": 0.00084,
                },
                "model_info": {"id": "deployment-28336"},
            }
        ]
    )

    try:
        # ``add_deployment`` runs as part of ``Router.__init__``; the
        # registered entry must not block ``_check_provider_match`` for
        # the deployment's provider.
        from derouter.utils import _check_provider_match

        registered_keys = [
            k for k in (deployment_model, model_key) if k in derouter.model_cost
        ]
        assert registered_keys, (
            "Router.add_deployment did not register custom pricing for "
            f"{model_key} / {deployment_model}"
        )
        for k in registered_keys:
            assert (
                _check_provider_match(derouter.model_cost[k], "openai") is True
            ), f"custom pricing for {k} was dropped by _check_provider_match"
    finally:
        derouter.model_cost.pop(model_key, None)
        derouter.model_cost.pop(deployment_model, None)
        del router


def test_embedding_router_zero_pricing_does_not_clobber_builtin_pricing():
    """LIT-3991: a router-originated embedding request that carries explicit
    zero custom pricing (e.g. resolved through an ``openai/*`` wildcard
    deployment with ``input_cost_per_token: 0``) must not overwrite the shared
    ``openai/text-embedding-3-small`` entry in ``derouter.model_cost``. Before
    the fix, one call through the wildcard poisoned the shared key and every
    sibling deployment relying on built-in pricing logged $0 until restart.
    """
    shared_key = "openai/text-embedding-3-small"
    deployment_id = "lit3991-wildcard-embed-zero"
    snapshot = _snapshot_model_cost_entries(
        [shared_key, "text-embedding-3-small", deployment_id]
    )
    builtin_input_cost = derouter.get_model_info(model=shared_key)[
        "input_cost_per_token"
    ]
    assert builtin_input_cost > 0

    try:
        derouter.embedding(
            model=shared_key,
            input=["hello"],
            api_key="fake-key",
            input_cost_per_token=0.0,
            output_cost_per_token=0.0,
            model_info={"id": deployment_id},
            metadata={"model_info": {"id": deployment_id}},
            mock_response=[0.1, 0.2],
        )

        assert (
            derouter.get_model_info(model=shared_key)["input_cost_per_token"]
            == builtin_input_cost
        ), "wildcard deployment's zero pricing leaked into the shared model_cost key"
        assert derouter.model_cost[deployment_id]["input_cost_per_token"] == 0.0
        assert derouter.model_cost[deployment_id]["output_cost_per_token"] == 0.0

        sibling_response = derouter.embedding(
            model=shared_key,
            input=["hello"],
            api_key="fake-key",
            mock_response=[0.1, 0.2],
        )
        sibling_cost = derouter.completion_cost(
            completion_response=sibling_response, call_type="embedding"
        )
        assert sibling_cost == pytest.approx(10 * builtin_input_cost)
    finally:
        _restore_model_cost_entries(snapshot)


def test_embedding_router_custom_pricing_costs_request_via_deployment_id():
    """The request that carries custom pricing must still be costed with that
    pricing (via its deployment id entry), while the shared backend key keeps
    the built-in rate for siblings.
    """
    shared_key = "openai/text-embedding-3-small"
    deployment_id = "lit3991-wildcard-embed-custom"
    override_input_cost = 5e-05
    snapshot = _snapshot_model_cost_entries(
        [shared_key, "text-embedding-3-small", deployment_id]
    )
    builtin_input_cost = derouter.get_model_info(model=shared_key)[
        "input_cost_per_token"
    ]
    assert builtin_input_cost != override_input_cost

    try:
        response = derouter.embedding(
            model=shared_key,
            input=["hello"],
            api_key="fake-key",
            input_cost_per_token=override_input_cost,
            output_cost_per_token=override_input_cost * 2,
            model_info={"id": deployment_id},
            metadata={"model_info": {"id": deployment_id}},
            mock_response=[0.1, 0.2],
        )

        request_cost = derouter.completion_cost(
            completion_response=response,
            model=shared_key,
            custom_llm_provider="openai",
            call_type="embedding",
            custom_pricing=True,
            router_model_id=deployment_id,
        )
        assert request_cost == pytest.approx(10 * override_input_cost)
        assert (
            derouter.get_model_info(model=shared_key)["input_cost_per_token"]
            == builtin_input_cost
        )
    finally:
        _restore_model_cost_entries(snapshot)


def test_completion_router_zero_pricing_does_not_clobber_builtin_pricing():
    """Same isolation as the embedding path, exercised through completion()."""
    shared_key = "openai/gpt-4o-mini"
    deployment_id = "lit3991-wildcard-chat-zero"
    snapshot = _snapshot_model_cost_entries(
        [shared_key, "gpt-4o-mini", deployment_id]
    )
    builtin_input_cost = derouter.get_model_info(model=shared_key)[
        "input_cost_per_token"
    ]
    assert builtin_input_cost > 0

    try:
        derouter.completion(
            model=shared_key,
            messages=[{"role": "user", "content": "hello"}],
            api_key="fake-key",
            input_cost_per_token=0.0,
            output_cost_per_token=0.0,
            model_info={"id": deployment_id},
            metadata={"model_info": {"id": deployment_id}},
            mock_response="hello back",
        )

        assert (
            derouter.get_model_info(model=shared_key)["input_cost_per_token"]
            == builtin_input_cost
        ), "wildcard deployment's zero pricing leaked into the shared model_cost key"
        assert derouter.model_cost[deployment_id]["input_cost_per_token"] == 0.0
    finally:
        _restore_model_cost_entries(snapshot)


def test_embedding_direct_sdk_custom_pricing_still_registers_shared_key():
    """Direct SDK calls (no router deployment id in metadata) keep the legacy
    behavior: custom pricing is registered under ``{provider}/{model}`` and the
    request is costed with it.
    """
    model_key = "openai/lit3991-direct-sdk-embed-model"
    override_input_cost = 3e-05
    try:
        response = derouter.embedding(
            model=model_key,
            input=["hello"],
            api_key="fake-key",
            input_cost_per_token=override_input_cost,
            output_cost_per_token=override_input_cost * 2,
            mock_response=[0.1, 0.2],
        )

        assert (
            derouter.model_cost[model_key]["input_cost_per_token"]
            == override_input_cost
        )
        cost = derouter.completion_cost(
            completion_response=response,
            model=model_key,
            custom_llm_provider="openai",
            call_type="embedding",
            custom_pricing=True,
        )
        assert cost == pytest.approx(10 * override_input_cost)
    finally:
        derouter.model_cost.pop(model_key, None)
        _invalidate_model_cost_lowercase_map()


def test_update_dictionary_merges_nested_dicts_without_aliasing():
    """A nested dict must be merged copy-on-write: the pre-existing nested dict
    object stays untouched, and the caller's incoming nested dict is never
    inserted by reference into the merged result.
    """
    from derouter.utils import _update_dictionary

    existing_nested = {"hours_utc": "01:00-02:00"}
    existing = {"off_peak_pricing": existing_nested}
    incoming_nested = {"windows": [{"hours_utc": "16:00-19:00", "weekdays": [2]}]}
    incoming = {"off_peak_pricing": incoming_nested}

    merged = _update_dictionary(existing, incoming)

    assert merged["off_peak_pricing"] == {
        "hours_utc": "01:00-02:00",
        "windows": [{"hours_utc": "16:00-19:00", "weekdays": [2]}],
    }
    assert existing_nested == {"hours_utc": "01:00-02:00"}
    assert merged["off_peak_pricing"] is not incoming_nested

    fresh = _update_dictionary({}, incoming)
    assert fresh["off_peak_pricing"] == incoming_nested
    assert fresh["off_peak_pricing"] is not incoming_nested


def test_router_deployments_sharing_backend_keep_their_own_off_peak_pricing():
    """Two deployments of the same backend model with different
    ``off_peak_pricing`` blocks must each keep their own schedule under their
    unique model id, and neither block may leak onto the shared backend keys.

    Before the fix, ``register_model`` inserted the first deployment's block by
    reference into the built-in ``gpt-4o-mini`` entry, and the second
    deployment's registration merged its keys into that same object, corrupting
    the first deployment's schedule and polluting the built-in entry.
    """
    from derouter import Router

    active_block = {
        "windows": [{"hours_utc": "16:00-19:00", "weekdays": [2]}],
        "input_cost_per_token": 5e-07,
        "output_cost_per_token": 1e-06,
    }
    inactive_block = {
        "hours_utc": "05:00-06:00",
        "input_cost_per_token": 5e-07,
        "output_cost_per_token": 1e-06,
    }
    shared_keys = ["gpt-4o-mini", "openai/gpt-4o-mini"]
    deployment_ids = ["offpeak-alias-dep-1", "offpeak-alias-dep-2"]
    original_entries = _snapshot_model_cost_entries(shared_keys)

    router = Router(
        model_list=[
            {
                "model_name": "offpeak-active-weekday",
                "derouter_params": {
                    "model": "openai/gpt-4o-mini",
                    "api_key": "fake-key-for-registration",
                },
                "model_info": {
                    "id": deployment_ids[0],
                    "input_cost_per_token": 1e-06,
                    "output_cost_per_token": 2e-06,
                    "off_peak_pricing": dict(active_block),
                },
            },
            {
                "model_name": "offpeak-inactive-hours",
                "derouter_params": {
                    "model": "openai/gpt-4o-mini",
                    "api_key": "fake-key-for-registration",
                },
                "model_info": {
                    "id": deployment_ids[1],
                    "input_cost_per_token": 1e-06,
                    "output_cost_per_token": 2e-06,
                    "off_peak_pricing": dict(inactive_block),
                },
            },
        ]
    )

    try:
        registered_first = derouter.model_cost[deployment_ids[0]]["off_peak_pricing"]
        registered_second = derouter.model_cost[deployment_ids[1]]["off_peak_pricing"]
        assert registered_first == active_block
        assert registered_second == inactive_block
        for shared_key in shared_keys:
            shared_entry = derouter.model_cost.get(shared_key) or {}
            assert not shared_entry.get("off_peak_pricing")
    finally:
        for deployment_id in deployment_ids:
            derouter.model_cost.pop(deployment_id, None)
        _restore_model_cost_entries(original_entries)
        del router


def test_router_off_peak_only_deployment_inherits_builtin_base_rates():
    """A deployment that sets only ``off_peak_pricing`` on its model_info must
    still be costed from its deployment-scoped entry: the base token rates are
    inherited from the backend model's built-in cost map entry, since the
    shared backend key deliberately never carries the off-peak block.
    """
    from derouter import Router

    block = {
        "hours_utc": "00:00-00:00",
        "input_cost_per_token": 5e-05,
        "output_cost_per_token": 1e-04,
    }
    shared_keys = ["gpt-4o-mini", "openai/gpt-4o-mini"]
    deployment_id = "offpeak-only-dep-1"
    original_entries = _snapshot_model_cost_entries(shared_keys + [deployment_id])
    builtin_info = derouter.get_model_info(model="openai/gpt-4o-mini")

    router = Router(
        model_list=[
            {
                "model_name": "offpeak-only",
                "derouter_params": {
                    "model": "openai/gpt-4o-mini",
                    "api_key": "fake-key-for-registration",
                },
                "model_info": {"id": deployment_id, "off_peak_pricing": dict(block)},
            }
        ]
    )

    try:
        entry = derouter.model_cost[deployment_id]
        assert entry["off_peak_pricing"] == block
        assert entry["input_cost_per_token"] is not None
        assert entry["input_cost_per_token"] == builtin_info["input_cost_per_token"]
        assert entry["output_cost_per_token"] == builtin_info["output_cost_per_token"]
        for shared_key in shared_keys:
            shared_entry = derouter.model_cost.get(shared_key) or {}
            assert not shared_entry.get("off_peak_pricing")
    finally:
        _restore_model_cost_entries(original_entries)
        del router


def test_use_custom_pricing_for_model_sees_off_peak_only_model_info():
    from derouter.derouter_core_utils.derouter_logging import use_custom_pricing_for_model

    block = {"hours_utc": "00:00-00:00", "input_cost_per_token": 5e-05}
    assert use_custom_pricing_for_model({"metadata": {"model_info": {"off_peak_pricing": block}}}) is True
    assert use_custom_pricing_for_model({"metadata": {"model_info": {"off_peak_pricing": None}}}) is False
    assert use_custom_pricing_for_model({"metadata": {"model_info": {"id": "some-id"}}}) is False


def test_completion_cost_applies_off_peak_only_deployment_pricing():
    """End to end through the cost calculator: with ``custom_pricing`` set and
    a ``router_model_id`` whose entry carries only an always-on off-peak block,
    the request bills at the block's rates rather than the shared backend rate.
    """
    from derouter import Router
    from derouter.types.utils import ModelResponse, Usage

    block = {
        "hours_utc": "00:00-00:00",
        "input_cost_per_token": 5e-05,
        "output_cost_per_token": 1e-04,
    }
    shared_keys = ["gpt-4o-mini", "openai/gpt-4o-mini"]
    deployment_id = "offpeak-only-dep-2"
    original_entries = _snapshot_model_cost_entries(shared_keys + [deployment_id])

    router = Router(
        model_list=[
            {
                "model_name": "offpeak-only",
                "derouter_params": {
                    "model": "openai/gpt-4o-mini",
                    "api_key": "fake-key-for-registration",
                },
                "model_info": {"id": deployment_id, "off_peak_pricing": dict(block)},
            }
        ]
    )

    try:
        response = ModelResponse(
            model="gpt-4o-mini",
            usage=Usage(prompt_tokens=100, completion_tokens=50, total_tokens=150),
        )
        cost = derouter.completion_cost(
            completion_response=response,
            model="openai/gpt-4o-mini",
            custom_llm_provider="openai",
            custom_pricing=True,
            router_model_id=deployment_id,
        )
        assert cost == pytest.approx(100 * 5e-05 + 50 * 1e-04)
    finally:
        _restore_model_cost_entries(original_entries)
        del router
