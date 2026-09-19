#include "ceres/voxel_kernel.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <limits>
#include <map>
#include <set>
#include <stdexcept>
#include <tuple>
#include <vector>

namespace {
void check(cudaError_t result) {
    if (result != cudaSuccess)
        throw std::runtime_error(cudaGetErrorString(result));
}
void expect(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}
bool near(float first, float second, float tolerance = 0.0003f) {
    return std::abs(first - second) < tolerance;
}
void identity(float* matrix) {
    std::fill_n(matrix, 16, 0.f);
    matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
}
float first_confidence() { return 1.f - std::exp(-.25f); }
ceres::StereoPoint point(float x, float y, float z, float r = 1, float g = 0, float b = 0) {
    return {x, y, z, 1, r, g, b, 1};
}
struct Fixture {
    ceres::StereoVoxelVolume volume;
    cudaStream_t stream = nullptr;
    ceres::StereoPoint* input = nullptr;
    ceres::StereoPoint* output = nullptr;
    ceres::VoxelGpuConfig config;
    std::vector<ceres::StereoPoint> host;
    const size_t allocation_bytes;
    explicit Fixture(size_t capacity) : volume(capacity), host(capacity),
        allocation_bytes(volume.scratch_bytes()) {
        check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
        check(cudaMalloc(&input, ceres::stereo_voxel_max_samples * sizeof(ceres::StereoPoint)));
        check(cudaMalloc(&output, capacity * sizeof(ceres::StereoPoint)));
        identity(config.head_to_world);
    }
    ~Fixture() {
        cudaStreamSynchronize(stream);
        cudaFree(input);
        cudaFree(output);
        cudaStreamDestroy(stream);
    }
    void upload(const std::vector<ceres::StereoPoint>& points) {
        expect(points.size() <= ceres::stereo_voxel_max_samples, "Fixture input bound");
        if (!points.empty())
            check(cudaMemcpyAsync(input, points.data(), points.size() * sizeof(ceres::StereoPoint),
                                  cudaMemcpyHostToDevice, stream));
    }
    std::vector<ceres::StereoPoint> read(const ceres::VoxelLodConfig* lod = nullptr) {
        if (lod)
            check(volume.snapshot_lod(output, *lod, stream));
        else
            check(volume.snapshot(output, stream));
        check(cudaMemcpyAsync(host.data(), output, host.size() * sizeof(ceres::StereoPoint),
                              cudaMemcpyDeviceToHost, stream));
        check(cudaStreamSynchronize(stream));
        std::vector<ceres::StereoPoint> valid;
        std::set<std::tuple<float, float, float>> positions;
        for (const auto& sample : host) {
            if (!sample.valid) {
                expect(sample.x == 0 && sample.y == 0 && sample.z == 0 && sample.r == 0 &&
                           sample.g == 0 && sample.b == 0 && sample.a == 0,
                       "Empty snapshot entries are fully cleared");
                continue;
            }
            const bool valid_width = std::isfinite(sample.valid) && sample.valid >= 1 &&
                   sample.valid <= float(1u << 21) && sample.valid == std::floor(sample.valid) &&
                !(unsigned(sample.valid) & (unsigned(sample.valid) - 1));
            expect(valid_width && std::isfinite(sample.x) && std::isfinite(sample.y) &&
                       std::isfinite(sample.z) && std::isfinite(sample.a) && sample.a > 0 && sample.a <= 1 &&
                       sample.r >= 0 && sample.r <= 1.0001f && sample.g >= 0 &&
                       sample.g <= 1.0001f && sample.b >= 0 && sample.b <= 1.0001f,
                   "Finite world-space snapshot and fused colours");
            expect(positions.emplace(sample.x, sample.y, sample.z).second,
                   "No duplicate retained representatives");
            valid.push_back(sample);
        }
        return valid;
    }
    std::vector<ceres::StereoPoint> run(const std::vector<ceres::StereoPoint>& points, float time,
                                        float now = -1) {
        upload(points);
        config.sample_time_seconds = time;
        config.now_seconds = now < 0 ? time : now;
        check(volume.integrate(points.empty() ? nullptr : input, points.size(), config, stream));
        return read();
    }
    void reset() {
        check(volume.clear(stream));
        config = {};
        identity(config.head_to_world);
    }
};

std::vector<ceres::SpatialMapPoint> metadata(Fixture& fixture, int64_t origin,
                                           const ceres::VoxelLodConfig* lod);

void geometry_and_colours() {
    Fixture f(256);
    expect(f.volume.capacity() == 256 && f.volume.scratch_bytes() <= 256 * 896 + 4096,
           "Surface cache and TSDF working storage have a fixed bounded allocation");
    expect(f.read().empty(), "New volume snapshot is empty");
    auto cloud = f.run({point(0.04f, 0.04f, -0.10f)}, 0);
    expect(cloud.size() == 1 && near(cloud[0].x, .04f) && near(cloud[0].y, .04f) &&
               near(cloud[0].z, -.10f) && cloud[0].a > .1f && cloud[0].a < .3f,
           "Snapshots preserve measured positions inside world-grid cells, including negative Z");

    f.config.head_to_world[12] = .30f;
    cloud = f.run({point(-.26f, .04f, -.10f, 0, 0, 1)}, 1);
    expect(cloud.size() == 1 && near(cloud[0].r, .5f) && near(cloud[0].b, .5f) && cloud[0].a > .3f,
           "Moving headset observations accumulate in the same world voxel");
    const auto previous = cloud.front();
    cloud = f.run({point(-.26f, .04f, -.10f, 0, 1, 0)}, .5f, 2);
    expect(cloud.size() == 1 && cloud[0].a == previous.a && cloud[0].r == previous.r &&
               cloud[0].g == previous.g && cloud[0].b == previous.b,
           "Older observations never refresh or recolour newer cells");
    cloud = f.run({point(-.26f, .04f, -.10f, 0, 1, 0)}, 1, 2);
    expect(cloud.size() == 1 && cloud[0].a == previous.a && cloud[0].g == previous.g,
           "Repeated observations do not add another colour vote");

    f.reset();
    f.config.head_to_world[0] = f.config.head_to_world[10] = 0;
    f.config.head_to_world[2] = -1;
    f.config.head_to_world[8] = 1;
    f.config.head_to_world[12] = .3f;
    f.config.head_to_world[13] = .6f;
    f.config.head_to_world[14] = -.9f;
    cloud = f.run({point(.04f, .04f, -.10f)}, 0);
    expect(cloud.size() == 1 && near(cloud[0].x, .20f) && near(cloud[0].y, .64f) &&
               near(cloud[0].z, -.94f),
           "Column-major rotation and translation transform head-local points");

    f.reset();
    cloud = f.run({point(-.001f, -.031f, -.061f), point(.001f, .031f, .061f)}, 0);
    expect(cloud.size() == 2 && std::any_of(cloud.begin(), cloud.end(),
                                            [](const auto& p) {
                                                return near(p.x, -.001f) && near(p.y, -.031f) &&
                                                       near(p.z, -.061f);
                                            }),
           "Negative coordinates occupy distinct floor-quantised voxels");

    f.reset();
    std::vector<ceres::StereoPoint> dense(32768, point(.041f, .042f, -.104f));
    for (size_t i = 8192; i < dense.size(); ++i)
        dense[i] = point(.041f, .042f, -.104f, 0, 0, 1);
    cloud = f.run(dense, 0);
    expect(cloud.size() == 1 && near(cloud[0].r, .25f) && near(cloud[0].b, .75f),
           "Dense concurrent writes produce one voxel with an average pair colour");
    cloud = f.run({point(.041f, .042f, -.104f, 0, 1, 0)}, 1);
    expect(cloud.size() == 1 && near(cloud[0].r, .125f) && near(cloud[0].g, .5f) &&
               near(cloud[0].b, .375f),
           "Each stereo pair has one vote, independent of point count");

    f.reset();
    const std::vector<ceres::StereoPoint> red{point(.041f, .042f, -.104f)};
    for (int i = 0; i < 100; ++i) {
        f.upload(red);
        f.config.sample_time_seconds = f.config.now_seconds = float(i);
        check(f.volume.integrate(f.input, red.size(), f.config, f.stream));
    }
    cloud = f.run({point(.041f, .042f, -.104f, 0, 0, 1)}, 100);
    expect(cloud.size() == 1 && near(cloud[0].r, 15.f / 16) && near(cloud[0].b, 1.f / 16),
           "Colour history is bounded to 16 observation votes");
}

void persistence_and_invalid_samples() {
    Fixture f(128);
    const auto first = point(.04f, .04f, -.1f), second = point(.4f, .04f, -.1f, 0, 1, 0);
    expect(f.run({first, second}, 0).size() == 2, "Both initial cells are present");
    auto cloud = f.run({second}, 7);
    expect(cloud.size() == 2, "Unobserved geometry persists");
    const auto before_idle = cloud;
    cloud = f.run({}, 100000);
    expect(cloud.size() == 2 && cloud[0].a == before_idle[0].a && cloud[1].a == before_idle[1].a,
           "Idle time cannot fade or remove retained evidence");
    expect(f.run({point(10, 10, -10)}, 0, 100001).size() == 2,
           "An old observation cannot introduce unseen geometry");

    f.reset();
    const float initial_confidence = f.run({first}, 0).front().a;
    std::vector<ceres::StereoPoint> invalid(8, first);
    invalid[0].valid = 0;
    invalid[1].valid = -1;
    invalid[2].valid = std::numeric_limits<float>::quiet_NaN();
    invalid[3].x = std::numeric_limits<float>::infinity();
    invalid[4].y = std::numeric_limits<float>::quiet_NaN();
    invalid[5].r = std::numeric_limits<float>::quiet_NaN();
    invalid[6].b = std::numeric_limits<float>::infinity();
    invalid[7].z = 1e10f;
    cloud = f.run(invalid, 5);
    expect(cloud.size() == 1 && cloud[0].a == initial_confidence, "Invalid samples do not alter existing evidence");
    expect(f.run({}, 1000).size() == 1, "Invalid samples and idle time preserve retained evidence");

    f.reset();
    cloud = f.run({point(.04f, .04f, -.1f, 2, -.5f, .5f)}, 0);
    expect(cloud.size() == 1 && cloud[0].r == 1 && cloud[0].g == 0 && near(cloud[0].b, .5f),
           "Finite colour input is clamped to the display range");
    check(f.volume.clear(f.stream));
    expect(f.read().empty(), "Explicit clear removes all occupied and tombstone entries");

    auto bad = f.config;
    bad.voxel_size = 0;
    expect(f.volume.integrate(f.input, 1, bad, f.stream) == cudaErrorInvalidValue,
           "Zero voxel size is rejected");
    bad = f.config;
    bad.contradiction_decrement = std::numeric_limits<float>::infinity();
    expect(f.volume.integrate(f.input, 1, bad, f.stream) == cudaErrorInvalidValue,
           "Nonfinite confidence changes are rejected");
    bad = f.config;
    bad.sample_time_seconds = 2;
    bad.now_seconds = 1;
    expect(f.volume.integrate(f.input, 1, bad, f.stream) == cudaErrorInvalidValue,
           "Future observations are rejected");
    bad = f.config;
    bad.head_to_world[4] = .5f;
    expect(f.volume.integrate(f.input, 1, bad, f.stream) == cudaErrorInvalidValue,
           "Non-rigid transforms are rejected");
    bad = f.config;
    bad.head_to_world[12] = std::numeric_limits<float>::quiet_NaN();
    expect(f.volume.integrate(f.input, 1, bad, f.stream) == cudaErrorInvalidValue,
           "Nonfinite transform is rejected");
    expect(f.volume.integrate(nullptr, 1, f.config, f.stream) == cudaErrorInvalidValue &&
               f.volume.integrate(f.input, ceres::stereo_voxel_max_samples + 1, f.config,
                                  f.stream) == cudaErrorInvalidValue &&
               f.volume.snapshot(nullptr, f.stream) == cudaErrorInvalidValue &&
               f.volume.clear(nullptr) == cudaErrorInvalidValue,
           "Invalid buffer, count and stream contracts are rejected");
    f.run({}, 5);
    bad = f.config;
    bad.sample_time_seconds = bad.now_seconds = 4;
    expect(f.volume.integrate(nullptr, 0, bad, f.stream) == cudaErrorInvalidValue,
           "Timebase cannot move backwards without a clear");
    bad = f.config;
    bad.voxel_size *= 2;
    expect(f.volume.integrate(nullptr, 0, bad, f.stream) == cudaErrorInvalidValue,
           "Voxel grid size cannot change without a clear");
    f.reset();
    expect(f.run({first}, 0).size() == 1, "Clear starts a new timebase");
}

void collisions_and_reuse() {
    for (size_t capacity : {size_t(0), size_t(3), ceres::stereo_voxel_capacity * 2}) {
        bool rejected = false;
        try {
            ceres::StereoVoxelVolume invalid(capacity);
        } catch (const std::runtime_error&) {
            rejected = true;
        }
        expect(rejected, "Invalid capacities are rejected before allocation");
    }
    Fixture f(32);
    std::vector<ceres::StereoPoint> points;
    for (int i = 0; i < 32; ++i)
        points.push_back(point(i * .09f + .011f, .012f, -.013f, 1, 0, 0));
    auto cloud = f.run(points, 0);
    expect(cloud.size() == 32, "All cells fill a 32-slot collision window");
    auto invalid = point(1, 0, -2);
    invalid.valid = 0;
    cloud = f.run({invalid}, 1);
    expect(cloud.size() == 32 && std::all_of(cloud.begin(), cloud.end(),
        [](const auto& p) { return p.valid == 1; }),
        "A full map cannot be pruned or coarsened by an invalid capture");
    cloud = f.run({point(10, 10, -10, 0, 1, 0)}, 2);
    expect(cloud.size() <= 32 && std::any_of(cloud.begin(), cloud.end(),
        [](const auto& p) { return p.x > 9 && p.y > 9; }),
        "A full table reserves space and admits fresh geometry");
    expect(std::any_of(cloud.begin(), cloud.end(), [](const auto& p) { return p.valid > 1; }),
           "Pressure coarsens distant retained geometry");

    // Repeated observations exercise pressure rebuilding and duplicate prevention.
    const auto survivor = points[17];
    f.run({survivor}, 7);
    cloud = f.run({}, 10);
    const auto idle_size = cloud.size();
    expect(f.run({}, 1000).size() == idle_size, "Idle calls do not prune a full map");
    std::vector<ceres::StereoPoint> dense(65536, survivor);
    for (size_t i = 1; i < dense.size(); i += 2)
        dense[i] = point(5.04f, -.04f, -1.04f, 0, 0, 1);
    for (int i = 0; i < 12; ++i) {
        cloud = f.run(dense, 1001.f + i);
        expect(cloud.size() <= 32 && cloud.size() > 2,
               "Dense writes retain bounded persistent coverage without duplicate occupied keys");
    }
    points.clear();
    for (int i = 0; i < 96; ++i)
        points.push_back(point(i * .09f + 10.011f, .012f, -.013f, 0, 1, 0));
    cloud = f.run(points, 1100);
    expect(cloud.size() <= 32, "Capacity remains fixed under colliding overflow");
    for (int frame = 0; frame < 20; ++frame) {
        const float x = 50.f + frame;
        cloud = f.run({point(x, .4f, -.4f, 0, 1, 0)}, 1101.f + frame);
        const auto accepted = metadata(f, 10000000, nullptr);
        const int64_t observed = 10000000 + int64_t(1101 + frame) * 1000000;
        expect(std::any_of(accepted.begin(), accepted.end(), [x, observed](const auto& p) {
                   const float width = p.cell_size;
                   return std::floor(p.x / width) == std::floor(x / width) &&
                          std::floor(p.y / width) == std::floor(.4f / width) &&
                          std::floor(p.z / width) == std::floor(-.4f / width) &&
                          p.observed_us == observed;
               }), "New regions continue entering a saturated map");
    }
    expect(f.volume.scratch_bytes() == f.allocation_bytes, "Repeated reuse never grows memory");
}

using LodLocation = std::tuple<int, int, int, unsigned>;
LodLocation location(const ceres::StereoPoint& p, float voxel_size) {
    const unsigned width = unsigned(p.valid);
    return {int(std::floor(p.x / (voxel_size * width)) * width),
            int(std::floor(p.y / (voxel_size * width)) * width),
            int(std::floor(p.z / (voxel_size * width)) * width), width};
}
LodLocation expected_location(const ceres::StereoPoint& p, float voxel_size,
                              const ceres::VoxelLodConfig& lod) {
    const int indices[3]{int(std::floor(p.x / voxel_size)),
                          int(std::floor(p.y / voxel_size)),
                          int(std::floor(p.z / voxel_size))};
    for (int level = int(lod.max_level); level >= 0; --level) {
        const unsigned width = 1u << level;
        const int base[3]{int(std::floor(float(indices[0]) / width)) * int(width),
                           int(std::floor(float(indices[1]) / width)) * int(width),
                           int(std::floor(float(indices[2]) / width)) * int(width)};
        const float size = voxel_size * width;
        float squared_distance = 0;
        for (int axis = 0; axis < 3; ++axis) {
            const float minimum = base[axis] * voxel_size;
            const float distance = std::max({minimum - lod.view_position[axis],
                                             lod.view_position[axis] - minimum - size, 0.f});
            squared_distance += distance * distance;
        }
        const float distance = std::sqrt(squared_distance);
        if (!level || (distance >= lod.minimum_distance &&
                       size * lod.focal_length_pixels <= distance * lod.target_pixels))
            return {base[0], base[1], base[2], width};
    }
    throw std::runtime_error("No voxel level selected");
}
std::set<LodLocation> locations(const std::vector<ceres::StereoPoint>& points, float size) {
    std::set<LodLocation> result;
    for (const auto& p : points)
        expect(result.emplace(location(p, size)).second, "Unique world-aligned LoD locations");
    return result;
}

void lod_density_and_world_grid() {
    Fixture f(8192);
    f.config.voxel_size = .05f;
    std::vector<ceres::StereoPoint> points;
    for (int z = 0; z < 4; ++z)
        for (int y = 0; y < 16; ++y)
            for (int x = 0; x < 16; ++x)
                points.push_back(point((x + .5f) * .05f, (y + .5f) * .05f,
                                       -(z + .5f) * .05f, x / 15.f, y / 15.f, z / 3.f));
    const auto fine = f.run(points, 2);
    expect(fine.size() == points.size(), "Every fine voxel is retained before LoD selection");
    ceres::VoxelLodConfig lod;
    lod.confidence_adaptive = false;
    lod.view_position[0] = lod.view_position[1] = .4f;
    lod.view_position[2] = .6f;
    lod.focal_length_pixels = 600;
    lod.target_pixels = 20;
    lod.minimum_distance = 1;
    auto cloud = f.read(&lod);
    expect(cloud.size() == 1024 && locations(cloud, .05f) == locations(fine, .05f),
           "Nearby geometry retains every fine world cell");
    lod.view_position[2] = 8;
    cloud = f.read(&lod);
    expect(cloud.size() == 16 && std::all_of(cloud.begin(), cloud.end(),
                                            [](const auto& p) { return p.valid == 4; }),
           "Distant geometry merges 1024 fine cells into 16 four-voxel-wide cells");
    const auto far_locations = locations(cloud, .05f);
    lod.view_position[0] += .37f;
    lod.view_position[1] -= .19f;
    expect(locations(f.read(&lod), .05f) == far_locations,
           "Moving the camera does not translate or jitter the world grid");
    lod.view_position[2] = 15;
    cloud = f.read(&lod);
    expect(cloud.size() == 4 && std::all_of(cloud.begin(), cloud.end(),
                                           [](const auto& p) { return p.valid == 8; }),
           "Greater distance selects an eight-voxel-wide coarser level");
    const auto unchanged = f.read();
    expect(unchanged.size() == fine.size(), "LoD never destroys persistent fine geometry");
    for (size_t i = 0; i < fine.size(); ++i)
        expect(unchanged[i].x == fine[i].x && unchanged[i].y == fine[i].y &&
                   unchanged[i].z == fine[i].z && unchanged[i].r == fine[i].r &&
                   unchanged[i].g == fine[i].g && unchanged[i].b == fine[i].b &&
                   unchanged[i].a == fine[i].a && unchanged[i].valid == 1,
               "Normal snapshots preserve the original positions, colours and ages");
    lod.max_level = 0;
    expect(locations(f.read(&lod), .05f) == locations(fine, .05f),
           "Level zero preserves the full-resolution snapshot contract");
    expect(f.volume.scratch_bytes() == f.allocation_bytes,
           "Repeated camera and level changes use only fixed allocated storage");
}

void lod_boundaries_and_validation() {
    Fixture f(8192);
    f.config.voxel_size = .05f;
    std::vector<ceres::StereoPoint> points;
    for (int z = -4; z < 0; ++z)
        for (int y = -2; y < 2; ++y)
            for (int x = -96; x <= 96; ++x)
                points.push_back(point((x + .5f) * .05f, (y + .5f) * .05f,
                                       (z + .5f) * .05f, 1, .5f, .25f));
    const auto fine = f.run(points, 0);
    expect(fine.size() == points.size(), "Boundary fixture retains every input voxel");
    ceres::VoxelLodConfig lod;
    lod.confidence_adaptive = false;
    lod.view_position[0] = .013f;
    lod.view_position[1] = .07f;
    lod.view_position[2] = 1.21f;
    lod.focal_length_pixels = 240;
    lod.target_pixels = 16;
    lod.minimum_distance = .25f;
    for (int step = 0; step < 8; ++step) {
        lod.view_position[0] += .127f;
        std::set<LodLocation> expected;
        for (const auto& p : fine)
            expected.emplace(expected_location(p, .05f, lod));
        const auto cloud = f.read(&lod);
        expect(locations(cloud, .05f) == expected,
               "Every negative and positive world cell is represented across moving LoD boundaries");
        expect(cloud.size() < fine.size() / 2, "Mixed levels reduce point count");
        std::set<unsigned> widths;
        for (const auto& p : cloud)
            widths.emplace(unsigned(p.valid));
        expect(widths.size() >= 3, "Boundary fixture exercises at least three simultaneous levels");
        for (auto first = expected.begin(); first != expected.end(); ++first) {
            const auto [x, y, z, width] = *first;
            for (auto second = std::next(first); second != expected.end(); ++second) {
                const auto [other_x, other_y, other_z, other_width] = *second;
                expect(x + int(width) <= other_x || other_x + int(other_width) <= x ||
                           y + int(width) <= other_y || other_y + int(other_width) <= y ||
                           z + int(width) <= other_z || other_z + int(other_width) <= z,
                       "Neighbouring LoD cells never overlap across tier boundaries");
            }
        }
    }
    auto bad = lod;
    bad.view_position[0] = std::numeric_limits<float>::quiet_NaN();
    expect(f.volume.snapshot_lod(f.output, bad, f.stream) == cudaErrorInvalidValue,
           "Nonfinite LoD camera position is rejected");
    bad = lod;
    bad.max_level = 7;
    expect(f.volume.snapshot_lod(f.output, bad, f.stream) == cudaErrorInvalidValue,
           "Unbounded LoD levels are rejected");
    bad = lod;
    bad.target_pixels = 0;
    expect(f.volume.snapshot_lod(f.output, bad, f.stream) == cudaErrorInvalidValue,
           "Nonpositive LoD projected size is rejected");
    bad = lod;
    bad.minimum_distance = -1;
    expect(f.volume.snapshot_lod(f.output, bad, f.stream) == cudaErrorInvalidValue &&
               f.volume.snapshot_lod(nullptr, lod, f.stream) == cudaErrorInvalidValue &&
               f.volume.snapshot_lod(f.output, lod, nullptr) == cudaErrorInvalidValue,
           "Invalid LoD distance, buffer and stream contracts are rejected");
}

void lod_colours_and_persistence() {
    Fixture f(128);
    f.config.voxel_size = 1;
    ceres::VoxelLodConfig lod;
    lod.confidence_adaptive = false;
    lod.view_position[2] = 20;
    lod.focal_length_pixels = 100;
    lod.target_pixels = 20;
    lod.max_level = 1;
    f.run({point(.25f, .25f, -.25f, 1, 0, 0)}, 0);
    f.run({point(1.25f, .25f, -.25f, 0, 0, 1)}, 5);
    auto cloud = f.read(&lod);
    expect(cloud.size() == 1 && cloud[0].valid == 2 && near(cloud[0].r, .5f) &&
               near(cloud[0].b, .5f) && near(cloud[0].a, first_confidence()),
           "Coarse colour averages fine cells and retains supported confidence");
    f.run({point(8.25f, .25f, -.25f, 0, 1, 0)}, 9);
    cloud = f.read(&lod);
    auto older = std::find_if(cloud.begin(), cloud.end(), [](const auto& p) { return p.x < 2; });
    expect(cloud.size() == 2 && older != cloud.end() && near(older->a, first_confidence()),
           "Unrelated fresh geometry leaves existing confidence unchanged");
    f.run({}, 100000);
    cloud = f.read(&lod);
    older = std::find_if(cloud.begin(), cloud.end(), [](const auto& p) { return p.x < 2; });
    expect(cloud.size() == 2 && older != cloud.end() && near(older->a, first_confidence()) && near(older->r, .5f) &&
               near(older->b, .5f), "Idle time preserves coarse colour and confidence");
}

std::vector<ceres::StereoPoint> depth_plane(float depth, bool valid = true, int width = 16) {
    std::vector<ceres::StereoPoint> points;
    for (int y = 0; y < width; ++y)
        for (int x = 0; x < width; ++x) {
            auto p = point((2.f * (x + .5f) / width - 1) * depth,
                           (1 - 2.f * (y + .5f) / width) * depth, -depth);
            p.valid = valid ? 1.f : 0.f;
            points.push_back(p);
        }
    return points;
}
ceres::ProjectiveDepthObservation observation(Fixture& f) {
    ceres::ProjectiveDepthObservation result;
    result.points = f.input;
    result.width = result.height = 16;
    result.projection[0] = result.projection[5] = 1;
    result.projection[10] = result.projection[11] = -1;
    result.projection[14] = -.2f;
    identity(result.norm_depth_from_norm_view);
    identity(result.view_from_world);
    return result;
}
std::vector<ceres::StereoPoint> observe(Fixture& f, const std::vector<ceres::StereoPoint>& points,
                                       float time, const ceres::ProjectiveDepthObservation& view,
                                       float now = -1) {
    f.upload(points);
    f.config.sample_time_seconds = time;
    f.config.now_seconds = now < 0 ? time : now;
    check(f.volume.integrate_projective(f.input, points.size(), f.config, view, f.stream));
    return f.read();
}
float confidence_at(const std::vector<ceres::StereoPoint>& points, float x, float y, float z,
                     float tolerance = .03f) {
    for (const auto& p : points)
        if (std::abs(p.x - x) < tolerance && std::abs(p.y - y) < tolerance &&
            std::abs(p.z - z) < tolerance)
            return p.a;
    return 0;
}
float confidence_covering(const std::vector<ceres::StereoPoint>& points,
                          const ceres::StereoPoint& location, float voxel_size) {
    for (const auto& p : points) {
        const float width = p.valid * voxel_size;
        if (std::floor(location.x / width) == std::floor(p.x / width) &&
            std::floor(location.y / width) == std::floor(p.y / width) &&
            std::floor(location.z / width) == std::floor(p.z / width))
            return p.a;
    }
    return 0;
}
void projective_evidence() {
    Fixture f(8192);
    const auto source = point(.01f, .01f, -2.01f);
    f.run({source}, 0);
    auto view = observation(f);
    auto far = depth_plane(4);
    auto cloud = observe(f, far, 1, view);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), first_confidence() - .2f),
           "A newer depth image fades evidence strictly inside measured free space");
    cloud = observe(f, far, 1, view, 2);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), first_confidence() - .2f),
           "Repeated observations cannot subtract confidence twice");
    cloud = observe(f, far, .5f, view, 2);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), first_confidence() - .2f),
           "Older observations cannot contradict newer evidence");
    cloud = observe(f, depth_plane(1), 3, view);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), first_confidence() - .2f),
           "A foreground surface preserves occluded background evidence");
    cloud = observe(f, depth_plane(4, false), 4, view);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), first_confidence() - .2f),
           "Invalid depth cannot erase retained geometry");
    cloud = f.run({}, 100000);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), first_confidence() - .2f),
           "Partially contradicted evidence does not continue fading with age");
    cloud = f.run({source}, 100001);
    expect(confidence_at(cloud, .015f, .015f, -2.025f) > first_confidence(),
           "Fresh agreeing geometry restores confidence");
    for (int i = 0; i < 5; ++i)
        cloud = observe(f, far, 100002.f + i, view);
    expect(confidence_at(cloud, .015f, .015f, -2.025f) == 0,
           "Repeated independent contradictions remove unsupported evidence");

    f.reset();
    f.run({source, point(10, .01f, -2.01f)}, 0);
    view = observation(f);
    for (int i = 0; i < 6; ++i)
        cloud = observe(f, far, float(i + 1), view);
    expect(near(confidence_at(cloud, 10.005f, .015f, -2.025f), first_confidence()),
           "Off-screen geometry persists through unrelated observations");

    f.reset();
    f.config.head_to_world[12] = 3;
    f.config.head_to_world[13] = .6f;
    f.run({source}, 0);
    view = observation(f);
    view.view_from_world[12] = -3;
    view.view_from_world[13] = -.6f;
    cloud = observe(f, far, 1, view);
    expect(near(confidence_at(cloud, 3.015f, .615f, -2.025f), first_confidence() - .2f),
           "Evidence uses the depth capture world pose, not a moving presentation camera");

    f.reset();
    f.run({point(2.01f, .01f, .01f)}, 0);
    view = observation(f);
    view.view_from_input[0] = view.view_from_input[10] = 0;
    view.view_from_input[2] = -1;
    view.view_from_input[8] = 1;
    std::copy_n(view.view_from_input, 16, view.view_from_world);
    for (auto& p : far) {
        const float x = p.x;
        p.x = -p.z;
        p.z = x;
    }
    cloud = observe(f, far, 1, view);
    expect(near(confidence_at(cloud, 2.025f, .015f, .015f), first_confidence() - .2f),
           "Stereo organised samples are transformed from head space to the rectified view");
}
void hand_exclusion_and_occlusion() {
    Fixture f(8192);
    const auto source = point(.01f, .01f, -2.01f);
    f.run({source}, 0);
    auto view = observation(f);
    view.hands.capsule_count = 1;
    auto& capsule = view.hands.capsules[0];
    capsule.from[2] = -.9f;
    capsule.to[2] = -1.1f;
    capsule.radius = .15f;
    auto cloud = observe(f, depth_plane(4), 1, view);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), first_confidence()),
           "A tracked hand shields background from contradictory depth");
    view.hands = {};
    view.hands.palm_count = 1;
    auto& palm = view.hands.palms[0];
    palm.centre[2] = -1;
    palm.axes[0] = palm.axes[4] = palm.axes[8] = 1;
    palm.half_extent[0] = palm.half_extent[1] = .15f;
    palm.half_extent[2] = .05f;
    cloud = observe(f, depth_plane(4), 2, view);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), first_confidence()),
           "Palm volume alone shields static background from contradictory depth");
    view.hands = {};
    view.hands.capsule_count = 1;
    view.hands.capsules[0].from[2] = -1.9f;
    view.hands.capsules[0].to[2] = -2.1f;
    view.hands.capsules[0].radius = .15f;
    view.points = nullptr;
    view.width = view.height = 0;
    cloud = observe(f, {source, point(1, 0, -2)}, 3, view);
    expect(confidence_at(cloud, .015f, .015f, -2.025f) == 0 &&
               confidence_at(cloud, 1.005f, .015f, -1.995f) > 0,
           "Hand volumes remove existing hand points and reject fresh hand geometry only");
}

