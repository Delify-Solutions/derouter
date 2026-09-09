import re
from datetime import datetime
from typing import TYPE_CHECKING, Any, Final

import httpx

import derouter
from derouter._logging import verbose_proxy_logger
from derouter.derouter_core_utils.derouter_logging import Logging as DeRouterLoggingObj
from derouter.llms.gemini.videos.transformation import GeminiVideoConfig
from derouter.llms.vertex_ai.gemini.vertex_and_google_ai_studio_gemini import (
    ModelResponseIterator as GeminiModelResponseIterator,
)
from derouter.proxy._types import PassThroughEndpointLoggingTypedDict
from derouter.types.utils import (
    ModelResponse,
    TextCompletionResponse,
)

if TYPE_CHECKING:
    from derouter.types.passthrough_endpoints.pass_through_endpoints import EndpointType

    from ..success_handler import PassThroughEndpointLogging
else:
    PassThroughEndpointLogging = Any
    EndpointType = Any


class GeminiPassthroughLoggingHandler:
    @staticmethod
    def gemini_passthrough_handler(
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
        if "predictLongRunning" in url_route:
            model = GeminiPassthroughLoggingHandler.extract_model_from_url(url_route)

            gemini_video_config: Final = GeminiVideoConfig()
            derouter_video_response: Final = gemini_video_config.transform_video_create_response(
                model=model,
                raw_response=httpx_response,
                logging_obj=logging_obj,
                custom_llm_provider="gemini",
                request_data=request_body,
            )
            logging_obj.model = model
            logging_obj.model_call_details["model"] = model
            logging_obj.model_call_details["custom_llm_provider"] = "gemini"
            logging_obj.custom_llm_provider = "gemini"

            response_cost: Final = derouter.completion_cost(
                completion_response=derouter_video_response,
                model=model,
                custom_llm_provider="gemini",
                call_type="create_video",
            )

            # Set response_cost in _hidden_params to prevent recalculation
            if not hasattr(derouter_video_response, "_hidden_params"):
                derouter_video_response._hidden_params = {}
            derouter_video_response._hidden_params["response_cost"] = response_cost

            kwargs["response_cost"] = response_cost
            kwargs["model"] = model
            kwargs["custom_llm_provider"] = "gemini"
            logging_obj.model_call_details["response_cost"] = response_cost
            return {
                "result": derouter_video_response,
                "kwargs": kwargs,
            }

        if "generateContent" in url_route:
            model = GeminiPassthroughLoggingHandler.extract_model_from_url(url_route)

            # Use Gemini config for transformation
            instance_of_gemini_llm: Final = derouter.GoogleAIStudioGeminiConfig()
            derouter_model_response: Final[ModelResponse] = instance_of_gemini_llm.transform_response(
                model=model,
                messages=[{"role": "user", "content": "no-message-pass-through-endpoint"}],
                raw_response=httpx_response,
                model_response=derouter.ModelResponse(),
                logging_obj=logging_obj,
                optional_params={},
                derouter_params={},
                api_key="",
                request_data={},
                encoding=getattr(derouter, "encoding", None),
            )
            kwargs = GeminiPassthroughLoggingHandler._create_gemini_response_logging_payload_for_generate_content(
                derouter_model_response=derouter_model_response,
                model=model,
                kwargs=kwargs,
                start_time=start_time,
                end_time=end_time,
                logging_obj=logging_obj,
                custom_llm_provider="gemini",
            )

            return {
                "result": derouter_model_response,
                "kwargs": kwargs,
            }
        else:
            return {
                "result": None,
                "kwargs": kwargs,
            }

    @staticmethod
    def _handle_logging_gemini_collected_chunks(
        derouter_logging_obj: DeRouterLoggingObj,
        passthrough_success_handler_obj: PassThroughEndpointLogging,
        url_route: str,
        request_body: dict,
        endpoint_type: EndpointType,
        start_time: datetime,
        all_chunks: list[str],
        model: str | None,
        end_time: datetime,
    ) -> PassThroughEndpointLoggingTypedDict:
        """
        Takes raw chunks from Gemini passthrough endpoint and logs them in derouter callbacks

        - Builds complete response from chunks
        - Creates standard logging object
        - Logs in derouter callbacks
        """
        kwargs: dict[str, Any] = {}
        model = model or GeminiPassthroughLoggingHandler.extract_model_from_url(url_route)
        complete_streaming_response: Final = GeminiPassthroughLoggingHandler._build_complete_streaming_response(
            all_chunks=all_chunks,
            derouter_logging_obj=derouter_logging_obj,
            model=model,
            url_route=url_route,
        )

        if complete_streaming_response is None:
            verbose_proxy_logger.error(
                "Unable to build complete streaming response for Gemini passthrough endpoint, not logging..."
            )
            return {
                "result": None,
                "kwargs": kwargs,
            }

        kwargs = GeminiPassthroughLoggingHandler._create_gemini_response_logging_payload_for_generate_content(
            derouter_model_response=complete_streaming_response,
            model=model,
            kwargs=kwargs,
            start_time=start_time,
            end_time=end_time,
            logging_obj=derouter_logging_obj,
            custom_llm_provider="gemini",
        )

        return {
            "result": complete_streaming_response,
            "kwargs": kwargs,
        }

    @staticmethod
    def _build_complete_streaming_response(
        all_chunks: list[str],
        derouter_logging_obj: DeRouterLoggingObj,
        model: str,
        url_route: str,
    ) -> ModelResponse | TextCompletionResponse | None:
        parsed_chunks = []
        if "generateContent" in url_route or "streamGenerateContent" in url_route:
            gemini_iterator: Final[Any] = GeminiModelResponseIterator(
                streaming_response=None,
                sync_stream=False,
                logging_obj=derouter_logging_obj,
            )
            chunk_parsing_logic: Final[Any] = gemini_iterator._common_chunk_parsing_logic
            parsed_chunks = [chunk_parsing_logic(chunk) for chunk in all_chunks]
        else:
            return None

        if len(parsed_chunks) == 0:
            return None

        all_openai_chunks: Final = []
        for parsed_chunk in parsed_chunks:
            if parsed_chunk is None:
                continue
            all_openai_chunks.append(parsed_chunk)

        complete_streaming_response: Final = derouter.stream_chunk_builder(chunks=all_openai_chunks)

        return complete_streaming_response

    @staticmethod
    def extract_model_from_url(url: str) -> str:
        pattern: Final = r"/models/([^:]+)"
        match: Final = re.search(pattern, url)
        if match:
            return match.group(1)
        return "unknown"

    @staticmethod
    def _create_gemini_response_logging_payload_for_generate_content(
        derouter_model_response: ModelResponse | TextCompletionResponse,
        model: str,
        kwargs: dict,
        start_time: datetime,
        end_time: datetime,
        logging_obj: DeRouterLoggingObj,
        custom_llm_provider: str,
    ):
        """
        Create the standard logging object for Gemini passthrough generateContent (streaming and non-streaming)
        """

        response_cost: Final = derouter.completion_cost(
            completion_response=derouter_model_response,
            model=model,
            custom_llm_provider="gemini",
        )

        kwargs["response_cost"] = response_cost
        kwargs["model"] = model
        kwargs["custom_llm_provider"] = custom_llm_provider

        # pretty print standard logging object
        verbose_proxy_logger.debug("kwargs= %s", kwargs)

        # set derouter_call_id to logging response object
        derouter_model_response.id = logging_obj.derouter_call_id
        logging_obj.model = derouter_model_response.model or model
        logging_obj.model_call_details["model"] = logging_obj.model
        logging_obj.model_call_details["custom_llm_provider"] = custom_llm_provider
        logging_obj.model_call_details["response_cost"] = response_cost
        return kwargs
