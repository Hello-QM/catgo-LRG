"""Aggregated TOOLS list from all tool category modules."""

__all__ = ["TOOLS"]

from .structure import TOOLS as _structure
from .adsorption import TOOLS as _adsorption
from .optimization import TOOLS as _optimization
from .nanotube_moire import TOOLS as _nanotube_moire
from .view import TOOLS as _view
from .dft_input import TOOLS as _dft_input
from .analysis import TOOLS as _analysis
from .misc import TOOLS as _misc
from .catalysis import TOOLS as _catalysis

TOOLS: list[dict] = (
    _structure
    # adsorption/doping/substitution/intercalation: defined here since the module
    # was written, but never added to this list — so the six tools CatBot's own
    # agent prompt and skills instruct it to call did not exist on the server it
    # connects to (the merged variant has them, this one silently did not).
    + _adsorption
    + _optimization
    + _nanotube_moire
    + _view
    + _dft_input
    + _analysis
    + _misc
    + _catalysis
)