void coarse_evidence_and_priority() {
    Fixture f(32);
    std::vector<ceres::StereoPoint> block;
    for (int y = 0; y < 4; ++y)
        for (int x = 0; x < 8; ++x)
            block.push_back(point((x + .5f) * .03f, (y + .5f) * .03f, -8.01f));
    expect(f.run(block, 0).size() == 32, "Pressure fixture begins with a full detailed block");
    auto cloud = f.run({point(.01f, .01f, -.3f)}, 1);
    expect(std::any_of(cloud.begin(), cloud.end(), [](const auto& p) {
        return p.valid > 1 && p.z < -7.9f;
    }), "Pressure retains distant geometry as a world-aligned coarse cell");
    auto view = observation(f);
    auto far = depth_plane(10);
    far[0].valid = 0;
    auto evidence = [&](float time) {
        f.upload(far);
        f.config.sample_time_seconds = f.config.now_seconds = time;
        // The organised image is independently leased. This invalid insertion
        // sample isolates evidence revision from admission and pressure pruning.
        check(f.volume.integrate_projective(f.input, 1, f.config, view, f.stream));
        return f.read();
    };
    cloud = evidence(2);
    auto coarse = std::find_if(cloud.begin(), cloud.end(), [](const auto& p) { return p.z < -7.9f; });
    expect(coarse != cloud.end() && near(coarse->a, first_confidence() - .2f),
           "Coarsened retained cells lose confidence under projective contradiction");
    cloud = f.run({block.front()}, 3);
    coarse = std::find_if(cloud.begin(), cloud.end(), [](const auto& p) { return p.z < -7.9f; });
    expect(coarse != cloud.end() && confidence_covering(cloud, block.front(), .03f) > first_confidence() - .2f,
           "An agreeing fine observation restores a retained coarse cell");
    for (int i = 0; i < 5; ++i)
        cloud = evidence(4.f + i);
    expect(std::none_of(cloud.begin(), cloud.end(), [](const auto& p) { return p.z < -7.9f; }),
           "Contradiction can fully replace coarsened geometry");

    f.reset();
    const auto supported = point(.01f, .01f, -1.01f);
    for (int i = 0; i < 16; ++i)
        f.run({supported}, float(i));
    block = {supported};
    for (int i = 0; i < 31; ++i)
        block.push_back(point(20.f + i, 1, -20));
    expect(f.run(block, 16).size() == 32, "Priority fixture fills every map slot");
    cloud = f.run({point(100, 0, -1)}, 17);
    expect(confidence_covering(cloud, supported, .03f) > .98f &&
               confidence_covering(cloud, point(100, 0, -1), .03f) > .1f,
           "Pressure preserves nearby repeatedly supported evidence while admitting a new region");
}

