"""
A2A to DeRouter Completion Bridge.

This module provides transformation between A2A protocol messages and
DeRouter completion API, enabling any DeRouter-supported provider to be
invoked via the A2A protocol.
"""

from derouter.a2a_protocol.derouter_completion_bridge.handler import (
    A2ACompletionBridgeHandler,
    handle_a2a_completion,
    handle_a2a_completion_streaming,
)
from derouter.a2a_protocol.derouter_completion_bridge.transformation import (
    A2ACompletionBridgeTransformation,
)

__all__ = [
    "A2ACompletionBridgeHandler",
    "A2ACompletionBridgeTransformation",
    "handle_a2a_completion",
    "handle_a2a_completion_streaming",
]
