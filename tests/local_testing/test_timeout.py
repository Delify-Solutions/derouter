#### What this tests ####
#    This tests the timeout decorator

import os
import traceback

import time
from derouter._uuid import uuid

import httpx
import openai
import pytest

import derouter
from tests.fake_openai_endpoint import FAKE_OPENAI_API_BASE


@pytest.mark.parametrize(
    "model, provider",
    [
        ("gpt-3.5-turbo", "openai"),
        ("azure/gpt-4.1-mini", "azure"),
    ],
)
@pytest.mark.parametrize("sync_mode", [True, False])
@pytest.mark.asyncio
async def test_httpx_timeout(model, provider, sync_mode):
    """
    Test if setting httpx.timeout works for completion calls
    """
    timeout_val = httpx.Timeout(10.0, connect=60.0)

    messages = [{"role": "user", "content": "Hey, how's it going?"}]

    if sync_mode:
        response = derouter.completion(
            model=model, messages=messages, timeout=timeout_val
        )
    else:
        response = await derouter.acompletion(
            model=model, messages=messages, timeout=timeout_val
        )

    print(f"response: {response}")


def test_timeout():
    # this Will Raise a timeout
    derouter.set_verbose = False
    try:
        response = derouter.completion(
            model="gpt-3.5-turbo",
            timeout=0.01,
            messages=[{"role": "user", "content": "hello, write a 20 pg essay"}],
        )
    except openai.APITimeoutError as e:
        print(
            "Passed: Raised correct exception. Got openai.APITimeoutError\nGood Job", e
        )
        print(type(e))
        pass
    except Exception as e:
        pytest.fail(
            f"Did not raise error `openai.APITimeoutError`. Instead raised error type: {type(e)}, Error: {e}"
        )


# test_timeout()


def test_bedrock_timeout():
    # this Will Raise a timeout
    derouter.set_verbose = True
    try:
        response = derouter.completion(
            model="bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
            timeout=0.01,
            messages=[{"role": "user", "content": "hello, write a 20 pg essay"}],
        )
        pytest.fail("Did not raise error `openai.APITimeoutError`")
    except openai.APITimeoutError as e:
        print(
            "Passed: Raised correct exception. Got openai.APITimeoutError\nGood Job", e
        )
        print(type(e))
        pass
    except Exception as e:
        pytest.fail(
            f"Did not raise error `openai.APITimeoutError`. Instead raised error type: {type(e)}, Error: {e}"
        )


def test_hanging_request_azure():
    """
    Test that a slow Azure request properly raises APITimeoutError via the Router.

    Uses a mock to simulate a slow HTTP response so the timeout fires reliably,
    rather than racing against real network latency.
    """
    derouter.set_verbose = True
    import asyncio
    from unittest.mock import AsyncMock, patch

    try:
        router = derouter.Router(
            model_list=[
                {
                    "model_name": "azure-gpt",
                    "derouter_params": {
                        "model": "azure/gpt-4.1-mini",
                        "api_base": os.environ["AZURE_AI_API_BASE"],
                        "api_key": os.environ["AZURE_AI_API_KEY"],
                    },
                },
                {
                    "model_name": "openai-gpt",
                    "derouter_params": {"model": "gpt-3.5-turbo"},
                },
            ],
            num_retries=0,
        )

        encoded = derouter.utils.encode(model="gpt-3.5-turbo", text="blue")[0]

        original_send = httpx.AsyncClient.send

        async def _slow_send(self, request, *args, **kwargs):
            await asyncio.sleep(5)
            return await original_send(self, request, *args, **kwargs)

        async def _test():
            with patch.object(httpx.AsyncClient, "send", new=_slow_send):
                response = await router.acompletion(
                    model="azure-gpt",
                    messages=[
                        {
                            "role": "user",
                            "content": f"what color is red {uuid.uuid4()}",
                        }
                    ],
                    logit_bias={encoded: 100},
                    timeout=0.01,
                )
                print(response)
                return response

        response = asyncio.run(_test())

        if response.choices[0].message.content is not None:
            pytest.fail("Got a response, expected a timeout")
    except openai.APITimeoutError as e:
        print(
            "Passed: Raised correct exception. Got openai.APITimeoutError\nGood Job", e
        )
        print(type(e))
        pass
    except Exception as e:
        pytest.fail(
            f"Did not raise error `openai.APITimeoutError`. Instead raised error type: {type(e)}, Error: {e}"
        )


