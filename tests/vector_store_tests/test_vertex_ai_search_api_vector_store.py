"""
Test for Vertex AI Search API Vector Store with mocked responses
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import derouter


# Mock response from actual Vertex AI Search API
MOCK_VERTEX_SEARCH_RESPONSE = {
    "results": [
        {
            "id": "0",
            "document": {
                "name": "projects/648660250433/locations/global/collections/default_collection/dataStores/derouter-docs_1761094140318/branches/0/documents/0",
                "id": "0",
                "derivedStructData": {
                    "htmlTitle": "<b>DeRouter</b> - Getting Started | <b>liteLLM</b>",
                    "snippets": [
                        {
                            "htmlSnippet": "https://github.com/Delify-Solutions/<b>derouter</b>.",
                            "snippet": "https://github.com/Delify-Solutions/derouter.",
                        }
                    ],
                    "title": "DeRouter - Getting Started | liteLLM",
                    "link": "https://router.delify.vn/docs/",
                    "displayLink": "router.delify.vn",
                },
            },
        },
        {
            "id": "1",
            "document": {
                "name": "projects/648660250433/locations/global/collections/default_collection/dataStores/derouter-docs_1761094140318/branches/0/documents/1",
                "id": "1",
                "derivedStructData": {
                    "title": "Using Vector Stores (Knowledge Bases) | liteLLM",
                    "link": "https://router.delify.vn/docs/completion/knowledgebase",
                    "snippets": [
                        {
                            "snippet": "DeRouter integrates with vector stores, allowing your models to access your organization's data for more accurate and contextually relevant responses."
                        }
                    ],
                },
            },
        },
    ],
    "totalSize": 299,
    "attributionToken": "mock_token",
    "summary": {},
}


class TestVertexAISearchAPIVectorStore:
    """Test Vertex AI Search API Vector Store with mocked responses"""

    @pytest.mark.asyncio
    async def test_basic_search_with_mock(self):
        """Test basic vector search with mocked backend response"""

        # Mock the HTTP response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = MOCK_VERTEX_SEARCH_RESPONSE
        mock_response.text = json.dumps(MOCK_VERTEX_SEARCH_RESPONSE)

        # Mock the access token method to avoid real authentication
        with patch(
            "derouter.llms.vertex_ai.vector_stores.search_api.transformation.VertexSearchAPIVectorStoreConfig._ensure_access_token"
        ) as mock_auth:
            mock_auth.return_value = ("mock_token", "test-vector-store-db")

            with patch(
                "derouter.llms.custom_httpx.http_handler.AsyncHTTPHandler.post",
                new_callable=AsyncMock,
            ) as mock_post:
                mock_post.return_value = mock_response

                # Make the search request
                response = await derouter.vector_stores.asearch(
                    query="what is DeRouter?",
                    vector_store_id="test-derouter-app_1761094730750",
                    custom_llm_provider="vertex_ai/search_api",
                    vertex_project="test-vector-store-db",
                    vertex_location="us-central1",
                )

                print("Response:", json.dumps(response, indent=2, default=str))

                # Validate the response structure (DeRouter standard format)
                assert response is not None
                assert response["object"] == "vector_store.search_results.page"
                assert "data" in response
                assert len(response["data"]) > 0
                assert "search_query" in response

                # Validate first result
                first_result = response["data"][0]
                assert "score" in first_result
                assert "content" in first_result
                assert "file_id" in first_result
                assert "filename" in first_result
                assert "attributes" in first_result

                # Validate content structure
                assert len(first_result["content"]) > 0
                assert first_result["content"][0]["type"] == "text"
                assert "text" in first_result["content"][0]

                # Verify the API was called
                mock_post.assert_called_once()

                # Verify the URL format
                call_args = mock_post.call_args
                url = call_args[1]["url"] if "url" in call_args[1] else call_args[0][0]
                assert "discoveryengine.googleapis.com" in url
                assert "test-vector-store-db" in url
                assert "test-derouter-app_1761094730750" in url

    def test_basic_search_sync_with_mock(self):
        """Test basic vector search (sync) with mocked backend response"""

        # Mock the HTTP response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = MOCK_VERTEX_SEARCH_RESPONSE
        mock_response.text = json.dumps(MOCK_VERTEX_SEARCH_RESPONSE)

        # Mock the access token method to avoid real authentication
        with patch(
            "derouter.llms.vertex_ai.vector_stores.search_api.transformation.VertexSearchAPIVectorStoreConfig._ensure_access_token"
        ) as mock_auth:
            mock_auth.return_value = ("mock_token", "test-vector-store-db")

            with patch(
                "derouter.llms.custom_httpx.http_handler.HTTPHandler.post"
            ) as mock_post:
                mock_post.return_value = mock_response

                # Make the search request
                response = derouter.vector_stores.search(
                    query="what is DeRouter?",
                    vector_store_id="test-derouter-app_1761094730750",
                    custom_llm_provider="vertex_ai/search_api",
                    vertex_project="test-vector-store-db",
                    vertex_location="us-central1",
                )

                print("Response:", json.dumps(response, indent=2, default=str))

                # Validate the response structure (DeRouter standard format)
                assert response is not None
                assert response["object"] == "vector_store.search_results.page"
                assert "data" in response
                assert len(response["data"]) > 0
                assert "search_query" in response

                # Validate first result structure
                first_result = response["data"][0]
                assert "score" in first_result
                assert "content" in first_result
                assert "file_id" in first_result
                assert "filename" in first_result
                assert "attributes" in first_result

                # Validate content structure
                assert len(first_result["content"]) > 0
                assert first_result["content"][0]["type"] == "text"
                assert "text" in first_result["content"][0]

                # Validate attributes
                assert "document_id" in first_result["attributes"]
                assert "link" in first_result["attributes"]
                assert "title" in first_result["attributes"]

                # Verify the API was called
                mock_post.assert_called_once()


if __name__ == "__main__":
    # Run tests
    import asyncio

    test = TestVertexAISearchAPIVectorStore()

    print("Running async test...")
    asyncio.run(test.test_basic_search_with_mock())

    print("\nRunning sync test...")
    test.test_basic_search_sync_with_mock()

    print("\n✅ All tests passed!")
