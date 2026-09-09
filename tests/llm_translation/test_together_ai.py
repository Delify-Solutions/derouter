"""
Test TogetherAI LLM
"""

from base_llm_unit_tests import BaseLLMChatTest
import json
import os
from datetime import datetime
from unittest.mock import AsyncMock


import derouter
import pytest


class TestTogetherAI(BaseLLMChatTest):
    def get_base_completion_call_args(self) -> dict:
        derouter.set_verbose = True
        return {"model": "together_ai/openai/gpt-oss-20b"}

    def test_tool_call_no_arguments(self, tool_call_no_arguments):
        """Test that tool calls with no arguments is translated correctly. Relevant issue: https://github.com/Delify-Solutions/derouter/issues/6833"""
        pass

    @pytest.mark.parametrize(
        "model",
        [
            "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
            "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        ],
    )
    def test_get_supported_response_format_together_ai(self, model: str) -> None:
        os.environ["DEROUTER_LOCAL_MODEL_COST_MAP"] = "True"
        derouter.model_cost = derouter.get_model_cost_map(url="")
        optional_params = derouter.get_supported_openai_params(
            model, custom_llm_provider="together_ai"
        )
        assert isinstance(optional_params, list)
        assert "response_format" in optional_params
        assert "tools" in optional_params
