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
    explicit Fixture(size_t capacity) : volume(capacity), host(capacity) {
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
                sample.valid <= 64 && sample.valid == std::floor(sample.valid) &&
                !(unsigned(sample.valid) & (unsigned(sample.valid) - 1));
            expect(valid_width && std::isfinite(sample.x) && std::isfinite(sample.y) &&
                       std::isfinite(sample.z) && std::isfinite(sample.a) && sample.a > 0 && sample.a <= 1 &&
                       sample.r >= 0 && sample.r <= 1.0001f && sample.g >= 0 &&
                       sample.g <= 1.0001f && sample.b >= 0 && sample.b <= 1.0001f,
                   "Finite world-space snapshot and fused colours");
            expect(positions.emplace(sample.x, sample.y, sample.z).second,
                   "No duplicate voxel centres");
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

void geometry_and_colours() {
    Fixture f(256);
    expect(f.volume.capacity() == 256 && f.volume.scratch_bytes() == 256 * 128 + 288,
           "Fixed, accounted voxel allocation");
    expect(f.read().empty(), "New volume snapshot is empty");
    auto cloud = f.run({point(0.04f, 0.04f, -0.10f)}, 0);
    expect(cloud.size() == 1 && near(cloud[0].x, .045f) && near(cloud[0].y, .045f) &&
               near(cloud[0].z, -.105f) && cloud[0].a == 1,
           "Voxel centres use floor quantisation in metres, including negative Z");

    f.config.head_to_world[12] = .30f;
    cloud = f.run({point(-.26f, .04f, -.10f, 0, 0, 1)}, 1);
    expect(cloud.size() == 1 && near(cloud[0].r, .5f) && near(cloud[0].b, .5f) && cloud[0].a == 1,
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
    expect(cloud.size() == 1 && near(cloud[0].x, .195f) && near(cloud[0].y, .645f) &&
               near(cloud[0].z, -.945f),
           "Column-major rotation and translation transform head-local points");

    f.reset();
    cloud = f.run({point(-.001f, -.031f, -.061f), point(.001f, .031f, .061f)}, 0);
    expect(cloud.size() == 2 && std::any_of(cloud.begin(), cloud.end(),
                                            [](const auto& p) {
                                                return near(p.x, -.015f) && near(p.y, -.045f) &&
                                                       near(p.z, -.075f);
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
    cloud = f.run({}, 100000);
    expect(cloud.size() == 2 && cloud[0].a == 1 && cloud[1].a == 1,
           "Idle time cannot fade or remove retained evidence");
    expect(f.run({point(10, 10, -10)}, 0, 100001).size() == 2,
           "An old observation cannot introduce unseen geometry");

    f.reset();
    f.run({first}, 0);
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
    expect(cloud.size() == 1 && cloud[0].a == 1, "Invalid samples do not alter existing evidence");
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
        expect(std::any_of(cloud.begin(), cloud.end(), [x](const auto& p) {
                   return std::abs(p.x - x) < .3f;
               }), "New regions continue entering a saturated map");
    }
    expect(f.volume.scratch_bytes() == 32 * 128 + 288, "Repeated reuse never grows memory");
}

using LodLocation = std::tuple<int, int, int, unsigned>;
LodLocation location(const ceres::StereoPoint& p, float voxel_size) {
    const unsigned width = unsigned(p.valid);
    return {int(std::lround(p.x / voxel_size - width * .5f)),
            int(std::lround(p.y / voxel_size - width * .5f)),
            int(std::lround(p.z / voxel_size - width * .5f)), width};
}
LodLocation expected_location(const ceres::StereoPoint& p, float voxel_size,
                              const ceres::VoxelLodConfig& lod) {
    const int indices[3]{int(std::lround(p.x / voxel_size - .5f)),
                          int(std::lround(p.y / voxel_size - .5f)),
                          int(std::lround(p.z / voxel_size - .5f))};
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
    expect(f.volume.scratch_bytes() == 8192 * 128 + 288,
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
    lod.view_position[2] = 20;
    lod.focal_length_pixels = 100;
    lod.target_pixels = 20;
    lod.max_level = 1;
    f.run({point(.25f, .25f, -.25f, 1, 0, 0)}, 0);
    f.run({point(1.25f, .25f, -.25f, 0, 0, 1)}, 5);
    auto cloud = f.read(&lod);
    expect(cloud.size() == 1 && cloud[0].valid == 2 && near(cloud[0].r, .5f) &&
               near(cloud[0].b, .5f) && cloud[0].a == 1,
           "Coarse colour averages fine cells and retains supported confidence");
    f.run({point(8.25f, .25f, -.25f, 0, 1, 0)}, 9);
    cloud = f.read(&lod);
    auto older = std::find_if(cloud.begin(), cloud.end(), [](const auto& p) { return p.x < 2; });
    expect(cloud.size() == 2 && older != cloud.end() && older->a == 1,
           "Unrelated fresh geometry leaves existing confidence unchanged");
    f.run({}, 100000);
    cloud = f.read(&lod);
    older = std::find_if(cloud.begin(), cloud.end(), [](const auto& p) { return p.x < 2; });
    expect(cloud.size() == 2 && older != cloud.end() && older->a == 1 && near(older->r, .5f) &&
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
        const float half = p.valid * voxel_size * .5f;
        if (location.x >= p.x - half && location.x < p.x + half &&
            location.y >= p.y - half && location.y < p.y + half &&
            location.z >= p.z - half && location.z < p.z + half)
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
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), .8f),
           "A newer depth image fades evidence strictly inside measured free space");
    cloud = observe(f, far, 1, view, 2);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), .8f),
           "Repeated observations cannot subtract confidence twice");
    cloud = observe(f, far, .5f, view, 2);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), .8f),
           "Older observations cannot contradict newer evidence");
    cloud = observe(f, depth_plane(1), 3, view);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), .8f),
           "A foreground surface preserves occluded background evidence");
    cloud = observe(f, depth_plane(4, false), 4, view);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), .8f),
           "Invalid depth cannot erase retained geometry");
    cloud = f.run({}, 100000);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), .8f),
           "Partially contradicted evidence does not continue fading with age");
    cloud = f.run({source}, 100001);
    expect(near(confidence_at(cloud, .015f, .015f, -2.025f), 1),
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
    expect(confidence_at(cloud, 10.005f, .015f, -2.025f) == 1,
           "Off-screen geometry persists through unrelated observations");

    f.reset();
    f.config.head_to_world[12] = 3;
    f.config.head_to_world[13] = .6f;
    f.run({source}, 0);
    view = observation(f);
    view.view_from_world[12] = -3;
    view.view_from_world[13] = -.6f;
    cloud = observe(f, far, 1, view);
    expect(near(confidence_at(cloud, 3.015f, .615f, -2.025f), .8f),
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
    expect(near(confidence_at(cloud, 2.025f, .015f, .015f), .8f),
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
    expect(confidence_at(cloud, .015f, .015f, -2.025f) == 1,
           "A tracked hand shields background from contradictory depth");
    view.hands = {};
    view.hands.palm_count = 1;
    auto& palm = view.hands.palms[0];
    palm.centre[2] = -1;
    palm.axes[0] = palm.axes[4] = palm.axes[8] = 1;
    palm.half_extent[0] = palm.half_extent[1] = .15f;
    palm.half_extent[2] = .05f;
    cloud = observe(f, depth_plane(4), 2, view);
    expect(confidence_at(cloud, .015f, .015f, -2.025f) == 1,
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
        return p.valid == 8 && p.z < -7.9f;
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
    expect(coarse != cloud.end() && near(coarse->a, .8f),
           "Coarsened retained cells lose confidence under projective contradiction");
    cloud = f.run({block.front()}, 3);
    coarse = std::find_if(cloud.begin(), cloud.end(), [](const auto& p) { return p.z < -7.9f; });
    expect(coarse != cloud.end() && near(coarse->a, 1),
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
    expect(confidence_covering(cloud, supported, .03f) > .99f &&
               confidence_covering(cloud, point(100, 0, -1), .03f) > .99f,
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
    cloud = observe(f, near_points, 5, view);
    const auto fine = std::count_if(cloud.begin(), cloud.end(), [](const auto& p) {
        return p.z < -7.9f && p.valid == 1;
    });
    expect(coarse_count(cloud) == 0 && fine >= 36,
           "A near revisit restores fine detail from broad fresh surface coverage");
    expect(f.volume.scratch_bytes() == 128 * 128 + 288,
           "Refinement reuses fixed allocated scratch storage");
}

void bounded_accumulation_and_timing() {
    Fixture f(ceres::stereo_voxel_capacity);
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
    Fixture f(ceres::stereo_voxel_capacity);
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
} // namespace

int main(int argc, char**) {
    try {
        if (argc > 1) {
            sweep_reliability();
            return 0;
        }
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
