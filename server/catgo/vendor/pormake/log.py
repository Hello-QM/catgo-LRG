import logging

# Make a logger. Pormake uses a single logger.
logger = logging.getLogger("unique_logger")
# To prevent colloisions with loggers in other libraries.
logger.propagate = False
# Log all levels (handlers gate what is actually emitted).
logger.setLevel(logging.DEBUG)

_format = (
    "[%(asctime)s (%(levelname)s) " "%(filename)s:%(lineno)s] " "%(message)s"
)

formatter = logging.Formatter(
    fmt=_format,
    datefmt="%Y-%m-%d %H:%M:%S",
)

# CatGO vendor adaptation: do NOT create a "runtime.log" file in the process
# CWD at import time (the original upstream behaviour litters/truncates a log
# file wherever the server is launched). The file handler is created lazily,
# only if enable_file_print() is called.
file_log_handler = None

# Setting for the console logs.
console_log_handler = logging.StreamHandler()
# CatGO vendor adaptation: quiet by default (WARNING) so embedding the builder
# in the server does not spam stderr with ">>>" build progress on every build.
# Call enable_print() to restore upstream INFO-level console output.
console_log_handler.setLevel(logging.WARNING)
# Simple formatter.
formatter = logging.Formatter(fmt=">>> %(message)s")
console_log_handler.setFormatter(formatter)

# Add the console handler to the logger.
logger.addHandler(console_log_handler)


def disable_print():
    console_log_handler.setLevel(logging.WARNING)


def enable_print():
    console_log_handler.setLevel(logging.INFO)
    logger.warning("Console logs (under WARNING level) are enabled.")


def _ensure_file_handler():
    global file_log_handler
    if file_log_handler is None:
        file_log_handler = logging.FileHandler(filename="runtime.log", mode="w")
        file_log_handler.setFormatter(
            logging.Formatter(
                fmt=_format,
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        logger.addHandler(file_log_handler)
    return file_log_handler


def disable_file_print():
    if file_log_handler is not None:
        file_log_handler.setLevel(logging.WARNING)


def enable_file_print():
    handler = _ensure_file_handler()
    handler.setLevel(logging.DEBUG)
    logger.warning("File logs (all levels) are enabled.")
