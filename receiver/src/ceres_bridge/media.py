"""One GStreamer peer and decoder, owned by the receiver worker process."""

import asyncio
import json
import threading

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstApp", "1.0")
gi.require_version("GstSdp", "1.0")
gi.require_version("GstWebRTC", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import GLib, Gst, GstSdp, GstVideo, GstWebRTC

from .protocol import parse_metadata
from .state import monotonic_us

Gst.init(None)


class MediaPeer:
    def __init__(self, state, broker, send_signal, *, jitter_ms=5, bind_address=None):
        try:
            self._initialise(state, broker, send_signal, jitter_ms=jitter_ms, bind_address=bind_address)
        except Exception:
            self.closed = True
            broker.request_keyframe = lambda: None
            if hasattr(self, "pipeline"):
                self.pipeline.set_state(Gst.State.NULL)
                if getattr(self, "bus_watched", False):
                    self.pipeline.get_bus().remove_signal_watch()
            if hasattr(self, "glib"):
                self.glib.quit()
            if hasattr(self, "thread") and self.thread.is_alive():
                self.thread.join(timeout=2)
            raise

    def _initialise(self, state, broker, send_signal, *, jitter_ms, bind_address):
        self.state, self.broker, self.send_signal = state, broker, send_signal
        self.loop = asyncio.get_running_loop()
        self.pipeline = Gst.Pipeline.new("ceres-bridge")
        self.webrtc = Gst.ElementFactory.make("webrtcbin", "peer")
        if not self.webrtc:
            raise RuntimeError("Install the GStreamer WebRTC and libnice plugins")
        self.webrtc.set_property("bundle-policy", GstWebRTC.WebRTCBundlePolicy.MAX_BUNDLE)
        self.webrtc.set_property("latency", jitter_ms)
        # Keep the GI wrapper alive for the peer lifetime. GStreamer 1.24 exposes
        # this property through a floating GstObject reference.
        self.ice = self.webrtc.get_property("ice-agent")
        self.ice.set_property("ice-tcp", False)
        self.pipeline.add(self.webrtc)
        self.glib = GLib.MainLoop()
        self.thread = threading.Thread(target=self.glib.run, name="ceres-media-events", daemon=True)
        self.thread.start()
        self.closed = False
        self.meta = None
        self.local_end = False
        self.remote_end = False
        self.acknowledged = False
        self.remote_set = False
        self.connected = asyncio.Event()
        self.changed = asyncio.Event()
        self.error = None
        self.video_bin = None
        self.audio_bin = None
        self.last_keyframe_request = 0
        self.broker.request_keyframe = self.request_keyframe
        self.pending_ice = []
        self.pings = {}
        self.ping_id = 0
        self.webrtc.connect("on-ice-candidate", self._candidate)
        self.webrtc.connect("notify::ice-gathering-state", self._gathering)
        self.webrtc.connect("notify::connection-state", self._connection)
        self.webrtc.connect("prepare-data-channel", self._prepare_channel)
        self.webrtc.connect("on-data-channel", self._channel)
        self.webrtc.connect("pad-added", self._pad)
        self.pipeline.connect("deep-element-added", self._element)
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        self.bus_watched = True
        bus.connect("message::error", self._error)
        if bind_address:
            # libnice restricts gathering to the selected LAN address.
            gi.require_version("Nice", "0.1")
            from gi.repository import Nice
            nice = self.nice = self.ice.get_property("agent")
            address = Nice.Address.new()
            if not address.set_from_string(bind_address) or not nice.add_local_address(address):
                raise ValueError("Cannot use the selected LAN address")
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("Cannot start the GStreamer receiver")

    def _notify(self):
        if not self.closed:
            self.loop.call_soon_threadsafe(self.changed.set)

    def _error(self, _bus, message):
        error, _debug = message.parse_error()
        self.error = error.message
        self._notify()

    def _element(self, _pipeline, _subbin, element):
        factory = element.get_factory()
        if factory and factory.get_name() == "rtpjitterbuffer":
            element.set_property("drop-on-latency", True)
            element.set_property("do-lost", True)

    def _candidate(self, _peer, line, candidate):
        if not self.closed:
            self.loop.call_soon_threadsafe(self.send_signal, {"candidate": {"candidate": candidate, "sdpMLineIndex": line}})

    def _gathering(self, *_):
        if self.webrtc.get_property("ice-gathering-state") == GstWebRTC.WebRTCICEGatheringState.COMPLETE:
            self.local_end = True
            self.loop.call_soon_threadsafe(self.send_signal, {"candidate": None})
            self._notify()

    def _connection(self, *_):
        value = self.webrtc.get_property("connection-state").value_nick
        with self.state.lock:
            self.state.connection = value
        self.loop.call_soon_threadsafe(self.connected.set if value == "connected" else self.connected.clear)
        self._notify()

    async def _promise(self, action, *args):
        future = self.loop.create_future()

        def complete(promise, *_):
            reply = promise.get_reply()
            def deliver():
                if not future.done():
                    if reply and reply.has_field("error"):
                        future.set_exception(RuntimeError(str(reply.get_value("error"))))
                    else:
                        future.set_result(reply)
            self.loop.call_soon_threadsafe(deliver)

        promise = Gst.Promise.new_with_change_func(complete, None, None)
        self.webrtc.emit(action, *args, promise)
        return await asyncio.wait_for(future, 10)

    async def signal(self, signal):
        if signal.get("type") == "offer":
            if self.remote_set or not isinstance(signal.get("sdp"), str) or len(signal["sdp"]) > 30_000:
                raise ValueError("Invalid Bridge offer")
            result, sdp = GstSdp.SDPMessage.new_from_text(signal["sdp"])
            if result != GstSdp.SDPResult.OK:
                raise ValueError("Invalid Bridge SDP")
            await self._promise("set-remote-description", GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdp))
            self.remote_set = True
            for candidate in self.pending_ice:
                self._add_candidate(candidate)
            self.pending_ice.clear()
            reply = await self._promise("create-answer", None)
            answer = reply.get_value("answer")
            await self._promise("set-local-description", answer)
            self.send_signal({"type": "answer", "sdp": answer.sdp.as_text()})
        elif "candidate" in signal:
            candidate = signal["candidate"]
            if candidate is None:
                self.remote_end = True
            if self.remote_set:
                self._add_candidate(candidate)
            elif len(self.pending_ice) < 64:
                self.pending_ice.append(candidate)
            else:
                raise ValueError("Too many Bridge ICE candidates")
        else:
            raise ValueError("Unexpected Bridge signalling message")
        self._notify()

    def _add_candidate(self, candidate):
        if candidate is None:
            self.webrtc.emit("add-ice-candidate", 0, "")
        elif (isinstance(candidate, dict) and type(candidate.get("sdpMLineIndex")) is int
              and 0 <= candidate["sdpMLineIndex"] <= 8 and isinstance(candidate.get("candidate"), str)
              and len(candidate["candidate"]) <= 2048):
            self.webrtc.emit("add-ice-candidate", candidate["sdpMLineIndex"], candidate["candidate"])
        else:
            raise ValueError("Invalid Bridge ICE candidate")

    def _prepare_channel(self, _peer, channel, _local):
        # DCEP has not populated label/reliability yet at prepare-data-channel.
        channel.connect("on-message-data", self._pose)
        channel.connect("on-message-string", self._metadata)

    def _pose(self, channel, data):
        if channel.get_property("label") == "ceres.pose.v1" and not channel.get_property("ordered") and channel.get_property("max-retransmits") == 0:
            self.state.accept(bytes(data.get_data()))
        else:
            self.error = "Unexpected Bridge binary channel"
            self._notify()

    def _channel(self, _peer, channel):
        label = channel.get_property("label")
        if label == "ceres.pose.v1" and not channel.get_property("ordered") and channel.get_property("max-retransmits") == 0:
            pass
        elif label == "ceres.meta.v1" and channel.get_property("ordered"):
            self.meta = channel
        else:
            channel.emit("close")
            self.error = f"Unexpected Bridge data channel: label={label!r}, ordered={channel.get_property('ordered')}, retransmits={channel.get_property('max-retransmits')}"
            self._notify()

    def _metadata(self, channel, raw):
        received = monotonic_us()
        try:
            if channel.get_property("label") != "ceres.meta.v1" or not channel.get_property("ordered"):
                raise ValueError("Unexpected Bridge metadata channel")
            self.meta = channel
            message = parse_metadata(raw)
            if message["epoch"] != self.state.epoch:
                raise ValueError("Foreign Bridge metadata epoch")
            with self.state.lock:
                if message["type"] == "description":
                    if self.state.description and self.state.description != message:
                        raise ValueError("Bridge description changed within one epoch")
                    self.state.description = message
                    channel.emit("send-string", json.dumps({"type": "ack", "version": 1, "epoch": self.state.epoch}))
                    self.acknowledged = True
                elif message["type"] == "pong":
                    expected = self.pings.pop(message["id"], None)
                    if expected is not None and expected == message["t0"]:
                        self.state.clock.add(expected, message["t1"], message["t2"], received)
                else:
                    raise ValueError("Unexpected Bridge metadata")
            self._notify()
        except (ValueError, TypeError, KeyError) as error:
            self.error = str(error)
            self._notify()

    def ping(self):
        if not self.meta or not self.acknowledged or self.closed:
            return
        if self.meta.get_property("buffered-amount") > 4096:
            return
        with self.state.lock:
            self.ping_id = (self.ping_id + 1) & 0xFFFFFFFF
            sent = monotonic_us()
            self.pings[self.ping_id] = sent
            if len(self.pings) > 8:
                del self.pings[next(iter(self.pings))]
            self.meta.emit("send-string", json.dumps({"type": "ping", "version": 1, "epoch": self.state.epoch,
                                                       "id": self.ping_id, "t0": sent}))

    def _pad(self, _peer, pad):
        if pad.get_direction() != Gst.PadDirection.SRC:
            return
        try:
            caps = pad.get_current_caps() or pad.query_caps(None)
            structure = caps.get_structure(0)
            encoding = structure.get_string("encoding-name")
            if structure.get_string("media") == "audio":
                if encoding != "OPUS" or self.audio_bin:
                    raise ValueError("Bridge accepts one Opus audio track")
                self.audio_bin = Gst.parse_bin_from_description(
                    "rtpopusdepay ! opusdec ! audioconvert ! audioresample ! "
                    "audio/x-raw,format=S16LE,rate=48000,channels=1,layout=interleaved ! "
                    "appsink name=audio emit-signals=true sync=false async=false max-buffers=1 drop=true wait-on-eos=false", True)
                self.audio_bin.get_by_name("audio").connect("new-sample", self._audio)
                self.pipeline.add(self.audio_bin)
                if pad.link(self.audio_bin.get_static_pad("sink")) != Gst.PadLinkReturn.OK:
                    raise RuntimeError("Cannot connect the audio decoder")
                self.audio_bin.sync_state_with_parent()
                return
            if structure.get_string("media") != "video" or encoding not in ("H264", "VP8") or self.video_bin:
                raise ValueError("Bridge accepts one H.264 or VP8 video track")
            decoder = "rtph264depay wait-for-keyframe=true request-keyframe=true ! h264parse name=parsed_h264 config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au ! tee name=access_units ! queue max-size-buffers=2 max-size-bytes=524288 max-size-time=100000000 ! avdec_h264 max-threads=1" if encoding == "H264" else "rtpvp8depay ! vp8dec threads=1"
            encoded_branch = " access_units. ! queue leaky=downstream max-size-buffers=1 max-size-bytes=262144 max-size-time=100000000 ! appsink name=encoded emit-signals=true sync=false max-buffers=1 drop=true wait-on-eos=false" if encoding == "H264" else ""
            self.video_bin = Gst.parse_bin_from_description(
                decoder + " ! videoconvert n-threads=1 ! video/x-raw,format=RGB ! appsink name=frames emit-signals=true sync=false max-buffers=1 drop=true wait-on-eos=false" + encoded_branch, True)
            sink = self.video_bin.get_by_name("frames")
            sink.connect("new-sample", self._frame)
            encoded_sink = self.video_bin.get_by_name("encoded")
            if encoded_sink:
                encoded_sink.connect("new-sample", self._encoded)
            with self.state.lock:
                self.state.codec = encoding.lower()
            self.pipeline.add(self.video_bin)
            if pad.link(self.video_bin.get_static_pad("sink")) != Gst.PadLinkReturn.OK:
                raise RuntimeError("Cannot connect the video decoder")
            self.video_bin.sync_state_with_parent()
        except Exception as error:
            self.error = str(error)
            self._notify()

    def request_keyframe(self):
        now = monotonic_us()
        if self.closed or not self.video_bin or now - self.last_keyframe_request < 200_000:
            return
        self.last_keyframe_request = now
        def request():
            if not self.closed and self.video_bin:
                parser = self.video_bin.get_by_name("parsed_h264")
                if parser:
                    parser.get_static_pad("src").send_event(GstVideo.video_event_new_upstream_force_key_unit(Gst.CLOCK_TIME_NONE, True, 0))
            return False
        GLib.idle_add(request)

    def _encoded(self, sink):
        sample = sink.emit("pull-sample")
        if not sample or self.closed:
            return Gst.FlowReturn.OK
        buffer = sample.get_buffer()
        success, mapped = buffer.map(Gst.MapFlags.READ)
        if success:
            try:
                self.broker.publish_encoded(mapped.data, not buffer.has_flags(Gst.BufferFlags.DELTA_UNIT), self.state.epoch,
                                            None if buffer.pts == Gst.CLOCK_TIME_NONE else buffer.pts)
            finally:
                buffer.unmap(mapped)
        return Gst.FlowReturn.OK

    def _frame(self, sink):
        sample = sink.emit("pull-sample")
        if not sample or self.closed:
            return Gst.FlowReturn.OK
        buffer = sample.get_buffer()
        info = GstVideo.VideoInfo.new_from_caps(sample.get_caps())
        if info.width > 640 or info.height > 1280:
            self.error = "Bridge video exceeds its negotiated geometry"
            self._notify()
            return Gst.FlowReturn.ERROR
        success, mapped = buffer.map(Gst.MapFlags.READ)
        if success:
            try:
                self.broker.publish_frame(mapped.data, info.width, info.height, info.stride[0], self.state.epoch,
                                          None if buffer.pts == Gst.CLOCK_TIME_NONE else buffer.pts)
            finally:
                buffer.unmap(mapped)
        return Gst.FlowReturn.OK

    def _audio(self, sink):
        sample = sink.emit("pull-sample")
        if not sample or self.closed:
            return Gst.FlowReturn.OK
        buffer = sample.get_buffer()
        success, mapped = buffer.map(Gst.MapFlags.READ)
        if success:
            try:
                self.broker.publish_audio(mapped.data, self.state.epoch,
                                          None if buffer.pts == Gst.CLOCK_TIME_NONE else buffer.pts)
            finally:
                buffer.unmap(mapped)
        return Gst.FlowReturn.OK

    @property
    def setup_complete(self):
        return self.connected.is_set() and self.acknowledged and self.local_end and self.remote_end

    def close(self):
        self.closed = True
        self.broker.request_keyframe = lambda: None
        self.pipeline.set_state(Gst.State.NULL)
        self.pipeline.get_bus().remove_signal_watch()
        self.glib.quit()
        self.thread.join(timeout=2)
        self.broker.reset()
