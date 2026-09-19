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
#include <iostream>
#include <limits>
#include <stdexcept>
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
ceres::SessionEvent depth_event(uint32_t sequence, int64_t time) {
    auto header = depth_fixture::header(sequence, 7, 2, 32, 32);
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
        require(glGetError() == GL_NO_ERROR, "Renderer lifecycle generated an OpenGL error");
        std::cout << "Renderer spatial map lifecycle passed: asynchronous identity, metadata restore, frozen acquisition and retained budget coverage\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
