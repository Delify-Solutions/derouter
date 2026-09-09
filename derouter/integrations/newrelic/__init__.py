"""
New Relic AI Monitoring Integration for DeRouter

This module provides integration with New Relic's AI Monitoring feature to track
LLM requests, responses, and usage metrics.
"""

from derouter.integrations.newrelic.newrelic import NewRelicLogger

__all__ = ["NewRelicLogger"]
