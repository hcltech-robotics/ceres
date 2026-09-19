#pragma once
#include "types.hpp"
#include <array>
#include <filesystem>
#include <glm/glm.hpp>
#include <vector>
namespace ceres {
struct Vertex {
    glm::vec3 position{}, normal{};
    glm::vec2 uv{};
    glm::ivec4 bones{0};
    glm::vec4 weights{1, 0, 0, 0};
    std::array<glm::ivec4, 3> extra_bones{};
    std::array<glm::vec4, 3> extra_weights{};
};
struct MeshData {
    std::vector<Vertex> vertices;
    std::vector<uint32_t> indices;
};
struct HandAssets {
    std::array<MeshData, 2> meshes;
    std::array<std::array<glm::vec3, 25>, 2> rest;
    Json metadata = {{"name", "ceres-original-hand-rig"}, {"generator", "continuous-loft-v1"}};
};
HandAssets original_hand_assets();
HandAssets load_hand_assets(const std::filesystem::path& directory);
HandAssets load_mano_assets(const std::filesystem::path& directory);
bool hand_pose_supported(const PoseSample& pose, bool left, const HandAssets& assets);
SessionEvent encode_hand_assets(const HandAssets& assets);
HandAssets decode_hand_assets(const SessionEvent& event);
std::array<glm::vec3, 25> rest_hand(bool left);
MeshData hand_mesh(bool left);
MeshData sphere_mesh(int rings = 8, int segments = 12);
MeshData cube_mesh();
std::array<glm::mat4, 25> hand_transforms(const PoseSample& pose, bool left);
std::array<glm::mat4, 25> hand_transforms(const PoseSample& pose, bool left,
                                          const std::array<glm::vec3, 25>& rest);
std::array<glm::mat4, 25> hand_transforms(const PoseSample& pose, bool left,
                                          const HandAssets& assets);
PoseSample fixture_hand(bool left, double seconds);
PoseSample fixture_hand(bool left, double seconds, const HandAssets& assets);
} // namespace ceres
