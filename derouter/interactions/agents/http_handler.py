"""
HTTP handler for the Agents API.

Extends InteractionsHTTPHandler so that the shared HTTP infrastructure
(_handle_error, _sync_client, _async_client) is reused rather than
duplicated. BaseAgentsAPIConfig stays as pure transform code.
"""

from collections.abc import Coroutine, Mapping
from typing import Any, Final

import httpx

from derouter.constants import request_timeout
from derouter.interactions.http_handler import InteractionsHTTPHandler
from derouter.derouter_core_utils.derouter_logging import Logging as DeRouterLoggingObj
from derouter.llms.base_llm.agents.transformation import BaseAgentsAPIConfig
from derouter.llms.custom_httpx.http_handler import AsyncHTTPHandler, HTTPHandler
from derouter.types.agents import (
    AgentCreateResponse,
    AgentDeleteResult,
    AgentListResponse,
    AgentVersionsResponse,
)
from derouter.types.router import GenericDeRouterParams


class AgentsHTTPHandler(InteractionsHTTPHandler):
    """HTTP handler for Agents API CRUD requests."""

    # ------------------------------------------------------------------ #
    # CREATE                                                               #
    # ------------------------------------------------------------------ #

    def create_agent(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        name: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        extra_body: Mapping[str, object] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: HTTPHandler | None = None,
        _is_async: bool = False,
    ) -> AgentCreateResponse | Coroutine[object, object, AgentCreateResponse]:
        if _is_async:
            return self.async_create_agent(
                agents_api_config=agents_api_config,
                name=name,
                derouter_params=derouter_params,
                logging_obj=logging_obj,
                extra_headers=extra_headers,
                extra_body=extra_body,
                timeout=timeout,
            )

        sync_httpx_client: Final = self._sync_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url: Final = agents_api_config.get_complete_url(
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        data: Final = agents_api_config.transform_create_request(name=name, derouter_params=dict(derouter_params))
        if extra_body:
            data.update(extra_body)

        logging_obj.pre_call(
            input=name,
            api_key="",
            additional_args={
                "complete_input_dict": data,
                "api_base": url,
                "headers": headers,
            },
        )
        try:
            response = sync_httpx_client.post(url=url, headers=headers, json=data, timeout=timeout or request_timeout)
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(
            original_response=response.text,
            additional_args={"complete_input_dict": data},
        )
        return agents_api_config.transform_create_response(raw_response=response, name=name)

    async def async_create_agent(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        name: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        extra_body: Mapping[str, object] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: AsyncHTTPHandler | None = None,
    ) -> AgentCreateResponse:
        async_httpx_client: Final = self._async_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url: Final = agents_api_config.get_complete_url(
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        data: Final = agents_api_config.transform_create_request(name=name, derouter_params=dict(derouter_params))
        if extra_body:
            data.update(extra_body)

        logging_obj.pre_call(
            input=name,
            api_key="",
            additional_args={
                "complete_input_dict": data,
                "api_base": url,
                "headers": headers,
            },
        )
        try:
            response: Final = await async_httpx_client.post(
                url=url, headers=headers, json=data, timeout=timeout or request_timeout
            )
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(
            original_response=response.text,
            additional_args={"complete_input_dict": data},
        )
        return agents_api_config.transform_create_response(raw_response=response, name=name)

    # ------------------------------------------------------------------ #
    # LIST                                                                 #
    # ------------------------------------------------------------------ #

    def list_agents(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: HTTPHandler | None = None,
        _is_async: bool = False,
    ) -> AgentListResponse | Coroutine[object, object, AgentListResponse]:
        if _is_async:
            return self.async_list_agents(
                agents_api_config=agents_api_config,
                derouter_params=derouter_params,
                logging_obj=logging_obj,
                extra_headers=extra_headers,
                timeout=timeout,
            )

        sync_httpx_client: Final = self._sync_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url, params = agents_api_config.transform_list_request(
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        logging_obj.pre_call(
            input="list_agents",
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )
        try:
            response: Final = sync_httpx_client.get(url=url, headers=headers, params=params)
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(original_response=response.text, additional_args={})
        return agents_api_config.transform_list_response(raw_response=response)

    async def async_list_agents(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: AsyncHTTPHandler | None = None,
    ) -> AgentListResponse:
        async_httpx_client: Final = self._async_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url, params = agents_api_config.transform_list_request(
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        logging_obj.pre_call(
            input="list_agents",
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )
        try:
            response: Final = await async_httpx_client.get(url=url, headers=headers, params=params)
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(original_response=response.text, additional_args={})
        return agents_api_config.transform_list_response(raw_response=response)

    # ------------------------------------------------------------------ #
    # GET                                                                  #
    # ------------------------------------------------------------------ #

    def get_agent(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        name: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: HTTPHandler | None = None,
        _is_async: bool = False,
    ) -> AgentCreateResponse | Coroutine[object, object, AgentCreateResponse]:
        if _is_async:
            return self.async_get_agent(
                agents_api_config=agents_api_config,
                name=name,
                derouter_params=derouter_params,
                logging_obj=logging_obj,
                extra_headers=extra_headers,
                timeout=timeout,
            )

        sync_httpx_client: Final = self._sync_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url, params = agents_api_config.transform_get_request(
            name=name,
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        logging_obj.pre_call(
            input=name,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )
        try:
            response: Final = sync_httpx_client.get(url=url, headers=headers, params=params)
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(original_response=response.text, additional_args={})
        return agents_api_config.transform_get_response(raw_response=response, name=name)

    async def async_get_agent(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        name: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: AsyncHTTPHandler | None = None,
    ) -> AgentCreateResponse:
        async_httpx_client: Final = self._async_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url, params = agents_api_config.transform_get_request(
            name=name,
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        logging_obj.pre_call(
            input=name,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )
        try:
            response: Final = await async_httpx_client.get(url=url, headers=headers, params=params)
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(original_response=response.text, additional_args={})
        return agents_api_config.transform_get_response(raw_response=response, name=name)

    # ------------------------------------------------------------------ #
    # DELETE                                                               #
    # ------------------------------------------------------------------ #

    def delete_agent(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        name: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: HTTPHandler | None = None,
        _is_async: bool = False,
    ) -> AgentDeleteResult | Coroutine[object, object, AgentDeleteResult]:
        if _is_async:
            return self.async_delete_agent(
                agents_api_config=agents_api_config,
                name=name,
                derouter_params=derouter_params,
                logging_obj=logging_obj,
                extra_headers=extra_headers,
                timeout=timeout,
            )

        sync_httpx_client: Final = self._sync_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url: Final = agents_api_config.transform_delete_request(
            name=name,
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        logging_obj.pre_call(
            input=name,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )
        try:
            response: Final = sync_httpx_client.delete(url=url, headers=headers, timeout=timeout or request_timeout)
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(original_response=response.text, additional_args={})
        return agents_api_config.transform_delete_response(raw_response=response, name=name)

    async def async_delete_agent(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        name: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: AsyncHTTPHandler | None = None,
    ) -> AgentDeleteResult:
        async_httpx_client: Final = self._async_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url: Final = agents_api_config.transform_delete_request(
            name=name,
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        logging_obj.pre_call(
            input=name,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )
        try:
            response = await async_httpx_client.delete(url=url, headers=headers, timeout=timeout or request_timeout)
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(original_response=response.text, additional_args={})
        return agents_api_config.transform_delete_response(raw_response=response, name=name)

    # ------------------------------------------------------------------ #
    # LIST VERSIONS                                                        #
    # ------------------------------------------------------------------ #

    def list_agent_versions(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        name: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: HTTPHandler | None = None,
        _is_async: bool = False,
    ) -> AgentVersionsResponse | Coroutine[object, object, AgentVersionsResponse]:
        if _is_async:
            return self.async_list_agent_versions(
                agents_api_config=agents_api_config,
                name=name,
                derouter_params=derouter_params,
                logging_obj=logging_obj,
                extra_headers=extra_headers,
                timeout=timeout,
            )

        sync_httpx_client: Final = self._sync_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url, params = agents_api_config.transform_list_versions_request(
            name=name,
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        logging_obj.pre_call(
            input=name,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )
        try:
            response: Final = sync_httpx_client.get(url=url, headers=headers, params=params)
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(original_response=response.text, additional_args={})
        return agents_api_config.transform_list_versions_response(raw_response=response, name=name)

    async def async_list_agent_versions(
        self,
        agents_api_config: BaseAgentsAPIConfig,
        name: str,
        derouter_params: GenericDeRouterParams,
        logging_obj: DeRouterLoggingObj,
        extra_headers: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        client: AsyncHTTPHandler | None = None,
    ) -> AgentVersionsResponse:
        async_httpx_client: Final = self._async_client(derouter_params, client)
        headers: Final = agents_api_config.validate_environment(
            headers=extra_headers or {}, derouter_params=dict(derouter_params)
        )
        url, params = agents_api_config.transform_list_versions_request(
            name=name,
            api_base=derouter_params.get("api_base"),
            derouter_params=dict(derouter_params),
        )
        logging_obj.pre_call(
            input=name,
            api_key="",
            additional_args={"api_base": url, "headers": headers},
        )
        try:
            response: Final = await async_httpx_client.get(url=url, headers=headers, params=params)
        except Exception as e:
            raise self._handle_error(e=e, provider_config=agents_api_config)

        logging_obj.post_call(original_response=response.text, additional_args={})
        return agents_api_config.transform_list_versions_response(raw_response=response, name=name)


agents_http_handler: Final = AgentsHTTPHandler()
