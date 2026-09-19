#include "ceres/renderer.hpp"
#include "depth_fixture.hpp"
#include <glad/gl.h>
#include <GLFW/glfw3.h>
#include <cuda_runtime_api.h>
#include <glm/glm.hpp>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/type_ptr.hpp>
#include <algorithm>
#include <array>
#include <chrono>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace {
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
void cuda_check(cudaError_t result) {
    if (result != cudaSuccess)
        throw std::runtime_error(cudaGetErrorString(result));
}
struct Context {
    GLFWwindow* window = nullptr;
    Context() {
        require(glfwInit() != 0, "Cannot initialise GLFW");
        glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
        glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 4);
        glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 5);
        glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
        window = glfwCreateWindow(128, 128, "Spatial map lifecycle checks", nullptr, nullptr);
        require(window != nullptr, "Cannot create OpenGL context");
        glfwMakeContextCurrent(window);
        require(gladLoadGL(glfwGetProcAddress) != 0, "Cannot load OpenGL");
    }
    ~Context() {
        glfwDestroyWindow(window);
        glfwTerminate();
    }
};
ceres::SpatialMapSnapshot fixture(ceres::SpatialMapSource source) {
    ceres::SpatialMapSnapshot map;
    map.source = source;
    map.world_id = "renderer-fixture";
    map.epoch = 7;
    map.space_epoch = 2;
    map.time_origin_us = 1000000;
    map.generation = 42;
    map.base_voxel_size = .03f;
    for (int region : {-1, 1}) {
        for (int y = 0; y < 10; ++y) {
            for (int x = 0; x < 10; ++x) {
                ceres::SpatialMapPoint point;
                point.x = float(region * 60 + x) * .03f + .015f;
                point.y = float(y) * .03f + .015f;
                point.z = -2.025f;
                point.cell_size = .03f;
                point.r = .2f;
                point.g = .4f;
                point.b = .6f;
                point.confidence = 1;
                point.observed_us = 2000000;
                point.weight = 8;
                point.flags = source == ceres::SpatialMapSource::stereo ? ceres::spatial_map_intrinsic_rgb : 0;
                map.points.push_back(point);
            }
        }
    }
    return map;
}
std::shared_ptr<ceres::SpatialMapSnapshot> snapshot(ceres::Renderer& renderer, bool environment,
                                                   const std::string& identity = "renderer-fixture") {
    require(renderer.request_map_snapshot(environment, identity, 7, 2), "Snapshot request was rejected");
    renderer.finish_map_snapshot(environment);
    auto result = renderer.take_map_snapshot(environment);
    require(bool(result), "Finished snapshot was not available");
    return result;
}
ceres::SessionEvent depth_event(uint32_t sequence, int64_t time, uint32_t epoch = 7,
                               uint32_t space_epoch = 2) {
    auto header = depth_fixture::header(sequence, epoch, space_epoch, 32, 32);
    const auto projection = glm::perspective(glm::radians(70.f), 1.f, .1f, 10.f);
    header["projection"] = std::vector<float>(glm::value_ptr(projection), glm::value_ptr(projection) + 16);
    header["observed_us"] = time;
    header["target_us"] = time;
    auto bytes = depth_fixture::encode(header);
    const auto start = bytes.size() - 32 * 32 * 2;
    for (size_t i = 0; i < 32 * 32; ++i)
        depth_fixture::put(bytes, start + i * 2, 2000, 2);
    return ceres::make_depth_event(std::move(bytes), time, {0, 0, 1, true});
}
ceres::VideoFrameLease video_frame(uint32_t sequence, int side, int solid_luma = -1) {
    auto image = std::make_shared<ceres::GpuImage>();
    image->width = 64;
    image->height = 48;
    image->full_range = true;
    require(cuCtxGetCurrent(&image->context) == CUDA_SUCCESS, "Cannot access CUDA context");
    unsigned char* device = nullptr;
    cuda_check(cudaMallocPitch(reinterpret_cast<void**>(&device), &image->pitch,
                               size_t(image->width), size_t(image->height * 3 / 2)));
    image->data = reinterpret_cast<CUdeviceptr>(device);
    std::vector<unsigned char> pixels(size_t(image->width) * image->height * 3 / 2, 128);
    for (int y = 0; y < image->height; ++y)
        for (int x = 0; x < image->width; ++x)
            pixels[size_t(y) * image->width + x] = static_cast<unsigned char>(solid_luma >= 0 ? solid_luma :
                30 + ((x + side * 3) * 37 + y * 73) % 180);
    cuda_check(cudaMemcpy2D(device, image->pitch, pixels.data(), image->width, image->width,
                           image->height * 3 / 2, cudaMemcpyHostToDevice));
    image->event.kind = ceres::EventKind::Video;
    image->event.epoch = 7;
    image->event.space_epoch = 2;
    image->event.sequence = sequence;
    image->event.receive_us = image->event.time_us = 3000000 + sequence * 100000;
    image->event.attributes = {{"head_pose", {0, 0, 0, 0, 0, 0, 1}}};
    return {std::move(image)};
}
std::shared_ptr<ceres::SpatialMapSnapshot> saved_snapshot(ceres::Renderer& renderer) {
    require(renderer.request_saved_map_snapshot(), "Saved map snapshot request was rejected");
    renderer.finish_saved_map_snapshot();
    auto result = renderer.take_saved_map_snapshot();
    require(bool(result), "Completed saved map snapshot was unavailable");
    return result;
}
void require_same_points(const ceres::SpatialMapSnapshot& expected,
                         const ceres::SpatialMapSnapshot& actual, const char* message) {
    require(expected.points.size() == actual.points.size(), message);
    for (const auto& point : expected.points) {
        const auto found = std::find_if(actual.points.begin(), actual.points.end(), [&](const auto& candidate) {
            return std::abs(point.x - candidate.x) < .000001f &&
                   std::abs(point.y - candidate.y) < .000001f &&
                   std::abs(point.z - candidate.z) < .000001f &&
                   point.cell_size == candidate.cell_size && point.weight == candidate.weight &&
                   point.confidence == candidate.confidence && point.observed_us == candidate.observed_us &&
                   point.r == candidate.r && point.g == candidate.g && point.b == candidate.b &&
                   point.flags == candidate.flags;
        });
        require(found != actual.points.end(), message);
    }
}
void check_capacity_growth(ceres::Renderer& renderer) {
    renderer.configure_spatial_map(false, .03f, 256);
    require(renderer.map_point_capacity(true) == 0 && renderer.map_point_capacity(false) == 0 &&
                renderer.saved_map_state().capacity == 0,
            "Selecting a map budget eagerly allocated inactive layers");
    auto imported = fixture(ceres::SpatialMapSource::environment_depth);
    for (auto& point : imported.points) {
        // Real fused samples are not snapped to the nominal voxel centre.
        point.x += .002f;
        point.y -= .001f;
    }
    require(renderer.import_spatial_map(imported), "Capacity fixture import was rejected");
    const auto before = snapshot(renderer, true);
    require(renderer.map_point_capacity(true) == 256 && renderer.map_point_capacity(false) == 0,
            "Initial allocation did not follow the selected active-layer budget");
    require(renderer.request_map_snapshot(true, "before-growth", 7, 2), "Pending growth snapshot was rejected");
    renderer.configure_spatial_map(true, .03f, 1025);
    require(renderer.map_point_capacity(true) == 2048 && renderer.map_point_budget(true) == 1025 &&
                renderer.map_point_capacity(false) == 0,
            "Growing the active map did not honour its budget independently");
    renderer.finish_map_snapshot(true);
    auto pending = renderer.take_map_snapshot(true);
    require(pending && pending->world_id == "before-growth", "Capacity growth discarded a pending snapshot");
    require_same_points(*before, *pending, "Capacity growth changed a pending snapshot's fused evidence");
    require_same_points(*before, *snapshot(renderer, true), "Capacity growth lost fused point positions or metadata");

    require(renderer.load_saved_map(imported), "Saved capacity fixture import was rejected");
    require(renderer.place_saved_map(glm::mat4(1.f), 7, 2, 3000000), "Saved capacity fixture placement failed");
    const auto placed = saved_snapshot(renderer);
    require(renderer.request_saved_map_snapshot(), "Pending saved growth snapshot was rejected");
    renderer.configure_spatial_map(true, .03f, 8193);
    const auto grown = renderer.saved_map_state();
    require(grown.loaded && grown.placed && grown.capacity == 16384 && grown.point_budget == 8193 &&
                renderer.map_point_capacity(false) == 0,
            "Saved-map growth changed placement or eagerly allocated the stereo layer");
    renderer.finish_saved_map_snapshot();
    const auto pending_saved = renderer.take_saved_map_snapshot();
    require(bool(pending_saved), "Saved-map growth discarded its pending readback");
    require_same_points(*placed, *pending_saved, "Saved-map growth changed pending fused evidence");
    require_same_points(*placed, *saved_snapshot(renderer), "Saved-map growth changed placed geometry");
    renderer.clear_saved_map();

    renderer.configure_spatial_map(true, .03f, 262145);
    require(renderer.map_point_capacity(true) == 524288 && renderer.map_point_budget(true) == 262145 &&
                renderer.map_point_capacity(false) == 0,
            "Selected capacity remained capped at 262144 points");
    require_same_points(*before, *snapshot(renderer, true), "Large-budget growth lost retained evidence");
    renderer.configure_spatial_map(true, .03f, 256);
    require_same_points(*before, *snapshot(renderer, true), "A sufficient smaller budget flattened retained evidence");
    renderer.clear_environment_depth(true);
    renderer.configure_spatial_map(false, .03f, 262144);
}
void check_compacted_map_restore(ceres::Renderer& renderer) {
    auto map = fixture(ceres::SpatialMapSource::environment_depth);
    map.base_voxel_size = .01f;
    map.points.clear();
    for (int region = 0; region < 2; ++region)
        for (int i = 0; i < 8; ++i) {
            ceres::SpatialMapPoint point;
            point.x = .001f + .16f * region + .02f * (i % 4) - .127f;
            point.y = .001f + .02f * (i / 4) - .014f;
            point.z = -.037f;
            point.cell_size = .01f;
            point.confidence = region == 0 ? .95f : .2f;
            point.weight = region == 0 ? 8 : 1;
            point.observed_us = 2000000;
            map.points.push_back(point);
        }
    struct TemporaryMap {
        std::filesystem::path path = std::filesystem::temp_directory_path() /
            ("ceres-confidence-roundtrip-" + std::to_string(ceres::monotonic_us()) + ".cmap");
        ~TemporaryMap() {
            std::error_code error;
            std::filesystem::remove(path, error);
            std::filesystem::remove(path.string() + ".pending", error);
        }
    } temporary;
    const auto limit = ceres::spatial_map_header_bytes + 10 * ceres::spatial_map_record_bytes;
    ceres::save_spatial_map(temporary.path, map, limit);
    const auto loaded = ceres::load_spatial_map(temporary.path, limit);
    require(loaded.map.points.size() <= 10, "Mixed-confidence map did not honour its saved-file budget");
    const auto fine = std::count_if(loaded.map.points.begin(), loaded.map.points.end(), [](const auto& point) {
        return point.confidence > .9f && point.cell_size == .01f;
    });
    require(fine == 8, "Saved-file pressure flattened the established region before the weak region");
    renderer.configure_spatial_map(true, .01f, 1024);
    require(renderer.import_spatial_map(loaded.map), "Mixed-confidence saved map was rejected by the GPU");
    require_same_points(loaded.map, *snapshot(renderer, true),
                        "GPU restore changed signed, non-aligned fine/coarse confidence regions");
    renderer.clear_environment_depth(true);
    renderer.configure_spatial_map(false, .03f, 262144);
}
void check_confidence_detail(ceres::Renderer& renderer) {
    renderer.reset_view();
    renderer.invalidate_poses();
    renderer.clear_saved_map();
    renderer.configure_spatial_map(true, .03f, 4096);
    auto map = fixture(ceres::SpatialMapSource::environment_depth);
    map.points.clear();
    for (int region = 0; region < 2; ++region)
        for (int y = 0; y < 16; ++y)
            for (int x = 0; x < 16; ++x) {
                ceres::SpatialMapPoint point;
                point.x = (region == 0 ? -.585f : .135f) + float(x) * .03f;
                point.y = -.225f + float(y) * .03f;
                point.z = -2.025f;
                point.cell_size = .03f;
                point.confidence = region == 0 ? 1.f : .2f;
                point.weight = region == 0 ? 16 : 1;
                point.observed_us = 2000000;
                map.points.push_back(point);
            }
    require(renderer.import_spatial_map(map), "Confidence display fixture was rejected");
    const auto retained = snapshot(renderer, true);
    ceres::ReceiverSnapshot receiver;
    receiver.epoch = 7;
    receiver.space_epoch = 2;
    receiver.now_us = 2000000;
    receiver.clock.valid = true;
    ceres::PoseSample head;
    head.valid = true;
    head.epoch = 7;
    head.space_epoch = 2;
    head.received_us = head.observed_us = receiver.now_us;
    head.values[6] = 1;
    receiver.poses[0] = head;
    ceres::ViewOptions options;
    options.hands = options.trails = options.grid = options.frusta = options.headset = options.projection = false;
    options.depth = false;
    options.environment_depth = options.map_frozen = true;
    options.point_size = options.depth_opacity = 1;
    options.map_shader = ceres::SpatialMapShader::neutral;
    options.map_style = ceres::SpatialMapStyle::points;
    using Pixel = std::array<unsigned char, 4>;
    const auto draw = [&] {
        renderer.update_headset_position(receiver);
        renderer.draw(receiver, ceres::Calibration{}, options);
        renderer.finish_frame();
        cuda_check(cudaDeviceSynchronize());
        std::vector<Pixel> pixels(128 * 128);
        glReadPixels(0, 0, 128, 128, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        return pixels;
    };
    draw();
    require(renderer.select_scene_view(ceres::SceneView::hmd), "Confidence fixture HMD view was unavailable");
    const auto empty = draw();
    options.depth = true;
    draw();
    const auto detail = draw();
    const auto regional_coverage = [&](const auto& pixels) {
        std::array<size_t, 2> result{};
        for (int y = 0; y < 128; ++y)
            for (int x = 0; x < 128; ++x)
                result[x < 64 ? 0 : 1] += pixels[size_t(y) * 128 + x] != empty[size_t(y) * 128 + x];
        return result;
    };
    const auto counts = regional_coverage(detail);
    require(counts[0] >= 240 && counts[1] > 0 && counts[0] > counts[1] * 3,
            "Adaptive detail flattened reliable and tentative regions to the same density");
    require(renderer.select_scene_view(ceres::SceneView::iso), "Confidence fixture orbit view was unavailable");
    std::this_thread::sleep_for(std::chrono::milliseconds(55));
    draw();
    draw();
    require(renderer.select_scene_view(ceres::SceneView::hmd), "Confidence fixture could not return to HMD view");
    std::this_thread::sleep_for(std::chrono::milliseconds(55));
    draw();
    require(regional_coverage(draw()) == counts,
            "Returning to an established region did not restore its confidence detail");
    require_same_points(*retained, *snapshot(renderer, true),
                        "Camera-dependent display aggregation changed the retained confidence map");
    renderer.clear_environment_depth(true);
    renderer.reset_view();
    renderer.configure_spatial_map(false, .03f, 262144);
}
void check_update_cadence(ceres::Renderer& renderer) {
    renderer.clear_environment_depth(true);
    renderer.configure_spatial_map(false, .03f, 4096);
    require(renderer.map_update_interval(true) == 0, "A cleared map retained an old fade cadence");
    uint32_t sequence = 0;
    const auto observe = [&](int64_t time, float expected_interval) {
        require(renderer.update_environment_depth(depth_event(++sequence, time), .2f, 5.f, .03f, time),
                "Cadence fixture observation was rejected");
        cuda_check(cudaDeviceSynchronize());
        require(std::abs(renderer.map_update_interval(true) - expected_interval) < .00001f,
                "New-data fade cadence did not follow independent source observations");
    };
    observe(1000000, .1f);
    observe(1100000, .1f);
    observe(1350000, .25f);
    observe(3350000, .25f); // One pause keeps the preceding cadence.
    observe(3600000, .25f);
    observe(5100000, .25f);
    observe(6600000, 1.5f); // Repeated slow observations establish a new rate.
    const auto duplicate = depth_event(sequence, 6600000);
    require(!renderer.update_environment_depth(duplicate, .2f, 5.f, .03f, 6600000) &&
                std::abs(renderer.map_update_interval(true) - 1.5f) < .00001f,
            "A repeated observation changed the fade cadence");
    renderer.clear_environment_depth(true);
    renderer.configure_spatial_map(false, .03f, 262144);
}
void check_saved_map_layers(ceres::Renderer& renderer) {
    renderer.clear_saved_map();
    renderer.clear_environment_depth(true);
    renderer.clear_stereo(true);
    renderer.configure_spatial_map(false, .03f, 262144);
    auto recorded = fixture(ceres::SpatialMapSource::environment_depth);
    recorded.points.resize(2);
    require(renderer.import_spatial_map(recorded), "Recording layer fixture import failed");
    auto saved = recorded;
    saved.world_id = "independent-saved-world";
    for (auto& point : saved.points)
        point.x += 10;
    require(renderer.load_saved_map(saved) && renderer.saved_map_state().loaded &&
                !renderer.saved_map_state().placed && !renderer.saved_map_state().fusing,
            "Saved map did not enter independent preview mode");
    require(snapshot(renderer, true)->points.size() == recorded.points.size() &&
                !renderer.request_saved_map_snapshot() && !renderer.set_saved_map_fusion(true),
            "Loading a map replaced recorded geometry or allowed unplaced fusion");
    const auto transform = glm::translate(glm::mat4(1.f), glm::vec3(4, 0, 0));
    bool oversized_rejected = false;
    try {
        renderer.place_saved_map(glm::translate(glm::mat4(1.f), glm::vec3(1000000, 0, 0)),
                                  7, 2, 4000000);
    } catch (const std::invalid_argument&) {
        oversized_rejected = true;
    }
    require(oversized_rejected && !renderer.saved_map_state().placed,
            "Out-of-grid placement could discard retained saved geometry");
    renderer.set_saved_map_transform(transform);
    require(renderer.place_saved_map(transform, 7, 2, 4000000), "Saved map placement failed");
    auto placed = saved_snapshot(renderer);
    require(placed->points.size() == saved.points.size() && placed->world_id == saved.world_id &&
                placed->epoch == 7 && placed->space_epoch == 2 &&
                placed->time_origin_us == saved.time_origin_us &&
                std::all_of(placed->points.begin(), placed->points.end(), [](const auto& point) {
                    return point.x > 12 && point.observed_us == 2000000 && point.weight == 8;
                }),
            "Placement changed saved evidence or did not bake the transform");
    renderer.set_saved_map_transform(glm::mat4(1.f));
    require(renderer.saved_map_state().world_from_map[3].x == 4 &&
                !renderer.place_saved_map(transform, 7, 2, 4000000),
            "Locked placement moved or applied its transform twice");
    const auto unfused_generation = renderer.saved_map_state().generation;
    require(renderer.set_saved_map_fusion(true) &&
                renderer.update_environment_depth(depth_event(99, 3900000), .2f, 5, .03f, 3900000) &&
                renderer.saved_map_state().fusing &&
                renderer.saved_map_state().generation == unfused_generation,
            "A queued observation from before placement disabled fusion or changed the saved map");
    renderer.stop_saved_map_fusion();
    require(renderer.update_environment_depth(depth_event(100, 4100000), .2f, 5, .03f, 4100000),
            "Recording layer rejected depth beside a saved map");
    require(renderer.saved_map_state().generation == unfused_generation &&
                snapshot(renderer, true)->points.size() > recorded.points.size(),
            "Independent recording acquisition changed the saved map");
    require(renderer.set_saved_map_fusion(true) &&
                renderer.update_environment_depth(depth_event(101, 4200000), .2f, 5, .03f, 4200000),
            "Placed saved map did not accept depth fusion");
    auto fused = saved_snapshot(renderer);
    require(fused->points.size() > placed->points.size() &&
                std::any_of(fused->points.begin(), fused->points.end(), [](const auto& point) {
                    return std::abs(point.x) < 1 && point.z < -1;
                }) &&
                std::count_if(fused->points.begin(), fused->points.end(), [](const auto& point) {
                    return point.x > 12 && point.observed_us == 2000000 && point.weight == 8;
                }) == static_cast<std::ptrdiff_t>(saved.points.size()),
            "Depth fusion replaced seeded evidence or failed to add observed geometry");
    const auto fused_generation = renderer.saved_map_state().generation;
    renderer.stop_saved_map_fusion();
    require(renderer.update_environment_depth(depth_event(102, 4300000), .2f, 5, .03f, 4300000) &&
                renderer.saved_map_state().generation == fused_generation,
            "Stopping saved fusion also stopped recording or continued changing saved geometry");
    require(renderer.set_saved_map_fusion(true), "Saved fusion could not resume");
    auto left = video_frame(103, 0), right = video_frame(103, 1);
    require(renderer.update_stereo(left, right, ceres::StereoCalibration::quest(),
                                    .2f, 5, .03f, 4400000) &&
                renderer.saved_map_state().generation > fused_generation,
            "Stereo observations did not reach the separate saved volume");
    fused = saved_snapshot(renderer);
    const auto before_reset = renderer.saved_map_state().generation;
    renderer.clear_environment_depth(true);
    renderer.clear_stereo(true);
    require(renderer.saved_map_state().loaded &&
                renderer.saved_map_state().generation == before_reset &&
                saved_snapshot(renderer)->points.size() == fused->points.size(),
            "Resetting recording caches removed the loaded map");
    renderer.stop_saved_map_fusion();
    require(renderer.set_saved_map_fusion(true, 1000000),
            "Fusion could not restart from an earlier replay position");
    auto replayed_depth = depth_event(104, 1100000);
    replayed_depth.attributes["replay_generation"] = 17;
    require(renderer.update_environment_depth(replayed_depth, .2f, 5, .03f, 1100000) &&
                renderer.saved_map_state().fusing &&
                renderer.saved_map_state().generation > before_reset,
            "Explicit fusion restart retained the prior replay clock or generation");
    const auto replay_fused = saved_snapshot(renderer);
    const auto latest_time = [](const auto& map) {
        int64_t latest = 0;
        for (const auto& point : map.points)
            latest = std::max(latest, point.observed_us);
        return latest;
    };
    require(latest_time(*replay_fused) > latest_time(*fused),
            "Restarting fusion after a backward seek decreased map observation time");
    const auto before_world_change = renderer.saved_map_state().generation;
    require(renderer.update_environment_depth(depth_event(105, 4500000, 8, 3),
                                               .2f, 5, .03f, 4500000) &&
                !renderer.saved_map_state().fusing &&
                renderer.saved_map_state().generation == before_world_change,
            "A new tracking world fused into the placed map");
    require(renderer.begin_saved_map_placement() && !renderer.saved_map_state().placed &&
                renderer.saved_map_state().loaded,
            "Adjusting placement discarded the saved layer");
    const auto adjustment = glm::translate(glm::mat4(1.f), glm::vec3(-1, 2, .5f));
    require(renderer.place_saved_map(adjustment, 8, 3, 4500000),
            "A saved map could not be placed in a new tracking world");
    const auto adjusted = saved_snapshot(renderer);
    require(adjusted->epoch == 8 && adjusted->space_epoch == 3 &&
                std::any_of(adjusted->points.begin(), adjusted->points.end(), [](const auto& point) {
                    return point.x > 11 && point.y > 2 && point.observed_us == 2000000;
                }),
            "Repositioning lost prior geometry, timestamps or the new tracking identity");
    renderer.clear_saved_map();
    require(!renderer.saved_map_state().loaded && !renderer.request_saved_map_snapshot() &&
                snapshot(renderer, true)->points.size() > 0,
            "Unloading the saved map cleared the independent recording layer");
    renderer.clear_environment_depth(true);
    renderer.clear_stereo(true);
}
void check_saved_map_preview_depth(ceres::Renderer& renderer) {
    renderer.reset_view();
    renderer.invalidate_poses();
    auto map = fixture(ceres::SpatialMapSource::environment_depth);
    map.points.resize(1);
    map.points[0].x = .015f;
    map.points[0].y = 1.515f;
    map.points[0].z = -.435f;
    require(renderer.load_saved_map(map), "Preview depth fixture failed to load");
    ceres::ViewOptions options;
    options.hands = options.trails = options.grid = options.frusta = options.headset = options.projection = false;
    options.depth = false;
    options.depth_lod = false;
    options.point_size = 8;
    ceres::ReceiverSnapshot receiver;
    receiver.epoch = 7;
    receiver.space_epoch = 2;
    receiver.now_us = 5000000;
    const auto render = [&] {
        renderer.draw(receiver, ceres::Calibration{}, options);
        renderer.finish_frame();
        cuda_check(cudaDeviceSynchronize());
        std::vector<unsigned char> colour(128 * 128 * 4);
        std::vector<float> depth(128 * 128);
        glReadPixels(0, 0, 128, 128, GL_RGBA, GL_UNSIGNED_BYTE, colour.data());
        glReadPixels(0, 0, 128, 128, GL_DEPTH_COMPONENT, GL_FLOAT, depth.data());
        return std::pair{colour, depth};
    };
    render();
    const auto preview = render();
    auto current = receiver;
    ceres::PoseSample head;
    head.valid = true;
    head.epoch = current.epoch;
    head.space_epoch = current.space_epoch;
    head.values[0] = .015f;
    head.values[1] = 1.515f;
    head.values[2] = -.335f;
    head.values[6] = 1;
    current.poses[0] = head;
    options.map_headset_world_matches = false;
    renderer.update_headset_position(current);
    const auto near_current_head = render();
    current.poses[0]->values[1] = 12;
    renderer.update_headset_position(current);
    require(render().first != near_current_head.first,
            "Saved preview distance ignored current HMD pose outside the recording world");
    options.saved_map_visible = false;
    const auto hidden = render();
    require(preview.first != hidden.first && preview.second == hidden.second,
            "Saved preview was invisible or wrote occluding scene depth");
    options.saved_map_visible = true;
    options.saved_map_opacity = 0;
    require(render() == hidden, "Zero saved map opacity left preview colour or depth behind");
    options.saved_map_opacity = 1;
    require(renderer.place_saved_map(glm::mat4(1.f), 7, 2, receiver.now_us),
            "Preview fixture placement failed");
    render();
    const auto placed = render();
    require(placed.second != hidden.second, "Committed saved map did not acquire scene depth");
    options.saved_map_opacity = 0;
    require(render() == hidden, "Zero saved map opacity left colour or depth behind");
    renderer.clear_saved_map();
}
void check_current_headset_transform(ceres::Renderer& renderer) {
    renderer.invalidate_video();
    ceres::ReceiverSnapshot current;
    current.epoch = 7;
    current.space_epoch = 2;
    current.now_us = 1000000;
    current.clock.valid = true;
    ceres::PoseSample head;
    head.valid = true;
    head.epoch = current.epoch;
    head.space_epoch = current.space_epoch;
    head.observed_us = head.received_us = current.now_us;
    head.values[0] = 2;
    head.values[1] = 3;
    head.values[2] = 4;
    head.values[6] = 1;
    current.poses[0] = head;
    renderer.update_headset_position(current);
    const auto accepted = renderer.headset_transform();
    require(accepted && glm::length(glm::vec3((*accepted)[3]) - glm::vec3(2, 3, 4)) < .0001f,
            "Current headset transform was unavailable before inspection rendering");
    auto inspection = current;
    inspection.poses[0]->values[0] = -2;
    ceres::ViewOptions options;
    options.pose_time_offset_ms = 1000;
    options.hands = options.trails = options.grid = options.frusta = options.projection = false;
    renderer.draw(inspection, ceres::Calibration{}, options);
    renderer.finish_frame();
    require(renderer.headset_transform() &&
                glm::length(glm::vec3((*renderer.headset_transform())[3]) - glm::vec3(2, 3, 4)) < .0001f &&
                renderer.select_scene_view(ceres::SceneView::hmd) &&
                std::abs(renderer.scene_camera().eye.x + 2) < .0001f,
            "Inspection changed current placement pose or HMD view stopped following inspection");
    current.poses[0]->valid = false;
    current.poses[0]->values[0] = 20;
    renderer.update_headset_position(current);
    require(renderer.headset_transform() &&
                std::abs((*renderer.headset_transform())[3].x - 2) < .0001f,
            "Tracking gap discarded the last accepted current headset transform");
    ++current.space_epoch;
    renderer.update_headset_position(current);
    require(!renderer.headset_transform(), "Current headset transform crossed tracking worlds");
    renderer.invalidate_video();
}
void check_scene_navigation(ceres::Renderer& renderer) {
    using Reference = ceres::SceneReference;
    using View = ceres::SceneView;
    ceres::ReceiverSnapshot receiver;
    receiver.epoch = 7;
    receiver.space_epoch = 2;
    receiver.now_us = 1000000;
    receiver.clock.valid = true;
    ceres::ViewOptions options;
    options.grid = options.frusta = options.projection = options.hands = options.headset = false;
    renderer.invalidate_poses();
    const auto draw = [&] {
        renderer.draw(receiver, ceres::Calibration{}, options);
        renderer.finish_frame();
    };
    const auto check_preset = [&](View view, Reference reference, glm::vec3 target) {
        const auto camera = renderer.scene_camera();
        const float distance = glm::length(camera.eye - camera.target);
        require(camera.view == view && camera.reference == reference &&
                    glm::length(camera.target - target) < .0001f &&
                    std::isfinite(distance) && distance > 0,
                "Camera preset lost its selected reference or framing");
        const auto direction = (camera.target - camera.eye) / distance;
        require(glm::length(glm::cross(direction, camera.up)) > .1f,
                "Camera preset has a singular view basis");
        if (view == View::top)
            require(glm::length(direction - glm::vec3(0, -1, 0)) < .0001f &&
                        glm::length(camera.up - glm::vec3(0, 0, -1)) < .0001f,
                    "Top view is not above the reference with a stable up axis");
        if (view == View::left)
            require(camera.eye.x < camera.target.x &&
                        glm::length(direction - glm::vec3(1, 0, 0)) < .0001f &&
                        glm::length(camera.up - glm::vec3(0, 1, 0)) < .0001f,
                    "Left view is not on the negative X axis looking towards the reference");
        if (view == View::iso)
            require(direction.x < 0 && direction.y < 0 && direction.z < 0 &&
                        std::abs(direction.x - direction.y) < .0001f &&
                        std::abs(direction.y - direction.z) < .0001f &&
                        glm::length(camera.up - glm::vec3(0, 1, 0)) < .0001f,
                    "Isometric view axes do not have equal foreshortening");
    };
    const auto check_presets = [&](Reference reference, glm::vec3 target) {
        for (auto view : {View::top, View::left, View::iso}) {
            require(renderer.scene_view_available(view) && renderer.select_scene_view(view),
                    "Available view preset was rejected");
            check_preset(view, reference, target);
            const auto before = renderer.scene_camera();
            draw();
            check_preset(view, reference, target);
            require(renderer.select_scene_view(view), "Repeated preset selection was rejected");
            const auto repeated = renderer.scene_camera();
            require(glm::length(before.eye - repeated.eye) < .0001f &&
                        glm::length(before.target - repeated.target) < .0001f &&
                        glm::length(before.up - repeated.up) < .0001f,
                    "Drawing or repeated selection changed the camera preset");
        }
    };
    draw();
    require(renderer.scene_reference_available(Reference::world) &&
                !renderer.scene_reference_available(Reference::model) &&
                !renderer.scene_reference_available(Reference::hands) &&
                !renderer.scene_reference_available(Reference::camera) &&
                !renderer.scene_view_available(View::hmd),
            "Empty scene exposed an unavailable reference");
    require(!renderer.select_scene_reference(Reference::hands) &&
                !renderer.select_scene_view(View::hmd), "Unavailable camera command was accepted");

    const auto map = fixture(ceres::SpatialMapSource::environment_depth);
    require(renderer.import_spatial_map(map), "Navigation map import was rejected");
    options.depth = options.environment_depth = true;
    draw();
    require(renderer.select_scene_reference(Reference::model), "Imported model has no orbit reference");
    require(glm::length(renderer.scene_camera().target - glm::vec3(.15f, .15f, -2.025f)) < .0001f,
            "Model orbit centre does not use the imported point bounds");
    check_presets(Reference::model, glm::vec3(.15f, .15f, -2.025f));
    require(renderer.select_scene_reference(Reference::world) &&
                renderer.scene_camera().view == View::iso &&
                glm::length(renderer.scene_camera().target) == 0,
            "World reference did not use the origin");
    check_presets(Reference::world, glm::vec3(0));

    ceres::PoseSample head;
    head.valid = true;
    head.epoch = receiver.epoch;
    head.space_epoch = receiver.space_epoch;
    head.observed_us = head.received_us = receiver.now_us;
    head.values[0] = 2;
    head.values[1] = 1.6f;
    head.values[2] = -.3f;
    head.values[5] = head.values[6] = std::sqrt(.5f);
    receiver.poses[0] = head;
    auto hand = head;
    hand.kind = 1;
    hand.joint_mask = 1;
    hand.values[0] = -.2f;
    hand.values[1] = 1.2f;
    hand.values[2] = -.6f;
    receiver.poses[1] = hand;
    options.hands = true;
    options.hand_level = ceres::HandLevel::points;
    draw();
    require(renderer.select_scene_reference(Reference::hands) &&
                glm::length(renderer.scene_camera().target - glm::vec3(-.2f, 1.2f, -.6f)) < .0001f,
            "Hands reference did not use visible joint bounds");
    check_presets(Reference::hands, glm::vec3(-.2f, 1.2f, -.6f));
    require(renderer.select_scene_view(View::left), "Left view of hands was rejected");
    hand.joint_mask = 1u << 5;
    hand.values = {};
    hand.values[5 * 8] = -.15f;
    hand.values[5 * 8 + 1] = 1.3f;
    hand.values[5 * 8 + 2] = -.7f;
    hand.values[5 * 8 + 6] = 1;
    receiver.poses[1] = hand;
    draw();
    check_preset(View::left, Reference::hands, glm::vec3(-.15f, 1.3f, -.7f));
    require(renderer.select_scene_reference(Reference::hands) &&
                renderer.scene_camera().view == View::left &&
                glm::length(renderer.scene_camera().target - glm::vec3(-.15f, 1.3f, -.7f)) < .0001f,
            "A valid partial hand without wrist tracking lost its visible fingers");
    options.hand_level = ceres::HandLevel::mesh;
    draw();
    require(!renderer.scene_reference_available(Reference::hands),
            "An unsupported hidden hand mesh exposed a visible-hands reference");
    options.hand_level = ceres::HandLevel::points;
    draw();
    require(renderer.select_scene_reference(Reference::camera) &&
                renderer.scene_camera().view == View::left &&
                glm::length(renderer.scene_camera().target - glm::vec3(2, 1.6f, -.3f)) < .0001f,
            "Camera reference did not use the headset location");
    check_preset(View::left, Reference::camera, glm::vec3(2, 1.6f, -.3f));
    check_presets(Reference::camera, glm::vec3(2, 1.6f, -.3f));
    require(renderer.select_scene_view(View::hmd), "Valid headset pose has no HMD view");
    const auto hmd = renderer.scene_camera();
    require(glm::length(hmd.eye - glm::vec3(2, 1.6f, -.3f)) < .0001f &&
                glm::length(hmd.up - glm::vec3(-1, 0, 0)) < .0001f &&
                glm::length((hmd.target - hmd.eye) - glm::vec3(0, 0, -1)) < .0001f,
            "HMD view lost headset position, orientation or roll");
    require(renderer.select_scene_reference(Reference::world) &&
                renderer.scene_camera().view == View::orbit &&
                glm::length(renderer.scene_camera().target) == 0 &&
                renderer.select_scene_view(View::hmd),
            "Changing reference from HMD view did not return to a selectable scene camera");
    receiver.now_us += 60000;
    draw();
    receiver.now_us += 2000000;
    draw();
    require(!renderer.scene_reference_available(Reference::hands) &&
                renderer.scene_view_available(View::hmd),
            "Stale hand references survived the visibility fade or retained headset pose was lost");

    renderer.invalidate_poses();
    head.observed_us = head.received_us = receiver.now_us;
    head.values[0] = std::numeric_limits<float>::quiet_NaN();
    receiver.poses = {};
    receiver.poses[0] = head;
    draw();
    require(!renderer.scene_view_available(View::hmd), "Non-finite pose enabled HMD view");
    head.values[0] = 2;
    head.epoch += 1;
    receiver.poses[0] = head;
    draw();
    require(!renderer.scene_reference_available(Reference::camera), "Wrong-epoch pose enabled a camera reference");
    head.epoch = receiver.epoch;
    head.observed_us = head.received_us = receiver.now_us - 60000;
    receiver.poses[0] = head;
    draw();
    require(!renderer.scene_view_available(View::hmd), "Stale unaccepted pose enabled HMD view");
    renderer.reset_view();
    renderer.invalidate_poses();
    renderer.clear_environment_depth(true);
}
void check_image_plane_opacity(ceres::Renderer& renderer) {
    renderer.invalidate_video();
    renderer.reset_view();
    renderer.set_scene_width_fraction(1);
    renderer.set_scene_top_fraction(0);
    renderer.set_scene_bottom_fraction(0);
    ceres::Calibration camera;
    camera.width = 64;
    camera.height = 48;
    camera.fx = camera.fy = 64;
    camera.cx = 32;
    camera.cy = 24;
    camera.translation = {0, 0, 0};
    camera.rotation = {0, 0, 0, 1};
    const auto image = video_frame(90, 0, 208);
    renderer.update_video(image, camera, false);
    cuda_check(cudaDeviceSynchronize());

    ceres::ReceiverSnapshot receiver;
    receiver.epoch = 7;
    receiver.space_epoch = 2;
    receiver.now_us = image.image->event.time_us;
    receiver.clock.valid = true;
    ceres::PoseSample head;
    head.valid = true;
    head.epoch = receiver.epoch;
    head.space_epoch = receiver.space_epoch;
    head.observed_us = head.received_us = receiver.now_us;
    head.values[6] = 1;
    receiver.poses[0] = head;
    auto hand = head;
    hand.kind = 1;
    hand.joint_mask = 1;
    hand.values[2] = -2;
    hand.values[7] = .2f;
    receiver.poses[1] = hand;

    ceres::ViewOptions options;
    options.grid = options.frusta = options.headset = options.trails = options.depth = false;
    options.hands = true;
    options.hand_level = ceres::HandLevel::points;
    options.projection = false;
    options.plane_distance = 1;
    using Pixel = std::array<unsigned char, 4>;
    const auto draw = [&] {
        renderer.draw(receiver, camera, options);
        renderer.finish_frame();
        std::vector<Pixel> pixels(128 * 128);
        glReadPixels(0, 0, 128, 128, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        return pixels;
    };
    draw();
    require(renderer.video_texture() != 0, "Image plane fixture did not publish its CUDA video frame");
    require(renderer.select_scene_view(ceres::SceneView::hmd), "Image plane fixture has no HMD view");
    const auto hand_only = draw();
    require(hand_only[64 * 128 + 64][2] > hand_only[64 * 128 + 64][0] + 30,
            "Image plane fixture did not render the blue hand behind the plane");

    options.projection = true;
    options.plane_opacity = 0;
    require(draw() == hand_only, "Zero image plane opacity modified the hand or background");
    options.plane_opacity = .5f;
    const auto translucent = draw();
    options.plane_opacity = 1;
    const auto opaque = draw();
    options.hands = false;
    const auto plane_only = draw();
    require(opaque == plane_only, "Opaque image plane did not occlude the rear hand");
    for (int y = 62; y < 66; ++y)
        for (int x = 62; x < 66; ++x) {
            const auto pixel = size_t(y) * 128 + x;
            require(std::abs(int(plane_only[pixel][0]) - 208) <= 2 &&
                        std::abs(int(plane_only[pixel][2]) - 208) <= 2,
                    "Image plane fixture did not display the solid camera image");
            for (size_t channel = 0; channel < 3; ++channel) {
                const float expected = .5f * (float(hand_only[pixel][channel]) + float(opaque[pixel][channel]));
                require(std::abs(float(translucent[pixel][channel]) - expected) <= 2.f,
                        "Fractional image plane opacity did not blend the visible rear hand");
            }
        }

    // The same camera plane sits behind this hand. Rendering transparent
    // image planes later must retain depth testing against nearer geometry.
    options.hands = true;
    options.projection = false;
    receiver.poses[1]->values[2] = -.5f;
    const auto foreground_only = draw();
    options.projection = true;
    for (float opacity : {.5f, 1.f}) {
        options.plane_opacity = opacity;
        const auto foreground = draw();
        for (int y = 60; y < 68; ++y)
            for (int x = 60; x < 68; ++x)
                require(foreground[size_t(y) * 128 + x] == foreground_only[size_t(y) * 128 + x],
                        "Image plane obscured the nearer hand");
    }
    renderer.invalidate_video();
    renderer.reset_view();
}
} // namespace

int main(int argc, char** argv) {
    try {
        std::filesystem::path assets = CERES_TEST_ASSET_DIRECTORY;
        if (argc == 3 && std::string(argv[1]) == "--assets")
            assets = argv[2];
        else if (argc != 1)
            throw std::invalid_argument("Usage: test_spatial_map_lifecycle [--assets PATH]");
        Context context;
        ceres::Renderer renderer(context.window, assets);
        check_capacity_growth(renderer);
        check_compacted_map_restore(renderer);
        check_confidence_detail(renderer);
        check_update_cadence(renderer);
        renderer.configure_spatial_map(false, .03f, 262144);
        for (const bool environment : {false, true}) {
            const auto source = environment ? ceres::SpatialMapSource::environment_depth : ceres::SpatialMapSource::stereo;
            const auto imported = fixture(source);
            require(renderer.import_spatial_map(imported), "Map import was rejected");
            auto restored = snapshot(renderer, environment);
            require(restored->points.size() == imported.points.size() && restored->source == source &&
                    restored->time_origin_us == imported.time_origin_us && restored->epoch == 7 &&
                    restored->space_epoch == 2 && restored->world_id == "renderer-fixture",
                    "Import/readback lost point data or identity");
            for (const auto& point : restored->points)
                require(point.observed_us == 2000000 && point.weight == 8 && point.confidence == 1 &&
                        point.flags == (environment ? 0u : ceres::spatial_map_intrinsic_rgb),
                        "Import/readback changed observation metadata");
            require(renderer.map_point_count(environment) == imported.points.size(), "Readback point count was not published");
            const auto active_generation = renderer.map_generation(environment);
            renderer.invalidate_video();
            require(renderer.map_generation(environment) == active_generation &&
                    snapshot(renderer, environment)->points.size() == imported.points.size(),
                    "Video invalidation erased an active spatial map");

            // A queued copy retains its world metadata and bytes even if the map
            // is explicitly cleared before the CPU observes the ready event.
            require(renderer.request_map_snapshot(environment, "old-world", 7, 2), "Old-world snapshot was rejected");
            const auto previous_generation = renderer.map_generation(environment);
            if (environment) renderer.clear_environment_depth(true);
            else renderer.clear_stereo(true);
            require(!renderer.request_map_snapshot(environment, "new-world", 8, 3), "Pending snapshot was overwritten");
            renderer.finish_map_snapshot(environment);
            auto previous = renderer.take_map_snapshot(environment);
            require(previous && previous->world_id == "old-world" && previous->epoch == 7 &&
                    previous->space_epoch == 2 && previous->generation == previous_generation &&
                    previous->points.size() == imported.points.size(), "Reset relabelled an old-world snapshot");
            require(snapshot(renderer, environment)->points.empty(), "Cleared map exported stale GPU points");
            require(renderer.import_spatial_map(imported), "Second map import was rejected");
            restored = snapshot(renderer, environment);
            renderer.configure_spatial_map(true, .03f, 262144);
            const auto frozen_generation = renderer.map_generation(environment);
            renderer.clear_environment_depth();
            renderer.clear_stereo();
            renderer.invalidate_video();
            require(renderer.map_generation(environment) == frozen_generation, "Ordinary lifecycle reset cleared frozen geometry");
            require(snapshot(renderer, environment)->points.size() == imported.points.size(), "Frozen map geometry was lost");
            renderer.configure_spatial_map(false, .03f, 262144);
        }

        const auto head = depth_event(1, 4000000);
        auto left = video_frame(1, 0), right = video_frame(1, 1);
        const auto calibration = ceres::StereoCalibration::quest();
        renderer.configure_spatial_map(true, .03f, 262144);
        const auto environment_generation = renderer.map_generation(true);
        const auto stereo_generation = renderer.map_generation(false);
        require(!renderer.update_environment_depth(head, .2f, 5, .03f, 4000000), "Frozen environment map accepted acquisition");
        require(!renderer.update_stereo(left, right, calibration, .2f, 5, .03f, 4000000), "Frozen stereo map accepted acquisition");
        require(renderer.map_generation(true) == environment_generation && renderer.map_generation(false) == stereo_generation,
                "Frozen acquisition changed map generation");
        renderer.configure_spatial_map(false, .03f, 262144);
        require(renderer.update_environment_depth(head, .2f, 5, .03f, 4000000), "Unfrozen environment map rejected a valid observation");
        require(renderer.update_stereo(left, right, calibration, .2f, 5, .03f, 4000000), "Unfrozen stereo map rejected a valid pair");
        require(snapshot(renderer, true)->points.size() > 0, "Environment acquisition produced an empty map");
        snapshot(renderer, false);

        // Timing follows the submitted capture through asynchronous completion.
        // Sender callback/readback age is separate from the local CUDA duration.
        renderer.clear_environment_depth(true);
        const auto observed = ceres::monotonic_us() - 80000;
        auto timed_depth = depth_event(2, observed);
        timed_depth.receive_us = observed + 65000;
        timed_depth.attributes["geometry_source"] = "sensor";
        timed_depth.attributes["readback_us"] = 42000;
        timed_depth.attributes["target_lead_us"] = 0;
        require(renderer.update_environment_depth(timed_depth, .2f, 5, .03f, observed),
                "Timed environment frame was rejected");
        timed_depth.attributes["geometry_source"] = "view-fallback";
        timed_depth.attributes["readback_us"] = 999999;
        snapshot(renderer, true);
        require(!renderer.update_environment_depth(timed_depth, .2f, 5, .03f, observed),
                "Repeated depth frame was integrated twice");
        const auto timing = renderer.environment_depth_timing();
        require(timing.valid && !timing.replay && timing.sequence == 2 &&
                    timing.geometry_source == "sensor" && timing.readback_ms == 42. &&
                    timing.target_lead_ms == 0. && timing.callback_to_arrival_ms == 65. &&
                    timing.arrival_to_submit_ms >= 15. && timing.submit_to_ready_ms >= 0 &&
                    timing.gpu_ms >= 0,
                "Depth timing mixed capture provenance or pipeline stages");
        renderer.clear_environment_depth(true);
        require(!renderer.environment_depth_timing().valid, "Cleared depth retained old pipeline timing");
        timed_depth.attributes["replay_generation"] = 1;
        timed_depth.attributes["recorded_receive_us"] = observed + 65000;
        timed_depth.attributes["replay_delivery_us"] = ceres::monotonic_us();
        timed_depth.receive_us = ceres::monotonic_us() - 5000000;
        require(renderer.update_environment_depth(timed_depth, .2f, 5, .03f, observed),
                "Restored replay depth was rejected");
        snapshot(renderer, true);
        renderer.update_environment_depth(timed_depth, .2f, 5, .03f, observed);
        const auto replay_timing = renderer.environment_depth_timing();
        require(replay_timing.valid && replay_timing.replay &&
                    replay_timing.callback_to_arrival_ms == 65. &&
                    replay_timing.arrival_to_submit_ms >= 0 && replay_timing.arrival_to_submit_ms < 1000,
                "Replay seek age was reported as local depth queueing");
        renderer.clear_environment_depth(true);

        const auto calibrated_map = fixture(ceres::SpatialMapSource::stereo);
        require(renderer.import_spatial_map(calibrated_map), "Calibration test import was rejected");
        snapshot(renderer, false);
        auto uniform_left = video_frame(2, 0), uniform_right = video_frame(2, 1);
        for (const auto& frame : {uniform_left, uniform_right})
            cuda_check(cudaMemset2D(reinterpret_cast<void*>(frame.image->data), frame.image->pitch,
                                    128, frame.image->width, frame.image->height * 3 / 2));
        auto changed_calibration = calibration;
        changed_calibration.measured = true;
        changed_calibration.preset_id.clear();
        changed_calibration.left.cx += .25;
        require(renderer.update_stereo(uniform_left, uniform_right, changed_calibration,
                                        .2f, 5, .03f, 5000000), "Calibration change rejected a valid pair");
        require(snapshot(renderer, false)->points.size() == calibrated_map.points.size(),
                "Calibration-only change erased world geometry");

        const auto saved = fixture(ceres::SpatialMapSource::environment_depth);
        require(renderer.import_spatial_map(saved), "Budget test import was rejected");
        snapshot(renderer, true);
        auto invalid = saved;
        invalid.points[0].x = std::numeric_limits<float>::quiet_NaN();
        const auto previous_generation = renderer.map_generation(true);
        bool rejected = false;
        try { ceres::Renderer::validate_spatial_map_import(invalid); }
        catch (const std::invalid_argument&) { rejected = true; }
        require(rejected && renderer.map_generation(true) == previous_generation &&
                snapshot(renderer, true)->points.size() == saved.points.size(),
                "Import preflight changed the current map");
        rejected = false;
        try { renderer.import_spatial_map(invalid); }
        catch (const std::invalid_argument&) { rejected = true; }
        require(rejected && renderer.map_generation(true) == previous_generation &&
                snapshot(renderer, true)->points.size() == saved.points.size(),
                "Rejected import changed the current map");
        renderer.configure_spatial_map(true, .06f, 32);
        const auto coarser = snapshot(renderer, true);
        require(!coarser->points.empty() && coarser->points.size() <= 32, "Logical point budget was not applied");
        bool left_region = false, right_region = false;
        for (const auto& point : coarser->points) {
            left_region |= point.x < -1;
            right_region |= point.x > 1;
        }
        require(left_region && right_region, "Changing spacing or budget removed a mapped region");
        require(coarser->base_voxel_size == .06f, "Spacing metadata was not updated");

        // Exercise origin selection through the real renderer, including a valid
        // last-known pose whose acquisition timestamp is deliberately stale.
        auto display = fixture(ceres::SpatialMapSource::environment_depth);
        display.points.resize(1);
        display.points[0].x = .015f;
        display.points[0].y = 1.515f;
        display.points[0].z = -.435f;
        require(renderer.import_spatial_map(display), "Display fixture import was rejected");
        snapshot(renderer, true);
        ceres::ViewOptions options;
        options.hands = options.trails = options.grid = options.frusta = options.headset = options.projection = false;
        options.depth = options.environment_depth = options.map_frozen = true;
        options.depth_lod = false;
        options.point_size = options.depth_opacity = 1;
        ceres::ReceiverSnapshot receiver;
        receiver.epoch = 7;
        receiver.space_epoch = 2;
        receiver.now_us = 900000000;
        ceres::PoseSample pose;
        pose.valid = true;
        pose.epoch = 7;
        pose.space_epoch = 2;
        pose.observed_us = pose.received_us = 1;
        pose.values[0] = .015f;
        pose.values[1] = 1.515f;
        pose.values[2] = -.335f;
        pose.values[6] = 1;
        receiver.poses[0] = pose;
        auto render = [&] {
            renderer.update_headset_position(receiver);
            renderer.draw(receiver, calibration.left, options, -1, 1, 2000000);
            renderer.finish_frame();
            cuda_check(cudaDeviceSynchronize());
            std::vector<unsigned char> pixels(128 * 128 * 4);
            glReadPixels(0, 0, 128, 128, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
            return pixels;
        };
        render(); // Publish the first CUDA-to-GL presentation slot.
        const auto near_head = render();
        receiver.poses[0]->values[1] = 12;
        const auto far_head = render();
        require(near_head != far_head, "Latest valid headset pose did not recolour frozen geometry");
        receiver.poses[0]->valid = false;
        receiver.poses[0]->values[1] = 1.515f;
        require(render() == far_head, "Tracking gap discarded the last valid map-relative origin");
        receiver.poses[0]->valid = true;
        receiver.poses[0]->epoch = 8;
        require(render() == far_head, "A different pose epoch recoloured retained geometry");
        receiver.poses[0]->epoch = 7;
        options.map_headset_world_matches = false;
        require(render() == far_head, "Unrelated connection with matching numeric epochs recoloured a detached map");
        options.map_headset_world_matches = true;
        require(render() == near_head, "Matching tracking world did not restore current distance colour");
        require(snapshot(renderer, true)->points.size() == 1, "Appearance updates changed the frozen geometry");
        check_scene_navigation(renderer);
        check_image_plane_opacity(renderer);
        check_saved_map_layers(renderer);
        check_saved_map_preview_depth(renderer);
        check_current_headset_transform(renderer);
        require(glGetError() == GL_NO_ERROR, "Renderer lifecycle generated an OpenGL error");
        std::cout << "Renderer spatial map lifecycle passed: asynchronous identity, metadata restore, frozen acquisition and retained budget coverage\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
