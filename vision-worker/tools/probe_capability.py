"""Capability probe for diffusiongemma.

Sends a folder of representative images (a workbook page, a scene, a traffic
light) to a running OpenAI-compatible vLLM endpoint serving diffusiongemma, and
reports per image: the parsed {is_text, ocr_full, overview, change_from_prev},
whether the JSON parsed on the first try, and the latency. The results decide
the temporal-voting count, capture interval, and whether guided decoding is
needed (see "Capability-gated branches" in the ExecPlan).

Run when the GPU is free:

    uv run --project vision-worker python vision-worker/tools/probe_capability.py \
        --endpoint http://127.0.0.1:8000/v1 --images vision-worker/tools/test-images/
"""

from __future__ import annotations

import argparse
import glob
import os
import time

from vision_worker.model_client import DiffusionGemmaClient
from vision_worker.records import PrevState


def main() -> None:
    parser = argparse.ArgumentParser(description="diffusiongemma capability probe")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8000/v1")
    parser.add_argument("--model", default="nvidia/diffusiongemma-26B-A4B-it-NVFP4")
    parser.add_argument("--images", required=True, help="directory of test images")
    parser.add_argument("--guided", action="store_true", help="use guided JSON decoding")
    parser.add_argument(
        "--report",
        # Default outside the repo so probe runs never deposit (possibly
        # personal) artifacts into the working tree. Override with --report.
        default=os.path.expanduser(
            "~/.cache/minimum-headroom/vision-probe/probe-report.md"
        ),
    )
    args = parser.parse_args()

    client = DiffusionGemmaClient(args.endpoint, args.model, guided=args.guided)

    paths: list[str] = []
    for pattern in ("*.jpg", "*.jpeg", "*.png"):
        paths.extend(glob.glob(os.path.join(args.images, pattern)))
    paths = sorted(set(paths))
    if not paths:
        raise SystemExit(f"no images found under {args.images}")

    lines = [f"# diffusiongemma probe — {time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    lines.append(f"endpoint={args.endpoint} model={args.model} guided={args.guided}")
    lines.append("")

    prev: PrevState | None = None
    for path in paths:
        with open(path, "rb") as handle:
            data = handle.read()
        try:
            obs = client.observe(data, prev)
            json_ok = not obs.low_confidence or bool(obs.overview or obs.ocr_full)
            summary = (
                f"- {os.path.basename(path)}  json_ok={json_ok}  is_text={obs.is_text}  "
                f"ocr_chars={len(obs.ocr_full)}  latency={obs.latency_ms}ms\n"
                f"    overview: {obs.overview!r}\n"
                f"    change:   {obs.change_from_prev!r}"
            )
            prev = PrevState(obs.ocr_full, obs.overview)
        except Exception as exc:  # noqa: BLE001 - report and continue
            summary = f"- {os.path.basename(path)}  ERROR: {exc}"
        print(summary)
        lines.append(summary)

    report_dir = os.path.dirname(args.report)
    if report_dir:
        os.makedirs(report_dir, exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    print(f"\nwrote {args.report}")


if __name__ == "__main__":
    main()
