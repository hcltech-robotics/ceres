#include "ceres/protocol.hpp"
#include <algorithm>
#include <bit>
#include <cctype>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace ceres {
namespace {
uint16_t le16(std::span<const uint8_t> b, size_t p) {
    return uint16_t(b[p] | (uint16_t(b[p + 1]) << 8));
}
uint32_t le32(std::span<const uint8_t> b, size_t p) {
    return uint32_t(b[p]) | (uint32_t(b[p + 1]) << 8) | (uint32_t(b[p + 2]) << 16) |
           (uint32_t(b[p + 3]) << 24);
}
uint64_t le64(std::span<const uint8_t> b, size_t p) {
    return le32(b, p) | (uint64_t(le32(b, p + 4)) << 32);
}
uint16_t be16(std::span<const uint8_t> b, size_t p) {
    return uint16_t((uint16_t(b[p]) << 8) | b[p + 1]);
}
uint32_t be32(std::span<const uint8_t> b, size_t p) {
    return (uint32_t(b[p]) << 24) | (uint32_t(b[p + 1]) << 16) | (uint32_t(b[p + 2]) << 8) |
           b[p + 3];
}
bool uint_value(const Json& j, uint64_t maximum) {
    return j.is_number_integer() && j.get<double>() >= 0 && j.get<double>() <= double(maximum);
}
[[noreturn]] void invalid(const char* message) {
    throw std::invalid_argument(message);
}
void observation_metadata(const Json& value, unsigned depth = 0) {
    if (depth > 16)
        invalid("Bridge metadata nesting exceeds its budget");
    if (value.is_object())
        for (const auto& [key, item] : value.items()) {
            std::string name = key;
            std::transform(name.begin(), name.end(), name.begin(),
                           [](unsigned char c) { return char(std::tolower(c)); });
            if (name == "secret" || name == "invitationsecret" || name == "code" ||
                name == "bindingid" || name == "deviceid" || name == "authorization" ||
                name == "password" || name == "access_token" || name == "refresh_token")
                invalid("Bridge observation metadata contains identity fields");
            observation_metadata(item, depth + 1);
        }
    else if (value.is_array())
        for (const auto& item : value)
            observation_metadata(item, depth + 1);
}
CameraDescription camera_description(const Json& camera) {
    if (!camera.is_object() || !camera.contains("calibration") || !camera["calibration"].is_null())
        invalid("Invalid Bridge camera calibration");
    for (const auto key : {"width", "height", "requestedWidth"})
        if (!camera.contains(key) || !uint_value(camera[key], 8192) || camera[key] == 0)
            invalid("Invalid Bridge camera dimensions");
    const auto side = camera.value("side", "");
    if (side != "left" && side != "right" && side != "unknown")
        invalid("Invalid Bridge camera side");
    double fps = 30;
    if (!camera.contains("fps"))
        invalid("Missing Bridge camera frame rate");
    if (!camera["fps"].is_null()) {
        if (!camera["fps"].is_number() || !std::isfinite(camera["fps"].get<double>()) ||
            camera["fps"].get<double>() <= 0)
            invalid("Invalid Bridge camera frame rate");
        fps = camera["fps"].get<double>();
    }
    return {camera["width"].get<int>(), camera["height"].get<int>(),
            camera["requestedWidth"].get<int>(), fps, side};
}
bool valid_mid(const std::string& mid) {
    return !mid.empty() && mid.size() <= 64 &&
           std::all_of(mid.begin(), mid.end(), [](unsigned char c) {
               return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                      c == '_' || c == '-';
           });
}
} // namespace

bool newer_sequence(uint32_t candidate, uint32_t previous) noexcept {
    const uint32_t distance = candidate - previous;
    return distance != 0 && distance < 0x80000000u;
}

