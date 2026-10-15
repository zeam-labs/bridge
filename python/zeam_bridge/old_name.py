import importlib
import pkgutil
import sys

NEW = "zeam_bridge"


def alias(old):
    package = importlib.import_module(NEW)
    for found in pkgutil.walk_packages(package.__path__, NEW + "."):
        importlib.import_module(found.name)
    for name, module in list(sys.modules.items()):
        if name == NEW or name.startswith(NEW + "."):
            sys.modules[old + name[len(NEW):]] = module
