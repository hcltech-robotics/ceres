#pragma once
#include "ceres/types.hpp"
#include "ceres/detail/rtp_repair.hpp"
#include <rtc/rtcpreceivingsession.hpp>
#include <cstdint>
#include <cstring>
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
    struct Feedback {
        int media_payload = -1, rtx_payload = -1;
        std::optional<uint32_t> media_ssrc, rtx_ssrc;
        bool nack = false, remb = false;
    };
    RtcpCameraSession() = default;
    explicit RtcpCameraSession(Feedback feedback) : feedback_(feedback),
                                                   media_ssrc_(feedback.media_ssrc) {}
    RtcpMediaClock clock;

    void incoming(rtc::message_vector& messages, const rtc::message_callback& send) override {
        incoming_at(messages, send, monotonic_us());
    }

    void incoming_at(rtc::message_vector& messages, const rtc::message_callback& send,
                     int64_t received_us) {
        std::lock_guard lock(feedback_mutex_);
        send_ = send;
        rtc::message_vector normalised;
        for (auto& message : messages) {
            if (message->type != rtc::Message::Binary) {
                normalised.push_back(std::move(message));
                continue;
            }
            auto data = bytes(*message);
            const auto source = rtp_source(data);
            if (!source || !detail::rtp_payload_offset(data))
                continue;
            const int payload = data[1] & 0x7f;
            if (feedback_.rtx_payload >= 0 && payload == feedback_.rtx_payload) {
                if (!media_ssrc_ || (feedback_.rtx_ssrc && *feedback_.rtx_ssrc != *source))
                    continue;
                const auto restored = detail::unwrap_rtx(data, uint8_t(feedback_.media_payload),
                                                          *media_ssrc_);
                if (!restored)
                    continue;
                message = packet_message(*restored, rtc::Message::Binary);
                data = bytes(*message);
            } else if (feedback_.media_payload >= 0 && payload != feedback_.media_payload)
                continue;
            const auto media_source = network_u32(data.data() + 8);
            if (media_ssrc_ && *media_ssrc_ != media_source) {
                repair_ = {};
                bitrate_ = 12000000;
                last_remb_us_ = 0;
            }
            media_ssrc_ = media_source;
            repair_.observe(detail::rtp_u16(data.data() + 2), received_us);
            normalised.push_back(std::move(message));
        }
        messages.swap(normalised);
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
        if (media_ssrc_)
            mSsrc = *media_ssrc_;
        feedback_locked(received_us);
    }

    // The receiver calls this during quiet intervals so a missing tail is
    // retried without waiting for another video frame to arrive.
    void tick(int64_t now_us) {
        std::lock_guard lock(feedback_mutex_);
        feedback_locked(now_us);
    }

    bool requestKeyframe(const rtc::message_callback& send) override {
        std::lock_guard lock(feedback_mutex_);
        return rtc::RtcpReceivingSession::requestKeyframe(send);
    }

    bool requestBitrate(unsigned int bitrate, const rtc::message_callback& send) override {
        std::lock_guard lock(feedback_mutex_);
        return feedback_.remb && rtc::RtcpReceivingSession::requestBitrate(bitrate, send);
    }

  private:
    static rtc::message_ptr packet_message(std::span<const uint8_t> bytes,
                                           rtc::Message::Type type) {
        auto message = rtc::make_message(bytes.size(), type);
        std::memcpy(message->data(), bytes.data(), bytes.size());
        return message;
    }

    void feedback_locked(int64_t now_us) {
        if (!send_ || !media_ssrc_)
            return;
        const auto missing = repair_.requests(now_us);
        if (feedback_.nack && !missing.empty())
            send_(packet_message(detail::nack_packet(*media_ssrc_, missing), rtc::Message::Control));
        if (!feedback_.remb)
            return;
        if (const auto loss = repair_.loss_fraction(now_us)) {
            if (*loss > .08)
                bitrate_ = std::max(2000000u, bitrate_ * 4 / 5);
            else if (*loss < .02)
                bitrate_ = std::min(12000000u, bitrate_ + bitrate_ / 10);
        }
        if (!last_remb_us_ || now_us - last_remb_us_ >= 500000) {
            rtc::RtcpReceivingSession::requestBitrate(bitrate_, send_);
            last_remb_us_ = now_us;
        }
    }

    static std::span<const uint8_t> bytes(const rtc::Message& message) {
        return {reinterpret_cast<const uint8_t*>(message.data()), message.size()};
    }
    Feedback feedback_;
    std::optional<uint32_t> media_ssrc_;
    detail::RtpRepair repair_;
    std::mutex feedback_mutex_;
    rtc::message_callback send_;
    unsigned bitrate_ = 12000000;
    int64_t last_remb_us_ = 0;
};
} // namespace ceres
