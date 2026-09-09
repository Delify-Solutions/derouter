# conftest.py - IMPROVED VERSION
#
# Key changes:
# 1. Changed module reload from 'module' scope to 'function' scope for better isolation
# 2. Made cache flushing happen per-function instead of per-module
# 3. Removed manual event loop creation (let pytest-asyncio handle it)
# 4. Added proper cleanup in fixtures
# 5. Added worker-specific isolation for parallel execution

import base64
import importlib
import os
from pathlib import Path
from types import SimpleNamespace
import httpx
import pytest

import asyncio

import derouter
from derouter import router as derouter_router_module
from derouter import utils as derouter_utils_module
from derouter._logging import ALL_LOGGERS
from derouter.derouter_core_utils.cli_keyring import (
    KeyringDiscardsWrites,
    KeyringUnreachable,
    KeyringUnusable,
    SecretErase,
    SecretErased,
    SecretFound,
    SecretMissing,
    SecretRead,
    SecretStored,
    SecretStranded,
    SecretWrite,
)
from derouter.derouter_core_utils.prompt_templates import (
    image_handling as image_handling_module,
)
from derouter.llms.custom_httpx.async_client_cleanup import (
    close_derouter_async_clients,
)
from derouter.proxy.db import tool_registry_writer as tool_registry_writer_module


def _reset_module_level_aws_auth_caches():
    """
    Clear module-level AWS auth state that can survive between tests.

    Bedrock/SageMaker handlers are instantiated once at import time and cache
    resolved credentials on the handler instance. If a previous test resolves an
    invalid or different auth flow, later tests can reuse that cached state and
    bypass their local monkeypatched env setup.
    """
    for module_name in (
        "derouter.main",
        "derouter.files.main",
        "derouter.rerank_api.main",
        "derouter.realtime_api.main",
    ):
        try:
            module = importlib.import_module(module_name)
        except Exception:
            continue
        for attr_name in dir(module):
            obj = getattr(module, attr_name)
            iam_cache = getattr(obj, "iam_cache", None)
            if iam_cache is None:
                continue
            flush_cache = getattr(iam_cache, "flush_cache", None)
            if callable(flush_cache):
                flush_cache()

    try:
        import boto3

        boto3.DEFAULT_SESSION = None
    except Exception:
        pass


@pytest.fixture(scope="session")
def isolated_aws_credentials_dir(tmp_path_factory):
    aws_dir = tmp_path_factory.mktemp("aws-config")
    credentials_file = Path(aws_dir) / "credentials"
    config_file = Path(aws_dir) / "config"
    credentials_file.write_text("", encoding="utf-8")
    config_file.write_text("", encoding="utf-8")
    return {
        "credentials": str(credentials_file),
        "config": str(config_file),
    }


@pytest.fixture(scope="function", autouse=True)
def isolate_host_aws_config(monkeypatch, isolated_aws_credentials_dir):
    """Prevent botocore from reading host AWS profiles during unit tests."""
    monkeypatch.setenv(
        "AWS_SHARED_CREDENTIALS_FILE", isolated_aws_credentials_dir["credentials"]
    )
    monkeypatch.setenv("AWS_CONFIG_FILE", isolated_aws_credentials_dir["config"])
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_PROFILE", raising=False)
    monkeypatch.delenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", raising=False)
    monkeypatch.delenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", raising=False)
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("AWS_ROLE_ARN", raising=False)
    monkeypatch.delenv("AWS_WEB_IDENTITY_TOKEN_FILE", raising=False)
    monkeypatch.delenv("AWS_BEARER_TOKEN_BEDROCK", raising=False)
    monkeypatch.delenv("AWS_REGION_NAME", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)


@pytest.fixture(scope="function", autouse=True)
def isolate_host_proxy_base_url(monkeypatch):
    """Prevent a host PROXY_BASE_URL from outranking request-derived URLs during unit tests."""
    monkeypatch.delenv("PROXY_BASE_URL", raising=False)


@pytest.fixture(scope="function", autouse=True)
def isolate_host_os_keychain(monkeypatch):
    """Keep any code path that resolves a CLI credential out of the developer's real OS keychain.

    Tests that exercise keychain behaviour inject their own vault instead.
    """
    monkeypatch.setenv("DEROUTER_CLI_DISABLE_KEYRING", "1")


