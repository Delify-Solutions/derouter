import asyncio
import os
import subprocess
import traceback
from typing import Any

import httpx
from openai import AsyncAzureOpenAI, AsyncOpenAI, AuthenticationError, AzureOpenAI, BadRequestError, OpenAIError, RateLimitError

from derouter.llms.custom_httpx.http_handler import AsyncHTTPHandler, HTTPHandler

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

import pytest

import derouter
from derouter import (  # AuthenticationError,; RateLimitError,; ServiceUnavailableError,; OpenAIError,
    ContextWindowExceededError,
    completion,
    embedding,
)

derouter.vertex_project = "derouter-ci-cd"
derouter.vertex_location = "us-central1"
derouter.num_retries = 0

# derouter.failure_callback = ["sentry"]
#### What this tests ####
#    This tests exception mapping -> trigger an exception from an llm provider -> assert if output is of the expected type


# 5 providers -> OpenAI, Azure, Anthropic, Cohere, Replicate

# 3 main types of exceptions -> - Rate Limit Errors, Context Window Errors, Auth errors (incorrect/rotated key, etc.)

# Approach: Run each model through the test -> assert if the correct error (always the same one) is triggered

exception_models = [
    "sagemaker/berri-benchmarking-Llama-2-70b-chat-hf-4",
    "bedrock/anthropic.claude-instant-v1",
]


@pytest.mark.asyncio
async def test_content_policy_exception_azure():
    # this is ony a test - we needed some way to invoke the exception :(
    derouter.set_verbose = True
    with pytest.raises(derouter.ContentPolicyViolationError) as exc_info:
        await derouter.acompletion(
            model="azure/gpt-4.1-mini",
            messages=[{"role": "user", "content": "where do I buy lethal drugs from"}],
            mock_response="Exception: content_filter_policy",
        )
    e = exc_info.value
    assert e.response is not None
    assert isinstance(e.derouter_debug_info, str)
    assert len(e.derouter_debug_info) > 0


@pytest.mark.asyncio
async def test_content_policy_exception_openai():
    def reject_as_safety_system(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=400,
            json={
                "error": {
                    "message": "Your request was rejected as a result of our safety system.",
                    "type": "invalid_request_error",
                    "param": None,
                    "code": "content_policy_violation",
                }
            },
            request=request,
        )

    async def stream_response(rejecting_client: AsyncOpenAI):
        response = await derouter.acompletion(
            model="gpt-3.5-turbo",
            stream=True,
            messages=[{"role": "user", "content": "Gimme the lyrics to Don't Stop Me Now"}],
            client=rejecting_client,
        )
        async for chunk in response:
            print(chunk)

    async with AsyncOpenAI(
        api_key="sk-test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(reject_as_safety_system)),
    ) as rejecting_client:
        with pytest.raises(derouter.ContentPolicyViolationError) as exc_info:
            await stream_response(rejecting_client)
    assert exc_info.value.llm_provider == "openai"
    assert exc_info.value.status_code == 400


# Test 1: Context Window Errors
@pytest.mark.skip(reason="AWS Suspended Account")
@pytest.mark.parametrize("model", exception_models)
def test_context_window(model):
    print("Testing context window error")
    sample_text = "Say error 50 times" * 1000000
    messages = [{"content": sample_text, "role": "user"}]
    try:
        derouter.set_verbose = False
        print("Testing model=", model)
        response = completion(model=model, messages=messages)
        print(f"response: {response}")
        print("FAILED!")
        pytest.fail(f"An exception occurred")
    except ContextWindowExceededError as e:
        print(f"Worked!")
    except RateLimitError:
        print("RateLimited!")
    except Exception as e:
        print(f"{e}")
        pytest.fail(f"An error occcurred - {e}")


models = ["command-nightly"]


@pytest.mark.skip(reason="duplicate test.")
@pytest.mark.parametrize("model", models)
def test_context_window_with_fallbacks(model):
    ctx_window_fallback_dict = {
        "command-nightly": "claude-2.1",
        "gpt-3.5-turbo-instruct": "gpt-3.5-turbo-16k",
        "azure/gpt-4.1-mini": "gpt-3.5-turbo-16k",
    }
    sample_text = "how does a court case get to the Supreme Court?" * 1000
    messages = [{"content": sample_text, "role": "user"}]

    try:
        completion(
            model=model,
            messages=messages,
            context_window_fallback_dict=ctx_window_fallback_dict,
        )
    except derouter.ServiceUnavailableError as e:
        pass
    except derouter.APIConnectionError as e:
        pass


