"""
DeRouter Search API Types

This module defines types for the unified search API across different providers.
"""

from typing_extensions import Required, TypedDict

from derouter.types.utils import SearchProviders

# Re-export SearchProviders as SearchProvider for backwards compatibility
SearchProvider = SearchProviders

__all__ = ["SearchProvider", "SearchProviders"]


class SearchToolDeRouterParams(TypedDict, total=False):
    """
    DeRouter params for search tools configuration.
    """

    search_provider: Required[str]
    api_key: str | None
    api_base: str | None
    timeout: float | None
    max_retries: int | None


class SearchTool(TypedDict, total=False):
    """
    Search tool configuration.

    Example:
        {
            "search_tool_id": "123e4567-e89b-12d3-a456-426614174000",
            "search_tool_name": "derouter-search",
            "derouter_params": {
                "search_provider": "perplexity",
                "api_key": "sk-..."
            },
            "search_tool_info": {
                "description": "Perplexity search tool"
            }
        }
    """

    search_tool_id: str | None
    search_tool_name: Required[str]
    derouter_params: Required[SearchToolDeRouterParams]
    search_tool_info: dict | None
    created_at: str | None
    updated_at: str | None


class SearchToolInfoResponse(TypedDict, total=False):
    """Response model for search tool information."""

    search_tool_id: str | None
    search_tool_name: str
    derouter_params: dict
    search_tool_info: dict | None
    created_at: str | None
    updated_at: str | None
    is_from_config: bool | None  # True if this tool is defined in config file, False if from DB


class ListSearchToolsResponse(TypedDict):
    """Response model for listing search tools."""

    search_tools: list[SearchToolInfoResponse]


class AvailableSearchProvider(TypedDict):
    """Information about an available search provider."""

    provider_name: str
    ui_friendly_name: str
