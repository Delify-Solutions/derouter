# +-----------------------------------------------+
# |                                               |
# |           Give Feedback / Get Help            |
# | https://github.com/Delify-Solutions/derouter/issues/new |
# |                                               |
# +-----------------------------------------------+
#
#  Thank you users! We ❤️ you! - Krrish & Ishaan

import asyncio
import copy
import inspect
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Final

import derouter
from derouter.constants import REDACTED_BY_DEROUTER
from derouter.integrations.custom_logger import CustomLogger
from derouter.derouter_core_utils.core_helpers import (
    get_metadata_variable_name_from_kwargs,
)
from derouter.llms.vertex_ai.common_utils import (
    redact_vertex_ai_metadata_from_derouter_params,
    redact_vertex_ai_metadata_from_logged_object,
)
from derouter.secret_managers.main import str_to_bool
from derouter.types.utils import StandardCallbackDynamicParams

if TYPE_CHECKING:
    from derouter.derouter_core_utils.derouter_logging import (
        Logging as _DeRouterLoggingObject,
    )

    DeRouterLoggingObject = _DeRouterLoggingObject
else:
    DeRouterLoggingObject = Any


def redact_message_input_output_from_custom_logger(
    derouter_logging_obj: DeRouterLoggingObject, result, custom_logger: CustomLogger
):
    if hasattr(custom_logger, "message_logging") and custom_logger.message_logging is not True:
        return perform_redaction(derouter_logging_obj.model_call_details, result, redact_streaming_responses=False)
    return result


def redact_streaming_responses_for_custom_logger(model_call_details: dict, custom_logger: CustomLogger) -> dict:
    """
    Returns a copy of model_call_details whose streaming response entries are redacted deepcopies
    when the custom logger has opted out of message logging. The shared model_call_details is left
    untouched so other callbacks still receive the unredacted response.
    """
    if not (hasattr(custom_logger, "message_logging") and custom_logger.message_logging is not True):
        return model_call_details
    redacted_entries: Final = {
        streaming_key: _redacted_streaming_response_copy(model_call_details[streaming_key])
        for streaming_key in ("complete_streaming_response", "async_complete_streaming_response")
        if model_call_details.get(streaming_key) is not None
    }
    if not redacted_entries:
        return model_call_details
    return {**model_call_details, **redacted_entries}


def _redacted_streaming_response_copy(streaming_response):
    redacted_response: Final = copy.deepcopy(streaming_response)
    _redact_streaming_response(redacted_response)
    return redacted_response


def _redact_streaming_response(streaming_response):
    if hasattr(streaming_response, "choices"):
        for choice in streaming_response.choices:
            _redact_choice_content(choice)
        redact_vertex_ai_metadata_from_logged_object(streaming_response)
    elif hasattr(streaming_response, "output"):
        _redact_responses_api_output(streaming_response.output)
        if hasattr(streaming_response, "reasoning") and streaming_response.reasoning is not None:
            streaming_response.reasoning = None


def _redact_tool_calls(tool_calls) -> None:
    """Redact tool call arguments (assistant tool calls carry prompt-derived data)."""
    if not tool_calls:
        return
    for tool_call in tool_calls:
        function = getattr(tool_call, "function", None)
        if function is not None and hasattr(function, "arguments"):
            function.arguments = REDACTED_BY_DEROUTER


def _redact_function_call(function_call) -> None:
    """Redact legacy assistant function_call arguments."""
    if function_call is not None and hasattr(function_call, "arguments"):
        function_call.arguments = REDACTED_BY_DEROUTER


