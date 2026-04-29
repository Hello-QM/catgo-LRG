"""CHGNet universal potential calculator."""

from .base import BaseCalculator


class CHGNetCalculator(BaseCalculator):
    """CHGNet universal potential calculator.

    Supports most elements. Requires chgnet package.
    """

    name = "chgnet"
    description = "CHGNet universal potential - fast and accurate"
    supported_elements = None  # Supports all elements

    def __init__(self, device: str = "cpu"):
        """Initialize CHGNet calculator.

        Args:
            device: Compute device - "cpu" or "cuda"
        """
        self.device = device

    def get_calculator(self):
        from chgnet.model.dynamics import CHGNetCalculator as CHGNetCalc

        return CHGNetCalc(use_device=self.device)
