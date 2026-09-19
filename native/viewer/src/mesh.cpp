#include "ceres/mesh.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <fstream>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/quaternion.hpp>
#include <glm/gtx/quaternion.hpp>
#include <stdexcept>
namespace ceres {
constexpr float pi = 3.14159265358979323846f;
std::array<glm::vec3, 25> rest_hand(bool left) {
    std::array<glm::vec3, 25> p{
        {{0, 0, 0},          {-.029f, .020f, 0}, {-.047f, .037f, 0}, {-.064f, .055f, 0},
         {-.075f, .071f, 0}, {-.027f, .066f, 0}, {-.030f, .105f, 0}, {-.030f, .132f, 0},
         {-.030f, .152f, 0}, {-.030f, .166f, 0}, {-.007f, .070f, 0}, {-.007f, .115f, 0},
         {-.007f, .145f, 0}, {-.007f, .168f, 0}, {-.007f, .182f, 0}, {.014f, .065f, 0},
         {.015f, .107f, 0},  {.016f, .135f, 0},  {.016f, .155f, 0},  {.016f, .168f, 0},
         {.033f, .055f, 0},  {.036f, .087f, 0},  {.038f, .109f, 0},  {.039f, .127f, 0},
         {.039f, .140f, 0}}};
    if (!left)
        for (auto& v : p)
            v.x = -v.x;
    return p;
}
namespace {
void quad(MeshData& m, uint32_t a, uint32_t b, uint32_t c, uint32_t d) {
    m.indices.insert(m.indices.end(), {a, b, c, a, c, d});
}
glm::quat between(glm::vec3 a, glm::vec3 b) {
    if (glm::length(a) < 1e-6f || glm::length(b) < 1e-6f)
        return {1, 0, 0, 0};
    a = glm::normalize(a);
    b = glm::normalize(b);
    float d = glm::dot(a, b);
    if (d < -.9999f) {
        auto axis = glm::cross(a, glm::vec3(1, 0, 0));
        if (glm::length(axis) < 1e-4f)
            axis = glm::cross(a, glm::vec3(0, 0, 1));
        return glm::angleAxis(pi, glm::normalize(axis));
    }
    return glm::normalize(glm::quat(1 + d, glm::cross(a, b)));
}
} // namespace
MeshData hand_mesh(bool left) {
    MeshData m;
    auto rest = rest_hand(left);
    constexpr int sides = 16;
    // A closed palm and continuously lofted fingers form the original hand rig.
    constexpr int palm_rings = 12;
    for (int j = 0; j <= palm_rings; ++j) {
        float t = float(j) / palm_rings, y = -.018f + t * .101f;
        float taper = std::sin(pi * (.11f + .78f * t));
        float rx = .039f * taper, rz = .011f * taper;
        for (int i = 0; i <= sides; ++i) {
            float a = 2 * pi * i / sides;
            Vertex v;
            v.position = {rx * std::cos(a), y, rz * std::sin(a)};
            v.normal = glm::normalize(
                glm::vec3(std::cos(a) / std::max(rx, .001f), 0, std::sin(a) / std::max(rz, .001f)));
            v.bones = {0,
                       v.position.x * (left ? 1 : -1) < -.015f
                           ? 5
                           : (v.position.x * (left ? 1 : -1) > .019f ? 20 : 10),
                       0, 0};
            float weight = std::clamp((y - .02f) / .07f, 0.f, .72f);
            v.weights = {1 - weight, weight, 0, 0};
            m.vertices.push_back(v);
            if (j && i) {
                uint32_t b = j * (sides + 1) + i;
                quad(m, b - sides - 2, b - 1, b, b - sides - 1);
            }
        }
    }
    for (int end : {0, palm_rings}) {
        uint32_t centre = static_cast<uint32_t>(m.vertices.size());
        Vertex v;
        v.position = {0, -.018f + float(end) / palm_rings * .101f, 0};
        v.normal = {0, end ? 1.f : -1.f, 0};
        m.vertices.push_back(v);
        for (int i = 0; i < sides; ++i) {
            uint32_t a = end * (sides + 1) + i, b = a + 1;
            if (end)
                m.indices.insert(m.indices.end(), {centre, b, a});
            else
                m.indices.insert(m.indices.end(), {centre, a, b});
        }
    }
    const std::array<int, 5> first{1, 5, 10, 15, 20}, last{4, 9, 14, 19, 24};
    for (size_t finger = 0; finger < 5; ++finger) {
        uint32_t base = static_cast<uint32_t>(m.vertices.size());
        int count = (last[finger] - first[finger]) * 5 + 1;
        for (int ring = 0; ring <= count; ++ring) {
            float f = float(ring) / count * (last[finger] - first[finger]);
            int k = std::min(int(f), last[finger] - first[finger] - 1), joint = first[finger] + k;
            float blend = std::clamp(f - k, 0.f, 1.f);
            auto centre = glm::mix(rest[joint], rest[joint + 1], blend);
            auto tangent = glm::normalize(rest[joint + 1] - rest[joint]);
            auto a = glm::normalize(glm::cross(tangent, glm::vec3(0, 0, 1)));
            auto b = glm::cross(a, tangent);
            float tip_t = float(ring) / count;
            float radius =
                (finger == 0 ? .010f : (finger == 4 ? .007f : .0085f)) * (1.f - .27f * tip_t);
            if (ring == count)
                radius = .0012f;
            for (int i = 0; i <= sides; ++i) {
                float angle = 2 * pi * i / sides;
                Vertex v;
                v.normal = a * std::cos(angle) + b * std::sin(angle);
                v.position = centre + v.normal * radius;
                v.bones = {joint, joint + 1, 0, 0};
                v.weights = {1 - blend, blend, 0, 0};
                m.vertices.push_back(v);
                if (ring && i) {
                    uint32_t ix = base + ring * (sides + 1) + i;
                    quad(m, ix - sides - 2, ix - 1, ix, ix - sides - 1);
                }
            }
        }
    }
    return m;
}
MeshData sphere_mesh(int rings, int segments) {
    MeshData m;
    for (int j = 0; j <= rings; ++j) {
        float a = pi * j / rings;
        for (int i = 0; i <= segments; ++i) {
            float b = 2 * pi * i / segments;
            Vertex v;
            v.position =
                v.normal = {std::sin(a) * std::cos(b), std::cos(a), std::sin(a) * std::sin(b)};
            m.vertices.push_back(v);
            if (j && i) {
                uint32_t k = j * (segments + 1) + i;
                quad(m, k - segments - 2, k - segments - 1, k, k - 1);
            }
        }
    }
    return m;
}
MeshData cube_mesh() {
    MeshData m;
    const std::array<glm::vec3, 6> ns{
        {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}}};
    for (auto n : ns) {
        glm::vec3 u = std::abs(n.y) > .5f ? glm::vec3(1, 0, 0)
                                          : glm::normalize(glm::cross(glm::vec3(0, 1, 0), n));
        auto v = glm::cross(n, u);
        uint32_t b = static_cast<uint32_t>(m.vertices.size());
        for (auto p : std::array<glm::vec2, 4>{{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}}) {
            Vertex x;
            x.position = n * .5f + (u * p.x + v * p.y) * .5f;
            x.normal = n;
            m.vertices.push_back(x);
        }
        quad(m, b, b + 1, b + 2, b + 3);
    }
    return m;
}
std::array<glm::mat4, 25> hand_transforms(const PoseSample& p, bool left) {
    return hand_transforms(p, left, rest_hand(left));
}
std::array<glm::mat4, 25> hand_transforms(const PoseSample& p, bool left,
                                          const std::array<glm::vec3, 25>& rest) {
    std::array<glm::mat4, 25> result;
    auto point = [&](int i) {
        return glm::vec3(p.values[i * 8], p.values[i * 8 + 1], p.values[i * 8 + 2]);
    };
    auto q = glm::quat(p.values[6], p.values[3], p.values[4], p.values[5]);
    if (glm::length(q) < .5f)
        q = {1, 0, 0, 0};
    glm::mat4 wrist = glm::translate(glm::mat4(1), point(0)) * glm::toMat4(glm::normalize(q));
    if ((p.joint_mask & (1u << 5)) && (p.joint_mask & (1u << 20))) {
        auto y = (point(5) + point(20)) * .5f - point(0);
        auto x = (left ? 1.f : -1.f) * (point(20) - point(5));
        if (glm::length(y) > 1e-5f && glm::length(glm::cross(x, y)) > 1e-6f) {
            y = glm::normalize(y);
            auto z = glm::normalize(glm::cross(x, y));
            x = glm::normalize(glm::cross(y, z));
            wrist = glm::mat4(glm::vec4(x, 0), glm::vec4(y, 0), glm::vec4(z, 0),
                              glm::vec4(point(0), 1));
        }
    }
    for (int i = 0; i < 25; ++i) {
        result[i] = wrist;
        if (!(p.joint_mask & (1u << i)))
            continue;
        if (i == 0) {
            result[i] = wrist;
            continue;
        }
        int next = (i == 4 || i == 9 || i == 14 || i == 19 || i == 24) ? joint_parents[i] : i + 1;
        if (!(p.joint_mask & (1u << next)))
            continue;
        auto rd = rest[next] - rest[i], ld = point(next) - point(i);
        float s = glm::length(ld) / std::max(.001f, glm::length(rd));
        s = std::clamp(s, .5f, 1.8f);
        result[i] = glm::translate(glm::mat4(1), point(i)) * glm::toMat4(between(rd, ld)) *
                    glm::scale(glm::mat4(1), glm::vec3(s)) * glm::translate(glm::mat4(1), -rest[i]);
    }
    return result;
}
HandAssets original_hand_assets() {
    return {{hand_mesh(true), hand_mesh(false)}, {rest_hand(true), rest_hand(false)}};
}
HandAssets load_hand_assets(const std::filesystem::path& directory) {
    const auto metadata_path = directory / "model.json";
    const auto geometry_path = directory / "geometry.bin";
    if (std::filesystem::file_size(metadata_path) > 1024 * 1024 ||
        std::filesystem::file_size(geometry_path) > 40 * 1024 * 1024)
        throw std::runtime_error("Hand asset exceeds its size limit");
    std::ifstream metadata(metadata_path, std::ios::binary);
    std::ifstream geometry(geometry_path, std::ios::binary);
    if (!metadata || !geometry)
        throw std::runtime_error("Cannot read bundled hand asset");
    SessionEvent event;
    event.kind = EventKind::Asset;
    event.stream = "hand-rig";
    event.attributes = Json::parse(metadata);
    event.payload.assign(std::istreambuf_iterator<char>(geometry), {});
    if (geometry.bad())
        throw std::runtime_error("Cannot read bundled hand geometry");
    return decode_hand_assets(event);
}
SessionEvent encode_hand_assets(const HandAssets& assets) {
    SessionEvent event;
    event.kind = EventKind::Asset;
    event.stream = "hand-rig";
    event.receive_us = event.time_us = monotonic_us();
    bool expanded = assets.metadata.value("skin_influences", 4) == 16;
    for (const auto& mesh : assets.meshes)
        for (const auto& vertex : mesh.vertices)
            for (const auto& weights : vertex.extra_weights)
                expanded = expanded || weights != glm::vec4(0);
    event.attributes = assets.metadata;
    event.attributes["schema"] = "ceres-hand-assets";
    event.attributes["version"] = expanded ? 2 : 1;
    event.attributes["skin_influences"] = expanded ? 16 : 4;
    event.payload = {'C', 'H', 'M', uint8_t(expanded ? '2' : '1')};
    auto integer = [&](uint32_t value) {
        for (int i = 0; i < 4; ++i)
            event.payload.push_back(uint8_t(value >> (i * 8)));
    };
    auto number = [&](float value) { integer(std::bit_cast<uint32_t>(value)); };
    for (size_t side = 0; side < 2; ++side) {
        for (auto point : assets.rest[side])
            for (int c = 0; c < 3; ++c)
                number(point[c]);
        auto& mesh = assets.meshes[side];
        integer(static_cast<uint32_t>(mesh.vertices.size()));
        integer(static_cast<uint32_t>(mesh.indices.size()));
        for (auto& vertex : mesh.vertices) {
            for (int i = 0; i < 3; ++i)
                number(vertex.position[i]);
            for (int i = 0; i < 3; ++i)
                number(vertex.normal[i]);
            for (int i = 0; i < 2; ++i)
                number(vertex.uv[i]);
            for (int i = 0; i < 4; ++i)
                integer(uint32_t(vertex.bones[i]));
            for (int i = 0; i < 4; ++i)
                number(vertex.weights[i]);
            if (expanded) {
                for (const auto& bones : vertex.extra_bones)
                    for (int i = 0; i < 4; ++i)
                        integer(uint32_t(bones[i]));
                for (const auto& weights : vertex.extra_weights)
                    for (int i = 0; i < 4; ++i)
                        number(weights[i]);
            }
        }
        for (auto index : mesh.indices)
            integer(index);
    }
    return event;
}
HandAssets decode_hand_assets(const SessionEvent& event) {
    const auto version = event.attributes.value("version", 0);
    if (event.kind != EventKind::Asset ||
        event.attributes.value("schema", std::string{}) != "ceres-hand-assets" ||
        (version != 1 && version != 2))
        throw std::runtime_error("Unsupported hand asset");
    auto& bytes = event.payload;
    if (bytes.size() < 4 || bytes[0] != 'C' || bytes[1] != 'H' || bytes[2] != 'M' ||
        bytes[3] != (version == 1 ? '1' : '2'))
        throw std::runtime_error("Invalid hand asset framing");
    size_t cursor = 4;
    auto integer = [&]() {
        if (bytes.size() - cursor < 4)
            throw std::runtime_error("Truncated hand asset");
        uint32_t value = 0;
        for (int i = 0; i < 4; ++i)
            value |= uint32_t(bytes[cursor++]) << (i * 8);
        return value;
    };
    auto number = [&]() {
        float value = std::bit_cast<float>(integer());
        if (!std::isfinite(value) || std::abs(value) > 100)
            throw std::runtime_error("Invalid hand asset coordinate");
        return value;
    };
    HandAssets result;
    result.metadata = event.attributes;
    const auto influences = version == 1 ? 4 : 16;
    if (event.attributes.value("skin_influences", influences) != influences)
        throw std::runtime_error("Hand asset influence count does not match its version");
    const auto retargeting = event.attributes.value("retargeting", std::string{});
    if (!retargeting.empty() && retargeting != "mano-landmark-lbs-v1" &&
        retargeting != "webxr-anatomical-v1")
        throw std::runtime_error("Unsupported hand asset retargeting");
    const bool anatomical = retargeting == "webxr-anatomical-v1";
    if (anatomical && event.attributes.value("units", std::string{}) != "metres")
        throw std::runtime_error("Anatomical hand asset must use metre units");
    for (size_t side = 0; side < 2; ++side) {
        for (auto& point : result.rest[side])
            for (int c = 0; c < 3; ++c)
                point[c] = number();
        if (anatomical) {
            const auto& rest = result.rest[side];
            const auto across = rest[6] - rest[21];
            if (glm::length(across) < .001f ||
                glm::length(glm::cross(across, rest[11] - rest[0])) < 1e-7f)
                throw std::runtime_error("Anatomical hand asset has a degenerate palm");
            for (size_t joint = 1; joint < rest.size(); ++joint) {
                const float length = glm::length(rest[joint] - rest[size_t(joint_parents[joint])]);
                if (length < .001f || length > .3f)
                    throw std::runtime_error("Anatomical hand bone is outside metre units");
            }
        }
        auto vertices = integer(), indices = integer();
        if (!vertices || vertices > 100000 || !indices || indices > 600000 || indices % 3 ||
            uint64_t(vertices) * (version == 1 ? 64 : 160) + uint64_t(indices) * 4 >
                bytes.size() - cursor)
            throw std::runtime_error("Invalid hand asset size");
        auto& mesh = result.meshes[side];
        mesh.vertices.resize(vertices);
        mesh.indices.resize(indices);
        for (auto& vertex : mesh.vertices) {
            for (int i = 0; i < 3; ++i)
                vertex.position[i] = number();
            for (int i = 0; i < 3; ++i)
                vertex.normal[i] = number();
            if (anatomical && std::abs(glm::length(vertex.normal) - 1) > 1e-3f)
                throw std::runtime_error("Anatomical hand asset has an invalid surface normal");
            for (int i = 0; i < 2; ++i)
                vertex.uv[i] = number();
            const auto read_bones = [&](glm::ivec4& bones) {
                for (int i = 0; i < 4; ++i) {
                    auto joint = integer();
                    if (joint >= 25)
                        throw std::runtime_error("Invalid hand asset joint");
                    bones[i] = int(joint);
                }
            };
            float sum = 0;
            const auto read_weights = [&](glm::vec4& weights) {
                for (int i = 0; i < 4; ++i) {
                    weights[i] = number();
                    if (weights[i] < 0 || weights[i] > 1)
                        throw std::runtime_error("Invalid hand asset weight");
                    sum += weights[i];
                }
            };
            read_bones(vertex.bones);
            read_weights(vertex.weights);
            if (version == 2) {
                for (auto& bones : vertex.extra_bones)
                    read_bones(bones);
                for (auto& weights : vertex.extra_weights)
                    read_weights(weights);
            }
            if (std::abs(sum - 1) > 1e-4f)
                throw std::runtime_error("Invalid hand asset skin weights");
        }
        for (auto& index : mesh.indices) {
            index = integer();
            if (index >= vertices)
                throw std::runtime_error("Invalid hand asset triangle");
        }
    }
    if (cursor != bytes.size())
        throw std::runtime_error("Unexpected trailing hand asset bytes");
    return result;
}
namespace {
PoseSample articulated_fixture(bool left, double seconds, const std::array<glm::vec3, 25>& bind) {
    PoseSample p;
    p.kind = left ? 2 : 3;
    p.valid = true;
    p.joint_mask = (1u << 25) - 1;
    p.epoch = p.space_epoch = 1;
    p.observed_us = p.target_us = p.received_us = monotonic_us();
    p.sequence = uint32_t(seconds * 90);

    // Align the actual bind palm with a proper rotation. The thumbs point inwards,
    // while the palms face the image plane along WebXR negative Z.
    const auto bind_x = glm::normalize(bind[6] - bind[21]);
    const auto bind_z = glm::normalize(glm::cross(bind_x, bind[11] - bind[0]));
    const glm::mat3 bind_basis(bind_x, glm::cross(bind_z, bind_x), bind_z);
    const float across = left ? 1.f : -1.f;
    const glm::mat3 desired_basis({across, 0, 0}, {0, 1, 0}, {0, 0, across});
    const auto alignment = desired_basis * glm::transpose(bind_basis);
    const glm::vec3 origin(left ? -.14f : .14f, 1.35f, -.48f), palm_normal(0, 0, -1);
    std::array<glm::vec3, 25> rest{}, observed{}, normals{};
    for (size_t joint = 0; joint < rest.size(); ++joint)
        rest[joint] = alignment * (bind[joint] - bind[0]);
    // MANO has no metacarpal landmarks. The fixture supplies these observations
    // along the palm without changing the source mesh or its skinning joints.
    for (int joint : {5, 10, 15, 20})
        if (glm::length(rest[size_t(joint)]) < 1e-6f)
            rest[size_t(joint)] = rest[size_t(joint + 1)] * .42f;
    observed = rest;
    normals.fill(palm_normal);

    // Start open and flex towards the palm through independent MCP, PIP and DIP
    // rotations. Forward kinematics preserves every phalanx length throughout.
    const float curl = .5f - .5f * std::cos(float(seconds) * 1.7f);
    for (int first : {1, 6, 11, 16, 21}) {
        const bool thumb = first == 1;
        const std::array<float, 3> flexion =
            thumb ? std::array<float, 3>{.15f, .50f, .45f} : std::array<float, 3>{.60f, .90f, .65f};
        glm::mat3 cumulative(1);
        for (int segment = 0; segment < 3; ++segment) {
            const size_t joint = size_t(first + segment);
            const auto bone = rest[joint + 1] - rest[joint];
            const auto axis = glm::normalize(glm::cross(bone, palm_normal));
            cumulative *= glm::mat3_cast(glm::angleAxis(flexion[size_t(segment)] * curl, axis));
            observed[joint + 1] = observed[joint] + cumulative * bone;
            normals[joint] = cumulative * palm_normal;
        }
        normals[size_t(first + 3)] = normals[size_t(first + 2)];
    }
    for (size_t joint = 0; joint < observed.size(); ++joint) {
        const bool tip = joint == 4 || joint == 9 || joint == 14 || joint == 19 || joint == 24;
        const auto direction = joint == 0 ? observed[11] - observed[0]
                               : tip      ? observed[joint] - observed[joint - 1]
                                          : observed[joint + 1] - observed[joint];
        // XRJointSpace: local -Z follows the bone and local -Y faces out of the palm.
        const auto z = -glm::normalize(direction);
        const auto x = glm::normalize(glm::cross(normals[joint], -z));
        const auto q = glm::normalize(glm::quat_cast(glm::mat3(x, glm::cross(z, x), z)));
        const auto v = origin + observed[joint];
        const size_t offset = joint * 8;
        p.values[offset] = v.x;
        p.values[offset + 1] = v.y;
        p.values[offset + 2] = v.z;
        p.values[offset + 3] = q.x;
        p.values[offset + 4] = q.y;
        p.values[offset + 5] = q.z;
        p.values[offset + 6] = q.w;
        p.values[offset + 7] = joint == 0 ? .018f : .008f;
    }
    return p;
}
} // namespace
PoseSample fixture_hand(bool left, double seconds) {
    return articulated_fixture(left, seconds, rest_hand(left));
}
PoseSample fixture_hand(bool left, double seconds, const HandAssets& assets) {
    return articulated_fixture(left, seconds, assets.rest[left ? 0 : 1]);
}
} // namespace ceres
