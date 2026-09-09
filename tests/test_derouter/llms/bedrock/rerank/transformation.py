import json

import pytest
from fastapi.testclient import TestClient

from unittest.mock import MagicMock, patch

from derouter import rerank
from derouter.llms.custom_httpx.http_handler import HTTPHandler
