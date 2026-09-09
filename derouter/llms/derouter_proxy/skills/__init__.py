"""
DeRouter Proxy Skills - Database-backed skills storage and execution

This module provides:
- Database-backed skills storage (alternative to Anthropic's cloud-based skills API)
- Skill content extraction and prompt injection
- Sandboxed code execution for skills
- Automatic code execution handler

Main components:
- handler.py: DeRouterSkillsHandler - database CRUD operations
- transformation.py: DeRouterSkillsTransformationHandler - SDK transformation layer
- prompt_injection.py: SkillPromptInjectionHandler - SKILL.md extraction and injection
- sandbox_executor.py: SkillsSandboxExecutor - Docker sandbox execution
- code_execution.py: CodeExecutionHandler - automatic agentic loop
"""

from derouter.llms.derouter_proxy.skills.code_execution import (
    DEROUTER_CODE_EXECUTION_TOOL,
    CodeExecutionHandler,
    DeRouterInternalTools,
    add_code_execution_tool,
    code_execution_handler,
    get_derouter_code_execution_tool,
    has_code_execution_tool,
)
from derouter.llms.derouter_proxy.skills.constants import (
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_SANDBOX_TIMEOUT,
)
from derouter.llms.derouter_proxy.skills.handler import DeRouterSkillsHandler
from derouter.llms.derouter_proxy.skills.prompt_injection import (
    SkillPromptInjectionHandler,
)
from derouter.llms.derouter_proxy.skills.sandbox_executor import SkillsSandboxExecutor
from derouter.llms.derouter_proxy.skills.transformation import (
    DeRouterSkillsTransformationHandler,
)

__all__ = [
    "DEFAULT_MAX_ITERATIONS",
    "DEFAULT_SANDBOX_TIMEOUT",
    "DEROUTER_CODE_EXECUTION_TOOL",
    "CodeExecutionHandler",
    "DeRouterInternalTools",
    "DeRouterSkillsHandler",
    "DeRouterSkillsTransformationHandler",
    "SkillPromptInjectionHandler",
    "SkillsSandboxExecutor",
    "add_code_execution_tool",
    "code_execution_handler",
    "get_derouter_code_execution_tool",
    "has_code_execution_tool",
]
