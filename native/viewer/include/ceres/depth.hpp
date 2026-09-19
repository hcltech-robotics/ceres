#pragma once
#include "ceres/types.hpp"
#include <deque>
#include <span>

namespace ceres {
inline constexpr size_t depth_max_json_bytes = 4096;
inline constexpr size_t depth_max_frame_bytes = 8 + depth_max_json_bytes + 256 * 256 * 2;
inline constexpr size_t depth_fragment_bytes = 16384;
inline constexpr size_t depth_fragment_header_bytes = 24;
inline constexpr size_t depth_fragment_payload_bytes =
    depth_fragment_bytes - depth_fragment_header_bytes;
inline constexpr int64_t depth_fragment_lifetime_us = 300000;

struct DepthFrame {
    uint32_t epoch = 0, space_epoch = 0, sequence = 0;
    int64_t observed_us = 0, target_us = 0;
    uint16_t width = 0, height = 0, source_width = 0, source_height = 0;
    std::string eye, usage, source_format;
    std::array<float, 16> world_from_view{}, projection{}, norm_depth_from_norm_view{};
    std::vector<uint16_t> millimetres;
    Json metadata;
};

// CED1 is a complete, independently usable frame. Zero millimetres means invalid.
DepthFrame decode_depth(std::span<const uint8_t> bytes);
SessionEvent make_depth_event(std::vector<uint8_t> bytes, int64_t received_us,
                              const ClockMapping& mapping);

// CDF1 fragments can arrive out of order. Assemblies expire from first arrival,
// never extend their lifetime on duplicates and occupy at most two frame buffers.
class DepthAssembler {
  public:
    void reset(uint32_t epoch, uint32_t space_epoch);
    void expire(int64_t now_us);
    std::optional<std::vector<uint8_t>> push(std::span<const uint8_t> fragment,
                                             int64_t received_us);
    size_t queued_frames() const {
        return frames_.size();
    }
    size_t queued_bytes() const;

  private:
    struct Assembly {
        uint32_t sequence = 0;
        uint16_t count = 0, received = 0;
        int64_t first_us = 0;
        std::vector<uint8_t> bytes;
        std::array<bool, 9> present{};
    };
    uint32_t epoch_ = 0, space_epoch_ = 0;
    std::optional<uint32_t> completed_;
    std::deque<Assembly> frames_;
};
} // namespace ceres
