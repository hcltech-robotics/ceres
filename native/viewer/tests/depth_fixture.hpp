#pragma once
#include "ceres/depth.hpp"
#include <algorithm>

namespace depth_fixture {
inline void put(std::vector<uint8_t>& bytes, size_t at, uint64_t value, int count = 4) {
    for (int i = 0; i < count; ++i)
        bytes[at + i] = uint8_t(value >> (i * 8));
}
inline ceres::Json header(uint32_t sequence = 1, uint32_t epoch = 7, uint32_t space = 2,
                          int width = 4, int height = 3) {
    const std::array<float, 16> identity{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    auto world = identity;
    world[13] = 1.6f;
    return {{"version", 1},
            {"epoch", epoch},
            {"space_epoch", space},
            {"sequence", sequence},
            {"observed_us", 4000000},
            {"target_us", 4011111},
            {"width", width},
            {"height", height},
            {"source_width", 256},
            {"source_height", 256},
            {"eye", "left"},
            {"usage", "cpu-optimized"},
            {"source_format", "luminance-alpha"},
            {"depth_format", "uint16-mm"},
            {"world_from_view", world},
            {"projection", identity},
            {"norm_depth_from_norm_view", identity}};
}
inline std::vector<uint8_t> encode(const ceres::Json& header, size_t count = 0) {
    if (!count)
        count = header.at("width").get<size_t>() * header.at("height").get<size_t>();
    const auto json = header.dump();
    std::vector<uint8_t> bytes(8 + json.size() + count * 2);
    std::copy_n("CED1", 4, bytes.begin());
    put(bytes, 4, json.size());
    std::copy(json.begin(), json.end(), bytes.begin() + 8);
    for (size_t i = 0; i < count; ++i)
        put(bytes, 8 + json.size() + i * 2, i == 0 ? 0 : i == 1 ? 65535 : 1234, 2);
    return bytes;
}
inline std::vector<std::vector<uint8_t>> fragment(const std::vector<uint8_t>& bytes,
                                                  const ceres::Json& header) {
    const size_t capacity = ceres::depth_fragment_payload_bytes;
    const size_t count = (bytes.size() + capacity - 1) / capacity;
    std::vector<std::vector<uint8_t>> result;
    for (size_t index = 0; index < count; ++index) {
        const auto size = std::min(capacity, bytes.size() - index * capacity);
        std::vector<uint8_t> part(24 + size);
        std::copy_n("CDF1", 4, part.begin());
        put(part, 4, header.at("epoch").get<uint32_t>());
        put(part, 8, header.at("space_epoch").get<uint32_t>());
        put(part, 12, header.at("sequence").get<uint32_t>());
        put(part, 16, index, 2);
        put(part, 18, count, 2);
        put(part, 20, bytes.size());
        std::copy_n(bytes.begin() + index * capacity, size, part.begin() + 24);
        result.push_back(std::move(part));
    }
    return result;
}
} // namespace depth_fixture