void near_revisit_refinement() {
    Fixture f(128);
    std::vector<ceres::StereoPoint> block;
    for (int z = 0; z < 2; ++z)
        for (int y = 0; y < 8; ++y)
            for (int x = 0; x < 8; ++x)
                block.push_back(point((x + .5f) * .03f, (y + .5f) * .03f, -8.01f - z * .03f));
    expect(f.run(block, 0).size() == 128, "Revisit fixture starts with detailed distant geometry");
    auto cloud = f.run({point(0, 0, -1)}, 1);
    auto coarse_count = [](const auto& points) {
        return std::count_if(points.begin(), points.end(), [](const auto& p) {
            return p.z < -7.9f && p.valid > 1;
        });
    };
    expect(coarse_count(cloud) > 0, "Distant detail is retained at a coarser pressure level");
    f.config.head_to_world[12] = f.config.head_to_world[13] = .12f;
    f.config.head_to_world[14] = -7;
    auto view = observation(f);
    view.width = view.height = 64;
    view.view_from_world[12] = view.view_from_world[13] = -.12f;
    view.view_from_world[14] = 7;
    auto near_points = depth_plane(1.01f, true, 64);
    for (auto& p : near_points) {
        const float x = p.x + .12f, y = p.y + .12f;
        if (x < 0 || x >= .24f || y < 0 || y >= .24f)
            p.valid = 0;
    }
    auto corner = near_points;
    for (auto& p : corner)
        if (p.x + .12f > .07f || p.y + .12f > .07f)
            p.valid = 0;
    cloud = observe(f, corner, 2, view);
    expect(coarse_count(cloud) > 0,
           "Sparse samples in one corner cannot destructively replace a coarse surface");
    view.hands.capsule_count = 1;
    view.hands.capsules[0].from[0] = view.hands.capsules[0].to[0] = .12f;
    view.hands.capsules[0].from[1] = view.hands.capsules[0].to[1] = .12f;
    view.hands.capsules[0].from[2] = -7.4f;
    view.hands.capsules[0].to[2] = -7.6f;
    view.hands.capsules[0].radius = .2f;
    cloud = observe(f, near_points, 3, view);
    expect(coarse_count(cloud) > 0,
           "A hand-occluded parent cannot be retired by surrounding depth samples");
    view.hands = {};
    auto foreground = depth_plane(.4f, true, 64);
    f.upload(foreground);
    f.config.sample_time_seconds = f.config.now_seconds = 4;
    check(f.volume.integrate_projective(f.input, 1, f.config, view, f.stream));
    cloud = f.read();
    expect(coarse_count(cloud) > 0,
           "Foreground occlusion cannot erase coarse background during refinement");
    for (int capture = 5; capture < 17; ++capture)
        cloud = observe(f, near_points, float(capture), view);
    const auto fine = std::count_if(cloud.begin(), cloud.end(), [](const auto& p) {
        return p.z < -7.9f && p.valid == 1;
    });
    const auto restored = metadata(f, 10000000, nullptr);
    expect(fine >= 36 && std::none_of(restored.begin(), restored.end(), [](const auto& p) {
        return p.z > -8.025f && p.z < -7.9f && p.cell_size > .031f;
    }),
           "Consistent near revisits restore fine detail from broad fresh surface coverage");
    unsigned rear = 0;
    for (const auto& p : restored) if (p.z < -8.025f) {
        ++rear;
        expect(p.weight == 1 && p.observed_us == 10000000 && near(p.confidence, first_confidence()),
               "Refining the visible plane preserves the separately occluded rear layer and its original evidence");
    }
    expect(rear > 0, "Fine front-surface restoration does not erase the previously observed rear surface");
    expect(f.volume.scratch_bytes() == f.allocation_bytes,
           "Refinement reuses fixed allocated scratch storage");
}

