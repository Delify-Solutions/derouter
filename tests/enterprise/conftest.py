# conftest.py

import asyncio
import importlib
import os

import pytest

import derouter


@pytest.fixture(scope="session")
def event_loop():
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
    yield loop
    loop.close()




@pytest.fixture(scope="function", autouse=True)
def setup_and_teardown():
    """
    This fixture reloads derouter before every function. To speed up testing by removing callbacks being chained.
    """
    curr_dir = os.getcwd()  # Get the current working directory

    from derouter import Router

    importlib.reload(derouter)

    try:
        if hasattr(derouter, "proxy") and hasattr(derouter.proxy, "proxy_server"):
            importlib.reload(derouter.proxy.proxy_server)
    except Exception as e:
        print(f"Error reloading derouter.proxy.proxy_server: {e}")

    derouter.in_memory_llm_clients_cache.flush_cache()

    import asyncio

    loop = asyncio.get_event_loop_policy().new_event_loop()
    asyncio.set_event_loop(loop)
    print(derouter)
    # from derouter import Router, completion, aembedding, acompletion, embedding
    yield

    # Teardown code (executes after the yield point)
    loop.close()  # Close the loop created earlier
    asyncio.set_event_loop(None)  # Remove the reference to the loop


def pytest_collection_modifyitems(config, items):
    # Separate tests in 'test_amazing_proxy_custom_logger.py' and other tests
    custom_logger_tests = [
        item for item in items if "custom_logger" in item.parent.name
    ]
    other_tests = [item for item in items if "custom_logger" not in item.parent.name]

    # Sort tests based on their names
    custom_logger_tests.sort(key=lambda x: x.name)
    other_tests.sort(key=lambda x: x.name)

    # Reorder the items list
    items[:] = custom_logger_tests + other_tests