PoseSample decode_pose(std::span<const uint8_t> bytes, int64_t received_us) {
    if (bytes.size() < 40)
        invalid("Truncated Bridge pose");
    const auto kind = bytes[5];
    const size_t expected = kind == 1 ? 68 : 844;
    const auto flags = le16(bytes, 6);
    if (le32(bytes, 0) != 0x31524243u || bytes[4] != 1 || kind < 1 || kind > 3 || flags > 1 ||
        bytes.size() != expected || le32(bytes, 20) != expected - 40 ||
        le64(bytes, 24) > 9007199254740991ull || le64(bytes, 32) > 9007199254740991ull)
        invalid("Invalid Bridge pose envelope");
    PoseSample pose;
    pose.kind = kind;
    pose.valid = flags != 0;
    pose.epoch = le32(bytes, 8);
    pose.space_epoch = le32(bytes, 12);
    pose.sequence = le32(bytes, 16);
    pose.observed_us = static_cast<int64_t>(le64(bytes, 24));
    pose.target_us = static_cast<int64_t>(le64(bytes, 32));
    pose.received_us = received_us;
    pose.joint_mask = kind == 1 ? 0 : le32(bytes, 40);
    if ((pose.joint_mask & ~bridge_joint_mask) ||
        (kind != 1 && bool(pose.joint_mask) != pose.valid))
        invalid("Invalid Bridge joint validity");
    const size_t count = kind == 1 ? 7 : 200;
    const size_t offset = kind == 1 ? 40 : 44;
    for (size_t i = 0; i < count; ++i)
        pose.values[i] = std::bit_cast<float>(le32(bytes, offset + i * 4));
    const size_t stride = kind == 1 ? 7 : 8;
    for (size_t joint = 0; joint < (kind == 1 ? 1u : 25u); ++joint) {
        const auto* values = pose.values.data() + joint * stride;
        const bool tracked = kind == 1 ? pose.valid : (pose.joint_mask & (1u << joint)) != 0;
        if (!tracked) {
            if (std::any_of(values, values + stride, [](float x) { return x != 0; }))
                invalid("Untracked Bridge transforms must be zero");
            continue;
        }
        double norm = 0;
        for (size_t i = 0; i < stride; ++i)
            if (!std::isfinite(values[i]))
                invalid("Invalid Bridge transform");
        for (size_t i = 3; i < 7; ++i)
            norm += double(values[i]) * values[i];
        if (norm < 0.5 || norm > 1.5 || (stride == 8 && values[7] < 0))
            invalid("Invalid Bridge transform");
    }
    return pose;
}

StreamDescription parse_description(const Json& value) {
    if (!value.is_object() || value.value("type", "") != "description" ||
        value.value("version", 0) != 1 || !uint_value(value.value("epoch", Json()), 0xffffffffu))
        invalid("Invalid Bridge stream description");
    const auto& clock = value.value("clock", Json::object());
    const auto& camera = value.value("camera", Json::object());
    const auto space = value.value("referenceSpace", "");
    if (value.value("axes", "") != "right-handed-x-right-y-up-z-back" ||
        value.value("units", "") != "metres" || value.value("quaternion", "") != "xyzw" ||
        (space != "local" && space != "local-floor") || !clock.is_object() ||
        clock.value("units", "") != "microseconds" ||
        clock.value("domain", "") != "sender-monotonic" || !clock.contains("id") ||
        !clock["id"].is_string() || clock["id"].get_ref<const std::string&>().size() > 128)
        invalid("Invalid Bridge stream description");
    const bool depth = value.contains("environment_depth");
    if (depth) {
        const auto& feature = value["environment_depth"];
        if (!feature.is_object() || feature.value("version", 0) != 1 ||
            feature.value("channel", "") != "ceres-depth-v1" ||
            feature.value("format", "") != "uint16-mm" ||
            !uint_value(feature.value("max_width", Json()), 256) ||
            !uint_value(feature.value("max_height", Json()), 256) || feature["max_width"] == 0 ||
            feature["max_height"] == 0)
            invalid("Invalid Bridge environment depth description");
    }
    const auto joints = value.value("joints", Json());
    if (!joints.is_array() || joints.size() != bridge_joints.size())
        invalid("Invalid Bridge joint order");
    for (size_t i = 0; i < bridge_joints.size(); ++i)
        if (!joints[i].is_string() || joints[i].get<std::string>() != bridge_joints[i])
            invalid("Invalid Bridge joint order");
    if (!value.contains("camera")) {
        if (!depth || value.contains("cameras"))
            invalid("Bridge description requires camera or environment depth");
        return {0, 0, 0, "unknown", value, {}};
    }
    const auto primary = camera_description(camera);
    StreamDescription result{primary.width, primary.height, primary.fps, primary.side, value};
    if (!value.contains("cameras")) {
        result.cameras.push_back(primary);
        return result;
    }
    const auto& cameras = value["cameras"];
    if (!cameras.is_array() || cameras.empty() || cameras.size() > 2)
        invalid("Invalid Bridge camera tracks");
    for (const auto& item : cameras) {
        auto description = camera_description(item);
        if (!item.contains("mid") || !item["mid"].is_string())
            invalid("Missing Bridge camera media identity");
        description.mid = item["mid"].get<std::string>();
        if (!valid_mid(description.mid) ||
            std::any_of(result.cameras.begin(), result.cameras.end(),
                        [&](const auto& prior) {
                            return prior.mid == description.mid || prior.side == description.side;
                        }) ||
            (cameras.size() == 2 && description.side == "unknown"))
            invalid("Invalid Bridge camera identity");
        description.primary = result.cameras.empty();
        description.stream =
            description.primary ? "passthrough" : "passthrough_" + description.side;
        result.cameras.push_back(std::move(description));
    }
    for (const auto key : {"side", "width", "height", "requestedWidth", "fps", "calibration"})
        if (cameras[0][key] != camera[key])
            invalid("Bridge primary camera does not match camera tracks");
    return result;
}

