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
#include <glad/gl.h>
#include <GLFW/glfw3.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cuda_gl_interop.h>
#include <fstream>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/type_ptr.hpp>
#include <glm/gtx/quaternion.hpp>
#include <stdexcept>
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
layout(location=12) in float point_valid;
uniform mat4 vp,model,bones[25];
uniform float joint_valid[25];
uniform vec3 joint_colour[25];
uniform int skinned,trail,point_cloud;
uniform float point_size,point_limit,voxel_size,voxel_focal,voxel_opacity;
uniform vec3 headset_origin,depth_palette[8];
uniform int headset_origin_valid;
uniform vec2 depth_range;
out vec3 N; out vec3 P; out vec2 UV; out float validity;
out float point_confidence;
out vec4 path_colour;
out vec3 visual_colour;
mat4 skin(ivec4 j,vec4 w) {
    return bones[j.x]*w.x+bones[j.y]*w.y+bones[j.z]*w.z+bones[j.w]*w.w;
}
float valid(ivec4 j,vec4 w) {
    return dot(vec4(joint_valid[j.x],joint_valid[j.y],joint_valid[j.z],joint_valid[j.w]),w);
}
vec3 skin_colour(ivec4 j,vec4 w) {
    return joint_colour[j.x]*w.x+joint_colour[j.y]*w.y+joint_colour[j.z]*w.z+joint_colour[j.w]*w.w;
}
void main() {
    visual_colour=vec3(1);
    point_confidence=0;
    if(point_cloud!=0) {
        N=vec3(0,0,1); P=position; UV=vec2(0); validity=point_valid;
        point_confidence=clamp(trail_colour.a,0,1);
        float alpha=voxel_opacity*point_confidence;
        vec4 clip=vp*vec4(position,1);
        float footprint=voxel_size*point_valid*voxel_focal/max(.01,clip.w);
        float distance_fraction=clamp((length(position-headset_origin)-depth_range.x)/
                                      max(.0001,depth_range.y-depth_range.x),0,1);
        float palette_position=distance_fraction*7;
        int palette_index=min(int(palette_position),6);
        vec3 depth_colour=mix(depth_palette[palette_index],depth_palette[palette_index+1],
                              palette_position-float(palette_index));
        path_colour=vec4(headset_origin_valid!=0 ? depth_colour : vec3(.72),alpha);
        gl_PointSize=clamp(max(point_size,footprint),1,point_limit);
        gl_Position=point_valid>0 && alpha>.001 && clip.w>0 ? clip : vec4(2,2,2,1);
        return;
    }
    if(trail!=0) {
        N=vec3(0,0,1); P=position; UV=vec2(0); validity=1;
        path_colour=trail_colour; gl_Position=vp*vec4(position,1); return;
    }
    path_colour=vec4(0);
    mat4 m=model; validity=1;
    if(skinned!=0) {
        m=skin(joints,weights)+skin(joints1,weights1)+skin(joints2,weights2)+skin(joints3,weights3);
        validity=clamp(valid(joints,weights)+valid(joints1,weights1)+valid(joints2,weights2)+valid(joints3,weights3),0.0,1.0);
        visual_colour=skin_colour(joints,weights)+skin_colour(joints1,weights1)+skin_colour(joints2,weights2)+skin_colour(joints3,weights3);
    }
    vec4 p=m*vec4(position,1); P=p.xyz;
    mat3 basis=mat3(m);
    vec3 n=abs(determinant(basis))>1e-7 ? transpose(inverse(basis))*normal : basis*normal;
    N=dot(n,n)>1e-12 ? normalize(n) : vec3(0,0,1);
    UV=uv; gl_Position=vp*p;
})GLSL";
    const char* fragment = R"GLSL(#version 450 core
