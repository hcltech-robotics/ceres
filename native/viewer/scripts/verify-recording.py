"""Validate a recording with the independent MCAP Python reader."""

import argparse
from collections import Counter
import json
import hashlib
import math
from pathlib import Path
import struct


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("recording", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    from mcap.reader import make_reader

    counts = Counter()
    keyframes = 0
    hand_assets = 0
    headset_assets = 0
    associations = 0
    assets = []
    first_receive_us = None
    last_receive_us = 0
    last_by_kind = {}
    with args.recording.open("rb") as stream:
        reader = make_reader(stream, validate_crcs=True)
        summary = reader.get_summary()
        assert summary is not None and summary.chunk_indexes
        for _, channel, message in reader.iter_messages(log_time_order=False):
            assert channel.message_encoding == "ceres-session-v1"
            data = message.data
            assert data[:4] == b"CSE1"
            size = struct.unpack_from("<I", data, 4)[0]
            header = json.loads(data[8:8 + size])
            assert header["version"] == 1
            assert header["session_receive_us"] >= 0
            assert header["session_time_us"] >= 0
            assert message.log_time == header["session_receive_us"] * 1000
            assert message.publish_time == header["session_time_us"] * 1000
            received = header["session_receive_us"]
            first_receive_us = received if first_receive_us is None else min(first_receive_us, received)
            last_receive_us = max(last_receive_us, received)
            kind = header["kind"]
            last_by_kind[kind] = max(last_by_kind.get(kind, 0), received)
            counts[kind] += 1
            payload = data[8 + size:]
            if kind == "pose":
                assert payload[:4] == b"CBR1"
                assert len(payload) in (68, 844)
            elif kind == "video":
                assert payload.startswith((b"\x00\x00\x01", b"\x00\x00\x00\x01"))
                keyframes += int(header["keyframe"])
                associations += int("head_pose" in header["attributes"])
                if "head_pose" in header["attributes"]:
                    head = header["attributes"]["head_pose"]
                    assert len(head) == 7 and all(math.isfinite(value) for value in head)
                    if "head_age_us" in header["attributes"]:
                        assert 0 <= header["attributes"]["head_age_us"] <= 50000
            elif kind == "asset" and header["attributes"].get("schema") == "ceres-hand-assets":
                assert payload[:4] in (b"CHM1", b"CHM2")
                hand_assets += 1
            elif kind == "asset" and header["attributes"].get("schema") == "ceres-headset-asset":
                assert payload[:4] == b"CQM1"
                headset_assets += 1
            if kind == "asset":
                assets.append({"stream": header["stream"], "bytes": len(payload),
                               "sha256": hashlib.sha256(payload).hexdigest(),
                               "attributes": header["attributes"]})
        assert sum(counts.values()) == summary.statistics.message_count
        assert "clock" in counts and "calibration" in counts and "epoch" in counts
    report = {
        "status": "passed", "bytes": args.recording.stat().st_size,
        "events": dict(counts), "chunks": len(summary.chunk_indexes),
        "keyframes": keyframes, "associated_images": associations,
        "embedded_hand_assets": hand_assets,
        "embedded_headset_assets": headset_assets,
        "first_receive_us": first_receive_us,
        "last_receive_us": last_receive_us,
        "last_receive_us_by_kind": last_by_kind,
        "assets": assets,
    }
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
