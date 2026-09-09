from collections.abc import AsyncIterator, Coroutine, Mapping
from typing import Final, cast

import derouter
from derouter.types.google_genai.adapters import GenerateContentCompletionKwargs
from derouter.types.router import GenericDeRouterParams
from derouter.types.utils import ModelResponse

from .transformation import GoogleGenAIAdapter

# Initialize adapter
GOOGLE_GENAI_ADAPTER: Final = GoogleGenAIAdapter()


class GenerateContentToCompletionHandler:
    """Handler for transforming generate_content calls to completion format when provider config is None"""

    @staticmethod
    def _prepare_completion_kwargs(
        model: str,
        contents: list[dict[str, object]] | dict[str, object],
        config: dict[str, object] | None = None,
        stream: bool = False,
        derouter_params: GenericDeRouterParams | None = None,
        extra_kwargs: Mapping[str, object] | None = None,
    ) -> GenerateContentCompletionKwargs:
        """Prepare kwargs for derouter.completion/acompletion"""

        # Transform generate_content request to completion format
        completion_request: Final = GOOGLE_GENAI_ADAPTER.translate_generate_content_to_completion(
            model=model,
            contents=contents,
            config=config,
            derouter_params=derouter_params,
            **(extra_kwargs or {}),
        )

        completion_kwargs: Final = dict(completion_request)

        # Forward extra_kwargs that should be passed to completion call
        if extra_kwargs is not None:
            # Forward metadata for custom callback
            if "metadata" in extra_kwargs:
                completion_kwargs["metadata"] = extra_kwargs["metadata"]
            # Forward extra_headers for providers that require custom headers (e.g., github_copilot)
            if "extra_headers" in extra_kwargs:
                completion_kwargs["extra_headers"] = extra_kwargs["extra_headers"]

        if stream:
            completion_kwargs["stream"] = stream

        return GenerateContentCompletionKwargs(**completion_kwargs)

    @staticmethod
    async def async_generate_content_handler(
        model: str,
        contents: list[dict[str, object]] | dict[str, object],
        derouter_params: GenericDeRouterParams,
        config: dict[str, object] | None = None,
        stream: bool = False,
        **kwargs: object,
    ) -> dict[str, object] | AsyncIterator[bytes]:
        """Handle generate_content call asynchronously using completion adapter"""

        completion_kwargs: Final = GenerateContentToCompletionHandler._prepare_completion_kwargs(
            model=model,
            contents=contents,
            config=config,
            stream=stream,
            derouter_params=derouter_params,
            extra_kwargs=kwargs,
        )

        try:
            completion_response: Final = await derouter.acompletion(**completion_kwargs)

            if stream:
                # Check if completion_response is actually a stream or a ModelResponse
                # This can happen in error cases or when stream is not properly supported
                if not hasattr(completion_response, "__aiter__"):
                    # If it's not a stream, treat it as a regular response
                    generate_content_response = GOOGLE_GENAI_ADAPTER.translate_completion_to_generate_content(
                        cast(ModelResponse, completion_response)
                    )
                    return generate_content_response
                else:
                    # Transform streaming completion response to generate_content format
                    transformed_stream: Final = GOOGLE_GENAI_ADAPTER.translate_completion_output_params_streaming(
                        completion_response
                    )
                    if transformed_stream is not None:
                        return transformed_stream
                    raise ValueError("Failed to transform streaming response")
            else:
                # Transform completion response back to generate_content format
                generate_content_response = GOOGLE_GENAI_ADAPTER.translate_completion_to_generate_content(
                    cast(ModelResponse, completion_response)
                )
                return generate_content_response

        except Exception as e:
            raise ValueError(f"Error calling derouter.acompletion for generate_content: {e}")

    @staticmethod
    def generate_content_handler(
        model: str,
        contents: list[dict[str, object]] | dict[str, object],
        derouter_params: GenericDeRouterParams,
        config: dict[str, object] | None = None,
        stream: bool = False,
        _is_async: bool = False,
        **kwargs: object,
    ) -> dict[str, object] | AsyncIterator[bytes] | Coroutine[None, None, dict[str, object] | AsyncIterator[bytes]]:
        """Handle generate_content call using completion adapter"""

        if _is_async:
            return GenerateContentToCompletionHandler.async_generate_content_handler(
                model=model,
                contents=contents,
                config=config,
                stream=stream,
                derouter_params=derouter_params,
                **kwargs,
            )

        completion_kwargs: Final = GenerateContentToCompletionHandler._prepare_completion_kwargs(
            model=model,
            contents=contents,
            config=config,
            stream=stream,
            derouter_params=derouter_params,
            extra_kwargs=kwargs,
        )

        try:
            completion_response: Final = derouter.completion(**completion_kwargs)

            if stream:
                # Check if completion_response is actually a stream or a ModelResponse
                # This can happen in error cases or when stream is not properly supported
                if not hasattr(completion_response, "__iter__"):
                    # If it's not a stream, treat it as a regular response
                    generate_content_response = GOOGLE_GENAI_ADAPTER.translate_completion_to_generate_content(
                        cast(ModelResponse, completion_response)
                    )
                    return generate_content_response
                else:
                    # Transform streaming completion response to generate_content format
                    transformed_stream: Final = GOOGLE_GENAI_ADAPTER.translate_completion_output_params_streaming(
                        completion_response
                    )
                    if transformed_stream is not None:
                        return transformed_stream
                    raise ValueError("Failed to transform streaming response")
            else:
                # Transform completion response back to generate_content format
                generate_content_response = GOOGLE_GENAI_ADAPTER.translate_completion_to_generate_content(
                    cast(ModelResponse, completion_response)
                )
                return generate_content_response

        except Exception as e:
            raise ValueError(f"Error calling derouter.completion for generate_content: {e}")
