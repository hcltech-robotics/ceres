# Stream measurements

`Receiver.diagnostics()` reports bounded receiver counters, recent clock exchanges and pose arrival-age percentiles. `ceres-bridge status` reports the current stream, negotiated codec and consumer buffer allocation.

Use a wired Linux receiver and a Quest 3 on the same LAN. Select the LAN interface with `--bind-address`, then record the selected ICE candidate pair, codec, actual image geometry and camera rate. Compare H.264 and VP8 with receiver jitter settings of 0, 5 and 10 ms.

Measure p50, p95 and p99 for source observation to Python availability, and report clock uncertainty with those figures. Source sequence gaps, stale rejections and sender admission drops are separate counts. Measure steady-state rates over at least 60 seconds after connection and clock warm-up.

For video latency, place a receiver-controlled flashing/counter target in the outward camera view and compare target transitions with decoded frame availability. Account for display timing when measuring physical-event latency.

The reference targets are a pose p95 of 20 ms, video p95 of 100 ms, at least 99% of valid pose components and at least 95% of negotiated video frames over an uncongested 60-second interval. The aggregate 640-wide/90 Hz profile has a 5 Mbit/s on-wire budget. The sender begins with a 2 Mbit/s video cap. Include RTP, RTCP and SCTP traffic in bandwidth measurements.

A 30-minute soak covers tracking loss, recentring, consumer stalls, congestion, peer rebuilding and signalling loss after setup. Hold both frame leases in one consumer while another continues reading. Check that a stale pose becomes unavailable after 50 ms, held frames remain unchanged and memory stays bounded. Repeat with ROS 2 and Foxglove attached.
