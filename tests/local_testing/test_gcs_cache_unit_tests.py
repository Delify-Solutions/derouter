from cache_unit_tests import LLMCachingUnitTests
from derouter.caching import DeRouterCacheType


class TestGCSCacheUnitTests(LLMCachingUnitTests):
    def get_cache_type(self) -> DeRouterCacheType:
        return DeRouterCacheType.GCS
