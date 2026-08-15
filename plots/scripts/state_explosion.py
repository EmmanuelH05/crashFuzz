"""Crash state count against trace length.

Reads plots/data/state-explosion.csv and plots/data/state-explosion-fit.json,
both written by core/tools/state-explosion.ts, and renders
plots/out/state-explosion.png. The figure regenerates from the data, so data
and script are committed alongside the image.

No fitting happens here. The exponents are read from the sidecar so the numbers
on the figure come from the estimator the TypeScript tests cover, rather than
from a second implementation of it.

    python3 plots/scripts/state_explosion.py
"""

import csv
import json
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "plots" / "data" / "state-explosion.csv"
FIT = ROOT / "plots" / "data" / "state-explosion-fit.json"
OUT = ROOT / "plots" / "out" / "state-explosion.png"


def series(rows, regime):
    points = sorted(
        (int(row["operations"]), int(row["states"]))
        for row in rows
        if row["regime"] == regime
    )
    return [p[0] for p in points], [p[1] for p in points]


def main():
    with DATA.open() as handle:
        rows = list(csv.DictReader(handle))
    with FIT.open() as handle:
        fit = json.load(handle)

    bounded_x, bounded_y = series(rows, "bounded")
    unbounded_x, unbounded_y = series(rows, "unbounded")

    fig, ax = plt.subplots(figsize=(7.5, 5))

    ax.plot(
        unbounded_x,
        unbounded_y,
        marker="o",
        color="#b3261e",
        label="no bounds, no fsync (p = %.1f)" % fit["unboundedExponent"],
    )
    ax.plot(
        bounded_x,
        bounded_y,
        marker="o",
        color="#1a73e8",
        label="bounded (p = %.2f)" % fit["boundedExponent"],
    )

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("trace length (operations)")
    ax.set_ylabel("crash states enumerated")
    ax.set_title("Crash state count against trace length")
    ax.grid(True, which="both", linewidth=0.3, alpha=0.6)
    ax.legend(loc="upper left", frameon=False)

    # A power law is a straight line on log-log axes. The bounded curve tracks
    # one; the unbounded curve bends upward away from it because it is 2**n.
    largest = fit["largestBounded"]
    ax.annotate(
        "%d states at %d operations" % (largest["states"], largest["operations"]),
        xy=(largest["operations"], largest["states"]),
        xytext=(0.45, 0.12),
        textcoords="axes fraction",
        fontsize=8,
        color="#1a73e8",
        arrowprops={"arrowstyle": "->", "color": "#1a73e8", "lw": 0.8},
    )

    fig.tight_layout()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT, dpi=160)
    print("wrote %s" % OUT)


if __name__ == "__main__":
    main()
