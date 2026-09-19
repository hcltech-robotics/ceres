#pragma once
#include "ceres/depth_display.hpp"
#include "ceres/spatial_map_display.hpp"
#include <glad/gl.h>
#include <glm/glm.hpp>
#include <glm/gtc/type_ptr.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>

namespace ceres::detail {
// Map positions remain in tracking-world metres. Point size is a framebuffer
// pixel width and is independent of voxel detail, perspective and display DPI.
class SpatialMapProgram {
  public:
    SpatialMapProgram() {
        constexpr const char* vertex = R"GLSL(#version 450 core
layout(location=0) in vec3 position;
layout(location=11) in vec4 source_colour;
layout(location=12) in float point_valid;
layout(location=13) in uvec2 observed_us;
layout(location=14) in uvec2 support_flags;
uniform mat4 vp;
uniform float point_size,opacity;
uniform vec3 headset_origin,depth_palette[8];
uniform int headset_origin_valid;
uniform int map_shader;
uniform uvec2 now_us;
uniform float density,recency_seconds;
uniform vec2 depth_range;
out float confidence;
out vec4 point_colour;
out float eye_depth;
float age_seconds() {
    if(observed_us.y>now_us.y || (observed_us.y==now_us.y && observed_us.x>now_us.x)) return 0;
    uint high=now_us.y-observed_us.y-uint(now_us.x<observed_us.x);
    uint low=now_us.x-observed_us.x;
    return float(high)*4294.967296+float(low)*.000001;
}
float stable_fraction() {
    uvec3 coordinate=floatBitsToUint(position);
    uint value=coordinate.x*73856093u ^ coordinate.y*19349663u ^ coordinate.z*83492791u;
    value^=value>>16; value*=0x7feb352du; value^=value>>15; value*=0x846ca68bu; value^=value>>16;
    return float(value>>8)*(.000000059604644775390625);
}
void main() {
    confidence=clamp(source_colour.a,0,1);
    float alpha=opacity*confidence;
    float fraction=clamp((length(position-headset_origin)-depth_range.x)/
                         max(.0001,depth_range.y-depth_range.x),0,1);
    if(map_shader==1) fraction=clamp(age_seconds()/max(.001,recency_seconds),0,1);
    if(map_shader==2) fraction=1-confidence;
    float palette_position=fraction*7;
    int palette_index=min(int(palette_position),6);
    vec3 colour=mix(depth_palette[palette_index],depth_palette[palette_index+1],
                    palette_position-float(palette_index));
    if(map_shader==3) colour=vec3(.74,.78,.82);
    point_colour=vec4(map_shader!=0 || headset_origin_valid!=0 ? colour : vec3(.72),alpha);
    vec4 clip=vp*vec4(position,1);
    eye_depth=clip.w;
    gl_PointSize=point_size;
    bool visible=point_valid>0 && support_flags.x>0u && density>0 && stable_fraction()<density;
    gl_Position=visible && alpha>.001 && clip.w>0 ? clip : vec4(2,2,2,1);
})GLSL";
        constexpr const char* fragment = R"GLSL(#version 450 core
in float confidence;
in vec4 point_colour;
in float eye_depth;
uniform int point_pass,premultiplied;
layout(location=0) out vec4 colour;
layout(location=1) out float linear_depth;
void main() {
    if(point_colour.a<=.001) discard;
    bool supported=confidence>=.999;
    if((point_pass<2 && !supported) || (point_pass==2 && supported)) discard;
    colour=point_colour;
    if(premultiplied!=0) colour.rgb*=colour.a;
    linear_depth=eye_depth;
})GLSL";
        constexpr const char* screen_vertex = R"GLSL(#version 450 core
void main() {
    vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);
    gl_Position=vec4(p*2-1,0,1);
})GLSL";
        constexpr const char* screen_fragment = R"GLSL(
