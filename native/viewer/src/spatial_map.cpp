#include "ceres/spatial_map.hpp"
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <queue>
#include <set>
#include <span>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <tuple>
#include <utility>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#endif

namespace ceres {
namespace {
using Bytes = std::vector<std::uint8_t>;
constexpr std::array<std::uint8_t, 8> magic{'C', 'E', 'R', 'E', 'S', 'M', 'A', 'P'};
constexpr std::uint64_t maximum_points =
    (spatial_map_hard_max_bytes - spatial_map_header_bytes) / spatial_map_record_bytes;
std::recursive_mutex map_files_mutex;
std::map<std::filesystem::path, std::size_t> protected_map_files;

bool same_map_file(const std::filesystem::path& left, const std::filesystem::path& right) {
    if (left == right)
        return true;
#ifdef _WIN32
    if (CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL)
        return true;
#endif
    std::error_code error;
    return std::filesystem::equivalent(left, right, error) && !error;
}
bool map_file_protected(const std::filesystem::path& path) {
    return std::any_of(protected_map_files.begin(), protected_map_files.end(),
                       [&](const auto& item) { return same_map_file(path, item.first); });
}

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
void validate_budget(std::uint64_t bytes) {
    require(bytes >= spatial_map_header_bytes + spatial_map_record_bytes &&
                bytes <= spatial_map_hard_max_bytes,
            "Map size must allow its header and one point, up to 256 MiB");
}
std::filesystem::path pending_path(const std::filesystem::path& path) {
    auto result = path;
    result += ".pending";
    return result;
}
void put(Bytes& bytes, std::size_t offset, std::uint64_t value, unsigned count) {
    for (unsigned i = 0; i < count; ++i)
        bytes.at(offset + i) = static_cast<std::uint8_t>(value >> (i * 8));
}
std::uint64_t get(std::span<const std::uint8_t> bytes, std::size_t offset, unsigned count) {
    std::uint64_t result = 0;
    require(offset <= bytes.size() && count <= bytes.size() - offset, "Truncated map field");
    for (unsigned i = 0; i < count; ++i)
        result |= std::uint64_t(bytes[offset + i]) << (i * 8);
    return result;
}
void put_float(Bytes& bytes, std::size_t offset, float value) {
    put(bytes, offset, std::bit_cast<std::uint32_t>(value), 4);
}
float get_float(std::span<const std::uint8_t> bytes, std::size_t offset) {
    return std::bit_cast<float>(static_cast<std::uint32_t>(get(bytes, offset, 4)));
}
std::uint32_t crc(std::span<const std::uint8_t> bytes) {
    static const auto table = [] {
        std::array<std::uint32_t, 256> result{};
        for (std::uint32_t i = 0; i < result.size(); ++i) {
            auto value = i;
            for (unsigned bit = 0; bit < 8; ++bit)
                value = (value >> 1) ^ ((value & 1u) ? 0x82f63b78u : 0u);
            result[i] = value;
        }
        return result;
    }();
    std::uint32_t result = 0xffffffffu;
    for (const auto value : bytes)
        result = table[(result ^ value) & 255u] ^ (result >> 8);
    return ~result;
}
void validate_identity(const SpatialMapSnapshot& map) {
    require(!map.world_id.empty() && map.world_id.size() <= 64 &&
                std::all_of(map.world_id.begin(), map.world_id.end(),
                            [](unsigned char ch) { return ch >= 32 && ch <= 126; }),
            "Map tracking-world identity must contain 1 to 64 ASCII characters");
    require(map.source == SpatialMapSource::environment_depth || map.source == SpatialMapSource::stereo,
            "Unknown map source");
    require(std::isfinite(map.base_voxel_size) && map.base_voxel_size > 0 &&
                map.base_voxel_size <= 1000.f,
            "Invalid map voxel size");
    require(map.time_origin_us >= 0, "Invalid map time origin");
    require(map.points.size() <= maximum_points, "Map snapshot exceeds the point limit");
}
void validate_point(const SpatialMapPoint& point, std::int64_t origin) {
    require(std::isfinite(point.x) && std::isfinite(point.y) && std::isfinite(point.z) &&
                std::isfinite(point.cell_size) && point.cell_size > 0 &&
                std::isfinite(point.confidence) && point.confidence > 0 && point.confidence <= 1 &&
                point.weight > 0 && !(point.flags & ~spatial_map_intrinsic_rgb) &&
                point.observed_us >= origin,
            "Invalid map point geometry or evidence");
    require(std::isfinite(point.r) && std::isfinite(point.g) && std::isfinite(point.b) &&
                point.r >= 0 && point.r <= 1 && point.g >= 0 && point.g <= 1 &&
                point.b >= 0 && point.b <= 1,
            "Invalid map point colour");
}
bool same_world(const SpatialMapSnapshot& left, const SpatialMapSnapshot& right) {
    return left.world_id == right.world_id && left.source == right.source &&
           left.epoch == right.epoch && left.space_epoch == right.space_epoch;
}
struct Compact {
    std::vector<SpatialMapPoint> points;
    std::uint64_t input = 0;
    float grid = 0;
};
Compact compact(const SpatialMapSnapshot& map, std::uint64_t max_bytes) {
    validate_identity(map);
    Compact result;
    result.grid = map.base_voxel_size;
    result.points.reserve(map.points.size());
    for (auto point : map.points) {
        if (!point.weight)
            continue;
        validate_point(point, map.time_origin_us);
        if (!(point.flags & spatial_map_intrinsic_rgb))
            point.r = point.g = point.b = 0;
        result.points.push_back(point);
    }
    result.input = result.points.size();
    const auto capacity = (max_bytes - spatial_map_header_bytes) / spatial_map_record_bytes;
    if (result.points.size() <= capacity)
        return result;
    // All samples remain intact until the file needs fewer records. A sparse
    // octree then merges the weakest regions first, leaving other cells fine.
    float extent = 0;
    for (const auto& point : result.points)
        extent = std::max({extent, std::abs(point.x), std::abs(point.y), std::abs(point.z)});
    using Key = std::array<std::uint64_t, 3>;
    struct IndexedPoint {
        Key key;
        std::uint32_t index;
    };
    const auto original = std::move(result.points);
    // Match the GPU's signed world grid and universal level-21 parent. Per-map
    // origins would let a restored coarse cell absorb unrelated fine neighbours.
    constexpr int axis_bias = 1 << 20;
    double base_grid = map.base_voxel_size;
    float inverse_grid = 1.f / static_cast<float>(base_grid);
    while (!std::isfinite(inverse_grid) || !std::isfinite(extent * inverse_grid) ||
           extent * inverse_grid >= float(axis_bias)) {
        base_grid *= 2;
        inverse_grid = 1.f / static_cast<float>(base_grid);
    }
    std::vector<IndexedPoint> ordered;
    ordered.reserve(original.size());
    for (std::uint32_t index = 0; index < original.size(); ++index) {
        const auto& point = original[index];
        const std::array<float, 3> position{point.x, point.y, point.z};
        Key key;
        for (unsigned axis = 0; axis < 3; ++axis)
            key[axis] = static_cast<std::uint64_t>(int(std::floor(position[axis] * inverse_grid)) + axis_bias);
        ordered.push_back({key, index});
    }
    const auto octant = [](const Key& key, unsigned bit) {
        return unsigned(((key[0] >> bit) & 1) | (((key[1] >> bit) & 1) << 1) |
                        (((key[2] >> bit) & 1) << 2));
    };
    std::sort(ordered.begin(), ordered.end(), [&](const auto& left, const auto& right) {
        const auto different = (left.key[0] ^ right.key[0]) | (left.key[1] ^ right.key[1]) |
                               (left.key[2] ^ right.key[2]);
        if (!different)
            return left.index < right.index;
        const auto bit = unsigned(std::bit_width(different) - 1);
        return octant(left.key, bit) < octant(right.key, bit);
    });
    constexpr auto no_parent = std::numeric_limits<std::uint32_t>::max();
    struct Node {
        std::uint32_t begin, end, parent, remaining, maximum_support;
        float maximum_confidence;
        unsigned level;
        bool merged = false;
    };
    std::vector<Node> nodes;
    nodes.reserve(original.size());
    const auto build = [&](auto&& self, std::uint32_t begin, std::uint32_t end, std::uint32_t parent) -> void {
        if (end - begin < 2)
            return;
        const auto& first = ordered[begin].key;
        const auto& last = ordered[end - 1].key;
        const auto different = (first[0] ^ last[0]) | (first[1] ^ last[1]) | (first[2] ^ last[2]);
        const auto level = unsigned(std::bit_width(different));
        const auto index = static_cast<std::uint32_t>(nodes.size());
        Node node{begin, end, parent, end - begin, 0, 0, level};
        for (auto i = begin; i < end; ++i) {
            const auto& point = original[ordered[i].index];
            node.maximum_confidence = std::max(node.maximum_confidence, point.confidence);
            node.maximum_support = std::max(node.maximum_support, point.weight);
        }
        nodes.push_back(node);
        if (!different)
            return;
        for (auto i = begin; i < end;) {
            auto next = i + 1;
            const auto child = octant(ordered[i].key, level - 1);
            while (next < end && octant(ordered[next].key, level - 1) == child)
                ++next;
            self(self, i, next, index);
            i = next;
        }
    };
    build(build, 0, static_cast<std::uint32_t>(ordered.size()), no_parent);
    const auto less_urgent = [&](std::uint32_t left, std::uint32_t right) {
        const auto& a = nodes[left];
        const auto& b = nodes[right];
        return std::tie(a.maximum_confidence, a.maximum_support, a.level, a.begin) >
               std::tie(b.maximum_confidence, b.maximum_support, b.level, b.begin);
    };
    std::priority_queue<std::uint32_t, std::vector<std::uint32_t>, decltype(less_urgent)> candidates(less_urgent);
    for (std::uint32_t index = 0; index < nodes.size(); ++index)
        candidates.push(index);
    const auto covered = [&](const Node& node) {
        for (auto parent = node.parent; parent != no_parent; parent = nodes[parent].parent)
            if (nodes[parent].merged)
                return true;
        return false;
    };
    auto remaining = original.size();
    while (remaining > capacity) {
        require(!candidates.empty(), "Map cannot be represented within the selected size");
        const auto index = candidates.top();
        candidates.pop();
        auto& node = nodes[index];
        if (node.remaining < 2 || covered(node))
            continue;
        const auto reduction = node.remaining - 1;
        node.merged = true;
        node.remaining = 1;
        remaining -= reduction;
        for (auto parent = node.parent; parent != no_parent; parent = nodes[parent].parent)
            nodes[parent].remaining -= reduction;
    }
    std::vector<std::uint32_t> merged;
    for (std::uint32_t index = 0; index < nodes.size(); ++index)
        if (nodes[index].merged && !covered(nodes[index]))
            merged.push_back(index);
    std::sort(merged.begin(), merged.end(), [&](auto left, auto right) { return nodes[left].begin < nodes[right].begin; });
    result.points.reserve(remaining);
    auto next_merge = merged.begin();
    for (std::uint32_t i = 0; i < ordered.size();) {
        if (next_merge == merged.end() || nodes[*next_merge].begin != i) {
            result.points.push_back(original[ordered[i++].index]);
            continue;
        }
        const auto& node = nodes[*next_merge++];
        const double grid = std::ldexp(base_grid, int(node.level));
        require(std::isfinite(grid) && grid <= std::numeric_limits<float>::max(),
                "Map coordinates exceed the supported coarsening range");
        result.grid = std::max(result.grid, static_cast<float>(grid));
        SpatialMapPoint point;
        point.cell_size = static_cast<float>(grid);
        double x = 0, y = 0, z = 0, r = 0, g = 0, b = 0;
        double mass = 0, colour_mass = 0, support = 0, confidence = 0;
        for (; i < node.end; ++i) {
            const auto& sample = original[ordered[i].index];
            const double weight = double(sample.confidence) * sample.weight;
            x += sample.x * weight;
            y += sample.y * weight;
            z += sample.z * weight;
            mass += weight;
            support += sample.weight;
            confidence += double(sample.confidence) * sample.weight;
            point.cell_size = std::max(point.cell_size, sample.cell_size);
            point.weight = std::max(point.weight, sample.weight);
            point.observed_us = std::max(point.observed_us, sample.observed_us);
            if (sample.flags & spatial_map_intrinsic_rgb) {
                r += sample.r * weight;
                g += sample.g * weight;
                b += sample.b * weight;
                colour_mass += weight;
            }
        }
        point.x = static_cast<float>(x / mass);
        point.y = static_cast<float>(y / mass);
        point.z = static_cast<float>(z / mass);
        point.confidence = static_cast<float>(confidence / support);
        if (colour_mass) {
            point.flags = spatial_map_intrinsic_rgb;
            point.r = static_cast<float>(r / colour_mass);
            point.g = static_cast<float>(g / colour_mass);
            point.b = static_cast<float>(b / colour_mass);
        }
        validate_point(point, map.time_origin_us);
        result.points.push_back(point);
    }
    return result;
}
Bytes encode(const SpatialMapSnapshot& map, const Compact& packed) {
    Bytes bytes(static_cast<std::size_t>(spatial_map_header_bytes +
                                        packed.points.size() * spatial_map_record_bytes), 0);
    std::copy(magic.begin(), magic.end(), bytes.begin());
    put(bytes, 8, 1, 4);
    put(bytes, 12, spatial_map_header_bytes, 4);
    put(bytes, 16, spatial_map_record_bytes, 4);
    put(bytes, 20, static_cast<std::uint32_t>(map.source), 4);
    put(bytes, 24, packed.points.size(), 8);
    put(bytes, 32, map.generation, 8);
    put(bytes, 40, static_cast<std::uint64_t>(map.time_origin_us), 8);
    put(bytes, 48, map.epoch, 4);
    put(bytes, 52, map.space_epoch, 4);
    put_float(bytes, 56, map.base_voxel_size);
    put_float(bytes, 60, packed.grid);
    put(bytes, 72, map.world_id.size(), 4);
    put(bytes, 80, packed.input, 8);
    std::copy(map.world_id.begin(), map.world_id.end(), bytes.begin() + 96);
    std::size_t offset = spatial_map_header_bytes;
    for (const auto& point : packed.points) {
        const std::array<float, 8> values{point.x, point.y, point.z, point.cell_size,
                                          point.r, point.g, point.b, point.confidence};
        for (unsigned i = 0; i < values.size(); ++i)
            put_float(bytes, offset + i * 4, values[i]);
        put(bytes, offset + 32, static_cast<std::uint64_t>(point.observed_us), 8);
        put(bytes, offset + 40, point.weight, 4);
        put(bytes, offset + 44, point.flags, 4);
        offset += spatial_map_record_bytes;
    }
    put(bytes, 64, crc(std::span(bytes).subspan(spatial_map_header_bytes)), 4);
    put(bytes, 68, crc(std::span(bytes).first(spatial_map_header_bytes)), 4);
    return bytes;
}
SpatialMapReadResult decode(Bytes bytes) {
    require(bytes.size() >= spatial_map_header_bytes, "Truncated map header");
    require(std::equal(magic.begin(), magic.end(), bytes.begin()) && get(bytes, 8, 4) == 1 &&
                get(bytes, 12, 4) == spatial_map_header_bytes &&
                get(bytes, 16, 4) == spatial_map_record_bytes,
            "Unsupported map file format");
    const auto header_crc = get(bytes, 68, 4);
    put(bytes, 68, 0, 4);
    require(crc(std::span(bytes).first(spatial_map_header_bytes)) == header_crc,
            "Map header checksum differs");
    const auto count = get(bytes, 24, 8);
    require(count <= maximum_points &&
                bytes.size() == spatial_map_header_bytes + count * spatial_map_record_bytes,
            "Map point count or file length differs");
    require(crc(std::span(bytes).subspan(spatial_map_header_bytes)) == get(bytes, 64, 4),
            "Map point checksum differs");
    const auto length = get(bytes, 72, 4);
    require(length > 0 && length <= 64, "Invalid map world identity length");
    require(get(bytes, 76, 4) == 0 && get(bytes, 88, 8) == 0 &&
                std::all_of(bytes.begin() + 96 + length, bytes.begin() + 256,
                            [](auto value) { return value == 0; }),
            "Unsupported map header fields");
    SpatialMapReadResult result;
    auto& map = result.map;
    map.world_id.assign(bytes.begin() + 96, bytes.begin() + 96 + length);
    map.source = static_cast<SpatialMapSource>(get(bytes, 20, 4));
    map.generation = get(bytes, 32, 8);
    const auto origin = get(bytes, 40, 8);
    require(origin <= std::uint64_t(std::numeric_limits<std::int64_t>::max()),
            "Invalid map time origin");
    map.time_origin_us = static_cast<std::int64_t>(origin);
    map.epoch = static_cast<std::uint32_t>(get(bytes, 48, 4));
    map.space_epoch = static_cast<std::uint32_t>(get(bytes, 52, 4));
    map.base_voxel_size = get_float(bytes, 56);
    validate_identity(map);
    result.info = {bytes.size(), get(bytes, 80, 8), count, get_float(bytes, 60), false};
    require(result.info.input_points >= count && result.info.input_points <= maximum_points &&
                std::isfinite(result.info.grid_size) && result.info.grid_size >= map.base_voxel_size,
            "Invalid map compaction metadata");
    map.points.reserve(static_cast<std::size_t>(count));
    for (std::size_t offset = spatial_map_header_bytes; offset < bytes.size();
         offset += spatial_map_record_bytes) {
        SpatialMapPoint point;
        point.x = get_float(bytes, offset);
        point.y = get_float(bytes, offset + 4);
        point.z = get_float(bytes, offset + 8);
        point.cell_size = get_float(bytes, offset + 12);
        point.r = get_float(bytes, offset + 16);
        point.g = get_float(bytes, offset + 20);
        point.b = get_float(bytes, offset + 24);
        point.confidence = get_float(bytes, offset + 28);
        const auto observed = get(bytes, offset + 32, 8);
        require(observed <= std::uint64_t(std::numeric_limits<std::int64_t>::max()),
                "Invalid map observation time");
        point.observed_us = static_cast<std::int64_t>(observed);
        point.weight = static_cast<std::uint32_t>(get(bytes, offset + 40, 4));
        point.flags = static_cast<std::uint32_t>(get(bytes, offset + 44, 4));
        validate_point(point, map.time_origin_us);
        require((point.flags & spatial_map_intrinsic_rgb) || (point.r == 0 && point.g == 0 && point.b == 0),
                "Unmeasured map colour must be empty");
        map.points.push_back(point);
    }
    return result;
}
SpatialMapReadResult read_file(const std::filesystem::path& path, std::uint64_t max_bytes) {
    const auto status = std::filesystem::symlink_status(path);
    require(std::filesystem::is_regular_file(status) && !std::filesystem::is_symlink(status),
            "Map path must be a regular file");
    const auto size = std::filesystem::file_size(path);
    require(size >= spatial_map_header_bytes && size <= max_bytes,
            "Map file exceeds the configured size or is truncated");
    // Check length before allocating from an external file.
    Bytes bytes(static_cast<std::size_t>(size));
    std::ifstream input(path, std::ios::binary);
    require(bool(input) && bool(input.read(reinterpret_cast<char*>(bytes.data()),
                                          static_cast<std::streamsize>(bytes.size()))) &&
                input.peek() == std::char_traits<char>::eof(),
            "Map file changed or could not be read completely");
    return decode(std::move(bytes));
}
void remove_pending(const std::filesystem::path& path) noexcept {
    std::error_code error;
    if (std::filesystem::is_regular_file(std::filesystem::symlink_status(path, error)))
        std::filesystem::remove(path, error);
}
void write_durable(const std::filesystem::path& path, const Bytes& bytes) {
    std::error_code error;
    const auto status = std::filesystem::symlink_status(path, error);
    require(!std::filesystem::exists(status) || std::filesystem::is_regular_file(status),
            "Pending map path must be a regular file");
#ifdef _WIN32
    HANDLE handle = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    require(handle != INVALID_HANDLE_VALUE, "Cannot create pending map file");
    bool success = true;
    std::size_t offset = 0;
    while (offset < bytes.size() && success) {
        DWORD written = 0;
        const DWORD count = static_cast<DWORD>(std::min<std::size_t>(bytes.size() - offset, 1024 * 1024));
        success = WriteFile(handle, bytes.data() + offset, count, &written, nullptr) && written == count;
        offset += written;
    }
    success = success && FlushFileBuffers(handle);
    CloseHandle(handle);
    require(success, "Could not flush pending map file");
#else
    const int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
    require(fd >= 0, "Cannot create pending map file");
    std::size_t offset = 0;
    bool success = true;
    while (offset < bytes.size()) {
        const auto count = ::write(fd, bytes.data() + offset, bytes.size() - offset);
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0) {
            success = false;
            break;
        }
        offset += static_cast<std::size_t>(count);
    }
    success = success && ::fsync(fd) == 0;
    ::close(fd);
    require(success, "Could not flush pending map file");
#endif
}
void validate_destination(const std::filesystem::path& path) {
    std::error_code error;
    const auto status = std::filesystem::symlink_status(path, error);
    require(!error || error == std::errc::no_such_file_or_directory,
            "Cannot inspect map destination");
    require(!std::filesystem::exists(status) ||
                (std::filesystem::is_regular_file(status) && !std::filesystem::is_symlink(status)),
            "Map destination must be a regular file, not a symbolic link");
}
void commit_pending(const std::filesystem::path& pending, const std::filesystem::path& path) {
    validate_destination(path);
#ifdef _WIN32
    require(MoveFileExW(pending.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH),
            "Cannot replace committed map file");
#else
    std::filesystem::rename(pending, path);
    const auto directory = path.parent_path().empty() ? std::filesystem::path(".") : path.parent_path();
    const int fd = ::open(directory.c_str(), O_RDONLY | O_DIRECTORY);
    require(fd >= 0, "Cannot open map directory for flush");
    const bool success = ::fsync(fd) == 0;
    ::close(fd);
    require(success, "Cannot flush committed map directory");
#endif
}
struct ManagedMapName {
    std::string world_id;
    SpatialMapSource source;
};
std::optional<ManagedMapName> managed_map_name(const std::filesystem::path& path) {
    const auto name = path.filename().string();
    SpatialMapSource source;
    std::size_t suffix;
    if (name.ends_with("-quest.cmap")) {
        source = SpatialMapSource::environment_depth;
        suffix = std::string_view("-quest.cmap").size();
    } else if (name.ends_with("-stereo.cmap")) {
        source = SpatialMapSource::stereo;
        suffix = std::string_view("-stereo.cmap").size();
    } else
        return {};
    const auto world = name.substr(0, name.size() - suffix);
    const auto separator = world.find('-');
    if (!separator || separator == std::string::npos || separator + 1 >= world.size() ||
        world.size() > 64 ||
        !std::all_of(world.begin(), world.begin() + separator,
                     [](unsigned char c) { return c >= '0' && c <= '9'; }) ||
        !std::all_of(world.begin() + separator + 1, world.end(),
                     [](unsigned char c) { return c >= '0' && c <= '9'; }))
        return {};
    return ManagedMapName{world, source};
}
bool matches_managed_name(const SpatialMapSnapshot& map, const ManagedMapName& name) {
    return map.world_id == name.world_id && map.source == name.source;
}
int compare_numeric(std::string_view left, std::string_view right) {
    while (left.size() > 1 && left.front() == '0') left.remove_prefix(1);
    while (right.size() > 1 && right.front() == '0') right.remove_prefix(1);
    if (left.size() != right.size()) return left.size() < right.size() ? -1 : 1;
    return left.compare(right);
}
void prune_managed_history(const std::filesystem::path& destination, std::size_t maximum) {
    std::lock_guard file_lock(map_files_mutex);
    const auto parent = destination.parent_path().empty() ? std::filesystem::path(".") : destination.parent_path();
    const auto directory = std::filesystem::canonical(parent);
    const auto current = directory / destination.filename();
    struct Candidate {
        std::filesystem::path path;
        std::filesystem::file_time_type modified;
        std::string world;
    };
    std::vector<Candidate> candidates;
    std::set<std::filesystem::path> paths;
    for (const auto& entry : std::filesystem::directory_iterator(directory)) {
        auto path = entry.path();
        if (path.extension() == ".pending") path.replace_extension();
        if (managed_map_name(path)) paths.insert(std::move(path));
    }
    for (const auto& path : paths) {
        // Selected sources neither consume the rolling history allowance nor
        // participate in pending-file recovery performed by this pruning pass.
        if (map_file_protected(path))
            continue;
        const auto name = *managed_map_name(path);
        std::error_code error;
        const auto status = std::filesystem::symlink_status(path, error);
        const bool exists = std::filesystem::exists(status);
        if (exists && (!std::filesystem::is_regular_file(status) || std::filesystem::is_symlink(status)))
            continue;
        std::optional<SpatialMapReadResult> committed;
        if (exists) {
            try {
                committed = read_file(path, spatial_map_hard_max_bytes);
            } catch (const std::exception&) {
                continue;
            }
            if (!matches_managed_name(committed->map, name)) continue;
        }
        const auto pending = pending_path(path);
        const auto pending_status = std::filesystem::symlink_status(pending, error);
        if (std::filesystem::exists(pending_status)) {
            if (!std::filesystem::is_regular_file(pending_status) || std::filesystem::is_symlink(pending_status))
                continue;
            std::optional<SpatialMapReadResult> recovered;
            try {
                recovered = read_file(pending, spatial_map_hard_max_bytes);
            } catch (const std::exception&) {
                if (committed) remove_pending(pending);
            }
            if (recovered) {
                if (!matches_managed_name(recovered->map, name) ||
                    (committed && !same_world(recovered->map, committed->map)))
                    continue;
                if (!committed || recovered->map.generation >= committed->map.generation) {
                    commit_pending(pending, path);
                    committed = std::move(recovered);
                } else
                    remove_pending(pending);
            }
        }
        if (committed)
            candidates.push_back({path, std::filesystem::last_write_time(path), name.world_id});
    }
    std::sort(candidates.begin(), candidates.end(), [&](const auto& left, const auto& right) {
        if ((left.path == current) != (right.path == current)) return left.path == current;
        if (left.modified != right.modified) return left.modified > right.modified;
        const auto left_separator = left.world.find('-'), right_separator = right.world.find('-');
        const auto run = compare_numeric(std::string_view(left.world).substr(0, left_separator),
                                         std::string_view(right.world).substr(0, right_separator));
        if (run) return run > 0;
        const auto serial = compare_numeric(std::string_view(left.world).substr(left_separator + 1),
                                            std::string_view(right.world).substr(right_separator + 1));
        return serial ? serial > 0 : left.path.filename() > right.path.filename();
    });
    for (std::size_t index = maximum; index < candidates.size(); ++index) {
        const auto& candidate = candidates[index];
        if (map_file_protected(candidate.path))
            continue;
        std::error_code error;
        const auto status = std::filesystem::symlink_status(candidate.path, error);
        if (error || candidate.path.parent_path() != directory ||
            !std::filesystem::is_regular_file(status) || std::filesystem::is_symlink(status) ||
            std::filesystem::last_write_time(candidate.path) != candidate.modified ||
            std::filesystem::exists(std::filesystem::symlink_status(pending_path(candidate.path), error)))
            continue;
        const auto checked = read_file(candidate.path, spatial_map_hard_max_bytes);
        if (!matches_managed_name(checked.map, *managed_map_name(candidate.path))) continue;
        require(std::filesystem::remove(candidate.path, error) && !error,
                "Cannot remove an older autosaved map");
    }
}
} // namespace