# test_hanging_request_azure()


def test_hanging_request_openai():
    derouter.set_verbose = True
    try:
        router = derouter.Router(
            model_list=[
                {
                    "model_name": "azure-gpt",
                    "derouter_params": {
                        "model": "azure/gpt-4.1-mini",
                        "api_base": os.environ["AZURE_AI_API_BASE"],
                        "api_key": os.environ["AZURE_AI_API_KEY"],
                    },
                },
                {
                    "model_name": "openai-gpt",
                    "derouter_params": {"model": "gpt-3.5-turbo"},
                },
            ],
            num_retries=0,
        )

        encoded = derouter.utils.encode(model="gpt-3.5-turbo", text="blue")[0]
        response = router.completion(
            model="openai-gpt",
            messages=[{"role": "user", "content": "what color is red"}],
            logit_bias={encoded: 100},
            timeout=0.01,
        )
        print(response)

        if response.choices[0].message.content is not None:
            pytest.fail("Got a response, expected a timeout")
    except openai.APITimeoutError as e:
        print(
            "Passed: Raised correct exception. Got openai.APITimeoutError\nGood Job", e
        )
        print(type(e))
        pass
    except Exception as e:
        pytest.fail(
            f"Did not raise error `openai.APITimeoutError`. Instead raised error type: {type(e)}, Error: {e}"
        )


# test_hanging_request_openai()

# test_timeout()


def test_timeout_streaming():
    # this Will Raise a timeout
    derouter.set_verbose = False
    try:
        response = derouter.completion(
            model="openai/slow-endpoint",
            messages=[{"role": "user", "content": "hello, write a 20 pg essay"}],
            api_base=FAKE_OPENAI_API_BASE,
            api_key="fake-key",
            timeout=0.5,
            stream=True,
        )
        for chunk in response:
            print(chunk)
        pytest.fail("Did not raise error `openai.APITimeoutError`. The stream completed instead")
    except openai.APITimeoutError as e:
        print(
            "Passed: Raised correct exception. Got openai.APITimeoutError\nGood Job", e
        )
        print(type(e))
        pass
    except Exception as e:
        pytest.fail(
            f"Did not raise error `openai.APITimeoutError`. Instead raised error type: {type(e)}, Error: {e}"
        )


# test_timeout_streaming()


@pytest.mark.skip(reason="local test")
def test_timeout_ollama():
    # this Will Raise a timeout
    import derouter

    derouter.set_verbose = True
    try:
        derouter.request_timeout = 0.1
        derouter.set_verbose = True
        response = derouter.completion(
            model="ollama/phi",
            messages=[{"role": "user", "content": "hello, what llm are u"}],
            max_tokens=1,
            api_base="https://test-ollama-endpoint.onrender.com",
        )
        # Add any assertions here to check the response
        derouter.request_timeout = None
        print(response)
    except openai.APITimeoutError as e:
        print("got a timeout error! Passed ! ")
        pass


# test_timeout_ollama()


@pytest.mark.parametrize("streaming", [True, False])
@pytest.mark.parametrize("sync_mode", [True, False])
@pytest.mark.asyncio
async def test_anthropic_timeout(streaming, sync_mode):
    derouter.set_verbose = False

    try:
        if sync_mode:
            response = derouter.completion(
                model="claude-sonnet-4-5-20250929",
                timeout=0.01,
                messages=[{"role": "user", "content": "hello, write a 20 pg essay"}],
                stream=streaming,
            )
            if isinstance(response, derouter.CustomStreamWrapper):
                for chunk in response:
                    pass
        else:
            response = await derouter.acompletion(
                model="claude-sonnet-4-5-20250929",
                timeout=0.01,
                messages=[{"role": "user", "content": "hello, write a 20 pg essay"}],
                stream=streaming,
            )
            if isinstance(response, derouter.CustomStreamWrapper):
                async for chunk in response:
                    pass
        pytest.fail("Did not raise error `openai.APITimeoutError`")
    except openai.APITimeoutError as e:
        print(
            "Passed: Raised correct exception. Got openai.APITimeoutError\nGood Job", e
        )
        print(type(e))
        pass
