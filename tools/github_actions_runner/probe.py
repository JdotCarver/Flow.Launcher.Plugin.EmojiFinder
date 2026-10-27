# probe.py
"""Print a non-sensitive receipt proving where the requested workload ran."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from collections.abc import Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from select_runner import load_request

# describe_machine() lives beside this bridge in the repository it was written for. It only
# turns the OS into a family-level label for the receipt, so its absence is not a reason for
# the probe to fail: fall back to the platform's own release string.
try:
    import machine_label  # noqa: E402
except ImportError:

    class machine_label:  # noqa: N801 - same name as the module it stands in for
        """Stand-in used when the bridge is copied into a repository without it."""

        @staticmethod
        def describe_machine() -> str:
            return platform.system() or "unknown"


EXPECTED_ENVIRONMENTS = {
    "cloud-windows": "github-hosted",
    "local-windows": "self-hosted",
}


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path, help="Path to runner-request.toml")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Validate the execution environment and print a safe, structured receipt."""

    args = parse_args(argv)
    request = load_request(args.request)
    actual_environment = os.environ.get("RUNNER_ENVIRONMENT", "unknown")
    expected_environment = EXPECTED_ENVIRONMENTS[request.target]

    problems = []
    if platform.system() != "Windows":
        problems.append(f"expected Windows, found {platform.system() or 'unknown'}")
    if actual_environment != expected_environment:
        problems.append(
            f"target {request.target!r} requires {expected_environment!r}, "
            f"found {actual_environment!r}"
        )
    if problems:
        print("Runner probe failed: " + "; ".join(problems), file=sys.stderr)
        return 1

    receipt = {
        "request_id": request.request_id,
        "job_name": request.job_name,
        "target": request.target,
        "repository": os.environ.get("GITHUB_REPOSITORY", "unknown"),
        "commit": os.environ.get("GITHUB_SHA", "unknown"),
        "run_id": os.environ.get("GITHUB_RUN_ID", "unknown"),
        "runner_name": os.environ.get("RUNNER_NAME", "unknown"),
        "runner_environment": actual_environment,
        "operating_system": machine_label.describe_machine(),
        "architecture": platform.machine(),
        "python_version": platform.python_version(),
    }
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