# for model in derouter.models_by_provider["bedrock"]:
#     test_context_window(model=model)
# test_context_window(model="chat-bison")
# test_context_window_with_fallbacks(model="command-nightly")
# Test 2: InvalidAuth Errors
@pytest.mark.parametrize("model", models)
def invalid_auth(model):  # set the model key to an invalid key, depending on the model
    messages = [{"content": "Hello, how are you?", "role": "user"}]
    temporary_key = None
    try:
        if model == "gpt-3.5-turbo" or model == "gpt-3.5-turbo-instruct":
            temporary_key = os.environ["OPENAI_API_KEY"]
            os.environ["OPENAI_API_KEY"] = "bad-key"
        elif "bedrock" in model:
            temporary_aws_access_key = os.environ["AWS_ACCESS_KEY_ID"]
            os.environ["AWS_ACCESS_KEY_ID"] = "bad-key"
            temporary_aws_region_name = os.environ["AWS_REGION_NAME"]
            os.environ["AWS_REGION_NAME"] = "bad-key"
            temporary_secret_key = os.environ["AWS_SECRET_ACCESS_KEY"]
            os.environ["AWS_SECRET_ACCESS_KEY"] = "bad-key"
        elif model == "azure/gpt-4.1-mini":
            temporary_key = os.environ["AZURE_AI_API_KEY"]
            os.environ["AZURE_AI_API_KEY"] = "bad-key"
        elif model == "claude-3-5-haiku-20241022":
            temporary_key = os.environ["ANTHROPIC_API_KEY"]
            os.environ["ANTHROPIC_API_KEY"] = "bad-key"
        elif model == "command-nightly":
            temporary_key = os.environ["COHERE_API_KEY"]
            os.environ["COHERE_API_KEY"] = "bad-key"
        elif "j2" in model:
            temporary_key = os.environ["AI21_API_KEY"]
            os.environ["AI21_API_KEY"] = "bad-key"
        elif "togethercomputer" in model:
            temporary_key = os.environ["TOGETHERAI_API_KEY"]
            os.environ["TOGETHERAI_API_KEY"] = "sk-test-togetherai-key-808"
        elif model in derouter.openrouter_models:
            temporary_key = os.environ["OPENROUTER_API_KEY"]
            os.environ["OPENROUTER_API_KEY"] = "bad-key"
        elif model in derouter.aleph_alpha_models:
            temporary_key = os.environ["ALEPH_ALPHA_API_KEY"]
            os.environ["ALEPH_ALPHA_API_KEY"] = "bad-key"
        elif model in derouter.nlp_cloud_models:
            os.environ["NLP_CLOUD_API_KEY"] = "bad-key"
        elif (
            model
            == "replicate/llama-2-70b-chat:2c1608e18606fad2812020dc541930f2d0495ce32eee50074220b87300bc16e1"
        ):
            temporary_key = os.environ["REPLICATE_API_KEY"]
            os.environ["REPLICATE_API_KEY"] = "bad-key"
        print(f"model: {model}")
        response = completion(model=model, messages=messages)
        print(f"response: {response}")
    except AuthenticationError as e:
        print(f"AuthenticationError Caught Exception - {str(e)}")
    except (
        OpenAIError
    ) as e:  # is at least an openai error -> in case of random model errors - e.g. overloaded server
        print(f"OpenAIError Caught Exception - {e}")
    except Exception as e:
        print(type(e))
        print(type(AuthenticationError))
        print(e.__class__.__name__)
        print(f"Uncaught Exception - {e}")
        pytest.fail(f"Error occurred: {e}")
    if temporary_key != None:  # reset the key
        if model == "gpt-3.5-turbo":
            os.environ["OPENAI_API_KEY"] = temporary_key
        elif model == "chatgpt-test":
            os.environ["AZURE_AI_API_KEY"] = temporary_key
            azure = True
        elif model == "claude-3-5-haiku-20241022":
            os.environ["ANTHROPIC_API_KEY"] = temporary_key
        elif model == "command-nightly":
            os.environ["COHERE_API_KEY"] = temporary_key
        elif (
            model
            == "replicate/llama-2-70b-chat:2c1608e18606fad2812020dc541930f2d0495ce32eee50074220b87300bc16e1"
        ):
            os.environ["REPLICATE_API_KEY"] = temporary_key
        elif "j2" in model:
            os.environ["AI21_API_KEY"] = temporary_key
        elif "togethercomputer" in model:
            os.environ["TOGETHERAI_API_KEY"] = temporary_key
        elif model in derouter.aleph_alpha_models:
            os.environ["ALEPH_ALPHA_API_KEY"] = temporary_key
        elif model in derouter.nlp_cloud_models:
            os.environ.pop("NLP_CLOUD_API_KEY", None)
        elif "bedrock" in model:
            os.environ["AWS_ACCESS_KEY_ID"] = temporary_aws_access_key
            os.environ["AWS_REGION_NAME"] = temporary_aws_region_name
            os.environ["AWS_SECRET_ACCESS_KEY"] = temporary_secret_key
    return


# for model in derouter.models_by_provider["bedrock"]:
#     invalid_auth(model=model)
# invalid_auth(model="command-nightly")


# Test 3: Invalid Request Error
@pytest.mark.parametrize("model", models)
def test_invalid_request_error(model):
    messages = [{"content": "hey, how's it going?", "role": "user"}]

    with pytest.raises(BadRequestError):
        completion(model=model, messages=messages, max_tokens="hello world")


def test_completion_azure_exception():
    try:
        import openai

        print("azure gpt-3.5 test\n\n")
        derouter.set_verbose = True
        ## Test azure call
        old_azure_key = os.environ["AZURE_AI_API_KEY"]
        os.environ["AZURE_AI_API_KEY"] = "good morning"
        response = completion(
            model="azure/gpt-4.1-mini",
            messages=[{"role": "user", "content": "hello"}],
        )
        os.environ["AZURE_AI_API_KEY"] = old_azure_key
        print(f"response: {response}")
        print(response)
    except openai.AuthenticationError as e:
        os.environ["AZURE_AI_API_KEY"] = old_azure_key
        print("good job got the correct error for azure when key not set")
    except Exception as e:
        pytest.fail(f"Error occurred: {e}")


# test_completion_azure_exception()


def test_azure_embedding_exceptions():
    # CRUCIAL Test - Ensures our exceptions are readable and not overly complicated. some users have complained exceptions will randomly have another exception raised in our exception mapping
    with pytest.raises(Exception, match="Mock error") as exc_info:
        derouter.embedding(
            model="azure/text-embedding-ada-002",
            input="hello",
            mock_response="error",
        )
    assert str(exc_info.value) == "Mock error"