#ifdef MULTISAMPLED
uniform sampler2DMS map_colour,map_depth;
vec4 colour_at(ivec2 p) { return texelFetch(map_colour,p,gl_SampleID); }
float depth_at(ivec2 p) { return texelFetch(map_depth,p,gl_SampleID).r; }
ivec2 extent() { return textureSize(map_depth); }
#else
uniform sampler2D map_colour,map_depth;
vec4 colour_at(ivec2 p) { return texelFetch(map_colour,p,0); }
float depth_at(ivec2 p) { return texelFetch(map_depth,p,0).r; }
ivec2 extent() { return textureSize(map_depth,0); }
#endif
uniform ivec2 viewport_origin;
uniform float relief_strength;
out vec4 colour;
void main() {
    ivec2 p=ivec2(gl_FragCoord.xy)-viewport_origin;
    vec4 material=colour_at(p);
    if(material.a<=.001) discard;
    float centre=depth_at(p);
    if(centre<=0) discard;
    const ivec2 directions[8]=ivec2[8](ivec2(1,0),ivec2(-1,0),ivec2(0,1),ivec2(0,-1),
        ivec2(1,1),ivec2(-1,1),ivec2(1,-1),ivec2(-1,-1));
    const int radii[3]=int[3](1,3,7);
    float response=0;
    // Empty pixels contribute neither a depth nor a shadow. The fixed kernel
    // adds relief to measured surfaces without filling gaps or enlarging points.
    for(int scale=0;scale<3;++scale) {
        float sum=0;
        int valid=0;
        for(int direction=0;direction<8;++direction) {
            ivec2 neighbour=p+directions[direction]*radii[scale];
            if(any(lessThan(neighbour,ivec2(0))) || any(greaterThanEqual(neighbour,extent()))) continue;
            float depth=depth_at(neighbour);
            if(depth<=0) continue;
            sum+=max(0,log2(centre)-log2(depth));
            ++valid;
        }
        if(valid>0) response+=sum/float(valid);
    }
    float light=max(.22,exp(-40*relief_strength*response/3));
    colour=vec4(material.rgb*light,material.a);
})GLSL";
        GLuint vs = 0, fs = 0;
        try {
            vs = compile(GL_VERTEX_SHADER, vertex);
            fs = compile(GL_FRAGMENT_SHADER, fragment);
            program_ = glCreateProgram();
            glAttachShader(program_, vs);
            glAttachShader(program_, fs);
            glLinkProgram(program_);
            GLint linked = 0;
            glGetProgramiv(program_, GL_LINK_STATUS, &linked);
            if (!linked) {
                std::array<char, 4096> log{};
                glGetProgramInfoLog(program_, GLsizei(log.size()), nullptr, log.data());
                throw std::runtime_error(log.data());
            }
            glDeleteShader(vs);
            glDeleteShader(fs);
            vs = fs = 0;
            screen_program_[0] = link(screen_vertex, std::string("#version 450 core\n") + screen_fragment);
            screen_program_[1] = link(screen_vertex, std::string("#version 450 core\n#define MULTISAMPLED\n") + screen_fragment);
            glGenVertexArrays(1, &screen_vao_);
        } catch (...) {
            glDeleteShader(vs);
            glDeleteShader(fs);
            glDeleteProgram(program_);
            for (const auto program : screen_program_) glDeleteProgram(program);
            throw;
        }
        vp_ = location("vp");
        size_ = location("point_size");
        opacity_ = location("opacity");
        origin_ = location("headset_origin");
        origin_valid_ = location("headset_origin_valid");
        range_ = location("depth_range");
        palette_ = location("depth_palette");
        pass_ = location("point_pass");
        shader_ = location("map_shader");
        now_ = location("now_us");
        density_ = location("density");
        recency_ = location("recency_seconds");
        premultiplied_ = location("premultiplied");
        GLfloat sizes[2]{};
        glGetFloatv(GL_POINT_SIZE_RANGE, sizes);
        maximum_size_ = std::max(1.f, sizes[1]);
    }
    ~SpatialMapProgram() {
        release_target();
        glDeleteProgram(program_);
        for (const auto program : screen_program_) glDeleteProgram(program);
        glDeleteVertexArrays(1, &screen_vao_);
    }
    SpatialMapProgram(const SpatialMapProgram&) = delete;
    SpatialMapProgram& operator=(const SpatialMapProgram&) = delete;

    void draw(GLuint vao, GLsizei count, const glm::mat4& vp, float size_pixels, float opacity,
              const std::optional<glm::vec3>& headset_origin, float near_distance,
              float far_distance, SpatialMapShader shader = SpatialMapShader::distance,
              int64_t now_us = 0, float density = 1.f, float recency_seconds = 30.f,
              SpatialMapStyle style = SpatialMapStyle::points, float relief_strength = 1.f) const {
        if (count <= 0 || !std::isfinite(opacity) || opacity <= 0)
            return;
        State previous;
        glUseProgram(program_);
        glBindVertexArray(vao);
        glUniformMatrix4fv(vp_, 1, GL_FALSE, glm::value_ptr(vp));
        glUniform1f(size_, std::clamp(std::isfinite(size_pixels) ? size_pixels : 1.f,
                                    1.f, maximum_size_));
        glUniform1f(opacity_, std::clamp(opacity, 0.f, 1.f));
        glUniform1i(origin_valid_, headset_origin.has_value() ? 1 : 0);
        const auto origin = headset_origin.value_or(glm::vec3(0));
        glUniform3fv(origin_, 1, glm::value_ptr(origin));
        glUniform2f(range_, near_distance, far_distance);
        glUniform1i(shader_, int(shader));
        const auto time = static_cast<uint64_t>(std::max<int64_t>(0, now_us));
        glUniform2ui(now_, GLuint(time & 0xffffffffu), GLuint(time >> 32));
        glUniform1f(density_, std::clamp(std::isfinite(density) ? density : 1.f, 0.f, 1.f));
        glUniform1f(recency_, std::isfinite(recency_seconds) ? std::max(.001f, recency_seconds) : 30.f);
        glUniform1i(premultiplied_, 0);
        static const auto palette = [] {
            std::array<float, 24> result{};
            for (int i = 0; i < 8; ++i) {
                const auto colour = spectral_depth_colour(float(i) / 7.f);
                result[size_t(i) * 3] = colour.r;
                result[size_t(i) * 3 + 1] = colour.g;
                result[size_t(i) * 3 + 2] = colour.b;
            }
            return result;
        }();
        glUniform3fv(palette_, 8, palette.data());
        glEnable(GL_PROGRAM_POINT_SIZE);
        // Full sample coverage prevents a single point from spilling into
        // neighbouring pixels on a multisampled window framebuffer.
        glDisable(GL_MULTISAMPLE);
        glEnable(GL_DEPTH_TEST);
        glEnable(GL_BLEND);
        glBlendEquation(GL_FUNC_ADD);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        glDepthFunc(GL_LESS);
        glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
        glDepthMask(GL_TRUE);
        glUniform1i(pass_, 0);
        glDrawArrays(GL_POINTS, 0, count);
        if (style == SpatialMapStyle::shape) {
            draw_shape(vao, count, previous, relief_strength);
            return;
        }
        // Every pass uses the same square pixel footprint. Confidence affects
        // compositing, never the area that occludes another surface.
        glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        glDepthMask(GL_FALSE);
        glDepthFunc(GL_LEQUAL);
        glUniform1i(pass_, 1);
        glDrawArrays(GL_POINTS, 0, count);
        glUniform1i(pass_, 2);
        glDrawArrays(GL_POINTS, 0, count);
    }

  private:
    struct State {
        GLint program = 0, vao = 0, depth_func = 0;
        GLint source_rgb = 0, destination_rgb = 0, source_alpha = 0, destination_alpha = 0;
        GLint equation_rgb = 0, equation_alpha = 0;
        GLint draw_framebuffer = 0, read_framebuffer = 0, viewport[4]{}, scissor_box[4]{};
        GLint active_texture = 0, texture_2d[2]{}, texture_ms[2]{}, sampler[2]{};
        GLint renderbuffer = 0;
        GLint second_source_rgb = 0, second_destination_rgb = 0, second_source_alpha = 0, second_destination_alpha = 0;
        GLint second_equation_rgb = 0, second_equation_alpha = 0;
        GLboolean second_blend = GL_FALSE, second_colour_write[4]{};
        GLboolean scissor, cull;
        GLboolean multisample, point_size, depth_test, blend, depth_write, colour_write[4]{};
        State()
            : scissor(glIsEnabled(GL_SCISSOR_TEST)), cull(glIsEnabled(GL_CULL_FACE)),
              multisample(glIsEnabled(GL_MULTISAMPLE)), point_size(glIsEnabled(GL_PROGRAM_POINT_SIZE)),
              depth_test(glIsEnabled(GL_DEPTH_TEST)), blend(glIsEnabled(GL_BLEND)) {
            glGetIntegerv(GL_CURRENT_PROGRAM, &program);
            glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao);
            glGetIntegerv(GL_DEPTH_FUNC, &depth_func);
            glGetBooleanv(GL_DEPTH_WRITEMASK, &depth_write);
            glGetBooleanv(GL_COLOR_WRITEMASK, colour_write);
            glGetIntegerv(GL_BLEND_SRC_RGB, &source_rgb);
            glGetIntegerv(GL_BLEND_DST_RGB, &destination_rgb);
            glGetIntegerv(GL_BLEND_SRC_ALPHA, &source_alpha);
            glGetIntegerv(GL_BLEND_DST_ALPHA, &destination_alpha);
            glGetIntegerv(GL_BLEND_EQUATION_RGB, &equation_rgb);
            glGetIntegerv(GL_BLEND_EQUATION_ALPHA, &equation_alpha);
            glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw_framebuffer);
            glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read_framebuffer);
            glGetIntegerv(GL_VIEWPORT, viewport);
            glGetIntegerv(GL_SCISSOR_BOX, scissor_box);
            glGetIntegerv(GL_RENDERBUFFER_BINDING, &renderbuffer);
            glGetIntegerv(GL_ACTIVE_TEXTURE, &active_texture);
            for (GLuint unit = 0; unit < 2; ++unit) {
                glActiveTexture(GL_TEXTURE0 + unit);
                glGetIntegerv(GL_TEXTURE_BINDING_2D, &texture_2d[unit]);
                glGetIntegerv(GL_TEXTURE_BINDING_2D_MULTISAMPLE, &texture_ms[unit]);
                glGetIntegeri_v(GL_SAMPLER_BINDING, unit, &sampler[unit]);
            }
            glActiveTexture(GLenum(active_texture));
            second_blend = glIsEnabledi(GL_BLEND, 1);
            glGetIntegeri_v(GL_BLEND_SRC_RGB, 1, &second_source_rgb);
            glGetIntegeri_v(GL_BLEND_DST_RGB, 1, &second_destination_rgb);
            glGetIntegeri_v(GL_BLEND_SRC_ALPHA, 1, &second_source_alpha);
            glGetIntegeri_v(GL_BLEND_DST_ALPHA, 1, &second_destination_alpha);
            glGetIntegeri_v(GL_BLEND_EQUATION_RGB, 1, &second_equation_rgb);
            glGetIntegeri_v(GL_BLEND_EQUATION_ALPHA, 1, &second_equation_alpha);
            glGetBooleani_v(GL_COLOR_WRITEMASK, 1, second_colour_write);
        }
        ~State() {
            glUseProgram(GLuint(program));
            glBindVertexArray(GLuint(vao));
            restore(GL_MULTISAMPLE, multisample);
            restore(GL_PROGRAM_POINT_SIZE, point_size);
            restore(GL_DEPTH_TEST, depth_test);
            restore(GL_BLEND, blend);
            glDepthFunc(GLenum(depth_func));
            glDepthMask(depth_write);
            glColorMask(colour_write[0], colour_write[1], colour_write[2], colour_write[3]);
            glBlendFuncSeparate(GLenum(source_rgb), GLenum(destination_rgb),
                                GLenum(source_alpha), GLenum(destination_alpha));
            glBlendEquationSeparate(GLenum(equation_rgb), GLenum(equation_alpha));
            if (second_blend) glEnablei(GL_BLEND, 1);
            else glDisablei(GL_BLEND, 1);
            glBlendFuncSeparatei(1, GLenum(second_source_rgb), GLenum(second_destination_rgb),
                                 GLenum(second_source_alpha), GLenum(second_destination_alpha));
            glBlendEquationSeparatei(1, GLenum(second_equation_rgb), GLenum(second_equation_alpha));
            glColorMaski(1, second_colour_write[0], second_colour_write[1],
                         second_colour_write[2], second_colour_write[3]);
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(draw_framebuffer));
            glBindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(read_framebuffer));
            glViewport(viewport[0], viewport[1], viewport[2], viewport[3]);
            glScissor(scissor_box[0], scissor_box[1], scissor_box[2], scissor_box[3]);
            restore(GL_SCISSOR_TEST, scissor);
            restore(GL_CULL_FACE, cull);
            glBindRenderbuffer(GL_RENDERBUFFER, GLuint(renderbuffer));
            for (GLuint unit = 0; unit < 2; ++unit) {
                glActiveTexture(GL_TEXTURE0 + unit);
                glBindTexture(GL_TEXTURE_2D, GLuint(texture_2d[unit]));
                glBindTexture(GL_TEXTURE_2D_MULTISAMPLE, GLuint(texture_ms[unit]));
                glBindSampler(unit, GLuint(sampler[unit]));
            }
            glActiveTexture(GLenum(active_texture));
        }
        static void restore(GLenum capability, GLboolean enabled) {
            if (enabled) glEnable(capability);
            else glDisable(capability);
        }
    };
    void draw_shape(GLuint vao, GLsizei count, const State& previous, float relief) const {
        const int width = previous.viewport[2], height = previous.viewport[3];
        if (width <= 0 || height <= 0) return;
        GLint samples = 0, depth_bits = 0, stencil_bits = 0, component_type = 0;
        glGetIntegerv(GL_SAMPLES, &samples);
        const GLenum depth_attachment = previous.draw_framebuffer ? GL_DEPTH_ATTACHMENT : GL_DEPTH;
        glGetFramebufferAttachmentParameteriv(GL_DRAW_FRAMEBUFFER, depth_attachment,
                                              GL_FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE, &depth_bits);
        glGetFramebufferAttachmentParameteriv(GL_DRAW_FRAMEBUFFER, depth_attachment,
                                              GL_FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE, &stencil_bits);
        glGetFramebufferAttachmentParameteriv(GL_DRAW_FRAMEBUFFER, depth_attachment,
                                              GL_FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE, &component_type);
        GLenum depth_format = GL_DEPTH_COMPONENT24;
        if (depth_bits == 16) depth_format = GL_DEPTH_COMPONENT16;
        else if (depth_bits == 32)
            depth_format = component_type == GL_FLOAT ? GL_DEPTH_COMPONENT32F : GL_DEPTH_COMPONENT32;
        if (stencil_bits > 0)
            depth_format = depth_bits == 32 ? GL_DEPTH32F_STENCIL8 : GL_DEPTH24_STENCIL8;
        ensure_target(width, height, samples, depth_format);
        glDisable(GL_SCISSOR_TEST);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(previous.draw_framebuffer));
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, target_);
        // Equal-sized, equal-format depth copies work for ordinary and MSAA
        // targets. The supported map surface remains in the scene depth buffer
        // so later hand trails obey the same occlusion as the Points style.
        glBlitFramebuffer(previous.viewport[0], previous.viewport[1],
                          previous.viewport[0] + width, previous.viewport[1] + height,
                          0, 0, width, height, GL_DEPTH_BUFFER_BIT, GL_NEAREST);
        glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        constexpr GLfloat empty[4]{};
        glClearBufferfv(GL_COLOR, 0, empty);
        glClearBufferfv(GL_COLOR, 1, empty);
        glViewport(0, 0, width, height);
        if (previous.scissor) {
            glEnable(GL_SCISSOR_TEST);
            glScissor(previous.scissor_box[0] - previous.viewport[0],
                      previous.scissor_box[1] - previous.viewport[1],
                      previous.scissor_box[2], previous.scissor_box[3]);
        }
        glBindVertexArray(vao);
        glUseProgram(program_);
        glDepthMask(GL_FALSE);
        glDepthFunc(GL_LEQUAL);
        glEnablei(GL_BLEND, 0);
        glBlendEquationi(0, GL_FUNC_ADD);
        glBlendFuncSeparatei(0, GL_ONE, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
        glDisablei(GL_BLEND, 1);
        glUniform1i(premultiplied_, 1);
        glUniform1i(pass_, 1);
        glDrawArrays(GL_POINTS, 0, count);
        glUniform1i(pass_, 2);
        glDrawArrays(GL_POINTS, 0, count);

        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(previous.draw_framebuffer));
        glViewport(previous.viewport[0], previous.viewport[1], width, height);
        glScissor(previous.scissor_box[0], previous.scissor_box[1],
                  previous.scissor_box[2], previous.scissor_box[3]);
        State::restore(GL_SCISSOR_TEST, previous.scissor);
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_CULL_FACE);
        const auto program = screen_program_[samples > 0 ? 1 : 0];
        // Per-sample fetches retain the scene's original edge coverage. A
        // resolved depth average would move silhouettes and produce halos.
        if (samples > 0) glEnable(GL_MULTISAMPLE);
        glUseProgram(program);
        glBindVertexArray(screen_vao_);
        const GLenum texture_target = samples > 0 ? GL_TEXTURE_2D_MULTISAMPLE : GL_TEXTURE_2D;
        for (GLuint unit = 0; unit < 2; ++unit) {
            glActiveTexture(GL_TEXTURE0 + unit);
            glBindTexture(texture_target, textures_[unit]);
            glBindSampler(unit, 0);
        }
        glUniform1i(glGetUniformLocation(program, "map_colour"), 0);
        glUniform1i(glGetUniformLocation(program, "map_depth"), 1);
        glUniform2i(glGetUniformLocation(program, "viewport_origin"), previous.viewport[0], previous.viewport[1]);
        glUniform1f(glGetUniformLocation(program, "relief_strength"),
                    std::clamp(std::isfinite(relief) ? relief : 1.f, 0.f, 4.f));
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }
    void ensure_target(int width, int height, int samples, GLenum depth_format) const {
        if (target_ && width_ == width && height_ == height && samples_ == samples && depth_format_ == depth_format)
            return;
        release_target();
        glGenFramebuffers(1, &target_);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, target_);
        glGenTextures(2, textures_.data());
        const GLenum texture_target = samples > 0 ? GL_TEXTURE_2D_MULTISAMPLE : GL_TEXTURE_2D;
        const GLenum formats[2] = {GL_RGBA16F, GL_R32F};
        glActiveTexture(GL_TEXTURE0);
        for (GLuint attachment = 0; attachment < 2; ++attachment) {
            glBindTexture(texture_target, textures_[attachment]);
            if (samples > 0)
                glTexStorage2DMultisample(texture_target, samples, formats[attachment], width, height, GL_TRUE);
            else {
                glTexStorage2D(texture_target, 1, formats[attachment], width, height);
                glTexParameteri(texture_target, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
                glTexParameteri(texture_target, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            }
            glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0 + attachment,
                                   texture_target, textures_[attachment], 0);
        }
        glGenRenderbuffers(1, &depth_);
        glBindRenderbuffer(GL_RENDERBUFFER, depth_);
        if (samples > 0) glRenderbufferStorageMultisample(GL_RENDERBUFFER, samples, depth_format, width, height);
        else glRenderbufferStorage(GL_RENDERBUFFER, depth_format, width, height);
        glFramebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth_);
        constexpr GLenum attachments[2] = {GL_COLOR_ATTACHMENT0, GL_COLOR_ATTACHMENT1};
        glDrawBuffers(2, attachments);
        if (glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            release_target();
            throw std::runtime_error("Cannot allocate spatial map shape target");
        }
        width_ = width;
        height_ = height;
        samples_ = samples;
        depth_format_ = depth_format;
    }
    void release_target() const {
        glDeleteFramebuffers(1, &target_);
        glDeleteTextures(2, textures_.data());
        glDeleteRenderbuffers(1, &depth_);
        target_ = depth_ = 0;
        textures_ = {};
        width_ = height_ = samples_ = 0;
    }
    static GLuint link(const char* vertex, const std::string& fragment) {
        GLuint vs = 0, fs = 0, program = 0;
        try {
            vs = compile(GL_VERTEX_SHADER, vertex);
            fs = compile(GL_FRAGMENT_SHADER, fragment.c_str());
            program = glCreateProgram();
            glAttachShader(program, vs);
            glAttachShader(program, fs);
            glLinkProgram(program);
            GLint linked = 0;
            glGetProgramiv(program, GL_LINK_STATUS, &linked);
            if (!linked) {
                std::array<char, 4096> log{};
                glGetProgramInfoLog(program, GLsizei(log.size()), nullptr, log.data());
                throw std::runtime_error(log.data());
            }
            glDeleteShader(vs);
            glDeleteShader(fs);
            return program;
        } catch (...) {
            glDeleteShader(vs);
            glDeleteShader(fs);
            glDeleteProgram(program);
            throw;
        }
    }
    static GLuint compile(GLenum type, const char* source) {
        const auto shader = glCreateShader(type);
        glShaderSource(shader, 1, &source, nullptr);
        glCompileShader(shader);
        GLint compiled = 0;
        glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
        if (!compiled) {
            std::array<char, 4096> log{};
            glGetShaderInfoLog(shader, GLsizei(log.size()), nullptr, log.data());
            glDeleteShader(shader);
            throw std::runtime_error(log.data());
        }
        return shader;
    }
    GLint location(const char* name) const { return glGetUniformLocation(program_, name); }
    GLuint program_ = 0;
    std::array<GLuint, 2> screen_program_{};
    GLuint screen_vao_ = 0;
    mutable GLuint target_ = 0, depth_ = 0;
    mutable std::array<GLuint, 2> textures_{};
    mutable int width_ = 0, height_ = 0, samples_ = 0;
    mutable GLenum depth_format_ = 0;
    GLint vp_, size_, opacity_, origin_, origin_valid_, range_, palette_, pass_, shader_, now_, density_, recency_, premultiplied_;
    float maximum_size_ = 1;
};
} // namespace ceres::detail
