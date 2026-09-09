from typing import Final

from mangum import Mangum

from derouter.proxy.proxy_server import app

handler: Final = Mangum(app, lifespan="on")