class FakeSecretVault:
    """In-memory stand-in for the OS keychain, injected wherever CLI credential storage is exercised.

    `available=False` models a keychain that is locked or has no backend, `writable=False` one that
    refuses to store, `erasable=False` one that will not release what it already holds, and `failure`
    picks which unusable state those report. `discards=True` is keyring's null backend, which answers
    reads and erases like any other yet keeps nothing it is given, so only writes report it.
    """

    def __init__(
        self,
        blob: str | None = None,
        *,
        available: bool = True,
        writable: bool = True,
        erasable: bool = True,
        discards: bool = False,
        failure: KeyringUnusable = KeyringUnreachable(),
    ) -> None:
        self.blob: str | None = blob
        self.available: bool = available
        self.writable: bool = writable
        self.erasable: bool = erasable
        self.discards: bool = discards
        self.failure: KeyringUnusable = failure
        self.reads: int = 0
        self.writes: list[str] = []
        self.erases: int = 0

    def read(self) -> SecretRead:
        self.reads += 1
        if not self.available:
            return self.failure
        return SecretMissing() if self.blob is None else SecretFound(self.blob)

    def write(self, blob: str) -> SecretWrite:
        self.writes.append(blob)
        if not (self.available and self.writable):
            return self.failure
        if self.discards:
            return KeyringDiscardsWrites()
        self.blob = blob
        return SecretStored()

    def erase(self) -> SecretErase:
        self.erases += 1
        if not self.available:
            return self.failure
        if not self.erasable:
            return SecretStranded() if self.blob is not None else SecretErased()
        self.blob = None
        return SecretErased()


@pytest.fixture
def secret_vault_factory():
    """Build FakeSecretVault instances; see its docstring for the failure modes it can model."""
    return FakeSecretVault


@pytest.fixture
def local_model_cost_map(monkeypatch):
    """Force the bundled in-repo cost map so capability and pricing assertions do not
    depend on the network-fetched ``main`` copy, which lags this branch until merge.

    ``get_model_info`` is lru_cached, so swapping ``model_cost`` is not enough on its
    own; clear on the way in and out so entries warmed against either map never leak
    across tests."""
    original_model_cost = derouter.model_cost
    monkeypatch.setenv("DEROUTER_LOCAL_MODEL_COST_MAP", "True")
    derouter.model_cost = derouter.get_model_cost_map(url="")
    derouter.get_model_info.cache_clear()
    try:
        yield
    finally:
        derouter.model_cost = original_model_cost
        derouter.get_model_info.cache_clear()


def _run_coroutine_if_needed(result):
    if not asyncio.iscoroutine(result):
        return

    try:
        asyncio.run(result)
    except RuntimeError:
        # If pytest-asyncio already has a running loop, best-effort scheduling is
        # still better than leaking the client entirely.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if loop.is_running():
            loop.create_task(result)
    except Exception:
        pass


def _close_handler_if_needed(handler):
    if handler is None:
        return

    close_fn = getattr(handler, "close", None)
    if not callable(close_fn):
        return

    try:
        result = close_fn()
        _run_coroutine_if_needed(result)
    except Exception:
        pass


