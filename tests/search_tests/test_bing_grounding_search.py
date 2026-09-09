"""
Tests for the Grounding with Bing Search (Microsoft Foundry) integration.
"""

import json
from unittest.mock import AsyncMock, Mock, patch

import pytest

import derouter
from tests.search_tests.base_search_unit_tests import BaseSearchTest

PROJECT_ENDPOINT = "https://acct.services.ai.azure.com/api/projects/proj"

_ANSWER_TEXT = (
    "DeRouter is an open source LLM gateway ([github.com](https://github.com/Delify-Solutions/derouter))\n"
    "The docs live on router.delify.vn ([router.delify.vn](https://router.delify.vn/))"
)


def _annotation(marker: str, url: str, title: str) -> dict:
    start = _ANSWER_TEXT.index(marker)
    return {
        "type": "url_citation",
        "url": url,
        "title": title,
        "start_index": start,
        "end_index": start + len(marker),
    }


MOCK_BING_GROUNDING_RESPONSE = {
    "id": "resp_mock",
    "object": "response",
    "status": "completed",
    "model": "gpt-4.1",
    "output": [
        {"type": "web_search_call", "status": "completed"},
        {
            "type": "message",
            "role": "assistant",
            "content": [
                {
                    "type": "output_text",
                    "text": _ANSWER_TEXT,
                    "annotations": [
                        _annotation(
                            "([github.com](https://github.com/Delify-Solutions/derouter))",
                            "https://github.com/Delify-Solutions/derouter",
                            "Delify-Solutions/derouter - GitHub",
                        ),
                        _annotation(
                            "([router.delify.vn](https://router.delify.vn/))",
                            "https://router.delify.vn/",
                            "DeRouter Docs",
                        ),
                    ],
                }
            ],
        },
    ],
    "usage": {"input_tokens": 100, "output_tokens": 50},
}


def _mock_response():
    response = Mock()
    response.status_code = 200
    response.headers = {}
    response.content = json.dumps(MOCK_BING_GROUNDING_RESPONSE).encode()
    return response


@pytest.mark.skip(reason="Local only tested search providers")
class TestBingGroundingSearch(BaseSearchTest):
    """
    E2E tests for Grounding with Bing Search that make real API calls.
    Inherits from BaseSearchTest to run standard search tests.
    """

    def get_search_provider(self) -> str:
        return "bing_grounding"


class TestBingGroundingSearchTransformation:
    """
    Full-stack tests through `derouter.search` / `derouter.asearch` with the HTTP layer mocked.
    Transformation details are unit-tested in tests/test_derouter/llms/azure/search/.
    """

    @pytest.fixture(autouse=True)
    def _server_env(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("BING_GROUNDING_PROJECT_ENDPOINT", PROJECT_ENDPOINT)
        monkeypatch.setenv("BING_GROUNDING_MODEL", "gpt-4.1")
        monkeypatch.setenv("BING_GROUNDING_TOKEN", "test-entra-token")
        monkeypatch.delenv("BING_GROUNDING_CONNECTION_ID", raising=False)

    def test_bing_grounding_search_request_and_response(self):
        with patch(  # test-quality-ok: derouter.search has no client injection seam
            "derouter.llms.custom_httpx.http_handler.HTTPHandler.post",
            return_value=_mock_response(),
        ) as mock_post:
            response = derouter.search(
                query="what is derouter",
                search_provider="bing_grounding",
                max_results=5,
                country="us",
            )

        assert mock_post.called
        call_kwargs = mock_post.call_args.kwargs
        assert call_kwargs["url"] == f"{PROJECT_ENDPOINT}/openai/v1/responses"
        assert call_kwargs["headers"]["Authorization"] == "Bearer test-entra-token"

        request_body = call_kwargs["json"]
        assert request_body["model"] == "gpt-4.1"
        assert request_body["input"] == "what is derouter"
        assert request_body["tools"] == [
            {"type": "web_search", "user_location": {"type": "approximate", "country": "US"}}
        ]

        assert response.object == "search"
        assert len(response.results) == 2
        assert response.results[0].url == "https://github.com/Delify-Solutions/derouter"
        assert response.results[0].title == "Delify-Solutions/derouter - GitHub"
        assert response.results[0].snippet == "DeRouter is an open source LLM gateway"
        assert response.results[1].url == "https://router.delify.vn/"
        assert response.results[1].snippet == "The docs live on router.delify.vn"

    def test_connection_mode_sends_the_bing_grounding_tool(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv(
            "BING_GROUNDING_CONNECTION_ID",
            "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices"
            "/accounts/acct/projects/proj/connections/bing-conn",
        )
        with patch(  # test-quality-ok: derouter.search has no client injection seam
            "derouter.llms.custom_httpx.http_handler.HTTPHandler.post",
            return_value=_mock_response(),
        ) as mock_post:
            derouter.search(
                query="what is derouter",
                search_provider="bing_grounding",
                max_results=3,
            )

        request_body = mock_post.call_args.kwargs["json"]
        assert request_body["tools"] == [
            {
                "type": "bing_grounding",
                "bing_grounding": {
                    "search_configurations": [
                        {
                            "project_connection_id": (
                                "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices"
                                "/accounts/acct/projects/proj/connections/bing-conn"
                            ),
                            "count": 3,
                        }
                    ]
                },
            }
        ]

    @pytest.mark.asyncio
    async def test_bing_grounding_asearch(self):
        with patch(  # test-quality-ok: derouter.asearch has no client injection seam
            "derouter.llms.custom_httpx.http_handler.AsyncHTTPHandler.post",
            new=AsyncMock(return_value=_mock_response()),
        ) as mock_post:
            response = await derouter.asearch(
                query="what is derouter",
                search_provider="bing_grounding",
            )

        assert mock_post.call_args.kwargs["json"]["tools"] == [{"type": "web_search"}]
        assert len(response.results) == 2

    def test_web_search_mode_is_not_billed_the_g1_price(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("DEROUTER_LOCAL_MODEL_COST_MAP", "True")
        monkeypatch.setattr(derouter, "model_cost", derouter.get_model_cost_map(url=""))
        with patch(  # test-quality-ok: derouter.search has no client injection seam
            "derouter.llms.custom_httpx.http_handler.HTTPHandler.post",
            return_value=_mock_response(),
        ):
            response = derouter.search(query="pricing check", search_provider="bing_grounding")

        assert response._hidden_params["response_cost"] == 0.0

    def test_connection_mode_tracks_the_g1_cost(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("BING_GROUNDING_CONNECTION_ID", "conn-id")
        monkeypatch.setenv("DEROUTER_LOCAL_MODEL_COST_MAP", "True")
        monkeypatch.setattr(derouter, "model_cost", derouter.get_model_cost_map(url=""))
        with patch(  # test-quality-ok: derouter.search has no client injection seam
            "derouter.llms.custom_httpx.http_handler.HTTPHandler.post",
            return_value=_mock_response(),
        ):
            response = derouter.search(query="pricing check", search_provider="bing_grounding")

        assert response._hidden_params["response_cost"] == pytest.approx(0.035)
