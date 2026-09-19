#include "ceres/mesh.hpp"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtx/quaternion.hpp>
#include <iostream>
#include <limits>
#include <stdexcept>
static void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
namespace {
constexpr std::array<int, 16> mano_targets{0, 6, 7, 8, 11, 12, 13, 21, 22, 23, 16, 17, 18, 1, 2, 3};
void fixture_geometry(const ceres::HandAssets& assets);
glm::mat4 skin(const ceres::Vertex& vertex, const std::array<glm::mat4, 25>& transforms) {
    glm::mat4 result(0);
    for (int group = 0; group < 4; ++group) {
        const auto& bones = group ? vertex.extra_bones[size_t(group - 1)] : vertex.bones;
        const auto& weights = group ? vertex.extra_weights[size_t(group - 1)] : vertex.weights;
        for (int influence = 0; influence < 4; ++influence)
            result += weights[influence] * transforms[size_t(bones[influence])];
    }
    return result;
}
ceres::PoseSample rest_pose(const std::array<glm::vec3, 25>& rest, bool left,
                            const glm::mat4& transform = glm::mat4(1)) {
    ceres::PoseSample pose;
    pose.kind = left ? 2 : 3;
    pose.valid = true;
    pose.joint_mask = (1u << 25) - 1;
    for (size_t joint = 0; joint < 25; ++joint) {
        const auto point = glm::vec3(transform * glm::vec4(rest[joint], 1));
        for (int c = 0; c < 3; ++c)
            pose.values[joint * 8 + size_t(c)] = point[c];
        pose.values[joint * 8 + 6] = 1;
    }
    return pose;
}
glm::vec3 observed(const ceres::PoseSample& pose, int joint) {
    return {pose.values[joint * 8], pose.values[joint * 8 + 1], pose.values[joint * 8 + 2]};
}
void finite(const std::array<glm::mat4, 25>& transforms) {
    for (const auto& transform : transforms)
        for (int c = 0; c < 4; ++c)
            for (int r = 0; r < 4; ++r)
                check(std::isfinite(transform[c][r]), "Tracking produced a non-finite transform");
}
void retarget_geometry(const ceres::HandAssets& assets) {
    const bool anatomical =
        assets.metadata.value("retargeting", std::string{}) == "webxr-anatomical-v1";
    const auto rigid = glm::translate(glm::mat4(1), glm::vec3(.4f, 1.2f, -.7f)) *
                       glm::toMat4(glm::angleAxis(1.1f, glm::normalize(glm::vec3(1, 2, 3))));
    const auto similarity = rigid * glm::scale(glm::mat4(1), glm::vec3(1.25f));
    for (int side = 0; side < 2; ++side) {
        const auto& rest = assets.rest[size_t(side)];
        const auto& mesh = assets.meshes[size_t(side)];
        for (const auto transform : {glm::mat4(1), similarity}) {
            const auto pose = rest_pose(rest, side == 0, transform);
            check(ceres::hand_pose_supported(pose, side == 0, assets),
                  "Complete MANO palm observations were rejected");
            const auto matrices = ceres::hand_transforms(pose, side == 0, assets);
            finite(matrices);
            for (const auto& vertex : mesh.vertices) {
                const auto fitted = skin(vertex, matrices);
                const auto error = glm::vec3((fitted - transform) * glm::vec4(vertex.position, 1));
                check(glm::length(error) < 2e-5f,
                      "MANO bind pose or rigid/uniform-scale equivariance failed");
                const auto normal =
                    glm::normalize(glm::transpose(glm::inverse(glm::mat3(fitted))) * vertex.normal);
                const auto expected = glm::normalize(
                    glm::transpose(glm::inverse(glm::mat3(transform))) * vertex.normal);
                check(glm::length(normal - expected) < 2e-4f,
                      "MANO transformed normal does not match the geometric transform");
            }
            auto partial = pose;
            partial.joint_mask = 1u | (1u << 6) | (1u << 21);
            check(ceres::hand_pose_supported(partial, side == 0, assets),
                  "A stable partially tracked palm was rejected");
            const auto partial_matrices = ceres::hand_transforms(partial, side == 0, assets);
            for (const auto& vertex : mesh.vertices)
                check(glm::length(glm::vec3((skin(vertex, partial_matrices) - transform) *
                                            glm::vec4(vertex.position, 1))) < 2e-5f,
                      "Partial palm alignment lost source orientation or scale");
        }
        auto bent = rest_pose(rest, side == 0);
        const auto axis = glm::normalize(glm::cross(rest[7] - rest[6], rest[11] - rest[0]));
        const auto bend = glm::toMat4(glm::angleAxis(.7f, axis));
        for (int joint : {7, 8, 9}) {
            const auto point =
                rest[6] + glm::vec3(bend * glm::vec4(rest[size_t(joint)] - rest[6], 0));
            for (int c = 0; c < 3; ++c)
                bent.values[joint * 8 + c] = point[c];
        }
        const auto matrices = ceres::hand_transforms(bent, side == 0, assets);
        for (int joint = 1; joint < 25; ++joint) {
            if (!anatomical &&
                std::find(mano_targets.begin(), mano_targets.end(), joint) == mano_targets.end())
                continue;
            const bool tip = joint == 4 || joint == 9 || joint == 14 || joint == 19 || joint == 24;
            for (int endpoint : {joint, tip ? joint - 1 : joint + 1}) {
                const auto actual =
                    glm::vec3(matrices[size_t(joint)] * glm::vec4(rest[size_t(endpoint)], 1));
                check(glm::length(actual - observed(bent, endpoint)) < 2e-5f,
                      "MANO articulated bone missed its observed joint or fingertip");
            }
        }
        auto moved = bent;
        for (int joint = 0; joint < 25; ++joint) {
            const auto point = glm::vec3(rigid * glm::vec4(observed(bent, joint), 1));
            for (int c = 0; c < 3; ++c)
                moved.values[joint * 8 + c] = point[c];
        }
        const auto moved_matrices = ceres::hand_transforms(moved, side == 0, assets);
        float maximum_displacement = 0;
        for (const auto& vertex : mesh.vertices) {
            const auto point = skin(vertex, matrices) * glm::vec4(vertex.position, 1);
            maximum_displacement =
                std::max(maximum_displacement, glm::length(glm::vec3(point) - vertex.position));
            const auto moved_point = skin(vertex, moved_matrices) * glm::vec4(vertex.position, 1);
            check(glm::length(glm::vec3(moved_point - rigid * point)) < 2e-5f,
                  "MANO articulation depends on arbitrary world axes");
        }
        check(maximum_displacement > .005f, "Finger articulation did not move the MANO skin");
        bent.joint_mask = 1;
        check(!ceres::hand_pose_supported(bent, side == 0, assets),
              "A wrist without palm observations fabricated a mesh alignment");
        finite(ceres::hand_transforms(bent, side == 0, assets));
        bent.joint_mask = (1u << 25) - 1;
        bent.values.fill(0);
        check(!ceres::hand_pose_supported(bent, side == 0, assets),
              "Degenerate palm observations fabricated a mesh alignment");
        finite(ceres::hand_transforms(bent, side == 0, assets));
    }
}
void anatomical_tracking(const ceres::HandAssets& assets) {
    const auto rigid = glm::translate(glm::mat4(1), glm::vec3(-.7f, .3f, 1.4f)) *
                       glm::toMat4(glm::angleAxis(2.1f, glm::normalize(glm::vec3(-3, 1, 2))));
    for (bool left : {true, false}) {
        const auto& rest = assets.rest[left ? 0 : 1];
        const auto& mesh = assets.meshes[left ? 0 : 1];
        auto extended = rest_pose(rest, left);
        for (int joint : {7, 8, 9}) {
            const auto position = rest[6] + (rest[size_t(joint)] - rest[6]) * 1.4f;
            for (int coordinate = 0; coordinate < 3; ++coordinate)
                extended.values[joint * 8 + coordinate] = position[coordinate];
        }
        const auto stretched = ceres::hand_transforms(extended, left, assets);
        for (int joint : {6, 7, 8}) {
            const auto axis = glm::normalize(rest[size_t(joint + 1)] - rest[size_t(joint)]);
            const auto across = glm::normalize(glm::cross(axis, rest[6] - rest[21]));
            const auto thickness = glm::cross(axis, across);
            check(std::abs(glm::length(glm::mat3(stretched[size_t(joint)]) * across) - 1) < 1e-5f &&
                      std::abs(glm::length(glm::mat3(stretched[size_t(joint)]) * thickness) - 1) <
                          1e-5f,
                  "A longer tracked bone inflated the source finger cross-section");
        }
        for (int tip : {4, 9, 14, 19, 24}) {
            for (const auto& vertex : mesh.vertices) {
                const auto position = glm::vec4(vertex.position, 1);
                check(glm::length(glm::vec3((stretched[size_t(tip)] - stretched[size_t(tip - 1)]) *
                                            position)) < 2e-5f,
                      "Weighted fingertip separated from its distal skin transform");
            }
        }
        auto antiparallel = rest_pose(rest, left);
        for (int joint : {7, 8, 9}) {
            const auto position = rest[6] - (rest[size_t(joint)] - rest[6]);
            for (int coordinate = 0; coordinate < 3; ++coordinate)
                antiparallel.values[joint * 8 + coordinate] = position[coordinate];
        }
        const auto reversed = ceres::hand_transforms(antiparallel, left, assets);
        finite(reversed);
        auto moved = antiparallel;
        for (int joint = 0; joint < 25; ++joint) {
            const auto position = glm::vec3(rigid * glm::vec4(observed(antiparallel, joint), 1));
            for (int coordinate = 0; coordinate < 3; ++coordinate)
                moved.values[joint * 8 + coordinate] = position[coordinate];
        }
        const auto moved_reversed = ceres::hand_transforms(moved, left, assets);
        finite(moved_reversed);
        for (const auto& vertex : mesh.vertices) {
            const auto actual = skin(vertex, moved_reversed) * glm::vec4(vertex.position, 1);
            const auto expected = rigid * skin(vertex, reversed) * glm::vec4(vertex.position, 1);
            check(glm::length(glm::vec3(actual - expected)) < 3e-5f,
                  "Antiparallel finger alignment depends on arbitrary world axes");
        }
        auto partial = ceres::fixture_hand(left, 1.3, assets);
        partial.joint_mask &= ~((1u << 7) | (1u << 9) | (1u << 15));
        for (int joint : {7, 9, 15})
            for (int coordinate = 0; coordinate < 3; ++coordinate)
                partial.values[joint * 8 + coordinate] = std::numeric_limits<float>::quiet_NaN();
        const auto incomplete = ceres::hand_transforms(partial, left, assets);
        finite(incomplete);
        for (int joint : {7, 9, 15}) {
            const auto position = glm::vec4(rest[size_t(joint)], 1);
            const auto inherited =
                incomplete[size_t(ceres::joint_parents[size_t(joint)])] * position;
            check(glm::length(glm::vec3(incomplete[size_t(joint)] * position - inherited)) < 1e-6f,
                  "Missing joint did not follow its nearest tracked parent");
        }
        // A tracked non-finite coordinate is treated as a missing observation too.
        partial.joint_mask |= (1u << 7);
        finite(ceres::hand_transforms(partial, left, assets));
        partial.values[0] = std::numeric_limits<float>::quiet_NaN();
        check(!ceres::hand_pose_supported(partial, left, assets),
              "A non-finite wrist fabricated a palm alignment");
    }
}
void anatomical_assets(const std::filesystem::path& directory) {
    const auto assets = ceres::load_hand_assets(directory);
    check(assets.metadata.value("name", std::string{}) == "soma-hand-mid" &&
              assets.metadata.value("retargeting", std::string{}) == "webxr-anatomical-v1",
          "Bundled hand asset has the wrong identity or retargeting contract");
    const auto event = ceres::encode_hand_assets(assets);
    check(event.payload[3] == '2' && event.attributes["skin_influences"] == 16,
          "Anatomical hand was not recorded with its full influence capacity");
    const auto restored = ceres::decode_hand_assets(event);
    check(restored.metadata == event.attributes, "Anatomical source metadata changed in recording");
    for (size_t side = 0; side < 2; ++side) {
        const auto& mesh = assets.meshes[side];
        const auto& copy = restored.meshes[side];
        check(mesh.vertices.size() == 2859 && mesh.indices.size() == 5692 * 3,
              "Bundled anatomical topology differs from the converted source");
        check(mesh.indices == copy.indices && assets.rest[side] == restored.rest[side],
              "Anatomical topology or landmarks changed in recording");
        bool weighted_tip = false, weighted_metacarpal = false, more_than_four = false;
        for (size_t index = 0; index < mesh.vertices.size(); ++index) {
            const auto& vertex = mesh.vertices[index];
            const auto& roundtrip = copy.vertices[index];
            check(vertex.position == roundtrip.position && vertex.normal == roundtrip.normal &&
                      vertex.uv == roundtrip.uv && vertex.bones == roundtrip.bones &&
                      vertex.weights == roundtrip.weights &&
                      vertex.extra_bones == roundtrip.extra_bones &&
                      vertex.extra_weights == roundtrip.extra_weights,
                  "CHM2 lost an anatomical vertex or source skin influence");
            check(std::abs(glm::length(vertex.normal) - 1) < 1e-5f,
                  "Anatomical vertex normal is not a finite unit vector");
            int nonzero = 0;
            float total = 0;
            for (int influence = 0; influence < 16; ++influence) {
                const auto& bones =
                    influence < 4 ? vertex.bones : vertex.extra_bones[size_t(influence / 4 - 1)];
                const auto& weights = influence < 4
                                          ? vertex.weights
                                          : vertex.extra_weights[size_t(influence / 4 - 1)];
                const int joint = bones[influence % 4];
                const float weight = weights[influence % 4];
                check(joint >= 0 && joint < 25 && weight >= 0 && weight <= 1,
                      "Anatomical skin contains an invalid joint or weight");
                nonzero += weight > 1e-8f;
                total += weight;
                weighted_tip =
                    weighted_tip || (weight > 1e-8f && (joint == 4 || joint == 9 || joint == 14 ||
                                                        joint == 19 || joint == 24));
                weighted_metacarpal =
                    weighted_metacarpal ||
                    (weight > 1e-8f && (joint == 5 || joint == 10 || joint == 15 || joint == 20));
            }
            check(std::abs(total - 1) < 1e-4f, "Anatomical skin weights do not sum to one");
            more_than_four = more_than_four || nonzero > 4;
        }
        check(weighted_tip && weighted_metacarpal && more_than_four,
              "Anatomical test no longer covers fingertips, metacarpals and full skin weights");
        for (size_t triangle = 0; triangle < mesh.indices.size(); triangle += 3) {
            const auto& a = mesh.vertices[mesh.indices[triangle]];
            const auto& b = mesh.vertices[mesh.indices[triangle + 1]];
            const auto& c = mesh.vertices[mesh.indices[triangle + 2]];
            const auto normal = glm::cross(b.position - a.position, c.position - a.position);
            check(glm::length(normal) > 1e-12f &&
                      glm::dot(normal, a.normal + b.normal + c.normal) > -1e-9f,
                  "Anatomical triangle winding opposes its surface normals");
        }
    }
    retarget_geometry(restored);
    fixture_geometry(restored);
    anatomical_tracking(restored);
    for (int defect = 0; defect < 6; ++defect) {
        auto invalid = assets;
        switch (defect) {
        case 0:
            invalid.meshes[0].vertices[0].normal = glm::vec3(0);
            break;
        case 1:
            invalid.meshes[0].vertices[0].weights = glm::vec4(-1);
            break;
        case 2:
            invalid.meshes[0].vertices[0].bones.x = 25;
            break;
        case 3:
            invalid.meshes[0].indices[0] = uint32_t(invalid.meshes[0].vertices.size());
            break;
        case 4:
            invalid.rest[0][7] = invalid.rest[0][6];
            break;
        case 5:
            invalid.metadata["units"] = "centimetres";
            break;
        }
        bool rejected = false;
        try {
            ceres::decode_hand_assets(ceres::encode_hand_assets(invalid));
        } catch (const std::exception&) {
            rejected = true;
        }
        check(rejected, "Malformed anatomical hand asset was accepted");
    }
    std::cout << "Anatomical source geometry, 25-joint retargeting and recording tests passed\n";
}
void fixture_geometry(const ceres::HandAssets& assets) {
    constexpr std::array<int, 5> tips{4, 9, 14, 19, 24};
    for (bool left : {true, false}) {
        const auto side = size_t(left ? 0 : 1);
        const auto open = ceres::fixture_hand(left, 0, assets);
        check(open.kind == (left ? 2 : 3) && open.valid && open.joint_mask == (1u << 25) - 1,
              "Fixture changed hand identity or observation validity");
        check((observed(open, 4).x - observed(open, 0).x) * (left ? 1 : -1) > .03f,
              "Fixture thumb is on the wrong side for forward-facing palms");
        const auto transforms = ceres::hand_transforms(open, left, assets);
        check(std::abs(glm::determinant(glm::mat3(transforms[0])) - 1) < 1e-4f,
              "Fixture alignment reflected or rescaled the MANO bind anatomy");
        for (const auto& vertex : assets.meshes[side].vertices) {
            const auto fitted = skin(vertex, transforms) * glm::vec4(vertex.position, 1);
            const auto rigid = transforms[0] * glm::vec4(vertex.position, 1);
            check(glm::length(glm::vec3(fitted - rigid)) < 2e-5f,
                  "Open fixture deformed the canonical MANO bind mesh");
        }
        for (int frame = 0; frame <= 40; ++frame) {
            const auto pose = ceres::fixture_hand(left, frame * .1, assets);
            finite(ceres::hand_transforms(pose, left, assets));
            for (int joint = 1; joint < 25; ++joint) {
                const int parent = ceres::joint_parents[size_t(joint)];
                const float original = glm::length(observed(open, joint) - observed(open, parent));
                const float posed = glm::length(observed(pose, joint) - observed(pose, parent));
                check(std::abs(original - posed) < 2e-6f,
                      "Fixture articulation changed a bone length");
            }
            for (int joint = 0; joint < 25; ++joint) {
                const auto offset = size_t(joint * 8);
                const glm::quat q(pose.values[offset + 6], pose.values[offset + 3],
                                  pose.values[offset + 4], pose.values[offset + 5]);
                check(std::abs(glm::length(q) - 1) < 1e-5f,
                      "Fixture joint orientation is not a unit quaternion");
                const bool tip = std::find(tips.begin(), tips.end(), joint) != tips.end();
                const auto direction = joint == 0 ? observed(pose, 11) - observed(pose, 0)
                                       : tip ? observed(pose, joint) - observed(pose, joint - 1)
                                             : observed(pose, joint + 1) - observed(pose, joint);
                check(glm::dot(q * glm::vec3(0, 0, -1), glm::normalize(direction)) > .9999f,
                      "Fixture quaternion does not follow the WebXR outgoing bone axis");
                if (frame == 0)
                    check(glm::dot(q * glm::vec3(0, -1, 0), glm::vec3(0, 0, -1)) > .85f,
                          "Open fixture palm faces away from the camera plane");
            }
        }
        const auto closed = ceres::fixture_hand(left, 3.141592653589793 / 1.7, assets);
        for (int tip : {9, 14, 19, 24})
            check(observed(closed, tip).z < observed(open, tip).z - .025f,
                  "Fixture finger bends backwards away from its palm");
    }
}
void mano_assets(const std::filesystem::path& directory) {
    auto assets = ceres::load_mano_assets(directory);
    const auto event = ceres::encode_hand_assets(assets);
    check(event.payload[3] == '2' && event.attributes["version"] == 2 &&
              event.attributes["name"] == "MANO" && !event.attributes.contains("generator"),
          "MANO asset framing or source attribution is incorrect");
    const auto restored = ceres::decode_hand_assets(event);
    check(restored.metadata == event.attributes, "Recorded MANO metadata changed");
    for (int side = 0; side < 2; ++side) {
        std::ifstream input(directory / (side ? "mano-right.json" : "mano-left.json"));
        const auto source = ceres::Json::parse(input);
        const auto& mesh = assets.meshes[size_t(side)];
        const auto& copy = restored.meshes[size_t(side)];
        check(mesh.vertices.size() == 778 && mesh.indices.size() == 1538 * 3,
              "MANO canonical topology was changed");
        check(mesh.indices == copy.indices &&
                  assets.rest[size_t(side)] == restored.rest[size_t(side)],
              "Recorded MANO topology or rest joints changed");
        for (size_t joint = 0; joint < mano_targets.size(); ++joint)
            for (int c = 0; c < 3; ++c)
                check(assets.rest[size_t(side)][size_t(mano_targets[joint])][c] ==
                          source["joints"][joint * 3 + size_t(c)].get<float>(),
                      "MANO rest joint was not mapped to its named WebXR observation");
        const std::array<const char*, 5> tip_names{"thumbTip", "indexTip", "middleTip", "ringTip",
                                                   "pinkyTip"};
        for (size_t tip = 0; tip < tip_names.size(); ++tip) {
            const auto vertex = source["tipVertexIds"][tip_names[tip]].get<size_t>();
            check(assets.rest[size_t(side)][tip * 5 + 4] == mesh.vertices[vertex].position,
                  "MANO fingertip landmark was mapped to the wrong WebXR observation");
        }
        bool more_than_four = false;
        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            const auto& vertex = mesh.vertices[i];
            const auto& roundtrip = copy.vertices[i];
            check(vertex.position == roundtrip.position && vertex.normal == roundtrip.normal &&
                      vertex.uv == roundtrip.uv && vertex.bones == roundtrip.bones &&
                      vertex.weights == roundtrip.weights &&
                      vertex.extra_bones == roundtrip.extra_bones &&
                      vertex.extra_weights == roundtrip.extra_weights,
                  "CHM2 lost a MANO vertex or skin influence");
            for (int c = 0; c < 3; ++c)
                check(vertex.position[c] == source["vertices"][i * 3 + size_t(c)].get<float>(),
                      "MANO source positions were mirrored or rotated during loading");
            check(std::abs(glm::length(vertex.normal) - 1) < 1e-5f,
                  "MANO vertex normal is not a finite unit vector");
            int nonzero = 0;
            for (int joint = 0; joint < 16; ++joint) {
                const auto& bones =
                    joint < 4 ? vertex.bones : vertex.extra_bones[size_t(joint / 4 - 1)];
                const auto& weights =
                    joint < 4 ? vertex.weights : vertex.extra_weights[size_t(joint / 4 - 1)];
                check(bones[joint % 4] == mano_targets[size_t(joint)] &&
                          weights[joint % 4] ==
                              source["weights"][i * 16 + size_t(joint)].get<float>(),
                      "MANO joint mapping or full skin weights changed");
                nonzero += weights[joint % 4] > 1e-8f;
            }
            more_than_four = more_than_four || nonzero > 4;
        }
        check(more_than_four, "Canonical MANO test did not exercise more than four weights");
        for (size_t i = 0; i < mesh.indices.size(); ++i)
            check(mesh.indices[i] == source["faces"][i].get<uint32_t>(),
                  "MANO source face winding was changed");
    }
    retarget_geometry(restored);
    fixture_geometry(restored);