std::vector<CameraDescription> camera_tracks(const StreamDescription& description,
                                             std::span<const std::string> mids) {
    if (mids.empty() && description.cameras.empty() &&
        description.raw.contains("environment_depth"))
        return {};
    if (mids.empty() || mids.size() > 2 || description.cameras.size() != mids.size())
        invalid("Bridge received undeclared camera tracks");
    for (size_t i = 0; i < mids.size(); ++i)
        if (!valid_mid(mids[i]) ||
            std::find(mids.begin(), mids.begin() + i, mids[i]) != mids.begin() + i)
            invalid("Bridge received duplicate or invalid camera tracks");
    auto cameras = description.cameras;
    if (!description.raw.contains("cameras")) {
        cameras[0].mid = mids[0];
    } else
        for (const auto& camera : cameras)
            if (std::find(mids.begin(), mids.end(), camera.mid) == mids.end())
                invalid("Bridge received an undeclared camera track");
    return cameras;
}

std::optional<int64_t> sender_media_time_us(uint32_t rtp, uint32_t report_rtp,
                                            uint64_t report_ntp) noexcept {
    const int64_t delta = int32_t(rtp - report_rtp);
    if (!report_ntp || std::abs(delta) > 5 * 90000)
        return std::nullopt;
    const int64_t report_us = int64_t(report_ntp >> 32) * 1000000 +
                              int64_t((report_ntp & 0xffffffffu) * 1000000 / 0x100000000ull);
    return report_us + delta * 1000000 / 90000;
}

Json parse_metadata(std::string_view text) {
    if (text.size() > 8192)
        invalid("Bridge metadata exceeds its budget");
    Json value = Json::parse(text, nullptr, false);
    if (value.is_discarded())
        invalid("Invalid Bridge metadata JSON");
    observation_metadata(value);
    if (!value.is_object() || value.value("version", 0) != 1 ||
        !uint_value(value.value("epoch", Json()), 0xffffffffu))
        invalid("Incompatible Bridge metadata");
    const auto type = value.value("type", "");
    if (type == "depth-status") {
        const auto status = value.value("status", "");
        if (status != "unsupported" && status != "waiting" && status != "streaming" &&
            status != "paused" && status != "error")
            invalid("Invalid Bridge depth status");
        if (!value.contains("usage") || !value.contains("source_format"))
            invalid("Missing Bridge depth status format");
        const auto usage = value.value("usage", Json());
        const auto format = value.value("source_format", Json());
        if ((!usage.is_null() && usage != "cpu-optimized" && usage != "gpu-optimized") ||
            (!format.is_null() && format != "luminance-alpha" && format != "float32" &&
             format != "unsigned-short"))
            invalid("Invalid Bridge depth status format");
        return value;
    }
    if (type == "ack")
        return value;
    if (type == "ping" || type == "pong") {
        if (!uint_value(value.value("id", Json()), 0xffffffffu) ||
            !uint_value(value.value("t0", Json()), 9007199254740991ull))
            invalid("Invalid Bridge clock exchange");
        if (type == "pong" && (!uint_value(value.value("t1", Json()), 9007199254740991ull) ||
                               !uint_value(value.value("t2", Json()), 9007199254740991ull) ||
                               value["t2"].get<int64_t>() < value["t1"].get<int64_t>()))
            invalid("Invalid Bridge clock exchange");
        return value;
    }
    parse_description(value);
    return value;
}

