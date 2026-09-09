from datetime import datetime
from typing import Final

import httpx

import derouter
from derouter import stream_chunk_builder
from derouter.derouter_core_utils.derouter_logging import Logging as DeRouterLoggingObj
from derouter.derouter_core_utils.derouter_logging import (
    get_standard_logging_object_payload,
)
from derouter.derouter_core_utils.streaming_handler import CustomStreamWrapper
from derouter.llms.base_llm.chat.transformation import BaseConfig
from derouter.llms.cohere.chat.v2_transformation import CohereV2ChatConfig
from derouter.llms.cohere.common_utils import (
    ModelResponseIterator as CohereModelResponseIterator,
)
from derouter.llms.cohere.embed.v1_transformation import CohereEmbeddingConfig
from derouter.proxy._types import PassThroughEndpointLoggingTypedDict
from derouter.types.passthrough_endpoints.pass_through_endpoints import (
    PassthroughStandardLoggingPayload,
)
from derouter.types.utils import (
    LlmProviders,
    ModelResponse,
    TextCompletionResponse,
)

from .base_passthrough_logging_handler import BasePassthroughLoggingHandler


class CoherePassthroughLoggingHandler(BasePassthroughLoggingHandler):
    @property
    def llm_provider_name(self) -> LlmProviders:
        return LlmProviders.COHERE

    def get_provider_config(self, model: str) -> BaseConfig:
        return CohereV2ChatConfig()

    def _build_complete_streaming_response(
        self,
        all_chunks: list[str],
        derouter_logging_obj: DeRouterLoggingObj,
        model: str,
    ) -> ModelResponse | TextCompletionResponse | None:
        cohere_model_response_iterator: Final = CohereModelResponseIterator(
            streaming_response=None,
            sync_stream=False,
        )
        derouter_custom_stream_wrapper: Final = CustomStreamWrapper(
            completion_stream=cohere_model_response_iterator,
            model=model,
            logging_obj=derouter_logging_obj,
            custom_llm_provider="cohere",
        )
        all_openai_chunks: Final = []
        for _chunk_str in all_chunks:
            try:
                generic_chunk = cohere_model_response_iterator.convert_str_chunk_to_generic_chunk(chunk=_chunk_str)
                derouter_chunk = derouter_custom_stream_wrapper.chunk_creator(chunk=generic_chunk)
                if derouter_chunk is not None:
                    all_openai_chunks.append(derouter_chunk)
            except (StopIteration, StopAsyncIteration):
                break
        complete_streaming_response: Final = stream_chunk_builder(chunks=all_openai_chunks)
        return complete_streaming_response

    def cohere_passthrough_handler(
        self,
        httpx_response: httpx.Response,
        response_body: dict,
        logging_obj: DeRouterLoggingObj,
        url_route: str,
        result: str,
        start_time: datetime,
        end_time: datetime,
        cache_hit: bool,
        request_body: dict,
        **kwargs,
    ) -> PassThroughEndpointLoggingTypedDict:
        """
        Handle Cohere passthrough logging with route detection and cost tracking.
        """
        # Check if this is an embed endpoint
        if "/v1/embed" in url_route and "/v1/embeddings" not in url_route:
            model: Final = request_body.get("model", response_body.get("model", ""))
            try:
                cohere_embed_config: Final = CohereEmbeddingConfig()
                derouter_model_response = derouter.EmbeddingResponse()
                handler_instance: Final = CoherePassthroughLoggingHandler()

                input_texts = request_body.get("texts", [])
                if not input_texts:
                    input_texts = request_body.get("input", [])

                # Transform the response
                derouter_model_response = cohere_embed_config._transform_response(
                    response=httpx_response,
                    api_key="",
                    logging_obj=logging_obj,
                    data=request_body,
                    model_response=derouter_model_response,
                    model=model,
                    encoding=derouter.encoding,
                    input=input_texts,
                )

                # Calculate cost using DeRouter's cost calculator
                response_cost: Final = derouter.completion_cost(
                    completion_response=derouter_model_response,
                    model=model,
                    custom_llm_provider="cohere",
                    call_type="aembedding",
                )

                # Set the calculated cost in _hidden_params to prevent recalculation
                if not hasattr(derouter_model_response, "_hidden_params"):
                    derouter_model_response._hidden_params = {}
                derouter_model_response._hidden_params["response_cost"] = response_cost

                kwargs["response_cost"] = response_cost
                kwargs["model"] = model
                kwargs["custom_llm_provider"] = "cohere"

                # Extract user information for tracking
                passthrough_logging_payload: Final[PassthroughStandardLoggingPayload | None] = kwargs.get(
                    "passthrough_logging_payload"
                )
                if passthrough_logging_payload:
                    user: Final = handler_instance._get_user_from_metadata(
                        passthrough_logging_payload=passthrough_logging_payload,
                    )
                    if user:
                        kwargs.setdefault("derouter_params", {})
                        kwargs["derouter_params"].update({"proxy_server_request": {"body": {"user": user}}})

                # Create standard logging object
                if derouter_model_response is not None:
                    get_standard_logging_object_payload(
                        kwargs=kwargs,
                        init_response_obj=derouter_model_response,
                        start_time=start_time,
                        end_time=end_time,
                        logging_obj=logging_obj,
                        status="success",
                    )

                # Update logging object with cost information
                logging_obj.model_call_details["model"] = model
                logging_obj.model_call_details["custom_llm_provider"] = "cohere"
                logging_obj.model_call_details["response_cost"] = response_cost

                return {
                    "result": derouter_model_response,
                    "kwargs": kwargs,
                }
            except Exception:
                # For other routes (e.g., /v2/chat), fall back to chat handler
                return super().passthrough_chat_handler(
                    httpx_response=httpx_response,
                    response_body=response_body,
                    logging_obj=logging_obj,
                    url_route=url_route,
                    result=result,
                    start_time=start_time,
                    end_time=end_time,
                    cache_hit=cache_hit,
                    request_body=request_body,
                    **kwargs,
                )

        # For non-embed routes (e.g., /v2/chat), fall back to chat handler
        return super().passthrough_chat_handler(
            httpx_response=httpx_response,
            response_body=response_body,
            logging_obj=logging_obj,
            url_route=url_route,
            result=result,
            start_time=start_time,
            end_time=end_time,
            cache_hit=cache_hit,
            request_body=request_body,
            **kwargs,
        )