async def asynctest_completion_azure_exception():
    try:
        import openai

        import derouter

        print("azure gpt-3.5 test\n\n")
        derouter.set_verbose = True
        ## Test azure call
        old_azure_key = os.environ["AZURE_AI_API_KEY"]
        os.environ["AZURE_AI_API_KEY"] = "good morning"
        response = await derouter.acompletion(
            model="azure/gpt-4.1-mini",
            messages=[{"role": "user", "content": "hello"}],
        )
        print(f"response: {response}")
        print(response)
    except openai.AuthenticationError as e:
        os.environ["AZURE_AI_API_KEY"] = old_azure_key
        print("good job got the correct error for azure when key not set")
        print(e)
    except Exception as e:
        print("Got wrong exception")
        print("exception", e)
        pytest.fail(f"Error occurred: {e}")


# import asyncio
# asyncio.run(
#     asynctest_completion_azure_exception()
# )


def asynctest_completion_openai_exception_bad_model():
    try:
        import asyncio

        import openai

        import derouter

        print("azure exception bad model\n\n")
        derouter.set_verbose = True

        ## Test azure call
        async def test():
            response = await derouter.acompletion(
                model="openai/gpt-6",
                messages=[{"role": "user", "content": "hello"}],
            )

        asyncio.run(test())
    except openai.NotFoundError:
        print("Good job this is a NotFoundError for a model that does not exist!")
        print("Passed")
    except Exception as e:
        print("Raised wrong type of exception", type(e))
        pytest.fail(f"Error occurred: {e}")


# asynctest_completion_openai_exception_bad_model()


def asynctest_completion_azure_exception_bad_model():
    try:
        import asyncio

        import openai

        import derouter

        print("azure exception bad model\n\n")
        derouter.set_verbose = True

        ## Test azure call
        async def test():
            response = await derouter.acompletion(
                model="azure/gpt-12",
                messages=[{"role": "user", "content": "hello"}],
            )

        asyncio.run(test())
    except openai.NotFoundError:
        print("Good job this is a NotFoundError for a model that does not exist!")
        print("Passed")
    except Exception as e:
        print("Raised wrong type of exception", type(e))
        pytest.fail(f"Error occurred: {e}")


# asynctest_completion_azure_exception_bad_model()


def test_completion_openai_exception():
    # test if openai:gpt raises openai.AuthenticationError
    try:
        import openai

        print("openai gpt-3.5 test\n\n")
        derouter.set_verbose = True
        ## Test azure call
        old_azure_key = os.environ["OPENAI_API_KEY"]
        os.environ["OPENAI_API_KEY"] = "good morning"
        response = completion(
            model="gpt-4",
            messages=[{"role": "user", "content": "hello"}],
        )
        print(f"response: {response}")
        print(response)
    except openai.AuthenticationError as e:
        os.environ["OPENAI_API_KEY"] = old_azure_key
        print("OpenAI: good job got the correct error for openai when key not set")
    except Exception as e:
        pytest.fail(f"Error occurred: {e}")


# test_completion_openai_exception()


def test_anthropic_openai_exception(monkeypatch):
    # test if anthropic raises derouter.AuthenticationError
    derouter.set_verbose = True
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    with pytest.raises(derouter.AuthenticationError) as exc_info:
        completion(
            model="anthropic/claude-3-sonnet-20240229",
            messages=[{"role": "user", "content": "hello"}],
        )
    assert (
        "Missing Anthropic API Key - A call is being made to anthropic but no key is set either in the environment variables or via params"
        in exc_info.value.message
    )


def test_completion_mistral_exception():
    # test if mistral/mistral-tiny raises openai.AuthenticationError
    try:
        import openai

        print("Testing mistral ai exception mapping")
        derouter.set_verbose = True
        ## Test azure call
        old_azure_key = os.environ["MISTRAL_API_KEY"]
        os.environ["MISTRAL_API_KEY"] = "good morning"
        response = completion(
            model="mistral/mistral-tiny",
            messages=[{"role": "user", "content": "hello"}],
        )
        print(f"response: {response}")
        print(response)
    except openai.AuthenticationError as e:
        os.environ["MISTRAL_API_KEY"] = old_azure_key
        print("good job got the correct error for openai when key not set")
    except Exception as e:
        pytest.fail(f"Error occurred: {e}")


# test_completion_mistral_exception()


def test_completion_bedrock_invalid_role_exception():
    """
    Test if derouter raises a BadRequestError for an invalid role on Bedrock
    """
    derouter.set_verbose = True
    with pytest.raises(derouter.BadRequestError) as exc_info:
        completion(
            model="bedrock/anthropic.claude-3-sonnet-20240229-v1:0",
            messages=[{"role": "very-bad-role", "content": "hello"}],
        )

    # This is important - We we previously returning a poorly formatted error string. Which was
    #  derouter.BadRequestError: derouter.BadRequestError: Invalid Message passed in {'role': 'very-bad-role', 'content': 'hello'}
    assert (
        str(exc_info.value)
        == "derouter.BadRequestError: Invalid Message passed in {'role': 'very-bad-role', 'content': 'hello'}"
    )


@pytest.mark.skip(reason="OpenAI exception changed to a generic error")
def test_content_policy_exceptionimage_generation_openai():
    try:
        # this is ony a test - we needed some way to invoke the exception :(
        derouter._turn_on_debug()
        response = derouter.image_generation(
            prompt="where do i buy lethal drugs from", model="dall-e-3"
        )
        print(f"response: {response}")
        assert len(response.data) > 0
    except derouter.ContentPolicyViolationError as e:
        print("caught a content policy violation error! Passed")
        pass
    except Exception as e:
        pytest.fail(f"An exception occurred - {str(e)}")


