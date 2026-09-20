#include "ceres/renderer.hpp"
#include "ceres/hand_display.hpp"
#include "ceres/hand_trails.hpp"
#include "ceres/image_kernel.hpp"
#include "ceres/mesh.hpp"
#include "ceres/static_model.hpp"
#include "ceres/stereo_kernel.hpp"
#include "ceres/voxel_kernel.hpp"
#include "ceres/depth.hpp"
#include "ceres/depth_kernel.hpp"
#include "ceres/depth_display.hpp"
#include "ceres/detail/tracking_visibility.hpp"
#include "ceres/detail/hand_presentation.hpp"
#include "ceres/detail/spatial_map_render.hpp"
#include <glad/gl.h>
#include <GLFW/glfw3.h>
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <cuda_gl_interop.h>
#include <fstream>
#include <limits>
#include <glm/gtc/constants.hpp>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/type_ptr.hpp>
#include <glm/gtx/quaternion.hpp>
#include <stdexcept>
#include <utility>
namespace ceres {
namespace {
void cuda_check(cudaError_t r, const char* what) {
    if (r != cudaSuccess)
        throw std::runtime_error(std::string(what) + ": " + cudaGetErrorString(r));
}
bool fresh_pose(const ReceiverSnapshot& snapshot, const PoseSample& pose, double time_scale) {
    const auto now = snapshot.now_us ? snapshot.now_us : monotonic_us();
    const auto& clock = snapshot.clock;
    const double observed = pose.observed_us * clock.rate + clock.offset_us;
    return pose.valid && pose.epoch == snapshot.epoch && pose.space_epoch == snapshot.space_epoch &&
           clock.valid && std::isfinite(clock.rate) && clock.rate > 0 &&
           std::isfinite(clock.offset_us) && std::isfinite(clock.uncertainty_us) &&
           clock.uncertainty_us >= 0 && std::isfinite(observed) &&
           std::isfinite(time_scale) && time_scale > 0 &&
           (static_cast<double>(now) - static_cast<double>(pose.received_us)) * time_scale <= 50000 &&
           (now - observed) * time_scale + clock.uncertainty_us <= 50000;
}
bool finite_position(const glm::vec3& point) {
    return std::isfinite(point.x) && std::isfinite(point.y) && std::isfinite(point.z);
}
bool valid_map_transform(const glm::mat4& transform) {
    for (int column = 0; column < 4; ++column)
        for (int row = 0; row < 4; ++row)
            if (!std::isfinite(transform[column][row]))
                return false;
    if (std::abs(transform[0][3]) > .0001f || std::abs(transform[1][3]) > .0001f ||
        std::abs(transform[2][3]) > .0001f || std::abs(transform[3][3] - 1.f) > .0001f)
        return false;
    std::array<glm::vec3, 3> axes;
    for (int axis = 0; axis < 3; ++axis) {
        const float length = glm::length(glm::vec3(transform[axis]));
        if (!std::isfinite(length) || length <= .000001f)
            return false;
        axes[axis] = glm::vec3(transform[axis]) / length;
    }
    return std::abs(glm::dot(axes[0], axes[1])) <= .0001f &&
           std::abs(glm::dot(axes[0], axes[2])) <= .0001f &&
           std::abs(glm::dot(axes[1], axes[2])) <= .0001f &&
           glm::dot(glm::cross(axes[0], axes[1]), axes[2]) > 0;
}
bool finite_pose(const float* values) {
    for (int i = 0; i < 7; ++i)
        if (!std::isfinite(values[i]))
            return false;
    const glm::quat rotation(values[6], values[3], values[4], values[5]);
    const float length = glm::length(rotation);
    return std::isfinite(length) && length > .5f;
}
struct SceneBounds {
    glm::vec3 minimum{}, maximum{};
    bool valid = false;
    void include(const glm::vec3& point) {
        if (!finite_position(point))
            return;
        minimum = valid ? glm::min(minimum, point) : point;
        maximum = valid ? glm::max(maximum, point) : point;
        valid = true;
    }
    void include(const SceneBounds& other) {
        if (other.valid) {
            include(other.minimum);
            include(other.maximum);
        }
    }
    glm::vec3 centre() const { return minimum * .5f + maximum * .5f; }
    float radius() const { return std::max(.15f, glm::length(maximum - minimum) * .5f); }
};
SceneBounds transformed_bounds(const SceneBounds& bounds, const glm::mat4& transform) {
    SceneBounds result;
    if (bounds.valid)
        for (unsigned corner = 0; corner < 8; ++corner)
            result.include(glm::vec3(transform * glm::vec4(
                corner & 1 ? bounds.maximum.x : bounds.minimum.x,
                corner & 2 ? bounds.maximum.y : bounds.minimum.y,
                corner & 4 ? bounds.maximum.z : bounds.minimum.z, 1.f)));
    return result;
}
GLuint program() {
    const char* vertex = R"GLSL(#version 450 core
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec2 uv;
layout(location=3) in ivec4 joints;
layout(location=4) in vec4 weights;
layout(location=5) in ivec4 joints1;
layout(location=6) in ivec4 joints2;
layout(location=7) in ivec4 joints3;
layout(location=8) in vec4 weights1;
layout(location=9) in vec4 weights2;
layout(location=10) in vec4 weights3;
layout(location=11) in vec4 trail_colour;
uniform mat4 vp,model,bones[25];
uniform float joint_valid[25],joint_opacity[25];
uniform vec3 joint_colour[25];
uniform int skinned,trail;
out vec3 N; out vec3 P; out vec2 UV; out float validity; out float opacity;
out vec4 path_colour;
out vec3 visual_colour;
mat4 skin(ivec4 j,vec4 w) {
    return bones[j.x]*w.x+bones[j.y]*w.y+bones[j.z]*w.z+bones[j.w]*w.w;
}
float valid(ivec4 j,vec4 w) {
    return dot(vec4(joint_valid[j.x],joint_valid[j.y],joint_valid[j.z],joint_valid[j.w]),w);
}
float visible(ivec4 j,vec4 w) {
    return dot(vec4(joint_opacity[j.x],joint_opacity[j.y],joint_opacity[j.z],joint_opacity[j.w]),w);
}
vec3 skin_colour(ivec4 j,vec4 w) {
    return joint_colour[j.x]*w.x+joint_colour[j.y]*w.y+joint_colour[j.z]*w.z+joint_colour[j.w]*w.w;
}
void main() {
    visual_colour=vec3(1); opacity=1;
    if(trail!=0) {
        N=vec3(0,0,1); P=position; UV=vec2(0); validity=1;
        path_colour=trail_colour; gl_Position=vp*vec4(position,1); return;
    }
    path_colour=vec4(0);
    mat4 m=model; validity=1;
    if(skinned!=0) {
        m=skin(joints,weights)+skin(joints1,weights1)+skin(joints2,weights2)+skin(joints3,weights3);
        validity=clamp(valid(joints,weights)+valid(joints1,weights1)+valid(joints2,weights2)+valid(joints3,weights3),0.0,1.0);
        opacity=clamp(visible(joints,weights)+visible(joints1,weights1)+visible(joints2,weights2)+visible(joints3,weights3),0.0,1.0);
        visual_colour=skin_colour(joints,weights)+skin_colour(joints1,weights1)+skin_colour(joints2,weights2)+skin_colour(joints3,weights3);
    }
    vec4 p=m*vec4(position,1); P=p.xyz;
    mat3 basis=mat3(m);
    vec3 n=abs(determinant(basis))>1e-7 ? transpose(inverse(basis))*normal : basis*normal;
    N=dot(n,n)>1e-12 ? normalize(n) : vec3(0,0,1);
    UV=uv; gl_Position=vp*p;
})GLSL";
    const char* fragment = R"GLSL(#version 450 core
in vec3 N; in vec3 P; in vec2 UV; in float validity; in float opacity;
in vec4 path_colour;
in vec3 visual_colour;
out vec4 colour;
uniform vec4 tint;
uniform sampler2D camera,normal_map,orm_map;
uniform int textured,lit,material_mask,trail;
uniform int hand_colouring;
uniform float material_metallic,material_roughness;
uniform vec3 eye;
void main() {
    if(trail!=0) { colour=path_colour; return; }
    if(textured==1) { colour=vec4(texture(camera,UV).rgb,tint.a); return; }
    vec3 c=tint.rgb;
    vec3 n=normalize(N);
    float alpha=tint.a;
    if(textured==2) {
        if((material_mask&1)!=0) { vec4 texel=texture(camera,UV); c*=texel.rgb; alpha*=texel.a; }
        if((material_mask&2)!=0) {
            vec3 a=dFdx(P),b=dFdy(P); vec2 u=dFdx(UV),v=dFdy(UV);
            float determinant_uv=u.x*v.y-u.y*v.x;
            if(abs(determinant_uv)>1e-10) {
                vec3 t=(a*v.y-b*u.y)/determinant_uv;
                vec3 bitangent=(b*u.x-a*v.x)/determinant_uv;
                t-=n*dot(n,t);
                if(dot(t,t)>1e-12 && dot(bitangent,bitangent)>1e-12) {
                    t=normalize(t);
                    vec3 perpendicular=cross(n,t);
                    bitangent=perpendicular*(dot(perpendicular,bitangent)<0 ? -1.0 : 1.0);
                    vec3 detail=texture(normal_map,UV).xyz*2-1;
                    n=normalize(t*detail.x+bitangent*detail.y+n*detail.z);
                }
            }
        }
        if(!gl_FrontFacing) n=-n;
        vec3 orm=(material_mask&4)!=0 ? texture(orm_map,UV).rgb : vec3(1);
        float metallic=clamp(material_metallic*orm.b,0.0,1.0);
        float roughness=clamp(material_roughness*orm.g,.05,1.0);
        vec3 l=normalize(vec3(-.5,1,.7));
        float diffuse=max(0.0,dot(n,l));
        float highlight=pow(max(0.0,dot(n,normalize(l+normalize(eye-P)))),mix(160.0,5.0,roughness));
        vec3 reflectance=mix(vec3(.04),c,metallic);
        c=c*(.30*orm.r+.66*diffuse*(1-metallic*.7))+reflectance*highlight*.8;
        c=pow(clamp(c,0.0,1.0),vec3(1.0/2.2));
    } else if(hand_colouring==1) {
        c=n*.5+.5;
    } else if(hand_colouring>=2) {
        c=visual_colour;
    } else if(lit!=0) {
        if(!gl_FrontFacing) n=-n;
        vec3 l=normalize(vec3(-.5,1,.7));
        float d=max(0.0,dot(n,l));
        float s=pow(max(0.0,dot(n,normalize(l+normalize(eye-P)))),42.0);
        c*=.40+.56*d; c+=.16*s;
    }
    c=mix(vec3(dot(c,vec3(.2126,.7152,.0722))),c,validity);
    colour=vec4(c,alpha*opacity);
})GLSL";
    auto shader = [](GLenum type, const char* s) {
        GLuint id = glCreateShader(type);
        glShaderSource(id, 1, &s, nullptr);
        glCompileShader(id);
        GLint ok = 0;
        glGetShaderiv(id, GL_COMPILE_STATUS, &ok);
        if (!ok) {
            char log[4096]{};
            glGetShaderInfoLog(id, 4096, nullptr, log);
            throw std::runtime_error(log);
        }
        return id;
    };
    GLuint vs = shader(GL_VERTEX_SHADER, vertex), fs = shader(GL_FRAGMENT_SHADER, fragment),
           p = glCreateProgram();
    glAttachShader(p, vs);
    glAttachShader(p, fs);
    glLinkProgram(p);
    glDeleteShader(vs);
    glDeleteShader(fs);
    GLint ok;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) {
        char log[4096]{};
        glGetProgramInfoLog(p, 4096, nullptr, log);
        throw std::runtime_error(log);
    }
    return p;
}
struct Mesh {
    GLuint vao = 0, vbo = 0, ibo = 0;
    GLsizei count = 0;
    GLenum primitive = GL_TRIANGLES;
    void upload(const MeshData& m, GLenum mode = GL_TRIANGLES) {
        if (ibo)
            glDeleteBuffers(1, &ibo);
        if (vbo)
            glDeleteBuffers(1, &vbo);
        if (vao)
            glDeleteVertexArrays(1, &vao);
        primitive = mode;
        count = static_cast<GLsizei>(m.indices.size());
        glGenVertexArrays(1, &vao);
        glGenBuffers(1, &vbo);
        glGenBuffers(1, &ibo);
        glBindVertexArray(vao);
        glBindBuffer(GL_ARRAY_BUFFER, vbo);
        glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(m.vertices.size() * sizeof(Vertex)),
                     m.vertices.data(), GL_STATIC_DRAW);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibo);
        glBufferData(GL_ELEMENT_ARRAY_BUFFER,
                     static_cast<GLsizeiptr>(m.indices.size() * sizeof(uint32_t)), m.indices.data(),
                     GL_STATIC_DRAW);
        for (GLuint i = 0; i < 11; ++i)
            glEnableVertexAttribArray(i);
        glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                              reinterpret_cast<void*>(offsetof(Vertex, position)));
        glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                              reinterpret_cast<void*>(offsetof(Vertex, normal)));
        glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                              reinterpret_cast<void*>(offsetof(Vertex, uv)));
        glVertexAttribIPointer(3, 4, GL_INT, sizeof(Vertex),
                               reinterpret_cast<void*>(offsetof(Vertex, bones)));
        glVertexAttribPointer(4, 4, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                              reinterpret_cast<void*>(offsetof(Vertex, weights)));
        for (GLuint i = 0; i < 3; ++i) {
            glVertexAttribIPointer(
                5 + i, 4, GL_INT, sizeof(Vertex),
                reinterpret_cast<void*>(offsetof(Vertex, extra_bones) + i * sizeof(glm::ivec4)));
            glVertexAttribPointer(
                8 + i, 4, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                reinterpret_cast<void*>(offsetof(Vertex, extra_weights) + i * sizeof(glm::vec4)));
        }
        glBindVertexArray(0);
    }
    void draw() const {
        glBindVertexArray(vao);
        glDrawElements(primitive, count, GL_UNSIGNED_INT, nullptr);
    }
    ~Mesh() {
        if (ibo)
            glDeleteBuffers(1, &ibo);
        if (vbo)
            glDeleteBuffers(1, &vbo);
        if (vao)
            glDeleteVertexArrays(1, &vao);
    }
};
struct TrailMesh {
    struct Vertex {
        std::array<float, 3> position;
        std::array<float, 4> colour;
    };
    struct Slot {
        GLuint vao = 0, vbo = 0;
        GLsync fence = nullptr;
    };
    std::array<Slot, 3> slots{};
    std::array<HandTrailSegment, HandTrails::max_segments> segments;
    std::array<Vertex, HandTrails::max_segments * 2> vertices;
    size_t next_slot = 0;
    float width = 1.f;

