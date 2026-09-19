"""Run the native WebRTC receiver/recorder with bounded process telemetry."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time

import psutil


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=3630)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    assert args.seconds >= 10
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    if shutil.disk_usage(output).free < 8 * 1024**3:
        raise RuntimeError("Qualification needs 8 GiB of free recording space")
    extension = ".exe" if os.name == "nt" else ""
    viewer = args.build.resolve() / ("ceres-viewer" + extension)
    source = args.build.resolve() / ("test_bridge" + extension)
    record = output / "session.mcap"
    source_args = [str(source), "--stream-fixture", str(args.video.resolve()),
                   "--seconds", str(args.seconds + 30), "--port", str(args.port)]
    viewer_args = [str(viewer), "--origin", f"http://127.0.0.1:{args.port}",
                   "--config-dir", str(output / "config"), "--record", str(record),
                   "--width", "2560", "--height", "1440", "--borderless", "--no-vsync",
                   "--seconds", str(args.seconds), "--metrics", str(output / "metrics.json"),
                   "--screenshot", str(output / "view.ppm")]
    provenance = {
        "source": "Local native Bridge publisher over WebRTC",
        "source_video_hz": 30, "source_pose_hz_per_stream": 90,
        "viewer_sha256": hashlib.sha256(viewer.read_bytes()).hexdigest(),
        "publisher_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "seconds_requested": args.seconds,
        "viewer_arguments": viewer_args,
    }
    (output / "run.json").write_text(json.dumps(provenance, indent=2) + "\n")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    publisher = application = None
    samples = []
    try:
        with (output / "publisher.log").open("w") as source_log, \
                (output / "viewer.log").open("w") as viewer_log, \
                (output / "memory.jsonl").open("w") as memory_log:
            publisher = subprocess.Popen(source_args, stdout=source_log, stderr=subprocess.STDOUT,
                                         creationflags=flags)
            ready_until = time.monotonic() + 10
            while True:
                if publisher.poll() is not None:
                    raise RuntimeError("The local Bridge publisher exited before becoming ready")
                try:
                    with socket.create_connection(("127.0.0.1", args.port), timeout=.2):
                        break
                except OSError:
                    if time.monotonic() >= ready_until:
                        raise RuntimeError("The local Bridge publisher did not become ready")
                    time.sleep(.1)
            application = subprocess.Popen(viewer_args, stdout=viewer_log, stderr=subprocess.STDOUT,
                                           creationflags=flags)
            process = psutil.Process(application.pid)
            started = time.monotonic()
            next_sample = started
            next_message = started
            while application.poll() is None:
                if publisher.poll() is not None:
                    raise RuntimeError("The local Bridge publisher stopped during qualification")
                now = time.monotonic()
                if now >= next_sample:
                    memory = process.memory_info()
                    cpu = process.cpu_times()
                    partial = Path(str(record) + ".partial")
                    sample = {
                        "seconds": round(now - started, 3), "rss_bytes": memory.rss,
                        "private_bytes": getattr(memory, "private", memory.vms),
                        "threads": process.num_threads(),
                        "cpu_seconds": cpu.user + cpu.system,
                        "recording_bytes": partial.stat().st_size if partial.exists() else 0,
                    }
                    samples.append(sample)
                    memory_log.write(json.dumps(sample) + "\n")
                    memory_log.flush()
                    if memory.rss > 4 * 1024**3:
                        raise RuntimeError("Viewer working set exceeded the 4 GiB qualification guard")
                    next_sample = now + 10
                    if now >= next_message:
                        print(json.dumps({"elapsed_s": round(now - started),
                                          "viewer_rss_mib": round(memory.rss / 1048576, 1),
                                          "recording_mib": round(sample["recording_bytes"] / 1048576, 1)}),
                              flush=True)
                        next_message = now + 60
                time.sleep(.2)
            elapsed = time.monotonic() - started
            if application.returncode != 0:
                raise RuntimeError(f"Viewer exited with code {application.returncode}")
            metrics = json.loads((output / "metrics.json").read_text())
            assert metrics["record_status"] == "complete" and not metrics["decoder_error"]
            assert metrics["seconds"] >= args.seconds
            assert record.exists() and not Path(str(record) + ".partial").exists()
            warm = [sample for sample in samples if sample["seconds"] >= 60] or samples
            report = {
                "status": "passed", "source": provenance["source"],
                "seconds": elapsed, "samples": len(samples),
                "rss_min_after_warmup": min(sample["rss_bytes"] for sample in warm),
                "rss_max_after_warmup": max(sample["rss_bytes"] for sample in warm),
                "private_first_after_warmup": warm[0]["private_bytes"],
                "private_last": warm[-1]["private_bytes"],
                "recording_bytes": record.stat().st_size,
                "video_received_frames": metrics["video_received_frames"],
                "tracking_received_packets": metrics["tracking_received_packets"],
                "render_frames": metrics["render_frames"],
            }
            (output / "qualification.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report), flush=True)
    finally:
        stop(application)
        stop(publisher)


if __name__ == "__main__":
    main()
