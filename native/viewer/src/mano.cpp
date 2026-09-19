#include "ceres/mesh.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtx/quaternion.hpp>
#include <stdexcept>

namespace ceres {
namespace {
constexpr std::array<const char*, 16> names{
    "wrist",  "index1", "index2", "index3", "middle1", "middle2", "middle3", "pinky1",
    "pinky2", "pinky3", "ring1",  "ring2",  "ring3",   "thumb1",  "thumb2",  "thumb3"};
constexpr std::array<int, 16> targets{0, 6, 7, 8, 11, 12, 13, 21, 22, 23, 16, 17, 18, 1, 2, 3};
constexpr std::array<int, 16> parents{-1, 0, 1, 2, 0, 4, 5, 0, 7, 8, 0, 10, 11, 0, 13, 14};
constexpr std::array<const char*, 5> tip_names{"thumbTip", "indexTip", "middleTip", "ringTip",
                                               "pinkyTip"};
constexpr std::array<int, 5> tips{4, 9, 14, 19, 24};
constexpr const char* retargeting = "mano-landmark-lbs-v1";
constexpr const char* anatomical_retargeting = "webxr-anatomical-v1";

void require(bool valid, const std::string& reason) {
    if (!valid)
        throw std::runtime_error("Invalid MANO asset: " + reason);
}
float number(const Json& value) {
    require(value.is_number(), "coordinate/weight is not numeric");
    const auto result = value.get<float>();
    require(std::isfinite(result) && std::abs(result) <= 2, "non-finite or out-of-range value");
    return result;
}
int integer(const Json& value, int minimum, int maximum) {
    require(value.is_number_integer(), "index is not an integer");
    if (value.is_number_unsigned())
        require(value.get<uint64_t>() <= uint64_t(maximum), "index is out of range");
    const auto result = value.get<int64_t>();
    require(result >= minimum && result <= maximum, "index is out of range");
    return int(result);
}
glm::vec3 point(const Json& values, size_t index) {
    return {number(values[index * 3]), number(values[index * 3 + 1]),
            number(values[index * 3 + 2])};
}
void array_size(const Json& asset, const char* name, size_t count) {
    require(asset.contains(name) && asset[name].is_array() && asset[name].size() == count,
            std::string(name) + " has the wrong shape");
}
bool basis(const glm::vec3& root, const glm::vec3& index, const glm::vec3& middle,
           const glm::vec3& pinky, glm::mat3& result) {
    const auto across = index - pinky;
    const auto normal = glm::cross(across, middle - root);
    if (!std::isfinite(glm::length(across)) || !std::isfinite(glm::length(normal)) ||
        glm::length(across) < 1e-5f || glm::length(normal) < 1e-7f)
        return false;
    const auto x = glm::normalize(across), z = glm::normalize(normal);
    result = glm::mat3(x, glm::cross(z, x), z);
    return true;
}
bool is_mano(const HandAssets& assets) {
    const auto found = assets.metadata.find("retargeting");
    return found != assets.metadata.end() && found->is_string() &&
           found->get_ref<const std::string&>() == retargeting;
}
bool is_anatomical(const HandAssets& assets) {
    return assets.metadata.value("retargeting", std::string{}) == anatomical_retargeting;
}
bool tracked(const PoseSample& pose, int joint) {
    if (!(pose.joint_mask & (1u << joint)))
        return false;
    for (int coordinate = 0; coordinate < 3; ++coordinate)
        if (!std::isfinite(pose.values[joint * 8 + coordinate]))
            return false;
    return true;
}
glm::mat3 align_bone(glm::vec3 from, glm::vec3 to, const glm::vec3& palm_normal,
                     const glm::vec3& palm_across) {
    from = glm::normalize(from);
    to = glm::normalize(to);
    const float cosine = glm::clamp(glm::dot(from, to), -1.f, 1.f);
    if (cosine < -.9999f) {
        auto axis = glm::cross(from, palm_normal);
        if (glm::length(axis) < 1e-5f)
            axis = glm::cross(from, palm_across);
        const glm::quat half_turn(0, glm::normalize(axis));
        const auto residual =
            glm::normalize(glm::quat(1.f + glm::dot(-from, to), glm::cross(-from, to)));
        return glm::mat3_cast(glm::normalize(residual * half_turn));
    }
    return glm::mat3_cast(glm::normalize(glm::quat(1.f + cosine, glm::cross(from, to))));
}
bool palm_rotation(const PoseSample& pose, const std::array<glm::vec3, 25>& rest,
                   glm::mat3& rotation) {
    if (!pose.valid || !tracked(pose, 0))
        return false;
    const auto point = [&](int joint) {
        return glm::vec3(pose.values[joint * 8], pose.values[joint * 8 + 1],
                         pose.values[joint * 8 + 2]);
    };
    const auto observed = [&](int joint) { return tracked(pose, joint); };
    glm::mat3 rest_basis, observed_basis;
    if (observed(6) && observed(11) && observed(21) &&
        basis(rest[0], rest[6], rest[11], rest[21], rest_basis) &&
        basis(point(0), point(6), point(11), point(21), observed_basis)) {
        rotation = observed_basis * glm::transpose(rest_basis);
        return true;
    }
    // Prefer the widest available knuckle pair for a stable partially tracked palm.
    constexpr std::array<std::array<int, 2>, 6> pairs{
        {{6, 21}, {6, 16}, {11, 21}, {6, 11}, {11, 16}, {16, 21}}};
    for (const auto pair : pairs) {
        const int a = pair[0], b = pair[1];
        if (observed(a) && observed(b) &&
            basis(rest[0], rest[size_t(a)], (rest[size_t(a)] + rest[size_t(b)]) * .5f,
                  rest[size_t(b)], rest_basis) &&
            basis(point(0), point(a), (point(a) + point(b)) * .5f, point(b), observed_basis)) {
            rotation = observed_basis * glm::transpose(rest_basis);
            return true;
        }
    }
    return false;
}

void load_hand(const std::filesystem::path& path, size_t side, HandAssets& output) {
    require(std::filesystem::file_size(path) <= 4 * 1024 * 1024, "file exceeds 4 MiB");
    std::ifstream input(path, std::ios::binary);
    require(bool(input), "cannot read " + path.filename().string());
    const auto asset = Json::parse(input);
    require(asset.is_object() && asset.contains("version") && integer(asset["version"], 1, 1) == 1,
            "unsupported asset version");
    require(asset.value("side", std::string{}) == (side == 0 ? "left" : "right"),
            "handedness does not match the file name");
    require(asset.contains("vertexCount") && integer(asset["vertexCount"], 778, 778) == 778 &&
                asset.contains("faceCount") && integer(asset["faceCount"], 1538, 1538) == 1538 &&
                asset.contains("jointCount") && integer(asset["jointCount"], 16, 16) == 16,
            "expected 778 vertices, 1538 faces and 16 joints");
    array_size(asset, "vertices", 778 * 3);
    array_size(asset, "faces", 1538 * 3);
    array_size(asset, "joints", 16 * 3);
    array_size(asset, "parents", 16);
    array_size(asset, "jointNames", 16);
    array_size(asset, "weights", 778 * 16);
    require(asset.contains("tipVertexIds") && asset["tipVertexIds"].is_object() &&
                asset["tipVertexIds"].size() == 5,
            "expected five fingertip vertex landmarks");
    std::array<int, 16> order{}, mapped{};
    for (size_t joint = 0; joint < names.size(); ++joint) {
        const auto found =
            std::find(asset["jointNames"].begin(), asset["jointNames"].end(), Json(names[joint]));
        require(found != asset["jointNames"].end(), "missing joint " + std::string(names[joint]));
        order[joint] = int(found - asset["jointNames"].begin());
        mapped[size_t(order[joint])] = targets[joint];
    }
    auto& rest = output.rest[side];
    for (size_t joint = 0; joint < names.size(); ++joint) {
        const auto source = size_t(order[joint]);
        const auto parent = integer(asset["parents"][source], -1, 15);
        require(parent == (parents[joint] < 0 ? -1 : order[size_t(parents[joint])]),
                "joint hierarchy does not match MANO joint names");
        rest[size_t(targets[joint])] = point(asset["joints"], source);
    }
    auto& mesh = output.meshes[side];
    mesh.vertices.resize(778);
    mesh.indices.reserve(1538 * 3);
    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        auto& vertex = mesh.vertices[i];
        vertex.position = point(asset["vertices"], i);
        vertex.normal = glm::vec3(0);
        float total = 0;
        for (size_t joint = 0; joint < 16; ++joint) {
            const float weight = number(asset["weights"][i * 16 + joint]);
            require(weight >= 0 && weight <= 1, "skin weight is outside [0,1]");
            total += weight;
            auto& bones = joint < 4 ? vertex.bones : vertex.extra_bones[joint / 4 - 1];
            auto& weights = joint < 4 ? vertex.weights : vertex.extra_weights[joint / 4 - 1];
            bones[int(joint % 4)] = mapped[joint];
            weights[int(joint % 4)] = weight;
        }
        require(std::abs(total - 1) <= 1e-4f, "skin weights do not sum to one");
    }
    for (const auto& index : asset["faces"])
        mesh.indices.push_back(uint32_t(integer(index, 0, 777)));
    for (size_t i = 0; i < mesh.indices.size(); i += 3) {
        auto& a = mesh.vertices[mesh.indices[i]];
        auto& b = mesh.vertices[mesh.indices[i + 1]];
        auto& c = mesh.vertices[mesh.indices[i + 2]];
        const auto normal = glm::cross(b.position - a.position, c.position - a.position);
        require(glm::length(normal) > 1e-12f, "degenerate triangle");
        a.normal += normal;
        b.normal += normal;
        c.normal += normal;
    }
    for (auto& vertex : mesh.vertices) {
        require(glm::length(vertex.normal) > 1e-12f, "undefined vertex normal");
        vertex.normal = glm::normalize(vertex.normal);
    }
    for (size_t i = 0; i < tips.size(); ++i) {
        require(asset["tipVertexIds"].contains(tip_names[i]), "missing fingertip landmark");
        const auto vertex = integer(asset["tipVertexIds"][tip_names[i]], 0, 777);
        rest[size_t(tips[i])] = mesh.vertices[size_t(vertex)].position;
    }
    // MANO has no separate WebXR metacarpal observations for these four fingers.
    // These unskinned entries are placeholders, while all skin joints use exact source data.
    for (int joint : {5, 10, 15, 20})
        rest[size_t(joint)] = rest[0];
    glm::mat3 palm;
    require(basis(rest[0], rest[6], rest[11], rest[21], palm), "degenerate rest palm");
    for (int joint : targets) {
        if (!joint)
            continue;
        const float length = glm::length(rest[size_t(joint + 1)] - rest[size_t(joint)]);
        require(length > .001f && length < .2f, "rest finger length is outside metre units");
    }
}
} // namespace

