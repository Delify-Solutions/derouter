"""
*New config* for using aiohttp to make the request to the custom OpenAI-like provider

This leads to 10x higher RPS than httpx
https://github.com/Delify-Solutions/derouter/issues/6592

New config to ensure we introduce this without causing breaking changes for users
"""

from typing import TYPE_CHECKING, Any, Final

from aiohttp import ClientResponse

from derouter.llms.openai_like.chat.transformation import OpenAILikeChatConfig
from derouter.types.llms.openai import AllMessageValues
from derouter.types.utils import Choices, ModelResponse

if TYPE_CHECKING:
    import tiktoken

    from derouter.derouter_core_utils.derouter_logging import Logging as _DeRouterLoggingObj

    DeRouterLoggingObj = _DeRouterLoggingObj
else:
    DeRouterLoggingObj = Any


class AiohttpOpenAIChatConfig(OpenAILikeChatConfig):
    def get_complete_url(
        self,
        api_base: str | None,
        api_key: str | None,
        model: str,
        optional_params: dict,
        derouter_params: dict,
        stream: bool | None = None,
    ) -> str:
        """
        Ensure - /v1/chat/completions is at the end of the url

        """
        if api_base is None:
            api_base = "https://api.openai.com"

        if not api_base.endswith("/chat/completions"):
            api_base += "/chat/completions"
        return api_base

    def validate_environment(
        self,
        headers: dict,
        model: str,
        messages: list[AllMessageValues],
        optional_params: dict,
        derouter_params: dict,
        api_key: str | None = None,
        api_base: str | None = None,
    ) -> dict:
        return {"Authorization": f"Bearer {api_key}"}

    async def transform_response(
        self,
        model: str,
        raw_response: ClientResponse,
        model_response: ModelResponse,
        logging_obj: DeRouterLoggingObj,
        request_data: dict,
        messages: list[AllMessageValues],
        optional_params: dict,
        derouter_params: dict,
        encoding: "tiktoken.Encoding | None",
        api_key: str | None = None,
        json_mode: bool | None = None,
    ) -> ModelResponse:
        _json_response: Final = await raw_response.json()
        model_response.id = _json_response.get("id")
        model_response.choices = [Choices(**choice) for choice in _json_response.get("choices")]
        model_response.created = _json_response.get("created")
        model_response.model = _json_response.get("model")
        model_response.object = _json_response.get("object")
        model_response.system_fingerprint = _json_response.get("system_fingerprint")
        return model_response
