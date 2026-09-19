#pragma once
#include "ceres/types.hpp"
#include <rtc/rtcpreceivingsession.hpp>
#include <cstdint>
#include <mutex>
#include <optional>
#include <span>

namespace ceres {
struct RtcpSenderReport {
    uint32_t ssrc = 0, rtp_timestamp = 0;
    uint64_t ntp_timestamp = 0;
    int64_t received_us = 0;
};

// RTP and RTCP callbacks run independently of the receiver event worker. Report
// age always measures control-message arrival, including when video is paused.
class RtcpMediaClock {
  public:
    void observe_source(uint32_t ssrc) {
        std::lock_guard lock(mutex_);
        if ((ssrc_ && *ssrc_ != ssrc) || (report_ && report_->ssrc != ssrc))
            report_.reset();
        ssrc_ = ssrc;
    }
    void observe_report(RtcpSenderReport report) {
        std::lock_guard lock(mutex_);
        if (!report.ntp_timestamp || report.received_us < 0 || (ssrc_ && *ssrc_ != report.ssrc))
            return;
        report_ = report;
    }
    std::optional<RtcpSenderReport> report(uint32_t ssrc, int64_t frame_received_us) const {
        std::lock_guard lock(mutex_);
        if (!ssrc_ || *ssrc_ != ssrc || !report_ || report_->ssrc != ssrc ||
            frame_received_us < report_->received_us ||
            frame_received_us - report_->received_us > 5000000)
            return std::nullopt;
        return report_;
    }

  private:
    mutable std::mutex mutex_;
    std::optional<uint32_t> ssrc_;
    std::optional<RtcpSenderReport> report_;
};
inline uint32_t network_u32(const uint8_t* bytes) noexcept {
    return uint32_t(bytes[0]) << 24 | uint32_t(bytes[1]) << 16 | uint32_t(bytes[2]) << 8 |
           uint32_t(bytes[3]);
}
inline std::optional<uint32_t> rtp_source(std::span<const uint8_t> packet) noexcept {
    if (packet.size() < 12 || packet[0] >> 6 != 2 || (packet[1] >= 192 && packet[1] <= 223))
        return std::nullopt;
    return network_u32(packet.data() + 8);
}

class RtcpCameraSession final : public rtc::RtcpReceivingSession {
  public:
    RtcpMediaClock clock;

    void incoming(rtc::message_vector& messages, const rtc::message_callback& send) override {
        incoming_at(messages, send, monotonic_us());
    }

    void incoming_at(rtc::message_vector& messages, const rtc::message_callback& send,
                     int64_t received_us) {
        // Observe a changed RTP source before admitting reports from the same
        // batch, then process every report before forwarding video downstream.
        for (const auto& message : messages)
            if (message->type == rtc::Message::Binary)
                if (const auto ssrc = rtp_source(bytes(*message)))
                    clock.observe_source(*ssrc);
        for (const auto& message : messages) {
            if (message->type != rtc::Message::Control)
                continue;
            const auto data = bytes(*message);
            size_t at = 0;
            while (at + 4 <= data.size()) {
                const auto* block = data.data() + at;
                const size_t length = (size_t(block[2]) * 256 + block[3] + 1) * 4;
                if (block[0] >> 6 != 2 || length > data.size() - at)
                    break;
                const auto count = block[0] & 31;
                if (block[1] == 200 && length >= 28 + size_t(count) * 24) {
                    clock.observe_report(
                        {network_u32(block + 4), network_u32(block + 16),
                         (uint64_t(network_u32(block + 8)) << 32) | network_u32(block + 12),
                         received_us});
                }
                at += length;
            }
        }
        rtc::RtcpReceivingSession::incoming(messages, send);
    }

  private:
    static std::span<const uint8_t> bytes(const rtc::Message& message) {
        return {reinterpret_cast<const uint8_t*>(message.data()), message.size()};
    }
};
} // namespace ceres
