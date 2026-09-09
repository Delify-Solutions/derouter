import json
from datetime import datetime
from unittest.mock import AsyncMock



from base_rerank_unit_tests import BaseLLMRerankTest
import derouter


class TestJinaAI(BaseLLMRerankTest):
    def get_custom_llm_provider(self) -> derouter.LlmProviders:
        return derouter.LlmProviders.JINA_AI

    def get_base_rerank_call_args(self) -> dict:
        return {
            "model": "jina_ai/jina-reranker-v2-base-multilingual",
        }


def test_jina_ai_embedding():
    derouter.embedding(
        model="jina_ai/jina-embeddings-v3",
        input=["a"],
        task="separation",
        dimensions=1024,
    )
