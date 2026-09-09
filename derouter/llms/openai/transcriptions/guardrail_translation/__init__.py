"""OpenAI Audio Transcription handler for Unified Guardrails."""

from typing import Final

from derouter.llms.openai.transcriptions.guardrail_translation.handler import (
    OpenAIAudioTranscriptionHandler,
)
from derouter.types.utils import CallTypes

guardrail_translation_mappings: Final = {
    CallTypes.transcription: OpenAIAudioTranscriptionHandler,
    CallTypes.atranscription: OpenAIAudioTranscriptionHandler,
}

__all__ = ["OpenAIAudioTranscriptionHandler", "guardrail_translation_mappings"]