bool ClockMap::add(int64_t t0, int64_t t1, int64_t t2, int64_t t3) {
    // Convert before subtraction so adversarial int64 input cannot overflow.
    const double rtt = (double(t3) - double(t0)) - (double(t2) - double(t1));
    if (rtt < 0 || rtt > 1000000 || t3 < t0 || t2 < t1)
        return false;
    samples_.push_back({rtt / 2, (double(t1) + double(t2)) / 2, (double(t0) + double(t3)) / 2, t3});
    if (samples_.size() > 12)
        samples_.pop_front();
    return true;
}

ClockMapping ClockMap::mapping(int64_t now) const {
    std::vector<Sample> recent;
    for (const auto& s : samples_)
        if (now >= s.received && now - s.received <= 3000000)
            recent.push_back(s);
    if (recent.size() > 8)
        recent.erase(recent.begin(), recent.end() - 8);
    if (recent.empty())
        return {};
    double best = std::numeric_limits<double>::infinity();
    for (const auto& s : recent)
        best = std::min(best, s.uncertainty);
    std::erase_if(recent,
                  [best](const Sample& s) { return s.uncertainty > std::max(2000.0, best * 4); });
    if (recent.size() < 2) {
        const auto& s = recent.back();
        return {s.receiver - s.sender, s.uncertainty + double(now - s.received) * 0.05, 1, true};
    }
    const double ox = recent.back().sender, oy = recent.back().receiver;
    double total = 0, mx = 0, my = 0;
    for (const auto& s : recent) {
        const double w = 1 / std::pow(std::max(100.0, s.uncertainty), 2);
        total += w;
        mx += w * (s.sender - ox);
        my += w * (s.receiver - oy);
    }
    mx /= total;
    my /= total;
    double variance = 0, covariance = 0;
    for (const auto& s : recent) {
        const double w = 1 / std::pow(std::max(100.0, s.uncertainty), 2), dx = s.sender - ox - mx;
        variance += w * dx * dx;
        covariance += w * dx * (s.receiver - oy - my);
    }
    if (variance <= 0)
        return {};
    const double rate = covariance / variance;
    if (!(rate > 0.5 && rate < 2))
        return {};
    const double offset = oy + my - rate * (ox + mx);
    double residual = 0;
    for (const auto& s : recent)
        residual =
            std::max(residual, std::abs(s.receiver - (rate * s.sender + offset)) + s.uncertainty);
    const double span =
        double(std::max<int64_t>(1, recent.back().received - recent.front().received));
    const double age = double(std::max<int64_t>(0, now - recent.back().received));
    return {offset, residual * (1 + age / span) + age * 0.0001, rate, true};
}

