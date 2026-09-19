#include "ceres/depth.hpp"
#include "ceres/protocol.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace ceres {
namespace {
[[noreturn]] void invalid(const char* message) {
    throw std::runtime_error(message);
}
uint16_t u16(const uint8_t* p) {
    return uint16_t(p[0]) | uint16_t(p[1]) << 8;
}
uint32_t u32(const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
uint64_t number(const Json& object, const char* name, uint64_t maximum) {
    const auto& value = object.at(name);
    if (!value.is_number_integer() ||
        (value.is_number_integer() && !value.is_number_unsigned() && value.get<int64_t>() < 0))
        invalid("Depth metadata requires unsigned integers");
    const auto result = value.get<uint64_t>();
    if (result > maximum)
        invalid("Depth metadata integer is out of range");
    return result;
}
std::string choice(const Json& object, const char* name,
                   std::initializer_list<const char*> choices) {
    const auto value = object.at(name).get<std::string>();
    if (std::none_of(choices.begin(), choices.end(), [&](const char* x) { return value == x; }))
        invalid("Unsupported depth metadata value");
    return value;
}
std::array<float, 16> matrix(const Json& object, const char* name) {
    const auto& values = object.at(name);
    if (!values.is_array() || values.size() != 16)
        invalid("Depth matrices require sixteen column-major values");
    std::array<float, 16> output;
    double rows[4][4]{};
    for (size_t i = 0; i < 16; ++i) {
        if (!values[i].is_number())
            invalid("Invalid depth matrix value");
        const auto v = values[i].get<double>();
        output[i] = float(v);
        if (!std::isfinite(v) || !std::isfinite(output[i]))
            invalid("Non-finite depth matrix");
        rows[i % 4][i / 4] = v;
    }
    // Pivoted elimination rejects singular matrices without assuming projection shape.
    for (size_t column = 0; column < 4; ++column) {
        size_t pivot = column;
        for (size_t row = column + 1; row < 4; ++row)
            if (std::abs(rows[row][column]) > std::abs(rows[pivot][column]))
                pivot = row;
        if (std::abs(rows[pivot][column]) < 1e-12)
            invalid("Singular depth matrix");
        for (size_t k = 0; k < 4; ++k)
            std::swap(rows[column][k], rows[pivot][k]);
        for (size_t row = column + 1; row < 4; ++row) {
            const auto scale = rows[row][column] / rows[column][column];
            for (size_t k = column; k < 4; ++k)
                rows[row][k] -= scale * rows[column][k];
        }
    }
    return output;
}
int64_t mapped_time(int64_t time, const ClockMapping& mapping) {
    const double value = double(time) * mapping.rate + mapping.offset_us;
    if (!std::isfinite(value) || value < 0 || value >= double(std::numeric_limits<int64_t>::max()))
        invalid("Depth clock mapping is out of range");
    return int64_t(std::llround(value));
}
} // namespace

DepthFrame decode_depth(std::span<const uint8_t> bytes) {
    if (bytes.size() < 8 || bytes.size() > depth_max_frame_bytes ||
        std::memcmp(bytes.data(), "CED1", 4) != 0)
        invalid("Invalid depth frame envelope");
    const auto json_size = u32(bytes.data() + 4);
    if (!json_size || json_size > depth_max_json_bytes || json_size > bytes.size() - 8)
        invalid("Invalid depth metadata length");
    DepthFrame frame;
    frame.metadata = Json::parse(bytes.begin() + 8, bytes.begin() + 8 + json_size,
                                 [](int depth, Json::parse_event_t, Json&) {
                                     if (depth > 4)
                                         invalid("Depth metadata nesting exceeds its budget");
                                     return true;
                                 });
    const auto& h = frame.metadata;
    if (!h.is_object() || number(h, "version", 1) != 1)
        invalid("Unsupported depth frame version");
    // The v1 observation envelope has no extension or identity fields.
    if (h.size() != 17)
        invalid("Unexpected depth metadata fields");
    frame.epoch = uint32_t(number(h, "epoch", UINT32_MAX));
    frame.space_epoch = uint32_t(number(h, "space_epoch", UINT32_MAX));
    frame.sequence = uint32_t(number(h, "sequence", UINT32_MAX));
    frame.observed_us = int64_t(number(h, "observed_us", 9007199254740991ULL));
    frame.target_us = int64_t(number(h, "target_us", 9007199254740991ULL));
    frame.width = uint16_t(number(h, "width", 256));
    frame.height = uint16_t(number(h, "height", 256));
    frame.source_width = uint16_t(number(h, "source_width", 8192));
    frame.source_height = uint16_t(number(h, "source_height", 8192));
    if (!frame.width || !frame.height || frame.source_width < frame.width ||
        frame.source_height < frame.height ||
        bytes.size() != 8 + json_size + size_t(frame.width) * frame.height * 2)
        invalid("Invalid depth dimensions or payload length");
    frame.eye = choice(h, "eye", {"left", "right", "none"});
    frame.usage = choice(h, "usage", {"cpu-optimized", "gpu-optimized"});
    frame.source_format =
        choice(h, "source_format", {"luminance-alpha", "float32", "unsigned-short"});
    choice(h, "depth_format", {"uint16-mm"});
    frame.world_from_view = matrix(h, "world_from_view");
    frame.projection = matrix(h, "projection");
    frame.norm_depth_from_norm_view = matrix(h, "norm_depth_from_norm_view");
    const auto& world = frame.world_from_view;
    if (std::abs(world[3]) > 1e-4f || std::abs(world[7]) > 1e-4f || std::abs(world[11]) > 1e-4f ||
        std::abs(world[15] - 1.f) > 1e-4f)
        invalid("Depth view pose must be affine");
    frame.millimetres.resize(size_t(frame.width) * frame.height);
    const auto* payload = bytes.data() + 8 + json_size;
    for (size_t i = 0; i < frame.millimetres.size(); ++i)
        frame.millimetres[i] = u16(payload + i * 2);
    return frame;
}

SessionEvent make_depth_event(std::vector<uint8_t> bytes, int64_t received_us,
                              const ClockMapping& mapping) {
    if (received_us < 0 ||
        (mapping.valid &&
         (!std::isfinite(mapping.rate) || mapping.rate <= 0 || !std::isfinite(mapping.offset_us) ||
          !std::isfinite(mapping.uncertainty_us) || mapping.uncertainty_us < 0)))
        invalid("Invalid depth receiver clock");
    const auto frame = decode_depth(bytes);
    SessionEvent event;
    event.kind = EventKind::Depth;
    event.receive_us = received_us;
    event.time_us = mapping.valid ? mapped_time(frame.target_us, mapping) : received_us;
    event.epoch = frame.epoch;
    event.space_epoch = frame.space_epoch;
    event.sequence = frame.sequence;
    event.stream = "environment_depth";
    event.attributes = frame.metadata;
    event.attributes["clock_valid"] = mapping.valid;
    event.attributes["clock_uncertainty_us"] = mapping.uncertainty_us;
    event.attributes["clock_rate"] = mapping.rate;
    event.attributes["clock_offset_us"] = mapping.offset_us;
    event.attributes["mapped_observed_us"] =
        mapping.valid ? Json(mapped_time(frame.observed_us, mapping)) : Json();
    event.attributes["mapped_target_us"] = mapping.valid ? Json(event.time_us) : Json();
    event.payload = std::move(bytes);
    return event;
}

void DepthAssembler::reset(uint32_t epoch, uint32_t space_epoch) {
    epoch_ = epoch;
    space_epoch_ = space_epoch;
    completed_.reset();
    frames_.clear();
}
void DepthAssembler::expire(int64_t now_us) {
    std::erase_if(frames_, [&](const auto& f) {
        return now_us < f.first_us || now_us - f.first_us >= depth_fragment_lifetime_us;
    });
}
size_t DepthAssembler::queued_bytes() const {
    size_t bytes = 0;
    for (const auto& frame : frames_)
        bytes += frame.bytes.size();
    return bytes;
}
std::optional<std::vector<uint8_t>> DepthAssembler::push(std::span<const uint8_t> fragment,
                                                         int64_t received_us) {
    expire(received_us);
    if (received_us < 0 || fragment.size() <= depth_fragment_header_bytes ||
        fragment.size() > depth_fragment_bytes || std::memcmp(fragment.data(), "CDF1", 4) != 0)
        invalid("Invalid depth fragment envelope");
    const auto epoch = u32(fragment.data() + 4), space = u32(fragment.data() + 8),
               sequence = u32(fragment.data() + 12), total = u32(fragment.data() + 20);
    const auto index = u16(fragment.data() + 16), count = u16(fragment.data() + 18);
    if (epoch != epoch_ || space != space_epoch_)
        invalid("Foreign depth fragment epoch");
    if (total < 8 || total > depth_max_frame_bytes || !count || count > 9 || index >= count ||
        count != (total + depth_fragment_payload_bytes - 1) / depth_fragment_payload_bytes)
        invalid("Invalid depth fragment dimensions");
    const size_t offset = size_t(index) * depth_fragment_payload_bytes;
    const size_t payload = std::min(depth_fragment_payload_bytes, size_t(total) - offset);
    if (fragment.size() != depth_fragment_header_bytes + payload)
        invalid("Invalid depth fragment length");
    if (completed_ && !newer_sequence(sequence, *completed_))
        return std::nullopt;
    auto found = std::find_if(frames_.begin(), frames_.end(),
                              [&](const auto& frame) { return frame.sequence == sequence; });
    if (found == frames_.end()) {
        if (frames_.size() == 2) {
            const size_t oldest = newer_sequence(frames_[0].sequence, frames_[1].sequence) ? 1 : 0;
            if (!newer_sequence(sequence, frames_[oldest].sequence))
                return std::nullopt;
            frames_.erase(frames_.begin() + oldest);
        }
        frames_.push_back({sequence, count, 0, received_us, std::vector<uint8_t>(total), {}});
        found = std::prev(frames_.end());
    }
    if (found->count != count || found->bytes.size() != total) {
        frames_.erase(found);
        invalid("Depth fragments disagree on frame length");
    }
    const auto* data = fragment.data() + depth_fragment_header_bytes;
    if (found->present[index]) {
        if (!std::equal(data, data + payload, found->bytes.data() + offset)) {
            frames_.erase(found);
            invalid("Conflicting duplicate depth fragment");
        }
        return std::nullopt;
    }
    std::copy_n(data, payload, found->bytes.begin() + offset);
    found->present[index] = true;
    if (++found->received != count)
        return std::nullopt;
    auto bytes = std::move(found->bytes);
    frames_.erase(found);
    const auto frame = decode_depth(bytes);
    if (frame.epoch != epoch || frame.space_epoch != space || frame.sequence != sequence)
        invalid("Depth fragment and frame identities disagree");
    completed_ = sequence;
    std::erase_if(frames_, [&](const auto& f) { return !newer_sequence(f.sequence, sequence); });
    return bytes;
}
} // namespace ceres