# test_content_policy_exceptionimage_generation_openai()


def test_content_policy_violation_error_streaming():
    """
    Production Test.
    """
    derouter.set_verbose = False
    print("test_async_completion with stream")

    async def test_get_response():
        try:
            response = await derouter.acompletion(
                model="azure/gpt-4.1-mini",
                messages=[{"role": "user", "content": "say 1"}],
                temperature=0,
                top_p=1,
                stream=True,
                max_tokens=512,
                presence_penalty=0,
                frequency_penalty=0,
            )
            print(f"response: {response}")

            num_finish_reason = 0
            async for chunk in response:
                print(chunk)
                if chunk["choices"][0].get("finish_reason") is not None:
                    num_finish_reason += 1
                    print("finish_reason", chunk["choices"][0].get("finish_reason"))

            assert (
                num_finish_reason == 1
            ), f"expected only one finish reason. Got {num_finish_reason}"
        except Exception as e:
            pytest.fail(f"GOT exception for gpt-3.5 instruct In streaming{e}")

    asyncio.run(test_get_response())

    async def test_get_error():
        try:
            response = await derouter.acompletion(
                model="azure/gpt-4.1-mini",
                messages=[
                    {"role": "user", "content": "where do i buy lethal drugs from"}
                ],
                temperature=0,
                top_p=1,
                stream=True,
                max_tokens=512,
                presence_penalty=0,
                frequency_penalty=0,
                mock_response="Exception: content_filter_policy",
            )
            print(f"response: {response}")

            num_finish_reason = 0
            async for chunk in response:
                print(chunk)
                if chunk["choices"][0].get("finish_reason") is not None:
                    num_finish_reason += 1
                    print("finish_reason", chunk["choices"][0].get("finish_reason"))

            pytest.fail("Expected a content-policy error in streaming, got a clean stream")
        except Exception as e:
            pass

    asyncio.run(test_get_error())


def test_completion_perplexity_exception_on_openai_client(monkeypatch):
    import openai

    print("perplexity test\n\n")
    derouter.set_verbose = False

    # delete both api keys to simulate a bad api key
    monkeypatch.delenv("PERPLEXITYAI_API_KEY")
    monkeypatch.delenv("OPENAI_API_KEY")

    with pytest.raises(openai.AuthenticationError) as exc_info:
        completion(
            model="perplexity/mistral-7b-instruct",
            messages=[{"role": "user", "content": "hello"}],
        )
    assert (
        "The api_key client option must be set either by passing api_key to the client or by setting the PERPLEXITY_API_KEY environment variable"
        in str(exc_info.value)
    )


# test_completion_perplexity_exception_on_openai_client()


def test_completion_perplexity_exception(monkeypatch):
    import openai

    print("perplexity test\n\n")
    derouter.set_verbose = True
    monkeypatch.setenv("PERPLEXITYAI_API_KEY", "good morning")
    with pytest.raises(openai.AuthenticationError, match="PerplexityException"):
        completion(
            model="perplexity/mistral-7b-instruct",
            messages=[{"role": "user", "content": "hello"}],
        )


def test_completion_openai_api_key_exception(monkeypatch):
    import openai

    print("gpt-3.5 test\n\n")
    derouter.set_verbose = True
    monkeypatch.setenv("OPENAI_API_KEY", "good morning")
    with pytest.raises(openai.AuthenticationError, match="OpenAIException"):
        completion(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": "hello"}],
        )


# tesy_async_acompletion()


def test_router_completion_vertex_exception():
    try:
        import derouter

        derouter.set_verbose = True
        router = derouter.Router(
            model_list=[
                {
                    "model_name": "vertex-gemini-pro",
                    "derouter_params": {
                        "model": "vertex_ai/gemini-pro",
                        "api_key": "good-morning",
                    },
                },
            ]
        )
        response = router.completion(
            model="vertex-gemini-pro",
            messages=[{"role": "user", "content": "hello"}],
            vertex_project="bad-project",
        )
        pytest.fail("Request should have failed - bad api key")
    except Exception as e:
        print("exception: ", e)


def test_derouter_completion_vertex_exception():
    try:
        import derouter

        derouter.set_verbose = True
        response = completion(
            model="vertex_ai/gemini-pro",
            api_key="good-morning",
            messages=[{"role": "user", "content": "hello"}],
            vertex_project="bad-project",
        )
        pytest.fail("Request should have failed - bad api key")
    except Exception as e:
        print("exception: ", e)


def test_derouter_predibase_exception():
    """
    Test - Assert that the Predibase API Key is not returned on Authentication Errors
    """
    try:
        import derouter

        derouter.set_verbose = True
        response = completion(
            model="predibase/llama-3-8b-instruct",
            messages=[{"role": "user", "content": "What is the meaning of life?"}],
            tenant_id="c4768f95",
            api_key="hf-rawapikey",
        )
        pytest.fail("Request should have failed - bad api key")
    except Exception as e:
        if "hf-rawapikey" in str(e):
            pytest.fail("predibase error leaked the raw api key")
        print("exception: ", e)


