"""
DeRouter Search API module.
"""

from derouter.search.cost_calculator import search_provider_cost_per_query
from derouter.search.main import asearch, search

__all__ = ["asearch", "search", "search_provider_cost_per_query"]
