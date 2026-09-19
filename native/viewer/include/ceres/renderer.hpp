#pragma once
#include "calibration.hpp"
#include "hand_display.hpp"
#include "spatial_observation.hpp"
#include "spatial_map_display.hpp"
#include "spatial_map.hpp"
#include "stereo.hpp"
#include "video.hpp"
#include <filesystem>
#include <glm/vec3.hpp>
#include <memory>
struct GLFWwindow;
namespace ceres {
enum class SceneReference { world, model, hands, camera };
enum class SceneView { orbit, hmd, top, side, iso };
struct SceneCameraState {
    SceneReference reference = SceneReference::world;
    SceneView view = SceneView::orbit;
    glm::vec3 eye{}, target{}, up{0, 1, 0};
};
struct ViewOptions {
    HandLevel hand_level = HandLevel::mesh;
    HandColour hand_colour = HandColour::side, trail_colour = HandColour::side;
    TrailMode trail_mode = TrailMode::fingertips;
    bool hands = true, trails = false;
    bool grid = true, frusta = true, headset = true, projection = true, undistort = true,
         depth = false;
    float plane_distance = 1, plane_opacity = .9f, pose_time_offset_ms = 0, trail_seconds = 2;
    float stereo_skew_ms = 8, depth_min = .2f, depth_max = 5, point_size = 2;
    float stereo_update_hz = 2, voxel_size = .03f;
    bool depth_lod = true, mask_hands = true;
    float depth_opacity = .85f;
    SpatialMapShader map_shader = SpatialMapShader::distance;
    SpatialMapStyle map_style = SpatialMapStyle::shape;
    float map_relief_strength = 1.f;
    float map_density = 1.f;
    float map_recency_seconds = 30.f;
    bool map_frozen = false;
    bool map_headset_world_matches = true;
    int depth_source = 0;           // Automatic, Quest depth or stereo.
    bool environment_depth = false; // Selected presentation source, not a preference.
};
struct DepthPipelineTiming {
    bool valid = false, replay = false;
    std::string geometry_source;
    std::optional<double> readback_ms, target_lead_ms, callback_to_arrival_ms;
    double arrival_to_submit_ms = 0, submit_to_ready_ms = 0, gpu_ms = 0;
    uint32_t sequence = 0;
};
class Renderer {
  public:
    explicit Renderer(GLFWwindow* window, const std::filesystem::path& assets = {});
    ~Renderer();
    int cuda_device() const;
    void set_scene_width_fraction(float fraction);
    void set_scene_top_fraction(float fraction);
    void set_scene_bottom_fraction(float fraction);
    void process_input(double dt, bool capture_mouse, bool capture_keyboard);
    void zoom(float delta);
    void reset_view();
    void frame_hands(const ReceiverSnapshot& snapshot);
    void headset_view(const ReceiverSnapshot& snapshot);
    bool scene_reference_available(SceneReference reference) const;
    bool select_scene_reference(SceneReference reference);
    bool scene_view_available(SceneView view) const;
    bool select_scene_view(SceneView view);
    SceneCameraState scene_camera() const;
    void update_headset_position(const ReceiverSnapshot& snapshot, double time_scale = 1);
    void update_video(VideoFrameLease lease, const Calibration& calibration, bool undistort,
                      size_t camera = 0);
    bool update_stereo(VideoFrameLease left, VideoFrameLease right,
                       const StereoCalibration& calibration, float min_depth, float max_depth,
                       float voxel_size, int64_t observation_time_us,
                       const HandMaskSet& hands = {});
    void clear_stereo(bool force = false);
    double stereo_ms() const;
    bool update_environment_depth(const SessionEvent& event, float min_depth, float max_depth,
                                  float voxel_size, int64_t observation_time_us,
                                  const HandMaskSet& hands = {});
    void clear_environment_depth(bool force = false);
    double environment_depth_ms() const;
    const DepthPipelineTiming& environment_depth_timing() const;
    size_t depth_map_bytes(bool environment) const;
    void configure_spatial_map(bool frozen, float spacing, size_t max_points);
    bool request_map_snapshot(bool environment, std::string world_id,
                              uint32_t epoch, uint32_t space_epoch);
    std::shared_ptr<SpatialMapSnapshot> take_map_snapshot(bool environment);
    void finish_map_snapshot(bool environment);
    static void validate_spatial_map_import(const SpatialMapSnapshot& map);
    bool import_spatial_map(const SpatialMapSnapshot& map);
    uint64_t map_generation(bool environment) const;
    size_t map_point_count(bool environment) const;
    void invalidate_video();
    void invalidate_poses();
    SessionEvent hand_asset_event() const;
    void restore_hand_asset(const SessionEvent& event);
    std::optional<SessionEvent> headset_asset_event() const;
    void restore_headset_asset(const SessionEvent& event);
    void restore_live_assets();
    Json scene_assets() const;
    void draw(const ReceiverSnapshot& snapshot, const Calibration& calibration,
              const ViewOptions& options, int64_t trail_time_us = -1, double trail_time_scale = 1,
              int64_t scene_time_us = -1);
    void finish_frame();
    void notify_presented();
    unsigned video_texture(size_t camera = 0) const;
    int video_width(size_t camera = 0) const;
    int video_height(size_t camera = 0) const;
    double gpu_ms() const;
    double video_latency_ms() const;
    uint64_t presented_frames() const;
    void screenshot(const std::filesystem::path& path);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace ceres
