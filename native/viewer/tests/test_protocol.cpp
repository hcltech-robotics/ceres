#include "ceres/protocol.hpp"
#include <bit>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
void check(bool condition, const char* text) {
    if (!condition)
        throw std::runtime_error(text);
}
template <class F> void rejects(F function, const char* text) {
    try {
        function();
    } catch (const std::exception&) {
        return;
    }
    throw std::runtime_error(text);
}
void put16(std::vector<uint8_t>& b, size_t at, uint16_t value) {
    b[at] = uint8_t(value);
    b[at + 1] = uint8_t(value >> 8);
}
void put32(std::vector<uint8_t>& b, size_t at, uint32_t value) {
    for (int i = 0; i < 4; ++i)
        b[at + i] = uint8_t(value >> (i * 8));
}
std::vector<uint8_t> from_hex(const std::string& text) {
    std::vector<uint8_t> bytes;
    for (size_t i = 0; i < text.size(); i += 2)
        bytes.push_back(static_cast<uint8_t>(std::stoul(text.substr(i, 2), nullptr, 16)));
    return bytes;
}
std::vector<uint8_t> rtp(uint16_t sequence, uint32_t timestamp, bool marker,
                         std::initializer_list<uint8_t> nal) {
    std::vector<uint8_t> result{0x80,
                                uint8_t(96 | (marker ? 0x80 : 0)),
                                uint8_t(sequence >> 8),
                                uint8_t(sequence),
                                uint8_t(timestamp >> 24),
                                uint8_t(timestamp >> 16),
                                uint8_t(timestamp >> 8),
                                uint8_t(timestamp),
                                0,
                                0,
                                0,
                                1};
    result.insert(result.end(), nal);
    return result;
}
ceres::Json description() {
    ceres::Json joints = ceres::Json::array();
    for (auto name : ceres::bridge_joints)
        joints.push_back(name);
    return {
        {"type", "description"},
        {"version", 1},
        {"epoch", 7},
        {"clock", {{"id", "clock-one"}, {"units", "microseconds"}, {"domain", "sender-monotonic"}}},
        {"referenceSpace", "local-floor"},
        {"axes", "right-handed-x-right-y-up-z-back"},
        {"units", "metres"},
        {"quaternion", "xyzw"},
        {"joints", joints},
        {"camera",
         {{"side", "left"},
          {"width", 640},
          {"height", 480},
          {"requestedWidth", 640},
          {"fps", 30},
          {"calibration", nullptr}}}};
}
} // namespace
int main() {
    try {
        std::ifstream input(std::filesystem::path(__FILE__).parent_path() / "fixtures" /
                            "bridge-poses.json");
        check(bool(input), "Pinned upstream fixtures are missing");
        const auto fixtures = ceres::Json::parse(input);
        for (const auto& fixture : fixtures) {
            auto bytes = from_hex(fixture["hex"].get<std::string>());
            const auto pose = ceres::decode_pose(bytes, 123456);
            check(pose.kind == fixture["kind"].get<int>(), "Fixture pose kind differs");
            check(pose.sequence == fixture["sequence"].get<uint32_t>(),
                  "Fixture pose sequence differs");
            check(pose.epoch == 7 && pose.space_epoch == 2 && pose.received_us == 123456,
                  "Fixture epoch or arrival differs");
            check(pose.valid ==
                      (fixture["name"].get<std::string>().find("-tracked") != std::string::npos),
                  "Fixture validity differs");
            auto invalid = bytes;
            invalid[0] = 0;
            rejects([&] { ceres::decode_pose(invalid); }, "Bad magic accepted");
            invalid = bytes;
            invalid.push_back(0);
            rejects([&] { ceres::decode_pose(invalid); }, "Oversized packet accepted");
            invalid = bytes;
            invalid.resize(39);
            rejects([&] { ceres::decode_pose(invalid); }, "Truncated packet accepted");
        }
        auto head = from_hex(fixtures[1]["hex"].get<std::string>());
        auto invalid = head;
        put16(invalid, 6, 2);
        rejects([&] { ceres::decode_pose(invalid); }, "Unknown flags accepted");
        invalid = head;
        put32(invalid, 40, 0x7fc00000);
        rejects([&] { ceres::decode_pose(invalid); }, "NaN position accepted");
        invalid = head;
        put32(invalid, 64, 0);
        rejects([&] { ceres::decode_pose(invalid); }, "Zero quaternion accepted");
        invalid = head;
        put16(invalid, 6, 0);
        rejects([&] { ceres::decode_pose(invalid); }, "Untracked nonzero transform accepted");
        invalid = head;
        invalid[31] = 0xff;
        rejects([&] { ceres::decode_pose(invalid); }, "Unsafe source timestamp accepted");
        auto hand = from_hex(fixtures[3]["hex"].get<std::string>());
        invalid = hand;
        put32(invalid, 40, 0xffffffff);
        rejects([&] { ceres::decode_pose(invalid); }, "Invalid joint mask accepted");
        invalid = hand;
        put32(invalid, 72, std::bit_cast<uint32_t>(-0.1f));
        rejects([&] { ceres::decode_pose(invalid); }, "Negative radius accepted");
        check(ceres::newer_sequence(0, 0xffffffff) && !ceres::newer_sequence(0xffffffff, 0) &&
                  !ceres::newer_sequence(5, 5),
              "Sequence wrap differs");
        check(!ceres::newer_sequence(0x80000000, 0), "Ambiguous sequence half range accepted");

        const auto metadata = description();
        check(ceres::parse_description(ceres::parse_metadata(metadata.dump())).side == "left",
              "Description parse differs");
        std::ifstream camera_fixture(std::filesystem::path(__FILE__).parent_path() / "fixtures" /
                                     "bridge-cameras.json");
        check(bool(camera_fixture), "Pinned upstream camera fixture is missing");
        const auto dual = ceres::Json::parse(camera_fixture).at("description");
        const auto parsed = ceres::parse_description(ceres::parse_metadata(dual.dump()));
        check(parsed.cameras.size() == 2 && parsed.width == 1280 && parsed.side == "right" &&
                  parsed.cameras[0].stream == "passthrough" &&
                  parsed.cameras[1].stream == "passthrough_left" && !parsed.cameras[1].primary,
              "Dual camera identity or legacy primary differs");
        const std::array<std::string, 2> reverse_mids{"1", "0"};
        const auto tracks = ceres::camera_tracks(parsed, reverse_mids);
        check(tracks[0].mid == "0" && tracks[1].mid == "1",
              "SDP arrival order selected the primary camera");
        for (const auto& mids :
             {std::vector<std::string>{"0"}, std::vector<std::string>{"0", "0"},
              std::vector<std::string>{"0", "2"}, std::vector<std::string>{"0", "1", "2"}})
            rejects([&] { ceres::camera_tracks(parsed, mids); },
                    "Mismatched negotiated camera identity accepted");
        auto mono = dual;
        mono.erase("cameras");
        const std::array<std::string, 1> mono_mid{"legacy-camera"};
        const auto legacy = ceres::camera_tracks(ceres::parse_description(mono), mono_mid);
        check(legacy.size() == 1 && legacy[0].mid == "legacy-camera" && legacy[0].primary,
              "Legacy mono camera routing differs");
        rejects([&] { ceres::camera_tracks(ceres::parse_description(mono), reverse_mids); },
                "Undeclared secondary camera accepted");
        auto single = dual;
        single["cameras"].erase(1);
        check(ceres::parse_description(single).cameras.size() == 1,
              "Explicit single camera metadata rejected");
        for (const auto& cameras :
             {ceres::Json(), ceres::Json::object(), ceres::Json::array(),
              ceres::Json::array({dual["cameras"][0], dual["cameras"][1], dual["cameras"][1]})}) {
            auto invalid = dual;
            invalid["cameras"] = cameras;
            rejects([&] { ceres::parse_metadata(invalid.dump()); }, "Invalid camera list accepted");
        }
        for (const auto& [key, value] : std::vector<std::pair<std::string, ceres::Json>>{
                 {"mid", "0"},
                 {"mid", ""},
                 {"mid", "invalid mid"},
                 {"mid", "a/b"},
                 {"mid", std::string(65, 'x')},
                 {"side", "right"},
                 {"side", "unknown"},
                 {"width", 0},
                 {"width", 8193},
                 {"fps", "30"},
                 {"calibration", ceres::Json::object()}}) {
            auto invalid = dual;
            invalid["cameras"][1][key] = value;
            rejects([&] { ceres::parse_metadata(invalid.dump()); },
                    "Invalid secondary camera accepted");
        }
        auto mismatch = dual;
        mismatch["camera"]["height"] = 480;
        rejects([&] { ceres::parse_metadata(mismatch.dump()); },
                "Mismatched primary camera accepted");
        const uint64_t report_ntp = (uint64_t(3900000000) << 32) | 0x80000000u;
        check(ceres::sender_media_time_us(90000, 0, report_ntp) == 3900000001500000ll &&
                  ceres::sender_media_time_us(0x00000770, 0xfffff000, report_ntp) ==
                      3900000000566666ll &&
                  !ceres::sender_media_time_us(0, 0, 0) &&
                  !ceres::sender_media_time_us(450001, 0, report_ntp),
              "Sender-report media timing or wrap differs");
        auto bad = metadata;
        bad["camera"]["calibration"] = {{"fx", 300}};
        rejects([&] { ceres::parse_metadata(bad.dump()); },
                "Unsupported wire calibration accepted");
        bad = metadata;
        bad["joints"][0] = "index-finger-tip";
        rejects([&] { ceres::parse_metadata(bad.dump()); }, "Wrong joint order accepted");
        bad = metadata;
        bad["camera"]["width"] = 0;
        rejects([&] { ceres::parse_metadata(bad.dump()); }, "Zero image width accepted");
        rejects([&] { ceres::parse_metadata(std::string(8193, ' ')); },
                "Oversized metadata accepted");
        bad = metadata;
        bad["camera"]["secret"] = "private-test-value";
        rejects([&] { ceres::parse_metadata(bad.dump()); },
                "Credential fields accepted in observation metadata");
        std::string private_error;
        try {
            ceres::parse_metadata("{\"secret\":\"private-test-value\"");
        } catch (const std::exception& e) {
            private_error = e.what();
        }
        check(!private_error.empty() &&
                  private_error.find("private-test-value") == std::string::npos,
              "Metadata parse error exposed private contents");
        rejects(
            [&] {
                ceres::parse_metadata(
                    R"({"version":1,"epoch":7,"type":"pong","id":1,"t0":100,"t1":300,"t2":200})");
            },
            "Backwards pong accepted");

        ceres::ClockMap clock;
        check(!clock.mapping(100).valid, "Empty clock valid");
        check(clock.add(1000, 5100, 5100, 1200), "First clock exchange rejected");
        auto mapped = clock.mapping(1200);
        check(mapped.valid && std::abs(mapped.offset_us + 4000) < 1e-9 &&
                  mapped.uncertainty_us == 100,
              "First clock mapping differs");
        check(clock.add(1001000, 1005100, 1005100, 1001200), "Second clock exchange rejected");
        mapped = clock.mapping(1001200);
        check(mapped.valid && std::abs(mapped.rate - 1) < 1e-9 &&
                  std::abs(mapped.offset_us + 4000) < 1e-6,
              "Affine clock mapping differs");
        check(!clock.add(100, 100, 300, 150), "Negative clock RTT accepted");
        check(!clock.mapping(5000000).valid, "Expired clock valid");
        clock.reset();
        for (int64_t i = 0; i < 8; ++i) {
            const int64_t receiver = 1000000 + i * 250000;
            const int64_t sender = 5000000 + i * 200000;
            check(clock.add(receiver - 100, sender, sender, receiver + 100),
                  "Drift fixture rejected");
        }
        mapped = clock.mapping(2750100);
        check(mapped.valid && std::abs(mapped.rate - 1.25) < 1e-8, "Clock rate fit differs");

        ceres::H264Assembler h264;
        auto frames = h264.push(
            rtp(100, 9000, true, {24, 0, 2, 0x67, 0x11, 0, 2, 0x68, 0x22, 0, 2, 0x65, 0x33}),
            1000000);
        check(frames.size() == 1 && frames[0].keyframe && frames[0].bytes.size() == 18,
              "STAP-A IDR assembly differs");
        check(frames[0].time_us == 1000000, "First media timestamp not anchored to arrival");
        check(h264.push(rtp(101, 12000, false, {0x7c, 0x81, 1, 2}), 1010000).empty(),
              "Premature FU frame");
        check(h264.push(rtp(103, 12000, true, {0x7c, 0x41, 5, 6}), 1011000).empty(),
              "Reordered tail emitted early");
        frames = h264.push(rtp(102, 12000, false, {0x7c, 0x01, 3, 4}), 1012000);
        check(frames.size() == 1 &&
                  frames[0].bytes == std::vector<uint8_t>({0, 0, 0, 1, 0x61, 1, 2, 3, 4, 5, 6}),
              "FU-A reorder assembly differs");
        h264.take_keyframe_request();
        h264.push(rtp(104, 15000, false, {0x7c, 0x81, 1}), 1020000);
        h264.push(rtp(106, 15000, true, {0x7c, 0x41, 3}), 1021000);
        check(h264.flush(1032000).empty() && h264.take_keyframe_request(),
              "Lost fragment did not request recovery");
        check(h264.push(rtp(107, 18000, true, {0x61, 4}), 1040000).empty(),
              "Dependent frame emitted after loss");
        frames = h264.push(rtp(108, 21000, true, {0x65, 5}), 1050000);
        check(frames.size() == 1 && frames[0].keyframe && frames[0].bytes.size() == 18,
              "Keyframe recovery did not restore cached SPS/PPS");
        h264.reset();
        h264.push(rtp(65535, 0xfffff000, true, {0x65, 1}), 2000000);
        frames = h264.push(rtp(0, 0x00000770, true, {0x61, 2}), 2100000);
        check(frames.size() == 1 && frames[0].extended_timestamp == uint64_t(0xfffff000) + 6000 &&
                  frames[0].time_us == 2066666,
              "RTP wrap differs");
        auto broken = rtp(1, 1000, true, {0x65, 1});
        broken.resize(16);
        broken[0] |= 0x10;
        broken[14] = 0xff;
        broken[15] = 0xff;
        check(h264.push(broken, 2200000).empty(), "Invalid RTP extension accepted");
        h264.reset();
        h264.push(rtp(1, 9000, false, {0x7c, 0x87, 0x11}), 3000000);
        h264.push(rtp(2, 9000, false, {0x7c, 0x47, 0x12}), 3000001);
        h264.push(rtp(3, 9000, false, {0x68, 0x22}), 3000002);
        frames = h264.push(rtp(4, 9000, true, {0x65, 0x33}), 3000003);
        check(frames.size() == 1 && frames[0].bytes.size() == 19,
              "Fragmented parameter set assembly differs");
        frames = h264.push(rtp(5, 12000, true, {0x65, 0x44}), 3033333);
        check(frames.size() == 1 && frames[0].bytes.size() == 19,
              "Fragmented SPS was not cached for the next keyframe");
        h264.take_keyframe_request();
        h264.push(rtp(6, 15000, false, {0x7c, 0x81, 0x11}), 3066666);
        check(h264.push(rtp(7, 15000, true, {0x7c, 0x42, 0x22}), 3066667).empty() &&
                  h264.take_keyframe_request(),
              "Mismatched FU-A headers did not trigger recovery");
        std::cout << "PASS: Bridge fixtures, validation, affine clock and bounded H264 recovery\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