def _redact_choice_content(choice):
    """Helper to redact content in a choice (message or delta)."""
    if isinstance(choice, derouter.Choices):
        if choice.message.content is not None:
            choice.message.content = REDACTED_BY_DEROUTER
        if getattr(choice.message, "reasoning_content", None) is not None:
            choice.message.reasoning_content = REDACTED_BY_DEROUTER
        if hasattr(choice.message, "thinking_blocks"):
            choice.message.thinking_blocks = None
        _redact_tool_calls(getattr(choice.message, "tool_calls", None))
        _redact_function_call(getattr(choice.message, "function_call", None))
    elif isinstance(choice, derouter.utils.StreamingChoices):
        if choice.delta.content is not None:
            choice.delta.content = REDACTED_BY_DEROUTER
        if getattr(choice.delta, "reasoning_content", None) is not None:
            choice.delta.reasoning_content = REDACTED_BY_DEROUTER
        if hasattr(choice.delta, "thinking_blocks"):
            choice.delta.thinking_blocks = None
        _redact_tool_calls(getattr(choice.delta, "tool_calls", None))
        _redact_function_call(getattr(choice.delta, "function_call", None))


def _redact_responses_api_output(output_items):
    """Helper to redact ResponsesAPIResponse output items."""
    for output_item in output_items:
        if getattr(output_item, "text", None) is not None:
            output_item.text = REDACTED_BY_DEROUTER

        if hasattr(output_item, "content") and isinstance(output_item.content, list):
            for content_part in output_item.content:
                if getattr(content_part, "text", None) is not None:
                    content_part.text = REDACTED_BY_DEROUTER

        # Redact reasoning items in output array
        if hasattr(output_item, "type") and output_item.type == "reasoning":
            if hasattr(output_item, "summary") and isinstance(output_item.summary, list):
                for summary_item in output_item.summary:
                    if getattr(summary_item, "text", None) is not None:
                        summary_item.text = REDACTED_BY_DEROUTER

        if hasattr(output_item, "type") and output_item.type == "function_call" and hasattr(output_item, "arguments"):
            output_item.arguments = REDACTED_BY_DEROUTER


def _redact_responses_api_output_dict(output_items, redacted_str: str):
    """Helper to redact ResponsesAPIResponse output items in dict form."""
    for output_item in output_items:
        if not isinstance(output_item, dict):
            continue

        if output_item.get("text") is not None:
            output_item["text"] = redacted_str

        if isinstance(output_item.get("content"), list):
            for content_item in output_item["content"]:
                if isinstance(content_item, dict) and content_item.get("text") is not None:
                    content_item["text"] = redacted_str

        if output_item.get("type") == "reasoning" and isinstance(output_item.get("summary"), list):
            for summary_item in output_item["summary"]:
                if isinstance(summary_item, dict) and summary_item.get("text") is not None:
                    summary_item["text"] = redacted_str

        if output_item.get("type") == "function_call" and "arguments" in output_item:
            output_item["arguments"] = redacted_str


def _redact_standard_logging_object(model_call_details: dict):
    """Redact messages and response inside standard_logging_object if present."""
    standard_logging_object: Final = model_call_details.get("standard_logging_object")
    if standard_logging_object is None:
        return

    redacted_str: Final = REDACTED_BY_DEROUTER

    if standard_logging_object.get("messages") is not None:
        standard_logging_object["messages"] = [{"role": "user", "content": redacted_str}]

    response: Final = standard_logging_object.get("response")
    if response is not None:
        if isinstance(response, dict) and "output" in response:
            # ResponsesAPIResponse format - redact content in output items
            if isinstance(response.get("output"), list):
                _redact_responses_api_output_dict(response["output"], redacted_str)
            redact_vertex_ai_metadata_from_logged_object(response)
        elif isinstance(response, dict) and "choices" in response:
            # ModelResponse dict format - redact content in choices
            if isinstance(response.get("choices"), list):
                _redact_model_response_dict_choices(response["choices"], redacted_str)
            redact_vertex_ai_metadata_from_logged_object(response)
        elif isinstance(response, str):
            standard_logging_object["response"] = redacted_str
        else:
            # For other formats (empty dict, None, etc.), use simple text format
            standard_logging_object["response"] = {"text": redacted_str}


