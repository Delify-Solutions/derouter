# What is this?
## This tests the batch update spend logic on the proxy server


import asyncio
import os
import random
import time
import traceback
from datetime import datetime

from dotenv import load_dotenv
from fastapi import Request

load_dotenv()

import logging

import pytest

import derouter
from derouter import Router, mock_completion
from derouter._logging import verbose_proxy_logger
from derouter.caching.caching import DualCache
from derouter.proxy._types import UserAPIKeyAuth
from derouter.proxy.management_endpoints.internal_user_endpoints import (
    new_user,
    user_info,
    user_update,
)
from derouter.proxy.management_endpoints.key_management_endpoints import (
    delete_key_fn,
    generate_key_fn,
    generate_key_helper_fn,
    info_key_fn,
    update_key_fn,
)
from derouter.proxy.proxy_server import user_api_key_auth
from derouter.proxy.management_endpoints.customer_endpoints import block_user
from derouter.proxy.spend_tracking.spend_management_endpoints import (
    spend_key_fn,
    spend_user_fn,
    view_spend_logs,
)
from derouter.proxy.utils import PrismaClient, ProxyLogging, hash_token, update_spend

verbose_proxy_logger.setLevel(level=logging.DEBUG)

from starlette.datastructures import URL

from derouter.proxy._types import (
    BlockUsers,
    DynamoDBArgs,
    GenerateKeyRequest,
    KeyRequest,
    NewUserRequest,
    UpdateKeyRequest,
    SpendUpdateQueueItem,
    Litellm_EntityType,
)

proxy_logging_obj = ProxyLogging(user_api_key_cache=DualCache())


@pytest.fixture
def prisma_client():
    from derouter.proxy.proxy_cli import append_query_params

    ### add connection pool + pool timeout args
    params = {"connection_limit": 100, "pool_timeout": 60}
    database_url = os.getenv("DATABASE_URL")
    modified_url = append_query_params(database_url, params)
    os.environ["DATABASE_URL"] = modified_url

    # Assuming PrismaClient is a class that needs to be instantiated
    prisma_client = PrismaClient(
        database_url=os.environ["DATABASE_URL"], proxy_logging_obj=proxy_logging_obj
    )

    # Reset derouter.proxy.proxy_server.prisma_client to None
    derouter.proxy.proxy_server.derouter_proxy_budget_name = (
        f"derouter-proxy-budget-{time.time()}"
    )
    derouter.proxy.proxy_server.user_custom_key_generate = None

    return prisma_client


@pytest.mark.asyncio
@pytest.mark.skip(reason="Requires reliable external DB connection (prisma).")
async def test_batch_update_spend(prisma_client):
    await proxy_logging_obj.db_spend_update_writer.spend_update_queue.add_update(
        SpendUpdateQueueItem(
            entity_type=Litellm_EntityType.USER,
            entity_id="test-derouter-user-5",
            response_cost=23,
        )
    )
    setattr(derouter.proxy.proxy_server, "prisma_client", prisma_client)
    setattr(derouter.proxy.proxy_server, "master_key", "sk-1234")
    await derouter.proxy.proxy_server.prisma_client.connect()
    await update_spend(
        prisma_client=derouter.proxy.proxy_server.prisma_client,
        db_writer_client=None,
        proxy_logging_obj=proxy_logging_obj,
    )
