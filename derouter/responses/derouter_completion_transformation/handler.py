"""
Handler for transforming responses api requests to derouter.completion requests
"""

from collections.abc import Coroutine, Mapping
from typing import Final

import derouter
from derouter.responses.derouter_completion_transformation.streaming_iterator import (
    DeRouterCompletionStreamingIterator,
)
from derouter.responses.derouter_completion_transformation.transformation import (
    DeRouterCompletionResponsesConfig,
)
from derouter.responses.streaming_iterator import BaseResponsesAPIStreamingIterator
from derouter.types.llms.openai import (
    ResponseInputParam,
    ResponsesAPIOptionalRequestParams,
    ResponsesAPIResponse,
)
from derouter.types.utils import ModelResponse


class DeRouterCompletionTransformationHandler:
    def response_api_handler(
        self,
        model: str,
        input: str | ResponseInputParam,
        responses_api_request: ResponsesAPIOptionalRequestParams,
        custom_llm_provider: str | None = None,
        _is_async: bool = False,
        stream: bool | None = None,
        extra_headers: Mapping[str, object] | None = None,
        **kwargs,
    ) -> (
        ResponsesAPIResponse
        | BaseResponsesAPIStreamingIterator
        | Coroutine[object, object, ResponsesAPIResponse | BaseResponsesAPIStreamingIterator]
    ):
        derouter_completion_request: Final[dict] = (
            DeRouterCompletionResponsesConfig.transform_responses_api_request_to_chat_completion_request(
                model=model,
                input=input,
                responses_api_request=responses_api_request,
                custom_llm_provider=custom_llm_provider,
                stream=stream,
                extra_headers=extra_headers,
                **kwargs,
            )
        )

        if _is_async:
            return self.async_response_api_handler(
                derouter_completion_request=derouter_completion_request,
                request_input=input,
                responses_api_request=responses_api_request,
                **kwargs,
            )

        completion_args: Final = {}
        completion_args.update(kwargs)
        completion_args.update(derouter_completion_request)
        completion_args["_skip_responses_api_bridge"] = True

        derouter_completion_response: Final[ModelResponse | derouter.CustomStreamWrapper] = derouter.completion(
            **completion_args,
        )

        if isinstance(derouter_completion_response, ModelResponse):
            responses_api_response: Final[ResponsesAPIResponse] = (
                DeRouterCompletionResponsesConfig.transform_chat_completion_response_to_responses_api_response(
                    chat_completion_response=derouter_completion_response,
                    request_input=input,
                    responses_api_request=responses_api_request,
                )
            )

            return responses_api_response

        elif isinstance(derouter_completion_response, derouter.CustomStreamWrapper):
            return DeRouterCompletionStreamingIterator(
                model=model,
                derouter_custom_stream_wrapper=derouter_completion_response,
                request_input=input,
                responses_api_request=responses_api_request,
                custom_llm_provider=custom_llm_provider,
                derouter_metadata=kwargs.get("derouter_metadata", {}),
            )
        raise ValueError(f"Unexpected response type: {type(derouter_completion_response)}")

    async def async_response_api_handler(
        self,
        derouter_completion_request: dict,
        request_input: str | ResponseInputParam,
        responses_api_request: ResponsesAPIOptionalRequestParams,
        **kwargs,
    ) -> ResponsesAPIResponse | BaseResponsesAPIStreamingIterator:
        previous_response_id: Final[str | None] = responses_api_request.get("previous_response_id")
        if previous_response_id:
            derouter_completion_request = await DeRouterCompletionResponsesConfig.async_responses_api_session_handler(
                previous_response_id=previous_response_id,
                derouter_completion_request=derouter_completion_request,
            )

        acompletion_args: Final = {}
        acompletion_args.update(kwargs)
        acompletion_args.update(derouter_completion_request)
        acompletion_args["_skip_responses_api_bridge"] = True

        derouter_completion_response: Final[ModelResponse | derouter.CustomStreamWrapper] = await derouter.acompletion(
            **acompletion_args,
        )

        if isinstance(derouter_completion_response, ModelResponse):
            responses_api_response: Final[ResponsesAPIResponse] = (
                DeRouterCompletionResponsesConfig.transform_chat_completion_response_to_responses_api_response(
                    chat_completion_response=derouter_completion_response,
                    request_input=request_input,
                    responses_api_request=responses_api_request,
                )
            )

            return responses_api_response

        elif isinstance(derouter_completion_response, derouter.CustomStreamWrapper):
            return DeRouterCompletionStreamingIterator(
                model=derouter_completion_request.get("model") or "",
                derouter_custom_stream_wrapper=derouter_completion_response,
                request_input=request_input,
                responses_api_request=responses_api_request,
                custom_llm_provider=derouter_completion_request.get("custom_llm_provider"),
                derouter_metadata=kwargs.get("derouter_metadata", {}),
            )
        raise ValueError(f"Unexpected response type: {type(derouter_completion_response)}")
