"""
WebSearch Interception Module

Provides server-side WebSearch tool execution for models that don't natively
support server-side tool calling (e.g., Bedrock/Claude).
"""

from derouter.integrations.websearch_interception.handler import (
    WebSearchInterceptionLogger,
)
from derouter.integrations.websearch_interception.tools import (
    get_derouter_web_search_tool,
    is_web_search_tool,
)

__all__ = [
    "WebSearchInterceptionLogger",
    "get_derouter_web_search_tool",
    "is_web_search_tool",
]