# # test_invalid_request_error(model="command-nightly")
# # Test 3: Rate Limit Errors
# def test_model_call(model):
#     try:
#         sample_text = "how does a court case get to the Supreme Court?"
#         messages = [{ "content": sample_text,"role": "user"}]
#         print(f"model: {model}")
#         response = completion(model=model, messages=messages)
#     except RateLimitError as e:
#         print(f"headers: {e.response.headers}")
#         return True
#     # except OpenAIError: # is at least an openai error -> in case of random model errors - e.g. overloaded server
#     #     return True
#     except Exception as e:
#         print(f"Uncaught Exception {model}: {type(e).__name__} - {e}")
#         traceback.print_exc()
#         pass
#     return False
# # Repeat each model 500 times
# # extended_models = [model for model in models for _ in range(250)]
# extended_models = ["azure/gpt-4.1-mini" for _ in range(250)]

# def worker(model):
#     return test_model_call(model)

# # Create a dictionary to store the results
# counts = {True: 0, False: 0}

# # Use Thread Pool Executor
# with ThreadPoolExecutor(max_workers=500) as executor:
#     # Use map to start the operation in thread pool
#     results = executor.map(worker, extended_models)

#     # Iterate over results and count True/False
#     for result in results:
#         counts[result] += 1

# accuracy_score = counts[True]/(counts[True] + counts[False])
# print(f"accuracy_score: {accuracy_score}")


@pytest.mark.parametrize(
    "provider",
    [
        "predibase",
        "vertex_ai_beta",
        "anthropic",
        "databricks",
        "watsonx",
        "fireworks_ai",
    ],
)
def test_exception_mapping(provider):
    """
    For predibase, run through a set of mock exceptions

    assert that they are being mapped correctly
    """
    derouter.set_verbose = True
    error_map = {
        400: derouter.BadRequestError,
        401: derouter.AuthenticationError,
        404: derouter.NotFoundError,
        408: derouter.Timeout,
        429: derouter.RateLimitError,
        500: derouter.InternalServerError,
        503: derouter.ServiceUnavailableError,
    }

    for code, expected_exception in error_map.items():
        mock_response = Exception()
        setattr(mock_response, "text", "This is an error message")
        setattr(mock_response, "llm_provider", provider)
        setattr(mock_response, "status_code", code)

        response: Any = None
        try:
            response = completion(
                model="{}/test-model".format(provider),
                messages=[{"role": "user", "content": "Hey, how's it going?"}],
                mock_response=mock_response,
            )
        except expected_exception:
            continue
        except Exception as e:
            traceback.print_exc()
            response = "{}".format(str(e))
        pytest.fail(
            "Did not raise expected exception. Expected={}, Return={},".format(
                expected_exception, response
            )
        )

    pass


def test_fireworks_ai_exception_mapping():
    """
    Comprehensive test for Fireworks AI exception mapping, including:
    1. Standard 429 rate limit errors
    2. Text-based rate limit detection (the main issue fixed)
    3. Generic 400 errors that should NOT be rate limits
    4. ExceptionCheckers utility function

    Related to: https://github.com/Delify-Solutions/derouter/pull/11455
    Based on Fireworks AI documentation: https://docs.fireworks.ai/tools-sdks/python-client/api-reference
    """
    import derouter
    from derouter.llms.fireworks_ai.common_utils import FireworksAIException
    from derouter.derouter_core_utils.exception_mapping_utils import ExceptionCheckers

    # Test scenarios covering all important cases
    test_scenarios = [
        {
            "name": "Standard 429 rate limit with proper status code",
            "status_code": 429,
            "message": "Rate limit exceeded. Please try again in 60 seconds.",
            "expected_exception": derouter.RateLimitError,
        },
        {
            "name": "Status 400 with rate limit text (the main issue fixed)",
            "status_code": 400,
            "message": '{"error":{"object":"error","type":"invalid_request_error","message":"rate limit exceeded, please try again later"}}',
            "expected_exception": derouter.RateLimitError,
        },
        {
            "name": "Status 400 with generic invalid request (should NOT be rate limit)",
            "status_code": 400,
            "message": '{"error":{"type":"invalid_request_error","message":"Invalid parameter value"}}',
            "expected_exception": derouter.BadRequestError,
        },
    ]

    # Test each scenario
    for scenario in test_scenarios:
        mock_exception = FireworksAIException(
            status_code=scenario["status_code"], message=scenario["message"], headers={}
        )

        with pytest.raises(scenario["expected_exception"]) as exc_info:
            derouter.completion(
                model="fireworks_ai/llama-v3p1-70b-instruct",
                messages=[{"role": "user", "content": "Hello"}],
                mock_response=mock_exception,
            )
        if scenario["expected_exception"] == derouter.RateLimitError:
            error_str = str(exc_info.value)
            assert "rate limit" in error_str.lower() or "429" in error_str

    # Test ExceptionCheckers.is_error_str_rate_limit() method directly

    # Test cases that should return True (rate limit detected)
    rate_limit_strings = [
        "429 rate limit exceeded",
        "Rate limit exceeded, please try again later",
        "RATE LIMIT ERROR",
        "Error 429: rate limit",
        '{"error":{"type":"invalid_request_error","message":"rate limit exceeded, please try again later"}}',
        "HTTP 429 Too Many Requests",
    ]

    for error_str in rate_limit_strings:
        assert ExceptionCheckers.is_error_str_rate_limit(
            error_str
        ), f"Should detect rate limit in: {error_str}"

    # Test cases that should return False (not rate limit)
    non_rate_limit_strings = [
        "400 Bad Request",
        "Authentication failed",
        "Invalid model specified",
        "Context window exceeded",
        "Internal server error",
        "",
        "Some other error message",
    ]

    for error_str in non_rate_limit_strings:
        assert not ExceptionCheckers.is_error_str_rate_limit(
            error_str
        ), f"Should NOT detect rate limit in: {error_str}"

    # Test edge cases
    assert not ExceptionCheckers.is_error_str_rate_limit(None)  # type: ignore
    assert not ExceptionCheckers.is_error_str_rate_limit(42)  # type: ignore