HandAssets load_mano_assets(const std::filesystem::path& directory) {
    HandAssets result;
    load_hand(directory / "mano-left.json", 0, result);
    load_hand(directory / "mano-right.json", 1, result);
    result.metadata = {{"name", "MANO"},
                       {"source", "licensed MANO model"},
                       {"asset_format", "ceres-mano-json-v1"},
                       {"source_files", {"mano-left.json", "mano-right.json"}},
                       {"retargeting", retargeting},
                       {"units", "metres"},
                       {"skin_influences", 16},
                       {"joint_names", names},
                       {"joint_webxr_indices", targets},
                       {"handedness", {"left", "right"}}};
    return result;
}

bool hand_pose_supported(const PoseSample& pose, bool left, const HandAssets& assets) {
    if (!is_mano(assets) && !is_anatomical(assets))
        return pose.valid && (pose.joint_mask & 1u);
    glm::mat3 rotation;
    return palm_rotation(pose, assets.rest[left ? 0 : 1], rotation);
}

std::array<glm::mat4, 25> hand_transforms(const PoseSample& pose, bool left,
                                          const HandAssets& assets) {
    const bool anatomical = is_anatomical(assets);
    if (!is_mano(assets) && !anatomical)
        return hand_transforms(pose, left, assets.rest[left ? 0 : 1]);
    const auto& rest = assets.rest[left ? 0 : 1];
    const auto observed = [&](int joint) { return tracked(pose, joint); };
    const auto point = [&](int joint) {
        return glm::vec3(pose.values[joint * 8], pose.values[joint * 8 + 1],
                         pose.values[joint * 8 + 2]);
    };
    std::array<glm::mat4, 25> result;
    result.fill(glm::mat4(1));
    if (!pose.valid || !observed(0))
        return result;
    glm::mat3 rotation(1);
    if (!palm_rotation(pose, rest, rotation))
        return result;
    const auto skinned = [&](int joint) {
        return anatomical || std::find(targets.begin(), targets.end(), joint) != targets.end();
    };
    const auto tip = [&](int joint) {
        return std::find(tips.begin(), tips.end(), joint) != tips.end();
    };
    std::array<float, 28> ratios{};
    size_t ratio_count = 0;
    for (int joint : {6, 11, 16, 21}) {
        if (!observed(joint))
            continue;
        const float original = glm::length(rest[size_t(joint)] - rest[0]);
        const float observed_length = glm::length(point(joint) - point(0));
        if (original > 1e-5f && observed_length > 1e-5f && std::isfinite(observed_length))
            ratios[ratio_count++] = observed_length / original;
    }
    for (int joint = 1; joint < 25; ++joint) {
        if (!skinned(joint) || tip(joint) || !observed(joint) || !observed(joint + 1))
            continue;
        const float original = glm::length(rest[size_t(joint + 1)] - rest[size_t(joint)]);
        const float observed_length = glm::length(point(joint + 1) - point(joint));
        if (original > 1e-5f && observed_length > 1e-5f && std::isfinite(observed_length))
            ratios[ratio_count++] = observed_length / original;
    }
    float scale = 1;
    if (ratio_count) {
        std::sort(ratios.begin(), ratios.begin() + ratio_count);
        scale = std::clamp(ratios[ratio_count / 2], .5f, 2.f);
    }
    const glm::mat4 root = glm::translate(glm::mat4(1), point(0)) * glm::mat4(rotation) *
                           glm::scale(glm::mat4(1), glm::vec3(scale)) *
                           glm::translate(glm::mat4(1), -rest[0]);
    result.fill(root);
    std::array<glm::mat3, 25> rotations;
    rotations.fill(rotation);
    const auto palm_across = glm::normalize(rest[6] - rest[21]);
    const auto palm_normal = glm::normalize(glm::cross(palm_across, rest[11] - rest[0]));
    for (int joint = 1; joint < 25; ++joint) {
        if (!skinned(joint))
            continue;
        const int parent = anatomical ? joint_parents[size_t(joint)]
                           : joint == 6 || joint == 11 || joint == 16 || joint == 21 ? 0
                                                                                     : joint - 1;
        result[size_t(joint)] = result[size_t(parent)];
        rotations[size_t(joint)] = rotations[size_t(parent)];
        if (!observed(joint))
            continue;
        auto linear = glm::mat3(result[size_t(parent)]);
        if (!tip(joint) && observed(joint + 1)) {
            const auto from = rest[size_t(joint + 1)] - rest[size_t(joint)];
            const auto to = point(joint + 1) - point(joint);
            const float from_length = glm::length(from), to_length = glm::length(to);
            if (from_length > 1e-5f && to_length > 1e-5f && std::isfinite(to_length)) {
                const auto direction = from / from_length;
                // Align in the parent's bind-relative frame. Even an antiparallel
                // bone then has a source-relative roll, independent of world axes.
                const auto parent_rotation = rotations[size_t(parent)];
                const auto aligned =
                    align_bone(direction, glm::transpose(parent_rotation) * (to / to_length),
                               palm_normal, palm_across);
                const auto oriented = parent_rotation * aligned;
                rotations[size_t(joint)] = oriented;
                const float along = std::clamp(to_length / from_length, .25f, 3.f);
                glm::mat3 stretch(scale);
                stretch += (along - scale) * glm::outerProduct(direction, direction);
                linear = oriented * stretch;
            }
        }
        result[size_t(joint)] = glm::translate(glm::mat4(1), point(joint)) * glm::mat4(linear) *
                                glm::translate(glm::mat4(1), -rest[size_t(joint)]);
    }
    return result;
}
} // namespace ceres
