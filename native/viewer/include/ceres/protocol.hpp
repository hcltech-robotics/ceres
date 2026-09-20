#pragma once
#include "ceres/types.hpp"
#include <deque>
#include <map>
#include <span>
#include <string_view>

namespace ceres {
inline constexpr uint32_t bridge_joint_mask = 0x01ffffff;
inline constexpr std::array<std::string_view, 25> bridge_joints{
    "wrist",
    "thumb-metacarpal",
    "thumb-phalanx-proximal",
    "thumb-phalanx-distal",
    "thumb-tip",
    "index-finger-metacarpal",
    "index-finger-phalanx-proximal",
    "index-finger-phalanx-intermediate",
    "index-finger-phalanx-distal",
    "index-finger-tip",
    "middle-finger-metacarpal",
    "middle-finger-phalanx-proximal",
    "middle-finger-phalanx-intermediate",
    "middle-finger-phalanx-distal",
    "middle-finger-tip",
    "ring-finger-metacarpal",
    "ring-finger-phalanx-proximal",
    "ring-finger-phalanx-intermediate",
    "ring-finger-phalanx-distal",
    "ring-finger-tip",
    "pinky-finger-metacarpal",
    "pinky-finger-phalanx-proximal",
    "pinky-finger-phalanx-intermediate",
    "pinky-finger-phalanx-distal",
    "pinky-finger-tip"};
bool newer_sequence(uint32_t candidate, uint32_t previous) noexcept;
PoseSample decode_pose(std::span<const uint8_t> bytes, int64_t received_us = 0);
Json parse_metadata(std::string_view text);
StreamDescription parse_description(const Json& metadata);
// Resolves declared cameras against negotiated video MIDs without using arrival order.
std::vector<CameraDescription> camera_tracks(const StreamDescription& description,
                                             std::span<const std::string> mids);
// RTP and RTCP sender reports share media time, but do not establish exposure synchrony.
std::optional<int64_t> sender_media_time_us(uint32_t rtp, uint32_t report_rtp,
                                            uint64_t report_ntp) noexcept;

class ClockMap {
  public:
    bool add(int64_t t0, int64_t t1, int64_t t2, int64_t t3);
    ClockMapping mapping(int64_t now_us) const;
    void reset() noexcept {
        samples_.clear();
    }

  private:
    struct Sample {
        double uncertainty, sender, receiver;
        int64_t received;
    };
    std::deque<Sample> samples_;
};

struct H264AccessUnit {
    std::vector<uint8_t> bytes;
    uint32_t rtp_timestamp = 0;
    uint64_t extended_timestamp = 0;
    int64_t received_us = 0, time_us = 0;
    bool keyframe = false;
};

// Bounded RFC 6184 receiver with a 60 ms deadline for reordering and repair.
class H264Assembler {
  public:
    std::vector<H264AccessUnit> push(std::span<const uint8_t> packet, int64_t received_us);
    std::vector<H264AccessUnit> flush(int64_t now_us);
    bool take_keyframe_request() noexcept;
    void reset();

  private:
    struct Packet {
        uint32_t timestamp = 0;
        int64_t received_us = 0;
        bool marker = false;
        std::vector<uint8_t> bytes;
    };
    std::vector<H264AccessUnit> drain(int64_t now_us);
    void consume(const Packet&, std::vector<H264AccessUnit>&);
    void lose_frame();
    void add_nal(std::span<const uint8_t>);
    void finish_frame(const Packet&, std::vector<H264AccessUnit>&);
    std::map<int64_t, Packet> pending_;
    size_t pending_bytes_ = 0;
    std::vector<uint8_t> frame_, sps_, pps_;
    std::optional<uint32_t> ssrc_, timestamp_;
    int64_t greatest_sequence_ = 0, next_sequence_ = 0;
    int64_t timestamp_anchor_ = 0, time_anchor_ = 0, extended_timestamp_ = 0;
    bool sequence_started_ = false, time_started_ = false;
    bool fragmented_ = false, frame_invalid_ = false, keyframe_ = false;
    uint8_t fragment_header_ = 0;
    size_t fragment_begin_ = 0;
    bool has_sps_ = false, has_pps_ = false, needs_keyframe_ = true, request_keyframe_ = true;
};
} // namespace ceres
