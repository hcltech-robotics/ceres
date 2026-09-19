# NVDEC fixtures

These three six-frame H.264 clips are generated colour patterns. Each contains access-unit delimiters, an initial SPS/PPS/IDR and five dependent frames, without B-frames. The sequence changes resolution from 640x480 to 1280x960 and back, then resets decode history before keyframe recovery.

The clips were generated with FFmpeg 8.0 and libx264 using `testsrc2=size=WIDTHxHEIGHT:rate=12`, `-frames:v 6 -pix_fmt yuv420p -c:v libx264 -preset ultrafast -tune zerolatency -threads 2 -x264-params aud=1:repeat-headers=1:keyint=30:min-keyint=30:scenecut=0:bframes=0:threads=2:lookahead-threads=1 -f h264`. Clip C adds `-vf hue=h=90`.

`nvdec-cpu-reference.json` contains input hashes and the software-decoded NV12 hashes from FFmpeg 6.1.1. The GPU test compares every output pixel, checks recovery after losing decode history and verifies that an outstanding frame lease survives resolution changes and decoder destruction. CPU readback is confined to this test.

Regenerate the software references with:

```text
python scripts/nvdec-reference.py --inputs tests/fixtures/nvdec --ffmpeg /path/to/ffmpeg
```

Run the hardware check with `ctest --test-dir BUILD -R nvdec --output-on-failure`. It requires an NVIDIA GPU with H.264 decoding support.
