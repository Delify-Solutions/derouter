"""
Bedrock AgentCore A2A provider configuration.
"""

from collections.abc import AsyncIterator
from typing import Any, Final

from derouter.a2a_protocol.providers.base import BaseA2AProviderConfig
from derouter.a2a_protocol.providers.bedrock_agentcore.handler import (
    BedrockAgentCoreA2AHandler,
)


class BedrockAgentCoreA2AConfig(BaseA2AProviderConfig):
    """
    Provider configuration for Bedrock AgentCore A2A-native agents.

    AgentCore agents that speak A2A natively expect the full JSON-RPC envelope.
    This config bypasses the completion bridge and forwards requests directly,
    deriving the endpoint URL from the model ARN and signing with SigV4/JWT.
    """

    async def handle_non_streaming(
        self,
        request_id: str,
        params: dict[str, Any],
        api_base: str | None = None,
        **kwargs,
    ) -> dict[str, Any]:
        """Handle non-streaming request to AgentCore A2A agent."""
        derouter_params: Final = kwargs.get("derouter_params")
        if not derouter_params:
            raise ValueError(
                "derouter_params is required for BedrockAgentCoreA2AConfig (must contain model with AgentCore ARN)"
            )
        return await BedrockAgentCoreA2AHandler.handle_non_streaming(
            request_id=request_id,
            params=params,
            derouter_params=derouter_params,
            agent_extra_headers=kwargs.get("agent_extra_headers"),
        )

    async def handle_streaming(
        self,
        request_id: str,
        params: dict[str, Any],
        api_base: str | None = None,
        **kwargs,
    ) -> AsyncIterator[dict[str, Any]]:
        """Handle streaming request to AgentCore A2A agent."""
        derouter_params: Final = kwargs.get("derouter_params")
        if not derouter_params:
            raise ValueError(
                "derouter_params is required for BedrockAgentCoreA2AConfig (must contain model with AgentCore ARN)"
            )
        async for chunk in BedrockAgentCoreA2AHandler.handle_streaming(
            request_id=request_id,
            params=params,
            derouter_params=derouter_params,
            agent_extra_headers=kwargs.get("agent_extra_headers"),
        ):
            yield chunk
