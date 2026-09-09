#### What this tests ####
#    This tests the validate environment function

import sys, os
import traceback

import time
import derouter

print(derouter.validate_environment("openai/gpt-3.5-turbo"))
