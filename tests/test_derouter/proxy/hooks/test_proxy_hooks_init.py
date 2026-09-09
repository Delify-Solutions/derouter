"""Regression guard for the enterprise hook registration / import cycle.

Python 3.13 is stricter about partially-initialized modules and surfaces
cycles that Python 3.12 silently tolerated. The previous bug:

  derouter.proxy.hooks.__init__
    -> enterprise.enterprise_hooks
    -> derouter_enterprise.proxy.hooks.managed_files
    -> derouter.llms.base_llm.managed_resources.isolation
    -> derouter.proxy.management_endpoints.common_utils
    -> derouter.proxy.utils  (re-enters derouter.proxy.hooks mid-init)

silently swallowed the ImportError in `hooks/__init__.py`, leaving
``managed_files`` unregistered and the /files endpoint returning 500.
"""

import pytest

from derouter.proxy.hooks import PROXY_HOOKS, get_proxy_hook


def test_managed_files_hook_registered():
    pytest.importorskip("derouter_enterprise")
    assert "managed_files" in PROXY_HOOKS
    hook_cls = get_proxy_hook("managed_files")
    assert hook_cls.__name__ == "_PROXY_DeRouterManagedFiles"


def test_managed_vector_stores_hook_registered():
    pytest.importorskip("derouter_enterprise")
    assert "managed_vector_stores" in PROXY_HOOKS
    hook_cls = get_proxy_hook("managed_vector_stores")
    assert hook_cls.__name__ == "_PROXY_DeRouterManagedVectorStores"


def test_isolation_module_does_not_pull_in_proxy_utils():
    """Layering guard: derouter.llms.* must not transitively import
    derouter.proxy.utils, which would reintroduce the import cycle."""
    import importlib
    import sys

    for mod in [
        "derouter.proxy.utils",
        "derouter.proxy.management_endpoints.common_utils",
        "derouter.llms.base_llm.managed_resources.isolation",
    ]:
        sys.modules.pop(mod, None)

    importlib.import_module("derouter.llms.base_llm.managed_resources.isolation")
    assert "derouter.proxy.utils" not in sys.modules
    assert "derouter.proxy.management_endpoints.common_utils" not in sys.modules
