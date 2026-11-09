"""ParlayPal quantitative ingestion and background worker package."""

from parlaypal_worker.devig import (
    BatchDevigResult,
    DeviggingError,
    EvaluatedPropRecord,
    PropDevigResult,
    TwoWayPropMarketInput,
    american_to_decimal,
    combine_independent_fair_probabilities,
    decimal_to_american,
    devig_multiplicative,
    devig_power,
    evaluate_two_way_prop,
    process_and_publish_ev_props,
)

__version__ = "0.1.0"

__all__ = [
    "BatchDevigResult",
    "DeviggingError",
    "EvaluatedPropRecord",
    "PropDevigResult",
    "TwoWayPropMarketInput",
    "__version__",
    "american_to_decimal",
    "combine_independent_fair_probabilities",
    "decimal_to_american",
    "devig_multiplicative",
    "devig_power",
    "evaluate_two_way_prop",
    "process_and_publish_ev_props",
]
