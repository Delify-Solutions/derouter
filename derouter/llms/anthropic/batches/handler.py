"""
Anthropic Batches API Handler
"""

import asyncio
from collections.abc import Coroutine
from typing import TYPE_CHECKING, Any, Final

import httpx

from derouter.llms.custom_httpx.http_handler import (
    get_async_httpx_client,
)
from derouter.types.utils import DeRouterBatch, LlmProviders

if TYPE_CHECKING:
    from derouter.derouter_core_utils.derouter_logging import Logging as DeRouterLoggingObj
else:
    DeRouterLoggingObj = Any

from ..common_utils import AnthropicModelInfo
from .transformation import AnthropicBatchesConfig


class AnthropicBatchesHandler:
    """
    Handler for Anthropic Message Batches API.

    Supports:
    - retrieve_batch() - Retrieve batch status and information
    """

    def __init__(self):
        self.anthropic_model_info = AnthropicModelInfo()
        self.provider_config = AnthropicBatchesConfig()

    async def aretrieve_batch(
        self,
        batch_id: str,
        api_base: str | None,
        api_key: str | None,
        timeout: float | httpx.Timeout,
        max_retries: int | None,
        logging_obj: DeRouterLoggingObj | None = None,
    ) -> DeRouterBatch:
        """
        Async: Retrieve a batch from Anthropic.

        Args:
            batch_id: The batch ID to retrieve
            api_base: Anthropic API base URL
            api_key: Anthropic API key
            timeout: Request timeout
            max_retries: Max retry attempts (unused for now)
            logging_obj: Optional logging object

        Returns:
            DeRouterBatch: Batch information in OpenAI format
        """
        # Resolve API credentials
        api_base = api_base or self.anthropic_model_info.get_api_base(api_base)
        api_key = api_key or self.anthropic_model_info.get_api_key()

        if not api_key:
            raise ValueError("Missing Anthropic API Key")

        # Create a minimal logging object if not provided
        if logging_obj is None:
            from derouter.derouter_core_utils.derouter_logging import (
                Logging as DeRouterLoggingObjClass,
            )

            logging_obj = DeRouterLoggingObjClass(
                model="anthropic/unknown",
                messages=[],
                stream=False,
                call_type="batch_retrieve",
                start_time=None,
                derouter_call_id=f"batch_retrieve_{batch_id}",
                function_id="batch_retrieve",
            )

        # Get the complete URL for batch retrieval
        retrieve_url: Final = self.provider_config.get_retrieve_batch_url(
            api_base=api_base,
            batch_id=batch_id,
            optional_params={},
            derouter_params={},
        )

        # Validate environment and get headers
        headers: Final = self.provider_config.validate_environment(
            headers={},
            model="",
            messages=[],
            optional_params={},
            derouter_params={},
            api_key=api_key,
            api_base=api_base,
        )

        logging_obj.pre_call(
            input=batch_id,
            api_key=api_key,
            additional_args={
                "api_base": retrieve_url,
                "headers": headers,
                "complete_input_dict": {},
            },
        )
        # Make the request
        async_client: Final = get_async_httpx_client(llm_provider=LlmProviders.ANTHROPIC)
        response: Final = await async_client.get(url=retrieve_url, headers=headers)
        response.raise_for_status()

        # Transform response to DeRouter format
        return self.provider_config.transform_retrieve_batch_response(
            model=None,
            raw_response=response,
            logging_obj=logging_obj,
            derouter_params={},
        )

    def retrieve_batch(
        self,
        _is_async: bool,
        batch_id: str,
        api_base: str | None,
        api_key: str | None,
        timeout: float | httpx.Timeout,
        max_retries: int | None,
        logging_obj: DeRouterLoggingObj | None = None,
    ) -> DeRouterBatch | Coroutine[Any, Any, DeRouterBatch]:
        """
        Retrieve a batch from Anthropic.

        Args:
            _is_async: Whether to run asynchronously
            batch_id: The batch ID to retrieve
            api_base: Anthropic API base URL
            api_key: Anthropic API key
            timeout: Request timeout
            max_retries: Max retry attempts (unused for now)
            logging_obj: Optional logging object

        Returns:
            DeRouterBatch or Coroutine: Batch information in OpenAI format
        """
        if _is_async:
            return self.aretrieve_batch(
                batch_id=batch_id,
                api_base=api_base,
                api_key=api_key,
                timeout=timeout,
                max_retries=max_retries,
                logging_obj=logging_obj,
            )
        else:
            return asyncio.run(
                self.aretrieve_batch(
                    batch_id=batch_id,
                    api_base=api_base,
                    api_key=api_key,
                    timeout=timeout,
                    max_retries=max_retries,
                    logging_obj=logging_obj,
                )
            )
