"""Aggregated TOOLS list from all tool category modules."""

__all__ = ["TOOLS"]

from .structure import TOOLS as _structure
from .optimization import TOOLS as _optimization
from .nanotube_moire import TOOLS as _nanotube_moire
from .view import TOOLS as _view
from .dft_input import TOOLS as _dft_input
from .analysis import TOOLS as _analysis
from .misc import TOOLS as _misc
from .catalysis import TOOLS as _catalysis

TOOLS: list[dict] = (
    _structure
    + _optimization
    + _nanotube_moire
    + _view
    + _dft_input
    + _analysis
    + _misc
    + _catalysis
)
