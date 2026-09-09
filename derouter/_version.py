import importlib_metadata

try:
    version = importlib_metadata.version("derouter")
except Exception:
    version = "unknown"
