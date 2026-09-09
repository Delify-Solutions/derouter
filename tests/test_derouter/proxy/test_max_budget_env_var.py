"""
Test that max_budget from environment variable (string) is correctly
converted to float.
GitHub Issue: #23843
"""

from unittest.mock import patch

import pytest

import derouter


@pytest.mark.asyncio
async def test_max_budget_string_converted_to_float():
    """
    When max_budget is set via os.environ/MAX_BUDGET, it arrives as a
    string. initialize() should convert it to float so the comparison
    `derouter.max_budget > 0` doesn't raise TypeError.
    """
    with (
        patch("derouter.proxy.common_utils.banner.show_banner"),
        patch("derouter.proxy.proxy_server.generate_feedback_box"),
    ):
        from derouter.proxy.proxy_server import initialize

        original = derouter.max_budget
        try:
            await initialize(max_budget="100.5")
            assert isinstance(derouter.max_budget, float)
            assert derouter.max_budget == 100.5
        finally:
            derouter.max_budget = original


@pytest.mark.asyncio
async def test_max_budget_float_stays_float():
    """max_budget as float should still work."""
    with (
        patch("derouter.proxy.common_utils.banner.show_banner"),
        patch("derouter.proxy.proxy_server.generate_feedback_box"),
    ):
        from derouter.proxy.proxy_server import initialize

        original = derouter.max_budget
        try:
            await initialize(max_budget=200.0)
            assert isinstance(derouter.max_budget, float)
            assert derouter.max_budget == 200.0
        finally:
            derouter.max_budget = original
