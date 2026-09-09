"""
HTTP Handler for Interactions API requests.

This module handles the HTTP communication for the Google Interactions API.
"""

from collections.abc import AsyncIterator, Coroutine, Iterator, Mapping
from typing import Any, Final

import httpx

import derouter
from derouter.constants import request_timeout
from derouter.interactions.streaming_iterator import (
    InteractionsAPIStreamingIterator,
    SyncInteractionsAPIStreamingIterator,
)
from derouter.derouter_core_utils.derouter_logging import Logging as DeRouterLoggingObj
from derouter.llms.base_llm.interactions.transformation import BaseInteractionsAPIConfig
from derouter.llms.custom_httpx.http_handler import (
    AsyncHTTPHandler,
    HTTPHandler,
    _get_httpx_client,
    get_async_httpx_client,
)
from derouter.types.interactions import (
    CancelInteractionResult,
    DeleteInteractionResult,
    InteractionInput,
    InteractionsAPIOptionalRequestParams,
    InteractionsAPIResponse,
    InteractionsAPIStreamingResponse,
)
from derouter.types.router import GenericDeRouterParams


class _BaseHTTPHandler:
    """
    Shared HTTP infrastructure for DeRouter handler classes.

    Provides common client resolution and error-mapping helpers so that
    handler subclasses (InteractionsHTTPHandler, AgentsHTTPHandler, …) do
    not duplicate this boilerplate.
    """

    def _handle_error(self, e: Exception, provider_config: Any) -> Exception:
        if isinstance(e, httpx.HTTPStatusError):
            return provider_config.get_error_class(
                error_message=e.response.text,
                status_code=e.response.status_code,
                headers=dict(e.response.headers),
            )
        return e

    def _sync_client(
        self,
        derouter_params: GenericDeRouterParams,
        client: HTTPHandler | None,
    ) -> HTTPHandler:
        return client or _get_httpx_client(params={"ssl_verify": derouter_params.get("ssl_verify", None)})

    def _async_client(
        self,
        derouter_params: GenericDeRouterParams,
        client: AsyncHTTPHandler | None,
    ) -> AsyncHTTPHandler:
        # GenericDeRouterParams.get uses getattr; an unset field is None, not the default.
        custom_llm_provider: Final = derouter_params.get("custom_llm_provider") or "gemini"
        return client or get_async_httpx_client(
            llm_provider=derouter.LlmProviders(custom_llm_provider),
            params={"ssl_verify": derouter_params.get("ssl_verify", None)},
        )