def test_anthropic_tool_calling_exception():
    """
    Related - https://github.com/Delify-Solutions/derouter/issues/4348
    """
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_current_weather",
                "description": "Get the current weather in a given location",
                "parameters": {},
            },
        }
    ]
    try:
        derouter.completion(
            model="claude-haiku-4-5-20251001",
            messages=[{"role": "user", "content": "Hey, how's it going?"}],
            tools=tools,
        )
    except derouter.BadRequestError:
        pass


from typing import Optional, Union

from openai import OpenAI


def _pre_call_utils(
    call_type: str,
    data: dict,
    client: Union[OpenAI, AsyncOpenAI],
    sync_mode: bool,
    streaming: Optional[bool],
):
    if call_type == "embedding":
        data["input"] = "Hello world!"
        if isinstance(client, (AzureOpenAI, AsyncAzureOpenAI)):
            mapped_target: Any = client.embeddings.with_raw_response
            patched_attr = "create"
        else:
            mapped_target = client
            patched_attr = "post"
        if sync_mode:
            original_function = derouter.embedding
        else:
            original_function = derouter.aembedding
    elif call_type == "chat_completion":
        data["messages"] = [{"role": "user", "content": "Hello world"}]
        if streaming is True:
            data["stream"] = True
        mapped_target = client.chat.completions.with_raw_response  # type: ignore
        patched_attr = "create"
        if sync_mode:
            original_function = derouter.completion
        else:
            original_function = derouter.acompletion
    elif call_type == "completion":
        data["prompt"] = "Hello world"
        if streaming is True:
            data["stream"] = True
        mapped_target = client.completions.with_raw_response  # type: ignore
        patched_attr = "create"
        if sync_mode:
            original_function = derouter.text_completion
        else:
            original_function = derouter.atext_completion

    return data, original_function, mapped_target, patched_attr


def _pre_call_utils_httpx(
    call_type: str,
    data: dict,
    client: Union[HTTPHandler, AsyncHTTPHandler],
    sync_mode: bool,
    streaming: Optional[bool],
):
    mapped_target: Any = client.client
    if call_type == "embedding":
        data["input"] = "Hello world!"

        if sync_mode:
            original_function = derouter.embedding
        else:
            original_function = derouter.aembedding
    elif call_type == "chat_completion":
        data["messages"] = [{"role": "user", "content": "Hello world"}]
        if streaming is True:
            data["stream"] = True

        if sync_mode:
            original_function = derouter.completion
        else:
            original_function = derouter.acompletion
    elif call_type == "completion":
        data["prompt"] = "Hello world"
        if streaming is True:
            data["stream"] = True
        if sync_mode:
            original_function = derouter.text_completion
        else:
            original_function = derouter.atext_completion

    return data, original_function, mapped_target


@pytest.mark.parametrize(
    "sync_mode",
    [True, False],
)
@pytest.mark.parametrize(
    "provider, model, call_type, streaming",
    [
        ("openai", "text-embedding-ada-002", "embedding", None),
        ("openai", "gpt-3.5-turbo", "chat_completion", False),
        ("openai", "gpt-3.5-turbo", "chat_completion", True),
        ("openai", "gpt-3.5-turbo-instruct", "completion", True),
        ("azure", "azure/gpt-4.1-mini", "chat_completion", True),
        ("azure", "azure/text-embedding-ada-002", "embedding", True),
        ("azure", "azure_text/gpt-3.5-turbo-instruct", "completion", True),
    ],
)
@pytest.mark.asyncio
async def test_exception_with_headers(sync_mode, provider, model, call_type, streaming):
    """
    User feedback: derouter says "No deployments available for selected model, Try again in 60 seconds"
    but Azure says to retry in at most 9s

    ```
    {"message": "derouter.proxy.proxy_server.embeddings(): Exception occured - No deployments available for selected model, Try again in 60 seconds. Passed model=text-embedding-ada-002. pre-call-checks=False, allowed_model_region=n/a, cooldown_list=[('b49cbc9314273db7181fe69b1b19993f04efb88f2c1819947c538bac08097e4c', {'Exception Received': 'derouter.RateLimitError: AzureException RateLimitError - Requests to the Embeddings_Create Operation under Azure OpenAI API version 2023-09-01-preview have exceeded call rate limit of your current OpenAI S0 pricing tier. Please retry after 9 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.', 'Status Code': '429'})]", "level": "ERROR", "timestamp": "2024-08-22T03:25:36.900476"}
    ```
    """
    print(f"Received args: {locals()}")
    import openai

    if sync_mode:
        if provider == "openai":
            openai_client = openai.OpenAI(api_key="")
        elif provider == "azure":
            openai_client = openai.AzureOpenAI(
                api_key="", base_url="", api_version=derouter.AZURE_DEFAULT_API_VERSION
            )
    else:
        if provider == "openai":
            openai_client = openai.AsyncOpenAI(api_key="")
        elif provider == "azure":
            openai_client = openai.AsyncAzureOpenAI(
                api_key="", base_url="", api_version=derouter.AZURE_DEFAULT_API_VERSION
            )

    data = {"model": model}
    data, original_function, mapped_target, patched_attr = _pre_call_utils(
        call_type=call_type,
        data=data,
        client=openai_client,
        sync_mode=sync_mode,
        streaming=streaming,
    )

    cooldown_time = 30.0

    def _return_exception(*args, **kwargs):
        import datetime

        from httpx import Headers, Request, Response

        kwargs = {
            "request": Request("POST", "https://www.google.com"),
            "message": "Error code: 429 - Rate Limit Error!",
            "body": {"detail": "Rate Limit Error!"},
            "code": None,
            "param": None,
            "type": None,
            "response": Response(
                status_code=429,
                headers=Headers(
                    {
                        "date": "Sat, 21 Sep 2024 22:56:53 GMT",
                        "server": "uvicorn",
                        "retry-after": "30",
                        "content-length": "30",
                        "content-type": "application/json",
                    }
                ),
                request=Request("POST", "http://0.0.0.0:9000/chat/completions"),
            ),
            "status_code": 429,
            "request_id": None,
        }

        exception = Exception()
        for k, v in kwargs.items():
            setattr(exception, k, v)
        raise exception

    with patch.object(
        mapped_target,
        patched_attr,
        side_effect=_return_exception,
    ):
        new_retry_after_mock_client = MagicMock(return_value=-1)

        derouter.utils._get_retry_after_from_exception_header = (
            new_retry_after_mock_client
        )

        async def call_and_drain():
            if sync_mode:
                resp = original_function(**data, client=openai_client)
                if streaming:
                    for chunk in resp:
                        continue
            else:
                resp = await original_function(**data, client=openai_client)

                if streaming:
                    async for chunk in resp:
                        continue

        with pytest.raises(derouter.RateLimitError) as exc_info:
            await call_and_drain()

        assert exc_info.value.derouter_response_headers is not None
        assert int(exc_info.value.derouter_response_headers["retry-after"]) == cooldown_time


