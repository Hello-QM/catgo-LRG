import logging

# Make a logger. Pormake uses a single logger.
logger = logging.getLogger("unique_logger")
# To prevent colloisions with loggers in other libraries.
logger.propagate = False
# Log all levels.
logger.setLevel(logging.DEBUG)

# Setting for the file logs.
file_log_handler = logging.FileHandler(filename="runtime.log", mode="w")
file_log_handler.setLevel(logging.DEBUG)

_format = (
    "[%(asctime)s (%(levelname)s) " "%(filename)s:%(lineno)s] " "%(message)s"
)

formatter = logging.Formatter(
    fmt=_format,
    datefmt="%Y-%m-%d %H:%M:%S",
)
file_log_handler.setFormatter(formatter)

# Setting for the console logs.
console_log_handler = logging.StreamHandler()
console_log_handler.setLevel(logging.INFO)
# Simple formatter.
formatter = logging.Formatter(fmt=">>> %(message)s")
console_log_handler.setFormatter(formatter)

# Add the handlers to the logger.
logger.addHandler(file_log_handler)
logger.addHandler(console_log_handler)


def disable_print():
    console_log_handler.setLevel(logging.WARNING)
    logger.warning("Console logs (under WARNING level) are disabled.")


def enable_print():
    console_log_handler.setLevel(logging.INFO)
    logger.warning("Console logs (under WARNING level) are enabled.")


def disable_file_print():
    file_log_handler.setLevel(logging.WARNING)
    logging.warning("File logs (under WARNING level) are disabled.")


def enable_file_print():
    file_log_handler.setLevel(logging.DEBUG)
    logging.warning("File logs (all levels) are enabled.")