def _redact_tool_calls_dict(message: Mapping[str, object]) -> None:
    """Redact tool call / function_call arguments in a dict-form message or delta."""
    tool_calls: Final = message.get("tool_calls")
    if isinstance(tool_calls, list):
        for tool_call in tool_calls:
            if isinstance(tool_call, dict) and isinstance(tool_call.get("function"), dict):
                tool_call["function"]["arguments"] = REDACTED_BY_DEROUTER

    function_call: Final = message.get("function_call")
    if isinstance(function_call, dict) and "arguments" in function_call:
        function_call["arguments"] = REDACTED_BY_DEROUTER


def _redact_model_response_dict_choices(choices, redacted_str: str):
    for choice in choices:
        if isinstance(choice, dict):
            if "message" in choice and isinstance(choice["message"], dict):
                if choice["message"].get("content") is not None:
                    choice["message"]["content"] = redacted_str
                if choice["message"].get("reasoning_content") is not None:
                    choice["message"]["reasoning_content"] = redacted_str
                if "thinking_blocks" in choice["message"]:
                    choice["message"]["thinking_blocks"] = None
                if "audio" in choice["message"]:
                    choice["message"]["audio"] = None
                _redact_tool_calls_dict(choice["message"])
            elif "delta" in choice and isinstance(choice["delta"], dict):
                if choice["delta"].get("content") is not None:
                    choice["delta"]["content"] = redacted_str
                if choice["delta"].get("reasoning_content") is not None:
                    choice["delta"]["reasoning_content"] = redacted_str
                if "thinking_blocks" in choice["delta"]:
                    choice["delta"]["thinking_blocks"] = None
                if "audio" in choice["delta"]:
                    choice["delta"]["audio"] = None
                _redact_tool_calls_dict(choice["delta"])
        else:
            _redact_choice_content(choice)


def perform_redaction(model_call_details: dict, result, redact_streaming_responses: bool = True):
    """
    Performs the actual redaction on the logging object and result.

    redact_streaming_responses=False skips the in-place redaction of the shared streaming
    response entries; per-callback redaction hands each opted-out callback its own redacted
    copy via redact_streaming_responses_for_custom_logger instead.
    """
    # Redact model_call_details
    model_call_details["messages"] = [{"role": "user", "content": REDACTED_BY_DEROUTER}]
    model_call_details["prompt"] = ""
    model_call_details["input"] = ""
    _redact_standard_logging_object(model_call_details)
    redact_vertex_ai_metadata_from_derouter_params(model_call_details)

    # Redact streaming response
    if redact_streaming_responses and model_call_details.get("stream", False) is True:
        for _streaming_key in ("complete_streaming_response", "async_complete_streaming_response"):
            _redact_streaming_response(model_call_details.get(_streaming_key))

    # Redact result
    if result is not None:
        # Check if result is a coroutine, async generator, or other async object - these cannot be deepcopied
        if (
            asyncio.iscoroutine(result)
            or inspect.iscoroutinefunction(result)
            or hasattr(result, "__aiter__")
            or hasattr(result, "__anext__")  # async generator
        ):  # async iterator
            # For async objects, return a simple redacted response without deepcopy
            return {"text": REDACTED_BY_DEROUTER}

        if not (
            isinstance(result, (derouter.ModelResponse, derouter.ResponsesAPIResponse, derouter.EmbeddingResponse))
            or (isinstance(result, dict) and ("choices" in result or "output" in result))
        ):
            return {"text": REDACTED_BY_DEROUTER}

        _result: Final = copy.deepcopy(result)
        if isinstance(_result, derouter.ModelResponse):
            if hasattr(_result, "choices") and _result.choices is not None:
                for choice in _result.choices:
                    _redact_choice_content(choice)
            redact_vertex_ai_metadata_from_logged_object(_result)
        elif isinstance(_result, dict) and "choices" in _result:
            # Handle dict representation of ModelResponse (e.g., from model_dump())
            if _result.get("choices") is not None:
                _redact_model_response_dict_choices(_result["choices"], REDACTED_BY_DEROUTER)
            redact_vertex_ai_metadata_from_logged_object(_result)
        elif isinstance(_result, dict) and "output" in _result:
            if isinstance(_result.get("output"), list):
                _redact_responses_api_output_dict(_result["output"], REDACTED_BY_DEROUTER)
        elif isinstance(_result, derouter.ResponsesAPIResponse):
            if hasattr(_result, "output"):
                _redact_responses_api_output(_result.output)
            # Redact reasoning field in ResponsesAPIResponse
            if hasattr(_result, "reasoning") and _result.reasoning is not None:
                _result.reasoning = None
        elif isinstance(_result, derouter.EmbeddingResponse):
            if hasattr(_result, "data") and _result.data is not None:
                _result.data = []
        else:
            return {"text": REDACTED_BY_DEROUTER}
        return _result


