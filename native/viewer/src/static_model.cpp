#include "ceres/static_model.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <fstream>
#include <glm/gtc/type_ptr.hpp>
#include <limits>
#include <span>
#include <stdexcept>

namespace ceres {
namespace {
constexpr size_t maximum_bytes = 60 * 1024 * 1024;
constexpr std::array<const char*, 3> texture_names{"base_colour", "normal", "orm"};
[[noreturn]] void invalid(const char* message) {
    throw std::runtime_error(message);
}
uint32_t integer(std::span<const uint8_t> bytes, size_t& offset) {
    if (offset > bytes.size() || bytes.size() - offset < 4)
        invalid("Truncated headset asset");
    uint32_t result = 0;
    for (int i = 0; i < 4; ++i)
        result |= uint32_t(bytes[offset++]) << (i * 8);
    return result;
}
void append(std::vector<uint8_t>& bytes, uint32_t value) {
    for (int i = 0; i < 4; ++i)
        bytes.push_back(uint8_t(value >> (i * 8)));
}
float number(std::span<const uint8_t> bytes, size_t& offset) {
    const auto value = std::bit_cast<float>(integer(bytes, offset));
    if (!std::isfinite(value))
        invalid("Non-finite headset geometry");
    return value;
}
size_t count(const Json& value, const char* field, size_t maximum) {
    const auto& n = value.at(field);
    if (!n.is_number_integer() || n.get<double>() < 0 || n.get<double>() > double(maximum))
        invalid("Invalid headset asset size");
    return n.get<size_t>();
}
std::vector<uint8_t> read_file(const std::filesystem::path& path, size_t expected) {
    if (expected > maximum_bytes || std::filesystem::file_size(path) != expected)
        invalid("Headset asset file size differs from its manifest");
    std::ifstream input(path, std::ios::binary);
    std::vector<uint8_t> bytes(expected);
    if (!input.read(reinterpret_cast<char*>(bytes.data()), std::streamsize(bytes.size())))
        invalid("Cannot read headset asset file");
    return bytes;
}
std::filesystem::path member(const std::filesystem::path& directory, const std::string& name) {
    const std::filesystem::path path(name);
    if (path.empty() || path.is_absolute() || path.has_parent_path() || path == "." || path == "..")
        invalid("Headset asset members must be local filenames");
    return directory / path;
}
size_t texture_bytes(const Json& texture) {
    const auto width = count(texture, "width", 8192), height = count(texture, "height", 8192);
    if (!width || !height || width * height > maximum_bytes / 4)
        invalid("Invalid headset texture dimensions");
    return width * height * 4;
}
size_t payload_bytes(const Json& metadata) {
    if (metadata.value("schema", std::string{}) != "ceres-static-model" ||
        metadata.value("version", 0) != 1)
        invalid("Unsupported headset model manifest");
    const auto vertices = count(metadata, "vertex_count", 500000);
    const auto indices = count(metadata, "index_count", 3000000);
    if (!vertices || !indices || indices % 3)
        invalid("Invalid headset triangle counts");
    size_t bytes = 4 + vertices * 32 + indices * 4;
    const auto& textures = metadata.at("textures");
    if (!textures.is_object())
        invalid("Invalid headset texture manifest");
    for (const char* name : texture_names)
        if (textures.contains(name))
            bytes += texture_bytes(textures.at(name));
    if (bytes > maximum_bytes)
        invalid("Headset asset exceeds its memory budget");
    return bytes;
}
void properties(StaticModel& model, const Json& metadata) {
    model.metadata = metadata;
    const auto transform = metadata.at("model_to_head").get<std::array<float, 16>>();
    for (const float value : transform)
        if (!std::isfinite(value))
            invalid("Non-finite headset transform");
    model.model_to_head = glm::make_mat4(transform.data());
    const glm::mat3 rotation(model.model_to_head);
    const auto orthogonal = glm::transpose(rotation) * rotation;
    for (int column = 0; column < 3; ++column)
        for (int row = 0; row < 3; ++row)
            if (std::abs(orthogonal[column][row] - float(column == row)) > .002f)
                invalid("Headset transform must contain a rigid rotation");
    if (glm::determinant(rotation) < .998f || glm::length(glm::vec3(model.model_to_head[3])) > 5 ||
        std::abs(transform[3]) > 1e-6f || std::abs(transform[7]) > 1e-6f ||
        std::abs(transform[11]) > 1e-6f || std::abs(transform[15] - 1) > 1e-6f)
        invalid("Invalid headset rigid transform");
    const auto colour = metadata.at("base_colour_factor").get<std::array<float, 4>>();
    for (float value : colour)
        if (!std::isfinite(value) || value < 0 || value > 1)
            invalid("Invalid headset material colour");
    model.base_colour = glm::make_vec4(colour.data());
    model.metallic = metadata.at("metallic_factor").get<float>();
    model.roughness = metadata.at("roughness_factor").get<float>();
    if (!std::isfinite(model.metallic) || !std::isfinite(model.roughness) || model.metallic < 0 ||
        model.metallic > 1 || model.roughness < 0 || model.roughness > 1)
        invalid("Invalid headset material properties");
}
} // namespace

StaticModel decode_headset_asset(const SessionEvent& event) {
    if (event.kind != EventKind::Asset || event.stream != "headset-rig" ||
        event.attributes.value("schema", std::string{}) != "ceres-headset-asset" ||
        event.attributes.value("version", 0) != 1)
        invalid("Unsupported headset recording asset");
    const auto& metadata = event.attributes.at("model");
    if (event.payload.size() != payload_bytes(metadata) ||
        !std::equal(event.payload.begin(), event.payload.begin() + 4, "CQM1"))
        invalid("Headset asset framing differs from its manifest");
    StaticModel model;
    properties(model, metadata);
    size_t offset = 4;
    const auto bytes = std::span<const uint8_t>(event.payload);
    model.mesh.vertices.resize(count(metadata, "vertex_count", 500000));
    for (auto& vertex : model.mesh.vertices) {
        for (int i = 0; i < 3; ++i)
            vertex.position[i] = number(bytes, offset);
        for (int i = 0; i < 3; ++i)
            vertex.normal[i] = number(bytes, offset);
        vertex.uv.x = number(bytes, offset);
        vertex.uv.y = number(bytes, offset);
        const auto normal_length = glm::length(vertex.normal);
        if (glm::length(vertex.position) > 5 || normal_length < .5f || normal_length > 1.5f)
            invalid("Invalid headset vertex position or normal");
        vertex.normal /= normal_length;
    }
    model.mesh.indices.resize(count(metadata, "index_count", 3000000));
    for (auto& index : model.mesh.indices) {
        index = integer(bytes, offset);
        if (index >= model.mesh.vertices.size())
            invalid("Headset triangle references an invalid vertex");
    }
    for (size_t i = 0; i < texture_names.size(); ++i) {
        const auto& textures = metadata.at("textures");
        if (!textures.contains(texture_names[i]))
            continue;
        const auto& texture = textures.at(texture_names[i]);
        auto& output = model.textures[i];
        output.width = int(count(texture, "width", 8192));
        output.height = int(count(texture, "height", 8192));
        const auto size = texture_bytes(texture);
        output.rgba.assign(bytes.begin() + offset, bytes.begin() + offset + size);
        offset += size;
    }
    return model;
}

SessionEvent encode_headset_asset(const StaticModel& model) {
    SessionEvent event;
    event.kind = EventKind::Asset;
    event.stream = "headset-rig";
    event.receive_us = event.time_us = monotonic_us();
    event.attributes = {
        {"schema", "ceres-headset-asset"}, {"version", 1}, {"model", model.metadata}};
    event.payload = {'C', 'Q', 'M', '1'};
    event.payload.reserve(payload_bytes(model.metadata));
    if (model.mesh.vertices.size() != count(model.metadata, "vertex_count", 500000) ||
        model.mesh.indices.size() != count(model.metadata, "index_count", 3000000))
        invalid("Headset geometry differs from its manifest");
    for (const auto& vertex : model.mesh.vertices) {
        for (int i = 0; i < 3; ++i)
            append(event.payload, std::bit_cast<uint32_t>(vertex.position[i]));
        for (int i = 0; i < 3; ++i)
            append(event.payload, std::bit_cast<uint32_t>(vertex.normal[i]));
        append(event.payload, std::bit_cast<uint32_t>(vertex.uv.x));
        append(event.payload, std::bit_cast<uint32_t>(vertex.uv.y));
    }
    for (uint32_t index : model.mesh.indices)
        append(event.payload, index);
    for (size_t i = 0; i < texture_names.size(); ++i) {
        const auto& textures = model.metadata.at("textures");
        if (textures.contains(texture_names[i])) {
            if (model.textures[i].rgba.size() != texture_bytes(textures.at(texture_names[i])))
                invalid("Headset texture differs from its manifest");
            event.payload.insert(event.payload.end(), model.textures[i].rgba.begin(),
                                 model.textures[i].rgba.end());
        }
    }
    return event;
}

StaticModel load_static_model(const std::filesystem::path& directory) {
    const auto manifest = directory / "model.json";
    if (std::filesystem::file_size(manifest) > 128 * 1024)
        invalid("Headset model manifest exceeds its memory budget");
    std::ifstream input(manifest);
    const auto metadata = Json::parse(input);
    SessionEvent event;
    event.kind = EventKind::Asset;
    event.stream = "headset-rig";
    event.attributes = {{"schema", "ceres-headset-asset"}, {"version", 1}, {"model", metadata}};
    event.payload = {'C', 'Q', 'M', '1'};
    event.payload.reserve(payload_bytes(metadata));
    auto add_file = [&](const std::string& name, size_t expected) {
        const auto bytes = read_file(member(directory, name), expected);
        event.payload.insert(event.payload.end(), bytes.begin(), bytes.end());
    };
    add_file("vertices.bin", count(metadata, "vertex_count", 500000) * 32);
    add_file("indices.bin", count(metadata, "index_count", 3000000) * 4);
    for (const char* name : texture_names)
        if (metadata.at("textures").contains(name)) {
            const auto& texture = metadata.at("textures").at(name);
            add_file(texture.at("file").get<std::string>(), texture_bytes(texture));
        }
    return decode_headset_asset(event);
}
} // namespace ceres