    void initialise() {
        GLfloat range[2]{};
        glGetFloatv(GL_ALIASED_LINE_WIDTH_RANGE, range);
        width = std::clamp(1.5f, range[0], range[1]);
        for (auto& slot : slots) {
            glGenVertexArrays(1, &slot.vao);
            glGenBuffers(1, &slot.vbo);
            glBindVertexArray(slot.vao);
            glBindBuffer(GL_ARRAY_BUFFER, slot.vbo);
            glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), nullptr, GL_STREAM_DRAW);
            glEnableVertexAttribArray(0);
            glEnableVertexAttribArray(11);
            glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                                  reinterpret_cast<void*>(offsetof(Vertex, position)));
            glVertexAttribPointer(11, 4, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                                  reinterpret_cast<void*>(offsetof(Vertex, colour)));
        }
        glBindVertexArray(0);
    }
    void draw(const HandTrails& history, TrailMode mode, HandColour colouring) {
        const size_t count = history.write_segments(segments, mode, colouring);
        if (!count)
            return;
        Slot* available = nullptr;
        for (size_t i = 0; i < slots.size(); ++i) {
            auto index = (next_slot + i) % slots.size();
            auto& slot = slots[index];
            if (slot.fence) {
                const auto state = glClientWaitSync(slot.fence, 0, 0);
                if (state != GL_ALREADY_SIGNALED && state != GL_CONDITION_SATISFIED)
                    continue;
                glDeleteSync(slot.fence);
                slot.fence = nullptr;
            }
            available = &slot;
            next_slot = (index + 1) % slots.size();
            break;
        }
        if (!available)
            return;
        for (size_t i = 0; i < count; ++i) {
            const auto& segment = segments[i];
            const float opacity = mode == TrailMode::hand ? .85f : .55f;
            vertices[i * 2] = {segment.from,
                               {segment.from_colour[0], segment.from_colour[1],
                                segment.from_colour[2], opacity * segment.from_alpha}};
            vertices[i * 2 + 1] = {segment.to,
                                   {segment.to_colour[0], segment.to_colour[1],
                                    segment.to_colour[2], opacity * segment.to_alpha}};
        }
        glBindVertexArray(available->vao);
        glBindBuffer(GL_ARRAY_BUFFER, available->vbo);
        glBufferSubData(GL_ARRAY_BUFFER, 0, count * 2 * sizeof(Vertex), vertices.data());
        glDepthMask(GL_FALSE);
        glLineWidth(width);
        glDrawArrays(GL_LINES, 0, static_cast<GLsizei>(count * 2));
        glLineWidth(1.f);
        glDepthMask(GL_TRUE);
        available->fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    }
    ~TrailMesh() {
        for (auto& slot : slots) {
            if (slot.fence)
                glDeleteSync(slot.fence);
            if (slot.vbo)
                glDeleteBuffers(1, &slot.vbo);
            if (slot.vao)
                glDeleteVertexArrays(1, &slot.vao);
        }
    }
};
glm::mat4 pose_transform(const float* v) {
    auto q = glm::quat(v[6], v[3], v[4], v[5]);
    if (glm::length(q) < .5f)
        q = {1, 0, 0, 0};
    return glm::translate(glm::mat4(1), glm::vec3(v[0], v[1], v[2])) *
           glm::toMat4(glm::normalize(q));
}
Calibration decoded_calibration(const Calibration& source, int width, int height) {
    source.validate();
    if (width < 32 || height < 32 || width % 2 || height % 2 || width > source.width ||
        height > source.height)
        throw std::runtime_error("Stereo " + source.side +
                                 " camera requires even decoded dimensions within its calibration");
    const double sx = double(width) / source.width, sy = double(height) / source.height;
    // Encoder dimensions can round a uniform scale to the nearest integer pixel.
    if (std::abs(width - source.width * sy) > 1.0 || std::abs(height - source.height * sx) > 1.0)
        throw std::runtime_error("Stereo " + source.side + " image aspect ratio changed from " +
                                 std::to_string(source.width) + "x" +
                                 std::to_string(source.height) + " to " + std::to_string(width) +
                                 "x" + std::to_string(height) +
                                 ". Load measured calibration for this image format");
    Calibration scaled = source;
    scaled.width = width;
    scaled.height = height;
    scaled.fx *= sx;
    scaled.fy *= sy;
    scaled.cx = (scaled.cx + .5) * sx - .5;
    scaled.cy = (scaled.cy + .5) * sy - .5;
    return scaled;
}
std::optional<std::array<float, 7>> associated_head(const SessionEvent& frame) {
    const auto values = frame.attributes.find("head_pose");
    if (values == frame.attributes.end() || !values->is_array() || values->size() != 7)
        return std::nullopt;
    std::array<float, 7> head{};
    for (size_t i = 0; i < head.size(); ++i) {
        if (!(*values)[i].is_number())
            return std::nullopt;
        head[i] = (*values)[i].get<float>();
        if (!std::isfinite(head[i]))
            return std::nullopt;
    }
    const float norm_squared =
        head[3] * head[3] + head[4] * head[4] + head[5] * head[5] + head[6] * head[6];
    if (std::abs(norm_squared - 1.f) > .02f)
        return std::nullopt;
    const float norm = std::sqrt(norm_squared);
    for (size_t i = 3; i < head.size(); ++i)
        head[i] /= norm;
    return head;
}
struct StereoBuffers {
    struct Slot {
        GLuint vao = 0, vbo = 0;
        cudaGraphicsResource_t resource = nullptr;
        cudaEvent_t started = nullptr, ready = nullptr;
        GLsync fence = nullptr;
        bool pending = false;
        bool reconstruction = true;
        uint64_t generation = 0, serial = 0;
        std::array<VideoFrameLease, 2> leases;
        uint16_t* depth_upload = nullptr;
        int64_t depth_submitted_us = 0;
        int64_t fade_observation_us = -1;
        float fade_interval_seconds = .1f;
        SessionEvent frame;
    };
    std::array<Slot, 3> slots{};
    cudaStream_t stream = nullptr;
    std::unique_ptr<StereoGpuWorkspace> workspace;
    std::unique_ptr<StereoVoxelVolume> volume;
    StereoPoint* reconstructed = nullptr;
    uint16_t* depth_samples = nullptr;
    int width = 0, height = 0, current = -1;
    uint64_t generation = 1, serial = 0, displayed = 0;
    double milliseconds = 0;
    DepthPipelineTiming depth_timing;
    std::optional<StereoCalibration> calibration;
    float min_depth = 0, max_depth = 0, voxel_size = 0;
    std::array<SessionEvent, 2> submitted;
    bool have_submission = false;
    bool reset_volume = true;
    std::optional<int64_t> time_origin_us;
    int64_t last_observation_us = 0;
    VoxelLodConfig lod_view{}, published_lod_view{};
    bool adaptive_lod = true, published_adaptive_lod = true, have_lod_snapshot = false;
    int64_t last_lod_refresh_us = 0;
    bool frozen = false;
    size_t maximum_points = stereo_voxel_initial_capacity, occupied_points = 0;
    size_t failed_capacity = 0;
    int64_t capacity_retry_after_us = 0;
    std::string capacity_error;
    SceneBounds scene_bounds;
    uint64_t content_generation = 1;
    std::optional<glm::vec3> colour_origin;
    int64_t display_time_us = 0, display_wall_us = 0;
    std::optional<int64_t> cadence_observation_us;
    float update_interval_seconds = .1f, long_interval_seconds = 0;
    unsigned cadence_samples = 0;
    int64_t fade_observation_us = -1, fade_wall_us = 0;
    float fade_interval_seconds = .1f;
    struct Readback {
        SpatialMapPoint* device = nullptr;
        SpatialMapPoint* host = nullptr;
        cudaEvent_t ready = nullptr;
        std::shared_ptr<SpatialMapSnapshot> result;
        bool pending = false;
        uint64_t geometry_generation = 0;
        size_t capacity = 0;
    } readback;
    struct ImportUpload {
        SpatialMapPoint* device = nullptr;
        SpatialMapPoint* host = nullptr;
        cudaEvent_t ready = nullptr;
        bool pending = false;
        size_t capacity = 0;
    } import_upload;

