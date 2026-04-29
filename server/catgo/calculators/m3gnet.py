"""M3GNet universal potential calculator."""

from .base import BaseCalculator


class M3GNetCalculator(BaseCalculator):
    """M3GNet universal potential calculator.

    Supports most elements. Requires matgl package.
    """

    name = "m3gnet"
    description = "M3GNet universal potential"
    supported_elements = None  # Supports all elements

    def __init__(self, device: str = "cpu"):
        """Initialize M3GNet calculator.

        Args:
            device: Compute device - "cpu" or "cuda"
        """
        self.device = device

    def get_calculator(self):
        import matgl
        from matgl.ext.ase import M3GNetCalculator as M3GNetCalc

        potential = matgl.load_model("M3GNet-MP-2021.2.8-DIRECT-PES")
        return M3GNetCalc(potential=potential)
