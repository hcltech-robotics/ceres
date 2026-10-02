#pragma once
#include <cstdint>
#include <limits>
#include <span>
#include <stdexcept>
#include <vector>

namespace ceres::detail {
struct H264Sample {
    std::vector<uint8_t> bytes, sps, pps;
    bool idr = false, has_picture = false;
};
// Annex B is retained in recordings. Only the VideoToolbox input uses AVCC lengths.
inline H264Sample h264_sample(std::span<const uint8_t> input) {
    auto prefix = [&](size_t at) -> size_t {
        if (at + 3 <= input.size() && input[at] == 0 && input[at + 1] == 0) {
            if (input[at + 2] == 1)
                return 3;
            if (at + 4 <= input.size() && input[at + 2] == 0 && input[at + 3] == 1)
                return 4;
        }
        return 0;
    };
    H264Sample result;
    size_t start = 0;
    while (start < input.size() && !prefix(start)) {
        if (input[start++] != 0)
            throw std::runtime_error("H.264 access unit is not Annex B");
    }
    while (start < input.size()) {
        const size_t begin = start + prefix(start);
        size_t end = begin;
        while (end < input.size() && !prefix(end))
            ++end;
        start = end;
        while (end > begin && input[end - 1] == 0)
            --end;
        if (end == begin || (input[begin] & 0x80))
            throw std::runtime_error("Invalid H.264 NAL unit");
        const auto nal = input.subspan(begin, end - begin);
        const auto type = nal[0] & 31;
        if (type == 7)
            result.sps.assign(nal.begin(), nal.end());
        else if (type == 8)
            result.pps.assign(nal.begin(), nal.end());
        else if (type != 9 && type != 10 && type != 11 && type != 12) {
            if (nal.size() > std::numeric_limits<uint32_t>::max())
                throw std::runtime_error("H.264 NAL unit is too large");
            const auto size = uint32_t(nal.size());
            for (int shift : {24, 16, 8, 0})
                result.bytes.push_back(uint8_t(size >> shift));
            result.bytes.insert(result.bytes.end(), nal.begin(), nal.end());
        }
        result.idr |= type == 5;
        result.has_picture |= type == 1 || type == 5;
    }
    if (!result.has_picture)
        throw std::runtime_error("H.264 access unit has no picture");
    return result;
}
} // namespace ceres::detail