SpatialMapFileProtection::SpatialMapFileProtection(const std::filesystem::path& path) {
    require(!path.empty(), "Protected map path is empty");
    std::lock_guard file_lock(map_files_mutex);
    path_ = std::filesystem::weakly_canonical(std::filesystem::absolute(path));
    const auto existing = std::find_if(protected_map_files.begin(), protected_map_files.end(),
        [&](const auto& item) { return same_map_file(path_, item.first); });
    if (existing != protected_map_files.end()) {
        path_ = existing->first;
        ++existing->second;
    } else {
        protected_map_files.emplace(path_, 1);
    }
}
SpatialMapFileProtection::~SpatialMapFileProtection() {
    std::lock_guard file_lock(map_files_mutex);
    const auto existing = protected_map_files.find(path_);
    if (existing != protected_map_files.end() && --existing->second == 0)
        protected_map_files.erase(existing);
}

SpatialMapFileInfo save_spatial_map(const std::filesystem::path& path,
                                   const SpatialMapSnapshot& map, std::uint64_t max_bytes) {
    validate_budget(max_bytes);
    require(!path.empty() && path.has_filename(), "Map path is empty");
    const auto packed = compact(map, max_bytes);
    const auto bytes = encode(map, packed);
    std::lock_guard lock(map_files_mutex);
    validate_destination(path);
    if (std::filesystem::exists(path) || std::filesystem::exists(pending_path(path))) {
        const auto previous = load_spatial_map(path, spatial_map_hard_max_bytes);
        require(same_world(previous.map, map), "Cannot replace a map from another tracking world");
        require(map.generation >= previous.map.generation, "Cannot save an older map generation");
    }
    if (!path.parent_path().empty())
        std::filesystem::create_directories(path.parent_path());
    const auto pending = pending_path(path);
    try {
        write_durable(pending, bytes);
        const auto checked = read_file(pending, max_bytes);
        require(checked.map.generation == map.generation && same_world(checked.map, map),
                "Pending map readback differs");
        commit_pending(pending, path);
    } catch (...) {
        remove_pending(pending);
        throw;
    }
    return {bytes.size(), packed.input, packed.points.size(), packed.grid, false};
}

