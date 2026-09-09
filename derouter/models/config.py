"""
Config table model.

Canonical definition for ``derouter_config``. Re-exported from
``derouter.proxy._types`` for backwards compatibility.
"""

from derouter.types.llms.base import DeRouterPydanticObjectBase


class DeRouter_Config(DeRouterPydanticObjectBase):
    param_name: str
    param_value: dict
