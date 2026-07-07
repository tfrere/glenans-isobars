"""CNN-based synoptic front detection (offline ingestion path).

Vendored from the DWD pre-trained network of Niebler et al. (2022),
https://github.com/stnie/FrontDetection (MIT). See ./LICENSE and ../README.md.
"""

from .infer import fronts_for_date

__all__ = ["fronts_for_date"]
