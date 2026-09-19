#pragma once
#include "mesh.hpp"
#include <filesystem>

namespace ceres {
struct ModelTexture {
    int width = 0, height = 0;
    std::vector<uint8_t> rgba;
};
struct StaticModel {
    MeshData mesh;
    glm::mat4 model_to_head{1};
    glm::vec4 base_colour{1};
    float metallic = 0, roughness = .7f;
    std::array<ModelTexture, 3> textures;
    Json metadata;
};
StaticModel load_static_model(const std::filesystem::path& directory);
SessionEvent encode_headset_asset(const StaticModel& model);
StaticModel decode_headset_asset(const SessionEvent& event);
} // namespace ceres