SpatialMapReadResult load_spatial_map(const std::filesystem::path& path, std::uint64_t max_bytes) {
    validate_budget(max_bytes);
    std::lock_guard lock(map_files_mutex);
    validate_destination(path);
    std::optional<SpatialMapReadResult> committed, pending;
    std::string failure = "Map file does not exist";
    const auto temporary = pending_path(path);
    for (bool is_pending : {false, true}) {
        const auto& candidate = is_pending ? temporary : path;
        if (!std::filesystem::exists(candidate))
            continue;
        try {
            auto result = read_file(candidate, max_bytes);
            (is_pending ? pending : committed) = std::move(result);
        } catch (const std::exception& error) {
            failure = error.what();
            if (is_pending)
                remove_pending(temporary);
        }
    }
    if (pending && (!committed || (same_world(pending->map, committed->map) &&
                                  pending->map.generation >= committed->map.generation))) {
        commit_pending(temporary, path);
        pending->info.recovered_pending = true;
        return std::move(*pending);
    }
    if (committed) {
        remove_pending(temporary);
        return std::move(*committed);
    }
    throw std::runtime_error(failure);
}

struct SpatialMapStore::Impl {
    using Clock = std::chrono::steady_clock;
    static constexpr std::array retry_delays{std::chrono::milliseconds(250),
                                             std::chrono::milliseconds(1000),
                                             std::chrono::milliseconds(4000)};
    std::filesystem::path path;
    mutable std::mutex mutex;
    std::condition_variable changed;
    SpatialMapStoreStatus state;
    std::shared_ptr<const SpatialMapSnapshot> pending, latest, loaded;
    std::optional<Clock::time_point> retry_at;
    std::size_t retry_count = 0;
    std::size_t load_max_points = 0;
    const std::size_t managed_history;
    bool load_requested = false, closing = false, save_failed = false;
    std::thread worker;

