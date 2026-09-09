
import pytest

import derouter
from base_audio_transcription_unit_tests import BaseLLMAudioTranscriptionTest


class TestDeepgramAudioTranscription(BaseLLMAudioTranscriptionTest):
    def get_base_audio_transcription_call_args(self) -> dict:
        return {
            "model": "deepgram/nova-2",
        }

    def get_custom_llm_provider(self) -> derouter.LlmProviders:
        return derouter.LlmProviders.DEEPGRAM
