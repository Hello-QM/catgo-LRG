"""Base calculator interface and factory."""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Optional

from catgo.models.structure import CalculatorType, CalculatorParams

if TYPE_CHECKING:
    from ase.calculators.calculator import Calculator


class BaseCalculator(ABC):
    """Abstract base class for calculators."""

    name: str = "base"
    description: str = "Base calculator"
    supported_elements: list[str] | None = None  # None means all elements

    @abstractmethod
    def get_calculator(self) -> "Calculator":
        """Return an ASE-compatible calculator instance."""
        pass

    def supports_structure(self, symbols: list[str]) -> tuple[bool, str]:
        """Check if calculator supports the given elements."""
        if self.supported_elements is None:
            return True, ""

        unsupported = set(symbols) - set(self.supported_elements)
        if unsupported:
            return False, f"Unsupported elements: {', '.join(unsupported)}"
        return True, ""


def get_calculator(
    calc_type: "CalculatorType | str",
    params: Optional[CalculatorParams] = None,
) -> BaseCalculator:
    """Factory function to get calculator instance.

    Supports both built-in CalculatorType enum values and plugin calculator IDs.
    If calc_type is not a built-in calculator, falls back to plugin_manager.
    """
    from .emt import EMTCalculator

    # Normalize to string for uniform lookup
    calc_id = calc_type.value if isinstance(calc_type, CalculatorType) else str(calc_type)

    builtin_calculators: dict[str, type] = {
        "emt": EMTCalculator,
    }

    # Try to import optional calculators
    try:
        from .xtb import XTBCalculator
        builtin_calculators["xtb"] = XTBCalculator
    except ImportError:
        pass

    try:
        from .mace import MACECalculator
        builtin_calculators["mace"] = MACECalculator
    except ImportError:
        pass

    try:
        from .chgnet import CHGNetCalculator
        builtin_calculators["chgnet"] = CHGNetCalculator
    except ImportError:
        pass

    try:
        from .m3gnet import M3GNetCalculator
        builtin_calculators["m3gnet"] = M3GNetCalculator
    except ImportError:
        pass

    # Built-in calculator path
    if calc_id in builtin_calculators:
        calc_class = builtin_calculators[calc_id]

        if calc_id == "xtb" and params and params.xtb:
            return calc_class(
                method=params.xtb.method.value,
                accuracy=params.xtb.accuracy,
                electronic_temperature=params.xtb.electronic_temperature,
                max_iterations=params.xtb.max_iterations,
            )
        elif calc_id == "mace" and params and params.mace:
            return calc_class(
                model=params.mace.model,
                model_path=params.mace.model_path,
                device=params.mace.device,
            )
        else:
            return calc_class()

    # Plugin fallback
    try:
        from catgo.plugins import plugin_manager

        if plugin_manager.has_calculator(calc_id):
            return _PluginCalculatorAdapter(calc_id, plugin_manager)
    except ImportError:
        pass

    # Neither built-in nor plugin — error
    available = list(builtin_calculators.keys())
    try:
        from catgo.plugins import plugin_manager
        available += [c["id"] for c in plugin_manager.get_all_calculators()]
    except Exception:
        pass  # Non-critical: only affects the available-calculator list in the error message
    raise ValueError(
        f"Calculator '{calc_id}' not available. Available: {available}"
    )


class _PluginCalculatorAdapter(BaseCalculator):
    """Adapts a CalculatorPlugin to the built-in BaseCalculator interface."""

    def __init__(self, calc_id: str, manager):
        self._calc_id = calc_id
        self._manager = manager
        info = manager.get_calculator_info(calc_id) or {}
        self.name = info.get("display_name", calc_id)
        self.description = info.get("description", "Plugin calculator")
        self.supported_elements = info.get("supported_elements")

    def get_calculator(self, **kwargs):
        return self._manager.get_calculator(self._calc_id, **kwargs)