void bounded_accumulation_and_timing() {
    Fixture f(ceres::stereo_voxel_initial_capacity);
    std::vector<ceres::StereoPoint> dense(ceres::stereo_voxel_max_samples,
                                          point(.04f, .04f, -.1f, 1, 1, 1));
    auto cloud = f.run(dense, 0);
    expect(cloud.size() == 1 && near(cloud[0].r, 1) && near(cloud[0].g, 1) && near(cloud[0].b, 1),
           "Maximum dense input cannot overflow integer colour sums");
    f.reset();
    std::vector<ceres::StereoPoint> frame;
    for (int y = 0; y < 240; ++y)
        for (int x = 0; x < 320; ++x)
            frame.push_back(point((x - 159.5f) * .012f, (y - 119.5f) * .012f, -2.005f,
                                  float(x) / 319, float(y) / 239, .5f));
    f.upload(frame);
    cudaEvent_t begin = nullptr, end = nullptr;
    check(cudaEventCreate(&begin));
    check(cudaEventCreate(&end));
    std::vector<float> timings;
    for (int i = 0; i < 23; ++i) {
        f.config.sample_time_seconds = f.config.now_seconds = float(i) * .5f;
        check(cudaEventRecord(begin, f.stream));
        check(f.volume.integrate(f.input, frame.size(), f.config, f.stream));
        check(f.volume.snapshot(f.output, f.stream));
        check(cudaEventRecord(end, f.stream));
        check(cudaEventSynchronize(end));
        float elapsed = 0;
        check(cudaEventElapsedTime(&elapsed, begin, end));
        if (i >= 3)
            timings.push_back(elapsed);
    }
    cloud = f.read();
    expect(cloud.size() >= 12000 && cloud.size() <= 13000,
           "Dense plane converges to its world voxel coverage");
    std::sort(timings.begin(), timings.end());
    std::cout << "CUDA voxel fusion 320x240, " << f.volume.capacity() << " slots, p95 "
              << timings[18] << " ms, scratch " << f.volume.scratch_bytes() << " bytes\n";
    const size_t fine_count = cloud.size();
    ceres::VoxelLodConfig lod;
    lod.confidence_adaptive = false;
    lod.view_position[2] = 8;
    lod.focal_length_pixels = 600;
    lod.target_pixels = 12;
    timings.clear();
    for (int i = 0; i < 23; ++i) {
        check(cudaEventRecord(begin, f.stream));
        check(f.volume.snapshot_lod(f.output, lod, f.stream));
        check(cudaEventRecord(end, f.stream));
        check(cudaEventSynchronize(end));
        float elapsed = 0;
        check(cudaEventElapsedTime(&elapsed, begin, end));
        if (i >= 3)
            timings.push_back(elapsed);
    }
    cloud = f.read(&lod);
    expect(cloud.size() < fine_count / 8,
           "LoD substantially reduces the rendered density of a distant depth plane");
    std::sort(timings.begin(), timings.end());
    std::cout << "CUDA voxel LoD " << fine_count << " to " << cloud.size() << " points, p95 "
              << timings[18] << " ms\n";
    check(cudaEventDestroy(begin));
    check(cudaEventDestroy(end));
}

