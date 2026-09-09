"""
Tests for derouter.derouter_core_utils.redact_messages.should_redact_message_logging

Covers the proxy flow where headers arrive in derouter_params["metadata"]["headers"]
but derouter_params["derouter_metadata"] is None.
"""

import threading
from types import SimpleNamespace

import pytest

import derouter
from derouter.integrations.custom_logger import CustomLogger
from derouter.derouter_core_utils.redact_messages import (
    _redact_responses_api_output,
    perform_redaction,
    redact_streaming_responses_for_custom_logger,
    should_redact_message_logging,
)
from derouter.responses.main import mock_responses_api_response


@pytest.fixture(autouse=True)
def _reset_global_redaction():
    """Ensure the global setting is off for every test."""
    original = derouter.turn_off_message_logging
    derouter.turn_off_message_logging = False
    yield
    derouter.turn_off_message_logging = original


def _make_model_call_details(
    metadata_headers=None,
    derouter_metadata=None,
    metadata=None,
    standard_callback_dynamic_params=None,
):
    """Build a model_call_details dict that mimics real proxy/SDK flows."""
    derouter_params = {}
    if metadata is not None:
        derouter_params["metadata"] = metadata
    elif metadata_headers is not None:
        derouter_params["metadata"] = {"headers": metadata_headers}
    else:
        derouter_params["metadata"] = {}

    # get_derouter_params always sets this key (even when value is None)
    derouter_params["derouter_metadata"] = derouter_metadata

    details = {"derouter_params": derouter_params}
    if standard_callback_dynamic_params is not None:
        details["standard_callback_dynamic_params"] = standard_callback_dynamic_params
    return details


class TestShouldRedactMessageLogging:
    """Unit tests for should_redact_message_logging()."""

    # ---- proxy flow: headers in metadata, derouter_metadata is None ----

    def test_enable_redaction_via_x_header_proxy_flow(self):
        """x-derouter-enable-message-redaction header should enable redaction
        even when derouter_metadata is None (proxy path)."""
        details = _make_model_call_details(
            metadata_headers={"x-derouter-enable-message-redaction": "true"},
            derouter_metadata=None,
        )
        assert should_redact_message_logging(details) is True

    def test_enable_redaction_via_old_header_proxy_flow(self):
        """derouter-enable-message-redaction header should enable redaction
        even when derouter_metadata is None (proxy path)."""
        details = _make_model_call_details(
            metadata_headers={"derouter-enable-message-redaction": "true"},
            derouter_metadata=None,
        )
        assert should_redact_message_logging(details) is True

    def test_disable_redaction_via_header_proxy_flow(self):
        """Core helper still honors the explicit disable-redaction header."""
        derouter.turn_off_message_logging = True
        details = _make_model_call_details(
            metadata_headers={"derouter-disable-message-redaction": "true"},
            derouter_metadata=None,
        )
        assert should_redact_message_logging(details) is False

    def test_disable_redaction_via_header_when_global_off(self):
        """derouter-disable-message-redaction is still honored when global redaction is off."""
        details = _make_model_call_details(
            metadata_headers={"derouter-disable-message-redaction": "true"},
            derouter_metadata=None,
        )
        assert should_redact_message_logging(details) is False

    # ---- SDK direct-call flow: headers in derouter_metadata ----

    def test_enable_redaction_via_header_in_derouter_metadata(self):
        """Headers inside derouter_metadata (SDK direct call) should work."""
        details = _make_model_call_details(
            derouter_metadata={
                "headers": {"x-derouter-enable-message-redaction": "true"}
            },
        )
        assert should_redact_message_logging(details) is True

    # ---- no headers at all ----

    def test_no_headers_defaults_to_global_off(self):
        """Without headers, falls back to global setting (False)."""
        details = _make_model_call_details(
            metadata_headers=None,
            derouter_metadata=None,
        )
        assert should_redact_message_logging(details) is False

    def test_no_headers_global_on(self):
        """Without headers, respects global turn_off_message_logging=True."""
        derouter.turn_off_message_logging = True
        details = _make_model_call_details(
            metadata_headers=None,
            derouter_metadata=None,
        )
        assert should_redact_message_logging(details) is True

    # ---- dynamic params take precedence ----

    def test_dynamic_param_enables_redaction(self):
        """Dynamic turn_off_message_logging=True should enable redaction."""
        details = _make_model_call_details(
            metadata_headers={},
            derouter_metadata=None,
            standard_callback_dynamic_params={"turn_off_message_logging": True},
        )
        assert should_redact_message_logging(details) is True

    def test_dynamic_param_false_overrides_header(self):
        """Dynamic turn_off_message_logging=False should take precedence over enable header."""
        details = _make_model_call_details(
            metadata_headers={"x-derouter-enable-message-redaction": "true"},
            derouter_metadata=None,
            standard_callback_dynamic_params={"turn_off_message_logging": False},
        )
        assert should_redact_message_logging(details) is False

    def test_dynamic_param_false_overrides_global_redaction(self):
        """Dynamic turn_off_message_logging=False should take precedence."""
        derouter.turn_off_message_logging = True
        details = _make_model_call_details(
            metadata_headers={},
            derouter_metadata=None,
            standard_callback_dynamic_params={"turn_off_message_logging": False},
        )
        assert should_redact_message_logging(details) is False

    # ---- non-dict metadata safety ----

    def test_both_metadata_fields_none(self):
        """When both derouter_metadata and metadata are None, should not raise."""
        details = _make_model_call_details(
            metadata=None,
            derouter_metadata=None,
        )
        assert should_redact_message_logging(details) is False

    def test_both_metadata_fields_none_global_on(self):
        """When both metadata fields are None but global is on, should still return True."""
        derouter.turn_off_message_logging = True
        details = _make_model_call_details(
            metadata=None,
            derouter_metadata=None,
        )
        assert should_redact_message_logging(details) is True


