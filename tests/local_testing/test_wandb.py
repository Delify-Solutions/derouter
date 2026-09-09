import os
import io, asyncio

# import logging
# logging.basicConfig(level=logging.DEBUG)

from derouter import completion
import derouter

derouter.num_retries = 3
derouter.success_callback = ["wandb"]
import time
import pytest


def test_wandb_logging_async():
    try:
        derouter.set_verbose = False

        async def _test_langfuse():
            from derouter import Router

            model_list = [
                {  # list of model deployments
                    "model_name": "gpt-3.5-turbo",
                    "derouter_params": {  # params for derouter completion/embedding call
                        "model": "gpt-3.5-turbo",
                        "api_key": os.getenv("OPENAI_API_KEY"),
                    },
                }
            ]

            router = Router(model_list=model_list)

            # openai.ChatCompletion.create replacement
            response = await router.acompletion(
                model="gpt-3.5-turbo",
                messages=[
                    {"role": "user", "content": "this is a test with derouter router ?"}
                ],
            )
            print(response)

        response = asyncio.run(_test_langfuse())
        print(f"response: {response}")
    except derouter.Timeout as e:
        pass
    except Exception as e:
        pass


def test_wandb_logging():
    try:
        response = completion(
            model="claude-3-5-haiku-20241022",
            messages=[{"role": "user", "content": "Hi 👋 - i'm claude"}],
            max_tokens=10,
            temperature=0.2,
        )
        print(response)
    except derouter.Timeout as e:
        pass
    except Exception as e:
        print(e)


# test_wandb_logging()
