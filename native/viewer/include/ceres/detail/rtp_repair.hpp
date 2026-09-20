#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <span>
#include <vector>

namespace ceres::detail {
inline constexpr int64_t video_repair_window_us = 60000;
inline constexpr size_t video_reorder_packets = 512;
inline constexpr size_t video_reorder_bytes = 2 * 1024 * 1024;

inline uint16_t rtp_u16(const uint8_t* bytes) {
    return uint16_t(uint16_t(bytes[0]) << 8 | bytes[1]);
}
inline void put_network_u32(std::span<uint8_t> bytes, size_t at, uint32_t value) {
    for (size_t i = 0; i < 4; ++i)
        bytes[at + i] = uint8_t(value >> (24 - i * 8));
}
inline std::optional<size_t> rtp_payload_offset(std::span<const uint8_t> packet) {
    if (packet.size() < 12 || packet.size() > 65536 || packet[0] >> 6 != 2)
        return std::nullopt;
    size_t at = 12 + (packet[0] & 15) * 4;
    if (at > packet.size())
        return std::nullopt;
    if (packet[0] & 0x10) {
        if (at + 4 > packet.size())
            return std::nullopt;
        at += 4 + size_t(rtp_u16(packet.data() + at + 2)) * 4;
    }
    if (at >= packet.size())
        return std::nullopt;
    return at;
}

// RFC 4588 restores the original sequence, payload type and media SSRC before
// the packet reaches the ordinary H.264 reorder/assembly path.
inline std::optional<std::vector<uint8_t>> unwrap_rtx(std::span<const uint8_t> packet,
                                                    uint8_t media_payload, uint32_t media_ssrc) {
    const auto at = rtp_payload_offset(packet);
    if (!at)
        return std::nullopt;
    auto end = packet.size();
    if (packet[0] & 0x20) {
        const auto padding = packet.back();
        if (!padding || padding > end - *at)
            return std::nullopt;
        end -= padding;
    }
    if (end < *at + 3)
        return std::nullopt;
    std::vector<uint8_t> result(packet.begin(), packet.begin() + *at);
    result[0] &= uint8_t(~0x20);
    result[1] = uint8_t((result[1] & 0x80) | media_payload);
    result[2] = packet[*at];
    result[3] = packet[*at + 1];
    put_network_u32(result, 8, media_ssrc);
    result.insert(result.end(), packet.begin() + *at + 2, packet.begin() + end);
    return result;
}

class RtpRepair {
  public:
    void observe(uint16_t sequence, int64_t now_us) {
        ++received_;
        if (!greatest_) {
            greatest_ = sequence;
            return;
        }
        const auto extended = *greatest_ + int16_t(uint16_t(sequence - uint16_t(*greatest_)));
        missing_.erase(extended);
        if (extended <= *greatest_)
            return;
        if (extended - *greatest_ > int64_t(video_reorder_packets))
            missing_.clear();
        else
            for (auto absent = *greatest_ + 1; absent < extended; ++absent)
                missing_.try_emplace(absent, Missing{now_us});
        greatest_ = extended;
        while (missing_.size() > video_reorder_packets)
            missing_.erase(missing_.begin());
    }

    std::vector<uint16_t> requests(int64_t now_us) {
        std::vector<uint16_t> result;
        for (auto it = missing_.begin(); it != missing_.end();) {
            auto& item = it->second;
            if (now_us - item.began_us >= video_repair_window_us) {
                ++lost_;
                it = missing_.erase(it);
                continue;
            }
            if (now_us - item.began_us >= 5000 && item.attempts < 3 &&
                (!item.attempts || now_us - item.last_request_us >= 20000)) {
                result.push_back(uint16_t(it->first));
                item.last_request_us = now_us;
                ++item.attempts;
            }
            ++it;
        }
        return result;
    }

    std::optional<double> loss_fraction(int64_t now_us) {
        if (!feedback_us_) {
            feedback_us_ = now_us;
            return std::nullopt;
        }
        if (now_us - *feedback_us_ < 500000)
            return std::nullopt;
        feedback_us_ = now_us;
        const auto count = received_ + lost_;
        const auto fraction = count ? double(lost_) / double(count) : 0.0;
        received_ = lost_ = 0;
        return count >= 20 ? std::optional<double>(fraction) : std::nullopt;
    }

  private:
    struct Missing { int64_t began_us, last_request_us = 0; unsigned attempts = 0; };
    std::optional<int64_t> greatest_, feedback_us_;
    std::map<int64_t, Missing> missing_;
    uint64_t received_ = 0, lost_ = 0;
};

// RFC 4585 PID/BLP pairs include up to 17 missing packets per four-byte entry.
inline std::vector<uint8_t> nack_packet(uint32_t source, std::span<const uint16_t> sequences) {
    if (sequences.empty())
        return {};
    std::vector<uint8_t> packet(12);
    packet[0] = 0x81;
    packet[1] = 205;
    put_network_u32(packet, 4, source ^ 0x43455245u);
    put_network_u32(packet, 8, source);
    for (size_t i = 0; i < sequences.size();) {
        const auto pid = sequences[i++];
        uint16_t mask = 0;
        while (i < sequences.size()) {
            const auto delta = uint16_t(sequences[i] - pid);
            if (!delta || delta > 16)
                break;
            mask |= uint16_t(1u << (delta - 1));
            ++i;
        }
        packet.insert(packet.end(), {uint8_t(pid >> 8), uint8_t(pid),
                                     uint8_t(mask >> 8), uint8_t(mask)});
    }
    const auto length = packet.size() / 4 - 1;
    packet[2] = uint8_t(length >> 8);
    packet[3] = uint8_t(length);
    return packet;
}
} // namespace ceres::detail