def test_openai_gateway_timeout_error():
    """
    Test that the OpenAI gateway timeout error is raised
    """
    openai_client = OpenAI()
    mapped_target = openai_client.chat.completions.with_raw_response  # type: ignore

    def _return_exception(*args, **kwargs):
        import datetime

        from httpx import Headers, Request, Response

        kwargs = {
            "request": Request("POST", "https://www.google.com"),
            "message": "Error code: 504 - Gateway Timeout Error!",
            "body": {"detail": "Gateway Timeout Error!"},
            "code": None,
            "param": None,
            "type": None,
            "response": Response(
                status_code=504,
                headers=Headers(
                    {
                        "date": "Sat, 21 Sep 2024 22:56:53 GMT",
                        "server": "uvicorn",
                        "content-length": "30",
                        "content-type": "application/json",
                    }
                ),
                request=Request("POST", "http://0.0.0.0:9000/chat/completions"),
            ),
            "status_code": 504,
            "request_id": None,
        }

        exception = Exception()
        for k, v in kwargs.items():
            setattr(exception, k, v)
        raise exception

    with pytest.raises(derouter.Timeout) as exc_info:
        with patch.object(
            mapped_target,
            "create",
            side_effect=_return_exception,
        ):
            derouter.completion(
                model="openai/gpt-3.5-turbo",
                messages=[{"role": "user", "content": "Hello world"}],
                client=openai_client,
            )
    e = exc_info.value
    assert e.status_code == 504


@pytest.mark.parametrize(
    "sync_mode",
    [True, False],
)
@pytest.mark.parametrize("streaming", [True, False])
@pytest.mark.parametrize(
    "provider, model, call_type",
    [
        ("anthropic", "claude-3-haiku-20240307", "chat_completion"),
    ],
)
@pytest.mark.asyncio
async def test_exception_with_headers_httpx(
    sync_mode, provider, model, call_type, streaming
):
    """
    User feedback: derouter says "No deployments available for selected model, Try again in 60 seconds"
    but Azure says to retry in at most 9s

    ```
    {"message": "derouter.proxy.proxy_server.embeddings(): Exception occured - No deployments available for selected model, Try again in 60 seconds. Passed model=text-embedding-ada-002. pre-call-checks=False, allowed_model_region=n/a, cooldown_list=[('b49cbc9314273db7181fe69b1b19993f04efb88f2c1819947c538bac08097e4c', {'Exception Received': 'derouter.RateLimitError: AzureException RateLimitError - Requests to the Embeddings_Create Operation under Azure OpenAI API version 2023-09-01-preview have exceeded call rate limit of your current OpenAI S0 pricing tier. Please retry after 9 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.', 'Status Code': '429'})]", "level": "ERROR", "timestamp": "2024-08-22T03:25:36.900476"}
    ```
    """
    print(f"Received args: {locals()}")
    import openai

    if sync_mode:
        client = HTTPHandler()
    else:
        client = AsyncHTTPHandler()

    data = {"model": model}
    data, original_function, mapped_target = _pre_call_utils_httpx(
        call_type=call_type,
        data=data,
        client=client,
        sync_mode=sync_mode,
        streaming=streaming,
    )

    cooldown_time = 30.0

    def _return_exception(*args, **kwargs):
        import datetime

        from httpx import Headers, HTTPStatusError, Request, Response

        # Create the Request object
        request = Request("POST", "http://0.0.0.0:9000/chat/completions")

        # Create the Response object with the necessary headers and status code
        response = Response(
            status_code=429,
            headers=Headers(
                {
                    "date": "Sat, 21 Sep 2024 22:56:53 GMT",
                    "server": "uvicorn",
                    "retry-after": "30",
                    "content-length": "30",
                    "content-type": "application/json",
                }
            ),
            request=request,
        )

        # Create and raise the HTTPStatusError exception
        raise HTTPStatusError(
            message="Error code: 429 - Rate Limit Error!",
            request=request,
            response=response,
        )

    with patch.object(
        mapped_target,
        "send",
        side_effect=_return_exception,
    ):
        new_retry_after_mock_client = MagicMock(return_value=-1)

        derouter.utils._get_retry_after_from_exception_header = (
            new_retry_after_mock_client
        )

        async def call_and_drain():
            if sync_mode:
                resp = original_function(**data, client=client)
                if streaming:
                    for chunk in resp:
                        continue
            else:
                resp = await original_function(**data, client=client)

                if streaming:
                    async for chunk in resp:
                        continue

        with pytest.raises(derouter.RateLimitError) as exc_info:
            await call_and_drain()

        assert (
            exc_info.value.derouter_response_headers is not None
        ), "derouter_response_headers is None"
        print("e.derouter_response_headers", exc_info.value.derouter_response_headers)
        assert int(exc_info.value.derouter_response_headers["retry-after"]) == cooldown_time


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["azure/gpt-4.1-mini", "openai/gpt-3.5-turbo"])
async def test_bad_request_error_contains_httpx_response(model):
    """
    Test that the BadRequestError contains the httpx response

    Relevant issue: https://github.com/Delify-Solutions/derouter/issues/6732
    """
    with pytest.raises(derouter.BadRequestError) as exc_info:
        await derouter.acompletion(
            model=model,
            messages=[{"role": "user", "content": "Hello world"}],
            bad_arg="bad_arg",
        )
    e = exc_info.value
    print("e.response", e.response)
    print("vars(e.response)", vars(e.response))
    assert e.response is not None


