"""Unit tests for DeRouterAgentModelResolver - derouter_agent/ prefix model resolution."""

from unittest.mock import MagicMock

import pytest

from derouter.integrations.derouter_agent import DeRouterAgentModelResolver


class TestDeRouterAgentModelResolver:
    def test_get_chat_completion_prompt_strips_prefix(self):
        """Verify get_chat_completion_prompt strips derouter_agent/ prefix from model."""
        resolver = DeRouterAgentModelResolver()
        messages = [{"role": "user", "content": "Hello"}]

        resolved_model, out_messages, out_params = resolver.get_chat_completion_prompt(
            model="derouter_agent/gpt-3.5-turbo",
            messages=messages,
            non_default_params={},
            prompt_id=None,
            prompt_variables=None,
            dynamic_callback_params={},
        )

        assert resolved_model == "gpt-3.5-turbo"
        assert out_messages == messages
        assert out_params == {}

    def test_get_chat_completion_prompt_preserves_rest_of_model(self):
        """Verify model name after prefix is preserved (e.g. openai/gpt-3.5-turbo)."""
        resolver = DeRouterAgentModelResolver()
        messages = [{"role": "user", "content": "Test"}]

        resolved_model, _, _ = resolver.get_chat_completion_prompt(
            model="derouter_agent/openai/gpt-3.5-turbo",
            messages=messages,
            non_default_params={},
            prompt_id=None,
            prompt_variables=None,
            dynamic_callback_params={},
        )

        assert resolved_model == "openai/gpt-3.5-turbo"

    def test_get_chat_completion_prompt_respects_ignore_prompt_manager_model(self):
        """Verify model is unchanged when ignore_prompt_manager_model is True."""
        resolver = DeRouterAgentModelResolver()
        messages = [{"role": "user", "content": "Hello"}]

        resolved_model, _, _ = resolver.get_chat_completion_prompt(
            model="derouter_agent/gpt-3.5-turbo",
            messages=messages,
            non_default_params={},
            prompt_id=None,
            prompt_variables=None,
            dynamic_callback_params={},
            ignore_prompt_manager_model=True,
        )

        assert resolved_model == "derouter_agent/gpt-3.5-turbo"

    @pytest.mark.asyncio
    async def test_async_get_chat_completion_prompt_strips_prefix(self):
        """Verify async_get_chat_completion_prompt strips prefix."""
        resolver = DeRouterAgentModelResolver()
        messages = [{"role": "user", "content": "Hello"}]

        resolved_model, out_messages, _ = (
            await resolver.async_get_chat_completion_prompt(
                model="derouter_agent/gpt-3.5-turbo",
                messages=messages,
                non_default_params={},
                prompt_id=None,
                prompt_variables=None,
                dynamic_callback_params={},
                derouter_logging_obj=MagicMock(),
            )
        )

        assert resolved_model == "gpt-3.5-turbo"
        assert out_messages == messages
