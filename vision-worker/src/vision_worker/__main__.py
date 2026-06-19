from __future__ import annotations

import argparse
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="minimum-headroom vision-worker")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--smoke", action="store_true", help="Import smoke test and exit")
    parser.add_argument(
        "--replay-once",
        action="store_true",
        help="Replay VISION_FRAME_DIR through the pipeline once, then exit",
    )
    parser.add_argument(
        "--replay",
        action="store_true",
        help="Continuously replay VISION_FRAME_DIR (Ctrl+C to stop)",
    )
    return parser.parse_args()


def _run_replay(loop: bool) -> None:
    from .config import load_settings
    from .db import VisionDB
    from .model_client import build_model_client
    from .pipeline import build_pipeline
    from .sources import DirectoryFrameSource
    from .store import FrameStore

    settings = load_settings()
    if not settings.frame_dir:
        print("[vision-worker] VISION_FRAME_DIR is required for replay", file=sys.stderr)
        raise SystemExit(2)

    db = VisionDB(settings.db_path)
    store = FrameStore(settings.cache_dir, thumb_max=settings.thumb_max)
    pipeline = build_pipeline(settings, db, store, build_model_client(settings))
    source = DirectoryFrameSource(
        settings.frame_dir,
        interval_ms=settings.capture_interval_ms if loop else 0,
        loop=loop,
    )

    print(
        f"[vision-worker] replay backend={settings.model_backend} "
        f"frame_dir={settings.frame_dir} db={settings.db_path}"
    )
    try:
        for frame_jpeg in source.frames():
            pipeline.process_frame(frame_jpeg)
    except KeyboardInterrupt:
        pass
    pipeline.flush()  # commit any voting window left open at end of stream

    print(f"[vision-worker] pipeline {pipeline.stats.as_dict()}")
    print(f"[vision-worker] db {db.counts()}")


def main() -> None:
    args = parse_args()

    if args.smoke:
        import httpx  # noqa: F401
        import numpy  # noqa: F401
        from fastapi import FastAPI  # noqa: F401
        from PIL import Image  # noqa: F401

        from .app import create_app

        create_app()
        print("vision-worker smoke: imports + app factory OK")
        return

    if args.replay_once or args.replay:
        _run_replay(loop=args.replay)
        return

    import uvicorn

    from .config import load_settings

    settings = load_settings()
    host = args.host or settings.host
    port = args.port or settings.port
    uvicorn.run("vision_worker.app:create_app", factory=True, host=host, port=port)


if __name__ == "__main__":
    main()
