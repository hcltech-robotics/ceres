#include "ceres/static_model.hpp"
#include <filesystem>
#include <iostream>
#include <limits>
#include <stdexcept>

using namespace ceres;
namespace {
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
template <class Function> void rejects(Function function, const char* message) {
    try {
        function();
    } catch (const std::exception&) {
        return;
    }
    throw std::runtime_error(message);
}
StaticModel triangle() {
    StaticModel model;
    model.mesh.vertices.resize(3);
    model.mesh.vertices[0].position = {-.1f, 0, 0};
    model.mesh.vertices[1].position = {.1f, 0, 0};
    model.mesh.vertices[2].position = {0, .1f, 0};
    for (auto& vertex : model.mesh.vertices)
        vertex.normal = {0, 0, 1};
    model.mesh.indices = {0, 1, 2};
    model.textures[0] = {1, 1, {230, 240, 250, 255}};
    model.metadata = {
        {"schema", "ceres-static-model"},
        {"version", 1},
        {"vertex_count", 3},
        {"index_count", 3},
        {"model_to_head", {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -.04, 1}},
        {"base_colour_factor", {1, 1, 1, 1}},
        {"metallic_factor", .1},
        {"roughness_factor", .8},
        {"textures",
         {{"base_colour", {{"file", "base-colour.rgba"}, {"width", 1}, {"height", 1}}}}}};
    return model;
}
} // namespace
int main() {
    try {
        auto model = triangle();
        const auto encoded = encode_headset_asset(model);
        const auto decoded = decode_headset_asset(encoded);
        require(decoded.mesh.vertices.size() == 3 && decoded.mesh.indices == model.mesh.indices &&
                    decoded.textures[0].rgba == model.textures[0].rgba &&
                    decoded.metadata == model.metadata &&
                    std::abs(decoded.model_to_head[3].z + .04f) < 1e-6f,
                "Headset recording round-trip changed geometry, pixels or placement");
        auto bad = encoded;
        bad.payload.pop_back();
        rejects([&] { decode_headset_asset(bad); }, "Truncated headset texture accepted");
        bad = encoded;
        bad.attributes["model"]["vertex_count"] = -1;
        rejects([&] { decode_headset_asset(bad); }, "Negative headset allocation accepted");
        bad = encoded;
        bad.attributes["model"]["textures"]["base_colour"]["width"] = 8192;
        bad.attributes["model"]["textures"]["base_colour"]["height"] = 8192;
        rejects([&] { decode_headset_asset(bad); }, "Oversized headset texture accepted");
        bad = encoded;
        bad.attributes["model"]["model_to_head"][0] = 2;
        rejects([&] { decode_headset_asset(bad); }, "Non-rigid headset placement accepted");
        model.mesh.indices[2] = 3;
        rejects([&] { decode_headset_asset(encode_headset_asset(model)); },
                "Out-of-range headset triangle accepted");
        model = triangle();
        model.mesh.vertices[1].position.x = std::numeric_limits<float>::quiet_NaN();
        rejects([&] { decode_headset_asset(encode_headset_asset(model)); },
                "Non-finite headset geometry accepted");
        const auto local = std::filesystem::path(__FILE__).parent_path().parent_path() / "assets" / "quest3";
        if (std::filesystem::exists(local / "model.json")) {
            const auto asset = load_static_model(local);
            const auto replay = decode_headset_asset(encode_headset_asset(asset));
            require(asset.mesh.vertices.size() == replay.mesh.vertices.size() &&
                        asset.mesh.indices == replay.mesh.indices &&
                        asset.textures[0].rgba == replay.textures[0].rgba &&
                        asset.textures[1].rgba == replay.textures[1].rgba &&
                        asset.textures[2].rgba == replay.textures[2].rgba,
                    "Quest recording did not retain the source mesh and texture maps");
            std::cout << "Quest asset: " << asset.mesh.vertices.size() << " vertices, "
                      << asset.mesh.indices.size() / 3 << " triangles\n";
        }
        std::cout << "Static model tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
