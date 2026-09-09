import asyncio

import pytest

import derouter  # noqa: E402,F401

from tests._vcr_conftest_common import (  # noqa: E402,F401
    VerboseReporterState,
    _pin_multipart_boundary,
    apply_vcr_auto_marker_to_items,
    emit_cassette_cache_session_banner,
    emit_vcr_classification_summary,
    emit_vcr_diagnostic_log,
    install_live_call_probe,
    record_vcr_outcome,
    register_persister_if_enabled,
    reset_vcr_diag_dir,
    vcr_config_dict,
)

_verbose_state = VerboseReporterState()

_CALLBACK_ATTRS = (
    "callbacks",
    "success_callback",
    "failure_callback",
    "_async_success_callback",
    "_async_failure_callback",
)

_SCALAR_ATTRS = (
    "num_retries",
    "set_verbose",
    "cache",
    "allowed_fails",
    "disable_aiohttp_transport",
    "force_ipv4",
    "drop_params",
    "modify_params",
    "api_base",
    "api_key",
    "cohere_key",
)


@pytest.fixture(scope="module")
def vcr_config():
    return vcr_config_dict()


def pytest_recording_configure(config, vcr):
    register_persister_if_enabled(vcr)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)


@pytest.fixture(autouse=True)
def _vcr_outcome_gate(request, vcr):
    install_live_call_probe(request, vcr)
    yield
    record_vcr_outcome(request, vcr)


def pytest_configure(config):
    _verbose_state.remember_pluginmanager(config)
    reset_vcr_diag_dir()


def pytest_runtest_logreport(report):
    _verbose_state.maybe_emit_verdict(report)


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    emit_cassette_cache_session_banner(terminalreporter)
    emit_vcr_classification_summary(terminalreporter)
    emit_vcr_diagnostic_log(terminalreporter)


@pytest.fixture(scope="session")
def event_loop():
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
    yield loop
    loop.close()


def _copy_derouter_state():
    state = {}
    for attr in _CALLBACK_ATTRS:
        if hasattr(derouter, attr):
            value = getattr(derouter, attr)
            state[attr] = value.copy() if isinstance(value, list) else value
    for attr in _SCALAR_ATTRS:
        if hasattr(derouter, attr):
            state[attr] = getattr(derouter, attr)
    return state


def _restore_derouter_state(state) -> None:
    for attr, value in state.items():
        if hasattr(derouter, attr):
            setattr(derouter, attr, value)


def _reset_derouter_callbacks() -> None:
    for attr in _CALLBACK_ATTRS:
        if hasattr(derouter, attr):
            setattr(derouter, attr, [])
    manager = getattr(derouter, "logging_callback_manager", None)
    reset = getattr(manager, "_reset_all_callbacks", None)
    if callable(reset):
        reset()


def _clear_logging_queue(loop=None) -> None:
    from derouter.derouter_core_utils.logging_worker import GLOBAL_LOGGING_WORKER

    if loop is not None and not loop.is_closed() and not loop.is_running():
        loop.run_until_complete(GLOBAL_LOGGING_WORKER.clear_queue())
        return
    asyncio.run(GLOBAL_LOGGING_WORKER.clear_queue())


@pytest.fixture(scope="function", autouse=True)
def setup_and_teardown(event_loop):
    original_state = _copy_derouter_state()
    _clear_logging_queue(event_loop)
    _reset_derouter_callbacks()
    asyncio.set_event_loop(event_loop)

    yield

    _clear_logging_queue(event_loop)
    _reset_derouter_callbacks()
    _restore_derouter_state(original_state)

    pending = asyncio.all_tasks(event_loop)
    for task in pending:
        task.cancel()
    if pending:
        event_loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))


def pytest_collection_modifyitems(config, items):
    apply_vcr_auto_marker_to_items(items)
