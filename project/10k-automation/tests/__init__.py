"""Test suite. Engine logging is quietened so failures are what you see."""

import logging

logging.getLogger("tenk").addHandler(logging.NullHandler())
logging.getLogger("tenk").propagate = False