def test_exceptions_base_class():
    with pytest.raises(derouter.RateLimitError) as exc_info:
        raise derouter.RateLimitError(
            message="BedrockException: Rate Limit Error",
            model="model",
            llm_provider="bedrock",
        )
    e = exc_info.value
    assert isinstance(e, derouter.RateLimitError)
    assert e.code == "429"
    assert e.type == "throttling_error"


def test_context_window_exceeded_error_from_derouter_proxy():
    from httpx import Response
    from derouter.derouter_core_utils.exception_mapping_utils import (
        extract_and_raise_derouter_exception,
    )

    args = {
        "response": Response(status_code=400, text="Bad Request"),
        "error_str": "Error code: 400 - {'error': {'message': \"derouter.ContextWindowExceededError: derouter.BadRequestError: this is a mock context window exceeded error\\nmodel=gpt-3.5-turbo. context_window_fallbacks=None. fallbacks=None.\\n\\nSet 'context_window_fallback' - https://router.delify.vn/docs/routing#fallbacks\\nReceived Model Group=gpt-3.5-turbo\\nAvailable Model Group Fallbacks=None\", 'type': None, 'param': None, 'code': '400'}}",
        "model": "gpt-3.5-turbo",
        "custom_llm_provider": "derouter_proxy",
    }
    with pytest.raises(derouter.ContextWindowExceededError):
        extract_and_raise_derouter_exception(**args)


def test_bad_request_error_with_response_without_request():
    """
    Test that BadRequestError handles Response objects without a request attribute.

    This simulates a real scenario where a Response is created without a request
    (e.g., in tests or when manually creating error responses), and we need to
    ensure it doesn't raise RuntimeError when the exception is created.
    """
    from httpx import Response
    from derouter.derouter_core_utils.exception_mapping_utils import (
        extract_and_raise_derouter_exception,
    )

    # Create a Response without a request (simulates the scenario that was failing)
    response_without_request = Response(status_code=400, text="Bad Request")

    # Test that extract_and_raise_derouter_exception can handle this
    args = {
        "response": response_without_request,
        "error_str": "Error code: 400 - {'error': {'message': 'derouter.BadRequestError: Invalid request parameters', 'type': None, 'param': None, 'code': '400'}}",
        "model": "gpt-3.5-turbo",
        "custom_llm_provider": "openai",
    }

    # This should raise BadRequestError without RuntimeError
    with pytest.raises(derouter.BadRequestError) as exc_info:
        extract_and_raise_derouter_exception(**args)

    # Verify the exception was created successfully
    error = exc_info.value
    assert error is not None
    assert error.model == "gpt-3.5-turbo"
    assert error.llm_provider == "openai"

    # Verify the exception has a response (should be minimal error response)
    assert error.response is not None
    # The response should have a request (minimal error response has one)
    assert getattr(error.response, "_request", None) is not None
    # Should be able to access request property without RuntimeError
    assert error.response.request is not None


@pytest.mark.parametrize("sync_mode", [True, False])
@pytest.mark.parametrize("stream_mode", [True, False])
@pytest.mark.parametrize("model", ["gpt-4.1-nano"])  # "gpt-4o-mini",
@pytest.mark.asyncio
async def test_exception_bubbling_up(sync_mode, stream_mode, model):
    """
    make sure code, param, and type are bubbled up
    """
    import derouter

    derouter.set_verbose = True
    async def _call_with_bad_role():
        if sync_mode:
            derouter.completion(
                model=model,
                messages=[{"role": "usera", "content": "hi"}],
                stream=stream_mode,
                sync_stream=sync_mode,
            )
        else:
            await derouter.acompletion(
                model=model,
                messages=[{"role": "usera", "content": "hi"}],
                stream=stream_mode,
                sync_stream=sync_mode,
            )

    with pytest.raises(Exception, match='derouter\\.BadRequestError: OpenAIException - Invalid value') as exc_info:
        await _call_with_bad_role()

    assert exc_info.value.code == "invalid_value"
    assert exc_info.value.param is not None
    assert exc_info.value.type == "invalid_request_error"
