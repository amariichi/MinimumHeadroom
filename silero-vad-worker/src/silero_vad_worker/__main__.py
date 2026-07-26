from __future__ import annotations

import argparse
import os


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="minimum-headroom silero-vad-worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8092)
    parser.add_argument("--smoke", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.smoke:
        from silero_vad import load_silero_vad  # noqa: F401

        print("silero-vad-worker smoke: imports OK")
        return

    import uvicorn

    uvicorn.run(
        "silero_vad_worker.app:create_app",
        factory=True,
        host=args.host,
        port=args.port,
        access_log=os.getenv("MH_SILERO_ACCESS_LOG", "0") == "1",
    )


if __name__ == "__main__":
    main()
