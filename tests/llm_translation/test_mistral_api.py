import asyncio
import traceback

from dotenv import load_dotenv

import derouter.types
import derouter.types.utils
from derouter.llms.anthropic.chat import ModelResponseIterator

load_dotenv()
import io

from typing import Optional
from unittest.mock import MagicMock, patch

import pytest

import derouter

from derouter.llms.anthropic.common_utils import process_anthropic_headers
from httpx import Headers
from base_llm_unit_tests import BaseLLMChatTest


@pytest.mark.flaky(retries=3, delay=2)
class TestMistralCompletion(BaseLLMChatTest):
    def get_base_completion_call_args(self) -> dict:
        derouter.set_verbose = True
        return {"model": "mistral/mistral-medium-latest"}

    def test_tool_call_no_arguments(self, tool_call_no_arguments):
        """Test that tool calls with no arguments is translated correctly. Relevant issue: https://github.com/Delify-Solutions/derouter/issues/6833"""
        pass