@pytest.fixture(scope="function", autouse=True)
def isolate_derouter_state():
    """
    Per-function isolation fixture (changed from module scope).

    This ensures better isolation when running tests in parallel:
    - Each test function gets a clean derouter state
    - Cache is flushed before each test
    - No module reloading during parallel execution

    Note: Module reloading at function scope is safer for parallel execution
    but adds overhead. Consider removing reload entirely if tests can work without it.
    """
    # Get worker ID if running with pytest-xdist
    worker_id = os.environ.get("PYTEST_XDIST_WORKER", "master")

    # Store original callback state (all callback lists)
    original_state = {}
    if hasattr(derouter, "callbacks"):
        original_state["callbacks"] = (
            derouter.callbacks.copy() if derouter.callbacks else []
        )
    if hasattr(derouter, "success_callback"):
        original_state["success_callback"] = (
            derouter.success_callback.copy() if derouter.success_callback else []
        )
    if hasattr(derouter, "failure_callback"):
        original_state["failure_callback"] = (
            derouter.failure_callback.copy() if derouter.failure_callback else []
        )
    if hasattr(derouter, "input_callback"):
        original_state["input_callback"] = (
            derouter.input_callback.copy() if derouter.input_callback else []
        )
    if hasattr(derouter, "_async_success_callback"):
        original_state["_async_success_callback"] = (
            derouter._async_success_callback.copy()
            if derouter._async_success_callback
            else []
        )
    if hasattr(derouter, "_async_failure_callback"):
        original_state["_async_failure_callback"] = (
            derouter._async_failure_callback.copy()
            if derouter._async_failure_callback
            else []
        )
    if hasattr(derouter, "_async_input_callback"):
        original_state["_async_input_callback"] = (
            derouter._async_input_callback.copy()
            if derouter._async_input_callback
            else []
        )

    # Store routing globals — leaked model_fallbacks causes tests to route
    # through async_completion_with_fallbacks / Router, bypassing HTTP mocks
    if hasattr(derouter, "model_fallbacks"):
        original_state["model_fallbacks"] = derouter.model_fallbacks

    # Store transport/network globals — many tests set these without restoring,
    # causing subsequent tests to get None from _create_async_transport()
    for _attr in ("disable_aiohttp_transport", "force_ipv4"):
        if hasattr(derouter, _attr):
            original_state[_attr] = getattr(derouter, _attr)

    # Store request-mapping globals that are frequently mutated in tests.
    if hasattr(derouter, "drop_params"):
        original_state["drop_params"] = derouter.drop_params
    if hasattr(derouter, "cache"):
        original_state["cache"] = derouter.cache

    # Store secret-manager globals. Several tests swap these out, which changes
    # get_secret() behavior for later env-driven tests (for example Redis config).
    for _attr in (
        "secret_manager_client",
        "_key_management_system",
        "_key_management_settings",
    ):
        if hasattr(derouter, _attr):
            original_state[_attr] = getattr(derouter, _attr)

    # Store other commonly-mutated DeRouter globals that affect provider routing,
    # auth, and request shaping during larger suite runs.
    for _attr in (
        "api_base",
        "num_retries",
        "modify_params",
        "ssl_verify",
        "credential_list",
        "model_group_settings",
        "default_internal_user_params",
        "default_team_params",
        "prometheus_emit_stream_label",
        "vector_store_registry",
        "model_cost",
        "cost_margin_config",
        "cost_discount_config",
        "disable_hf_tokenizer_download",
        "disable_copilot_system_to_assistant",
        "cohere_models",
        "anthropic_models",
        "token_counter",
        "initialized_langfuse_clients",
    ):
        if hasattr(derouter, _attr):
            original_state[_attr] = getattr(derouter, _attr)

    original_runtime_registered_model_cost = {
        model_key: dict(model_value)
        for model_key, model_value in derouter_utils_module._runtime_registered_model_cost.items()
    }

    original_live_routers = set(derouter_router_module._live_routers)

    # Store DeRouter logger state. Some tests reconfigure handlers/propagation for
    # JSON logging and do not restore them, which breaks later caplog-based tests.
    logger_state = {}
    for logger in ALL_LOGGERS:
        logger_state[logger.name] = {
            "level": logger.level,
            "disabled": logger.disabled,
            "propagate": logger.propagate,
            "handlers": list(logger.handlers),
            "filters": list(logger.filters),
        }

    # Store singleton registries that are lazily initialized during tests and
    # can change endpoint behavior later in the suite.
    original_tool_policy_registry = tool_registry_writer_module._tool_policy_registry
    had_module_level_client = "module_level_client" in derouter.__dict__
    had_module_level_aclient = "module_level_aclient" in derouter.__dict__
    original_module_level_client = derouter.__dict__.get("module_level_client")
    original_module_level_aclient = derouter.__dict__.get("module_level_aclient")

    # Flush cache before test (critical for respx mocks)
    if hasattr(derouter, "in_memory_llm_clients_cache"):
        derouter.in_memory_llm_clients_cache.flush_cache()
    image_handling_module.in_memory_cache.flush_cache()
    _reset_module_level_aws_auth_caches()
    # derouter.get_model_info() memoizes ModelInfo built from derouter.model_cost, so a
    # test that rebinds the cost map leaves later tests pricing against the old map.
    derouter_utils_module._invalidate_model_cost_lowercase_map()

    # Clear all callback lists to prevent cross-test contamination
    if hasattr(derouter, "callbacks"):
        derouter.callbacks = []
    if hasattr(derouter, "success_callback"):
        derouter.success_callback = []
    if hasattr(derouter, "failure_callback"):
        derouter.failure_callback = []
    if hasattr(derouter, "input_callback"):
        derouter.input_callback = []
    if hasattr(derouter, "_async_success_callback"):
        derouter._async_success_callback = []
    if hasattr(derouter, "_async_failure_callback"):
        derouter._async_failure_callback = []
    if hasattr(derouter, "_async_input_callback"):
        derouter._async_input_callback = []

    # Clear routing globals
    if hasattr(derouter, "model_fallbacks"):
        derouter.model_fallbacks = None
    if hasattr(derouter, "cache"):
        derouter.cache = None
    derouter.__dict__.pop("module_level_client", None)
    derouter.__dict__.pop("module_level_aclient", None)
    tool_registry_writer_module._tool_policy_registry = None

    yield

    # Cleanup after test
    if hasattr(derouter, "in_memory_llm_clients_cache"):
        derouter.in_memory_llm_clients_cache.flush_cache()
    image_handling_module.in_memory_cache.flush_cache()
    _reset_module_level_aws_auth_caches()
    current_module_level_client = derouter.__dict__.get("module_level_client")
    current_module_level_aclient = derouter.__dict__.get("module_level_aclient")

    # Restore all callback lists to original state
    for attr_name, original_value in original_state.items():
        if hasattr(derouter, attr_name):
            setattr(derouter, attr_name, original_value)

    derouter_utils_module._runtime_registered_model_cost.clear()
    derouter_utils_module._runtime_registered_model_cost.update(original_runtime_registered_model_cost)
    derouter_utils_module._invalidate_model_cost_lowercase_map()

    for _router in tuple(derouter_router_module._live_routers):
        derouter_router_module._live_routers.discard(_router)
    for _router in original_live_routers:
        derouter_router_module._live_routers.add(_router)

    # Restore logger configuration mutated by logging-focused tests.
    for logger in ALL_LOGGERS:
        original_logger_state = logger_state.get(logger.name)
        if original_logger_state is None:
            continue
        logger.setLevel(original_logger_state["level"])
        logger.disabled = original_logger_state["disabled"]
        logger.propagate = original_logger_state["propagate"]
        logger.handlers = list(original_logger_state["handlers"])
        logger.filters = list(original_logger_state["filters"])

    tool_registry_writer_module._tool_policy_registry = original_tool_policy_registry
    if current_module_level_client is not original_module_level_client:
        _close_handler_if_needed(current_module_level_client)
    if current_module_level_aclient is not original_module_level_aclient:
        _close_handler_if_needed(current_module_level_aclient)
    if had_module_level_client:
        derouter.__dict__["module_level_client"] = original_module_level_client
    else:
        derouter.__dict__.pop("module_level_client", None)
    if had_module_level_aclient:
        derouter.__dict__["module_level_aclient"] = original_module_level_aclient
    else:
        derouter.__dict__.pop("module_level_aclient", None)