float retained_coverage(const std::vector<ceres::StereoPoint>& cloud,
                        const std::vector<ceres::StereoPoint>& sources, float size) {
    const auto occupied = locations(cloud, size);
    size_t present = 0;
    for (const auto& p : sources) {
        const int fine[3]{int(std::floor(p.x / size)), int(std::floor(p.y / size)),
                           int(std::floor(p.z / size))};
        for (unsigned width = 1; width <= 64; width *= 2) {
            const LodLocation cell{int(std::floor(float(fine[0]) / width)) * int(width),
                                    int(std::floor(float(fine[1]) / width)) * int(width),
                                    int(std::floor(float(fine[2]) / width)) * int(width), width};
            if (occupied.find(cell) != occupied.end()) { ++present; break; }
        }
    }
    return float(present) / float(sources.size());
}
void sweep_reliability() {
    Fixture f(ceres::stereo_voxel_initial_capacity);
    f.config.voxel_size = .01f;
    std::vector<ceres::StereoPoint> wall;
    for (int y = 0; y < 32; ++y)
        for (int x = 0; x < 32; ++x)
            wall.push_back(point((x - 15.5f) * .01f, (y - 15.5f) * .01f, -6.005f));
    for (int frame = 0; frame < 16; ++frame)
        f.run(wall, float(frame));
    std::vector<ceres::StereoPoint> clutter;
    for (int z = 0; z < 30; ++z)
        for (int y = 0; y < 64; ++y)
            for (int x = 0; x < 128; ++x)
                clutter.push_back(point((x - 63.5f) * .01f, (y - 31.5f) * .01f,
                                         -.505f - z * .01f, .2f, .4f, .8f));
    f.run(clutter, 16);
    auto cloud = f.run({point(1, 0, -1)}, 17);
    const float coverage = retained_coverage(cloud, wall, .01f);
    std::cout << "Confirmed wall coverage after 1cm pressure sweep " << coverage
              << ", retained cells " << cloud.size() << '\n';

    Fixture evidence(8192);
    const auto source = point(.01f, .01f, -2.01f);
    for (int frame = 0; frame < 16; ++frame)
        evidence.run({source}, float(frame) * .1f);
    auto view = observation(evidence);
    for (int frame = 0; frame < 8; ++frame)
        cloud = observe(evidence, depth_plane(frame & 1 ? 5.f : 3.f), 2.f + frame * .1f, view);
    const float noisy_confidence = confidence_at(cloud, .015f, .015f, -2.025f);
    std::cout << "Confirmed wall confidence after eight inconsistent depth frames "
              << noisy_confidence << '\n';
    for (int frame = 0; frame < 32; ++frame)
        cloud = observe(evidence, depth_plane(4.f), 3.f + frame * .1f, view);
    const float replaced_confidence = confidence_at(cloud, .015f, .015f, -2.025f);
    std::cout << "Confirmed wall confidence after sustained coherent replacement "
              << replaced_confidence << '\n';
    expect(coverage >= .99f, "Pressure should coarsen detail before discarding a confirmed room surface");
    expect(noisy_confidence >= .95f, "Inconsistent sweep depth must not erase a repeatedly confirmed surface");
    expect(replaced_confidence == 0, "Stable free-space evidence must still replace a removed surface");
    for (const float cadence : {.55f, 2.f}) {
        evidence.reset();
        for (int frame = 0; frame < 16; ++frame)
            evidence.run({source}, float(frame) * .1f);
        float sample_time = 2;
        for (int frame = 0; frame < 32; ++frame) {
            sample_time += cadence;
            if (frame == 12)
                sample_time += cadence;
            cloud = observe(evidence, depth_plane(4.f), sample_time, view);
        }
        const float remaining = confidence_at(cloud, .015f, .015f, -2.025f);
        std::cout << "Confirmed wall confidence after coherent " << cadence
                  << "s cadence with one missed frame " << remaining << '\n';
        expect(remaining == 0,
               "Sparse and jittered depth cadence still replaces coherently contradicted surfaces");
    }
}
std::vector<ceres::SpatialMapPoint> metadata(Fixture& f, int64_t origin = 10000000,
                                            const ceres::VoxelLodConfig* lod = nullptr) {
    ceres::SpatialMapPoint* device = nullptr;
    check(cudaMalloc(&device, f.volume.capacity() * sizeof(*device)));
    std::vector<ceres::SpatialMapPoint> result(f.volume.capacity());
    if (lod) check(f.volume.snapshot_metadata_lod(device, *lod, origin, f.stream));
    else check(f.volume.snapshot_metadata(device, origin, f.stream));
    check(cudaMemcpyAsync(result.data(), device, result.size() * sizeof(*device),
                          cudaMemcpyDeviceToHost, f.stream));
    check(cudaStreamSynchronize(f.stream));
    check(cudaFree(device));
    result.erase(std::remove_if(result.begin(), result.end(), [](const auto& p) { return !p.weight; }), result.end());
    std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) {
        return std::tie(a.x, a.y, a.z) < std::tie(b.x, b.y, b.z);
    });
    return result;
}
ceres::VoxelStatistics statistics(Fixture& f) {
    ceres::VoxelStatistics* device = nullptr;
    check(cudaMalloc(&device, sizeof(*device)));
    check(f.volume.statistics(device, f.stream));
    ceres::VoxelStatistics result;
    check(cudaMemcpyAsync(&result, device, sizeof(result), cudaMemcpyDeviceToHost, f.stream));
    check(cudaStreamSynchronize(f.stream));
    check(cudaFree(device));
    return result;
}
std::vector<ceres::VoxelTsdfSample> tsdf(Fixture& f, const std::vector<ceres::StereoPoint>& positions) {
    f.upload(positions);
    ceres::VoxelTsdfSample* device = nullptr;
    check(cudaMalloc(&device, positions.size() * sizeof(*device)));
    check(f.volume.query_tsdf(f.input, positions.size(), device, f.stream));
    std::vector<ceres::VoxelTsdfSample> result(positions.size());
    check(cudaMemcpyAsync(result.data(), device, result.size() * sizeof(*device),
                          cudaMemcpyDeviceToHost, f.stream));
    check(cudaStreamSynchronize(f.stream));
    check(cudaFree(device));
    return result;
}
std::vector<ceres::StereoPoint> dense_plane(float depth, int side = 64, bool valid = true) {
    std::vector<ceres::StereoPoint> result;
    for (int y = 0; y < side; ++y)
        for (int x = 0; x < side; ++x) {
            auto p = point((2.f * (x + .5f) / side - 1) * depth,
                           (1 - 2.f * (y + .5f) / side) * depth, -depth, .2f, .4f, .8f);
            p.valid = valid ? 1.f : 0.f;
            result.push_back(p);
        }
    return result;
}
void tsdf_metric_fusion_and_zero_crossings() {
    Fixture f(65536);
    f.config.voxel_size = .05f;
    f.config.intrinsic_colour = false;
    auto view = observation(f);
    view.width = view.height = 64;
    observe(f, dense_plane(2), 0, view);
    const std::vector<ceres::StereoPoint> positions{
        point(.025f, .025f, -1.925f), point(.025f, .025f, -2.075f), point(10, 10, 10)};
    auto values = tsdf(f, positions);
    expect(near(values[0].weight, 1, .001f) && near(values[0].distance_metres, .075f, .001f) &&
               near(values[1].weight, 1, .001f) && near(values[1].distance_metres, -.075f, .001f) &&
               values[2].weight == 0,
           "TSDF stores signed metric samples around the surface and leaves unknown space unobserved");
    const auto first = metadata(f);
    expect(first.size() > 1000, "A depth plane produces a dense extracted zero-level surface");
    for (const auto& p : first)
        expect(near(p.z, -2, .0001f) && p.flags == 0 && p.r == 0 && p.g == 0 && p.b == 0 &&
                   p.observed_us == 10000000,
               "Depth metadata preserves the mathematical zero crossing without a display palette");
    observe(f, dense_plane(2.04f), 1, view);
    values = tsdf(f, positions);
    expect(values[0].weight > 1 && values[0].weight < 2 && near(values[0].distance_metres, .0898f, .001f) &&
               values[1].weight > 1 && values[1].weight < 2 && near(values[1].distance_metres, -.0602f, .001f),
           "Independent depth captures fuse signed distance with range and residual weighting");
    observe(f, dense_plane(2.04f), 1, view, 2);
    const auto repeated = tsdf(f, positions);
    expect(repeated[0].weight == values[0].weight && repeated[0].distance_metres == values[0].distance_metres,
           "Repeated capture timestamps do not double-count TSDF weight");
    observe(f, dense_plane(1), 3, view);
    const auto occluded = tsdf(f, positions);
    expect(occluded[0].weight == values[0].weight && occluded[0].distance_metres == values[0].distance_metres,
           "Foreground depth does not carve a hidden background TSDF surface");
    observe(f, dense_plane(4, 64, false), 4, view);
    const auto invalid = tsdf(f, positions);
    expect(invalid[0].weight == values[0].weight && invalid[0].distance_metres == values[0].distance_metres,
           "Invalid range samples do not change a retained TSDF");
    for (int frame = 5; frame < 25; ++frame) observe(f, dense_plane(2.04f), float(frame), view);
    values = tsdf(f, positions);
    expect(near(values[0].weight, 16, .001f) && near(values[0].distance_metres, .115f, .005f),
           "Bounded TSDF weight converges under repeated independent measurements");
    const auto stats = statistics(f);
    expect(stats.tsdf_voxels > stats.occupied_points && stats.occupied_points <= f.volume.max_points(),
           "TSDF samples and extracted surface points remain separate bounded layers");

    f.reset();
    f.config.voxel_size = .05f;
    f.config.head_to_world[0] = f.config.head_to_world[10] = 0;
    f.config.head_to_world[2] = -1; f.config.head_to_world[8] = 1;
    f.config.head_to_world[12] = 3; f.config.head_to_world[14] = -.5f;
    view = observation(f); view.width = view.height = 64;
    view.view_from_world[0] = view.view_from_world[10] = 0;
    view.view_from_world[2] = 1; view.view_from_world[8] = -1;
    view.view_from_world[12] = -.5f; view.view_from_world[14] = -3;
    observe(f, dense_plane(2), 0, view);
    values = tsdf(f, {point(1.025f, .025f, -.525f), point(.975f, .025f, -.525f)});
    expect(values[0].weight > 0 && values[1].weight > 0 &&
               near(values[0].distance_metres, .025f, .001f) && near(values[1].distance_metres, -.025f, .001f),
           "TSDF projection uses the capture pose across world rotation and translation");
    for (const auto& p : metadata(f))
        expect(near(p.x, 1, .0001f), "Rotated extracted surfaces remain in world coordinates");
}
void metadata_regrid_restore_and_budget() {
    Fixture f(4096);
    f.config.voxel_size = .02f;
    std::vector<ceres::StereoPoint> points;
    for (int region = 0; region < 4; ++region)
        for (int y = 0; y < 8; ++y)
            for (int x = 0; x < 8; ++x)
                points.push_back(point(region * .64f + .003f + x * .02f,
                                       .007f + y * .02f, -2.003f, .2f, .4f, .8f));
    f.run(points, 7);
    const auto initial = metadata(f);
    expect(initial.size() == points.size() && near(initial.front().x, .003f) &&
               near(initial.front().y, .007f) && near(initial.front().z, -2.003f) &&
               initial.front().observed_us == 17000000 &&
               initial.front().flags == ceres::spatial_map_intrinsic_rgb,
           "Authoritative metadata retains acquired coordinates, source colour and observation time");
    ceres::VoxelLodConfig lod;
    lod.confidence_adaptive = false;
    lod.view_position[2] = 20;
    (void)metadata(f, 10000000, &lod);
    const auto unchanged = metadata(f);
    expect(initial.size() == unchanged.size() &&
               std::equal(initial.begin(), initial.end(), unchanged.begin(), [](const auto& a, const auto& b) {
                   return a.x == b.x && a.y == b.y && a.z == b.z && a.observed_us == b.observed_us && a.weight == b.weight;
               }), "Display snapshots cannot modify acquisition geometry or timestamps");
    const size_t allocation = f.volume.scratch_bytes();
    check(f.volume.set_max_points(32, f.stream));
    auto coarse = metadata(f);
    expect(coarse.size() <= 32 && f.volume.max_points() == 32 && f.volume.scratch_bytes() == allocation,
           "Reducing the logical map budget coarsens immediately within the fixed allocation");
    for (int region = 0; region < 4; ++region)
        expect(std::any_of(coarse.begin(), coarse.end(), [&](const auto& p) {
            return p.x >= region * .64f && p.x < region * .64f + .16f;
        }), "Budget pressure preserves each acquired region by spatial merging");
    check(f.volume.reconfigure(.08f, f.stream));
    coarse = metadata(f);
    for (const auto& p : coarse)
        expect(near(p.z, -2.003f) && p.observed_us == 17000000 && p.cell_size >= .08f,
               "Changing grid spacing retains the measured surface position and timestamp");
    check(f.volume.reconfigure(.01f, f.stream));
    const auto finer = metadata(f);
    expect(!finer.empty(), "Finer future acquisition does not discard existing coarse geometry");
    for (const auto& p : finer) expect(near(p.z, -2.003f), "Regridding does not snap geometry to a voxel centre");
    ceres::SpatialMapPoint* device = nullptr;
    check(cudaMalloc(&device, finer.size() * sizeof(*device)));
    check(cudaMemcpyAsync(device, finer.data(), finer.size() * sizeof(*device), cudaMemcpyHostToDevice, f.stream));
    check(f.volume.restore(device, finer.size(), .01f, 10000000, f.stream));
    const auto restored = metadata(f);
    check(cudaFree(device));
    expect(restored.size() == finer.size(), "Restore replaces the authoritative surface cache");
    for (const auto& p : restored)
        expect(near(p.z, -2.003f) && p.observed_us == 17000000 &&
                   p.flags == ceres::spatial_map_intrinsic_rgb,
               "Restore preserves world geometry, colour provenance and last observation time");
    expect(statistics(f).tsdf_voxels == 0, "Restored surfaces begin with an empty TSDF working layer");
    expect(f.volume.set_max_points(0, f.stream) == cudaErrorInvalidValue &&
               f.volume.set_max_points(f.volume.capacity() + 1, f.stream) == cudaErrorInvalidValue,
           "Logical budgets cannot bypass the hard GPU allocation bound");
}
void saved_map_transform_geometry_and_metadata() {
    Fixture f(4096);
    constexpr int64_t origin = 10000000;
    std::vector<ceres::SpatialMapPoint> source(3);
    const float positions[3][3]{{-.237f, .417f, -1.531f},
                               {1.713f, -2.127f, .673f},
                               {4.971f, 3.139f, -4.217f}};
    const unsigned weights[3]{3, 17, 900};
    for (unsigned index = 0; index < source.size(); ++index) {
        auto& p = source[index];
        p.x = positions[index][0]; p.y = positions[index][1]; p.z = positions[index][2];
        p.cell_size = .02f * (1u << index);
        p.confidence = .25f * (index + 1);
        p.weight = weights[index];
        p.observed_us = origin + (index + 1) * 1250000;
        if (index < 2) {
            p.r = .2f; p.g = .4f; p.b = .8f;
            p.flags = ceres::spatial_map_intrinsic_rgb;
        }
    }
    ceres::SpatialMapPoint* device = nullptr;
    check(cudaMalloc(&device, source.size() * sizeof(*device)));
    check(cudaMemcpyAsync(device, source.data(), source.size() * sizeof(*device),
                          cudaMemcpyHostToDevice, f.stream));
    check(f.volume.restore(device, source.size(), .01f, origin, f.stream));
    const auto before = metadata(f, origin);
    check(cudaFree(device));
    expect(before.size() == source.size(), "Saved transform fixture retains each distinct source cell");

    float matrix[16];
    identity(matrix);
    matrix[0] = matrix[5] = 0;
    matrix[1] = 2; matrix[4] = -3; matrix[10] = .5f;
    matrix[12] = 20; matrix[13] = -5; matrix[14] = 2;
    check(f.volume.transform(matrix, .02f, origin, f.stream));
    identity(matrix);
    matrix[12] = .25f; matrix[13] = -.5f; matrix[14] = 1;
    check(f.volume.transform(matrix, .02f, origin, f.stream));
    std::fill_n(matrix, 16, std::numeric_limits<float>::quiet_NaN());
    const auto transformed = metadata(f, origin);
    expect(transformed.size() == before.size(),
           "Queued transforms reuse scratch storage without importing empty capacity slots");
    for (const auto& p : before) {
        const auto found = std::find_if(transformed.begin(), transformed.end(), [&](const auto& q) {
            return q.weight == p.weight;
        });
        expect(found != transformed.end(), "Transforms preserve complete evidence support");
        expect(near(found->x, -3 * p.y + 20.25f) && near(found->y, 2 * p.x - 5.5f) &&
                   near(found->z, .5f * p.z + 3),
               "Host matrix values are copied for queued translation, rotation and nonuniform scale");
        float expected_width = .02f;
        while (expected_width < p.cell_size * 3 * .99999f) expected_width *= 2;
        expect(near(found->cell_size, expected_width) &&
                   near(found->confidence, p.confidence) && found->observed_us == p.observed_us &&
                   found->flags == p.flags && near(found->r, p.r) && near(found->g, p.g) && near(found->b, p.b),
               "Transform regridding retains colour, confidence and timestamps with conservative cell widths");
    }
    expect(statistics(f).tsdf_voxels == 0 && f.volume.scratch_bytes() == f.allocation_bytes,
           "Saved transforms retain a fixed allocation and leave the TSDF working layer empty");

    f.config.voxel_size = .02f;
    auto view = observation(f);
    view.width = view.height = 16;
    observe(f, dense_plane(2, 16), 5, view);
    const auto acquired = metadata(f, origin);
    expect(statistics(f).tsdf_voxels > 0 && acquired.size() > transformed.size(),
           "Independent fresh depth builds a new TSDF and extends the transformed map");
    for (const auto& p : transformed)
        expect(std::any_of(acquired.begin(), acquired.end(), [&](const auto& q) {
            return near(q.x, p.x) && near(q.y, p.y) && near(q.z, p.z) &&
                   q.weight == p.weight && q.observed_us == p.observed_us &&
                   near(q.confidence, p.confidence) && q.flags == p.flags &&
                   near(q.r, p.r) && near(q.g, p.g) && near(q.b, p.b);
        }), "Fresh acquisition preserves far transformed samples and their evidence");
}
void saved_map_transform_validation_and_tsdf() {
    Fixture f(8192);
    f.config.voxel_size = .05f;
    auto view = observation(f);
    view.width = view.height = 16;
    observe(f, dense_plane(2, 16), 1, view);
    const auto before = metadata(f);
    const auto working = statistics(f);
    expect(!before.empty() && working.tsdf_voxels > 0, "Transform validation fixture contains both map layers");
    float matrix[16];
    identity(matrix);
    auto reject = [&] {
        expect(f.volume.transform(matrix, .05f, 10000000, f.stream) == cudaErrorInvalidValue,
               "Invalid saved-map matrices are rejected before queuing any mutation");
        identity(matrix);
    };
    matrix[0] = std::numeric_limits<float>::quiet_NaN(); reject();
    matrix[12] = std::numeric_limits<float>::infinity(); reject();
    matrix[3] = .01f; reject();
    matrix[7] = .01f; reject();
    matrix[11] = .01f; reject();
    matrix[15] = .5f; reject();
    matrix[0] = 0; reject();
    matrix[5] = 1e-7f; reject();
    matrix[4] = .2f; reject();
    matrix[0] = -1; reject();
    expect(f.volume.transform(nullptr, .05f, 10000000, f.stream) == cudaErrorInvalidValue &&
               f.volume.transform(matrix, .05f, 10000000, nullptr) == cudaErrorInvalidValue &&
               f.volume.transform(matrix, .05f, -1, f.stream) == cudaErrorInvalidValue &&
               f.volume.transform(matrix, 0, 10000000, f.stream) == cudaErrorInvalidValue &&
               f.volume.transform(matrix, std::numeric_limits<float>::infinity(), 10000000, f.stream) ==
                   cudaErrorInvalidValue &&
               f.volume.transform(matrix, std::numeric_limits<float>::quiet_NaN(), 10000000, f.stream) ==
                   cudaErrorInvalidValue,
           "Invalid transform arguments are rejected before changing the map");
    const auto unchanged = metadata(f);
    expect(unchanged.size() == before.size() &&
               std::equal(before.begin(), before.end(), unchanged.begin(), [](const auto& a, const auto& b) {
                   return a.x == b.x && a.y == b.y && a.z == b.z && a.cell_size == b.cell_size &&
                          a.r == b.r && a.g == b.g && a.b == b.b && a.confidence == b.confidence &&
                          a.observed_us == b.observed_us && a.weight == b.weight && a.flags == b.flags;
               }) && statistics(f).tsdf_voxels == working.tsdf_voxels,
           "Rejected transforms leave retained metadata and the TSDF working layer intact");
    matrix[12] = 30;
    check(f.volume.transform(matrix, .05f, 10000000, f.stream));
    const auto transformed = metadata(f);
    expect(transformed.size() == before.size() && statistics(f).tsdf_voxels == 0,
           "Transforming an acquired map clears its old TSDF while retaining extracted surfaces");
    std::vector<bool> matched(transformed.size());
    for (const auto& source : before) {
        bool found = false;
        for (size_t index = 0; index < transformed.size(); ++index) {
            const auto& target = transformed[index];
            if (matched[index] || !near(target.x, source.x + 30) ||
                !near(target.y, source.y) || !near(target.z, source.z) ||
                target.weight != source.weight || target.observed_us != source.observed_us) continue;
            matched[index] = found = true;
            break;
        }
        if (!found)
            std::cerr << "Unmatched translated sample " << source.x << ' ' << source.y << ' ' << source.z
                      << ", support " << source.weight << ", observed " << source.observed_us << '\n';
        // Translation can round almost-equal X values into one floating-point
        // value, changing their Y/Z sort order without changing the surfaces.
        expect(found, "Translation moves every retained surface without changing its support or observation time");
    }
}
void observation_time_and_invalid_pressure() {
    Fixture evidence(8192);
    evidence.run({point(.01f, .01f, -2.01f)}, 0);
    auto view = observation(evidence);
    observe(evidence, depth_plane(4), 1, view);
    const auto retained = metadata(evidence);
    const auto old = std::find_if(retained.begin(), retained.end(), [](const auto& p) {
        return near(p.x, .01f) && near(p.y, .01f) && near(p.z, -2.01f);
    });
    expect(old != retained.end() && old->confidence < 1 && old->observed_us == 10000000,
           "Contradictory free space reduces confidence without refreshing the surface observation time");

    Fixture crowded(256);
    view = observation(crowded);
    observe(crowded, depth_plane(2), 0, view);
    const auto before = statistics(crowded);
    expect(before.tsdf_voxels > 0, "Small working TSDF contains measured distance samples");
    observe(crowded, depth_plane(4, false), 1, view);
    const auto after = statistics(crowded);
    expect(after.tsdf_voxels == before.tsdf_voxels,
           "A wholly invalid capture cannot reclaim a saturated TSDF working layer");
}
void pressure_preserves_all_regions() {
    auto support = [](const auto& points) {
        unsigned maximum = 0;
        for (const auto& p : points) maximum = std::max(maximum, p.weight);
        return maximum;
    };
    auto covered = [](const auto& retained, const auto& input) {
        for (const auto& source : input) {
            bool found = false;
            for (const auto& p : retained) {
                const auto cell = [size = p.cell_size](float value) {
                    return std::floor(double(value) / size);
                };
                if (cell(p.x) == cell(source.x) && cell(p.y) == cell(source.y) &&
                    cell(p.z) == cell(source.z)) { found = true; break; }
            }
            if (!found) return false;
        }
        return true;
    };
    Fixture f(256);
    f.config.voxel_size = .01f;
    std::vector<ceres::StereoPoint> separated;
    for (int i = 0; i < 33; ++i)
        separated.push_back(point(i * 1.28f + .003f, .007f, -2.003f));
    f.run(separated, 0);
    check(f.volume.set_max_points(32, f.stream));
    auto result = metadata(f);
    expect(!result.empty() && result.size() <= 32 && support(result) == 1 && covered(result, separated),
           "More than 32 distant regions merge beyond six levels without losing coverage or support");
    expect(std::any_of(result.begin(), result.end(), [](const auto& p) { return p.cell_size > .64f; }),
           "Retained coarsening extends past the former six-level ceiling");

    std::vector<ceres::StereoPoint> incoming;
    for (int i = 0; i < 600; ++i)
        incoming.push_back(point(100 + i * 1.28f + .003f, .007f, -2.003f));
    f.run(incoming, 1);
    result = metadata(f);
    expect(result.size() <= 32 && support(result) <= 2 && covered(result, separated) && covered(result, incoming),
           "An oversized observation preserves every old and new region within the logical budget");
    f.reset();
    check(f.volume.set_max_points(256, f.stream));
    f.config.voxel_size = .01f;
    f.run(incoming, 0);
    result = metadata(f);
    expect(result.size() <= 256 && support(result) == 1 && covered(result, incoming),
           "The first oversized observation retries all samples instead of retaining an arbitrary prefix");
    f.reset();
    check(f.volume.set_max_points(1, f.stream));
    f.config.voxel_size = .01f;
    f.run({point(-100, -100, -100), point(100, 100, 100)}, 0);
    result = metadata(f);
    expect(result.size() == 1 && result[0].weight == 1 && near(result[0].cell_size, .01f * (1u << 21), .01f) &&
               near(result[0].x, 0) && near(result[0].y, 0) && near(result[0].z, 0),
           "The universal parent preserves both sides of every axis under a one-point budget");
    check(f.volume.set_max_points(256, f.stream));

    ceres::SpatialMapPoint large{};
    large.x = .003f; large.y = .007f; large.z = -2.003f;
    large.cell_size = 5.12f; large.confidence = 1; large.weight = 264000;
    large.observed_us = 17000000;
    ceres::SpatialMapPoint* device = nullptr;
    check(cudaMalloc(&device, sizeof(large)));
    check(cudaMemcpyAsync(device, &large, sizeof(large), cudaMemcpyHostToDevice, f.stream));
    check(f.volume.restore(device, 1, .01f, 10000000, f.stream));
    result = metadata(f);
    expect(result.size() == 1 && near(result[0].cell_size, 5.12f) && result[0].weight == large.weight &&
               near(result[0].x, large.x) && near(result[0].z, large.z),
           "Import preserves large stored hierarchy cells, their representative and all retained support");
    check(cudaFree(device));
    expect(f.volume.scratch_bytes() == f.allocation_bytes,
           "Full-hierarchy pressure and overflow retries use fixed allocations");
}

