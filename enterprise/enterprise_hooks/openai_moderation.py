# +-------------------------------------------------------------+
#
#           Use OpenAI /moderations for your LLM calls
#
# +-------------------------------------------------------------+
#  Thank you users! We ❤️ you! - Krrish & Ishaan

import os
import sys

sys.path.insert(
    0, os.path.abspath("../..")
)  # Adds the parent directory to the system path
import sys

from fastapi import HTTPException

import derouter
from derouter._logging import verbose_proxy_logger
from derouter.integrations.custom_logger import CustomLogger
from derouter.proxy._types import UserAPIKeyAuth
from derouter.proxy.guardrails._content_utils import iter_message_text
from derouter.types.utils import CallTypesLiteral


class _ENTERPRISE_OpenAI_Moderation(CustomLogger):
    def __init__(self):
        self.model_name = (
            derouter.openai_moderations_model_name or "text-moderation-latest"
        )  # pass the model_name you initialized on derouter.Router()
        pass

    #### CALL HOOKS - proxy only ####

    async def async_moderation_hook(
        self,
        data: dict,
        user_api_key_dict: UserAPIKeyAuth,
        call_type: CallTypesLiteral,
    ):
        # Covers multimodal list content + Responses-API input.
        text = "".join(iter_message_text(data))

        from derouter.proxy.proxy_server import llm_router

        if llm_router is None:
            return

        moderation_response = await llm_router.amoderation(
            model=self.model_name, input=text
        )

        verbose_proxy_logger.debug("Moderation response: %s", moderation_response)
        if moderation_response and moderation_response.results[0].flagged is True:
            raise HTTPException(
                status_code=403, detail={"error": "Violated content safety policy"}
            )
        pass
