"""
Bridge module for connecting Interactions API to Responses API via derouter.responses().
"""

from derouter.interactions.derouter_responses_transformation.handler import (
    DeRouterResponsesInteractionsHandler,
)
from derouter.interactions.derouter_responses_transformation.transformation import (
    DeRouterResponsesInteractionsConfig,
)

__all__ = [
    "DeRouterResponsesInteractionsConfig",  # Transformation config class (not BaseInteractionsAPIConfig)
    "DeRouterResponsesInteractionsHandler",
]