    void observe_cadence(int64_t observation_us, float initial_interval) {
        if (!cadence_observation_us) {
            update_interval_seconds = initial_interval;
        } else if (observation_us > *cadence_observation_us) {
            const float interval = float(double(observation_us - *cadence_observation_us) / 1000000.0);
            // One long pause does not redefine capture cadence. Two consecutive
            // intervals at a slower rate do, including deliberately slow updates.
            if (cadence_samples >= 2 && interval > 4.f * update_interval_seconds) {
                if (long_interval_seconds > 0 && std::abs(interval - long_interval_seconds) < .25f * interval) {
                    update_interval_seconds = interval;
                    long_interval_seconds = 0;
                } else {
                    long_interval_seconds = interval;
                }
            } else {
                update_interval_seconds = interval;
                long_interval_seconds = 0;
            }
        } else {
            return;
        }
        cadence_observation_us = observation_us;
        ++cadence_samples;
    }
    void capture_fade_clock(Slot& slot) const {
        slot.fade_observation_us = cadence_observation_us.value_or(-1);
        slot.fade_interval_seconds = update_interval_seconds;
    }
    std::pair<float, float> fade_timing(double playback_rate) const {
        if (fade_observation_us < 0 || !time_origin_us)
            return {0.f, 0.f};
        const auto rate = std::isfinite(playback_rate) && playback_rate > 0 ? playback_rate : 1.;
        const auto elapsed = double(std::max<int64_t>(0, monotonic_us() - fade_wall_us)) / 1000000.0;
        return {float(double(fade_observation_us - *time_origin_us) / 1000000.0 + elapsed * rate),
                fade_interval_seconds};
    }
    void collect_readback() {
        auto& points = readback.result->points;
        points.reserve(readback.capacity);
        for (size_t i = 0; i < readback.capacity; ++i)
            if (readback.host[i].weight)
                points.push_back(readback.host[i]);
        readback.pending = false;
    }
    static void release_slots(std::array<Slot, 3>& buffers) {
        for (auto& slot : buffers) {
            if (slot.fence) {
                glClientWaitSync(slot.fence, GL_SYNC_FLUSH_COMMANDS_BIT, 1000000000);
                glDeleteSync(slot.fence);
            }
            if (slot.resource)
                cudaGraphicsUnregisterResource(slot.resource);
            if (slot.started)
                cudaEventDestroy(slot.started);
            if (slot.ready)
                cudaEventDestroy(slot.ready);
            if (slot.vbo)
                glDeleteBuffers(1, &slot.vbo);
            if (slot.vao)
                glDeleteVertexArrays(1, &slot.vao);
            cudaFreeHost(slot.depth_upload);
            slot = {};
        }
    }
    static std::array<Slot, 3> create_slots(size_t capacity, bool depth_upload) {
        std::array<Slot, 3> buffers{};
        try {
            for (auto& slot : buffers) {
                glGenVertexArrays(1, &slot.vao);
                glGenBuffers(1, &slot.vbo);
                glBindVertexArray(slot.vao);
                glBindBuffer(GL_ARRAY_BUFFER, slot.vbo);
                const auto bytes = GLsizeiptr(capacity * (sizeof(SpatialMapPoint) + sizeof(float)));
                glBufferData(GL_ARRAY_BUFFER, bytes, nullptr, GL_DYNAMIC_DRAW);
                GLint64 allocated = 0;
                glGetBufferParameteri64v(GL_ARRAY_BUFFER, GL_BUFFER_SIZE, &allocated);
                if (allocated != bytes)
                    throw std::runtime_error("Cannot allocate spatial map display buffer");
                for (const auto location : {0u, 11u, 12u, 13u, 14u, 15u})
                    glEnableVertexAttribArray(location);
                glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(SpatialMapPoint), nullptr);
                glVertexAttribPointer(11, 4, GL_FLOAT, GL_FALSE, sizeof(SpatialMapPoint),
                                      reinterpret_cast<void*>(offsetof(SpatialMapPoint, r)));
                glVertexAttribPointer(12, 1, GL_FLOAT, GL_FALSE, sizeof(SpatialMapPoint),
                                      reinterpret_cast<void*>(offsetof(SpatialMapPoint, cell_size)));
                glVertexAttribIPointer(13, 2, GL_UNSIGNED_INT, sizeof(SpatialMapPoint),
                                       reinterpret_cast<void*>(offsetof(SpatialMapPoint, observed_us)));
                glVertexAttribIPointer(14, 2, GL_UNSIGNED_INT, sizeof(SpatialMapPoint),
                                       reinterpret_cast<void*>(offsetof(SpatialMapPoint, weight)));
                glVertexAttribPointer(15, 1, GL_FLOAT, GL_FALSE, sizeof(float),
                                      reinterpret_cast<void*>(capacity * sizeof(SpatialMapPoint)));
                cuda_check(cudaGraphicsGLRegisterBuffer(&slot.resource, slot.vbo,
                                                        cudaGraphicsRegisterFlagsWriteDiscard),
                           "Register spatial map display buffer");
                cuda_check(cudaEventCreate(&slot.started), "Create spatial map start event");
                cuda_check(cudaEventCreate(&slot.ready), "Create spatial map completion event");
                if (depth_upload)
                    cuda_check(cudaHostAlloc(&slot.depth_upload, 256 * 256 * sizeof(uint16_t),
                                             cudaHostAllocDefault), "Allocate environment depth upload");
            }
            glBindVertexArray(0);
        } catch (...) {
            release_slots(buffers);
            throw;
        }
        return buffers;
    }
    void reserve(size_t required) {
        if (!volume || required <= volume->capacity())
            return;
        if (failed_capacity == required && monotonic_us() < capacity_retry_after_us)
            throw std::runtime_error(capacity_error);
        const auto capacity = std::bit_ceil(required);
        // Budget changes are infrequent explicit operations. Retire old CUDA
        // leases and GL draws before replacing their presentation allocations.
        cuda_check(cudaStreamSynchronize(stream), "Retire spatial map buffers");
        poll();
        if (readback.pending)
            collect_readback();
        std::array<Slot, 3> replacement{};
        try {
            replacement = create_slots(capacity, depth_samples != nullptr);
            cuda_check(volume->reserve(capacity, stream), "Grow spatial map capacity");
        } catch (const std::exception& error) {
            release_slots(replacement);
            failed_capacity = required;
            capacity_retry_after_us = monotonic_us() + 30000000;
            capacity_error = error.what();
            throw;
        }
        failed_capacity = 0;
        capacity_error.clear();
        glFinish();
        release_slots(slots);
        slots = std::move(replacement);
        current = -1;
        displayed = 0;
        have_lod_snapshot = false;
        last_lod_refresh_us = 0;
        cudaFree(readback.device);
        cudaFreeHost(readback.host);
        readback.device = nullptr;
        readback.host = nullptr;
        readback.capacity = 0;
        cudaFree(import_upload.device);
        cudaFreeHost(import_upload.host);
        import_upload.device = nullptr;
        import_upload.host = nullptr;
        import_upload.capacity = 0;
        import_upload.pending = false;
    }
    void configure(bool freeze, float spacing, size_t budget) {
        frozen = freeze;
        const bool resolution_changed = voxel_size != spacing;
        const bool budget_changed = maximum_points != budget;
        if (!resolution_changed && !budget_changed)
            return;
        if (volume) {
            if (budget > volume->capacity())
                reserve(budget);
            else if (budget_changed) {
                failed_capacity = 0;
                capacity_error.clear();
            }
            if (resolution_changed && !reset_volume)
                cuda_check(volume->reconfigure(spacing, stream), "Change spatial map spacing");
            if (budget_changed)
                cuda_check(volume->set_max_points(budget, stream), "Change spatial map budget");
        }
        voxel_size = spacing;
        maximum_points = budget;
        have_lod_snapshot = false;
        last_lod_refresh_us = 0;
        ++content_generation;
    }
    bool request_snapshot(std::shared_ptr<SpatialMapSnapshot> result) {
        if (readback.result)
            return false;
        result->time_origin_us = time_origin_us.value_or(0);
        result->generation = content_generation;
        result->base_voxel_size = voxel_size > 0 ? voxel_size : .03f;
        readback.geometry_generation = generation;
        if (!volume || reset_volume) {
            readback.result = std::move(result);
            return true;
        }
        const auto bytes = volume->capacity() * sizeof(SpatialMapPoint);
        if (!readback.device)
            cuda_check(cudaMalloc(&readback.device, bytes), "Allocate spatial map readback");
        if (!readback.host)
            cuda_check(cudaHostAlloc(&readback.host, bytes, cudaHostAllocDefault),
                       "Allocate spatial map host readback");
        if (!readback.ready)
            cuda_check(cudaEventCreateWithFlags(&readback.ready, cudaEventDisableTiming),
                       "Create spatial map readback event");
        readback.capacity = volume->capacity();
        try {
            cuda_check(volume->snapshot_metadata(readback.device, result->time_origin_us, stream),
                       "Read spatial map geometry");
            cuda_check(cudaMemcpyAsync(readback.host, readback.device, bytes, cudaMemcpyDeviceToHost,
                                       stream), "Read spatial map metadata");
            cuda_check(cudaEventRecord(readback.ready, stream), "Complete spatial map readback");
        } catch (...) {
            // An enqueue can fail after earlier work has retained these buffers.
            // Retire that work before an error recovery can reuse either buffer.
            cudaStreamSynchronize(stream);
            throw;
        }
        readback.result = std::move(result);
        readback.pending = true;
        return true;
    }
    std::shared_ptr<SpatialMapSnapshot> take_snapshot() {
        if (!readback.result)
            return {};
        if (readback.pending) {
            const auto ready = cudaEventQuery(readback.ready);
            if (ready == cudaErrorNotReady)
                return {};
            cuda_check(ready, "Complete spatial map readback");
            collect_readback();
        }
        if (readback.geometry_generation == generation) {
            occupied_points = readback.result->points.size();
            scene_bounds = {};
            for (const auto& point : readback.result->points)
                scene_bounds.include(glm::vec3(point.x, point.y, point.z));
        }
        return std::exchange(readback.result, {});
    }
    bool restore_snapshot(const SpatialMapSnapshot& source) {
        if (import_upload.pending) {
            const auto ready = cudaEventQuery(import_upload.ready);
            if (ready == cudaErrorNotReady)
                return false;
            cuda_check(ready, "Complete spatial map import");
            import_upload.pending = false;
        }
        initialise_volume();
        reserve(source.points.size());
        const auto bytes = volume->capacity() * sizeof(SpatialMapPoint);
        if (!import_upload.device)
            cuda_check(cudaMalloc(&import_upload.device, bytes), "Allocate spatial map import");
        if (!import_upload.host)
            cuda_check(cudaHostAlloc(&import_upload.host, bytes, cudaHostAllocDefault),
                       "Allocate spatial map host import");
        if (!import_upload.ready)
            cuda_check(cudaEventCreateWithFlags(&import_upload.ready, cudaEventDisableTiming),
                       "Create spatial map import event");
        import_upload.capacity = volume->capacity();
        std::copy(source.points.begin(), source.points.end(), import_upload.host);
        try {
            if (!source.points.empty())
                cuda_check(cudaMemcpyAsync(import_upload.device, import_upload.host,
                                           source.points.size() * sizeof(SpatialMapPoint),
                                           cudaMemcpyHostToDevice, stream), "Upload saved spatial map");
            cuda_check(volume->restore(import_upload.device, source.points.size(), source.base_voxel_size,
                                        source.time_origin_us, stream), "Restore saved spatial map");
            cuda_check(cudaEventRecord(import_upload.ready, stream), "Complete spatial map import");
        } catch (...) {
            cudaStreamSynchronize(stream);
            throw;
        }
        import_upload.pending = true;
        clear(true);
        reset_volume = false;
        time_origin_us = source.time_origin_us;
        voxel_size = source.base_voxel_size;
        submitted[0] = {};
        submitted[0].epoch = source.epoch;
        submitted[0].space_epoch = source.space_epoch;
        have_submission = true;
        occupied_points = source.points.size();
        last_observation_us = source.time_origin_us;
        for (const auto& point : source.points) {
            last_observation_us = std::max(last_observation_us, point.observed_us);
            scene_bounds.include(glm::vec3(point.x, point.y, point.z));
        }
        display_time_us = last_observation_us;
        display_wall_us = monotonic_us();
        return true;
    }

    cudaError_t snapshot(SpatialMapPoint* output) {
        const auto origin = time_origin_us.value_or(0);
        auto* births = reinterpret_cast<float*>(output + volume->capacity());
        const auto result = adaptive_lod ? volume->snapshot_metadata_lod(output, lod_view, origin, stream, births)
                                         : volume->snapshot_metadata(output, origin, stream, births);
        if (result == cudaSuccess) {
            published_lod_view = lod_view;
            published_adaptive_lod = adaptive_lod;
            have_lod_snapshot = true;
            last_lod_refresh_us = monotonic_us();
        }
        return result;
    }
    void refresh_lod(const glm::vec3& eye, float focal_pixels, bool enabled) {
        std::copy_n(glm::value_ptr(eye), 3, lod_view.view_position);
        lod_view.focal_length_pixels = focal_pixels;
        // Display aggregation may combine subpixel samples. Spatial confidence
        // controls evidence detail independently of the desktop camera position.
        lod_view.target_pixels = .75f;
        adaptive_lod = enabled;
        float motion_squared = 0;
        for (int i = 0; i < 3; ++i) {
            const float delta = lod_view.view_position[i] - published_lod_view.view_position[i];
            motion_squared += delta * delta;
        }
        const bool changed = !have_lod_snapshot || enabled != published_adaptive_lod ||
                             (enabled && (motion_squared > .000225f ||
                                          std::abs(focal_pixels - published_lod_view.focal_length_pixels) > 1));
        const auto now = monotonic_us();
        if (!changed || !volume || reset_volume || !have_submission ||
            now - last_lod_refresh_us < 50000)
            return;
        for (size_t i = 0; i < slots.size(); ++i) {
            auto& slot = slots[i];
            if (int(i) == current || slot.pending)
                continue;
            if (slot.fence) {
                const auto state = glClientWaitSync(slot.fence, 0, 0);
                if (state != GL_ALREADY_SIGNALED && state != GL_CONDITION_SATISFIED)
                    continue;
                glDeleteSync(slot.fence);
                slot.fence = nullptr;
            }
            bool mapped = false;
            try {
                cuda_check(cudaGraphicsMapResources(1, &slot.resource, stream), "Map detail buffer");
                mapped = true;
                SpatialMapPoint* output = nullptr;
                size_t bytes = 0;
                cuda_check(cudaGraphicsResourceGetMappedPointer(reinterpret_cast<void**>(&output),
                                                                &bytes, slot.resource),
                           "Access detail buffer");
                if (bytes < volume->capacity() * (sizeof(SpatialMapPoint) + sizeof(float)))
                    throw std::runtime_error("Detail buffer is too small");
                cuda_check(cudaEventRecord(slot.started, stream), "Start detail update");
                cuda_check(snapshot(output), "Update world detail");
                cuda_check(cudaGraphicsUnmapResources(1, &slot.resource, stream), "Release detail buffer");
                mapped = false;
                cuda_check(cudaEventRecord(slot.ready, stream), "Complete detail update");
            } catch (...) {
                if (mapped)
                    cudaGraphicsUnmapResources(1, &slot.resource, stream);
                throw;
            }
            slot.pending = true;
            slot.reconstruction = false;
            slot.generation = generation;
            slot.serial = ++serial;
            slot.frame = submitted[0];
            capture_fade_clock(slot);
            return;
        }
    }

    void clear(bool force = false) {
        if (frozen && !force)
            return;
        ++generation;
        ++content_generation;
        current = -1;
        displayed = 0;
        have_submission = false;
        reset_volume = true;
        time_origin_us.reset();
        last_observation_us = 0;
        have_lod_snapshot = false;
        last_lod_refresh_us = 0;
        occupied_points = 0;
        scene_bounds = {};
        colour_origin.reset();
        display_time_us = display_wall_us = 0;
        cadence_observation_us.reset();
        cadence_samples = 0;
        update_interval_seconds = fade_interval_seconds = .1f;
        long_interval_seconds = 0;
        fade_observation_us = -1;
        fade_wall_us = 0;
        depth_timing = {};
    }
    void poll() {
        for (size_t i = 0; i < slots.size(); ++i) {
            auto& slot = slots[i];
            if (!slot.pending)
                continue;
            const auto state = cudaEventQuery(slot.ready);
            if (state == cudaErrorNotReady)
                continue;
            cuda_check(state, "Complete stereo reconstruction");
            slot.pending = false;
            slot.leases = {};
            if (slot.generation == generation && slot.serial > displayed) {
                float elapsed = 0;
                cuda_check(cudaEventElapsedTime(&elapsed, slot.started, slot.ready),
                           "Measure stereo reconstruction");
                if (slot.reconstruction)
                    milliseconds = elapsed;
                if (slot.reconstruction && slot.frame.kind == EventKind::Depth &&
                    slot.depth_submitted_us > 0) {
                    const auto& attributes = slot.frame.attributes;
                    depth_timing = {};
                    depth_timing.valid = true;
                    depth_timing.replay = attributes.contains("replay_generation");
                    depth_timing.sequence = slot.frame.sequence;
                    depth_timing.geometry_source = attributes.value("geometry_source", std::string{});
                    if (attributes.contains("readback_us"))
                        depth_timing.readback_ms = attributes.at("readback_us").get<double>() / 1000.;
                    if (attributes.contains("target_lead_us"))
                        depth_timing.target_lead_ms = attributes.at("target_lead_us").get<double>() / 1000.;
                    if (attributes.value("clock_valid", false) &&
                        attributes.contains("mapped_observed_us") &&
                        attributes.at("mapped_observed_us").is_number()) {
                        const auto arrival = attributes.value("recorded_receive_us", slot.frame.receive_us);
                        depth_timing.callback_to_arrival_ms =
                            (double(arrival) - attributes.at("mapped_observed_us").get<double>()) / 1000.;
                    }
                    depth_timing.arrival_to_submit_ms =
                        double(slot.depth_submitted_us -
                               attributes.value("replay_delivery_us", slot.frame.receive_us)) / 1000.;
                    depth_timing.submit_to_ready_ms = double(monotonic_us() - slot.depth_submitted_us) / 1000.;
                    depth_timing.gpu_ms = elapsed;
                }
                current = int(i);
                displayed = slot.serial;
                if (slot.fade_observation_us >= 0 && slot.fade_observation_us != fade_observation_us) {
                    fade_observation_us = slot.fade_observation_us;
                    fade_interval_seconds = slot.fade_interval_seconds;
                    fade_wall_us = monotonic_us();
                }
            }
        }
    }
    void release() {
        // Resource changes and teardown may wait. Normal frame submission never does.
        if (stream)
            cudaStreamSynchronize(stream);
        cudaFree(readback.device);
        cudaFreeHost(readback.host);
        if (readback.ready)
            cudaEventDestroy(readback.ready);
        readback = {};
        cudaFree(import_upload.device);
        cudaFreeHost(import_upload.host);
        if (import_upload.ready)
            cudaEventDestroy(import_upload.ready);
        import_upload = {};
        release_slots(slots);
        workspace.reset();
        volume.reset();
        cudaFree(reconstructed);
        reconstructed = nullptr;
        cudaFree(depth_samples);
        depth_samples = nullptr;
        width = height = 0;
        clear(true);
    }
    void resize(int w, int h) {
        try {
            if (!stream)
                cuda_check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking),
                           "Create stereo stream");
            // Decoder resolution changes replace scratch storage, while the world
            // volume and its registered presentation buffers remain resident.
            if (workspace) {
                cuda_check(cudaStreamSynchronize(stream), "Retire stereo scratch storage");
                poll();
                workspace.reset();
                cudaFree(reconstructed);
                reconstructed = nullptr;
            }
            width = w;
            height = h;
            workspace = std::make_unique<StereoGpuWorkspace>(w, h);
            cuda_check(cudaMalloc(&reconstructed, size_t(w) * h * sizeof(StereoPoint)),
                       "Allocate stereo reconstruction scratch");
            initialise_volume();
        } catch (...) {
            release();
            throw;
        }
    }
    void initialise_volume() {
        if (volume)
            return;
        if (failed_capacity == maximum_points && monotonic_us() < capacity_retry_after_us)
            throw std::runtime_error(capacity_error);
        if (!stream)
            cuda_check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking),
                       "Create spatial map stream");
        try {
            auto initial = std::make_unique<StereoVoxelVolume>(std::bit_ceil(maximum_points));
            cuda_check(initial->set_max_points(maximum_points, stream), "Set spatial map budget");
            auto presentation = create_slots(initial->capacity(), false);
            volume = std::move(initial);
            slots = std::move(presentation);
        } catch (const std::exception& error) {
            cudaStreamSynchronize(stream);
            failed_capacity = maximum_points;
            capacity_retry_after_us = monotonic_us() + 30000000;
            capacity_error = error.what();
            throw;
        }
        failed_capacity = 0;
        capacity_error.clear();
        reset_volume = true;
    }
    void prepare_depth() {
        if (depth_samples)
            return;
        try {
            if (!stream)
                cuda_check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking),
                           "Create environment depth stream");
            cuda_check(cudaMalloc(&depth_samples, 256 * 256 * sizeof(uint16_t)),
                       "Allocate environment depth samples");
            cuda_check(cudaMalloc(&reconstructed, 256 * 256 * sizeof(StereoPoint)),
                       "Allocate environment depth points");
            initialise_volume();
            for (auto& slot : slots)
                cuda_check(cudaHostAlloc(&slot.depth_upload, 256 * 256 * sizeof(uint16_t),
                                         cudaHostAllocDefault),
                           "Allocate environment depth upload");
        } catch (...) {
            release();
            throw;
        }
    }
    ~StereoBuffers() {
        release();
        if (stream)
            cudaStreamDestroy(stream);
    }
};
} // namespace
struct Renderer::Impl {
    GLFWwindow* window;
    GLuint shader = 0;
    std::unique_ptr<detail::SpatialMapProgram> map_shader;
    GLuint offscreen_framebuffer = 0, offscreen_colour = 0, offscreen_depth = 0;
    int offscreen_width = 0, offscreen_height = 0;
    bool offscreen = false;
    Mesh left, right, sphere, cube, grid, plane, headset;
    HandTrails hand_trails;
    TrailMesh trail_mesh;
    HandAssets hand_assets;
    std::optional<StaticModel> headset_asset;
    std::filesystem::path local_assets;
    bool replay_assets = false;
    std::array<GLuint, 3> headset_textures{};
    std::array<detail::HandPresentation, 2> hand_presentation;
    std::array<bool, 2> hand_drawn{}, hand_mesh{};
    std::array<std::optional<uint32_t>, 2> drawn_hand_sequence, drawn_camera_sequence;
    std::array<uint64_t, 2> hand_update_count{}, hand_updates_without_video{};
    glm::vec3 target{0, 1.5f, -.45f}, eye{};
    SceneReference scene_reference = SceneReference::world;
    SceneView scene_view = SceneView::orbit;
    std::array<SceneBounds, 4> reference_bounds;
    glm::vec3 reference_offset{0, 1.5f, -.45f};
    std::optional<glm::mat4> headset_camera;
    std::optional<glm::mat4> current_headset_transform;
    std::optional<glm::vec3> headset_origin;
    uint32_t headset_epoch = 0, headset_space_epoch = 0;
    float yaw = .48f, pitch = .23f, distance = 1.85f;
    float scene_width_fraction = 1;
    float scene_top_fraction = 0;
    float scene_bottom_fraction = 0;
    bool first_mouse = true;
    std::array<bool, 3> mouse_down{}, scene_drag{};
    double mx = 0, my = 0;
    struct Texture {
        GLuint id = 0;
        cudaGraphicsResource_t resource = nullptr;
        cudaEvent_t ready = nullptr;
        cudaSurfaceObject_t surface = 0;
        GLsync fence = nullptr;
        bool pending = false;
        VideoFrameLease lease;
        SessionEvent metadata;
    };
    struct Camera {
        std::array<Texture, 3> textures{};
        int width = 0, height = 0, current = -1;
        int64_t uploaded_time = -1;
        uint32_t uploaded_seq = 0;
        Calibration converted_calibration;
        bool converted_undistort = false, have_conversion = false;
        SessionEvent presented;
    };
    std::array<Camera, 2> cameras{};
    StereoBuffers stereo, environment, saved;
    SavedMapState saved_state;
    SpatialMapSnapshot saved_metadata;
    int64_t saved_input_anchor_us = 0, saved_clock_anchor_us = 0;
    std::optional<uint64_t> saved_replay_generation;
    cudaEvent_t saved_input_ready = nullptr, saved_fusion_ready = nullptr;
    cudaStream_t stream = nullptr;
    int device = 0;
    uint64_t count = 0;
    std::array<std::optional<PoseSample>, 3> held;
    std::array<detail::TrackingVisibility, 3> tracking_visibility;
    std::array<bool, 3> fresh{};
    uint32_t epoch = 0, space_epoch = 0;
    float pose_time_offset_ms = 0;
    GLuint queries[4]{};
    uint64_t frame = 0, notified_count = 0;
    bool query_open = false;
    double gpu = 0, latency = 0;
    explicit Impl(GLFWwindow* w, const std::filesystem::path& assets)
        : window(w), local_assets(assets) {
        offscreen = glfwGetWindowAttrib(window, GLFW_VISIBLE) == GLFW_FALSE;
        unsigned n = 0;
        int devs[8]{};
        cuda_check(cudaGLGetDevices(&n, devs, 8, cudaGLDeviceListAll),
                   "Match NVIDIA graphics and CUDA device");
        if (!n)
            throw std::runtime_error("No NVIDIA CUDA device owns this OpenGL window");
        device = devs[0];
        cuda_check(cudaSetDevice(device), "Select rendering GPU");
        cuda_check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking),
                   "Create image stream");
        shader = program();
        map_shader = std::make_unique<detail::SpatialMapProgram>();
        trail_mesh.initialise();
        hand_assets = std::filesystem::exists(assets / "local" / "mano" / "mano-left.json")
                          ? load_mano_assets(assets / "local" / "mano")
                          : load_hand_assets(assets / "hands");
        left.upload(hand_assets.meshes[0]);
        right.upload(hand_assets.meshes[1]);
        if (std::filesystem::exists(assets / "quest3" / "model.json"))
            set_headset(load_static_model(assets / "quest3"));
        sphere.upload(sphere_mesh());
        cube.upload(cube_mesh());
        MeshData g;
        for (int i = -30; i <= 30; ++i) {
            for (auto v : std::array<glm::vec3, 4>{{{float(i) * .1f, 0, -3},
                                                    {float(i) * .1f, 0, 3},
                                                    {-3, 0, float(i) * .1f},
                                                    {3, 0, float(i) * .1f}}}) {
                Vertex a;
                a.position = v;
                g.indices.push_back(static_cast<uint32_t>(g.vertices.size()));
                g.vertices.push_back(a);
            }
        }
        grid.upload(g, GL_LINES);
        MeshData p;
        for (auto uv : std::array<glm::vec2, 4>{{{0, 0}, {1, 0}, {1, 1}, {0, 1}}}) {
            Vertex v;
            v.position = {uv.x, uv.y, 0};
            v.uv = uv;
            v.normal = {0, 0, 1};
            p.vertices.push_back(v);
        }
        p.indices = {0, 1, 2, 0, 2, 3};
        plane.upload(p);
        glGenQueries(4, queries);
        glEnable(GL_DEPTH_TEST);
        glDisable(GL_CULL_FACE);
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    }
    void set_headset(StaticModel asset) {
        headset.upload(asset.mesh);
        glDeleteTextures(3, headset_textures.data());
        headset_textures = {};
        for (size_t i = 0; i < headset_textures.size(); ++i) {
            const auto& image = asset.textures[i];
            if (image.rgba.empty())
                continue;
            glGenTextures(1, &headset_textures[i]);
            glBindTexture(GL_TEXTURE_2D, headset_textures[i]);
            glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
            glTexImage2D(GL_TEXTURE_2D, 0, i == 0 ? GL_SRGB8_ALPHA8 : GL_RGBA8, image.width,
                         image.height, 0, GL_RGBA, GL_UNSIGNED_BYTE, image.rgba.data());
            glGenerateMipmap(GL_TEXTURE_2D);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
        }
        headset_asset = std::move(asset);
    }
    void clear_textures(Camera& camera) {
        if (stream)
            cudaStreamSynchronize(stream);
        for (auto& t : camera.textures) {
            if (t.fence) {
                glClientWaitSync(t.fence, GL_SYNC_FLUSH_COMMANDS_BIT, 1000000000);
                glDeleteSync(t.fence);
            }
            if (t.surface)
                cudaDestroySurfaceObject(t.surface);
            if (t.resource)
                cudaGraphicsUnregisterResource(t.resource);
            if (t.ready)
                cudaEventDestroy(t.ready);
            if (t.id)
                glDeleteTextures(1, &t.id);
            t = {};
        }
        camera.current = -1;
        camera.uploaded_time = -1;
        camera.have_conversion = false;
        camera.presented = {};
    }
    ~Impl() {
        if (saved.stream)
            cudaStreamSynchronize(saved.stream);
        if (saved_input_ready)
            cudaEventDestroy(saved_input_ready);
        if (saved_fusion_ready)
            cudaEventDestroy(saved_fusion_ready);
        if (query_open)
            glEndQuery(GL_TIME_ELAPSED);
        for (auto& camera : cameras)
            clear_textures(camera);
        if (stream)
            cudaStreamDestroy(stream);
        glDeleteQueries(4, queries);
        glDeleteTextures(3, headset_textures.data());
        glDeleteFramebuffers(1, &offscreen_framebuffer);
        glDeleteRenderbuffers(1, &offscreen_colour);
        glDeleteRenderbuffers(1, &offscreen_depth);
        if (shader)
            glDeleteProgram(shader);
    }
    void bind_target(int w, int h) {
        if (!offscreen)
            return;
        // Hidden native windows do not always have a readable default framebuffer.
        if (!offscreen_framebuffer) {
            glCreateFramebuffers(1, &offscreen_framebuffer);
            glCreateRenderbuffers(1, &offscreen_colour);
            glCreateRenderbuffers(1, &offscreen_depth);
        }
        if (w != offscreen_width || h != offscreen_height) {
            glNamedRenderbufferStorage(offscreen_colour, GL_RGBA8, w, h);
            glNamedRenderbufferStorage(offscreen_depth, GL_DEPTH_COMPONENT24, w, h);
            glNamedFramebufferRenderbuffer(offscreen_framebuffer, GL_COLOR_ATTACHMENT0,
                                           GL_RENDERBUFFER, offscreen_colour);
            glNamedFramebufferRenderbuffer(offscreen_framebuffer, GL_DEPTH_ATTACHMENT,
                                           GL_RENDERBUFFER, offscreen_depth);
            glNamedFramebufferDrawBuffer(offscreen_framebuffer, GL_COLOR_ATTACHMENT0);
            glNamedFramebufferReadBuffer(offscreen_framebuffer, GL_COLOR_ATTACHMENT0);
            if (glCheckNamedFramebufferStatus(offscreen_framebuffer, GL_FRAMEBUFFER) !=
                GL_FRAMEBUFFER_COMPLETE)
                throw std::runtime_error("Cannot create the hidden rendering framebuffer");
            offscreen_width = w;
            offscreen_height = h;
        }
        glBindFramebuffer(GL_FRAMEBUFFER, offscreen_framebuffer);
    }
    void resize(Camera& camera, int w, int h) {
        clear_textures(camera);
        camera.width = w;
        camera.height = h;
        for (auto& t : camera.textures) {
            glGenTextures(1, &t.id);
            glBindTexture(GL_TEXTURE_2D, t.id);
            glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, w, h);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            cuda_check(cudaGraphicsGLRegisterImage(&t.resource, t.id, GL_TEXTURE_2D,
                                                   cudaGraphicsRegisterFlagsSurfaceLoadStore),
                       "Register video texture");
            cuda_check(cudaEventCreateWithFlags(&t.ready, cudaEventDisableTiming),
                       "Create image completion event");
        }
    }
    void set(const char* name, int v) {
        glUniform1i(glGetUniformLocation(shader, name), v);
    }
    void clear_pose_state() {
        hand_trails.clear();
        held = {};
        tracking_visibility = {};
        fresh = {};
        hand_presentation = {};
        hand_drawn = hand_mesh = {};
        drawn_hand_sequence = drawn_camera_sequence = {};
        hand_update_count = hand_updates_without_video = {};
        headset_camera.reset();
        reference_bounds[static_cast<size_t>(SceneReference::hands)] = {};
        reference_bounds[static_cast<size_t>(SceneReference::camera)] = {};
        if (scene_view == SceneView::hmd)
            scene_view = SceneView::orbit;
    }
    void model(const glm::mat4& m, glm::vec4 tint, bool lighting = true) {
        glUniformMatrix4fv(glGetUniformLocation(shader, "model"), 1, GL_FALSE, glm::value_ptr(m));
        glUniform4fv(glGetUniformLocation(shader, "tint"), 1, glm::value_ptr(tint));
        set("skinned", 0);
        set("hand_colouring", -1);
        set("lit", lighting ? 1 : 0);
        set("textured", 0);
    }
    glm::vec3 direction() const {
        return glm::vec3(std::cos(pitch) * std::sin(yaw), std::sin(pitch),
                         std::cos(pitch) * std::cos(yaw));
    }
    glm::vec3 view_up() const {
        if (scene_view == SceneView::hmd && headset_camera)
            return glm::vec3((*headset_camera)[1]);
        return std::abs(direction().y) > .999f ? glm::vec3(0, 0, -1) : glm::vec3(0, 1, 0);
    }
    void orbit_from_headset() {
        if (scene_view == SceneView::hmd && headset_camera) {
            const auto backward = glm::vec3((*headset_camera)[2]);
            yaw = std::atan2(backward.x, backward.z);
            pitch = std::asin(std::clamp(backward.y, -1.f, 1.f));
            distance = std::max(distance, .5f);
            target = glm::vec3((*headset_camera)[3]) - backward * distance;
            const auto& bounds = reference_bounds[static_cast<size_t>(scene_reference)];
            reference_offset = target - (bounds.valid ? bounds.centre() : glm::vec3(0));
        }
        scene_view = SceneView::orbit;
    }
    void update_scene_references(const ViewOptions& options) {
        reference_bounds = {};
        reference_bounds[static_cast<size_t>(SceneReference::world)].include(glm::vec3(0));
        auto& model = reference_bounds[static_cast<size_t>(SceneReference::model)];
        auto& hands = reference_bounds[static_cast<size_t>(SceneReference::hands)];
        if (options.depth && options.recorded_map_visible)
            model.include((options.environment_depth ? environment : stereo).scene_bounds);
        if (saved_state.loaded && options.saved_map_visible)
            model.include(transformed_bounds(saved.scene_bounds,
                saved_state.placed ? glm::mat4(1.f) : saved_state.world_from_map));
        if (held[0] && finite_pose(held[0]->values.data())) {
            headset_camera = pose_transform(held[0]->values.data());
            const auto position = glm::vec3((*headset_camera)[3]);
            reference_bounds[static_cast<size_t>(SceneReference::camera)].include(position);
            if (options.headset)
                model.include(position);
        } else
            headset_camera.reset();
        if (options.hands) {
            for (int side = 1; side < 3; ++side) {
                const auto& presentation = hand_presentation[side - 1];
                if (!presentation.retained())
                    continue;
                const auto& pose = presentation.pose();
                for (int joint = 0; joint < 25; ++joint) {
                    if (!(pose.joint_mask & (1u << joint)) || presentation.opacity(joint) <= .001f)
                        continue;
                    const auto* values = pose.values.data() + joint * 8;
                    if (finite_pose(values))
                        hands.include(glm::vec3(values[0], values[1], values[2]));
                }
            }
        }
        model.include(hands);
        const auto& bounds = reference_bounds[static_cast<size_t>(scene_reference)];
        if (bounds.valid && scene_view != SceneView::hmd)
            target = bounds.centre() + reference_offset;
        if (scene_view == SceneView::hmd && !headset_camera)
            scene_view = SceneView::orbit;
    }
    void fuse_saved(StereoBuffers& source, const SessionEvent& event, int64_t observation_time_us,
                    size_t point_count, const VoxelGpuConfig& config,
                    const ProjectiveDepthObservation& observation) {
        if (!saved_state.loaded || !saved_state.placed || !saved_state.fusing)
            return;
        const auto replay_generation = event.attributes.value("replay_generation", uint64_t(0));
        if (event.epoch != saved_metadata.epoch || event.space_epoch != saved_metadata.space_epoch ||
            (saved_replay_generation && *saved_replay_generation != replay_generation)) {
            saved_state.fusing = false;
            return;
        }
        // An observation queued before placement belongs to the acquisition
        // layer but must not advance or disable the newly placed saved map.
        if (observation_time_us < saved_input_anchor_us)
            return;
        const auto elapsed = observation_time_us - saved_input_anchor_us;
        if (elapsed > std::numeric_limits<int64_t>::max() - saved_clock_anchor_us) {
            saved_state.fusing = false;
            return;
        }
        const auto map_time = saved_clock_anchor_us + elapsed;
        if (map_time <= saved.last_observation_us)
            return;
        if (!saved_input_ready)
            cuda_check(cudaEventCreateWithFlags(&saved_input_ready, cudaEventDisableTiming),
                       "Create saved map input event");
        if (!saved_fusion_ready)
            cuda_check(cudaEventCreateWithFlags(&saved_fusion_ready, cudaEventDisableTiming),
                       "Create saved map fusion event");
        auto fusion = config;
        fusion.voxel_size = saved.voxel_size;
        fusion.sample_time_seconds = fusion.now_seconds =
            float(double(map_time - saved.time_origin_us.value_or(0)) / 1000000.0);
        cuda_check(cudaEventRecord(saved_input_ready, source.stream), "Order saved map observations");
        cuda_check(cudaStreamWaitEvent(saved.stream, saved_input_ready, 0), "Wait for saved map observations");
        try {
            cuda_check(saved.volume->integrate_projective(source.reconstructed, point_count, fusion,
                                                          observation, saved.stream),
                       "Fuse observations into saved map");
            cuda_check(cudaEventRecord(saved_fusion_ready, saved.stream), "Complete saved map fusion");
            cuda_check(cudaStreamWaitEvent(source.stream, saved_fusion_ready, 0),
                       "Retain observations until saved map fusion completes");
        } catch (...) {
            cudaStreamSynchronize(saved.stream);
            saved_state.fusing = false;
            throw;
        }
        saved_replay_generation = replay_generation;
        saved.observe_cadence(map_time, source.update_interval_seconds);
        saved.update_interval_seconds = source.update_interval_seconds;
        saved.last_observation_us = map_time;
        saved.submitted[0] = event;
        saved.have_submission = true;
        saved.have_lod_snapshot = false;
        saved.display_time_us = map_time;
        saved.display_wall_us = monotonic_us();
        ++saved.content_generation;
    }
    bool cursor_in_scene(double x, double y) const {
        int w, h;
        glfwGetWindowSize(window, &w, &h);
        return w > 0 && h > 0 && glfwGetWindowAttrib(window, GLFW_ICONIFIED) == GLFW_FALSE &&
               x >= 0 && y >= double(h) * scene_top_fraction &&
               x < double(w) * scene_width_fraction &&
               y < double(h) * (1.f - std::min(scene_bottom_fraction, .95f - scene_top_fraction));
    }
    void segment(glm::vec3 a, glm::vec3 b, float radius, glm::vec4 colour, bool lighting = true) {
        auto d = b - a;
        float len = glm::length(d);
        if (len < 1e-6f)
            return;
        glm::mat4 m = glm::translate(glm::mat4(1), (a + b) * .5f) *
                      glm::toMat4(glm::rotation(glm::vec3(0, 1, 0), d / len)) *
                      glm::scale(glm::mat4(1), glm::vec3(radius, len, radius));
        model(m, colour, lighting);
        cube.draw();
    }
};
Renderer::Renderer(GLFWwindow* w, const std::filesystem::path& assets)
    : impl_(std::make_unique<Impl>(w, assets)) {}