class TestPerformRedaction:
    def test_redacts_standard_logging_and_responses_api_dicts(self):
        details = {
            "messages": [{"role": "user", "content": "sensitive input"}],
            "prompt": "sensitive prompt",
            "input": "sensitive input",
            "standard_logging_object": {
                "messages": [{"role": "user", "content": "sensitive input"}],
                "response": {
                    "output": [
                        {"text": "top-level text"},
                        {"content": [{"text": "nested text"}]},
                        {"type": "reasoning", "summary": [{"text": "reasoning"}]},
                    ],
                    "usage": {"total_tokens": 1},
                },
            },
        }
        result = {
            "output": [
                {"text": "top-level result"},
                {"content": [{"text": "nested result"}]},
                {"type": "reasoning", "summary": [{"text": "reasoning result"}]},
            ],
            "usage": {"total_tokens": 1},
        }

        redacted = perform_redaction(details, result)

        assert details["messages"] == [
            {"role": "user", "content": "redacted-by-derouter"}
        ]
        assert details["prompt"] == ""
        assert details["input"] == ""

        logged_response = details["standard_logging_object"]["response"]
        assert logged_response["usage"] == {"total_tokens": 1}
        assert logged_response["output"][0]["text"] == "redacted-by-derouter"
        assert logged_response["output"][1]["content"][0]["text"] == (
            "redacted-by-derouter"
        )
        assert logged_response["output"][2]["summary"][0]["text"] == (
            "redacted-by-derouter"
        )

        assert redacted["usage"] == {"total_tokens": 1}
        assert redacted["output"][0]["text"] == "redacted-by-derouter"
        assert redacted["output"][1]["content"][0]["text"] == "redacted-by-derouter"
        assert redacted["output"][2]["summary"][0]["text"] == "redacted-by-derouter"
        assert result["output"][0]["text"] == "top-level result"

    def test_redacts_model_response_dict_choices(self):
        result = {
            "choices": [
                {
                    "message": {
                        "content": "message content",
                        "reasoning_content": "message reasoning",
                        "thinking_blocks": ["thinking"],
                        "audio": {"data": "audio"},
                    }
                },
                {
                    "delta": {
                        "content": "delta content",
                        "reasoning_content": "delta reasoning",
                        "thinking_blocks": ["delta thinking"],
                        "audio": {"data": "audio"},
                    }
                },
            ]
        }

        redacted = perform_redaction({}, result)

        message = redacted["choices"][0]["message"]
        assert message["content"] == "redacted-by-derouter"
        assert message["reasoning_content"] == "redacted-by-derouter"
        assert message["thinking_blocks"] is None
        assert message["audio"] is None

        delta = redacted["choices"][1]["delta"]
        assert delta["content"] == "redacted-by-derouter"
        assert delta["reasoning_content"] == "redacted-by-derouter"
        assert delta["thinking_blocks"] is None
        assert delta["audio"] is None

    def test_redacts_standard_logging_model_response_dict_choices(self):
        details = {
            "standard_logging_object": {
                "response": {
                    "choices": [
                        {
                            "message": {
                                "content": "message content",
                                "reasoning_content": "message reasoning",
                                "thinking_blocks": ["thinking"],
                                "audio": {"data": "audio"},
                            }
                        },
                        {
                            "delta": {
                                "content": "delta content",
                                "reasoning_content": "delta reasoning",
                                "thinking_blocks": ["delta thinking"],
                                "audio": {"data": "audio"},
                            }
                        },
                    ]
                }
            }
        }

        perform_redaction(details, None)

        choices = details["standard_logging_object"]["response"]["choices"]
        message = choices[0]["message"]
        assert message["content"] == "redacted-by-derouter"
        assert message["reasoning_content"] == "redacted-by-derouter"
        assert message["thinking_blocks"] is None
        assert message["audio"] is None

        delta = choices[1]["delta"]
        assert delta["content"] == "redacted-by-derouter"
        assert delta["reasoning_content"] == "redacted-by-derouter"
        assert delta["thinking_blocks"] is None
        assert delta["audio"] is None

    def test_redacts_object_choices_inside_model_response_dict(self):
        result = {
            "choices": [
                derouter.Choices(
                    message=derouter.Message(
                        content="message content",
                        role="assistant",
                        reasoning_content="message reasoning",
                    )
                )
            ]
        }

        redacted = perform_redaction({}, result)

        choice = redacted["choices"][0]
        assert choice.message.content == "redacted-by-derouter"
        assert choice.message.reasoning_content == "redacted-by-derouter"

    def test_redacts_tool_call_arguments_in_model_response_dict(self):
        """Assistant tool call arguments must not leak when redaction is on."""
        result = {
            "choices": [
                {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "get_weather",
                                    "arguments": '{"city": "sensitive-city"}',
                                },
                            }
                        ],
                        "function_call": {
                            "name": "get_weather",
                            "arguments": '{"city": "sensitive-city"}',
                        },
                    }
                }
            ]
        }

        redacted = perform_redaction({}, result)

        message = redacted["choices"][0]["message"]
        assert message["content"] is None
        tool_call = message["tool_calls"][0]
        assert tool_call["function"]["arguments"] == "redacted-by-derouter"
        assert tool_call["function"]["name"] == "get_weather"
        assert message["function_call"]["arguments"] == "redacted-by-derouter"

    def test_redacts_tool_call_arguments_in_streaming_delta_dict(self):
        result = {
            "choices": [
                {
                    "delta": {
                        "content": None,
                        "tool_calls": [
                            {
                                "index": 0,
                                "function": {
                                    "name": "get_weather",
                                    "arguments": '{"city": "sensitive-city"}',
                                },
                            }
                        ],
                    }
                }
            ]
        }

        redacted = perform_redaction({}, result)

        delta = redacted["choices"][0]["delta"]
        assert delta["tool_calls"][0]["function"]["arguments"] == "redacted-by-derouter"

    def test_redacts_tool_call_arguments_on_model_response_object(self):
        result = derouter.ModelResponse(
            id="resp-1",
            choices=[
                derouter.Choices(
                    message=derouter.Message(
                        content=None,
                        role="assistant",
                        tool_calls=[
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "get_weather",
                                    "arguments": '{"city": "sensitive-city"}',
                                },
                            }
                        ],
                    )
                )
            ],
            model="gpt-4o",
        )

        redacted = perform_redaction({}, result)

        tool_call = redacted.choices[0].message.tool_calls[0]
        assert tool_call.function.arguments == "redacted-by-derouter"
        assert tool_call.function.name == "get_weather"
        assert result.choices[0].message.tool_calls[0].function.arguments == (
            '{"city": "sensitive-city"}'
        )

    def test_redacts_tool_call_arguments_on_streaming_response_object(self):
        """Reproduces the Stream=True path where tool calls arrive as deltas."""
        streaming_choice = derouter.utils.StreamingChoices(
            delta=derouter.utils.Delta(
                content=None,
                role="assistant",
                tool_calls=[
                    {
                        "index": 0,
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": '{"city": "sensitive-city"}',
                        },
                    }
                ],
            )
        )
        streaming_response = SimpleNamespace(choices=[streaming_choice])
        details = {
            "stream": True,
            "complete_streaming_response": streaming_response,
        }

        perform_redaction(details, None)

        tool_call = streaming_response.choices[0].delta.tool_calls[0]
        assert tool_call.function.arguments == "redacted-by-derouter"

    def test_redacts_tool_call_arguments_in_standard_logging_object(self):
        details = {
            "standard_logging_object": {
                "response": {
                    "choices": [
                        {
                            "message": {
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {
                                            "name": "get_weather",
                                            "arguments": '{"city": "sensitive-city"}',
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                }
            }
        }

        perform_redaction(details, None)

        message = details["standard_logging_object"]["response"]["choices"][0]["message"]
        assert message["tool_calls"][0]["function"]["arguments"] == "redacted-by-derouter"

    def test_redacts_responses_api_function_call_arguments_dict(self):
        result = {
            "output": [
                {
                    "type": "function_call",
                    "name": "get_weather",
                    "arguments": '{"city": "sensitive-city"}',
                    "call_id": "call_1",
                }
            ]
        }

        redacted = perform_redaction({}, result)

        assert redacted["output"][0]["arguments"] == "redacted-by-derouter"
        assert redacted["output"][0]["name"] == "get_weather"

    def test_redacts_every_tool_call_in_multi_element_list(self):
        result = derouter.ModelResponse(
            id="resp-multi",
            choices=[
                derouter.Choices(
                    message=derouter.Message(
                        content=None,
                        role="assistant",
                        tool_calls=[
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {"name": "get_weather", "arguments": '{"city": "a"}'},
                            },
                            {
                                "id": "call_2",
                                "type": "function",
                                "function": {"name": "get_time", "arguments": '{"tz": "b"}'},
                            },
                        ],
                    )
                )
            ],
            model="gpt-4o",
        )

        redacted = perform_redaction({}, result)

        tool_calls = redacted.choices[0].message.tool_calls
        assert tool_calls[0].function.arguments == "redacted-by-derouter"
        assert tool_calls[1].function.arguments == "redacted-by-derouter"

    def test_preserves_none_content_on_tool_call_only_message(self):
        result = derouter.ModelResponse(
            id="resp-none",
            choices=[
                derouter.Choices(
                    message=derouter.Message(
                        content=None,
                        role="assistant",
                        tool_calls=[
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {"name": "get_weather", "arguments": '{"city": "a"}'},
                            }
                        ],
                    )
                )
            ],
            model="gpt-4o",
        )

        redacted = perform_redaction({}, result)

        assert redacted.choices[0].message.content is None

    def test_redacts_responses_api_function_call_arguments_object(self):
        output_item = SimpleNamespace(
            type="function_call",
            name="get_weather",
            arguments='{"city": "sensitive-city"}',
            call_id="call_1",
        )

        _redact_responses_api_output([output_item])

        assert output_item.arguments == "redacted-by-derouter"
        assert output_item.name == "get_weather"

    def test_redacts_response_output_objects_with_top_level_text(self):
        output_items = [
            SimpleNamespace(text="top-level output"),
            "non-dict output item",
        ]

        _redact_responses_api_output(output_items)

        assert output_items[0].text == "redacted-by-derouter"
        assert output_items[1] == "non-dict output item"

    def test_preserves_none_text_in_responses_output(self):
        from derouter.derouter_core_utils.redact_messages import _redact_responses_api_output_dict

        none_item = SimpleNamespace(type="output_text", text=None, content=[SimpleNamespace(text=None)])
        real_item = SimpleNamespace(type="output_text", text="real answer", content=[SimpleNamespace(text="real part")])

        _redact_responses_api_output([none_item, real_item])

        assert none_item.text is None
        assert none_item.content[0].text is None
        assert real_item.text == "redacted-by-derouter"
        assert real_item.content[0].text == "redacted-by-derouter"

        none_dict = {"type": "output_text", "text": None, "content": [{"text": None}]}
        real_dict = {"type": "output_text", "text": "real answer", "content": [{"text": "real part"}]}

        _redact_responses_api_output_dict([none_dict, real_dict], "redacted-by-derouter")

        assert none_dict["text"] is None
        assert none_dict["content"][0]["text"] is None
        assert real_dict["text"] == "redacted-by-derouter"
        assert real_dict["content"][0]["text"] == "redacted-by-derouter"

    def test_skips_non_dict_response_output_items(self):
        result = {
            "output": [
                "non-dict output item",
                {"content": [{"text": "nested result"}]},
            ]
        }

        redacted = perform_redaction({}, result)

        assert redacted["output"][0] == "non-dict output item"
        assert redacted["output"][1]["content"][0]["text"] == "redacted-by-derouter"

    def test_redacts_responses_api_response_object(self):
        response = mock_responses_api_response("sensitive output")

        redacted = perform_redaction({}, response)

        assert redacted.output[0].content[0].text == "redacted-by-derouter"
        assert response.output[0].content[0].text == "sensitive output"

    def test_redacts_vertex_provider_metadata_in_standard_logging_response(self):
        details = {
            "standard_logging_object": {
                "messages": [{"role": "user", "content": "sensitive prompt"}],
                "response": {
                    "choices": [
                        {
                            "message": {
                                "content": "sensitive answer",
                                "role": "assistant",
                            }
                        }
                    ],
                    "vertex_ai_grounding_metadata": [
                        {"webSearchQueries": ["sensitive search term"]}
                    ],
                    "vertex_ai_url_context_metadata": [
                        {"urlMetadata": [{"retrievedUrl": "https://example.com"}]}
                    ],
                },
            }
        }

        perform_redaction(details, None)

        response = details["standard_logging_object"]["response"]
        assert response["choices"][0]["message"]["content"] == "redacted-by-derouter"
        assert response["vertex_ai_grounding_metadata"] == []
        assert response["vertex_ai_url_context_metadata"] == []

    def test_redacts_vertex_provider_metadata_on_streaming_model_response(self):
        response = derouter.ModelResponse(
            id="resp-1",
            choices=[
                derouter.Choices(
                    message=derouter.Message(
                        content="sensitive answer",
                        role="assistant",
                    )
                )
            ],
            model="gemini-2.5-flash",
        )
        setattr(
            response,
            "vertex_ai_grounding_metadata",
            [{"webSearchQueries": ["sensitive search term"]}],
        )
        response._hidden_params["vertex_ai_grounding_metadata"] = [
            {"webSearchQueries": ["sensitive search term"]}
        ]

        details = {
            "stream": True,
            "complete_streaming_response": response,
        }

        perform_redaction(details, response)

        assert response.choices[0].message.content == "redacted-by-derouter"
        assert getattr(response, "vertex_ai_grounding_metadata") == []
        assert "vertex_ai_grounding_metadata" not in response._hidden_params

    def test_redacts_vertex_provider_metadata_from_metadata_hidden_params(self):
        """Streaming success_handler copies _hidden_params into metadata before redaction."""
        details = {
            "stream": True,
            "derouter_params": {
                "metadata": {
                    "hidden_params": {
                        "response_cost": 0.01,
                        "vertex_ai_grounding_metadata": [
                            {"webSearchQueries": ["sensitive search term"]}
                        ],
                        "vertex_ai_url_context_metadata": [
                            {"urlMetadata": [{"retrievedUrl": "https://example.com"}]}
                        ],
                        "vertex_ai_safety_ratings": [{"category": "HARM"}],
                        "vertex_ai_citation_metadata": [{"citations": ["source"]}],
                    }
                }
            },
        }

        perform_redaction(details, None)

        hidden_params = details["derouter_params"]["metadata"]["hidden_params"]
        assert hidden_params["response_cost"] == 0.01
        assert "vertex_ai_grounding_metadata" not in hidden_params
        assert "vertex_ai_url_context_metadata" not in hidden_params
        assert "vertex_ai_safety_ratings" not in hidden_params
        assert "vertex_ai_citation_metadata" not in hidden_params

    def test_redact_async_complete_streaming_response(self):
        """Test that async_complete_streaming_response is properly redacted."""
        response_obj = derouter.ModelResponse(
            choices=[
                derouter.Choices(
                    message=derouter.Message(content="secret content", role="assistant")
                )
            ]
        )

        model_call_details = {
            "messages": [{"role": "user", "content": "hi"}],
            "prompt": "hi",
            "input": "hi",
            "stream": True,
            "async_complete_streaming_response": response_obj,
        }

        perform_redaction(model_call_details, result=None)

        redacted_response = model_call_details["async_complete_streaming_response"]
        assert redacted_response.choices[0].message.content == "redacted-by-derouter"

    def test_redact_complete_streaming_response(self):
        """Test that complete_streaming_response is properly redacted."""
        response_obj = derouter.ModelResponse(
            choices=[
                derouter.Choices(
                    message=derouter.Message(content="secret content", role="assistant")
                )
            ]
        )

        model_call_details = {
            "messages": [{"role": "user", "content": "hi"}],
            "prompt": "hi",
            "input": "hi",
            "stream": True,
            "complete_streaming_response": response_obj,
        }

        perform_redaction(model_call_details, result=None)

        redacted_response = model_call_details["complete_streaming_response"]
        assert redacted_response.choices[0].message.content == "redacted-by-derouter"

    def test_streaming_responses_untouched_when_disabled(self):
        response_obj = derouter.ModelResponse(
            choices=[
                derouter.Choices(
                    message=derouter.Message(content="secret content", role="assistant")
                )
            ]
        )

        model_call_details = {
            "messages": [{"role": "user", "content": "hi"}],
            "prompt": "hi",
            "input": "hi",
            "stream": True,
            "async_complete_streaming_response": response_obj,
        }

        perform_redaction(model_call_details, result=None, redact_streaming_responses=False)

        assert response_obj.choices[0].message.content == "secret content"

    def test_unredactable_result_is_not_deepcopied(self):
        """A result shape no branch can redact must not be deepcopied.

        Binary/HTTP response bodies (batch output, file content, audio) hold an
        unpicklable ``_thread.lock``. Copying one raises TypeError inside
        ``Logging.success_handler``, which aborts the handler body at the redaction call so
        everything after it is skipped. The copy is also pointless: an unrecognized shape
        returns the placeholder and the copy is discarded.

        The lock is the assertion. If a deepcopy is ever reintroduced ahead of the type
        check, this raises instead of returning.
        """

        class _BinaryResponseBody:
            def __init__(self) -> None:
                self.text = "batch output bytes"
                self._client_lock = threading.Lock()

        body = _BinaryResponseBody()

        redacted = perform_redaction({"derouter_params": {}}, body)

        assert redacted == {"text": "redacted-by-derouter"}

    def test_recognized_shapes_still_redact_a_copy(self):
        """The type gate must not change behaviour for shapes that were already handled."""
        original = derouter.ModelResponse(
            choices=[derouter.Choices(message=derouter.Message(content="secret content", role="assistant"))]
        )

        redacted = perform_redaction({"derouter_params": {}}, original)

        assert redacted.choices[0].message.content == "redacted-by-derouter"
        assert original.choices[0].message.content == "secret content"

        embedding = derouter.EmbeddingResponse(data=[{"embedding": [1.0, 2.0]}])
        assert perform_redaction({"derouter_params": {}}, embedding).data == []

        as_dict = {"choices": [{"message": {"role": "assistant", "content": "secret content"}}]}
        assert (
            perform_redaction({"derouter_params": {}}, as_dict)["choices"][0]["message"]["content"]
            == "redacted-by-derouter"
        )


class TestRedactStreamingResponsesForCustomLogger:
    def _model_call_details(self):
        response_obj = derouter.ModelResponse(
            choices=[
                derouter.Choices(
                    message=derouter.Message(content="secret content", role="assistant")
                )
            ]
        )
        return {
            "stream": True,
            "async_complete_streaming_response": response_obj,
        }, response_obj

    def test_opted_out_logger_gets_redacted_copy(self):
        model_call_details, response_obj = self._model_call_details()
        opted_out_logger = CustomLogger(message_logging=False)

        redacted_details = redact_streaming_responses_for_custom_logger(
            model_call_details=model_call_details, custom_logger=opted_out_logger
        )

        redacted_response = redacted_details["async_complete_streaming_response"]
        assert redacted_response.choices[0].message.content == "redacted-by-derouter"
        assert response_obj.choices[0].message.content == "secret content"
        assert model_call_details["async_complete_streaming_response"] is response_obj

    def test_compliant_logger_gets_shared_response(self):
        model_call_details, response_obj = self._model_call_details()
        compliant_logger = CustomLogger()

        result_details = redact_streaming_responses_for_custom_logger(
            model_call_details=model_call_details, custom_logger=compliant_logger
        )

        assert result_details is model_call_details
        assert response_obj.choices[0].message.content == "secret content"
