"""
Test for preset_cache_key multiple values bug fix.

This test verifies that get_cache_key doesn't raise TypeError when kwargs
already contains preset_cache_key.

Issue: When get_cache_key(**kwargs) is called with kwargs containing 
preset_cache_key, the call to _set_preset_cache_key_in_kwargs() would fail with:
    TypeError: got multiple values for keyword argument 'preset_cache_key'
"""

import pytest
from unittest.mock import MagicMock, patch


class TestPresetCacheKeyFix:
    """Tests for the preset_cache_key multiple values fix."""

    def test_get_cache_key_with_preset_cache_key_in_kwargs(self):
        """
        Test that get_cache_key handles kwargs that already contain preset_cache_key.

        This was causing:
        TypeError: _set_preset_cache_key_in_kwargs() got multiple values
        for keyword argument 'preset_cache_key'
        """
        from derouter.caching.caching import Cache

        cache = Cache()

        # Simulate kwargs that already has preset_cache_key (as can happen
        # when the cache key is recomputed in certain code paths)
        kwargs_with_preset = {
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "Hello"}],
            "preset_cache_key": "existing_key_12345",  # This caused the bug
            "derouter_params": {},
        }

        # This should NOT raise TypeError
        try:
            result = cache.get_cache_key(**kwargs_with_preset)
            assert result is not None
            assert isinstance(result, str)
        except TypeError as e:
            if "multiple values for keyword argument" in str(e):
                pytest.fail(f"Bug not fixed: {e}")
            raise

    def test_get_cache_key_without_preset_cache_key(self):
        """Test normal case without preset_cache_key in kwargs still works."""
        from derouter.caching.caching import Cache

        cache = Cache()

        kwargs_normal = {
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "Hello"}],
            "derouter_params": {},
        }

        result = cache.get_cache_key(**kwargs_normal)
        assert result is not None
        assert isinstance(result, str)

    def test_preset_cache_key_is_set_in_derouter_params(self):
        """Verify that preset_cache_key is correctly set in derouter_params."""
        from derouter.caching.caching import Cache

        cache = Cache()

        derouter_params = {}
        kwargs = {
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "Hello"}],
            "derouter_params": derouter_params,
        }

        result = cache.get_cache_key(**kwargs)

        # The method should set preset_cache_key in derouter_params
        assert "preset_cache_key" in derouter_params
        assert derouter_params["preset_cache_key"] == result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
