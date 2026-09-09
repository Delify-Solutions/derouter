from typing import Final

from derouter.llms.anthropic.chat.guardrail_translation.handler import (
    AnthropicMessagesHandler,
)
from derouter.types.utils import CallTypes

guardrail_translation_mappings: Final = {
    CallTypes.anthropic_messages: AnthropicMessagesHandler,
}

__all__ = ["guardrail_translation_mappings"]