@pytest.fixture(scope="module", autouse=True)
def setup_and_teardown():
    """
    Module-scoped setup/teardown for heavy initialization.

    Use this sparingly - most state should be handled by isolate_derouter_state.
    Only reload modules here if absolutely necessary.
    """

    import derouter

    # Only reload if NOT running in parallel (module reload + parallel = bad)
    worker_id = os.environ.get("PYTEST_XDIST_WORKER", None)
    if worker_id is None:
        # Single process mode - safe to reload
        importlib.reload(derouter)

        try:
            if hasattr(derouter, "proxy") and hasattr(derouter.proxy, "proxy_server"):
                import derouter.proxy.proxy_server

                importlib.reload(derouter.proxy.proxy_server)
        except Exception as e:
            print(f"Error reloading derouter.proxy.proxy_server: {e}")

        # Flush cache after reload (prevents stale client instances)
        if hasattr(derouter, "in_memory_llm_clients_cache"):
            derouter.in_memory_llm_clients_cache.flush_cache()

    print(f"[conftest] Module setup complete (worker: {worker_id or 'master'})")

    yield

    # Teardown - no need to manually manage event loops with pytest-asyncio auto mode
    print(f"[conftest] Module teardown complete (worker: {worker_id or 'master'})")


def pytest_collection_modifyitems(config, items):
    """
    Customize test collection order.

    - Separate tests marked with 'no_parallel' from parallelizable tests
    - Sort custom_logger tests first (they tend to interfere with other tests)
    """
    # Separate no_parallel tests
    no_parallel_tests = [
        item
        for item in items
        if any(mark.name == "no_parallel" for mark in item.iter_markers())
    ]

    # Separate custom_logger tests
    custom_logger_tests = [
        item
        for item in items
        if "custom_logger" in item.parent.name and item not in no_parallel_tests
    ]

    # Everything else
    other_tests = [
        item
        for item in items
        if item not in no_parallel_tests and item not in custom_logger_tests
    ]

    # Sort each group
    custom_logger_tests.sort(key=lambda x: x.name)
    other_tests.sort(key=lambda x: x.name)
    no_parallel_tests.sort(key=lambda x: x.name)

    # Reorder: custom_logger first (isolated), then other tests, then no_parallel tests last
    items[:] = custom_logger_tests + other_tests + no_parallel_tests


