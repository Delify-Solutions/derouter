"""
Regression test for _sync_guardrail_info_to_logging_obj.

Ensures that when the @log_guardrail_information decorator writes guardrail info
to request_data["derouter_metadata"] (as it does for /v1/messages passthrough
routes that have no "metadata" key), the helper propagates it into
logging_obj.derouter_params["metadata"] so merge_derouter_metadata surfaces it in
spend logs.
"""

import pytest
from derouter.integrations.custom_guardrail import _sync_guardrail_info_to_logging_obj


def _make_slg_entry(name: str = "headroom-test") -> dict:
    return {
        "guardrail_name": name,
        "guardrail_response": "mask",
        "guardrail_status": "success",
        "duration": 0.1,
    }


class _FakeLogging:
    """Minimal stand-in for derouter.derouter_core_utils.derouter_logging.Logging."""

    def __init__(self, lp_metadata: dict | None = None):
        self.derouter_params: dict = {"metadata": lp_metadata or {}}
        self.model_call_details: dict = {"derouter_params": self.derouter_params}


def test_syncs_from_derouter_metadata_key():
    """When guardrail info is in request_data["derouter_metadata"], it is copied."""
    entry = _make_slg_entry()
    request_data = {
        "derouter_metadata": {"standard_logging_guardrail_information": [entry]}
    }
    logging_obj = _FakeLogging()

    _sync_guardrail_info_to_logging_obj(request_data, logging_obj)

    result = logging_obj.derouter_params["metadata"].get(
        "standard_logging_guardrail_information"
    )
    assert result == [entry]


def test_syncs_from_metadata_key():
    """When guardrail info is in request_data["metadata"], it is also copied."""
    entry = _make_slg_entry()
    request_data = {"metadata": {"standard_logging_guardrail_information": [entry]}}
    logging_obj = _FakeLogging()

    _sync_guardrail_info_to_logging_obj(request_data, logging_obj)

    result = logging_obj.derouter_params["metadata"].get(
        "standard_logging_guardrail_information"
    )
    assert result == [entry]


def test_derouter_metadata_wins_over_caller_metadata():
    """When both keys are present the helper must read the bucket the writer used,
    which get_or_create_metadata_bucket resolves to derouter_metadata. Reading the
    caller's metadata instead is how a guardrail entry went missing from spend logs
    on the routes that seed derouter_metadata."""
    entry_meta = _make_slg_entry("from-metadata")
    entry_lm = _make_slg_entry("from-derouter_metadata")
    request_data = {
        "metadata": {"standard_logging_guardrail_information": [entry_meta]},
        "derouter_metadata": {"standard_logging_guardrail_information": [entry_lm]},
    }
    logging_obj = _FakeLogging()

    _sync_guardrail_info_to_logging_obj(request_data, logging_obj)

    result = logging_obj.derouter_params["metadata"].get(
        "standard_logging_guardrail_information"
    )
    assert result == [entry_lm]


def test_syncs_when_caller_sends_its_own_metadata():
    """The Claude Code shape: caller metadata present, guardrail entry in the seeded
    derouter_metadata bucket. The entry must still reach the spend-log payload."""
    entry = _make_slg_entry()
    request_data = {
        "metadata": {"user_id": "device-account-session"},
        "derouter_metadata": {"standard_logging_guardrail_information": [entry]},
    }
    logging_obj = _FakeLogging()

    _sync_guardrail_info_to_logging_obj(request_data, logging_obj)

    result = logging_obj.derouter_params["metadata"].get(
        "standard_logging_guardrail_information"
    )
    assert result == [entry]


def test_noop_when_no_guardrail_info():
    """Does nothing when standard_logging_guardrail_information is absent."""
    request_data = {"derouter_metadata": {"other_key": "value"}}
    logging_obj = _FakeLogging()

    _sync_guardrail_info_to_logging_obj(request_data, logging_obj)

    assert (
        logging_obj.derouter_params["metadata"].get(
            "standard_logging_guardrail_information"
        )
        is None
    )


def test_noop_when_logging_obj_is_none():
    """Does nothing when logging_obj is None."""
    entry = _make_slg_entry()
    request_data = {
        "derouter_metadata": {"standard_logging_guardrail_information": [entry]}
    }
    _sync_guardrail_info_to_logging_obj(request_data, None)


def test_writes_to_model_call_details_too():
    """Also writes into model_call_details["derouter_params"]["metadata"]."""
    entry = _make_slg_entry()
    request_data = {
        "derouter_metadata": {"standard_logging_guardrail_information": [entry]}
    }

    logging_obj = _FakeLogging()
    # Simulate derouter_params reassignment (creating a new dict) — model_call_details
    # then points to the OLD dict while derouter_params points to the new one.
    old_lp = logging_obj.derouter_params
    logging_obj.derouter_params = {**old_lp, "extra": "added"}
    logging_obj.model_call_details["derouter_params"] = old_lp  # diverged

    _sync_guardrail_info_to_logging_obj(request_data, logging_obj)

    # Both dicts should have the info.
    assert logging_obj.derouter_params["metadata"].get(
        "standard_logging_guardrail_information"
    ) == [entry]
    assert old_lp["metadata"].get("standard_logging_guardrail_information") == [entry]
