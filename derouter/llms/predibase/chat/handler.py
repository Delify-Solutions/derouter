# What is this?
## Controller file for Predibase Integration - https://predibase.com/

import json
from collections.abc import Callable
from functools import partial
from typing import Final

import httpx

import derouter
from derouter.derouter_core_utils.derouter_logging import Logging as DeRouterLoggingObj
from derouter.llms.custom_httpx.http_handler import (
    AsyncHTTPHandler,
    get_async_httpx_client,
)
from derouter.utils import CustomStreamWrapper, ModelResponse

from ..common_utils import PredibaseError


async def make_call(
    client: AsyncHTTPHandler,
    api_base: str,
    headers: dict,
    data: str,
    model: str,
    messages: list,
    logging_obj,
    timeout: float | httpx.Timeout | None,
):
    response: Final = await client.post(api_base, headers=headers, data=data, stream=True, timeout=timeout)

    if response.status_code != 200:
        raise PredibaseError(status_code=response.status_code, message=response.text)

    completion_stream: Final = response.aiter_lines()
    # LOGGING
    logging_obj.post_call(
        input=messages,
        api_key="",
        original_response=completion_stream,  # Pass the completion stream for logging
        additional_args={"complete_input_dict": data},
    )

    return completion_stream


class PredibaseChatCompletion:
    def __init__(self) -> None:
        super().__init__()

    def completion(
        self,
        model: str,
        messages: list,
        api_base: str,
        custom_prompt_dict: dict,
        model_response: ModelResponse,
        print_verbose: Callable,
        encoding,
        api_key: str,
        logging_obj: DeRouterLoggingObj,
        optional_params: dict,
        derouter_params: dict,
        tenant_id: str,
        timeout: float | httpx.Timeout,
        acompletion=None,
        logger_fn=None,
        headers: dict = {},
    ) -> ModelResponse | CustomStreamWrapper:
        predibase_config: Final = derouter.PredibaseConfig()
        headers = predibase_config.validate_environment(
            api_key=api_key,
            headers=headers,
            messages=messages,
            optional_params=optional_params,
            model=model,
            derouter_params=derouter_params,
        )
        request_optional_params: Final = {**optional_params}
        stream: Final = request_optional_params.get("stream", False)
        request_derouter_params: Final = {
            **derouter_params,
            "custom_prompt_dict": custom_prompt_dict,
            "predibase_tenant_id": tenant_id,
        }
        completion_url: Final = predibase_config.get_complete_url(
            api_base=api_base,
            api_key=api_key,
            model=model,
            optional_params=request_optional_params,
            derouter_params=request_derouter_params,
            stream=stream,
        )
        data: Final = predibase_config.transform_request(
            model=model,
            messages=messages,
            optional_params=request_optional_params,
            derouter_params=request_derouter_params,
            headers=headers,
        )

        ## LOGGING
        logging_obj.pre_call(
            input=data.get("inputs", ""),
            api_key=api_key,
            additional_args={
                "complete_input_dict": data,
                "headers": headers,
                "api_base": completion_url,
                "acompletion": acompletion,
            },
        )
        ## COMPLETION CALL
        if acompletion is True:
            ### ASYNC STREAMING
            if stream is True:
                return self.async_streaming(
                    model=model,
                    messages=messages,
                    data=data,
                    api_base=completion_url,
                    model_response=model_response,
                    print_verbose=print_verbose,
                    encoding=encoding,
                    api_key=api_key,
                    logging_obj=logging_obj,
                    optional_params=request_optional_params,
                    derouter_params=request_derouter_params,
                    logger_fn=logger_fn,
                    headers=headers,
                    timeout=timeout,
                )
            else:
                ### ASYNC COMPLETION
                return self.async_completion(
                    model=model,
                    messages=messages,
                    data=data,
                    api_base=completion_url,
                    model_response=model_response,
                    print_verbose=print_verbose,
                    encoding=encoding,
                    api_key=api_key,
                    logging_obj=logging_obj,
                    optional_params=request_optional_params,
                    stream=False,
                    derouter_params=request_derouter_params,
                    logger_fn=logger_fn,
                    headers=headers,
                    timeout=timeout,
                    predibase_config=predibase_config,
                )

        ### SYNC STREAMING
        if stream is True:
            response = derouter.module_level_client.post(
                completion_url,
                headers=headers,
                data=json.dumps(data),
                stream=stream,
                timeout=timeout,
            )
            _response: Final = CustomStreamWrapper(
                response.iter_lines(),
                model,
                custom_llm_provider="predibase",
                logging_obj=logging_obj,
            )
            return _response
        ### SYNC COMPLETION
        else:
            response = derouter.module_level_client.post(
                url=completion_url,
                headers=headers,
                data=json.dumps(data),
                timeout=timeout,
            )
        return predibase_config.transform_response(
            model=model,
            raw_response=response,
            model_response=model_response,
            logging_obj=logging_obj,
            optional_params=request_optional_params,
            api_key=api_key,
            request_data=data,
            messages=messages,
            derouter_params=request_derouter_params,
            encoding=encoding,
        )

    async def async_completion(
        self,
        model: str,
        messages: list,
        api_base: str,
        model_response: ModelResponse,
        print_verbose: Callable,
        encoding,
        api_key,
        logging_obj,
        stream,
        data: dict,
        optional_params: dict,
        timeout: float | httpx.Timeout,
        derouter_params=None,
        logger_fn=None,
        headers={},
        predibase_config=None,
    ) -> ModelResponse:
        if predibase_config is None:
            predibase_config = derouter.PredibaseConfig()
        async_handler: Final = get_async_httpx_client(
            llm_provider=derouter.LlmProviders.PREDIBASE,
            params={"timeout": timeout},
        )
        try:
            response: Final = await async_handler.post(api_base, headers=headers, data=json.dumps(data))
        except httpx.HTTPStatusError as e:
            raise PredibaseError(
                status_code=e.response.status_code,
                message=f"HTTPStatusError - received status_code={e.response.status_code}, error_message={e.response.text}",
            )
        except Exception as e:
            for exception in derouter.DEROUTER_EXCEPTION_TYPES:
                if isinstance(e, exception):
                    raise e
            raise PredibaseError(
                status_code=500, message=f"{e}"
            )  # don't use verbose_logger.exception, if exception is raised
        return predibase_config.transform_response(
            model=model,
            raw_response=response,
            model_response=model_response,
            logging_obj=logging_obj,
            api_key=api_key,
            request_data=data,
            messages=messages,
            optional_params=optional_params,
            derouter_params=derouter_params or {},
            encoding=encoding,
        )

    async def async_streaming(
        self,
        model: str,
        messages: list,
        api_base: str,
        model_response: ModelResponse,
        print_verbose: Callable,
        encoding,
        api_key,
        logging_obj: DeRouterLoggingObj,
        data: dict,
        timeout: float | httpx.Timeout,
        optional_params=None,
        derouter_params=None,
        logger_fn=None,
        headers={},
    ) -> CustomStreamWrapper:
        data["stream"] = True

        streamwrapper: Final = CustomStreamWrapper(
            completion_stream=None,
            make_call=partial(
                make_call,
                api_base=api_base,
                headers=headers,
                data=json.dumps(data),
                model=model,
                messages=messages,
                logging_obj=logging_obj,
                timeout=timeout,
            ),
            model=model,
            custom_llm_provider="predibase",
            logging_obj=logging_obj,
        )
        return streamwrapper

    def embedding(self, *args, **kwargs):
        pass
