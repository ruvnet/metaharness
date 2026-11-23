"""Machine-readable bounded knob registry for external Darwin orchestration."""
import argparse
import json

from .tasks import KNOBS, format_task_id, parse_task_id

__all__ = ["KNOBS", "format_task_id", "parse_task_id"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Print the canonical registry as JSON")
    parser.parse_args()
    print(json.dumps(KNOBS, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
