"""
DeRouter Skills Hook - Proxy integration for skills

This module provides the CustomLogger hook for skills processing.
The actual skill logic is in derouter/llms/derouter_proxy/skills/.

Usage:
    from derouter.proxy.hooks.derouter_skills import SkillsInjectionHook

    # Register hook in proxy
    derouter.callbacks.append(SkillsInjectionHook())
"""

# Re-export from the SDK location for convenience
from derouter.llms.derouter_proxy.skills import (
    DEROUTER_CODE_EXECUTION_TOOL,
    CodeExecutionHandler,
    DeRouterInternalTools,
    SkillPromptInjectionHandler,
    SkillsSandboxExecutor,
    code_execution_handler,
    get_derouter_code_execution_tool,
)
from derouter.proxy.hooks.derouter_skills.main import SkillsInjectionHook

__all__ = [
    "DEROUTER_CODE_EXECUTION_TOOL",
    "CodeExecutionHandler",
    "DeRouterInternalTools",
    "SkillPromptInjectionHandler",
    "SkillsInjectionHook",
    "SkillsSandboxExecutor",
    "code_execution_handler",
    "get_derouter_code_execution_tool",
]
