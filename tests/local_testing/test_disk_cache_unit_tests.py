from cache_unit_tests import LLMCachingUnitTests
from derouter.caching import DeRouterCacheType


class TestDiskCacheUnitTests(LLMCachingUnitTests):
    def get_cache_type(self) -> DeRouterCacheType:
        return DeRouterCacheType.DISK


# if __name__ == "__main__":
#     pytest.main([__file__, "-v", "-s"])
