import json

import derouter
import pytest


@pytest.fixture()
def disable_aiohttp_transport():
    original_disable_aiohttp = derouter.disable_aiohttp_transport
    derouter.disable_aiohttp_transport = True
    derouter.in_memory_llm_clients_cache.flush_cache()
    try:
        yield
    finally:
        derouter.disable_aiohttp_transport = original_disable_aiohttp
        derouter.in_memory_llm_clients_cache.flush_cache()


@pytest.mark.asyncio
async def test_parse_legacy_wraps_enhance_under_options(
    disable_aiohttp_transport, respx_mock
):
    upload_route = respx_mock.post("https://platform.reducto.ai/upload").respond(
        json={"file_id": "reducto://legacy.pdf"}
    )
    parse_route = respx_mock.post("https://platform.reducto.ai/parse").respond(
        json={
            "usage": {"num_pages": 1, "credits": 1},
            "result": {
                "chunks": [
                    {
                        "content": "Legacy parse",
                        "blocks": [{"content": "Legacy parse", "bbox": {"page": 1}}],
                    }
                ]
            },
        }
    )

    response = await derouter.aocr(
        model="reducto/parse-legacy",
        document={
            "type": "file",
            "file": b"%PDF-1.4 legacy",
            "mime_type": "application/pdf",
        },
        api_key="legacy-key",
        api_base="https://platform.reducto.ai",
        enhance={"agentic": [{"type": "table"}]},
    )

    assert upload_route.called
    assert parse_route.called
    request_body = json.loads(parse_route.calls[0].request.read())
    assert request_body == {
        "document_url": "reducto://legacy.pdf",
        "options": {"enhance": {"agentic": [{"type": "table"}]}},
    }
    assert response.pages[0].markdown == "Legacy parse"
