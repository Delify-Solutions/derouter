from typing import Optional
from unittest.mock import patch

import pytest

import derouter
from derouter.llms.derouter_proxy.chat.transformation import DeRouterProxyChatConfig


def test_derouter_proxy_chat_transformation():
    """
    Assert messages are not transformed when calling derouter proxy
    """
    config = DeRouterProxyChatConfig()
    file_content = [
        {"type": "text", "text": "What is this document about?"},
        {
            "type": "file",
            "file": {
                "file_id": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
                "format": "application/pdf",
            },
        },
    ]
    messages = [{"role": "user", "content": file_content}]
    assert config.transform_request(
        model="model",
        messages=messages,
        optional_params={},
        derouter_params={},
        headers={},
    ) == {"model": "model", "messages": messages}


def test_derouter_gateway_from_sdk_with_user_param():
    from derouter.llms.derouter_proxy.chat.transformation import DeRouterProxyChatConfig

    supported_params = DeRouterProxyChatConfig().get_supported_openai_params(
        "openai/gpt-4o"
    )
    print(f"supported_params: {supported_params}")
    assert "user" in supported_params
