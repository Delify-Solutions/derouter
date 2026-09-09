"""
Tests for derouter/vector_stores/main.py.

Pins the router threading contract for vector store search: the router is an
explicit named parameter that reaches the HTTP handler wrapped in the embedding
executor, and it must never leak into derouter_params/kwargs where logging would
model_dump() it (the #19550 serialization trap).
"""

from unittest.mock import MagicMock, patch

import pytest

import derouter.vector_stores.main as vector_stores_main
from derouter.llms.base_llm.vector_store.transformation import (
    RouterVectorStoreEmbeddingExecutor,
)
from derouter.vector_stores.main import search

MOCK_SEARCH_RESPONSE = {
    "object": "vector_store.search_results.page",
    "search_query": "q",
    "data": [],
}


@pytest.mark.parametrize("query", ["q", ["q", "another question"]])
def test_search_wraps_router_into_the_handler_embedding_executor(query: str | list[str]):
    """search() hands the HTTP handler a Router-backed embedding executor carrying the
    request metadata, and no bare router kwarg (LIT-6750)"""
    mock_router = MagicMock()
    logger = MagicMock()

    with (
        patch(  # test-quality-ok: stubs provider config resolution; the seam under test is the executor threading
            "derouter.vector_stores.main.ProviderConfigManager.get_provider_vector_stores_config",
            return_value=MagicMock(),
        ),
        patch.object(  # test-quality-ok: the handler call is the observable boundary for the executor contract
            vector_stores_main.base_llm_http_handler,
            "vector_store_search_handler",
            return_value=MOCK_SEARCH_RESPONSE,
        ) as mock_handler,
    ):
        response = search(
            vector_store_id="bkt:idx",
            query=query,
            custom_llm_provider="s3_vectors",
            router=mock_router,
            derouter_logging_obj=logger,
            derouter_metadata={"user_api_key_team_id": "team-a"},
        )

    assert response == MOCK_SEARCH_RESPONSE
    mock_handler.assert_called_once()
    assert "router" not in mock_handler.call_args.kwargs
    assert mock_handler.call_args.kwargs["query"] == query
    executor = mock_handler.call_args.kwargs["embedding_executor"]
    assert isinstance(executor, RouterVectorStoreEmbeddingExecutor)
    assert executor.router is mock_router
    assert dict(executor.metadata) == {"user_api_key_team_id": "team-a"}


def test_search_router_not_in_derouter_params():
    """Regression (#19550 class): the router must stay out of GenericDeRouterParams,
    otherwise pre-call logging model_dump()s it and breaks serialization."""
    mock_router = MagicMock()
    logger = MagicMock()

    with (
        patch(  # test-quality-ok: stubs provider config resolution; the seam under test is derouter_params contents
            "derouter.vector_stores.main.ProviderConfigManager.get_provider_vector_stores_config",
            return_value=MagicMock(),
        ),
        patch.object(  # test-quality-ok: the handler call is where a leaked router in derouter_params would surface
            vector_stores_main.base_llm_http_handler,
            "vector_store_search_handler",
            return_value=MOCK_SEARCH_RESPONSE,
        ) as mock_handler,
    ):
        search(
            vector_store_id="bkt:idx",
            query="q",
            custom_llm_provider="s3_vectors",
            router=mock_router,
            derouter_logging_obj=logger,
        )

    derouter_params = mock_handler.call_args.kwargs["derouter_params"]
    assert "router" not in derouter_params.model_dump(exclude_none=True)
    assert getattr(derouter_params, "router", None) is None