    Impl(std::filesystem::path destination, std::uint64_t max_bytes, std::size_t history)
        : path(std::move(destination)), managed_history(history) {
        validate_budget(max_bytes);
        require(!path.empty(), "Map path is empty");
        require(!managed_history || managed_map_name(path).has_value(),
                "Automatic map history requires a managed map filename");
        state.max_bytes = max_bytes;
        worker = std::thread([this] { run(); });
    }
    ~Impl() {
        {
            std::lock_guard lock(mutex);
            closing = true;
            if (retry_at && !pending)
                pending = latest;
            retry_at.reset();
        }
        changed.notify_all();
        worker.join();
    }
    bool retry_save() {
        if (closing || state.busy || pending || load_requested || retry_at || !save_failed || !latest)
            return false;
        retry_count = 0;
        retry_at.reset();
        pending = latest;
        changed.notify_all();
        return true;
    }
    void run() {
        std::unique_lock lock(mutex);
        while (true) {
            while (!closing && !pending && !load_requested) {
                if (retry_at) {
                    const auto deadline = *retry_at;
                    if (changed.wait_until(lock, deadline, [&] {
                            return closing || pending || load_requested || !retry_at;
                        }))
                        continue;
                    pending = latest;
                    retry_at.reset();
                } else {
                    changed.wait(lock, [&] { return closing || pending || load_requested || retry_at; });
                }
            }
            if (!pending && !load_requested && closing)
                return;
            const bool loading = load_requested;
            load_requested = false;
            auto snapshot = loading ? std::shared_ptr<const SpatialMapSnapshot>{} : std::move(pending);
            if (!loading)
                retry_at.reset();
            const auto budget = state.max_bytes;
            const auto point_limit = load_max_points;
            state.busy = true;
            lock.unlock();
            SpatialMapFileInfo info;
            std::shared_ptr<const SpatialMapSnapshot> restored;
            std::string error;
            try {
                if (loading) {
                    auto result = load_spatial_map(path, budget);
                    info = result.info;
                    if (point_limit && result.map.points.size() > point_limit) {
                        const auto loaded_budget = spatial_map_header_bytes +
                            std::uint64_t(point_limit) * spatial_map_record_bytes;
                        auto packed = compact(result.map, loaded_budget);
                        result.map.points = std::move(packed.points);
                    }
                    restored = std::make_shared<SpatialMapSnapshot>(std::move(result.map));
                } else {
                    if (managed_history) {
                        require(matches_managed_name(*snapshot, *managed_map_name(path)),
                                "Autosaved map identity differs from its filename");
                        std::lock_guard file_lock(map_files_mutex);
                        info = save_spatial_map(path, *snapshot, budget);
                        prune_managed_history(path, managed_history);
                    } else
                        info = save_spatial_map(path, *snapshot, budget);
                }
            } catch (const std::exception& failure) {
                error = failure.what();
            } catch (...) {
                error = "Unknown map storage failure";
            }
            lock.lock();
            state.busy = false;
            const bool success = error.empty();
            if (!loading || !save_failed || !success)
                state.error = std::move(error);
            if (success) {
                if (!loading) {
                    save_failed = false;
                    retry_count = 0;
                    retry_at.reset();
                }
                state.file = info;
                state.saved_generation = restored ? restored->generation : snapshot->generation;
                if (restored) {
                    loaded = restored;
                    if (!save_failed && !pending && (!latest || restored->generation >= latest->generation))
                        latest = restored;
                    state.submitted_generation = std::max(state.submitted_generation, restored->generation);
                }
                if (state.max_bytes != budget && !pending)
                    pending = latest;
            } else if (!loading) {
                save_failed = true;
                if (!closing && !pending && retry_count < retry_delays.size())
                    retry_at = Clock::now() + retry_delays[retry_count++];
            }
            changed.notify_all();
        }
    }
};

