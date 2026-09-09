"""OpenAI Text Completion handler for Unified Guardrails."""

from typing import Final

from derouter.llms.openai.completion.guardrail_translation.handler import (
    OpenAITextCompletionHandler,
)
from derouter.types.utils import CallTypes

guardrail_translation_mappings: Final = {
    CallTypes.text_completion: OpenAITextCompletionHandler,
    CallTypes.atext_completion: OpenAITextCompletionHandler,
}

__all__ = ["OpenAITextCompletionHandler", "guardrail_translation_mappings"]