class InteractionsHTTPHandler(_BaseHTTPHandler):
    """
    HTTP handler for Interactions API requests.
    """

    # _handle_error is inherited from _BaseHTTPHandler (accepts Any provider_config).
    # AgentsHTTPHandler also extends this class and passes BaseAgentsAPIConfig, which
    # is structurally compatible but a different type — keeping the override here with
    # BaseInteractionsAPIConfig would cause type errors in the subclass.

    # =========================================================
    # CREATE INTERACTION
    # =========================================================

    def create_interaction(
        self,
        interactions_api_config: BaseInteractionsAPIConfig,
        optional_params: InteractionsAPIOptionalRequestParams,
        custom_llm_provider: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        model: str | None = None,
        agent: str | None = None,
        input: InteractionInput | None = None,
        extra_headers: dict[str, str] | None = None,
        extra_body: Mapping[str, object] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: HTTPHandler | None = None,
        _is_async: bool = False,
        stream: bool | None = None,
    ) -> (
        InteractionsAPIResponse
        | Iterator[InteractionsAPIStreamingResponse]
        | Coroutine[object, object, InteractionsAPIResponse | AsyncIterator[InteractionsAPIStreamingResponse]]
    ):
        """
        Create a new interaction (synchronous or async based on _is_async flag).

        Per Google's OpenAPI spec, the endpoint is POST /{api_version}/interactions
        """
        if _is_async:
            return self.async_create_interaction(
                model=model,
                agent=agent,
                input=input,
                interactions_api_config=interactions_api_config,
                optional_params=optional_params,
                custom_llm_provider=custom_llm_provider,
                derouter_params=derouter_params,
                logging_obj=logging_obj,
                extra_headers=extra_headers,
                extra_body=extra_body,
                timeout=timeout,
                stream=stream,
            )

        if client is None:
            sync_httpx_client = _get_httpx_client(params={"ssl_verify": derouter_params.get("ssl_verify", None)})
        else:
            sync_httpx_client = client

        headers: Final = interactions_api_config.validate_environment(
            headers=extra_headers or {},
            model=model or "",
            derouter_params=derouter_params,
        )

        api_base: Final = interactions_api_config.get_complete_url(
            api_base=derouter_params.api_base or "",
            model=model,
            agent=agent,
            derouter_params=dict(derouter_params),
            stream=stream,
        )

        data: Final = interactions_api_config.transform_request(
            model=model,
            agent=agent,
            input=input,
            optional_params=optional_params,
            derouter_params=derouter_params,
            headers=headers,
        )

        if extra_body:
            data.update(extra_body)

        # Logging
        logging_obj.pre_call(
            input=input,
            api_key="",
            additional_args={
                "complete_input_dict": data,
                "api_base": api_base,
                "headers": headers,
            },
        )

        try:
            if stream:
                response = sync_httpx_client.post(
                    url=api_base,
                    headers=headers,
                    json=data,
                    timeout=timeout or request_timeout,
                    stream=True,
                )
                return self._create_sync_streaming_iterator(
                    response=response,
                    model=model,
                    logging_obj=logging_obj,
                    interactions_api_config=interactions_api_config,
                )
            else:
                response = sync_httpx_client.post(
                    url=api_base,
                    headers=headers,
                    json=data,
                    timeout=timeout or request_timeout,
                )
        except Exception as e:
            raise self._handle_error(e=e, provider_config=interactions_api_config)

        return interactions_api_config.transform_response(
            model=model,
            raw_response=response,
            logging_obj=logging_obj,
        )

    async def async_create_interaction(
        self,
        interactions_api_config: BaseInteractionsAPIConfig,
        optional_params: InteractionsAPIOptionalRequestParams,
        custom_llm_provider: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        model: str | None = None,
        agent: str | None = None,
        input: InteractionInput | None = None,
        extra_headers: dict[str, str] | None = None,
        extra_body: Mapping[str, object] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: AsyncHTTPHandler | None = None,
        stream: bool | None = None,
    ) -> InteractionsAPIResponse | AsyncIterator[InteractionsAPIStreamingResponse]:
        """
        Create a new interaction (async version).
        """
        if client is None:
            async_httpx_client = get_async_httpx_client(
                llm_provider=derouter.LlmProviders(custom_llm_provider),
                params={"ssl_verify": derouter_params.get("ssl_verify", None)},
            )
        else:
            async_httpx_client = client

        headers: Final = interactions_api_config.validate_environment(
            headers=extra_headers or {},
            model=model or "",
            derouter_params=derouter_params,
        )

        api_base: Final = interactions_api_config.get_complete_url(
            api_base=derouter_params.api_base or "",
            model=model,
            agent=agent,
            derouter_params=dict(derouter_params),
            stream=stream,
        )

        data: Final = interactions_api_config.transform_request(
            model=model,
            agent=agent,
            input=input,
            optional_params=optional_params,
            derouter_params=derouter_params,
            headers=headers,
        )

        if extra_body:
            data.update(extra_body)

        # Logging
        logging_obj.pre_call(
            input=input,
            api_key="",
            additional_args={
                "complete_input_dict": data,
                "api_base": api_base,
                "headers": headers,
            },
        )

        try:
            if stream:
                response = await async_httpx_client.post(
                    url=api_base,
                    headers=headers,
                    json=data,
                    timeout=timeout or request_timeout,
                    stream=True,
                )
                return self._create_async_streaming_iterator(
                    response=response,
                    model=model,
                    logging_obj=logging_obj,
                    interactions_api_config=interactions_api_config,
                )
            else:
                response = await async_httpx_client.post(
                    url=api_base,
                    headers=headers,
                    json=data,
                    timeout=timeout or request_timeout,
                )
        except Exception as e:
            raise self._handle_error(e=e, provider_config=interactions_api_config)

        return interactions_api_config.transform_response(
            model=model,
            raw_response=response,
            logging_obj=logging_obj,
        )

    def _create_sync_streaming_iterator(
        self,
        response: httpx.Response,
        model: str | None,
        logging_obj: DeRouterLoggingObj,
        interactions_api_config: BaseInteractionsAPIConfig,
    ) -> SyncInteractionsAPIStreamingIterator:
        """Create a synchronous streaming iterator.

        Google AI's streaming format uses SSE (Server-Sent Events).
        Returns a proper streaming iterator that yields chunks as they arrive.
        """
        return SyncInteractionsAPIStreamingIterator(
            response=response,
            model=model,
            interactions_api_config=interactions_api_config,
            logging_obj=logging_obj,
        )

    def _create_async_streaming_iterator(
        self,
        response: httpx.Response,
        model: str | None,
        logging_obj: DeRouterLoggingObj,
        interactions_api_config: BaseInteractionsAPIConfig,
    ) -> InteractionsAPIStreamingIterator:
        """Create an asynchronous streaming iterator.

        Google AI's streaming format uses SSE (Server-Sent Events).
        Returns a proper streaming iterator that yields chunks as they arrive.
        """
        return InteractionsAPIStreamingIterator(
            response=response,
            model=model,
            interactions_api_config=interactions_api_config,
            logging_obj=logging_obj,
        )

    # =========================================================
    # GET INTERACTION
    # =========================================================

    def get_interaction(
        self,
        interaction_id: str,
        interactions_api_config: BaseInteractionsAPIConfig,
        custom_llm_provider: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, str] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: HTTPHandler | None = None,
        _is_async: bool = False,
    ) -> InteractionsAPIResponse | Coroutine[object, object, InteractionsAPIResponse]:
        """Get an interaction by ID."""
        if _is_async:
            return self.async_get_interaction(
                interaction_id=interaction_id,
                interactions_api_config=interactions_api_config,
                custom_llm_provider=custom_llm_provider,
                derouter_params=derouter_params,
                logging_obj=logging_obj,
                extra_headers=extra_headers,
                timeout=timeout,
            )

        if client is None:
            sync_httpx_client = _get_httpx_client(params={"ssl_verify": derouter_params.get("ssl_verify", None)})
        else:
            sync_httpx_client = client

        headers: Final = interactions_api_config.validate_environment(
            headers=extra_headers or {},
            model="",
            derouter_params=derouter_params,
        )

        url, params = interactions_api_config.transform_get_interaction_request(
            interaction_id=interaction_id,
            api_base=derouter_params.api_base or "",
            derouter_params=derouter_params,
            headers=headers,
        )

        logging_obj.pre_call(
            input=interaction_id,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )

        try:
            response: Final = sync_httpx_client.get(
                url=url,
                headers=headers,
                params=params,
            )
        except Exception as e:
            raise self._handle_error(e=e, provider_config=interactions_api_config)

        return interactions_api_config.transform_get_interaction_response(
            raw_response=response,
            logging_obj=logging_obj,
        )

    async def async_get_interaction(
        self,
        interaction_id: str,
        interactions_api_config: BaseInteractionsAPIConfig,
        custom_llm_provider: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, str] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: AsyncHTTPHandler | None = None,
    ) -> InteractionsAPIResponse:
        """Get an interaction by ID (async version)."""
        if client is None:
            async_httpx_client = get_async_httpx_client(
                llm_provider=derouter.LlmProviders(custom_llm_provider),
                params={"ssl_verify": derouter_params.get("ssl_verify", None)},
            )
        else:
            async_httpx_client = client

        headers: Final = interactions_api_config.validate_environment(
            headers=extra_headers or {},
            model="",
            derouter_params=derouter_params,
        )

        url, params = interactions_api_config.transform_get_interaction_request(
            interaction_id=interaction_id,
            api_base=derouter_params.api_base or "",
            derouter_params=derouter_params,
            headers=headers,
        )

        logging_obj.pre_call(
            input=interaction_id,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )

        try:
            response: Final = await async_httpx_client.get(
                url=url,
                headers=headers,
                params=params,
            )
        except Exception as e:
            raise self._handle_error(e=e, provider_config=interactions_api_config)

        return interactions_api_config.transform_get_interaction_response(
            raw_response=response,
            logging_obj=logging_obj,
        )

    # =========================================================
    # DELETE INTERACTION
    # =========================================================

    def delete_interaction(
        self,
        interaction_id: str,
        interactions_api_config: BaseInteractionsAPIConfig,
        custom_llm_provider: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, str] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: HTTPHandler | None = None,
        _is_async: bool = False,
    ) -> DeleteInteractionResult | Coroutine[object, object, DeleteInteractionResult]:
        """Delete an interaction by ID."""
        if _is_async:
            return self.async_delete_interaction(
                interaction_id=interaction_id,
                interactions_api_config=interactions_api_config,
                custom_llm_provider=custom_llm_provider,
                derouter_params=derouter_params,
                logging_obj=logging_obj,
                extra_headers=extra_headers,
                timeout=timeout,
            )

        if client is None:
            sync_httpx_client = _get_httpx_client(params={"ssl_verify": derouter_params.get("ssl_verify", None)})
        else:
            sync_httpx_client = client

        headers: Final = interactions_api_config.validate_environment(
            headers=extra_headers or {},
            model="",
            derouter_params=derouter_params,
        )

        url, data = interactions_api_config.transform_delete_interaction_request(
            interaction_id=interaction_id,
            api_base=derouter_params.api_base or "",
            derouter_params=derouter_params,
            headers=headers,
        )

        logging_obj.pre_call(
            input=interaction_id,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )

        try:
            response: Final = sync_httpx_client.delete(
                url=url,
                headers=headers,
                timeout=timeout or request_timeout,
            )
        except Exception as e:
            raise self._handle_error(e=e, provider_config=interactions_api_config)

        return interactions_api_config.transform_delete_interaction_response(
            raw_response=response,
            logging_obj=logging_obj,
            interaction_id=interaction_id,
        )

    async def async_delete_interaction(
        self,
        interaction_id: str,
        interactions_api_config: BaseInteractionsAPIConfig,
        custom_llm_provider: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, str] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: AsyncHTTPHandler | None = None,
    ) -> DeleteInteractionResult:
        """Delete an interaction by ID (async version)."""
        if client is None:
            async_httpx_client = get_async_httpx_client(
                llm_provider=derouter.LlmProviders(custom_llm_provider),
                params={"ssl_verify": derouter_params.get("ssl_verify", None)},
            )
        else:
            async_httpx_client = client

        headers: Final = interactions_api_config.validate_environment(
            headers=extra_headers or {},
            model="",
            derouter_params=derouter_params,
        )

        url, data = interactions_api_config.transform_delete_interaction_request(
            interaction_id=interaction_id,
            api_base=derouter_params.api_base or "",
            derouter_params=derouter_params,
            headers=headers,
        )

        logging_obj.pre_call(
            input=interaction_id,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )

        try:
            response: Final = await async_httpx_client.delete(
                url=url,
                headers=headers,
                timeout=timeout or request_timeout,
            )
        except Exception as e:
            raise self._handle_error(e=e, provider_config=interactions_api_config)

        return interactions_api_config.transform_delete_interaction_response(
            raw_response=response,
            logging_obj=logging_obj,
            interaction_id=interaction_id,
        )

    # =========================================================
    # CANCEL INTERACTION
    # =========================================================

    def cancel_interaction(
        self,
        interaction_id: str,
        interactions_api_config: BaseInteractionsAPIConfig,
        custom_llm_provider: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, str] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: HTTPHandler | None = None,
        _is_async: bool = False,
    ) -> CancelInteractionResult | Coroutine[object, object, CancelInteractionResult]:
        """Cancel an interaction by ID."""
        if _is_async:
            return self.async_cancel_interaction(
                interaction_id=interaction_id,
                interactions_api_config=interactions_api_config,
                custom_llm_provider=custom_llm_provider,
                derouter_params=derouter_params,
                logging_obj=logging_obj,
                extra_headers=extra_headers,
                timeout=timeout,
            )

        if client is None:
            sync_httpx_client = _get_httpx_client(params={"ssl_verify": derouter_params.get("ssl_verify", None)})
        else:
            sync_httpx_client = client

        headers: Final = interactions_api_config.validate_environment(
            headers=extra_headers or {},
            model="",
            derouter_params=derouter_params,
        )

        url, data = interactions_api_config.transform_cancel_interaction_request(
            interaction_id=interaction_id,
            api_base=derouter_params.api_base or "",
            derouter_params=derouter_params,
            headers=headers,
        )

        logging_obj.pre_call(
            input=interaction_id,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )

        try:
            response: Final = sync_httpx_client.post(
                url=url,
                headers=headers,
                json=data,
                timeout=timeout or request_timeout,
            )
        except Exception as e:
            raise self._handle_error(e=e, provider_config=interactions_api_config)

        return interactions_api_config.transform_cancel_interaction_response(
            raw_response=response,
            logging_obj=logging_obj,
        )

    async def async_cancel_interaction(
        self,
        interaction_id: str,
        interactions_api_config: BaseInteractionsAPIConfig,
        custom_llm_provider: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, str] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: AsyncHTTPHandler | None = None,
    ) -> CancelInteractionResult:
        """Cancel an interaction by ID (async version)."""
        if client is None:
            async_httpx_client = get_async_httpx_client(
                llm_provider=derouter.LlmProviders(custom_llm_provider),
                params={"ssl_verify": derouter_params.get("ssl_verify", None)},
            )
        else:
            async_httpx_client = client

        headers: Final = interactions_api_config.validate_environment(
            headers=extra_headers or {},
            model="",
            derouter_params=derouter_params,
        )

        url, data = interactions_api_config.transform_cancel_interaction_request(
            interaction_id=interaction_id,
            api_base=derouter_params.api_base or "",
            derouter_params=derouter_params,
            headers=headers,
        )

        logging_obj.pre_call(
            input=interaction_id,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )

        try:
            response: Final = await async_httpx_client.post(
                url=url,
                headers=headers,
                json=data,
                timeout=timeout or request_timeout,
            )
        except Exception as e:
            raise self._handle_error(e=e, provider_config=interactions_api_config)

        return interactions_api_config.transform_cancel_interaction_response(
            raw_response=response,
            logging_obj=logging_obj,
        )


# Initialize the HTTP handler singleton
interactions_http_handler: Final = InteractionsHTTPHandler()
