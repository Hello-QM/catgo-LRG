"""MACE universal potential calculator."""

from typing import Optional

from .base import BaseCalculator


class MACECalculator(BaseCalculator):
    """MACE universal potential calculator.

    Supports most elements. Requires mace-torch package.
    Uses MACE-MP-0 foundation model by default, or a custom model file.
    """

    name = "mace"
    description = "MACE universal potential - accurate for most materials"
    supported_elements = None  # Supports all elements

    def __init__(
        self,
        model: str = "medium",
        model_path: Optional[str] = None,
        device: str = "cpu",
    ):
        """Initialize MACE calculator.

        Args:
            model: Model size - "small", "medium", "large", or "custom" (requires model_path)
            model_path: Path to custom MACE model file (.model). If provided, uses custom model.
            device: Compute device - "cpu" or "cuda"
        """
        self.model = model
        self.model_path = model_path
        self.device = device

    def get_calculator(self):
        # If custom model path is provided, load from file
        if self.model_path:
            from mace.calculators import MACECalculator as MACE

            return MACE(
                model_paths=self.model_path,
                device=self.device,
                default_dtype="float64",
            )
        else:
            # Use pre-trained MACE-MP models
            from mace.calculators import mace_mp

            return mace_mp(model=self.model, device=self.device, default_dtype="float64")