def should_redact_message_logging(model_call_details: dict) -> bool:
    """
    Determine if message logging should be redacted.

    Priority order:
    1. Dynamic parameter (turn_off_message_logging in request)
    2. Headers (derouter-disable-message-redaction / derouter-enable-message-redaction)
    3. Global setting (derouter.turn_off_message_logging)
    """
    derouter_params: Final = model_call_details.get("derouter_params", {})

    metadata_field: Final = get_metadata_variable_name_from_kwargs(derouter_params)
    metadata = derouter_params.get(metadata_field, {})
    if not isinstance(metadata, dict):
        # Fall back: derouter_metadata was None, try metadata
        metadata = derouter_params.get("metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}

    # Get headers from the metadata
    request_headers: Final = metadata.get("headers", {})

    # Check for headers that explicitly control redaction
    if request_headers and bool(request_headers.get("derouter-disable-message-redaction", False)):
        # User explicitly disabled redaction via header
        return False

    possible_enable_headers: Final = [
        "derouter-enable-message-redaction",  # old header. maintain backwards compatibility
        "x-derouter-enable-message-redaction",  # new header
    ]

    is_redaction_enabled_via_header = False
    for header in possible_enable_headers:
        if bool(request_headers.get(header, False)):
            is_redaction_enabled_via_header = True
            break

    # Priority 1: Check dynamic parameter first (if explicitly set)
    dynamic_turn_off: Final = _get_turn_off_message_logging_from_dynamic_params(model_call_details)
    if dynamic_turn_off is not None:
        # Dynamic parameter is explicitly set, use it
        return dynamic_turn_off

    # Priority 2: Check if header explicitly enables redaction
    if is_redaction_enabled_via_header:
        return True

    # Priority 3: Fall back to global setting
    return derouter.turn_off_message_logging is True


def redact_message_input_output_from_logging(model_call_details: dict, result, input: Any | None = None) -> Any:
    """
    Removes messages, prompts, input, response from logging. This modifies the data in-place
    only redacts when derouter.turn_off_message_logging == True
    """
    if should_redact_message_logging(model_call_details):
        return perform_redaction(model_call_details, result)
    return result


def _get_turn_off_message_logging_from_dynamic_params(
    model_call_details: dict,
) -> bool | None:
    """
    gets the value of `turn_off_message_logging` from the dynamic params, if it exists.

    handles boolean and string values of `turn_off_message_logging`
    """
    standard_callback_dynamic_params: Final[StandardCallbackDynamicParams | None] = model_call_details.get(
        "standard_callback_dynamic_params", None
    )
    if standard_callback_dynamic_params:
        _turn_off_message_logging: Final = standard_callback_dynamic_params.get("turn_off_message_logging")
        if isinstance(_turn_off_message_logging, bool):
            return _turn_off_message_logging
        elif isinstance(_turn_off_message_logging, str):
            return str_to_bool(_turn_off_message_logging)
    return None


def redact_user_api_key_info(metadata: dict) -> dict:
    """
    removes any user_api_key_info before passing to logging object, if flag set

    Usage:

    SDK
    ```python
    derouter.redact_user_api_key_info = True
    ```

    PROXY:
    ```yaml
    derouter_settings:
        redact_user_api_key_info: true
    ```
    """
    if derouter.redact_user_api_key_info is not True:
        return metadata

    new_metadata: Final = {}
    for k, v in metadata.items():
        if isinstance(k, str) and k.startswith("user_api_key"):
            pass
        else:
            new_metadata[k] = v

    return new_metadata
