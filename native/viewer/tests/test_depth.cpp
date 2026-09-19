#include "ceres/depth.hpp"
#include "ceres/protocol.hpp"
#include "ceres/session.hpp"
#include "depth_fixture.hpp"
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <mutex>
#include <thread>

using namespace ceres;
namespace {
void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
template <class F> void rejects(F function, const char* message) {
    try {
        function();
    } catch (const std::exception&) {
        return;
    }
    throw std::runtime_error(message);
}
void codec_tests() {
    const auto header = depth_fixture::header();
    const auto bytes = depth_fixture::encode(header);
    const auto frame = decode_depth(bytes);
    check(frame.width == 4 && frame.height == 3 && frame.epoch == 7 && frame.space_epoch == 2 &&
              frame.sequence == 1 && frame.observed_us == 4000000 && frame.target_us == 4011111 &&
              frame.millimetres[0] == 0 && frame.millimetres[1] == 65535 &&
              frame.millimetres[2] == 1234 && frame.world_from_view[13] == 1.6f,
          "Depth frame units, identity or matrix order changed");
    for (size_t length : {size_t(0), size_t(7), bytes.size() - 1})
        rejects([&] { decode_depth(std::span(bytes).first(length)); }, "Truncated depth accepted");
    auto bad = bytes;
    bad.push_back(0);
    rejects([&] { decode_depth(bad); }, "Trailing depth data accepted");
    depth_fixture::put(bad, 4, 4097);
    rejects([&] { decode_depth(bad); }, "Oversized depth metadata accepted");
    auto change = [&](const char* field, Json value) {
        auto h = header;
        h[field] = std::move(value);
        rejects([&] { decode_depth(depth_fixture::encode(h, 12)); },
                "Malformed depth field accepted");
    };
    change("version", 2);
    change("epoch", -1);
    change("sequence", 4294967296ULL);
    change("observed_us", 9007199254740992ULL);
    change("target_us", 1.5);
    change("geometry_source", "arrival");
    change("geometry_source", nullptr);
    change("mapping_version", 0);
    change("mapping_version", 3);
    change("mapping_version", true);
    change("readback_us", -1);
    change("readback_us", 1.5);
    change("readback_us", 9007199254740992ULL);
    change("target_lead_us", 1.5);
    change("target_lead_us", 0);
    change("target_lead_us", UINT64_MAX);
    change("width", 0);
    change("width", 257);
    change("source_width", 2);
    change("source_height", 8193);
    change("eye", "centre");
    change("usage", "gpu");
    change("source_format", "rgb");
    change("depth_format", "float32");
    change("projection", std::vector<float>(16, 0));
    change("projection", std::vector<float>(15, 1));
    change("norm_depth_from_norm_view", Json::array({nullptr}));
    auto world = header.at("world_from_view");
    world[3] = .5;
    change("world_from_view", world);
    auto identity = header;
    identity["secret"] = "forbidden";
    rejects([&] { decode_depth(depth_fixture::encode(identity)); },
            "Identity field entered recording");
    auto large = depth_fixture::header(1, 7, 2, 256, 256);
    check(decode_depth(depth_fixture::encode(large)).millimetres.size() == 65536,
          "Maximum depth dimensions rejected");

    const ClockMapping mapping{1000000, 250, 1.0001, true};
    const auto event = make_depth_event(bytes, 5020000, mapping);
    check(event.kind == EventKind::Depth && event.payload == bytes && event.receive_us == 5020000 &&
              event.time_us == 5011512 && event.attributes.at("mapped_observed_us") == 5000400 &&
              event.attributes.at("clock_uncertainty_us") == 250 &&
              event.attributes.at("target_us") == 4011111,
          "Depth source times or clock mapping changed");
    const auto fallback = make_depth_event(bytes, 5020000, {});
    check(fallback.time_us == fallback.receive_us && !fallback.attributes.at("clock_valid") &&
              fallback.attributes.at("mapped_target_us").is_null(),
          "Unmapped depth fabricated a sender mapping");
    for (const auto* geometry : {"sensor", "view", "view-fallback"}) {
        auto h = header;
        h["geometry_source"] = geometry;
        h["mapping_version"] = 2;
        h["readback_us"] = 42000;
        h["target_lead_us"] = 11111;
        const auto delayed = make_depth_event(depth_fixture::encode(h), 5600000, mapping);
        check(delayed.attributes.at("geometry_source") == geometry &&
                  delayed.attributes.at("readback_us") == 42000 &&
                  delayed.attributes.at("target_lead_us") == 11111 &&
                  delayed.time_us == event.time_us &&
                  decode_depth(delayed.payload).world_from_view == frame.world_from_view,
              "Delayed depth changed its capture geometry or timestamp provenance");
        const auto recorded = decode_session_event(encode_session_event(delayed, 5000000));
        check(recorded.attributes == delayed.attributes && recorded.payload == delayed.payload,
              "Recording changed depth capture diagnostics");
    }
    auto early = header;
    early["target_us"] = 3999000;
    early["target_lead_us"] = -1000;
    check(decode_depth(depth_fixture::encode(early)).target_us == 3999000,
          "Signed target lead was rejected");
    rejects([&] { make_depth_event(bytes, 1000, {0, 0, -1, true}); },
            "Negative clock rate accepted");
    const auto roundtrip = decode_session_event(encode_session_event(event, 5000000));
    check(roundtrip.kind == EventKind::Depth && roundtrip.payload == event.payload &&
              roundtrip.attributes == event.attributes && roundtrip.time_us == event.time_us,
          "MCAP envelope changed depth provenance");
}
std::vector<uint8_t> base64(const std::string& input) {
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::vector<uint8_t> bytes;
    unsigned accumulator = 0;
    int bits = 0;
    for (const auto c : input) {
        if (c == '=')
            break;
        const auto at = alphabet.find(c);
        check(at != std::string::npos, "Invalid pinned base64 fixture");
        accumulator = (accumulator << 6) | unsigned(at);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push_back(uint8_t(accumulator >> bits));
        }
    }
    return bytes;
}
void typescript_fixture_tests() {
    const auto path =
        std::filesystem::path(__FILE__).parent_path() / "fixtures" / "bridge-depth-v1.json";
    std::ifstream file(path);
    check(bool(file), "Pinned TypeScript depth fixtures are missing");
    const auto fixtures = Json::parse(file);
    check(fixtures.at("version") == 1 && fixtures.at("cases").size() == 3,
          "Pinned TypeScript fixture identity changed");
    for (const auto& item : fixtures.at("cases")) {
        const auto bytes = base64(item.at("frame_base64").get<std::string>());
        const auto frame = decode_depth(bytes);
        check(frame.metadata == item.at("header") &&
                  frame.millimetres == item.at("millimetres").get<std::vector<uint16_t>>(),
              "Native decoder disagrees with the exact TypeScript CED1 encoding");
        std::vector<std::vector<uint8_t>> fragments;
        for (const auto& fragment : item.at("fragments_base64"))
            fragments.push_back(base64(fragment.get<std::string>()));
        DepthAssembler assembler;
        assembler.reset(frame.epoch, frame.space_epoch);
        std::optional<std::vector<uint8_t>> completed;
        for (auto it = fragments.rbegin(); it != fragments.rend(); ++it)
            completed = assembler.push(*it, 1000000);
        check(completed && *completed == bytes,
              "Native reassembly disagrees with the exact TypeScript CDF1 encoding");
        check(!assembler.push(fragments.front(), 1000100),
              "TypeScript frame duplicate was emitted twice");
    }
}
void reassembly_tests() {
    auto h = depth_fixture::header(0xffffffffu, 7, 2, 256, 256);
    const auto bytes = depth_fixture::encode(h);
    const auto parts = depth_fixture::fragment(bytes, h);
    check(parts.size() == 9, "Maximum depth fixture did not exercise nine fragments");
    DepthAssembler assembler;
    assembler.reset(7, 2);
    std::optional<std::vector<uint8_t>> completed;
    for (size_t i = parts.size(); i-- > 0;) {
        auto result = assembler.push(parts[i], 1000 + int64_t(parts.size() - i));
        if (result)
            completed = std::move(result);
    }
    check(completed && *completed == bytes && assembler.queued_frames() == 0,
          "Out-of-order depth fragments changed the frame");
    check(!assembler.push(parts[0], 2000) && assembler.queued_frames() == 0,
          "Completed sequence was reassembled twice");
    h["sequence"] = 0;
    const auto wrapped = depth_fixture::fragment(depth_fixture::encode(h), h);
    for (const auto& part : wrapped)
        completed = assembler.push(part, 3000);
    check(completed && decode_depth(*completed).sequence == 0, "Depth sequence wrap rejected");

    assembler.reset(7, 2);
    assembler.push(parts[0], 1000);
    assembler.push(parts[0], 299999);
    assembler.expire(301000);
    check(assembler.queued_frames() == 0, "Duplicate fragment extended incomplete-frame lifetime");
    for (uint32_t sequence = 1; sequence <= 20; ++sequence) {
        h["sequence"] = sequence;
        const auto next = depth_fixture::fragment(depth_fixture::encode(h), h);
        assembler.push(next[0], 400000 + sequence);
        check(assembler.queued_frames() <= 2 &&
                  assembler.queued_bytes() <= 2 * depth_max_frame_bytes,
              "Depth fragment memory grew beyond its bound");
    }
    assembler.reset(7, 3);
    rejects([&] { assembler.push(parts[0], 500000); }, "Old reference-space depth accepted");
    assembler.reset(8, 2);
    rejects([&] { assembler.push(parts[0], 500000); }, "Old connection depth accepted");
    assembler.reset(7, 2);
    auto bad = parts[0];
    depth_fixture::put(bad, 20, depth_max_frame_bytes + 1);
    rejects([&] { assembler.push(bad, 600000); }, "Oversized depth allocation accepted");
    bad = parts[0];
    bad.pop_back();
    rejects([&] { assembler.push(bad, 600000); }, "Short non-final fragment accepted");
    bad = parts[0];
    depth_fixture::put(bad, 18, 8, 2);
    rejects([&] { assembler.push(bad, 600000); }, "Incorrect fragment count accepted");
    assembler.push(parts[0], 600000);
    bad = parts[0];
    bad.back() ^= 1;
    rejects([&] { assembler.push(bad, 600001); }, "Conflicting duplicate fragment accepted");
    check(assembler.queued_frames() == 0, "Conflicting assembly survived rejection");
    h = depth_fixture::header();
    auto small = depth_fixture::fragment(depth_fixture::encode(h), h)[0];
    depth_fixture::put(small, 12, 9);
    rejects([&] { assembler.push(small, 700000); }, "Frame and fragment identities disagreed");
}
Json description() {
    Json joints = Json::array();
    for (auto name : bridge_joints)
        joints.push_back(name);
    return {{"type", "description"},
            {"version", 1},
            {"epoch", 7},
            {"clock",
             {{"id", "depth-test"}, {"units", "microseconds"}, {"domain", "sender-monotonic"}}},
            {"referenceSpace", "local-floor"},
            {"axes", "right-handed-x-right-y-up-z-back"},
            {"units", "metres"},
            {"quaternion", "xyzw"},
            {"joints", joints},
            {"environment_depth",
             {{"version", 1},
              {"channel", "ceres-depth-v1"},
              {"format", "uint16-mm"},
              {"max_width", 256},
              {"max_height", 256}}}};
}
void description_tests() {
    const auto d = description();
    const auto parsed = parse_description(parse_metadata(d.dump()));
    check(parsed.cameras.empty() && parsed.width == 0 && camera_tracks(parsed, {}).empty(),
          "Depth-only description required a camera");
    auto bad = d;
    bad.erase("environment_depth");
    rejects([&] { parse_description(bad); }, "Empty acquisition description accepted");
    bad = d;
    bad["environment_depth"]["max_width"] = 257;
    rejects([&] { parse_description(bad); }, "Unbounded depth capability accepted");
    const Json status{{"type", "depth-status"},  {"version", 1},     {"epoch", 7},
                      {"status", "unsupported"}, {"usage", nullptr}, {"source_format", nullptr}};
    check(parse_metadata(status.dump()) == status, "Depth status not preserved");
    bad = status;
    bad["status"] = "unknown";
    rejects([&] { parse_metadata(bad.dump()); }, "Unknown depth status accepted");
}
void session_tests() {
    const auto path = std::filesystem::temp_directory_path() /
                      ("ceres-depth-test-" + std::to_string(monotonic_us()) + ".mcap");
    SessionEvent metadata;
    metadata.epoch = 7;
    metadata.space_epoch = 2;
    metadata.receive_us = metadata.time_us = 1000000;
    metadata.attributes = description();
    Recorder recorder;
    recorder.start(path, {metadata});
    auto frame = [&](uint32_t sequence, uint32_t space, int64_t time) {
        auto h = depth_fixture::header(sequence, 7, space);
        h["observed_us"] = time - 100;
        h["target_us"] = time;
        auto event = make_depth_event(depth_fixture::encode(h), time, {0, 10, 1, true});
        check(recorder.push(event), "Depth recording rejected complete frame");
        return event;
    };
    frame(1, 2, 1010000);
    const auto second = frame(2, 2, 1020000);
    SessionEvent reset;
    reset.kind = EventKind::Epoch;
    reset.epoch = 7;
    reset.space_epoch = 3;
    reset.receive_us = reset.time_us = 1030000;
    reset.attributes = {{"reason", "reference-space"}};
    check(recorder.push(reset), "Reference-space reset was not recorded");
    frame(200, 2, 1032000);
    const auto third = frame(3, 3, 1040000);
    const auto fourth = frame(4, 3, 1100000);
    recorder.stop();
    check(!recorder.status().failed && recorder.status().written_events == 7,
          "Depth recorder dropped completed observations");

    ReplaySource replay(path);
    replay.set_playing(false);
    std::mutex mutex;
    std::condition_variable changed;
    std::vector<SessionEvent> frames;
    uint64_t generation = 0;
    replay.set_event_sink([&](const SessionEvent& event) {
        std::lock_guard lock(mutex);
        if (event.kind == EventKind::Epoch && event.attributes.value("reason", "") == "seek") {
            frames.clear();
            generation = event.attributes.at("replay_generation");
        }
        if (event.kind == EventKind::Depth)
            frames.push_back(event);
        changed.notify_all();
    });
    replay.start();
    auto seek = [&](int64_t position, size_t count) {
        uint64_t previous;
        {
            std::lock_guard lock(mutex);
            previous = generation;
        }
        replay.seek(position);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        for (;;) {
            {
                std::unique_lock lock(mutex);
                changed.wait_for(lock, std::chrono::milliseconds(5));
                if (generation > previous && frames.size() == count &&
                    replay.position_us() == position &&
                    (count || replay.snapshot().space_epoch == 3))
                    return frames;
            }
            check(std::chrono::steady_clock::now() < deadline,
                  "Depth seek did not restore its state");
        }
    };
    auto restored = seek(20000, 1);
    check(restored[0].payload == second.payload &&
              restored[0].attributes.at("session_time_us") == 20000 &&
              restored[0].attributes.at("target_us") == 1020000 &&
              replay.snapshot().depth_frames == 1 && replay.snapshot().depth_status == "streaming",
          "Depth seek changed payload, timing or snapshot");
    check(restored[0].attributes.at("replay_delivery_us").get<int64_t>() <= monotonic_us() &&
              monotonic_us() - restored[0].attributes.at("replay_delivery_us").get<int64_t>() < 1000000,
          "Replay did not preserve its actual local delivery time");
    restored = seek(35000, 0);
    check(restored.empty(), "Old-space depth survived a seek");
    restored = seek(40000, 1);
    check(restored[0].payload == third.payload && restored[0].space_epoch == 3,
          "Depth seek did not restore the new reference space");
    replay.set_playing(true);
    {
        std::unique_lock lock(mutex);
        check(changed.wait_for(lock, std::chrono::seconds(2), [&] { return frames.size() == 2; }),
              "Fresh depth after seek did not play");
        check(frames.back().payload == fourth.payload, "Fresh depth changed during playback");
    }
    replay.set_playing(false);
    restored = seek(20000, 1);
    check(restored[0].payload == second.payload && replay.snapshot().space_epoch == 2,
          "Backward seek retained later depth or space");
    replay.stop();
    std::filesystem::remove(path);
}
} // namespace
int main() {
    try {
        codec_tests();
        typescript_fixture_tests();
        reassembly_tests();
        description_tests();
        session_tests();
        std::cout
            << "Depth parsing, bounded fragments, clock mapping and recording/replay passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