void H264Assembler::reset() {
    *this = H264Assembler();
}
bool H264Assembler::take_keyframe_request() noexcept {
    const bool value = request_keyframe_;
    request_keyframe_ = false;
    return value;
}
void H264Assembler::lose_frame() {
    frame_.clear();
    fragmented_ = false;
    frame_invalid_ = true;
    needs_keyframe_ = true;
    request_keyframe_ = true;
}
void H264Assembler::add_nal(std::span<const uint8_t> nal) {
    if (nal.empty() || (nal[0] & 0x80) || (nal[0] & 31) == 0 || (nal[0] & 31) >= 24 ||
        frame_.size() + nal.size() + 4 > 2 * 1024 * 1024) {
        lose_frame();
        return;
    }
    const auto kind = nal[0] & 31;
    if (kind == 7) {
        sps_.assign(nal.begin(), nal.end());
        has_sps_ = true;
    }
    if (kind == 8) {
        pps_.assign(nal.begin(), nal.end());
        has_pps_ = true;
    }
    keyframe_ |= kind == 5;
    frame_.insert(frame_.end(), {0, 0, 0, 1});
    frame_.insert(frame_.end(), nal.begin(), nal.end());
}
void H264Assembler::finish_frame(const Packet& packet, std::vector<H264AccessUnit>& output) {
    if (fragmented_)
        lose_frame();
    if (!frame_invalid_ && !frame_.empty() && (!needs_keyframe_ || keyframe_)) {
        if (keyframe_ && (!has_sps_ || !has_pps_)) {
            std::vector<uint8_t> prefix;
            for (const auto* nal : {has_sps_ ? nullptr : &sps_, has_pps_ ? nullptr : &pps_}) {
                if (nal && !nal->empty()) {
                    prefix.insert(prefix.end(), {0, 0, 0, 1});
                    prefix.insert(prefix.end(), nal->begin(), nal->end());
                }
            }
            prefix.insert(prefix.end(), frame_.begin(), frame_.end());
            frame_ = std::move(prefix);
        }
        if (!time_started_) {
            timestamp_anchor_ = packet.timestamp;
            extended_timestamp_ = packet.timestamp;
            time_anchor_ = packet.received_us;
            time_started_ = true;
        } else {
            extended_timestamp_ += int32_t(packet.timestamp - uint32_t(extended_timestamp_));
        }
        output.push_back(
            {std::move(frame_), packet.timestamp, uint64_t(extended_timestamp_), packet.received_us,
             time_anchor_ + (extended_timestamp_ - timestamp_anchor_) * 1000000 / 90000,
             keyframe_});
        needs_keyframe_ = false;
    } else if (needs_keyframe_)
        request_keyframe_ = true;
    frame_.clear();
    timestamp_.reset();
    fragmented_ = false;
    frame_invalid_ = false;
    keyframe_ = false;
    has_sps_ = false;
    has_pps_ = false;
}
void H264Assembler::consume(const Packet& packet, std::vector<H264AccessUnit>& output) {
    if (timestamp_ && *timestamp_ != packet.timestamp) {
        // A timestamp change without an end marker means an incomplete access unit.
        lose_frame();
        timestamp_.reset();
        frame_invalid_ = false;
        keyframe_ = false;
        has_sps_ = false;
        has_pps_ = false;
    }
    timestamp_ = packet.timestamp;
    const auto data = std::span<const uint8_t>(packet.bytes);
    if (data.empty()) {
        lose_frame();
        return;
    }
    const uint8_t type = data[0] & 31;
    if ((data[0] & 0x80) != 0)
        lose_frame();
    else if (type >= 1 && type <= 23) {
        if (fragmented_)
            lose_frame();
        if (!frame_invalid_)
            add_nal(data);
    } else if (type == 24) {
        if (fragmented_)
            lose_frame();
        size_t at = 1;
        while (!frame_invalid_ && at < data.size()) {
            if (at + 2 > data.size()) {
                lose_frame();
                break;
            }
            const size_t count = be16(data, at);
            at += 2;
            if (!count || at + count > data.size()) {
                lose_frame();
                break;
            }
            add_nal(data.subspan(at, count));
            at += count;
        }
    } else if (type == 28 && data.size() >= 3) {
        const bool start = (data[1] & 0x80) != 0, end = (data[1] & 0x40) != 0;
        const uint8_t nal = uint8_t((data[0] & 0xe0) | (data[1] & 31));
        if ((data[1] & 0x20) || (start && end) || (nal & 31) == 0 || (nal & 31) >= 24)
            lose_frame();
        else if (start) {
            if (fragmented_)
                lose_frame();
            if (!frame_invalid_) {
                frame_.insert(frame_.end(), {0, 0, 0, 1, nal});
                fragmented_ = true;
                fragment_header_ = nal;
                fragment_begin_ = frame_.size() - 1;
                keyframe_ |= (nal & 31) == 5;
            }
        } else if (!fragmented_ || nal != fragment_header_)
            lose_frame();
        if (!frame_invalid_ && fragmented_) {
            if (frame_.size() + data.size() - 2 > 2 * 1024 * 1024)
                lose_frame();
            else {
                frame_.insert(frame_.end(), data.begin() + 2, data.end());
                if (end) {
                    fragmented_ = false;
                    if ((fragment_header_ & 31) == 7) {
                        sps_.assign(frame_.begin() + fragment_begin_, frame_.end());
                        has_sps_ = true;
                    }
                    if ((fragment_header_ & 31) == 8) {
                        pps_.assign(frame_.begin() + fragment_begin_, frame_.end());
                        has_pps_ = true;
                    }
                }
            }
        }
    } else
        lose_frame();
    if (packet.marker)
        finish_frame(packet, output);
}
std::vector<H264AccessUnit> H264Assembler::drain(int64_t now) {
    std::vector<H264AccessUnit> output;
    while (!pending_.empty()) {
        auto it = pending_.find(next_sequence_);
        if (it == pending_.end()) {
            int64_t oldest = now;
            for (const auto& [sequence, packet] : pending_)
                oldest = std::min(oldest, packet.received_us);
            if (pending_.size() < 64 && now - oldest < 10000)
                break;
            lose_frame();
            next_sequence_ = pending_.begin()->first;
            continue;
        }
        consume(it->second, output);
        pending_.erase(it);
        ++next_sequence_;
    }
    return output;
}
std::vector<H264AccessUnit> H264Assembler::flush(int64_t now) {
    return drain(now);
}
std::vector<H264AccessUnit> H264Assembler::push(std::span<const uint8_t> packet, int64_t received) {
    if (packet.size() < 12 || packet.size() > 65536 || packet[0] >> 6 != 2) {
        request_keyframe_ = true;
        return {};
    }
    // RTCP packets are consumed by RtcpReceivingSession, but ignore them defensively.
    if (packet[1] >= 192 && packet[1] <= 223)
        return {};
    size_t at = 12 + 4 * (packet[0] & 15);
    if (at > packet.size()) {
        request_keyframe_ = true;
        return {};
    }
    if (packet[0] & 0x10) {
        if (at + 4 > packet.size()) {
            request_keyframe_ = true;
            return {};
        }
        at += 4 + size_t(be16(packet, at + 2)) * 4;
    }
    if (at >= packet.size()) {
        request_keyframe_ = true;
        return {};
    }
    size_t end = packet.size();
    if (packet[0] & 0x20) {
        const auto padding = packet.back();
        if (!padding || padding > end - at) {
            request_keyframe_ = true;
            return {};
        }
        end -= padding;
    }
    if (at >= end) {
        request_keyframe_ = true;
        return {};
    }
    const auto ssrc = be32(packet, 8);
    if (ssrc_ && *ssrc_ != ssrc)
        reset();
    ssrc_ = ssrc;
    const uint16_t short_sequence = be16(packet, 2);
    int64_t sequence = short_sequence;
    if (!sequence_started_) {
        greatest_sequence_ = sequence;
        next_sequence_ = sequence;
        sequence_started_ = true;
    } else
        sequence =
            greatest_sequence_ + int16_t(uint16_t(short_sequence - uint16_t(greatest_sequence_)));
    if (sequence < next_sequence_)
        return {};
    if (sequence > next_sequence_ + 4096) {
        pending_.clear();
        lose_frame();
        next_sequence_ = sequence;
    }
    greatest_sequence_ = std::max(greatest_sequence_, sequence);
    pending_.try_emplace(sequence, Packet{be32(packet, 4),
                                          received,
                                          (packet[1] & 0x80) != 0,
                                          {packet.begin() + at, packet.begin() + end}});
    return drain(received);
}
} // namespace ceres
