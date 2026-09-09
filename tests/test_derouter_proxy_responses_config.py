"""
Unit test for DeRouter Proxy Responses API configuration.
"""

import pytest

from derouter.types.utils import LlmProviders
from derouter.utils import ProviderConfigManager


def test_derouter_proxy_responses_api_config():
    """Test that derouter_proxy provider returns correct Responses API config"""
    from derouter.llms.derouter_proxy.responses.transformation import (
        DeRouterProxyResponsesAPIConfig,
    )

    config = ProviderConfigManager.get_provider_responses_api_config(
        model="derouter_proxy/gpt-5.5",
        provider=LlmProviders.DEROUTER_PROXY,
    )
    print(f"config: {config}")
    assert config is not None, "Config should not be None for derouter_proxy provider"
    assert isinstance(
        config, DeRouterProxyResponsesAPIConfig
    ), f"Expected DeRouterProxyResponsesAPIConfig, got {type(config)}"
    assert (
        config.custom_llm_provider == LlmProviders.DEROUTER_PROXY
    ), "custom_llm_provider should be DEROUTER_PROXY"


def test_derouter_proxy_responses_api_config_get_complete_url():
    """Test that get_complete_url works correctly"""
    import os
    from derouter.llms.derouter_proxy.responses.transformation import (
        DeRouterProxyResponsesAPIConfig,
    )

    config = DeRouterProxyResponsesAPIConfig()

    # Test with explicit api_base
    url = config.get_complete_url(
        api_base="https://my-proxy.example.com",
        derouter_params={},
    )
    assert url == "https://my-proxy.example.com/responses"

    # Test with trailing slash
    url = config.get_complete_url(
        api_base="https://my-proxy.example.com/",
        derouter_params={},
    )
    assert url == "https://my-proxy.example.com/responses"

    # Test that it raises error when api_base is None and env var is not set
    if "DEROUTER_PROXY_API_BASE" in os.environ:
        del os.environ["DEROUTER_PROXY_API_BASE"]

    with pytest.raises(ValueError, match="api_base not set"):
        config.get_complete_url(api_base=None, derouter_params={})


def test_derouter_proxy_responses_api_config_inherits_from_openai():
    """Test that DeRouterProxyResponsesAPIConfig extends OpenAI config properly"""
    from derouter.llms.derouter_proxy.responses.transformation import (
        DeRouterProxyResponsesAPIConfig,
    )
    from derouter.llms.openai.responses.transformation import (
        OpenAIResponsesAPIConfig,
    )

    config = DeRouterProxyResponsesAPIConfig()

    # Should inherit from OpenAI config
    assert isinstance(config, OpenAIResponsesAPIConfig)

    # Should have the correct provider set
    assert config.custom_llm_provider == LlmProviders.DEROUTER_PROXY


if __name__ == "__main__":
    test_derouter_proxy_responses_api_config()
    test_derouter_proxy_responses_api_config_get_complete_url()
    test_derouter_proxy_responses_api_config_inherits_from_openai()
    print("All tests passed!")
