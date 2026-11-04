"""Load this worker's handler.py under a directory-unique module name so the
two workers' test suites can run in one pytest invocation."""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = f"handler_{HERE.name.replace('-', '_')}"
spec = importlib.util.spec_from_file_location(NAME, HERE / "handler.py")
module = importlib.util.module_from_spec(spec)
sys.modules[NAME] = module
spec.loader.exec_module(module)  # type: ignore[union-attr]