SpatialMapStore::SpatialMapStore(std::filesystem::path path, std::uint64_t max_bytes,
                               std::size_t managed_history)
    : impl_(std::make_unique<Impl>(std::move(path), max_bytes, managed_history)) {}
SpatialMapStore::~SpatialMapStore() = default;
bool SpatialMapStore::submit(std::shared_ptr<const SpatialMapSnapshot> map) {
    if (!map)
        return false;
    std::lock_guard lock(impl_->mutex);
    if (impl_->closing || (impl_->latest && map->generation < impl_->latest->generation))
        return false;
    impl_->state.submitted_generation = map->generation;
    impl_->retry_count = 0;
    impl_->retry_at.reset();
    impl_->latest = map;
    impl_->pending = std::move(map);
    impl_->changed.notify_all();
    return true;
}
bool SpatialMapStore::retry_save() {
    std::lock_guard lock(impl_->mutex);
    return impl_->retry_save();
}
void SpatialMapStore::set_max_bytes(std::uint64_t max_bytes) {
    validate_budget(max_bytes);
    std::lock_guard lock(impl_->mutex);
    if (impl_->state.max_bytes == max_bytes)
        return;
    impl_->state.max_bytes = max_bytes;
    impl_->retry_count = 0;
    impl_->retry_at.reset();
    impl_->pending = impl_->latest;
    impl_->changed.notify_all();
}
void SpatialMapStore::request_load(std::size_t max_points) {
    require(max_points <= maximum_points, "Map load point limit exceeds the supported maximum");
    std::lock_guard lock(impl_->mutex);
    impl_->loaded.reset();
    impl_->load_max_points = max_points;
    impl_->load_requested = true;
    impl_->changed.notify_all();
}
std::shared_ptr<const SpatialMapSnapshot> SpatialMapStore::take_loaded() {
    std::lock_guard lock(impl_->mutex);
    return std::exchange(impl_->loaded, {});
}
SpatialMapStoreStatus SpatialMapStore::status() const {
    std::lock_guard lock(impl_->mutex);
    auto result = impl_->state;
    result.busy = result.busy || bool(impl_->pending) || impl_->load_requested || bool(impl_->retry_at);
    return result;
}
void SpatialMapStore::flush() {
    std::unique_lock lock(impl_->mutex);
    if (!impl_->retry_at)
        impl_->retry_save();
    impl_->changed.wait(lock, [&] {
        return !impl_->state.busy && !impl_->pending && !impl_->load_requested && !impl_->retry_at;
    });
}
} // namespace ceres
