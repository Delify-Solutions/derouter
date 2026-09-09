# What is this?
## Unit Tests for guardrails config
import asyncio
import inspect
import time
import traceback
from derouter._uuid import uuid
from datetime import datetime

import pytest
from pydantic import BaseModel

import derouter.derouter_core_utils
import derouter.derouter_core_utils.derouter_logging

from typing import Any, List, Literal, Optional, Tuple, Union
from unittest.mock import AsyncMock, MagicMock, patch

import derouter
from derouter import Cache, completion, embedding
from derouter.integrations.custom_logger import CustomLogger
from derouter.types.utils import DeRouterCommonStrings


class CustomLoggingIntegration(CustomLogger):
    def __init__(self) -> None:
        super().__init__()

    def logging_hook(
        self, kwargs: dict, result: Any, call_type: str
    ) -> Tuple[dict, Any]:
        input: Optional[Any] = kwargs.get("input", None)
        messages: Optional[List] = kwargs.get("messages", None)
        if call_type == "completion":
            # assume input is of type messages
            if input is not None and isinstance(input, list):
                input[0]["content"] = "Hey, my name is [NAME]."
            if messages is not None and isinstance(messages, List):
                messages[0]["content"] = "Hey, my name is [NAME]."

            kwargs["input"] = input
            kwargs["messages"] = messages
        return kwargs, result


def test_guardrail_masking_logging_only():
    """
    Assert response is unmasked.

    Assert logged response is masked.
    """
    callback = CustomLoggingIntegration()

    with patch.object(callback, "log_success_event", new=MagicMock()) as mock_call:
        derouter.callbacks = [callback]
        messages = [{"role": "user", "content": "Hey, my name is Peter."}]
        response = completion(
            model="gpt-5-mini", messages=messages, mock_response="Hi Peter!"
        )

        assert response.choices[0].message.content == "Hi Peter!"  # type: ignore

        time.sleep(3)
        mock_call.assert_called_once()

        print(mock_call.call_args.kwargs["kwargs"]["messages"][0]["content"])

        assert (
            mock_call.call_args.kwargs["kwargs"]["messages"][0]["content"]
            == "Hey, my name is [NAME]."
        )


def test_guardrail_list_of_event_hooks():
    from derouter.integrations.custom_guardrail import CustomGuardrail
    from derouter.types.guardrails import GuardrailEventHooks

    cg = CustomGuardrail(
        guardrail_name="custom-guard", event_hook=["pre_call", "post_call"]
    )

    data = {"model": "gpt-5-mini", "metadata": {"guardrails": ["custom-guard"]}}
    assert cg.should_run_guardrail(data=data, event_type=GuardrailEventHooks.pre_call)

    assert cg.should_run_guardrail(data=data, event_type=GuardrailEventHooks.post_call)

    assert not cg.should_run_guardrail(
        data=data, event_type=GuardrailEventHooks.during_call
    )


def test_guardrail_info_response():
    from derouter.types.guardrails import (
        GuardrailInfoResponse,
        LitellmParams,
    )

    guardrail_info = GuardrailInfoResponse(
        guardrail_name="aporia-pre-guard",
        derouter_params=LitellmParams(
            guardrail="aporia",
            mode="pre_call",
        ),
        guardrail_info={
            "guardrail_name": "aporia-pre-guard",
            "derouter_params": {
                "guardrail": "aporia",
                "mode": "always_on",
            },
        },
    )

    assert guardrail_info.derouter_params.default_on == False