void adversarial_retained_hash_collisions() {
    auto spread = [](unsigned value) {
        unsigned long long bits = value & ((1u << 21) - 1);
        bits = (bits | (bits << 32)) & 0x001f00000000ffffull;
        bits = (bits | (bits << 16)) & 0x001f0000ff0000ffull;
        bits = (bits | (bits << 8)) & 0x100f00f00f00f00full;
        bits = (bits | (bits << 4)) & 0x10c30c30c30c30c3ull;
        return (bits | (bits << 2)) & 0x1249249249249249ull;
    };
    auto hash = [](unsigned long long value) {
        value ^= value >> 30; value *= 0xbf58476d1ce4e5b9ull;
        value ^= value >> 27; value *= 0x94d049bb133111ebull;
        value ^= value >> 31;
        return unsigned(value);
    };
    Fixture f(256);
    std::vector<ceres::SpatialMapPoint> source;
    for (unsigned y = 0; y < 256 && source.size() < 130; ++y)
        for (unsigned x = 0; x < 65536 && source.size() < 130; ++x) {
            const auto key = ((spread(x + (1u << 20)) | (spread(y + (1u << 20)) << 1) |
                              (spread((1u << 20) - 1) << 2)) << 1) | 1ull;
            const auto h = hash(key);
            if ((h & 255u) != 0 || (((h >> 16) | 1u) & 255u) != 1) continue;
            ceres::SpatialMapPoint p{};
            p.x = (x + .5f) * .03f; p.y = (y + .5f) * .03f; p.z = -.015f;
            p.cell_size = .03f; p.confidence = 1; p.weight = 1; p.observed_us = 10000000;
            source.push_back(p);
        }
    expect(source.size() == 130, "Adversarial hash fixture fills more than 128 identical probe paths");
    ceres::SpatialMapPoint* device = nullptr;
    check(cudaMalloc(&device, source.size() * sizeof(*device)));
    check(cudaMemcpyAsync(device, source.data(), source.size() * sizeof(*device), cudaMemcpyHostToDevice, f.stream));
    check(f.volume.restore(device, source.size(), .03f, 10000000, f.stream));
    const auto restored = metadata(f);
    expect(restored.size() == source.size(), "Retained rehashing preserves groups beyond 128 probes");
    std::vector<ceres::StereoPoint> revisit;
    for (const auto& p : source) revisit.push_back(point(p.x, p.y, p.z));
    f.run(revisit, 1);
    const auto refreshed = metadata(f);
    expect(refreshed.size() == source.size() && std::all_of(refreshed.begin(), refreshed.end(), [](const auto& p) {
        return p.weight == 2 && p.observed_us == 11000000;
    }), "Lookup and insertion agree for retained cells beyond the old probe window");
    check(cudaFree(device));
}
void confidence_and_independent_observations() {
    Fixture stable(256), discordant(256);
    stable.config.voxel_size = discordant.config.voxel_size = .1f;
    const auto sample = point(.01f, .01f, -1.01f);
    stable.run(std::vector<ceres::StereoPoint>(32768, sample), 0);
    auto first = metadata(stable);
    expect(first.size() == 1 && first[0].weight == 1 && first[0].confidence > .1f && first[0].confidence < .3f,
           "Thousands of pixels in one capture contribute one tentative evidence vote");
    stable.run({sample}, 0);
    auto duplicate = metadata(stable);
    expect(duplicate[0].weight == first[0].weight && duplicate[0].confidence == first[0].confidence,
           "Replaying the same capture timestamp cannot manufacture certainty");
    for (int capture = 0; capture < 24; ++capture) {
        if (capture) stable.run({point(.011f, .01f, -1.01f)}, float(capture));
        discordant.run({point(capture & 1 ? .095f : .005f, .01f, -1.01f)}, float(capture));
    }
    const auto reliable = metadata(stable), uncertain = metadata(discordant);
    expect(reliable[0].weight == 24 && uncertain[0].weight == 24 && reliable[0].confidence > .98f &&
               uncertain[0].confidence < .85f && reliable[0].confidence > uncertain[0].confidence + .15f,
           "Repeated positional agreement raises confidence while discordant positions remain uncertain");
    expect(reliable[0].x > sample.x && reliable[0].x < .0111f && near(stable.read()[0].x, reliable[0].x),
           "Every sweep refines the measured position and both snapshot APIs expose the same centroid");
}