    const auto temporary = std::filesystem::temp_directory_path() /
                           ("ceres-mano-test-" + std::to_string(ceres::monotonic_us()));
    std::filesystem::create_directories(temporary);
    struct Cleanup {
        std::filesystem::path path;
        ~Cleanup() {
            std::error_code ignored;
            std::filesystem::remove_all(path, ignored);
        }
    } cleanup{temporary};
    std::filesystem::copy_file(directory / "mano-right.json", temporary / "mano-right.json");
    std::ifstream input(directory / "mano-left.json");
    const auto canonical = ceres::Json::parse(input);
    for (int defect = 0; defect < 9; ++defect) {
        auto malformed = canonical;
        switch (defect) {
        case 0:
            malformed["side"] = "right";
            break;
        case 1:
            malformed["weights"][0] = -1;
            break;
        case 2:
            malformed["faces"][0] = 778;
            break;
        case 3:
            malformed["parents"][1] = 1;
            break;
        case 4:
            malformed["jointNames"][1] = "wrist";
            break;
        case 5:
            malformed["tipVertexIds"]["indexTip"] = 778;
            break;
        case 6:
            malformed["vertices"][0] = nullptr;
            break;
        case 7:
            malformed["version"] = 1.5;
            break;
        case 8:
            malformed["parents"][0] = std::numeric_limits<uint64_t>::max();
            break;
        }
        {
            std::ofstream output(temporary / "mano-left.json");
            output << malformed;
        }
        bool rejected = false;
        try {
            ceres::load_mano_assets(temporary);
        } catch (const std::exception&) {
            rejected = true;
        }
        check(rejected, "Malformed MANO asset was accepted");
    }
    std::cout << "MANO canonical geometry, 16-weight skinning and retargeting tests passed\n";
}
} // namespace
int main(int argc, char** argv) {
    try {
        auto original = ceres::original_hand_assets();
        auto event = ceres::encode_hand_assets(original);
        auto restored = ceres::decode_hand_assets(event);
        check(event.payload[3] == '1' && event.attributes["version"] == 1,
              "Original four-weight asset lost CHM1 compatibility");
        for (int side = 0; side < 2; ++side) {
            auto& mesh = original.meshes[side];
            auto& copy = restored.meshes[side];
            check(copy.indices == mesh.indices, "Triangle topology changed");
            check(copy.vertices.size() == mesh.vertices.size(), "Vertex count changed");
            for (size_t triangle = 0; triangle < mesh.indices.size(); triangle += 3) {
                const auto& a = mesh.vertices[mesh.indices[triangle]];
                const auto& b = mesh.vertices[mesh.indices[triangle + 1]];
                const auto& c = mesh.vertices[mesh.indices[triangle + 2]];
                const auto normal = glm::cross(b.position - a.position, c.position - a.position);
                check(glm::dot(normal, a.normal + b.normal + c.normal) >= -1e-8f,
                      "Hand triangle winding opposes its surface normal");
            }
            for (size_t i = 0; i < mesh.vertices.size(); ++i) {
                auto& a = mesh.vertices[i];
                auto& b = copy.vertices[i];
                check(a.position == b.position && a.normal == b.normal && a.uv == b.uv &&
                          a.bones == b.bones && a.weights == b.weights,
                      "Skin asset changed");
            }
            check(original.rest[side] == restored.rest[side], "Rest rig changed");
        }
        auto malformed = event;
        malformed.payload.resize(80);
        bool rejected = false;
        try {
            ceres::decode_hand_assets(malformed);
        } catch (...) {
            rejected = true;
        }
        check(rejected, "Truncated mesh accepted");
        malformed = event;
        malformed.payload.push_back(0);
        rejected = false;
        try {
            ceres::decode_hand_assets(malformed);
        } catch (...) {
            rejected = true;
        }
        check(rejected, "Trailing asset data accepted");
        malformed = event;
        malformed.payload[304] = 0xff;
        malformed.payload[305] = 0xff;
        malformed.payload[306] = 0xff;
        malformed.payload[307] = 0xff;
        rejected = false;
        try {
            ceres::decode_hand_assets(malformed);
        } catch (...) {
            rejected = true;
        }
        check(rejected, "Oversized mesh accepted");
        for (bool left : {false, true}) {
            auto hand = ceres::fixture_hand(left, .4);
            auto transforms = ceres::hand_transforms(hand, left);
            check(hand.kind == (left ? 2 : 3), "Wrong hand identity");
            for (auto& transform : transforms)
                for (int c = 0; c < 4; ++c)
                    for (int r = 0; r < 4; ++r)
                        check(std::isfinite(transform[c][r]), "Invalid articulated transform");
            for (int j = 0; j < 25; ++j) {
                hand.values[j * 8] = 0;
                hand.values[j * 8 + 1] = 0;
                hand.values[j * 8 + 2] = 0;
            }
            transforms = ceres::hand_transforms(hand, left);
            for (auto& transform : transforms)
                for (int c = 0; c < 4; ++c)
                    for (int r = 0; r < 4; ++r)
                        check(std::isfinite(transform[c][r]), "Degenerate tracking produced NaN");
        }
        auto expanded = original;
        auto& vertex = expanded.meshes[0].vertices[0];
        vertex.weights *= .5f;
        vertex.extra_bones[2] = vertex.bones;
        vertex.extra_weights[2] = vertex.weights;
        const auto expanded_event = ceres::encode_hand_assets(expanded);
        check(expanded_event.payload[3] == '2', "Expanded skin did not use CHM2");
        const auto expanded_copy = ceres::decode_hand_assets(expanded_event);
        check(expanded_copy.meshes[0].vertices[0].extra_weights == vertex.extra_weights &&
                  expanded_copy.meshes[0].vertices[0].extra_bones == vertex.extra_bones,
              "CHM2 did not preserve the final influence group");
#ifdef CERES_TEST_ASSET_DIRECTORY
        anatomical_assets(std::filesystem::path(CERES_TEST_ASSET_DIRECTORY) / "hands");
#endif
        if (argc == 3 && std::string(argv[1]) == "--mano")
            mano_assets(argv[2]);
        else if (const char* directory = std::getenv("CERES_MANO_DIR"))
            mano_assets(directory);
        else
            check(argc == 1, "Usage: test_mesh [--mano DIRECTORY]");
        std::cout << "Hand asset and articulation tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
