#include "ceres/spatial_map.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
void expect(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
template <typename Function> void rejects(Function action, const char* message) {
    bool rejected = false;
    try {
        action();
    } catch (const std::exception&) {
        rejected = true;
    }
    expect(rejected, message);
}
template <typename Function> void wait_until(Function condition, const char* message) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!condition()) {
        expect(std::chrono::steady_clock::now() < deadline, message);
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
}
bool near(float first, float second) { return std::abs(first - second) < .0001f; }

struct Fixture {
    std::filesystem::path root;
    Fixture() {
        static std::atomic<unsigned> sequence{0};
        const auto temporary = std::filesystem::weakly_canonical(std::filesystem::temp_directory_path());
        const auto time = std::chrono::steady_clock::now().time_since_epoch().count();
        root = temporary / ("ceres-map-test-" + std::to_string(time) + "-" + std::to_string(sequence++));
        expect(root.is_absolute() && root.parent_path() == temporary, "Isolated absolute test directory");
        expect(std::filesystem::create_directory(root), "Create isolated map test directory");
    }
    ~Fixture() {
        std::error_code error;
        if (root.is_absolute() && root.filename().string().starts_with("ceres-map-test-"))
            std::filesystem::remove_all(root, error);
    }
    auto path(const char* name = "map.cmap") const { return root / name; }
};
ceres::SpatialMapPoint point(float x, std::int64_t observed = 1100000, unsigned weight = 2) {
    return {x, .25f, -.5f, .03f, .8f, .2f, .1f, .75f, observed,
            weight, ceres::spatial_map_intrinsic_rgb};
}
ceres::SpatialMapSnapshot map(unsigned generation = 1) {
    ceres::SpatialMapSnapshot result;
    result.world_id = "test-tracking-world";
    result.epoch = 7;
    result.space_epoch = 3;
    result.time_origin_us = 1000000;
    result.generation = generation;
    result.points = {point(1.25f), point(-2.5f, 1200000, 4)};
    return result;
}
std::vector<unsigned char> bytes(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
void write(const std::filesystem::path& path, const std::vector<unsigned char>& value) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output.write(reinterpret_cast<const char*>(value.data()), static_cast<std::streamsize>(value.size()));
    expect(bool(output), "Write test fixture");
}
// Independent bitwise Castagnoli implementation for malformed-header fixtures.
void repair_header_crc(std::vector<unsigned char>& value) {
    for (unsigned i = 68; i < 72; ++i)
        value[i] = 0;
    std::uint32_t crc = 0xffffffffu;
    for (unsigned i = 0; i < 256; ++i) {
        crc ^= value[i];
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ ((crc & 1u) ? 0x82f63b78u : 0u);
    }
    crc = ~crc;
    for (unsigned i = 0; i < 4; ++i)
        value[68 + i] = static_cast<unsigned char>(crc >> (i * 8));
}
void portable_roundtrip() {
    Fixture fixture;
    auto original = map();
    auto unused = point(std::numeric_limits<float>::quiet_NaN());
    unused.weight = 0;
    original.points.push_back(unused);
    const auto info = ceres::save_spatial_map(fixture.path(), original);
    expect(info.bytes == 352 && info.input_points == 2 && info.stored_points == 2,
           "Fixed portable header and record lengths exclude empty GPU slots");
    const auto encoded = bytes(fixture.path());
    const std::array<unsigned char, 8> magic{'C', 'E', 'R', 'E', 'S', 'M', 'A', 'P'};
    expect(std::equal(magic.begin(), magic.end(), encoded.begin()), "Portable magic");
    expect(encoded[8] == 1 && encoded[9] == 0 && encoded[12] == 0 && encoded[13] == 1 &&
               encoded[16] == 48 && encoded[24] == 2,
           "Header version, sizes and count are explicitly little endian");
    expect(encoded[256] == 0 && encoded[257] == 0 && encoded[258] == 0xa0 && encoded[259] == 0x3f,
           "World X uses IEEE binary32 little endian");
    expect(encoded[288] == 0xe0 && encoded[289] == 0xc8 && encoded[290] == 0x10 && encoded[291] == 0,
           "Observation microseconds use signed 64-bit little endian");
    const auto restored = ceres::load_spatial_map(fixture.path());
    expect(restored.map.world_id == original.world_id && restored.map.epoch == 7 &&
               restored.map.space_epoch == 3 && restored.map.time_origin_us == 1000000 &&
               restored.map.generation == 1 && restored.map.points.size() == 2,
           "World identity and source clock survive readback");
    const auto& first = restored.map.points.front();
    expect(first.x == 1.25f && first.y == .25f && first.z == -.5f && first.weight == 2 &&
               first.observed_us == 1100000 && first.flags == ceres::spatial_map_intrinsic_rgb &&
               first.r == .8f && first.confidence == .75f,
           "World geometry, intrinsic RGB, support, confidence and timestamp survive readback");
}
void bounded_coarsening() {
    Fixture fixture;
    auto original = map();
    original.points.clear();
    for (unsigned i = 0; i < 16; ++i) {
        original.points.push_back(point(-10.f + i * .001f, 1100000 + i, 2));
        original.points.push_back(point(10.f + i * .001f, 1200000 + i, 2));
    }
    const auto budget = ceres::spatial_map_header_bytes + 2 * ceres::spatial_map_record_bytes;
    const auto info = ceres::save_spatial_map(fixture.path(), original, budget);
    const auto restored = ceres::load_spatial_map(fixture.path(), budget);
    expect(info.bytes <= budget && restored.map.points.size() == 2 && info.input_points == 32,
           "Bounded output coarsens spatial neighbours without discarding either region");
    expect(restored.map.points[0].x < -9 && restored.map.points[1].x > 9 &&
               restored.map.points[0].weight == 2 && restored.map.points[1].weight == 2,
           "Distant regions keep representative positions without adding neighbouring observation counts");
    original.generation = 2;
    const auto minimum = ceres::spatial_map_header_bytes + ceres::spatial_map_record_bytes;
    ceres::save_spatial_map(fixture.path(), original, minimum);
    const auto one = ceres::load_spatial_map(fixture.path(), minimum);
    expect(one.map.points.size() == 1 && near(one.map.points[0].x, .0075f) &&
               one.map.points[0].weight == 2 && one.map.points[0].observed_us == 1200015,
           "A one-cell budget merges both sides of the world origin with weighted XYZ and latest time");
    expect(one.info.grid_size > restored.info.grid_size,
           "Tighter storage progressively increases spatial scale");
}
void confidence_priority_compaction() {
    Fixture fixture;
    auto original = map();
    original.base_voxel_size = .01f;
    original.points.clear();
    for (unsigned region = 0; region < 2; ++region)
        for (unsigned i = 0; i < 8; ++i) {
            auto sample = point(.001f + .16f * region + .02f * float(i % 4), 1100000 + i,
                                region == 0 ? 8 : 1);
            sample.y = .001f + .02f * float(i / 4);
            sample.cell_size = .01f;
            sample.confidence = region == 0 ? .95f : .2f;
            original.points.push_back(sample);
        }
    const auto exact_budget = ceres::spatial_map_header_bytes + original.points.size() * ceres::spatial_map_record_bytes;
    const auto complete_info = ceres::save_spatial_map(fixture.path("complete.cmap"), original, exact_budget);
    const auto complete = ceres::load_spatial_map(fixture.path("complete.cmap"), exact_budget).map;
    expect(complete_info.stored_points == original.points.size() && complete_info.bytes == exact_budget &&
               near(complete_info.grid_size, .01f),
           "An exact file budget retains both confidence levels at their original density");
    for (std::size_t i = 0; i < original.points.size(); ++i)
        expect(complete.points[i].x == original.points[i].x && complete.points[i].y == original.points[i].y &&
                   complete.points[i].cell_size == original.points[i].cell_size &&
                   complete.points[i].confidence == original.points[i].confidence &&
                   complete.points[i].weight == original.points[i].weight,
               "Unequal confidence never changes a sample that fits in the file");

    const auto pressure_budget = ceres::spatial_map_header_bytes + 10 * ceres::spatial_map_record_bytes;
    const auto compacted_info = ceres::save_spatial_map(fixture.path("compact.cmap"), original, pressure_budget);
    const auto compacted = ceres::load_spatial_map(fixture.path("compact.cmap"), pressure_budget).map;
    expect(compacted_info.bytes <= pressure_budget && compacted_info.input_points == 16 &&
               compacted.points.size() <= 10,
           "Real file pressure produces a bounded multiresolution snapshot");
    for (std::size_t i = 0; i < 8; ++i) {
        const auto& fine = original.points[i];
        expect(std::any_of(compacted.points.begin(), compacted.points.end(), [&](const auto& sample) {
            return sample.x == fine.x && sample.y == fine.y && sample.z == fine.z &&
                   sample.cell_size == fine.cell_size && sample.confidence == fine.confidence &&
                   sample.weight == fine.weight && sample.observed_us == fine.observed_us;
        }), "Confident geometry stays at its original resolution while weak neighbours can still merge");
    }
    std::size_t weak = 0;
    for (const auto& sample : compacted.points)
        if (sample.confidence < .5f) {
            ++weak;
            expect(sample.x >= .16f && sample.x < .23f && sample.cell_size > .01f && sample.weight == 1 &&
                       near(sample.confidence, .2f),
                   "Weak geometry remains represented at a coarser scale without gaining artificial evidence");
        }
    expect(weak > 0 && weak <= 2, "Compaction retains coverage of the nearby weak region");
    ceres::save_spatial_map(fixture.path("roundtrip.cmap"), compacted, pressure_budget);
    const auto first_bytes = bytes(fixture.path("compact.cmap"));
    const auto roundtrip_bytes = bytes(fixture.path("roundtrip.cmap"));
    expect(first_bytes.size() == roundtrip_bytes.size() &&
               std::equal(first_bytes.begin() + ceres::spatial_map_header_bytes, first_bytes.end(),
                          roundtrip_bytes.begin() + ceres::spatial_map_header_bytes),
           "Mixed cell sizes, confidence and independent support survive a byte-exact record roundtrip");

    auto signed_map = original;
    for (auto& sample : signed_map.points) {
        sample.x -= .127f;
        sample.y -= .014f;
        sample.z = -.037f;
    }
    ceres::save_spatial_map(fixture.path("signed.cmap"), signed_map, pressure_budget);
    const auto aligned = ceres::load_spatial_map(fixture.path("signed.cmap"), pressure_budget).map;
    expect(std::count_if(aligned.points.begin(), aligned.points.end(), [](const auto& sample) {
        return sample.confidence > .9f && sample.cell_size == .01f;
    }) == 8, "Signed, non-aligned map extrema preserve the confident region's fine samples");
    for (const auto& coarse : aligned.points) {
        if (coarse.confidence >= .5f)
            continue;
        for (const auto& fine : aligned.points) {
            if (fine.confidence <= .9f)
                continue;
            const auto key = [&](float coordinate) {
                return std::floor(coordinate * (1.f / coarse.cell_size));
            };
            expect(key(coarse.x) != key(fine.x) || key(coarse.y) != key(fine.y) || key(coarse.z) != key(fine.z),
                   "A saved weak ancestor cannot cover a separate confident cell on the canonical world grid");
        }
    }
}
void colour_provenance() {
    Fixture fixture;
    auto original = map();
    original.points[0] = point(0, 1100000, 2);
    original.points[0].r = 1;
    original.points[0].g = original.points[0].b = 0;
    original.points[1] = point(.01f, 1200000, 6);
    original.points[1].flags = 0;
    original.points[1].r = 0;
    original.points[1].g = original.points[1].b = 1;
    const auto budget = ceres::spatial_map_header_bytes + ceres::spatial_map_record_bytes;
    ceres::save_spatial_map(fixture.path(), original, budget);
    const auto result = ceres::load_spatial_map(fixture.path(), budget).map.points.front();
    expect(near(result.x, .0075f) && result.weight == 6 && result.r == 1 && result.g == 0 && result.b == 0,
           "Geometry uses all evidence, colour uses measured RGB and support is not manufactured by merging");
    original.generation = 2;
    for (auto& value : original.points)
        value.flags = 0;
    ceres::save_spatial_map(fixture.path(), original, budget);
    const auto neutral = ceres::load_spatial_map(fixture.path(), budget).map.points.front();
    expect(neutral.flags == 0 && neutral.r == 0 && neutral.g == 0 && neutral.b == 0,
           "Unmeasured display colours are not persisted as captured colour");
}
void replacement_and_removal() {
    Fixture fixture;
    auto original = map();
    ceres::save_spatial_map(fixture.path(), original);
    auto reduced = map(2);
    reduced.points.resize(1);
    ceres::save_spatial_map(fixture.path(), reduced);
    expect(ceres::load_spatial_map(fixture.path()).map.points.size() == 1,
           "A complete newer snapshot preserves explicit geometry removal");
    rejects([&] { ceres::save_spatial_map(fixture.path(), original); }, "Older generations cannot restore removed points");
    auto foreign = reduced;
    foreign.world_id = "different-world";
    rejects([&] { ceres::save_spatial_map(fixture.path(), foreign); }, "Another tracking world cannot replace the map");
    reduced.generation = 3;
    reduced.points.clear();
    ceres::save_spatial_map(fixture.path(), reduced);
    expect(ceres::load_spatial_map(fixture.path()).map.points.empty(), "An empty snapshot clears all saved geometry");
}
void changed_time_origin_replacement() {
    Fixture fixture;
    ceres::save_spatial_map(fixture.path(), map());
    auto replacement = map(2);
    replacement.time_origin_us = 2000000;
    replacement.points = {point(3.5f, 2100000)};
    ceres::save_spatial_map(fixture.path(), replacement);
    const auto restored = ceres::load_spatial_map(fixture.path()).map;
    expect(restored.generation == 2 && restored.time_origin_us == 2000000 &&
               restored.points.size() == 1 && restored.points.front().x == 3.5f &&
               restored.points.front().observed_us == 2100000,
           "A new observation clock origin does not change the tracking world or retain old geometry");
    for (unsigned identity = 0; identity < 3; ++identity) {
        auto foreign = replacement;
        foreign.generation = 3;
        if (identity == 0)
            foreign.source = ceres::SpatialMapSource::stereo;
        else if (identity == 1)
            ++foreign.epoch;
        else
            ++foreign.space_epoch;
        rejects([&] { ceres::save_spatial_map(fixture.path(), foreign); },
                "Source and tracking epochs still identify the saved world");
    }
    replacement.generation = 3;
    replacement.time_origin_us = 3000000;
    replacement.points = {point(-4.f, 3100000)};
    ceres::save_spatial_map(fixture.path("new-clock.cmap"), replacement);
    write(fixture.path().string() + ".pending", bytes(fixture.path("new-clock.cmap")));
    const auto recovered = ceres::load_spatial_map(fixture.path());
    expect(recovered.info.recovered_pending && recovered.map.generation == 3 &&
               recovered.map.time_origin_us == 3000000 && recovered.map.points.size() == 1 &&
               recovered.map.points.front().observed_us == 3100000,
           "Pending recovery accepts a newer clock origin in the same tracking world");
}
void bounded_worker_load() {
    Fixture fixture;
    auto original = map();
    original.source = ceres::SpatialMapSource::stereo;
    original.base_voxel_size = .01f;
    original.points.clear();
    constexpr unsigned region_points = 257 * 257;
    original.points.reserve(4 * region_points);
    for (unsigned region = 0; region < 4; ++region) {
        const float offset = -150.f + 100.f * region;
        for (unsigned i = 0; i < region_points; ++i) {
            auto sample = point(offset + .02f * float(i % 257), 1100000 + 100000 * region, 1);
            sample.y = .02f * float(i / 257);
            original.points.push_back(sample);
        }
    }
    expect(original.points.size() > 262144, "Load fixture exceeds the GPU surface cache capacity");
    ceres::save_spatial_map(fixture.path(), original);
    const auto original_bytes = bytes(fixture.path());
    ceres::SpatialMapStore loader(fixture.path());
    rejects([&] { loader.request_load(std::numeric_limits<std::size_t>::max()); },
            "A load point limit cannot overflow its byte budget");
    loader.request_load(32);
    loader.flush();
    const auto status = loader.status();
    const auto loaded = loader.take_loaded();
    expect(status.error.empty() && loaded && loaded->points.size() <= 32,
           "The worker coarsens a valid larger map before publishing the bounded result");
    expect(loaded->world_id == original.world_id && loaded->source == original.source &&
               loaded->epoch == original.epoch && loaded->space_epoch == original.space_epoch &&
               loaded->generation == original.generation && loaded->time_origin_us == original.time_origin_us &&
               loaded->base_voxel_size == original.base_voxel_size,
           "Bounded loading preserves source identity and acquisition resolution");
    std::array<std::uint64_t, 4> counts{};
    std::array<double, 4> min_x, min_y, max_x, max_y;
    min_x.fill(std::numeric_limits<double>::infinity());
    min_y.fill(std::numeric_limits<double>::infinity());
    max_x.fill(-std::numeric_limits<double>::infinity());
    max_y.fill(-std::numeric_limits<double>::infinity());
    for (const auto& sample : loaded->points) {
        const auto region = sample.x < -100 ? 0u : sample.x < 0 ? 1u : sample.x < 100 ? 2u : 3u;
        ++counts[region];
        min_x[region] = std::min(min_x[region], double(sample.x) - sample.cell_size);
        min_y[region] = std::min(min_y[region], double(sample.y) - sample.cell_size);
        max_x[region] = std::max(max_x[region], double(sample.x) + sample.cell_size);
        max_y[region] = std::max(max_y[region], double(sample.y) + sample.cell_size);
        expect(sample.observed_us == 1100000 + 100000 * region && near(sample.confidence, .75f) &&
                   sample.weight == 1 &&
                   sample.flags == ceres::spatial_map_intrinsic_rgb && near(sample.r, .8f) &&
                   near(sample.g, .2f) && near(sample.b, .1f),
               "Bounded loading retains observation times, support, confidence and measured colour");
    }
    for (unsigned region = 0; region < 4; ++region)
        expect(counts[region] > 0 && min_x[region] <= -150. + 100. * region + .001 &&
                   max_x[region] >= -150. + 100. * region + 5.119 && min_y[region] <= .001 && max_y[region] >= 5.119,
               "Progressive load coarsening preserves the coverage of every separated region");
    expect(status.file.bytes == original_bytes.size() && status.file.stored_points == original.points.size() &&
               bytes(fixture.path()) == original_bytes,
           "Bounded loading leaves the original file and its reported size unchanged");
    loader.request_load();
    loader.flush();
    const auto complete = loader.take_loaded();
    expect(complete && complete->points.size() == original.points.size(),
           "The default load request still returns every stored point");
}
void malformed_files_and_limits() {
    Fixture fixture;
    ceres::save_spatial_map(fixture.path(), map());
    const auto valid = bytes(fixture.path());
    rejects([&] { ceres::load_spatial_map(fixture.path(), 304); }, "File size is capped before payload allocation");
    for (const auto length : {std::size_t(0), std::size_t(255), valid.size() - 1}) {
        write(fixture.path(), {valid.begin(), valid.begin() + length});
        rejects([&] { ceres::load_spatial_map(fixture.path()); }, "Truncated maps are rejected");
    }
    auto damaged = valid;
    damaged.back() ^= 1;
    write(fixture.path(), damaged);
    rejects([&] { ceres::load_spatial_map(fixture.path()); }, "Payload corruption is rejected");
    damaged = valid;
    for (unsigned i = 24; i < 32; ++i)
        damaged[i] = 255;
    repair_header_crc(damaged);
    write(fixture.path(), damaged);
    rejects([&] { ceres::load_spatial_map(fixture.path()); }, "Forged point count cannot allocate or overflow");
    write(fixture.path(), valid);
    auto invalid = map(2);
    invalid.points[0].x = std::numeric_limits<float>::infinity();
    rejects([&] { ceres::save_spatial_map(fixture.path(), invalid); }, "Invalid geometry fails before replacing committed data");
    expect(bytes(fixture.path()) == valid, "Rejected saves preserve the committed file byte for byte");
    rejects([&] { ceres::save_spatial_map(fixture.path(), map(), 303); }, "Too-small budget is rejected");
    rejects([&] { ceres::load_spatial_map(fixture.path(), ceres::spatial_map_hard_max_bytes + 1); },
            "Load budget cannot exceed the hard cap");
}
void recovery() {
    Fixture fixture;
    const auto pending = fixture.path("map.cmap.pending");
    ceres::save_spatial_map(fixture.path(), map());
    const auto committed = bytes(fixture.path());
    write(pending, {'t', 'o', 'r', 'n'});
    auto restored = ceres::load_spatial_map(fixture.path());
    expect(restored.map.generation == 1 && !restored.info.recovered_pending &&
               !std::filesystem::exists(pending),
           "A torn pending save is removed without changing the valid committed generation");
    auto newer = map(2);
    newer.points.resize(1);
    ceres::save_spatial_map(fixture.path("newer.cmap"), newer);
    std::filesystem::copy_file(fixture.path("newer.cmap"), pending);
    restored = ceres::load_spatial_map(fixture.path());
    expect(restored.map.generation == 2 && restored.map.points.size() == 1 &&
               restored.info.recovered_pending && !std::filesystem::exists(pending),
           "A fully flushed pending generation is recovered atomically");
    write(pending, committed);
    expect(ceres::load_spatial_map(fixture.path()).map.generation == 2 && !std::filesystem::exists(pending),
           "An older pending generation cannot roll back committed removal");
    write(fixture.path(), {'b', 'a', 'd'});
    std::filesystem::copy_file(fixture.path("newer.cmap"), pending);
    expect(ceres::load_spatial_map(fixture.path()).info.recovered_pending,
           "A valid pending generation recovers an invalid committed file");
    std::filesystem::create_directory(pending);
    newer.generation = 3;
    rejects([&] { ceres::save_spatial_map(fixture.path(), newer); }, "Pending directories are never overwritten or recursively deleted");
    expect(std::filesystem::is_directory(pending) && ceres::load_spatial_map(fixture.path()).map.generation == 2,
           "A pending-path failure keeps committed data intact");
    ceres::save_spatial_map(fixture.path("restart.cmap"), map());
    std::filesystem::copy_file(fixture.path("newer.cmap"), fixture.path("restart.cmap.pending"));
    rejects([&] { ceres::save_spatial_map(fixture.path("restart.cmap"), map()); },
            "A save cannot overwrite a newer recoverable pending generation");
    expect(ceres::load_spatial_map(fixture.path("restart.cmap")).map.generation == 2,
           "Save-side recovery preserves the last complete generation after restart");
}
void asynchronous_latest_snapshot() {
    Fixture fixture;
    {
        ceres::SpatialMapStore store(fixture.path());
        for (unsigned generation = 1; generation <= 100; ++generation) {
            auto snapshot = std::make_shared<ceres::SpatialMapSnapshot>(map(generation));
            if (generation == 100)
                snapshot->points.resize(1);
            expect(store.submit(std::move(snapshot)), "Submit a complete immutable snapshot");
        }
        const auto queued = store.status();
        expect(queued.busy || queued.saved_generation == 100,
               "Queued saves remain busy until the final generation is committed");
        store.flush();
        const auto status = store.status();
        expect(status.error.empty() && !status.busy && status.saved_generation == 100,
               "A flush waits for the latest accepted generation");
        expect(ceres::load_spatial_map(fixture.path()).map.points.size() == 1,
               "Latest-wins asynchronous saves do not resurrect removed points");
        expect(!store.submit(std::make_shared<ceres::SpatialMapSnapshot>(map(99))),
               "A stale queued generation is rejected");
        expect(store.submit(std::make_shared<ceres::SpatialMapSnapshot>(map(101))),
               "Accept fresh geometry before reducing the storage budget");
        store.flush();
        store.set_max_bytes(304);
        store.flush();
        expect(store.status().error.empty() && store.status().file.bytes <= 304 &&
                   store.status().file.input_points == 2 && store.status().file.stored_points == 1,
               "Budget adjustment resaves the latest complete snapshot");
        store.request_load();
        store.flush();
        const auto loaded = store.take_loaded();
        expect(loaded && loaded->generation == 101 && !store.take_loaded(),
               "Asynchronous load transfers one immutable result");
        auto last = std::make_shared<ceres::SpatialMapSnapshot>(map(102));
        last->points.clear();
        expect(store.submit(last), "Submit final shutdown generation");
    }
    expect(ceres::load_spatial_map(fixture.path()).map.points.empty(),
           "Shutdown drains the final accepted save");
    write(fixture.path("not-a-directory"), {'x'});
    ceres::SpatialMapStore failing(fixture.path("not-a-directory") / "map.cmap");
    failing.submit(std::make_shared<ceres::SpatialMapSnapshot>(map()));
    failing.flush();
    expect(!failing.status().error.empty() && !failing.status().busy,
           "Worker I/O errors are reported without escaping or deadlocking the caller");
    expect(std::filesystem::remove(fixture.path("not-a-directory")), "Remove the test I/O obstruction");
    std::filesystem::create_directory(fixture.path("not-a-directory"));
    expect(failing.submit(std::make_shared<ceres::SpatialMapSnapshot>(map())),
           "Retry accepts the same generation after a transient I/O failure");
    failing.flush();
    expect(failing.status().error.empty() && failing.status().saved_generation == 1,
           "The same-generation retry commits after I/O recovers");
}
void retired_snapshot_recovery() {
    Fixture fixture;
    ceres::save_spatial_map(fixture.path("source.cmap"), map());
    const auto original = bytes(fixture.path("source.cmap"));
    const auto directory = fixture.path("temporarily-unavailable");
    write(directory, {'x'});
    const auto destination = directory / "placed.cmap";
    ceres::SpatialMapStore retired(destination);
    auto final = std::make_shared<ceres::SpatialMapSnapshot>(map(2));
    final->points.resize(1);
    final->points[0].x = 7.5f;
    expect(retired.submit(final), "Queue the final fused geometry before retiring the map");
    final.reset();
    wait_until([&] { return !retired.status().error.empty(); }, "Observe the first failed write");
    expect(retired.status().busy && !retired.retry_save(),
           "A retained failed snapshot remains busy and cannot restart its scheduled retry");
    expect(std::filesystem::remove(directory), "Remove the transient filesystem obstruction");
    std::filesystem::create_directory(directory);
    wait_until([&] {
        const auto status = retired.status();
        return !status.busy && status.saved_generation == 2;
    }, "A retired store retries its final snapshot without another submission or flush");
    const auto restored = ceres::load_spatial_map(destination).map;
    expect(retired.status().error.empty() && restored.generation == 2 && restored.points.size() == 1 &&
               near(restored.points[0].x, 7.5f),
           "Recovery writes the final fused geometry without resurrecting older points");
    expect(bytes(fixture.path("source.cmap")) == original, "Retry leaves the selected source file unchanged");
    expect(!retired.retry_save(), "A successful retired store has no failed save to retry");

    const auto shutdown_directory = fixture.path("closing");
    write(shutdown_directory, {'x'});
    {
        ceres::SpatialMapStore closing(shutdown_directory / "placed.cmap");
        closing.submit(std::make_shared<ceres::SpatialMapSnapshot>(map(3)));
        wait_until([&] { return !closing.status().error.empty(); }, "Schedule a retry before shutdown");
        expect(std::filesystem::remove(shutdown_directory), "Restore storage before shutdown");
        std::filesystem::create_directory(shutdown_directory);
    }
    expect(ceres::load_spatial_map(shutdown_directory / "placed.cmap").map.generation == 3,
           "Shutdown drains a scheduled retry without waiting for the backoff delay");
}
void exhausted_snapshot_recovery() {
    Fixture fixture;
    std::array<std::filesystem::path, 2> directories{fixture.path("manual"), fixture.path("shutdown")};
    std::array<std::unique_ptr<ceres::SpatialMapStore>, 2> retired;
    for (std::size_t i = 0; i < retired.size(); ++i) {
        write(directories[i], {'x'});
        retired[i] = std::make_unique<ceres::SpatialMapStore>(directories[i] / "placed.cmap");
        auto final = std::make_shared<ceres::SpatialMapSnapshot>(map(static_cast<unsigned>(i + 1)));
        final->points.resize(i + 1);
        expect(retired[i]->submit(final), "Queue a final snapshot for an unavailable destination");
    }
    wait_until([&] {
        return std::all_of(retired.begin(), retired.end(), [](const auto& store) {
            const auto status = store->status();
            return !status.busy && !status.error.empty();
        });
    }, "Persistent failures exhaust their bounded retries without spinning indefinitely");
    for (std::size_t i = 0; i < retired.size(); ++i) {
        const auto status = retired[i]->status();
        expect(status.saved_generation == 0 && status.submitted_generation == i + 1 && !status.error.empty(),
               "An exhausted retry cycle retains the final generation and a visible storage error");
        expect(std::filesystem::remove(directories[i]), "Restore the destination after retry exhaustion");
        std::filesystem::create_directory(directories[i]);
    }
    expect(retired[0]->retry_save(), "Save map now can retry a retired snapshot after its automatic cycle");
    retired[0]->flush();
    retired[1]->flush();
    for (std::size_t i = 0; i < retired.size(); ++i) {
        const auto status = retired[i]->status();
        const auto restored = ceres::load_spatial_map(directories[i] / "placed.cmap").map;
        expect(!status.busy && status.error.empty() && status.saved_generation == i + 1 &&
                   restored.generation == i + 1 && restored.points.size() == i + 1,
               "Explicit retry and shutdown flush both recover retired snapshots after filesystem recovery");
    }
    const auto load_path = fixture.path("missing-source.cmap");
    ceres::save_spatial_map(load_path, map());
    ceres::SpatialMapStore loader(load_path);
    loader.request_load();
    loader.flush();
    expect(loader.take_loaded() != nullptr && std::filesystem::remove(load_path),
           "Load a source before it becomes unavailable");
    loader.request_load();
    loader.flush();
    expect(!loader.status().error.empty() && !loader.retry_save() &&
               !std::filesystem::exists(load_path),
           "A failed source load is never retried as a save");
}
void retry_preserves_submitted_snapshot() {
    Fixture fixture;
    ceres::save_spatial_map(fixture.path(), map());
    const auto obstruction = fixture.path("map.cmap.pending");
    std::filesystem::create_directory(obstruction);
    ceres::SpatialMapStore store(fixture.path());
    auto revised = std::make_shared<ceres::SpatialMapSnapshot>(map());
    revised->points[0].x = 7.5f;
    expect(store.submit(revised), "Queue revised geometry before a readback");
    wait_until([&] { return !store.status().error.empty(); }, "Observe the failed revised save");
    store.request_load(1);
    std::shared_ptr<const ceres::SpatialMapSnapshot> loaded;
    wait_until([&] { return bool(loaded = store.take_loaded()); }, "Read the previous committed map during backoff");
    expect(loaded->points.size() == 1 && !store.status().error.empty(),
           "A coarsened readback keeps the failed save and its error intact");
    expect(std::filesystem::remove(obstruction), "Allow the retained revised snapshot to be written");
    store.flush();
    const auto restored = ceres::load_spatial_map(fixture.path()).map;
    expect(store.status().error.empty() && restored.points.size() == 2 && near(restored.points[0].x, 7.5f),
           "A retry writes submitted geometry rather than the coarsened map returned by a load");

    const auto directory = fixture.path("newer-generation");
    write(directory, {'x'});
    ceres::SpatialMapStore newer(directory / "placed.cmap");
    expect(newer.submit(std::make_shared<ceres::SpatialMapSnapshot>(map())), "Queue an older generation");
    wait_until([&] { return !newer.status().error.empty(); }, "Schedule a retry of the older generation");
    auto final = std::make_shared<ceres::SpatialMapSnapshot>(map(2));
    final->points.resize(1);
    expect(newer.submit(final), "A newer generation supersedes a scheduled retry");
    expect(std::filesystem::remove(directory), "Restore storage for the newer generation");
    std::filesystem::create_directory(directory);
    newer.flush();
    expect(ceres::load_spatial_map(directory / "placed.cmap").map.points.size() == 1 &&
               newer.status().saved_generation == 2,
           "A cancelled older retry cannot restore points removed by the final generation");
}
ceres::SpatialMapSnapshot managed_map(unsigned serial, bool stereo = false, unsigned generation = 1) {
    auto snapshot = map(generation);
    snapshot.world_id = "1000000-" + std::to_string(serial);
    snapshot.source = stereo ? ceres::SpatialMapSource::stereo : ceres::SpatialMapSource::environment_depth;
    return snapshot;
}
std::filesystem::path managed_path(const Fixture& fixture, unsigned serial, bool stereo = false) {
    return fixture.root / ("1000000-" + std::to_string(serial) + (stereo ? "-stereo.cmap" : "-quest.cmap"));
}
void save_managed(const Fixture& fixture, unsigned serial, bool stereo = false, std::size_t history = 3) {
    ceres::SpatialMapStore store(managed_path(fixture, serial, stereo), ceres::spatial_map_default_max_bytes, history);
    expect(store.submit(std::make_shared<ceres::SpatialMapSnapshot>(managed_map(serial, stereo))),
           "Queue a managed autosave");
    store.flush();
    expect(store.status().error.empty(), "Managed autosave and history cleanup complete");
}
void managed_history_retention() {
    Fixture fixture;
    ceres::save_spatial_map(fixture.path("original.cmap"), map());
    const auto original = bytes(fixture.path("original.cmap"));
    ceres::save_spatial_map(fixture.path("holiday-1-quest.cmap"), map());
    ceres::save_spatial_map(fixture.path("2000000-1-quest.cmap"), map());
    auto wrong_source = managed_map(90, true);
    ceres::save_spatial_map(managed_path(fixture, 90), wrong_source);
    const auto wrong_source_bytes = bytes(managed_path(fixture, 90));
    const std::vector<unsigned char> invalid{'n', 'o', 't', '-', 'a', '-', 'm', 'a', 'p'};
    write(fixture.path("3000000-1-quest.cmap"), invalid);
    const auto linked = managed_path(fixture, 91);
    const auto linked_target = fixture.path("linked-original.cmap");
    ceres::save_spatial_map(linked_target, managed_map(91));
    const auto target_bytes = bytes(linked_target);
    std::filesystem::create_symlink(linked_target, linked);
    const auto old_time = std::filesystem::file_time_type::clock::now() - std::chrono::hours(24);
    for (unsigned index = 0; index < 6; ++index) {
        const unsigned serial = index / 2 + 1;
        const bool stereo = index % 2 != 0;
        save_managed(fixture, serial, stereo);
        std::filesystem::last_write_time(managed_path(fixture, serial, stereo), old_time + std::chrono::seconds(index));
    }
    for (unsigned index = 0; index < 6; ++index)
        expect(std::filesystem::exists(managed_path(fixture, index / 2 + 1, index % 2 != 0)) == (index >= 3),
               "History keeps the three most recent map files across Quest and stereo together");
    expect(bytes(fixture.path("original.cmap")) == original &&
               bytes(fixture.path("holiday-1-quest.cmap")) == original &&
               bytes(fixture.path("2000000-1-quest.cmap")) == original &&
               bytes(fixture.path("3000000-1-quest.cmap")) == invalid &&
               bytes(managed_path(fixture, 90)) == wrong_source_bytes,
           "Retention preserves user files, invalid headers and mismatched identities");
    expect(std::filesystem::is_symlink(std::filesystem::symlink_status(linked)) && bytes(linked_target) == target_bytes,
           "Retention does not follow or remove a map symlink or change its target");
    rejects([&] { ceres::SpatialMapStore invalid_store(fixture.path("original.cmap"),
                                                      ceres::spatial_map_default_max_bytes, 3); },
            "Managed retention cannot be enabled for an arbitrary filename");
    ceres::SpatialMapStore mismatch(managed_path(fixture, 92), ceres::spatial_map_default_max_bytes, 3);
    mismatch.submit(std::make_shared<ceres::SpatialMapSnapshot>(map()));
    mismatch.flush();
    expect(!mismatch.status().error.empty() && !std::filesystem::exists(managed_path(fixture, 92)),
           "Managed saves reject a filename and world metadata mismatch before writing");
}
void managed_history_failure_and_recovery() {
    Fixture fixture;
    for (unsigned serial = 1; serial <= 4; ++serial)
        save_managed(fixture, serial, false, 0);
    const auto failed_path = managed_path(fixture, 5);
    std::filesystem::create_directory(failed_path.string() + ".pending");
    ceres::SpatialMapStore failing(failed_path, ceres::spatial_map_default_max_bytes, 3);
    failing.submit(std::make_shared<ceres::SpatialMapSnapshot>(managed_map(5)));
    failing.flush();
    expect(!failing.status().error.empty() && !std::filesystem::exists(failed_path),
           "The obstructed autosave fails before a committed map appears");
    for (unsigned serial = 1; serial <= 4; ++serial)
        expect(std::filesystem::exists(managed_path(fixture, serial)), "A failed save never prunes existing history");
    expect(std::filesystem::is_directory(failed_path.string() + ".pending"),
           "A pending directory is not removed by history cleanup");
    auto newer = managed_map(4, false, 2);
    newer.points.resize(1);
    ceres::save_spatial_map(fixture.path("recovery-template.cmap"), newer);
    write(managed_path(fixture, 4).string() + ".pending", bytes(fixture.path("recovery-template.cmap")));
    auto orphan = managed_map(6, true);
    ceres::save_spatial_map(fixture.path("orphan-template.cmap"), orphan);
    write(managed_path(fixture, 6, true).string() + ".pending", bytes(fixture.path("orphan-template.cmap")));
    write(managed_path(fixture, 3).string() + ".pending", {'t', 'o', 'r', 'n'});
    const auto old = std::filesystem::file_time_type::clock::now() - std::chrono::hours(24);
    for (unsigned serial = 1; serial <= 4; ++serial)
        std::filesystem::last_write_time(managed_path(fixture, serial), old + std::chrono::seconds(serial));
    save_managed(fixture, 7);
    expect(ceres::load_spatial_map(managed_path(fixture, 4)).map.generation == 2 &&
               ceres::load_spatial_map(managed_path(fixture, 6, true)).map.world_id == orphan.world_id &&
               std::filesystem::exists(managed_path(fixture, 7)),
           "History recovers complete pending generations before retaining the three newest maps");
    for (unsigned serial : {1u, 2u, 3u})
        expect(!std::filesystem::exists(managed_path(fixture, serial)), "Recovered history prunes only older committed maps");
    expect(!std::filesystem::exists(managed_path(fixture, 3).string() + ".pending") &&
               !std::filesystem::exists(managed_path(fixture, 4).string() + ".pending") &&
               !std::filesystem::exists(managed_path(fixture, 6, true).string() + ".pending"),
           "Torn managed pending data is cleaned and complete pending saves are promoted");
}
void protected_managed_history() {
    Fixture fixture;
    const auto old = std::filesystem::file_time_type::clock::now() - std::chrono::hours(24);
    for (unsigned serial = 1; serial <= 4; ++serial) {
        save_managed(fixture, serial, false, 0);
        std::filesystem::last_write_time(managed_path(fixture, serial), old + std::chrono::seconds(serial));
    }
    const auto source = managed_path(fixture, 1);
    const auto original = bytes(source);
    auto first = std::make_unique<ceres::SpatialMapFileProtection>(source);
    auto alias = source.parent_path() / "." / source.filename();
#ifdef _WIN32
    auto spelling = alias.native();
    std::transform(spelling.begin(), spelling.end(), spelling.begin(),
                   [](wchar_t ch) { return static_cast<wchar_t>(std::towupper(ch)); });
    alias = std::move(spelling);
#endif
    auto second = std::make_unique<ceres::SpatialMapFileProtection>(alias);
    save_managed(fixture, 5);
    expect(bytes(source) == original && !std::filesystem::exists(managed_path(fixture, 2)) &&
               std::filesystem::exists(managed_path(fixture, 3)) &&
               std::filesystem::exists(managed_path(fixture, 4)) &&
               std::filesystem::exists(managed_path(fixture, 5)),
           "A selected source remains unchanged while the three newest unprotected maps are retained");
    first.reset();
    save_managed(fixture, 6);
    expect(bytes(source) == original && !std::filesystem::exists(managed_path(fixture, 3)),
           "Canonical aliases and Windows case variants retain protection until the last lease ends");
    second.reset();
    save_managed(fixture, 7);
    expect(!std::filesystem::exists(source) && !std::filesystem::exists(managed_path(fixture, 4)) &&
               std::filesystem::exists(managed_path(fixture, 5)) &&
               std::filesystem::exists(managed_path(fixture, 6)) &&
               std::filesystem::exists(managed_path(fixture, 7)),
           "Releasing the last source lease restores normal rolling retention");
}
void protected_history_file_identity() {
    Fixture fixture;
    save_managed(fixture, 1, false, 0);
    const auto source = managed_path(fixture, 1);
    const auto alias = fixture.path("selected-alias.cmap");
    std::filesystem::create_hard_link(source, alias);
    const auto original = bytes(source);
    const auto old = std::filesystem::file_time_type::clock::now() - std::chrono::hours(24);
    std::filesystem::last_write_time(source, old);
    {
        ceres::SpatialMapFileProtection lease(alias);
        for (unsigned serial = 2; serial <= 5; ++serial)
            save_managed(fixture, serial);
        expect(bytes(source) == original && bytes(alias) == original &&
                   !std::filesystem::exists(managed_path(fixture, 2)),
               "A source selected through a hard link protects the managed file with the same identity");
    }
    save_managed(fixture, 6);
    expect(!std::filesystem::exists(source) && bytes(alias) == original,
           "Released hard-link protection permits pruning without changing the user alias");
}
void protected_history_skips_pending_recovery() {
    Fixture fixture;
    save_managed(fixture, 1, false, 0);
    const auto source = managed_path(fixture, 1);
    const auto original = bytes(source);
    ceres::save_spatial_map(fixture.path("newer.cmap"), managed_map(1, false, 2));
    const auto newer = bytes(fixture.path("newer.cmap"));
    const auto pending = source.string() + ".pending";
    write(pending, newer);
    std::filesystem::last_write_time(pending,
        std::filesystem::file_time_type::clock::now() + std::chrono::hours(1));
    {
        ceres::SpatialMapFileProtection lease(source);
        for (unsigned serial = 2; serial <= 5; ++serial)
            save_managed(fixture, serial);
        expect(bytes(source) == original && bytes(pending) == newer,
               "History cleanup cannot rewrite a protected source by recovering its pending generation");
    }
    save_managed(fixture, 6);
    expect(!std::filesystem::exists(pending) && ceres::load_spatial_map(source).map.generation == 2,
           "Normal pending recovery resumes after the source lease is released");
}
void concurrent_managed_history() {
    Fixture fixture;
    std::vector<std::unique_ptr<ceres::SpatialMapStore>> stores;
    for (unsigned serial = 1; serial <= 12; ++serial) {
        const bool stereo = serial % 2 != 0;
        auto store = std::make_unique<ceres::SpatialMapStore>(managed_path(fixture, serial, stereo),
                                                           ceres::spatial_map_default_max_bytes, 3);
        expect(store->submit(std::make_shared<ceres::SpatialMapSnapshot>(managed_map(serial, stereo))),
               "Queue concurrent managed writers");
        stores.push_back(std::move(store));
    }
    for (auto& store : stores) {
        store->flush();
        expect(store->status().error.empty(), "Concurrent commits and pruning do not race");
    }
    unsigned count = 0;
    for (const auto& entry : std::filesystem::directory_iterator(fixture.root)) {
        expect(entry.path().extension() == ".cmap", "Concurrent history leaves no pending files");
        expect(!ceres::load_spatial_map(entry.path()).map.points.empty(), "Every retained concurrent map is valid");
        ++count;
    }
    expect(count == 3, "Concurrent autosave writers retain exactly three combined map files");
}
void destination_symlinks_are_preserved() {
    for (const bool dangling : {false, true}) {
        Fixture fixture;
        const auto destination = fixture.path();
        const auto target = fixture.path("original.cmap");
        if (!dangling) ceres::save_spatial_map(target, map());
        const auto original = dangling ? std::vector<unsigned char>{} : bytes(target);
        std::filesystem::create_symlink(target, destination);
        const auto newer = map(2);
        ceres::save_spatial_map(fixture.path("pending-template.cmap"), newer);
        const auto pending_bytes = bytes(fixture.path("pending-template.cmap"));
        const auto pending = destination.string() + ".pending";
        write(pending, pending_bytes);
        rejects([&] { ceres::save_spatial_map(destination, newer); },
                "A save cannot replace an existing or dangling destination symlink");
        rejects([&] { ceres::load_spatial_map(destination); },
                "Pending recovery cannot replace an existing or dangling destination symlink");
        expect(std::filesystem::is_symlink(std::filesystem::symlink_status(destination)) &&
                   bytes(pending) == pending_bytes &&
                   (dangling ? !std::filesystem::exists(target) : bytes(target) == original),
               "Rejected destination links preserve the link, its target and pending recovery data");
    }
}
} // namespace

int main() {
    try {
        portable_roundtrip();
        bounded_coarsening();
        confidence_priority_compaction();
        colour_provenance();
        replacement_and_removal();
        changed_time_origin_replacement();
        bounded_worker_load();
        malformed_files_and_limits();
        recovery();
        asynchronous_latest_snapshot();
        retired_snapshot_recovery();
        exhausted_snapshot_recovery();
        retry_preserves_submitted_snapshot();
        managed_history_retention();
        managed_history_failure_and_recovery();
        protected_managed_history();
        protected_history_file_identity();
        protected_history_skips_pending_recovery();
        concurrent_managed_history();
        destination_symlinks_are_preserved();
        std::cout << "Spatial map storage tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
