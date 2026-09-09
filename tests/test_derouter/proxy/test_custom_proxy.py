import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

load_dotenv()

# Set the SERVER_ROOT_PATH environment variable to match the custom mount path
os.environ["SERVER_ROOT_PATH"] = "/my-custom-path"

from derouter.proxy.proxy_server import app as derouter_app
from derouter.proxy.proxy_server import proxy_startup_event

# Create main FastAPI app
app = FastAPI(title="Custom DeRouter Server", lifespan=proxy_startup_event)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

custom_path = "/my-custom-path"

# Mount DeRouter app at /derouter
app.mount(custom_path, derouter_app)


# Default route at /
@app.get("/")
async def root():
    return {
        "message": "Welcome to the API Gateway",
        "derouter_endpoint": f"{custom_path}",
    }


# Health check endpoint
@app.get("/health")
async def health_check():
    return {"status": "healthy"}


if __name__ == "__main__":
    # Run the server on port 8000
    uvicorn.run(app, host="0.0.0.0", port=4000, log_level="info")