def pytest_configure(config):
    """
    Configure pytest with custom settings.
    """
    # Add marker for flaky tests (for documentation purposes)
    config.addinivalue_line(
        "markers", "flaky: mark test as potentially flaky (should use --reruns)"
    )

    # Detect if running in CI
    is_ci = os.environ.get("CI") == "true" or os.environ.get("DEROUTER_CI") == "true"
    if is_ci:
        print("[conftest] Running in CI mode - enabling stricter test isolation")


# Optional: Add a fixture for tests that need even stricter isolation
@pytest.fixture
def strict_isolation():
    """
    Use this fixture for tests that need extra strict isolation.

    Example:
        def test_something(strict_isolation):
            # Test code with guaranteed clean state
            pass
    """
    # Force flush all caches
    if hasattr(derouter, "in_memory_llm_clients_cache"):
        derouter.in_memory_llm_clients_cache.flush_cache()

    # Reset all global state
    if hasattr(derouter, "disable_aiohttp_transport"):
        original_aiohttp = derouter.disable_aiohttp_transport
        derouter.disable_aiohttp_transport = False
    else:
        original_aiohttp = None

    if hasattr(derouter, "set_verbose"):
        original_verbose = derouter.set_verbose
        derouter.set_verbose = False
    else:
        original_verbose = None

    yield

    # Restore original state
    if original_aiohttp is not None:
        derouter.disable_aiohttp_transport = original_aiohttp
    if original_verbose is not None:
        derouter.set_verbose = original_verbose

    # Final cache flush
    if hasattr(derouter, "in_memory_llm_clients_cache"):
        derouter.in_memory_llm_clients_cache.flush_cache()


def pytest_sessionfinish(session, exitstatus):
    """Close any globally cached HTTP clients so xdist workers exit cleanly."""
    _close_handler_if_needed(derouter.__dict__.get("module_level_client"))
    _close_handler_if_needed(derouter.__dict__.get("module_level_aclient"))
    derouter.__dict__.pop("module_level_client", None)
    derouter.__dict__.pop("module_level_aclient", None)
    _close_handler_if_needed(getattr(derouter, "base_llm_aiohttp_handler", None))
    _close_handler_if_needed(getattr(derouter, "httpx_client", None))
    _close_handler_if_needed(getattr(derouter, "aclient", None))
    _close_handler_if_needed(getattr(derouter, "client", None))
    _run_coroutine_if_needed(close_derouter_async_clients())


ONE_PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


@pytest.fixture
def async_only_image_fetch(monkeypatch):
    from derouter.derouter_core_utils.prompt_templates import factory, image_handling
    from derouter.llms.gemini.chat import transformation as gemini_chat_transformation

    fetch = SimpleNamespace(
        fetched=[],
        base64_png=base64.b64encode(ONE_PIXEL_PNG).decode(),
        data_url="data:image/png;base64," + base64.b64encode(ONE_PIXEL_PNG).decode(),
    )

    def forbid_sync_fetch(client, url, **kwargs):
        raise derouter.ImageFetchError(f"sync image fetch ran on the event loop: {url}")

    async def serve_png(client, url, **kwargs):
        fetch.fetched.append(url)
        return httpx.Response(
            200,
            content=ONE_PIXEL_PNG,
            headers={"content-type": "image/png"},
            request=httpx.Request("GET", url),
        )

    def forbid_sync_convert(url, *args, **kwargs):
        if url.startswith(("http://", "https://")):
            raise derouter.ImageFetchError(f"sync convert_url_to_base64 ran on the request path: {url}")
        return url

    monkeypatch.setattr(image_handling, "safe_get", forbid_sync_fetch)
    monkeypatch.setattr(image_handling, "async_safe_get", serve_png)
    for module in (image_handling, factory, gemini_chat_transformation):
        monkeypatch.setattr(module, "convert_url_to_base64", forbid_sync_convert)
    return fetch