void confidence_density_and_real_budget() {
    Fixture f(1024);
    f.config.voxel_size = .02f;
    std::vector<ceres::StereoPoint> strong, weak;
    for (int y = 0; y < 8; ++y)
        for (int x = 0; x < 8; ++x) {
            strong.push_back(point(.003f + x * .02f, .007f + y * .02f, -1.003f));
            weak.push_back(point(2.003f + x * .02f, .007f + y * .02f, -1.003f));
        }
    for (int capture = 0; capture < 16; ++capture) f.run(strong, float(capture));
    f.run(weak, 16);
    ceres::VoxelLodConfig lod;
    lod.minimum_distance = 100000;
    auto displayed = metadata(f, 10000000, &lod);
    const auto detailed = std::count_if(displayed.begin(), displayed.end(), [](const auto& p) {
        return p.x < 1 && p.cell_size < .021f;
    });
    const auto tentative = std::count_if(displayed.begin(), displayed.end(), [](const auto& p) { return p.x > 1; });
    expect(detailed == 64 && tentative > 0 && tentative < 16 && metadata(f).size() == 128,
           "Reliable sweeps retain dense detail while tentative regions remain visible and acquisition stays intact");
    check(f.volume.set_max_points(140, f.stream));
    f.run({point(4.003f, .007f, -1.003f)}, 17);
    auto retained = metadata(f);
    expect(retained.size() == 129 && std::all_of(retained.begin(), retained.end(), [](const auto& p) {
        return p.cell_size < .021f;
    }), "A map above75percent occupancy retains every fine cell while it remains inside the selected budget");
    check(f.volume.set_max_points(96, f.stream));
    retained = metadata(f);
    expect(retained.size() <= 96 && std::count_if(retained.begin(), retained.end(), [](const auto& p) {
        return p.x < 1 && p.cell_size < .021f && p.weight == 16;
    }) == 64, "Actual budget pressure reduces weak regions before repeatedly confirmed detail");
    expect(retained_coverage(f.read(), strong, .02f) == 1 && retained_coverage(f.read(), weak, .02f) == 1,
           "Confidence-priority pressure keeps every observed region represented");
    for (const auto& point : retained) if (point.x > 1)
        expect(point.weight == 1, "Spatial aggregation does not turn one capture into multiple evidence votes");
}

