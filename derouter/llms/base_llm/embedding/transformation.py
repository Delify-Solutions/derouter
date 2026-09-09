from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

import httpx

from derouter.llms.base_llm.chat.transformation import BaseConfig
from derouter.types.llms.openai import AllEmbeddingInputValues, AllMessageValues
from derouter.types.utils import EmbeddingResponse, ModelResponse

if TYPE_CHECKING:
    import tiktoken

    from derouter.derouter_core_utils.derouter_logging import Logging as _DeRouterLoggingObj

    DeRouterLoggingObj = _DeRouterLoggingObj
else:
    DeRouterLoggingObj = Any


class BaseEmbeddingConfig(BaseConfig, ABC):
    @abstractmethod
    def transform_embedding_request(
        self,
        model: str,
        input: AllEmbeddingInputValues,
        optional_params: dict,
        headers: dict,
    ) -> dict:
        return {}

    @abstractmethod
    def transform_embedding_response(
        self,
        model: str,
        raw_response: httpx.Response,
        model_response: EmbeddingResponse,
        logging_obj: DeRouterLoggingObj,
        api_key: str | None,
        request_data: dict,
        optional_params: dict,
        derouter_params: dict,
    ) -> EmbeddingResponse:
        return model_response

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
        OPTIONAL

        Get the complete url for the request

        Some providers need `model` in `api_base`
        """
        return api_base or ""

    def transform_request(
        self,
        model: str,
        messages: list[AllMessageValues],
        optional_params: dict,
        derouter_params: dict,
        headers: dict,
    ) -> dict:
        raise NotImplementedError("EmbeddingConfig does not need a request transformation for chat models")

    def transform_response(
        self,
        model: str,
        raw_response: httpx.Response,
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
        raise NotImplementedError("EmbeddingConfig does not need a response transformation for chat models")
