"""
Tests for per-request enable_json_schema_validation parameter.

Ensures the per-request flag overrides the global derouter.enable_json_schema_validation,
making JSON schema validation thread-safe for concurrent usage.

Related issue: https://github.com/Delify-Solutions/derouter/issues/XXXX
"""

import json

import pytest

import derouter
from derouter.types.utils import ModelResponse
from derouter.utils import Rules, post_call_processing


def _make_response(content: dict) -> ModelResponse:
    """Create a ModelResponse with the given content as JSON string."""
    response = ModelResponse()
    response.choices[0].message.content = json.dumps(content)
    return response


def _mock_completion():
    """Mock function with __name__ == 'completion' for post_call_processing."""
    pass


_mock_completion.__name__ = "completion"

# Schema that requires 'title' (string) and 'rating' (integer)
STRICT_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "MovieReview",
        "schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "rating": {"type": "integer"},
            },
            "required": ["title", "rating"],
        },
    },
}

INVALID_CONTENT = {"name": "test", "age": 25}  # Does NOT match the schema
VALID_CONTENT = {"title": "Inception", "rating": 9}  # Matches the schema


@pytest.fixture(autouse=True)
def _reset_global_flag():
    """Reset the global flag before and after each test."""
    original = derouter.enable_json_schema_validation
    derouter.enable_json_schema_validation = False
    yield
    derouter.enable_json_schema_validation = original


class TestPerRequestJsonSchemaValidation:
    """Test that per-request enable_json_schema_validation overrides the global flag."""

    def test_global_off_no_per_request_skips_validation(self):
        """Global OFF + no per-request flag -> no validation (default behavior)."""
        derouter.enable_json_schema_validation = False
        # Should NOT raise even though response doesn't match schema
        post_call_processing(
            _make_response(INVALID_CONTENT),
            "test-model",
            {"response_format": STRICT_SCHEMA},
            _mock_completion,
            Rules(),
        )

    def test_per_request_on_overrides_global_off(self):
        """Global OFF + per-request ON -> validation runs and catches invalid response."""
        derouter.enable_json_schema_validation = False
        with pytest.raises(derouter.JSONSchemaValidationError):
            post_call_processing(
                _make_response(INVALID_CONTENT),
                "test-model",
                {
                    "response_format": STRICT_SCHEMA,
                    "enable_json_schema_validation": True,
                },
                _mock_completion,
                Rules(),
            )

    def test_per_request_off_overrides_global_on(self):
        """Global ON + per-request OFF -> validation skipped (per-request wins)."""
        derouter.enable_json_schema_validation = True
        # Should NOT raise because per-request says False
        post_call_processing(
            _make_response(INVALID_CONTENT),
            "test-model",
            {
                "response_format": STRICT_SCHEMA,
                "enable_json_schema_validation": False,
            },
            _mock_completion,
            Rules(),
        )

    def test_global_on_no_per_request_validates(self):
        """Global ON + no per-request flag -> validation runs (backward compatible)."""
        derouter.enable_json_schema_validation = True
        with pytest.raises(derouter.JSONSchemaValidationError):
            post_call_processing(
                _make_response(INVALID_CONTENT),
                "test-model",
                {"response_format": STRICT_SCHEMA},
                _mock_completion,
                Rules(),
            )

    def test_valid_response_passes_with_per_request_on(self):
        """Per-request ON + valid response -> no error raised."""
        post_call_processing(
            _make_response(VALID_CONTENT),
            "test-model",
            {
                "response_format": STRICT_SCHEMA,
                "enable_json_schema_validation": True,
            },
            _mock_completion,
            Rules(),
        )

    def test_per_request_flag_is_in_all_derouter_params(self):
        """Ensure the param is registered so it doesn't leak to provider APIs."""
        from derouter.types.utils import all_derouter_params

        assert "enable_json_schema_validation" in all_derouter_params