void projective_measurement_quality_and_growth() {
    Fixture f(32768);
    f.config.voxel_size = .1f;
    auto view = observation(f);
    view.width = view.height = 32;
    for (int capture = 0; capture < 14; ++capture)
        observe(f, dense_plane(2, 32), float(capture), view);
    const auto before = metadata(f);
    double centre = 0, edge = 0;
    unsigned centres = 0, edges = 0;
    for (const auto& p : before) {
        if (std::abs(p.x) < .3f && std::abs(p.y) < .3f) { centre += p.confidence; ++centres; }
        if (std::abs(p.x) > 1.5f && std::abs(p.y) > 1.5f) { edge += p.confidence; ++edges; }
    }
    const double first_edge_confidence = edges ? edge / edges : 0;
    expect(centres && edges && centre / centres > .85 && edge / edges < centre / centres - .1 && edge / edges > .05,
           "Peripheral depth contributes less certainty while retaining visible surface coverage");
    for (int capture = 14; capture < 54; ++capture)
        observe(f, dense_plane(2, 32), float(capture), view);
    const auto sustained = metadata(f);
    edge = 0; edges = 0;
    for (const auto& p : sustained)
        if (std::abs(p.x) > 1.5f && std::abs(p.y) > 1.5f) { edge += p.confidence; ++edges; }
    expect(edges && edge / edges > .88 && edge / edges > first_edge_confidence + .12,
           "Sustained agreeing peripheral captures eventually earn high confidence and finer detail");
    const auto queried = tsdf(f, {point(.05f, .05f, -1.95f)});
    const auto previous_bytes = f.volume.scratch_bytes();
    check(f.volume.reserve(65536, f.stream));
    check(f.volume.set_max_points(50000, f.stream));
    const auto after = metadata(f);
    const auto grown_tsdf = tsdf(f, {point(.05f, .05f, -1.95f)});
    expect(f.volume.capacity() == 65536 && f.volume.max_points() == 50000 &&
               f.volume.scratch_bytes() > previous_bytes && sustained.size() == after.size(),
           "A larger selected budget grows GPU storage without discarding the acquired map");
    for (size_t i = 0; i < sustained.size(); ++i)
        expect(sustained[i].x == after[i].x && sustained[i].y == after[i].y && sustained[i].z == after[i].z &&
                   sustained[i].confidence == after[i].confidence && sustained[i].weight == after[i].weight,
               "Capacity growth preserves each fused position and its accumulated independent evidence");
    expect(queried[0].weight == grown_tsdf[0].weight && queried[0].distance_metres == grown_tsdf[0].distance_metres,
           "Capacity growth also preserves the working TSDF instead of resetting positional refinement");
    expect(f.volume.reserve(3, f.stream) == cudaErrorInvalidValue && metadata(f).size() == sustained.size(),
           "Rejected growth leaves the existing map intact");
}
void full_selected_point_budget() {
    Fixture f(524288);
    f.config.voxel_size = .01f;
    check(f.volume.set_max_points(350000, f.stream));
    std::vector<ceres::StereoPoint> measured;
    measured.reserve(300000);
    for (int y = 0; y < 300; ++y)
        for (int x = 0; x < 1000; ++x)
            measured.push_back(point((x + .25f) * .01f, (y + .25f) * .01f, -1.005f));
    auto retained = f.run(measured, 0);
    expect(retained.size() == 300000 && std::all_of(retained.begin(), retained.end(), [](const auto& p) {
        return p.valid == 1;
    }), "A300000point map keeps every measured fine point above the former fixed ceiling");
    retained = f.run({point(20.005f, .005f, -1.005f)}, 1);
    expect(retained.size() == 300001 && std::all_of(retained.begin(), retained.end(), [](const auto& p) {
        return p.valid == 1;
    }), "Subsequent sweeps do not flatten acquired geometry below the selected350000point budget");
}
void observation_births_do_not_restart() {
    Fixture f(256);
    f.config.voxel_size = .1f;
    f.run({point(.025f, .025f, -.025f)}, 2);
    f.run({point(.027f, .025f, -.025f), point(.125f, .025f, -.025f)}, 3);
    ceres::SpatialMapPoint* device = nullptr;
    float* device_births = nullptr;
    check(cudaMalloc(&device, f.volume.capacity() * sizeof(ceres::SpatialMapPoint)));
    check(cudaMalloc(&device_births, f.volume.capacity() * sizeof(float)));
    auto read = [&](bool grouped) {
        ceres::VoxelLodConfig lod;
        lod.max_level = 1;
        if (grouped) check(f.volume.snapshot_metadata_lod(device, lod, 0, f.stream, device_births));
        else check(f.volume.snapshot_metadata(device, 0, f.stream, device_births));
        std::vector<ceres::SpatialMapPoint> points(f.volume.capacity());
        std::vector<float> births(f.volume.capacity());
        check(cudaMemcpyAsync(points.data(), device, points.size() * sizeof(points[0]), cudaMemcpyDeviceToHost, f.stream));
        check(cudaMemcpyAsync(births.data(), device_births, births.size() * sizeof(float), cudaMemcpyDeviceToHost, f.stream));
        check(cudaStreamSynchronize(f.stream));
        std::vector<std::pair<ceres::SpatialMapPoint, float>> result;
        for (size_t i = 0; i < points.size(); ++i) if (points[i].weight) result.emplace_back(points[i], births[i]);
        return result;
    };
    auto points = read(false);
    expect(points.size() == 2 && std::any_of(points.begin(), points.end(), [](const auto& p) {
        return p.first.x < .1f && p.second == 2;
    }) && std::any_of(points.begin(), points.end(), [](const auto& p) {
        return p.first.x > .1f && p.second == 3;
    }), "New points retain their first observation time while subsequent sweeps do not restart appearance");
    points = read(true);
    expect(points.size() == 1 && points[0].second == 2,
           "A shared display representative inherits the earliest contributing birth time");
    check(f.volume.restore(device, f.volume.capacity(), .1f, 0, f.stream));
    points = read(false);
    expect(points.size() == 1 && points[0].second < 0,
           "Deliberately imported maps appear immediately without a new-acquisition fade");
    check(cudaFree(device));
    check(cudaFree(device_births));
}
} // namespace

int main(int argc, char**) {
    try {
        if (argc > 1) {
            sweep_reliability();
            return 0;
        }
        confidence_and_independent_observations();
        confidence_density_and_real_budget();
        projective_measurement_quality_and_growth();
        full_selected_point_budget();
        observation_births_do_not_restart();
        tsdf_metric_fusion_and_zero_crossings();
        metadata_regrid_restore_and_budget();
        saved_map_transform_geometry_and_metadata();
        saved_map_transform_validation_and_tsdf();
        observation_time_and_invalid_pressure();
        pressure_preserves_all_regions();
        adversarial_retained_hash_collisions();
        geometry_and_colours();
        persistence_and_invalid_samples();
        collisions_and_reuse();
        lod_density_and_world_grid();
        lod_boundaries_and_validation();
        lod_colours_and_persistence();
        projective_evidence();
        hand_exclusion_and_occlusion();
        coarse_evidence_and_priority();
        near_revisit_refinement();
        bounded_accumulation_and_timing();
        sweep_reliability();
        std::cout << "CUDA voxel transforms, colours, persistence, evidence, pressure, LoD and bounds passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