Renderer::~Renderer() = default;
int Renderer::cuda_device() const {
    return impl_->device;
}
void Renderer::set_scene_width_fraction(float fraction) {
    auto& p = *impl_;
    fraction = std::isfinite(fraction) ? std::clamp(fraction, 0.f, 1.f) : 1.f;
    if (p.scene_width_fraction != fraction) {
        p.scene_width_fraction = fraction;
        p.scene_drag = {};
    }
}
void Renderer::reset_view() {
    impl_->target = {0, 1.5f, -.45f};
    impl_->yaw = .48f;
    impl_->pitch = .23f;
    impl_->distance = 1.85f;
    impl_->scene_reference = SceneReference::world;
    impl_->scene_view = SceneView::orbit;
    impl_->reference_offset = impl_->target;
}
void Renderer::set_scene_top_fraction(float fraction) {
    auto& p = *impl_;
    fraction = std::isfinite(fraction) ? std::clamp(fraction, 0.f, .95f) : 0.f;
    if (p.scene_top_fraction != fraction) {
        p.scene_top_fraction = fraction;
        p.scene_drag = {};
    }
}
void Renderer::set_scene_bottom_fraction(float fraction) {
    auto& p = *impl_;
    fraction = std::isfinite(fraction) ? std::clamp(fraction, 0.f, .95f) : 0.f;
    if (p.scene_bottom_fraction != fraction) {
        p.scene_bottom_fraction = fraction;
        p.scene_drag = {};
    }
}
void Renderer::frame_hands(const ReceiverSnapshot& s) {
    if (s.epoch == impl_->epoch && s.space_epoch == impl_->space_epoch &&
        select_scene_reference(SceneReference::hands)) {
        impl_->distance = .75f;
    }
}
void Renderer::headset_view(const ReceiverSnapshot& s) {
    if (s.epoch == impl_->epoch && s.space_epoch == impl_->space_epoch)
        select_scene_view(SceneView::hmd);
}
bool Renderer::scene_reference_available(SceneReference reference) const {
    const auto index = static_cast<size_t>(reference);
    return reference == SceneReference::world ||
           (index < impl_->reference_bounds.size() && impl_->reference_bounds[index].valid);
}
bool Renderer::select_scene_reference(SceneReference reference) {
    if (!scene_reference_available(reference))
        return false;
    auto& p = *impl_;
    if (p.scene_view == SceneView::hmd)
        p.orbit_from_headset();
    p.scene_reference = reference;
    p.reference_offset = {};
    p.target = reference == SceneReference::world ? glm::vec3(0)
        : p.reference_bounds[static_cast<size_t>(reference)].centre();
    p.scene_drag = {};
    return true;
}
bool Renderer::scene_view_available(SceneView view) const {
    return view == SceneView::hmd ? bool(impl_->headset_camera)
        : (view == SceneView::orbit || view == SceneView::top ||
           view == SceneView::left || view == SceneView::iso) &&
              scene_reference_available(impl_->scene_reference);
}
bool Renderer::select_scene_view(SceneView view) {
    if (!scene_view_available(view))
        return false;
    auto& p = *impl_;
    p.scene_drag = {};
    if (view == SceneView::orbit) {
        p.orbit_from_headset();
        return true;
    }
    p.scene_view = view;
    if (view == SceneView::hmd)
        return true;
    p.reference_offset = {};
    const auto& bounds = p.reference_bounds[static_cast<size_t>(p.scene_reference)];
    p.target = p.scene_reference == SceneReference::world ? glm::vec3(0) : bounds.centre();
    p.yaw = view == SceneView::left ? -glm::half_pi<float>()
           : view == SceneView::iso ? glm::quarter_pi<float>() : 0.f;
    p.pitch = view == SceneView::top ? glm::half_pi<float>()
             : view == SceneView::iso ? std::asin(1.f / std::sqrt(3.f)) : 0.f;
    int width = 1, height = 1;
    glfwGetFramebufferSize(p.window, &width, &height);
    const float aspect = std::max(.1f, width * p.scene_width_fraction /
        std::max(1.f, height * (1.f - p.scene_top_fraction - p.scene_bottom_fraction)));
    const float half_fov = std::atan(std::tan(glm::radians(24.f)) * std::min(1.f, aspect));
    const float radius = p.scene_reference == SceneReference::world ? 1.5f : bounds.radius();
    p.distance = std::clamp(radius * 1.15f / std::sin(half_fov), .2f, 30.f);
    return true;
}
SceneCameraState Renderer::scene_camera() const {
    const auto& p = *impl_;
    if (p.scene_view == SceneView::hmd && p.headset_camera) {
        const auto position = glm::vec3((*p.headset_camera)[3]);
        return {p.scene_reference, p.scene_view, position,
                position - glm::vec3((*p.headset_camera)[2]), p.view_up()};
    }
    return {p.scene_reference, p.scene_view, p.target + p.direction() * p.distance,
            p.target, p.view_up()};
}
std::optional<glm::mat4> Renderer::headset_transform() const {
    return impl_->current_headset_transform;
}
void Renderer::process_input(double dt, bool mouse, bool keyboard) {
    auto& p = *impl_;
    double x, y;
    glfwGetCursorPos(p.window, &x, &y);
    float dx = float(x - p.mx), dy = float(y - p.my);
    p.mx = x;
    p.my = y;
    if (p.first_mouse) {
        p.first_mouse = false;
        dx = dy = 0;
    }
    bool scene_mouse = !mouse && p.cursor_in_scene(x, y) &&
                       glfwGetWindowAttrib(p.window, GLFW_FOCUSED) == GLFW_TRUE;
    for (size_t i = 0; i < p.mouse_down.size(); ++i) {
        bool down = glfwGetMouseButton(p.window, int(i)) == GLFW_PRESS;
        if (!down)
            p.scene_drag[i] = false;
        else if (!p.mouse_down[i])
            p.scene_drag[i] = scene_mouse;
        p.mouse_down[i] = down;
    }
    bool right = p.scene_drag[GLFW_MOUSE_BUTTON_RIGHT];
    const bool moving_mouse = (dx != 0 || dy != 0) &&
        (p.scene_drag[GLFW_MOUSE_BUTTON_LEFT] || p.scene_drag[GLFW_MOUSE_BUTTON_MIDDLE] || right);
    const bool flying = !keyboard && right &&
        (glfwGetKey(p.window, GLFW_KEY_W) == GLFW_PRESS || glfwGetKey(p.window, GLFW_KEY_S) == GLFW_PRESS ||
         glfwGetKey(p.window, GLFW_KEY_A) == GLFW_PRESS || glfwGetKey(p.window, GLFW_KEY_D) == GLFW_PRESS ||
         glfwGetKey(p.window, GLFW_KEY_Q) == GLFW_PRESS || glfwGetKey(p.window, GLFW_KEY_E) == GLFW_PRESS);
    if (scene_mouse && (moving_mouse || flying))
        p.orbit_from_headset();
    const auto previous_target = p.target;
    if (scene_mouse) {
        if ((p.scene_drag[GLFW_MOUSE_BUTTON_LEFT] || right) && (dx != 0 || dy != 0)) {
            p.yaw -= dx * .004f;
            p.pitch = std::clamp(p.pitch + dy * .004f, -1.5f, 1.5f);
        }
        if (p.scene_drag[GLFW_MOUSE_BUTTON_MIDDLE]) {
            auto r = glm::normalize(glm::cross(p.view_up(), p.direction()));
            auto u = glm::cross(p.direction(), r);
            p.target += (-dx * r + dy * u) * p.distance * .0012f;
        }
    }
    if (!keyboard && scene_mouse && right) {
        float speed = float(dt) *
                      (.8f * (glfwGetKey(p.window, GLFW_KEY_LEFT_SHIFT) == GLFW_PRESS ? 3.f : 1.f));
        auto forward = -p.direction(),
             side = glm::normalize(glm::cross(forward, p.view_up()));
        if (glfwGetKey(p.window, GLFW_KEY_W) == GLFW_PRESS)
            p.target += forward * speed;
        if (glfwGetKey(p.window, GLFW_KEY_S) == GLFW_PRESS)
            p.target -= forward * speed;
        if (glfwGetKey(p.window, GLFW_KEY_A) == GLFW_PRESS)
            p.target -= side * speed;
        if (glfwGetKey(p.window, GLFW_KEY_D) == GLFW_PRESS)
            p.target += side * speed;
        if (glfwGetKey(p.window, GLFW_KEY_E) == GLFW_PRESS)
            p.target.y += speed;
        if (glfwGetKey(p.window, GLFW_KEY_Q) == GLFW_PRESS)
            p.target.y -= speed;
    }
    p.reference_offset += p.target - previous_target;
}
void Renderer::zoom(float delta) {
    double x, y;
    glfwGetCursorPos(impl_->window, &x, &y);
    if (!impl_->cursor_in_scene(x, y))
        return;
    impl_->orbit_from_headset();
    impl_->distance = std::clamp(impl_->distance * std::exp(-delta * .12f), .02f, 30.f);
}
void Renderer::invalidate_poses() {
    impl_->clear_pose_state();
}
void Renderer::update_headset_position(const ReceiverSnapshot& snapshot, double) {
    auto& p = *impl_;
    if (p.headset_epoch != snapshot.epoch || p.headset_space_epoch != snapshot.space_epoch) {
        p.headset_origin.reset();
        p.current_headset_transform.reset();
        p.headset_epoch = snapshot.epoch;
        p.headset_space_epoch = snapshot.space_epoch;
    }
    if (!snapshot.poses[0] || !snapshot.poses[0]->valid ||
        snapshot.poses[0]->epoch != snapshot.epoch || snapshot.poses[0]->space_epoch != snapshot.space_epoch)
        return;
    const auto& head = *snapshot.poses[0];
    if (std::isfinite(head.values[0]) && std::isfinite(head.values[1]) &&
        std::isfinite(head.values[2]))
        p.headset_origin = glm::vec3(head.values[0], head.values[1], head.values[2]);
    if (finite_pose(head.values.data()))
        p.current_headset_transform = pose_transform(head.values.data());
}
SessionEvent Renderer::hand_asset_event() const {
    return encode_hand_assets(impl_->hand_assets);
}
void Renderer::restore_hand_asset(const SessionEvent& event) {
    auto& p = *impl_;
    if (event.attributes.value("schema", std::string{}) != "ceres-hand-assets")
        return;
    auto assets = decode_hand_assets(event);
    p.left.upload(assets.meshes[0]);
    p.right.upload(assets.meshes[1]);
    p.hand_assets = std::move(assets);
    p.replay_assets = true;
    invalidate_poses();
}
std::optional<SessionEvent> Renderer::headset_asset_event() const {
    if (!impl_->headset_asset)
        return std::nullopt;
    return encode_headset_asset(*impl_->headset_asset);
}
void Renderer::restore_headset_asset(const SessionEvent& event) {
    if (event.attributes.value("schema", std::string{}) == "ceres-headset-asset") {
        impl_->set_headset(decode_headset_asset(event));
        impl_->replay_assets = true;
    }
}
void Renderer::restore_live_assets() {
    auto& p = *impl_;
    if (!p.replay_assets)
        return;
    auto directory = p.local_assets / "local";
    auto hands = std::filesystem::exists(directory / "mano" / "mano-left.json")
                     ? load_mano_assets(directory / "mano")
                     : load_hand_assets(p.local_assets / "hands");
    p.left.upload(hands.meshes[0]);
    p.right.upload(hands.meshes[1]);
    p.hand_assets = std::move(hands);
    if (std::filesystem::exists(p.local_assets / "quest3" / "model.json"))
        p.set_headset(load_static_model(p.local_assets / "quest3"));
    else {
        glDeleteTextures(3, p.headset_textures.data());
        p.headset_textures = {};
        p.headset_asset.reset();
    }
    p.replay_assets = false;
    invalidate_poses();
}
Json Renderer::scene_assets() const {
    const auto& p = *impl_;
    Json hands = Json::array();
    for (size_t side = 0; side < 2; ++side)
        hands.push_back({{"side", side == 0 ? "left" : "right"},
                         {"vertices", p.hand_assets.meshes[side].vertices.size()},
                         {"triangles", p.hand_assets.meshes[side].indices.size() / 3}});
    Json result = {{"hands", {{"metadata", p.hand_assets.metadata}, {"meshes", hands}}}};
    if (p.headset_asset) {
        const auto& asset = *p.headset_asset;
        result["headset"] = {{"vertices", asset.mesh.vertices.size()},
                             {"triangles", asset.mesh.indices.size() / 3},
                             {"model", asset.metadata}};
    }
    return result;
}
Json Renderer::presentation_metrics() const {
    const auto& p = *impl_;
    Json hands = Json::object();
    for (size_t side = 0; side < p.hand_presentation.size(); ++side) {
        const auto& presentation = p.hand_presentation[side];
        const auto& pose = presentation.pose();
        hands[side == 0 ? "left" : "right"] = {
            {"visible", p.hand_drawn[side]}, {"mesh", p.hand_mesh[side]},
            {"latest_sequence", pose.sequence}, {"source_valid", presentation.source_valid()},
            {"source_mask", presentation.source_mask()}, {"observed_mask", presentation.observed_mask()},
            {"retained_mask", pose.joint_mask}, {"wrist_sequence", presentation.joint_sequence(0)},
            {"wrist_observed_us", presentation.joint_observed_us(0)},
            {"wrist_position", {pose.values[0], pose.values[1], pose.values[2]}},
            {"wrist_opacity", presentation.opacity(0)}, {"drawn_updates", p.hand_update_count[side]},
            {"updates_without_video", p.hand_updates_without_video[side]}};
    }
    Json cameras = Json::array();
    for (const auto& camera : p.cameras)
        cameras.push_back({{"available", camera.current >= 0}, {"sequence", camera.presented.sequence},
                           {"time_us", camera.presented.time_us}, {"receive_us", camera.presented.receive_us},
                           {"rtp_timestamp", camera.presented.rtp_timestamp}});
    return {{"hands", std::move(hands)}, {"cameras", std::move(cameras)}, {"rendered_frames", p.frame}};
}
void Renderer::invalidate_video() {
    auto& p = *impl_;
    p.headset_origin.reset();
    p.current_headset_transform.reset();
    p.hand_trails.clear();
    cuda_check(cudaStreamSynchronize(p.stream), "Finish pending image conversion");
    for (auto& camera : p.cameras) {
        for (auto& t : camera.textures) {
            if (t.surface) {
                cudaDestroySurfaceObject(t.surface);
                t.surface = 0;
            }
            t.pending = false;
            t.lease = {};
        }
        camera.current = -1;
        camera.uploaded_time = -1;
        camera.have_conversion = false;
        camera.presented = {};
    }
    p.clear_pose_state();
}
void Renderer::update_video(VideoFrameLease lease, const Calibration& c, bool undistort,
                            size_t camera_index) {
    auto& p = *impl_;
    if (camera_index >= p.cameras.size())
        throw std::out_of_range("Camera slot exceeds the supported two cameras");
    auto& camera = p.cameras[camera_index];
    for (int i = 0; i < 3; ++i) {
        auto& t = camera.textures[i];
        if (t.pending && cudaEventQuery(t.ready) == cudaSuccess) {
            if (t.surface) {
                cudaDestroySurfaceObject(t.surface);
                t.surface = 0;
            }
            t.pending = false;
            t.lease = {};
        }
    }
    if (!lease)
        return;
    auto& f = *lease.image;
    if (f.event.receive_us == camera.uploaded_time && f.event.sequence == camera.uploaded_seq &&
        camera.have_conversion && camera.converted_calibration == c &&
        camera.converted_undistort == undistort)
        return;
    if (camera.width != f.width || camera.height != f.height)
        p.resize(camera, f.width, f.height);
    int available = -1;
    for (int i = 0; i < 3; ++i) {
        auto& t = camera.textures[i];
        if (i == camera.current || t.pending)
            continue;
        if (t.fence) {
            auto ready = glClientWaitSync(t.fence, 0, 0);
            if (ready != GL_ALREADY_SIGNALED && ready != GL_CONDITION_SATISFIED)
                continue;
            glDeleteSync(t.fence);
            t.fence = nullptr;
        }
        available = i;
        break;
    }
    if (available < 0)
        return;
    auto& t = camera.textures[available];
    cuda_check(cudaGraphicsMapResources(1, &t.resource, p.stream), "Map image texture");
    cudaArray_t array = nullptr;
    cuda_check(cudaGraphicsSubResourceGetMappedArray(&array, t.resource, 0, 0),
               "Access image texture");
    cudaResourceDesc resource{};
    resource.resType = cudaResourceTypeArray;
    resource.res.array.array = array;
    cuda_check(cudaCreateSurfaceObject(&t.surface, &resource), "Create image surface");
    ImageConversion args{};
    args.width = f.width;
    args.height = f.height;
    args.full_range = f.full_range;
    args.bt709 = f.bt709;
    args.undistort = undistort;
    args.flip_x = c.flip_x;
    args.flip_y = c.flip_y;
    args.fx = float(c.fx * f.width / c.width);
    args.fy = float(c.fy * f.height / c.height);
    args.cx = float(c.cx * f.width / c.width);
    args.cy = float(c.cy * f.height / c.height);
    for (int i = 0; i < 5; ++i)
        args.distortion[i] = float(c.distortion[i]);
    cuda_check(convert_nv12(reinterpret_cast<const unsigned char*>(f.data), f.pitch, t.surface,
                            args, p.stream),
               "Convert camera image");
    cuda_check(cudaGraphicsUnmapResources(1, &t.resource, p.stream), "Release image texture");
    cuda_check(cudaEventRecord(t.ready, p.stream), "Record image completion");
    t.pending = true;
    t.lease = lease;
    t.metadata = f.event;
    camera.uploaded_time = f.event.receive_us;
    camera.uploaded_seq = f.event.sequence;
    camera.converted_calibration = c;
    camera.converted_undistort = undistort;
    camera.have_conversion = true;
    // Unmap orders subsequent GL reads after CUDA writes without a host wait.
    camera.current = available;
    camera.presented = t.metadata;
    if (camera_index == 0)
        ++p.count;
}
bool Renderer::update_stereo(VideoFrameLease left, VideoFrameLease right,
                             const StereoCalibration& calibration, float min_depth, float max_depth,
                             float voxel_size, int64_t observation_time_us,
                             const HandMaskSet& hands) {
    auto& p = *impl_;
    auto& stereo = p.stereo;
    stereo.poll();
    if (stereo.frozen)
        return false;
    if (!left || !right || !std::isfinite(min_depth) || !std::isfinite(max_depth) ||
        min_depth <= 0 || max_depth <= min_depth || !std::isfinite(voxel_size) ||
        voxel_size < .01f || voxel_size > .1f || observation_time_us < 0)
        return false;
    const auto& a = *left.image;
    const auto& b = *right.image;
    if (a.context != b.context || a.event.epoch != b.event.epoch ||
        a.event.space_epoch != b.event.space_epoch ||
        a.event.attributes.value("replay_generation", uint64_t(0)) !=
            b.event.attributes.value("replay_generation", uint64_t(0)))
        return false;
    const auto head = associated_head(a.event), other_head = associated_head(b.event);
    if (!head || !other_head)
        return false;
    float translation_squared = 0, rotation_dot = 0;
    for (size_t i = 0; i < 3; ++i) {
        const float delta = (*head)[i] - (*other_head)[i];
        translation_squared += delta * delta;
    }
    for (size_t i = 3; i < head->size(); ++i)
        rotation_dot += (*head)[i] * (*other_head)[i];
    // Asynchronous exposures cannot share one rigid stereo geometry after large motion.
    if (translation_squared > .02f * .02f ||
        std::abs(rotation_dot) < std::cos(glm::radians(2.f) * .5f))
        throw std::runtime_error("Head moved more than 2 cm or 2 degrees between camera frames");
    // Validate the original profile before adapting source sampling. Resampling
    // must not turn nominal preset geometry into a new calibration assertion.
    auto config = make_stereo_gpu_config(calibration, 320, a.width, a.height, b.width, b.height);
    config.min_depth = min_depth;
    config.max_depth = max_depth;
    if (stereo.have_submission &&
         (stereo.submitted[0].epoch != a.event.epoch ||
          stereo.submitted[0].space_epoch != a.event.space_epoch ||
          stereo.submitted[0].attributes.value("replay_generation", uint64_t(0)) !=
              a.event.attributes.value("replay_generation", uint64_t(0)))) {
        stereo.clear();
        stereo.calibration = calibration;
        stereo.min_depth = min_depth;
        stereo.max_depth = max_depth;
        stereo.voxel_size = voxel_size;
    }
    stereo.configure(stereo.frozen, voxel_size, stereo.maximum_points);
    stereo.calibration = calibration;
    stereo.min_depth = min_depth;
    stereo.max_depth = max_depth;
    if (stereo.width != config.width || stereo.height != config.height)
        stereo.resize(config.width, config.height);
    auto same_frame = [](const SessionEvent& x, const SessionEvent& y) {
        return x.receive_us == y.receive_us && x.sequence == y.sequence && x.epoch == y.epoch &&
               x.space_epoch == y.space_epoch && x.stream == y.stream &&
               x.attributes.value("replay_generation", uint64_t(0)) ==
                   y.attributes.value("replay_generation", uint64_t(0));
    };
    if (stereo.have_submission && same_frame(a.event, stereo.submitted[0]) &&
        same_frame(b.event, stereo.submitted[1]))
        return false;
    if (stereo.time_origin_us && observation_time_us < stereo.last_observation_us)
        return false;
    StereoBuffers::Slot* available = nullptr;
    for (size_t i = 0; i < stereo.slots.size(); ++i) {
        auto& slot = stereo.slots[i];
        if (int(i) == stereo.current || slot.pending)
            continue;
        if (slot.fence) {
            const auto state = glClientWaitSync(slot.fence, 0, 0);
            if (state != GL_ALREADY_SIGNALED && state != GL_CONDITION_SATISFIED)
                continue;
            glDeleteSync(slot.fence);
            slot.fence = nullptr;
        }
        available = &slot;
        break;
    }
    if (!available)
        return false;
    auto& slot = *available;
    stereo.observe_cadence(observation_time_us, .5f);
    slot.leases = {left, right};
    bool mapped = false;
    try {
        cuda_check(cudaGraphicsMapResources(1, &slot.resource, stereo.stream),
                   "Map stereo point buffer");
        mapped = true;
        SpatialMapPoint* output = nullptr;
        size_t bytes = 0;
        cuda_check(cudaGraphicsResourceGetMappedPointer(reinterpret_cast<void**>(&output), &bytes,
                                                        slot.resource),
                   "Access stereo point buffer");
        if (bytes < stereo.volume->capacity() * (sizeof(SpatialMapPoint) + sizeof(float)))
            throw std::runtime_error("Stereo point buffer is too small");
        const auto input = [](const GpuImage& image) {
            return StereoNv12{reinterpret_cast<const unsigned char*>(image.data),
                              image.pitch,
                              image.width,
                              image.height,
                              image.full_range,
                              image.bt709};
        };
        cuda_check(cudaEventRecord(slot.started, stereo.stream), "Start stereo reconstruction");
        if (stereo.reset_volume) {
            cuda_check(stereo.volume->clear(stereo.stream), "Reset stereo voxel volume");
            stereo.reset_volume = false;
            stereo.time_origin_us = observation_time_us;
        }
        VoxelGpuConfig fusion;
        fusion.voxel_size = voxel_size;
        fusion.sample_time_seconds = fusion.now_seconds =
            float(double(observation_time_us - *stereo.time_origin_us) / 1000000.0);
        const auto world = pose_transform(head->data());
        std::copy_n(glm::value_ptr(world), 16, fusion.head_to_world);
        cuda_check(stereo.workspace->enqueue(input(a), input(b), config, stereo.reconstructed,
                                             stereo.stream),
                   "Reconstruct stereo points");
        ProjectiveDepthObservation observation;
        observation.hands = hands;
        observation.points = stereo.reconstructed;
        observation.width = config.width;
        observation.height = config.height;
        glm::mat4 head_from_view(1.f);
        for (int row = 0; row < 3; ++row)
            for (int column = 0; column < 3; ++column)
                head_from_view[column][row] = config.rect_to_head[row * 3 + column];
        for (int row = 0; row < 3; ++row)
            head_from_view[3][row] = config.left_origin[row];
        const auto view_from_head = glm::inverse(head_from_view);
        const auto view_from_world = view_from_head * glm::inverse(world);
        std::copy_n(glm::value_ptr(view_from_head), 16, observation.view_from_input);
        std::copy_n(glm::value_ptr(view_from_world), 16, observation.view_from_world);
        // Stereo rays use integer pixel centres. The observation grid uses the
        // centres of normalised pixel cells, including the half-pixel offset.
        glm::mat4 projection(0.f);
        projection[0][0] = 2.f * config.fx / config.width;
        projection[1][1] = 2.f * config.fy / config.height;
        projection[2][0] = 1.f - (2.f * config.cx + 1.f) / config.width;
        projection[2][1] = (2.f * config.cy + 1.f) / config.height - 1.f;
        projection[2][2] = -1.f;
        projection[2][3] = -1.f;
        projection[3][2] = -.2f;
        std::copy_n(glm::value_ptr(projection), 16, observation.projection);
        const glm::mat4 identity(1.f);
        std::copy_n(glm::value_ptr(identity), 16, observation.norm_depth_from_norm_view);
        cuda_check(stereo.volume->integrate_projective(stereo.reconstructed,
                                            size_t(config.width) * config.height, fusion,
                                            observation, stereo.stream),
                   "Integrate stereo voxels");
        p.fuse_saved(stereo, a.event, observation_time_us,
                     size_t(config.width) * config.height, fusion, observation);
        cuda_check(stereo.snapshot(output), "Publish stereo voxel volume");
        cuda_check(cudaGraphicsUnmapResources(1, &slot.resource, stereo.stream),
                   "Release stereo point buffer");
        mapped = false;
        cuda_check(cudaEventRecord(slot.ready, stereo.stream), "Record stereo completion");
    } catch (...) {
        if (mapped)
            cudaGraphicsUnmapResources(1, &slot.resource, stereo.stream);
        // Failed submissions may still have queued work that owns the input surfaces.
        cudaStreamSynchronize(stereo.stream);
        slot.leases = {};
        stereo.clear();
        throw;
    }
    slot.pending = true;
    slot.generation = stereo.generation;
    slot.reconstruction = true;
    stereo.capture_fade_clock(slot);
    slot.serial = ++stereo.serial;
    slot.frame = a.event;
    stereo.last_observation_us = observation_time_us;
    stereo.submitted = {a.event, b.event};
    stereo.have_submission = true;
    ++stereo.content_generation;
    return true;
}
void Renderer::clear_stereo(bool force) {
    impl_->stereo.clear(force);
}
double Renderer::stereo_ms() const {
    return impl_->stereo.milliseconds;
}
bool Renderer::update_environment_depth(const SessionEvent& event, float min_depth, float max_depth,
                                        float voxel_size, int64_t observation_time_us,
                                        const HandMaskSet& hands) {
    if (impl_->environment.frozen || event.kind != EventKind::Depth || observation_time_us < 0 || !std::isfinite(voxel_size) ||
        voxel_size < .01f || voxel_size > .1f)
        return false;
    const auto frame = decode_depth(event.payload);
    auto& volume = impl_->environment;
    volume.poll();
    if (volume.have_submission &&
         (volume.submitted[0].epoch != event.epoch ||
          volume.submitted[0].space_epoch != event.space_epoch ||
          volume.submitted[0].attributes.value("replay_generation", uint64_t(0)) !=
              event.attributes.value("replay_generation", uint64_t(0)))) {
        volume.clear();
        volume.min_depth = min_depth;
        volume.max_depth = max_depth;
        volume.voxel_size = voxel_size;
    }
    volume.configure(volume.frozen, voxel_size, volume.maximum_points);
    if (volume.have_submission && volume.submitted[0].sequence == event.sequence)
        return false;
    if (volume.time_origin_us && observation_time_us < volume.last_observation_us)
        return false;
    volume.prepare_depth();
    StereoBuffers::Slot* available = nullptr;
    for (size_t i = 0; i < volume.slots.size(); ++i) {
        auto& slot = volume.slots[i];
        if (int(i) == volume.current || slot.pending)
            continue;
        if (slot.fence) {
            const auto state = glClientWaitSync(slot.fence, 0, 0);
            if (state != GL_ALREADY_SIGNALED && state != GL_CONDITION_SATISFIED)
                continue;
            glDeleteSync(slot.fence);
            slot.fence = nullptr;
        }
        available = &slot;
        break;
    }
    if (!available)
        return false;
    auto& slot = *available;
    volume.observe_cadence(observation_time_us, .1f);
    DepthGpuConfig config;
    config.width = frame.width;
    config.height = frame.height;
    config.min_depth = min_depth;
    config.max_depth = max_depth;
    const auto projection = glm::inverse(glm::make_mat4(frame.projection.data()));
    const auto depth_transform =
        glm::inverse(glm::make_mat4(frame.norm_depth_from_norm_view.data()));
    std::copy_n(glm::value_ptr(projection), 16, config.inverse_projection);
    std::copy_n(glm::value_ptr(depth_transform), 16, config.norm_view_from_norm_depth);
    std::copy(frame.millimetres.begin(), frame.millimetres.end(), slot.depth_upload);
    slot.depth_submitted_us = monotonic_us();
    bool mapped = false;
    try {
        cuda_check(cudaGraphicsMapResources(1, &slot.resource, volume.stream),
                   "Map environment volume");
        mapped = true;
        SpatialMapPoint* output = nullptr;
        size_t bytes = 0;
        cuda_check(cudaGraphicsResourceGetMappedPointer(reinterpret_cast<void**>(&output), &bytes,
                                                        slot.resource),
                   "Access environment volume");
        if (bytes < volume.volume->capacity() * (sizeof(SpatialMapPoint) + sizeof(float)))
            throw std::runtime_error("Environment point buffer is too small");
        cuda_check(cudaEventRecord(slot.started, volume.stream), "Start environment update");
        if (volume.reset_volume) {
            cuda_check(volume.volume->clear(volume.stream), "Reset environment volume");
            volume.reset_volume = false;
            volume.time_origin_us = observation_time_us;
        }
        cuda_check(cudaMemcpyAsync(volume.depth_samples, slot.depth_upload,
                                   frame.millimetres.size() * sizeof(uint16_t),
                                   cudaMemcpyHostToDevice, volume.stream),
                   "Upload environment depth");
        cuda_check(unproject_environment_depth(volume.depth_samples, volume.reconstructed, config,
                                               volume.stream),
                   "Unproject environment depth");
        VoxelGpuConfig fusion;
        fusion.voxel_size = voxel_size;
        fusion.intrinsic_colour = false;
        fusion.sample_time_seconds = fusion.now_seconds =
            float(double(observation_time_us - *volume.time_origin_us) / 1000000.0);
        std::copy(frame.world_from_view.begin(), frame.world_from_view.end(), fusion.head_to_world);
        ProjectiveDepthObservation observation;
        observation.points = volume.reconstructed;
        observation.width = frame.width;
        observation.height = frame.height;
        observation.hands = hands;
        const auto view_from_world = glm::inverse(glm::make_mat4(frame.world_from_view.data()));
        std::copy_n(glm::value_ptr(view_from_world), 16, observation.view_from_world);
        std::copy(frame.projection.begin(), frame.projection.end(), observation.projection);
        std::copy(frame.norm_depth_from_norm_view.begin(), frame.norm_depth_from_norm_view.end(),
                  observation.norm_depth_from_norm_view);
        cuda_check(volume.volume->integrate_projective(volume.reconstructed, frame.millimetres.size(),
                                                       fusion, observation, volume.stream),
                   "Integrate environment depth");
        impl_->fuse_saved(volume, event, observation_time_us, frame.millimetres.size(), fusion,
                          observation);
        cuda_check(volume.snapshot(output), "Publish environment volume");
        cuda_check(cudaGraphicsUnmapResources(1, &slot.resource, volume.stream),
                   "Release environment volume");
        mapped = false;
        cuda_check(cudaEventRecord(slot.ready, volume.stream), "Complete environment update");
    } catch (...) {
        if (mapped)
            cudaGraphicsUnmapResources(1, &slot.resource, volume.stream);
        cudaStreamSynchronize(volume.stream);
        volume.clear();
        throw;
    }
    slot.pending = true;
    slot.generation = volume.generation;
    slot.reconstruction = true;
    volume.capture_fade_clock(slot);
    slot.serial = ++volume.serial;
    slot.frame = event;
    volume.last_observation_us = observation_time_us;
    volume.submitted[0] = event;
    volume.have_submission = true;
    ++volume.content_generation;
    return true;
}
void Renderer::clear_environment_depth(bool force) {
    impl_->environment.clear(force);
}
double Renderer::environment_depth_ms() const {
    return impl_->environment.milliseconds;
}
const DepthPipelineTiming& Renderer::environment_depth_timing() const {
    return impl_->environment.depth_timing;
}
size_t Renderer::depth_map_bytes(bool environment) const {
    const auto& map = environment ? impl_->environment : impl_->stereo;
    return map.volume ? map.volume->scratch_bytes() +
                            (map.slots.size() * map.volume->capacity() + map.readback.capacity +
                             map.import_upload.capacity) * sizeof(SpatialMapPoint) +
                            map.slots.size() * map.volume->capacity() * sizeof(float)
                      : 0;
}
void Renderer::configure_spatial_map(bool frozen, float spacing, size_t max_points) {
    if (!std::isfinite(spacing) || spacing < .01f || spacing > .1f || max_points == 0 ||
        max_points > stereo_voxel_capacity)
        throw std::invalid_argument("Invalid spatial map spacing or point budget");
    impl_->environment.configure(frozen, spacing, max_points);
    impl_->stereo.configure(frozen, spacing, max_points);
    if (impl_->saved_state.loaded)
        impl_->saved.configure(true, impl_->saved.voxel_size, max_points);
}
bool Renderer::request_map_snapshot(bool environment, std::string world_id,
                                    uint32_t epoch, uint32_t space_epoch) {
    if (world_id.empty() || world_id.size() > 64 ||
        std::any_of(world_id.begin(), world_id.end(), [](unsigned char c) {
            return c < 32 || c > 126;
        }))
        throw std::invalid_argument("Invalid spatial map world identity");
    auto result = std::make_shared<SpatialMapSnapshot>();
    result->world_id = std::move(world_id);
    result->source = environment ? SpatialMapSource::environment_depth : SpatialMapSource::stereo;
    result->epoch = epoch;
    result->space_epoch = space_epoch;
    return (environment ? impl_->environment : impl_->stereo).request_snapshot(std::move(result));
}
std::shared_ptr<SpatialMapSnapshot> Renderer::take_map_snapshot(bool environment) {
    return (environment ? impl_->environment : impl_->stereo).take_snapshot();
}
void Renderer::finish_map_snapshot(bool environment) {
    auto& map = environment ? impl_->environment : impl_->stereo;
    if (map.readback.pending)
        cuda_check(cudaEventSynchronize(map.readback.ready), "Finish spatial map readback");
}
void Renderer::validate_spatial_map_import(const SpatialMapSnapshot& snapshot) {
    if ((snapshot.source != SpatialMapSource::environment_depth && snapshot.source != SpatialMapSource::stereo) ||
        snapshot.points.size() > stereo_voxel_capacity || snapshot.time_origin_us < 0 ||
        !std::isfinite(snapshot.base_voxel_size) || snapshot.base_voxel_size < .01f ||
        snapshot.base_voxel_size > .1f || snapshot.world_id.empty() || snapshot.world_id.size() > 64 ||
        std::any_of(snapshot.world_id.begin(), snapshot.world_id.end(), [](unsigned char c) {
            return c < 32 || c > 126;
        }))
        throw std::invalid_argument("Invalid spatial map import");
    for (const auto& point : snapshot.points) {
        if (!std::isfinite(point.x) || !std::isfinite(point.y) || !std::isfinite(point.z) ||
            !std::isfinite(point.cell_size) || point.cell_size <= 0 || !point.weight ||
            !std::isfinite(point.r) || !std::isfinite(point.g) || !std::isfinite(point.b) ||
            point.r < 0 || point.r > 1 || point.g < 0 || point.g > 1 || point.b < 0 || point.b > 1 ||
            !std::isfinite(point.confidence) || point.confidence <= 0 || point.confidence > 1 ||
            point.observed_us < snapshot.time_origin_us || (point.flags & ~spatial_map_intrinsic_rgb))
            throw std::invalid_argument("Invalid spatial map point");
    }
}
bool Renderer::import_spatial_map(const SpatialMapSnapshot& snapshot) {
    validate_spatial_map_import(snapshot);
    return (snapshot.source == SpatialMapSource::environment_depth ? impl_->environment : impl_->stereo)
        .restore_snapshot(snapshot);
}
bool Renderer::load_saved_map(const SpatialMapSnapshot& snapshot) {
    validate_spatial_map_import(snapshot);
    auto& p = *impl_;
    finish_saved_map_snapshot();
    p.saved.take_snapshot();
    p.saved.configure(true, snapshot.base_voxel_size, p.environment.maximum_points);
    if (!p.saved.restore_snapshot(snapshot))
        return false;
    p.saved.content_generation = std::max(p.saved.content_generation, snapshot.generation);
    p.saved_metadata = {snapshot.world_id, snapshot.source, snapshot.epoch, snapshot.space_epoch,
                         snapshot.time_origin_us, snapshot.generation, snapshot.base_voxel_size, {}};
    p.saved_state = {};
    p.saved_state.loaded = true;
    p.saved_replay_generation.reset();
    return true;
}
void Renderer::clear_saved_map() {
    auto& p = *impl_;
    p.saved.clear(true);
    p.saved_state = {};
    p.saved_metadata = {};
    p.saved_replay_generation.reset();
}
bool Renderer::begin_saved_map_placement() {
    auto& p = *impl_;
    if (!p.saved_state.loaded)
        return false;
    p.saved_state.placed = p.saved_state.fusing = false;
    p.saved_state.world_from_map = glm::mat4(1.f);
    p.saved_replay_generation.reset();
    return true;
}
void Renderer::set_saved_map_transform(const glm::mat4& transform) {
    if (!valid_map_transform(transform))
        throw std::invalid_argument("Invalid saved map placement");
    auto& p = *impl_;
    if (p.saved_state.loaded && !p.saved_state.placed)
        p.saved_state.world_from_map = transform;
}
bool Renderer::place_saved_map(const glm::mat4& transform, uint32_t epoch,
                              uint32_t space_epoch, int64_t observation_time_us) {
    if (!valid_map_transform(transform) || observation_time_us < 0)
        throw std::invalid_argument("Invalid saved map placement");
    auto& p = *impl_;
    if (!p.saved_state.loaded || p.saved_state.placed ||
        p.saved.last_observation_us == std::numeric_limits<int64_t>::max())
        return false;
    if (p.saved.scene_bounds.valid) {
        const auto& bounds = p.saved.scene_bounds;
        const float limit = p.saved.voxel_size * 1048576.f;
        for (unsigned corner = 0; corner < 8; ++corner) {
            const auto point = glm::vec3(transform * glm::vec4(
                corner & 1 ? bounds.maximum.x : bounds.minimum.x,
                corner & 2 ? bounds.maximum.y : bounds.minimum.y,
                corner & 4 ? bounds.maximum.z : bounds.minimum.z, 1.f));
            if (!finite_position(point) || point.x < -limit || point.x >= limit ||
                point.y < -limit || point.y >= limit || point.z < -limit || point.z >= limit)
                throw std::invalid_argument("Saved map placement exceeds the spatial grid");
        }
    }
    cuda_check(p.saved.volume->transform(glm::value_ptr(transform), p.saved.voxel_size,
                                         p.saved.time_origin_us.value_or(0), p.saved.stream),
               "Place saved map in the tracking world");
    p.saved.scene_bounds = transformed_bounds(p.saved.scene_bounds, transform);
    ++p.saved.generation;
    ++p.saved.content_generation;
    p.saved.current = -1;
    p.saved.displayed = 0;
    p.saved.have_lod_snapshot = false;
    p.saved.last_lod_refresh_us = 0;
    p.saved.submitted[0].epoch = epoch;
    p.saved.submitted[0].space_epoch = space_epoch;
    p.saved_metadata.epoch = epoch;
    p.saved_metadata.space_epoch = space_epoch;
    p.saved_state.world_from_map = transform;
    p.saved_state.placed = true;
    p.saved_state.fusing = false;
    p.saved_input_anchor_us = observation_time_us;
    p.saved_clock_anchor_us = p.saved.last_observation_us + 1;
    p.saved_replay_generation.reset();
    return true;
}
bool Renderer::set_saved_map_fusion(bool enabled, std::optional<int64_t> observation_time_us) {
    auto& p = *impl_;
    if (enabled && (!p.saved_state.loaded || !p.saved_state.placed))
        return false;
    if (enabled) {
        if (observation_time_us) {
            if (*observation_time_us < 0 ||
                p.saved.last_observation_us == std::numeric_limits<int64_t>::max())
                return false;
            p.saved_input_anchor_us = *observation_time_us;
            p.saved_clock_anchor_us = p.saved.last_observation_us + 1;
        }
        p.saved_replay_generation.reset();
    }
    p.saved_state.fusing = enabled;
    return true;
}
void Renderer::stop_saved_map_fusion() {
    impl_->saved_state.fusing = false;
}
SavedMapState Renderer::saved_map_state() const {
    auto result = impl_->saved_state;
    result.points = result.loaded ? impl_->saved.occupied_points : 0;
    result.capacity = impl_->saved.volume ? impl_->saved.volume->capacity() : 0;
    result.point_budget = impl_->saved.maximum_points;
    result.update_interval_seconds = impl_->saved.cadence_observation_us ? impl_->saved.update_interval_seconds : 0.f;
    result.generation = result.loaded ? impl_->saved.content_generation : 0;
    return result;
}
bool Renderer::request_saved_map_snapshot() {
    auto& p = *impl_;
    if (!p.saved_state.loaded || !p.saved_state.placed)
        return false;
    return p.saved.request_snapshot(std::make_shared<SpatialMapSnapshot>(p.saved_metadata));
}
std::shared_ptr<SpatialMapSnapshot> Renderer::take_saved_map_snapshot() {
    return impl_->saved.take_snapshot();
}
void Renderer::finish_saved_map_snapshot() {
    if (impl_->saved.readback.pending)
        cuda_check(cudaEventSynchronize(impl_->saved.readback.ready), "Finish saved map readback");
}
uint64_t Renderer::map_generation(bool environment) const {
    return (environment ? impl_->environment : impl_->stereo).content_generation;
}
size_t Renderer::map_point_count(bool environment) const {
    return (environment ? impl_->environment : impl_->stereo).occupied_points;
}
size_t Renderer::map_point_capacity(bool environment) const {
    const auto& map = environment ? impl_->environment : impl_->stereo;
    return map.volume ? map.volume->capacity() : 0;
}
size_t Renderer::map_point_budget(bool environment) const {
    return (environment ? impl_->environment : impl_->stereo).maximum_points;
}
float Renderer::map_update_interval(bool environment) const {
    const auto& map = environment ? impl_->environment : impl_->stereo;
    return map.cadence_observation_us ? map.update_interval_seconds : 0.f;
}
void Renderer::draw(const ReceiverSnapshot& s, const Calibration& c, const ViewOptions& o,
                    int64_t trail_time_us, double trail_time_scale, int64_t scene_time_us) {
    auto& p = *impl_;
    p.stereo.poll();
    p.environment.poll();
    p.saved.poll();
    int w, h;
    glfwGetFramebufferSize(p.window, &w, &h);
    if (w <= 0 || h <= 0)
        return;
    p.bind_target(w, h);
    if (o.pose_time_offset_ms != p.pose_time_offset_ms) {
        invalidate_poses();
        p.pose_time_offset_ms = o.pose_time_offset_ms;
    }
    if (s.epoch != p.epoch || s.space_epoch != p.space_epoch) {
        if (p.saved_state.fusing && (s.epoch != p.saved_metadata.epoch ||
                                   s.space_epoch != p.saved_metadata.space_epoch))
            p.saved_state.fusing = false;
        p.clear_pose_state();
        // A newly decoded pair can precede the first draw of this reference space.
        if (!p.stereo.have_submission || p.stereo.submitted[0].epoch != s.epoch ||
            p.stereo.submitted[0].space_epoch != s.space_epoch)
            clear_stereo();
        p.epoch = s.epoch;
        p.space_epoch = s.space_epoch;
    }
    if (p.frame >= 4) {
        GLint ready = 0;
        glGetQueryObjectiv(p.queries[p.frame % 4], GL_QUERY_RESULT_AVAILABLE, &ready);
        if (ready) {
            GLuint64 ns = 0;
            glGetQueryObjectui64v(p.queries[p.frame % 4], GL_QUERY_RESULT, &ns);
            p.gpu = double(ns) / 1e6;
        }
    }
    glBeginQuery(GL_TIME_ELAPSED, p.queries[p.frame % 4]);
    p.query_open = true;
    glViewport(0, 0, w, h);
    glDisable(GL_SCISSOR_TEST);
    glClearColor(.055f, .063f, .076f, 1);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    int scene_width = int(double(w) * p.scene_width_fraction);
    const int scene_bottom = int(double(h) * std::min(p.scene_bottom_fraction, .95f - p.scene_top_fraction));
    const int scene_height = std::max(1, int(double(h) * (1.f - p.scene_top_fraction)) - scene_bottom);
    if (scene_width <= 0)
        return;
    glViewport(0, scene_bottom, scene_width, scene_height);
    glEnable(GL_DEPTH_TEST);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glUseProgram(p.shader);
    int64_t now = s.now_us ? s.now_us : monotonic_us();
    const int64_t appearance_now = scene_time_us >= 0 ? scene_time_us : now;
    p.hand_trails.update(s, true, o.trail_seconds, trail_time_us >= 0 ? trail_time_us : now,
                         trail_time_scale);
    for (int i = 0; i < 3; ++i) {
        p.fresh[i] = false;
        if (s.poses[i]) {
            auto& a = *s.poses[i];
            if (fresh_pose(s, a, trail_time_scale) && (i != 0 || finite_pose(a.values.data()))) {
                p.fresh[i] = true;
                if (i == 0)
                    p.held[i] = a;
            }
        }
        if (i == 0) {
            p.tracking_visibility[i].update(appearance_now, p.fresh[i], s.epoch, s.space_epoch,
                                            detail::TrackingVisibility::LossPolicy::Hold);
            if (!p.tracking_visibility[i].retained())
                p.held[i].reset();
        }
    }
    for (int side = 0; side < 2; ++side) {
        const auto* source = s.poses[side + 1] ? &*s.poses[side + 1] : nullptr;
        const bool supported = source && hand_pose_supported(*source, side == 0, p.hand_assets);
        p.hand_presentation[side].update(appearance_now, source, p.fresh[side + 1],
                                         s.epoch, s.space_epoch, supported);
    }
    p.update_scene_references(o);
    const auto camera_state = scene_camera();
    p.eye = camera_state.eye;
    auto vp = glm::perspective(glm::radians(48.f), float(scene_width) / scene_height, .01f, 100.f) *
              glm::lookAt(p.eye, camera_state.target, camera_state.up);
    glUniformMatrix4fv(glGetUniformLocation(p.shader, "vp"), 1, GL_FALSE, glm::value_ptr(vp));
    glUniform3fv(glGetUniformLocation(p.shader, "eye"), 1, glm::value_ptr(p.eye));
    if (o.grid) {
        p.model(glm::mat4(1), {.18f, .21f, .25f, .65f}, false);
        p.grid.draw();
    }
    if (o.headset && p.held[0] && p.tracking_visibility[0].alpha() > .001f) {
        auto m = pose_transform(p.held[0]->values.data());
        const float alpha = p.tracking_visibility[0].alpha();
        glDepthMask(alpha >= .999f ? GL_TRUE : GL_FALSE);
        if (p.headset_asset) {
            const auto& asset = *p.headset_asset;
            auto colour = asset.base_colour;
            colour.a *= alpha;
            p.model(m * asset.model_to_head, colour);
            p.set("textured", 2);
            int mask = 0;
            for (size_t i = 0; i < p.headset_textures.size(); ++i) {
                glActiveTexture(GL_TEXTURE0 + GLenum(i));
                glBindTexture(GL_TEXTURE_2D, p.headset_textures[i]);
                if (p.headset_textures[i])
                    mask |= 1 << i;
            }
            p.set("camera", 0);
            p.set("normal_map", 1);
            p.set("orm_map", 2);
            p.set("material_mask", mask);
            glUniform1f(glGetUniformLocation(p.shader, "material_metallic"), asset.metallic);
            glUniform1f(glGetUniformLocation(p.shader, "material_roughness"), asset.roughness);
            p.headset.draw();
            glActiveTexture(GL_TEXTURE0);
            p.set("textured", 0);
        } else {
            p.model(m * glm::translate(glm::mat4(1), glm::vec3(0, -.012f, -.044f)) *
                        glm::scale(glm::mat4(1), glm::vec3(.105f, .049f, .062f)),
                    {.62f, .67f, .73f, alpha});
            p.sphere.draw();
            p.model(m * glm::translate(glm::mat4(1), glm::vec3(0, -.012f, -.093f)) *
                        glm::scale(glm::mat4(1), glm::vec3(.088f, .034f, .014f)),
                    {.085f, .11f, .14f, alpha});
            p.sphere.draw();
            for (float x : {-.042f, .042f}) {
                p.model(m * glm::translate(glm::mat4(1), glm::vec3(x, -.006f, -.107f)) *
                            glm::scale(glm::mat4(1), glm::vec3(.008f, .008f, .004f)),
                        {.19f, .39f, .53f, alpha});
                p.sphere.draw();
            }
            p.segment(glm::vec3(m * glm::vec4(-.10f, 0, -.025f, 1)),
                      glm::vec3(m * glm::vec4(-.078f, 0, .075f, 1)), .012f,
                      {.24f, .28f, .33f, alpha});
            p.segment(glm::vec3(m * glm::vec4(.10f, 0, -.025f, 1)),
                      glm::vec3(m * glm::vec4(.078f, 0, .075f, 1)), .012f,
                      {.24f, .28f, .33f, alpha});
        }
    }
    glDepthMask(GL_TRUE);
    struct ImagePlane {
        glm::mat4 transform;
        GLuint texture;
        float distance_squared;
    };
    std::array<ImagePlane, 2> image_planes{};
    size_t image_plane_count = 0;
    for (size_t camera_index = 0; camera_index < p.cameras.size(); ++camera_index) {
        const auto& image = p.cameras[camera_index];
        if (camera_index != 0 && !image.have_conversion)
            continue;
        const auto& calibration = image.have_conversion ? image.converted_calibration : c;
        bool image_in_space = image.current >= 0 && image.presented.epoch == s.epoch &&
                              image.presented.space_epoch == s.space_epoch;
        glm::mat4 camera(1);
        bool have_camera = false, image_has_head = false;
        if (const auto head = detail::associated_camera_head(image.presented, s.epoch, s.space_epoch);
            image_in_space && head) {
            camera = pose_transform(head->data());
            have_camera = image_has_head = true;
        } else if (p.held[0]) {
            camera = pose_transform(p.held[0]->values.data());
            have_camera = true;
        }
        camera =
            camera *
            glm::translate(glm::mat4(1),
                           glm::vec3(calibration.translation[0], calibration.translation[1],
                                     calibration.translation[2])) *
            glm::toMat4(glm::quat(float(calibration.rotation[3]), float(calibration.rotation[0]),
                                  float(calibration.rotation[1]), float(calibration.rotation[2])));
        if (have_camera && calibration.side != "unknown") {
            float d = o.plane_distance;
            auto plane_transform =
                camera *
                glm::translate(glm::mat4(1),
                               glm::vec3(float(-calibration.cx / calibration.fx * d),
                                         float(calibration.cy / calibration.fy * d), -d)) *
                glm::scale(glm::mat4(1),
                           glm::vec3(float(calibration.width / calibration.fx * d),
                                     float(-calibration.height / calibration.fy * d), 1));
            if (o.projection && image_in_space && image_has_head) {
                const auto centre = glm::vec3(plane_transform * glm::vec4(.5f, .5f, 0, 1));
                const auto offset = centre - p.eye;
                image_planes[image_plane_count++] = {
                    plane_transform, image.textures[image.current].id, glm::dot(offset, offset)};
            }
            if (o.projection && o.frusta) {
                auto origin = glm::vec3(camera[3]);
                std::array<glm::vec3, 4> corners;
                int i = 0;
                for (auto v :
                     std::array<glm::vec3, 4>{{{0, 0, 0}, {1, 0, 0}, {1, 1, 0}, {0, 1, 0}}})
                    corners[i++] = glm::vec3(plane_transform * glm::vec4(v, 1));
                for (i = 0; i < 4; ++i) {
                    auto colour = calibration.side == "left" ? glm::vec4(.30f, .50f, .65f, .45f)
                                                             : glm::vec4(.65f, .40f, .33f, .45f);
                    p.segment(origin, corners[i], .0012f, colour);
                    colour.a = .7f;
                    p.segment(corners[i], corners[(i + 1) % 4], .0015f, colour);
                }
            }
        }
    }
    p.hand_drawn = p.hand_mesh = {};
    for (int side = 0; side < 2; ++side) {
        const auto& presentation = p.hand_presentation[side];
        if (!o.hands || !presentation.retained())
            continue;
        const auto& hand = presentation.pose();
        glm::vec4 colour =
            side == 0 ? glm::vec4(.27f, .64f, .95f, 1) : glm::vec4(.95f, .47f, .38f, 1);
        const bool draw_mesh = o.hand_level == HandLevel::mesh &&
                               presentation.use_mesh(hand_pose_supported(hand, side == 0, p.hand_assets));
        if (draw_mesh) {
            auto transforms = hand_transforms(hand, side == 0, p.hand_assets);
            std::array<float, 25> validity{};
            std::array<float, 25> opacity{};
            std::array<std::array<float, 3>, 25> joint_colours{};
            for (int j = 0; j < 25; ++j) {
                validity[j] = (presentation.observed_mask() & (1u << j)) ? 1.f : 0.f;
                opacity[j] = presentation.opacity(j);
                joint_colours[j] = hand_colour(o.hand_colour, side, {},
                                               p.hand_trails.joint_velocity(side, j));
            }
            p.hand_drawn[side] = std::any_of(opacity.begin(), opacity.end(), [](float alpha) { return alpha > .001f; });
            p.hand_mesh[side] = p.hand_drawn[side];
            glDepthMask(std::all_of(opacity.begin(), opacity.end(), [](float alpha) { return alpha >= .999f; })
                            ? GL_TRUE : GL_FALSE);
            p.model(glm::mat4(1), colour);
            p.set("skinned", 1);
            p.set("hand_colouring", static_cast<int>(o.hand_colour));
            glUniform1fv(glGetUniformLocation(p.shader, "joint_valid"), 25, validity.data());
            glUniform1fv(glGetUniformLocation(p.shader, "joint_opacity"), 25, opacity.data());
            glUniform3fv(glGetUniformLocation(p.shader, "joint_colour"), 25,
                         joint_colours[0].data());
            glUniformMatrix4fv(glGetUniformLocation(p.shader, "bones"), 25, GL_FALSE,
                               glm::value_ptr(transforms[0]));
            (side == 0 ? p.left : p.right).draw();
            p.set("skinned", 0);
        }
        if (draw_mesh)
            continue;
        // A partially tracked palm can still provide useful current joints.
        // Mesh mode falls back to those joints immediately, with the same
        // independent hold/fade clocks as the explicit points and bones modes.
        const bool mesh_fallback = o.hand_level == HandLevel::mesh;
        for (int j = 0; j < 25; ++j) {
            const float alpha = presentation.opacity(j);
            if (!(hand.joint_mask & (1u << j)) || alpha <= .001f)
                continue;
            auto v = glm::vec3(hand.values[j * 8], hand.values[j * 8 + 1], hand.values[j * 8 + 2]);
            const auto normal = glm::vec3(pose_transform(hand.values.data() + j * 8)[2]);
            const auto rgb = hand_colour(o.hand_colour, side, {normal.x, normal.y, normal.z},
                                         p.hand_trails.joint_velocity(side, j));
            const glm::vec4 joint_colour{rgb[0], rgb[1], rgb[2], alpha};
            const bool lighting = o.hand_colour == HandColour::side;
            glDepthMask(alpha >= .999f ? GL_TRUE : GL_FALSE);
            if (o.hand_level == HandLevel::points || mesh_fallback) {
                float radius = std::max(.0025f, hand.values[j * 8 + 7] * .48f);
                p.model(glm::translate(glm::mat4(1), v) *
                            glm::scale(glm::mat4(1), glm::vec3(radius)),
                        joint_colour, lighting);
                p.sphere.draw();
                p.hand_drawn[side] = true;
            }
            if ((o.hand_level == HandLevel::outline || o.hand_level == HandLevel::bones || mesh_fallback) &&
                joint_parents[j] >= 0 && (hand.joint_mask & (1u << joint_parents[j]))) {
                int b = joint_parents[j] * 8;
                const bool outline = o.hand_level == HandLevel::outline;
                auto bone_colour = joint_colour;
                bone_colour.a = std::min(alpha, presentation.opacity(joint_parents[j]));
                glDepthMask(bone_colour.a >= .999f ? GL_TRUE : GL_FALSE);
                p.segment(v, {hand.values[b], hand.values[b + 1], hand.values[b + 2]},
                          outline ? .0008f : .003f, bone_colour, lighting && !outline);
                p.hand_drawn[side] |= bone_colour.a > .001f;
            }
        }
    }
    glDepthMask(GL_TRUE);
    auto& depth_volume = o.environment_depth ? p.environment : p.stereo;
    const float voxel_focal = float(scene_height) / (2.f * std::tan(glm::radians(24.f)));
    if (o.depth && o.recorded_map_visible)
        depth_volume.refresh_lod(p.eye, voxel_focal, o.depth_lod);
    if (o.depth && o.recorded_map_visible && depth_volume.current >= 0) {
        auto& slot = depth_volume.slots[depth_volume.current];
        const bool current = depth_volume.frozen ||
                             (slot.frame.epoch == s.epoch && slot.frame.space_epoch == s.space_epoch);
        if (current) {
            const auto display_wall = monotonic_us();
            if (o.map_headset_world_matches && slot.frame.epoch == s.epoch && slot.frame.space_epoch == s.space_epoch) {
                if (p.headset_origin)
                    depth_volume.colour_origin = p.headset_origin;
                depth_volume.display_time_us = appearance_now;
                depth_volume.display_wall_us = display_wall;
            } else if (!depth_volume.display_wall_us) {
                depth_volume.display_time_us = depth_volume.last_observation_us;
                depth_volume.display_wall_us = display_wall;
            }
            const auto elapsed = std::max<int64_t>(0, display_wall - depth_volume.display_wall_us);
            const auto map_time = depth_volume.display_time_us > std::numeric_limits<int64_t>::max() - elapsed
                                      ? std::numeric_limits<int64_t>::max()
                                      : depth_volume.display_time_us + elapsed;
            const auto [fade_now, fade_duration] = depth_volume.fade_timing(trail_time_scale);
            p.map_shader->draw(slot.vao, GLsizei(depth_volume.volume->capacity()), vp,
                               o.point_size, o.depth_opacity * o.recorded_map_opacity,
                               depth_volume.colour_origin,
                               o.depth_min, o.depth_max, o.map_shader, map_time,
                               o.map_density, o.map_recency_seconds, o.map_style,
                               o.map_relief_strength, glm::mat4(1.f), true, fade_now, fade_duration,
                               o.map_gradient);
            if (slot.fence)
                glDeleteSync(slot.fence);
            slot.fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        }
    }
    if (p.saved_state.loaded && o.saved_map_visible) {
        const bool placed = p.saved_state.placed;
        const auto transform = placed ? glm::mat4(1.f) : p.saved_state.world_from_map;
        const auto local_eye = glm::vec3(glm::inverse(transform) * glm::vec4(p.eye, 1.f));
        const auto scale = std::max({glm::length(glm::vec3(transform[0])),
                                    glm::length(glm::vec3(transform[1])),
                                    glm::length(glm::vec3(transform[2]))});
        p.saved.refresh_lod(local_eye, voxel_focal * scale, o.depth_lod);
        if (p.saved.current >= 0) {
            auto& slot = p.saved.slots[p.saved.current];
            if (p.current_headset_transform && (!placed || (p.headset_epoch == p.saved_metadata.epoch &&
                                                            p.headset_space_epoch == p.saved_metadata.space_epoch)))
                p.saved.colour_origin = glm::vec3((*p.current_headset_transform)[3]);
            const auto elapsed = std::max<int64_t>(0, monotonic_us() - p.saved.display_wall_us);
            const auto time = p.saved.display_time_us > std::numeric_limits<int64_t>::max() - elapsed
                ? std::numeric_limits<int64_t>::max() : p.saved.display_time_us + elapsed;
            const auto [fade_now, fade_duration] = p.saved.fade_timing(trail_time_scale);
            p.map_shader->draw(slot.vao, GLsizei(p.saved.volume->capacity()), vp,
                               o.point_size, (placed ? o.depth_opacity : .12f) * o.saved_map_opacity,
                               p.saved.colour_origin, o.depth_min, o.depth_max,
                               placed ? o.map_shader : SpatialMapShader::distance, time,
                               o.map_density, o.map_recency_seconds,
                               placed ? o.map_style : SpatialMapStyle::points,
                               o.map_relief_strength, transform, placed, fade_now, fade_duration,
                               o.map_gradient);
            if (slot.fence)
                glDeleteSync(slot.fence);
            slot.fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        }
    }
    if (o.trails && o.trail_mode != TrailMode::off) {
        p.set("trail", 1);
        p.trail_mesh.draw(p.hand_trails, o.trail_mode, o.trail_colour);
        p.set("trail", 0);
    }
    // Composite camera images after geometry so partial opacity reveals hands
    // and map surfaces behind the plane while retaining foreground occlusion.
    const float plane_alpha = std::clamp(o.plane_opacity, 0.f, 1.f);
    if (plane_alpha > 0 && image_plane_count) {
        std::sort(image_planes.begin(), image_planes.begin() + image_plane_count,
                  [](const auto& a, const auto& b) { return a.distance_squared > b.distance_squared; });
        glDepthMask(plane_alpha >= 1.f ? GL_TRUE : GL_FALSE);
        glActiveTexture(GL_TEXTURE0);
        p.set("camera", 0);
        for (size_t i = 0; i < image_plane_count; ++i) {
            const auto& plane = image_planes[i];
            p.model(plane.transform, {1, 1, 1, plane_alpha}, false);
            p.set("textured", 1);
            glBindTexture(GL_TEXTURE_2D, plane.texture);
            p.plane.draw();
        }
        p.set("textured", 0);
        glDepthMask(GL_TRUE);
    }
    glBindVertexArray(0);
    glUseProgram(0);
    glViewport(0, 0, w, h);
}
void Renderer::finish_frame() {
    auto& p = *impl_;
    if (p.query_open) {
        glEndQuery(GL_TIME_ELAPSED);
        p.query_open = false;
        ++p.frame;
    }
    for (auto& camera : p.cameras) {
        if (camera.current >= 0) {
            auto& t = camera.textures[camera.current];
            if (t.fence)
                glDeleteSync(t.fence);
            t.fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        }
    }
}
void Renderer::notify_presented() {
    auto& p = *impl_;
    const auto& primary = p.cameras[0];
    if (primary.current >= 0 && p.notified_count != p.count) {
        p.latency = (monotonic_us() - primary.presented.receive_us) / 1000.0;
        p.notified_count = p.count;
    }
    for (size_t side = 0; side < p.hand_presentation.size(); ++side) {
        const auto& presentation = p.hand_presentation[side];
        const auto sequence = presentation.pose().sequence;
        if (!p.hand_drawn[side] || !presentation.observed_mask() || p.drawn_hand_sequence[side] == sequence)
            continue;
        ++p.hand_update_count[side];
        if (p.drawn_hand_sequence[side] && primary.current >= 0 &&
            p.drawn_camera_sequence[side] == primary.presented.sequence)
            ++p.hand_updates_without_video[side];
        p.drawn_hand_sequence[side] = sequence;
        p.drawn_camera_sequence[side] = primary.current >= 0
                                          ? std::optional<uint32_t>{primary.presented.sequence} : std::nullopt;
    }
}
unsigned Renderer::video_texture(size_t camera_index) const {
    if (camera_index >= impl_->cameras.size())
        return 0;
    const auto& camera = impl_->cameras[camera_index];
    return camera.current < 0 ? 0 : camera.textures[camera.current].id;
}
CameraPresentation Renderer::camera_presentation(const ReceiverSnapshot& snapshot,
                                                size_t camera_index) const {
    if (camera_index >= impl_->cameras.size())
        return {};
    const auto& camera = impl_->cameras[camera_index];
    const bool current = camera.current >= 0 && camera.presented.epoch == snapshot.epoch &&
                         camera.presented.space_epoch == snapshot.space_epoch;
    const bool placed = current && camera.have_conversion && camera.converted_calibration.side != "unknown" &&
                        detail::associated_camera_head(camera.presented, snapshot.epoch,
                                                       snapshot.space_epoch).has_value();
    return {video_texture(camera_index), camera.width, camera.height, camera.presented.sequence,
            current, placed};
}
int Renderer::video_width(size_t camera_index) const {
    return camera_index < impl_->cameras.size() ? impl_->cameras[camera_index].width : 0;
}
int Renderer::video_height(size_t camera_index) const {
    return camera_index < impl_->cameras.size() ? impl_->cameras[camera_index].height : 0;
}
double Renderer::gpu_ms() const {
    return impl_->gpu;
}
double Renderer::video_latency_ms() const {
    return impl_->latency;
}
uint64_t Renderer::presented_frames() const {
    return impl_->count;
}
void Renderer::screenshot(const std::filesystem::path& path) {
    int w, h;
    glfwGetFramebufferSize(impl_->window, &w, &h);
    std::vector<unsigned char> pixels(size_t(w) * h * 3);
    GLint previous_framebuffer = 0, previous_buffer = 0;
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &previous_framebuffer);
    glGetIntegerv(GL_READ_BUFFER, &previous_buffer);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, impl_->offscreen_framebuffer);
    glReadBuffer(impl_->offscreen ? GL_COLOR_ATTACHMENT0 : GL_BACK);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, w, h, GL_RGB, GL_UNSIGNED_BYTE, pixels.data());
    glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(previous_framebuffer));
    glReadBuffer(static_cast<GLenum>(previous_buffer));
    if (!path.parent_path().empty())
        std::filesystem::create_directories(path.parent_path());
    std::ofstream f(path, std::ios::binary);
    f << "P6\n" << w << ' ' << h << "\n255\n";
    for (int y = h - 1; y >= 0; --y)
        f.write(reinterpret_cast<const char*>(pixels.data() + size_t(y) * w * 3), w * 3);
    if (!f)
        throw std::runtime_error("Cannot write screenshot");
}
} // namespace ceres
