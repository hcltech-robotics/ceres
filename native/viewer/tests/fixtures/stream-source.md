# Local Bridge stream source

The Bridge acceptance executable can publish an Annex B H.264 file over the native
WebRTC transport. The source provides one 640x480 camera, a head transform and two
25-joint hands. It sends the camera at 30 frames per second and each pose stream at
90 samples per second. Clock exchanges use a separate sender clock and the camera
uses the 90 kHz RTP clock. The source responds to keyframe requests and starts each
connection at an IDR picture.

The H.264 input must contain access unit delimiters, an initial IDR and SPS/PPS
parameter sets. Encode without B frames. The source keeps up to 64 MiB of compressed
input in memory and loops it for the requested duration.

Start the source in one terminal:

```powershell
rtk proxy .\build-native\test_bridge.exe --stream-fixture D:\data\ceres-viewer\acceptance\camera-fixture.h264 --seconds 3700 --port 8765
```

Connect the viewer with a dedicated configuration directory:

```powershell
rtk proxy .\build-native\ceres-viewer.exe --origin http://127.0.0.1:8765 --config-dir D:\data\ceres-viewer\acceptance\webrtc-config
```

The separate configuration directory gives this local source its own pairing
identity and preferences. The source accepts one receiver and listens only on
loopback. The local pairing state is held in memory. Restarting the source allows
the receiver to create a fresh local binding.

For a transport check without opening the viewer, use `--self-test`. Adding
`--capture` saves the access units received after WebRTC depacketisation so that
FFmpeg can check the complete received stream:

```powershell
rtk proxy .\build-native\test_bridge.exe --stream-fixture D:\data\ceres-viewer\acceptance\camera-fixture.h264 --seconds 8 --port 0 --self-test --capture D:\data\ceres-viewer\acceptance\webrtc-received.h264
rtk proxy ffmpeg -hide_banner -loglevel error -i D:\data\ceres-viewer\acceptance\webrtc-received.h264 -f null -
```

`--port 0` selects a free port and prints the selected origin. `--fps 60` changes
the transport cadence and advertised camera rate to 60 frames per second. The
default invocation without arguments runs the deterministic Bridge integration
test.