in vec3 N; in vec3 P; in vec2 UV; in float validity;
in float point_confidence;
in vec4 path_colour;
in vec3 visual_colour;
out vec4 colour;
uniform vec4 tint;
uniform sampler2D camera,normal_map,orm_map;
uniform int textured,lit,material_mask,trail,point_cloud;
uniform int point_pass;
uniform int hand_colouring;
uniform float material_metallic,material_roughness;
uniform vec3 eye;
void main() {
    if(point_cloud!=0) {
        if(validity<=0 || path_colour.a<=.001 || dot(gl_PointCoord-.5,gl_PointCoord-.5)>.25) discard;
        bool supported=point_confidence>=.999;
        if((point_pass<2 && !supported) || (point_pass==2 && supported)) discard;
        colour=path_colour; return;
    }
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
    colour=vec4(c,alpha*mix(.16,1.0,validity));
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

    cudaError_t snapshot(StereoPoint* output) {
        const auto result = adaptive_lod ? volume->snapshot_lod(output, lod_view, stream)
                                         : volume->snapshot(output, stream);
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
        lod_view.target_pixels = 10.f;
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
                StereoPoint* output = nullptr;
                size_t bytes = 0;
                cuda_check(cudaGraphicsResourceGetMappedPointer(reinterpret_cast<void**>(&output),
                                                                &bytes, slot.resource),
                           "Access detail buffer");
                if (bytes < volume->capacity() * sizeof(StereoPoint))
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
            return;
        }
    }

    void clear() {
        ++generation;
        current = -1;
        displayed = 0;
        have_submission = false;
        reset_volume = true;
        time_origin_us.reset();
        last_observation_us = 0;
        have_lod_snapshot = false;
        last_lod_refresh_us = 0;
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
                current = int(i);
                displayed = slot.serial;
            }
        }
    }
    void release() {
        // Resource changes and teardown may wait. Normal frame submission never does.
        if (stream)
            cudaStreamSynchronize(stream);
        for (auto& slot : slots) {
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
        workspace.reset();
        volume.reset();
        cudaFree(reconstructed);
        reconstructed = nullptr;
        cudaFree(depth_samples);
        depth_samples = nullptr;
        width = height = 0;
        clear();
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
        volume = std::make_unique<StereoVoxelVolume>();
        reset_volume = true;
        for (auto& slot : slots) {
            glGenVertexArrays(1, &slot.vao);
            glGenBuffers(1, &slot.vbo);
            glBindVertexArray(slot.vao);
            glBindBuffer(GL_ARRAY_BUFFER, slot.vbo);
            glBufferData(GL_ARRAY_BUFFER, volume->capacity() * sizeof(StereoPoint), nullptr,
                         GL_DYNAMIC_DRAW);
            glEnableVertexAttribArray(0);
            glEnableVertexAttribArray(11);
            glEnableVertexAttribArray(12);
            glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(StereoPoint), nullptr);
            glVertexAttribPointer(11, 4, GL_FLOAT, GL_FALSE, sizeof(StereoPoint),
                                  reinterpret_cast<void*>(offsetof(StereoPoint, r)));
            glVertexAttribPointer(12, 1, GL_FLOAT, GL_FALSE, sizeof(StereoPoint),
                                  reinterpret_cast<void*>(offsetof(StereoPoint, valid)));
            cuda_check(cudaGraphicsGLRegisterBuffer(&slot.resource, slot.vbo,
                                                    cudaGraphicsRegisterFlagsWriteDiscard),
                       "Register stereo point buffer");
            cuda_check(cudaEventCreate(&slot.started), "Create stereo start event");
            cuda_check(cudaEventCreate(&slot.ready), "Create stereo completion event");
        }
        glBindVertexArray(0);
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
    std::array<std::optional<PoseSample>, 2> mesh_held;
    std::array<detail::TrackingVisibility, 2> mesh_visibility;
    glm::vec3 target{0, 1.5f, -.45f}, eye{};
    std::optional<glm::vec3> headset_origin;
    uint32_t headset_epoch = 0, headset_space_epoch = 0;
    float yaw = .48f, pitch = .23f, distance = 1.85f;
    float point_size_limit = 1;
    float scene_width_fraction = 1;
    float scene_top_fraction = 0;
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
    StereoBuffers stereo, environment;
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
        GLfloat point_sizes[2]{};
        glGetFloatv(GL_POINT_SIZE_RANGE, point_sizes);
        point_size_limit = std::max(1.f, point_sizes[1]);
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
        mesh_held = {};
        mesh_visibility = {};
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
    bool cursor_in_scene(double x, double y) const {
        int w, h;
        glfwGetWindowSize(window, &w, &h);
        return w > 0 && h > 0 && glfwGetWindowAttrib(window, GLFW_ICONIFIED) == GLFW_FALSE &&
               x >= 0 && y >= double(h) * scene_top_fraction &&
               x < double(w) * scene_width_fraction && y < h;
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
}
void Renderer::set_scene_top_fraction(float fraction) {
    auto& p = *impl_;
    fraction = std::isfinite(fraction) ? std::clamp(fraction, 0.f, .95f) : 0.f;
    if (p.scene_top_fraction != fraction) {
        p.scene_top_fraction = fraction;
        p.scene_drag = {};
    }
}
void Renderer::frame_hands(const ReceiverSnapshot& s) {
    glm::vec3 t{};
    int n = 0;
    for (int i = 1; i < 3; ++i)
        if (s.poses[i] && s.poses[i]->valid) {
            auto& v = s.poses[i]->values;
            t += glm::vec3(v[0], v[1], v[2]);
            ++n;
        }
    if (n) {
        impl_->target = t / float(n);
        impl_->distance = .75f;
    }
}
void Renderer::headset_view(const ReceiverSnapshot& s) {
    const auto& p = *impl_;
    if (s.epoch != p.epoch || s.space_epoch != p.space_epoch || !p.held[0])
        return;
    const auto& v = p.held[0]->values;
    auto m = pose_transform(v.data());
    auto d = glm::vec3(m * glm::vec4(0, 0, 1, 0));
    impl_->yaw = std::atan2(d.x, d.z);
    impl_->pitch = std::asin(std::clamp(d.y, -1.f, 1.f));
    impl_->distance = .02f;
    impl_->target = glm::vec3(m[3]) - d * .02f;
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
    if (scene_mouse) {
        if (p.scene_drag[GLFW_MOUSE_BUTTON_LEFT] || right) {
            p.yaw -= dx * .004f;
            p.pitch = std::clamp(p.pitch + dy * .004f, -1.5f, 1.5f);
        }
        if (p.scene_drag[GLFW_MOUSE_BUTTON_MIDDLE]) {
            auto r = glm::normalize(glm::cross(glm::vec3(0, 1, 0), p.direction()));
            auto u = glm::cross(p.direction(), r);
            p.target += (-dx * r + dy * u) * p.distance * .0012f;
        }
    }
    if (!keyboard && scene_mouse && right) {
        float speed = float(dt) *
                      (.8f * (glfwGetKey(p.window, GLFW_KEY_LEFT_SHIFT) == GLFW_PRESS ? 3.f : 1.f));
        auto forward = -p.direction(),
             side = glm::normalize(glm::cross(forward, glm::vec3(0, 1, 0)));
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
}
void Renderer::zoom(float delta) {
    double x, y;
    glfwGetCursorPos(impl_->window, &x, &y);
    if (!impl_->cursor_in_scene(x, y))
        return;
    impl_->distance = std::clamp(impl_->distance * std::exp(-delta * .12f), .02f, 30.f);
}
void Renderer::invalidate_poses() {
    impl_->clear_pose_state();
}
void Renderer::update_headset_position(const ReceiverSnapshot& snapshot, double time_scale) {
    auto& p = *impl_;
    if (p.headset_epoch != snapshot.epoch || p.headset_space_epoch != snapshot.space_epoch) {
        p.headset_origin.reset();
        p.headset_epoch = snapshot.epoch;
        p.headset_space_epoch = snapshot.space_epoch;
    }
    if (!snapshot.poses[0] || !fresh_pose(snapshot, *snapshot.poses[0], time_scale))
        return;
    const auto& head = *snapshot.poses[0];
    if (std::isfinite(head.values[0]) && std::isfinite(head.values[1]) &&
        std::isfinite(head.values[2]))
        p.headset_origin = glm::vec3(head.values[0], head.values[1], head.values[2]);
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
void Renderer::invalidate_video() {
    auto& p = *impl_;
    p.headset_origin.reset();
    p.environment.clear();
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
    clear_stereo();
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
    if (!stereo.calibration || stereo.calibration->left != calibration.left ||
        stereo.calibration->right != calibration.right || stereo.voxel_size != voxel_size ||
        (stereo.have_submission &&
         (stereo.submitted[0].epoch != a.event.epoch ||
          stereo.submitted[0].space_epoch != a.event.space_epoch ||
          stereo.submitted[0].attributes.value("replay_generation", uint64_t(0)) !=
              a.event.attributes.value("replay_generation", uint64_t(0))))) {
        stereo.clear();
        stereo.calibration = calibration;
        stereo.min_depth = min_depth;
        stereo.max_depth = max_depth;
        stereo.voxel_size = voxel_size;
    }
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
    slot.leases = {left, right};
    bool mapped = false;
    try {
        cuda_check(cudaGraphicsMapResources(1, &slot.resource, stereo.stream),
                   "Map stereo point buffer");
        mapped = true;
        StereoPoint* output = nullptr;
        size_t bytes = 0;
        cuda_check(cudaGraphicsResourceGetMappedPointer(reinterpret_cast<void**>(&output), &bytes,
                                                        slot.resource),
                   "Access stereo point buffer");
        if (bytes < stereo.volume->capacity() * sizeof(StereoPoint))
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
    slot.serial = ++stereo.serial;
    slot.frame = a.event;
    stereo.last_observation_us = observation_time_us;
    stereo.submitted = {a.event, b.event};
    stereo.have_submission = true;
    return true;
}
void Renderer::clear_stereo() {
    impl_->stereo.clear();
}
double Renderer::stereo_ms() const {
    return impl_->stereo.milliseconds;
}
bool Renderer::update_environment_depth(const SessionEvent& event, float min_depth, float max_depth,
                                        float voxel_size, int64_t observation_time_us,
                                        const HandMaskSet& hands) {
    if (event.kind != EventKind::Depth || observation_time_us < 0 || !std::isfinite(voxel_size) ||
        voxel_size < .01f || voxel_size > .1f)
        return false;
    const auto frame = decode_depth(event.payload);
    auto& volume = impl_->environment;
    volume.poll();
    if (volume.voxel_size != voxel_size ||
        (volume.have_submission &&
         (volume.submitted[0].epoch != event.epoch ||
          volume.submitted[0].space_epoch != event.space_epoch ||
          volume.submitted[0].attributes.value("replay_generation", uint64_t(0)) !=
              event.attributes.value("replay_generation", uint64_t(0))))) {
        volume.clear();
        volume.min_depth = min_depth;
        volume.max_depth = max_depth;
        volume.voxel_size = voxel_size;
    }
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
    bool mapped = false;
    try {
        cuda_check(cudaGraphicsMapResources(1, &slot.resource, volume.stream),
                   "Map environment volume");
        mapped = true;
        StereoPoint* output = nullptr;
        size_t bytes = 0;
        cuda_check(cudaGraphicsResourceGetMappedPointer(reinterpret_cast<void**>(&output), &bytes,
                                                        slot.resource),
                   "Access environment volume");
        if (bytes < volume.volume->capacity() * sizeof(StereoPoint))
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
    slot.serial = ++volume.serial;
    slot.frame = event;
    volume.last_observation_us = observation_time_us;
    volume.submitted[0] = event;
    volume.have_submission = true;
    return true;
}
void Renderer::clear_environment_depth() {
    impl_->environment.clear();
}
double Renderer::environment_depth_ms() const {
    return impl_->environment.milliseconds;
}
size_t Renderer::depth_map_bytes(bool environment) const {
    const auto& map = environment ? impl_->environment : impl_->stereo;
    return map.volume ? map.volume->scratch_bytes() +
                            map.slots.size() * map.volume->capacity() * sizeof(StereoPoint)
                      : 0;
}
void Renderer::draw(const ReceiverSnapshot& s, const Calibration& c, const ViewOptions& o,
                    int64_t trail_time_us, double trail_time_scale, int64_t scene_time_us) {
    auto& p = *impl_;
    p.stereo.poll();
    p.environment.poll();
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
    const int scene_height = std::max(1, int(double(h) * (1.f - p.scene_top_fraction)));
    if (scene_width <= 0)
        return;
    glViewport(0, 0, scene_width, scene_height);
    glEnable(GL_DEPTH_TEST);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glUseProgram(p.shader);
    p.eye = p.target + p.direction() * p.distance;
    auto vp = glm::perspective(glm::radians(48.f), float(scene_width) / scene_height, .01f, 100.f) *
              glm::lookAt(p.eye, p.target, glm::vec3(0, 1, 0));
    glUniformMatrix4fv(glGetUniformLocation(p.shader, "vp"), 1, GL_FALSE, glm::value_ptr(vp));
    glUniform3fv(glGetUniformLocation(p.shader, "eye"), 1, glm::value_ptr(p.eye));
    int64_t now = s.now_us ? s.now_us : monotonic_us();
    const int64_t appearance_now = scene_time_us >= 0 ? scene_time_us : now;
    p.hand_trails.update(s, true, o.trail_seconds, trail_time_us >= 0 ? trail_time_us : now,
                         trail_time_scale);
    for (int i = 0; i < 3; ++i) {
        p.fresh[i] = false;
        if (s.poses[i]) {
            auto& a = *s.poses[i];
            if (fresh_pose(s, a, trail_time_scale)) {
                p.held[i] = a;
                p.fresh[i] = true;
            }
        }
        using LossPolicy = detail::TrackingVisibility::LossPolicy;
        p.tracking_visibility[i].update(appearance_now, p.fresh[i], s.epoch, s.space_epoch,
                                        i == 0 ? LossPolicy::Hold : LossPolicy::Fade);
        if (!p.tracking_visibility[i].retained())
            p.held[i].reset();
    }
    for (int side = 0; side < 2; ++side) {
        const bool supported = p.fresh[side + 1] && p.held[side + 1] &&
                               hand_pose_supported(*p.held[side + 1], side == 0, p.hand_assets);
        if (supported) {
            p.mesh_held[side] = p.held[side + 1];
        }
        p.mesh_visibility[side].update(appearance_now, supported, s.epoch, s.space_epoch);
        if (!p.mesh_visibility[side].retained())
            p.mesh_held[side].reset();
    }
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
    for (size_t camera_index = 0; camera_index < p.cameras.size(); ++camera_index) {
        const auto& image = p.cameras[camera_index];
        if (camera_index != 0 && !image.have_conversion)
            continue;
        const auto& calibration = image.have_conversion ? image.converted_calibration : c;
        bool image_in_space = image.current >= 0 && image.presented.epoch == s.epoch &&
                              image.presented.space_epoch == s.space_epoch;
        glm::mat4 camera(1);
        bool have_camera = false, image_has_head = false;
        auto values = image.presented.attributes.find("head_pose");
        if (image_in_space && values != image.presented.attributes.end() && values->is_array() &&
            values->size() == 7) {
            auto v = values->get<std::array<float, 7>>();
            camera = pose_transform(v.data());
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
                p.model(plane_transform, {1, 1, 1, o.plane_opacity}, false);
                p.set("textured", 1);
                glActiveTexture(GL_TEXTURE0);
                glBindTexture(GL_TEXTURE_2D, image.textures[image.current].id);
                p.set("camera", 0);
                p.plane.draw();
                p.set("textured", 0);
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
    for (int side = 0; side < 2; ++side) {
        int k = side + 1;
        if (!o.hands || !p.held[k] || p.tracking_visibility[k].alpha() <= .001f)
            continue;
        auto& hand = *p.held[k];
        glm::vec4 colour =
            side == 0 ? glm::vec4(.27f, .64f, .95f, 1) : glm::vec4(.95f, .47f, .38f, 1);
        colour.a = p.tracking_visibility[k].alpha();
        if (o.hand_level == HandLevel::mesh && p.mesh_held[side] &&
            p.mesh_visibility[side].alpha() > .001f) {
            const auto& mesh_pose = *p.mesh_held[side];
            auto transforms = hand_transforms(mesh_pose, side == 0, p.hand_assets);
            auto mesh_colour = colour;
            mesh_colour.a = std::min(colour.a, p.mesh_visibility[side].alpha());
            glDepthMask(mesh_colour.a >= .999f ? GL_TRUE : GL_FALSE);
            std::array<float, 25> validity{};
            std::array<std::array<float, 3>, 25> joint_colours{};
            for (int j = 0; j < 25; ++j) {
                validity[j] = (mesh_pose.joint_mask & (1u << j)) ? 1.f : 0.f;
                joint_colours[j] = hand_colour(o.hand_colour, side, {},
                                               p.hand_trails.joint_velocity(side, j));
            }
            p.model(glm::mat4(1), mesh_colour);
            p.set("skinned", 1);
            p.set("hand_colouring", static_cast<int>(o.hand_colour));
            glUniform1fv(glGetUniformLocation(p.shader, "joint_valid"), 25, validity.data());
            glUniform3fv(glGetUniformLocation(p.shader, "joint_colour"), 25,
                         joint_colours[0].data());
            glUniformMatrix4fv(glGetUniformLocation(p.shader, "bones"), 25, GL_FALSE,
                               glm::value_ptr(transforms[0]));
            (side == 0 ? p.left : p.right).draw();
            p.set("skinned", 0);
        }
        if (o.hand_level == HandLevel::mesh)
            continue;
        glDepthMask(colour.a >= .999f ? GL_TRUE : GL_FALSE);
        for (int j = 0; j < 25; ++j) {
            if (!(hand.joint_mask & (1u << j)))
                continue;
            auto v = glm::vec3(hand.values[j * 8], hand.values[j * 8 + 1], hand.values[j * 8 + 2]);
            const auto normal = glm::vec3(pose_transform(hand.values.data() + j * 8)[2]);
            const auto rgb = hand_colour(o.hand_colour, side, {normal.x, normal.y, normal.z},
                                         p.hand_trails.joint_velocity(side, j));
            const glm::vec4 joint_colour{rgb[0], rgb[1], rgb[2], colour.a};
            const bool lighting = o.hand_colour == HandColour::side;
            if (o.hand_level == HandLevel::points) {
                float radius = std::max(.0025f, hand.values[j * 8 + 7] * .48f);
                p.model(glm::translate(glm::mat4(1), v) *
                            glm::scale(glm::mat4(1), glm::vec3(radius)),
                        joint_colour, lighting);
                p.sphere.draw();
            }
            if ((o.hand_level == HandLevel::outline || o.hand_level == HandLevel::bones) &&
                joint_parents[j] >= 0 && (hand.joint_mask & (1u << joint_parents[j]))) {
                int b = joint_parents[j] * 8;
                const bool outline = o.hand_level == HandLevel::outline;
                p.segment(v, {hand.values[b], hand.values[b + 1], hand.values[b + 2]},
                          outline ? .0008f : .003f, joint_colour, lighting && !outline);
            }
        }
    }
    glDepthMask(GL_TRUE);
    auto& depth_volume = o.environment_depth ? p.environment : p.stereo;
    const float voxel_focal = float(scene_height) / (2.f * std::tan(glm::radians(24.f)));
    if (o.depth)
        depth_volume.refresh_lod(p.eye, voxel_focal, o.depth_lod);
    if (o.depth && depth_volume.current >= 0) {
        auto& slot = depth_volume.slots[depth_volume.current];
        const bool current = slot.frame.epoch == s.epoch && slot.frame.space_epoch == s.space_epoch;
        if (current) {
            p.model(glm::mat4(1), {1, 1, 1, 1}, false);
            p.set("point_cloud", 1);
            glUniform1f(glGetUniformLocation(p.shader, "point_size"),
                        std::clamp(o.point_size, 1.f, 8.f));
            glUniform1f(glGetUniformLocation(p.shader, "point_limit"), p.point_size_limit);
            glUniform1f(glGetUniformLocation(p.shader, "voxel_size"), depth_volume.voxel_size);
            glUniform1f(glGetUniformLocation(p.shader, "voxel_focal"), voxel_focal);
            glUniform1f(glGetUniformLocation(p.shader, "voxel_opacity"),
                        std::clamp(o.depth_opacity, 0.f, 1.f));
            glUniform2f(glGetUniformLocation(p.shader, "depth_range"), o.depth_min, o.depth_max);
            p.set("headset_origin_valid", p.headset_origin.has_value() ? 1 : 0);
            const auto origin = p.headset_origin.value_or(glm::vec3(0));
            glUniform3fv(glGetUniformLocation(p.shader, "headset_origin"), 1, glm::value_ptr(origin));
            static const auto depth_palette = [] {
                std::array<float, 24> palette{};
                for (int i = 0; i < 8; ++i) {
                    const auto colour = spectral_depth_colour(float(i) / 7.f);
                    palette[size_t(i) * 3] = colour.r;
                    palette[size_t(i) * 3 + 1] = colour.g;
                    palette[size_t(i) * 3 + 2] = colour.b;
                }
                return palette;
            }();
            glUniform3fv(glGetUniformLocation(p.shader, "depth_palette"), 8, depth_palette.data());
            glEnable(GL_PROGRAM_POINT_SIZE);
            glBindVertexArray(slot.vao);
            // Resolve confident surfaces before blending. Hash-table order must
            // not let farther points overpaint a retained nearer surface.
            p.set("point_pass", 0);
            glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
            glDepthMask(GL_TRUE);
            glDrawArrays(GL_POINTS, 0, GLsizei(depth_volume.volume->capacity()));
            glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
            glDepthMask(GL_FALSE);
            glDepthFunc(GL_LEQUAL);
            p.set("point_pass", 1);
            glDrawArrays(GL_POINTS, 0, GLsizei(depth_volume.volume->capacity()));
            // Contradicted foreground geometry can fade over the confirmed
            // replacement behind it without obscuring that replacement's depth.
            p.set("point_pass", 2);
            glDrawArrays(GL_POINTS, 0, GLsizei(depth_volume.volume->capacity()));
            glDepthFunc(GL_LESS);
            glDepthMask(GL_TRUE);
            glDisable(GL_PROGRAM_POINT_SIZE);
            p.set("point_cloud", 0);
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
}
unsigned Renderer::video_texture(size_t camera_index) const {
    if (camera_index >= impl_->cameras.size())
        return 0;
    const auto& camera = impl_->cameras[camera_index];
    return camera.current < 0 ? 0 : camera.textures[camera.current].id;
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
