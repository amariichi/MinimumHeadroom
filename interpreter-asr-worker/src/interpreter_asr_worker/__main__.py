from __future__ import annotations

import argparse
import os


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Minimum Headroom offline Nemotron 3.5 ASR worker"
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8095)
    parser.add_argument("--smoke", action="store_true")
    return parser.parse_args()


def main() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    args = parse_args()
    if args.smoke:
        from .app import create_runtime

        runtime = create_runtime()
        runtime.load()
        print(
            f"interpreter-asr-worker smoke: model={runtime.model_id} "
            f"revision={runtime.revision} offline=true"
        )
        return

    import uvicorn

    uvicorn.run(
        "interpreter_asr_worker.app:create_app",
        factory=True,
        host=args.host,
        port=args.port,
    )


if __name__ == "__main__":
    main()
