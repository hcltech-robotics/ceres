#include "ceres/graphics_device.hpp"
#include "ceres/detail/spatial_map_render.hpp"
#include "ceres/spatial_map_point.hpp"
#include <GLFW/glfw3.h>
#include <glm/gtc/matrix_transform.hpp>
#include <array>
#include <cstddef>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
using Pixel = std::array<unsigned char, 4>;
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
struct Context {
    GLFWwindow* window = nullptr;
    Context() {
        ceres::prefer_nvidia_graphics();
        require(glfwInit() != 0, "Cannot initialise GLFW");
        glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
        glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 4);
        glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 5);
        glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
        window = glfwCreateWindow(128, 128, "Spatial map pixel checks", nullptr, nullptr);
        require(window != nullptr, "Cannot create OpenGL 4.5 context");
        glfwMakeContextCurrent(window);
        require(gladLoadGL(glfwGetProcAddress) != 0, "Cannot load OpenGL");
    }
    ~Context() {
        glfwDestroyWindow(window);
        glfwTerminate();
    }
};
struct Target {
    GLuint framebuffer = 0, colour = 0, depth = 0;
    GLuint resolved = 0, resolved_colour = 0;
    int width;
    Target(int extent, int samples) : width(extent) {
        glGenFramebuffers(1, &framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glGenRenderbuffers(1, &colour);
        glBindRenderbuffer(GL_RENDERBUFFER, colour);
        glRenderbufferStorageMultisample(GL_RENDERBUFFER, samples, GL_RGBA8, width, width);
        glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, colour);
        glGenRenderbuffers(1, &depth);
        glBindRenderbuffer(GL_RENDERBUFFER, depth);
        glRenderbufferStorageMultisample(GL_RENDERBUFFER, samples, GL_DEPTH_COMPONENT32F, width, width);
        glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);
        require(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE,
                "Incomplete render target");
        glGenFramebuffers(1, &resolved);
        glBindFramebuffer(GL_FRAMEBUFFER, resolved);
        glGenRenderbuffers(1, &resolved_colour);
        glBindRenderbuffer(GL_RENDERBUFFER, resolved_colour);
        glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, width, width);
        glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, resolved_colour);
        require(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE,
                "Incomplete resolve target");
    }
    ~Target() {
        glDeleteRenderbuffers(1, &colour);
        glDeleteRenderbuffers(1, &depth);
        glDeleteRenderbuffers(1, &resolved_colour);
        glDeleteFramebuffers(1, &framebuffer);
        glDeleteFramebuffers(1, &resolved);
    }
    void clear() {
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glViewport(0, 0, width, width);
        glDisable(GL_SCISSOR_TEST);
        glDisable(GL_FRAMEBUFFER_SRGB);
        glDisable(GL_DITHER);
        glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        glDepthMask(GL_TRUE);
        glClearColor(0, 0, 0, 0);
        glClearDepth(1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        glEnable(GL_MULTISAMPLE);
    }
    std::vector<Pixel> read() {
        const bool scissor = glIsEnabled(GL_SCISSOR_TEST) != 0;
        glDisable(GL_SCISSOR_TEST);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, resolved);
        glBlitFramebuffer(0, 0, width, width, 0, 0, width, width, GL_COLOR_BUFFER_BIT, GL_NEAREST);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, resolved);
        glReadBuffer(GL_COLOR_ATTACHMENT0);
        std::vector<Pixel> pixels(size_t(width) * width);
        glReadPixels(0, 0, width, width, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        if (scissor) glEnable(GL_SCISSOR_TEST);
        return pixels;
    }
};
struct Points {
    GLuint vao = 0, buffer = 0;
    GLsizei count = 0;
    Points() {
        glGenVertexArrays(1, &vao);
        glGenBuffers(1, &buffer);
        glBindVertexArray(vao);
        glBindBuffer(GL_ARRAY_BUFFER, buffer);
        for (const auto location : {0u, 11u, 12u, 13u, 14u, 15u})
            glEnableVertexAttribArray(location);
        glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(ceres::SpatialMapPoint), nullptr);
        glVertexAttribPointer(11, 4, GL_FLOAT, GL_FALSE, sizeof(ceres::SpatialMapPoint),
                              reinterpret_cast<void*>(offsetof(ceres::SpatialMapPoint, r)));
        glVertexAttribPointer(12, 1, GL_FLOAT, GL_FALSE, sizeof(ceres::SpatialMapPoint),
                              reinterpret_cast<void*>(offsetof(ceres::SpatialMapPoint, cell_size)));
        glVertexAttribIPointer(13, 2, GL_UNSIGNED_INT, sizeof(ceres::SpatialMapPoint),
                               reinterpret_cast<void*>(offsetof(ceres::SpatialMapPoint, observed_us)));
        glVertexAttribIPointer(14, 2, GL_UNSIGNED_INT, sizeof(ceres::SpatialMapPoint),
                               reinterpret_cast<void*>(offsetof(ceres::SpatialMapPoint, weight)));
    }
    ~Points() {
        glDeleteBuffers(1, &buffer);
        glDeleteVertexArrays(1, &vao);
    }
    void upload(const std::vector<ceres::SpatialMapPoint>& points,
                const std::vector<float>& births = {}) {
        count = GLsizei(points.size());
        require(births.empty() || births.size() == points.size(), "Invalid birth fixture size");
        const auto times = births.empty() ? std::vector<float>(points.size(), -1.f) : births;
        const auto point_bytes = GLsizeiptr(points.size() * sizeof(points[0]));
        const auto birth_bytes = GLsizeiptr(times.size() * sizeof(float));
        glBindVertexArray(vao);
        glBindBuffer(GL_ARRAY_BUFFER, buffer);
        glBufferData(GL_ARRAY_BUFFER, point_bytes + birth_bytes, nullptr, GL_STATIC_DRAW);
        glBufferSubData(GL_ARRAY_BUFFER, 0, point_bytes, points.data());
        glBufferSubData(GL_ARRAY_BUFFER, point_bytes, birth_bytes, times.data());
        glVertexAttribPointer(15, 1, GL_FLOAT, GL_FALSE, sizeof(float), reinterpret_cast<void*>(point_bytes));
    }
    std::vector<ceres::SpatialMapPoint> read() const {
        std::vector<ceres::SpatialMapPoint> points(static_cast<size_t>(count));
        glBindBuffer(GL_ARRAY_BUFFER, buffer);
        glGetBufferSubData(GL_ARRAY_BUFFER, 0, GLsizeiptr(points.size() * sizeof(points[0])), points.data());
        return points;
    }
};
struct Occluder {
    GLuint program = 0, vao = 0;
    Occluder() {
        const char* vertex_source = R"GLSL(#version 450 core
void main() {
    const vec2 positions[3]=vec2[3](vec2(-.8,-.8),vec2(.813,-.8),vec2(-.8,.813));
    gl_Position=vec4(positions[gl_VertexID],0,1);
})GLSL";
        const char* fragment_source = R"GLSL(#version 450 core
out vec4 colour;
void main() { colour=vec4(.1,.4,.2,1); }
)GLSL";
        const GLuint vertex = glCreateShader(GL_VERTEX_SHADER);
        const GLuint fragment = glCreateShader(GL_FRAGMENT_SHADER);
        glShaderSource(vertex, 1, &vertex_source, nullptr);
        glShaderSource(fragment, 1, &fragment_source, nullptr);
        glCompileShader(vertex);
        glCompileShader(fragment);
        program = glCreateProgram();
        glAttachShader(program, vertex);
        glAttachShader(program, fragment);
        glLinkProgram(program);
        glDeleteShader(vertex);
        glDeleteShader(fragment);
        GLint linked = 0;
        glGetProgramiv(program, GL_LINK_STATUS, &linked);
        require(linked != 0, "Cannot link scene occlusion fixture");
        glGenVertexArrays(1, &vao);
    }
    ~Occluder() {
        glDeleteProgram(program);
        glDeleteVertexArrays(1, &vao);
    }
    void draw() const {
        glUseProgram(program);
        glBindVertexArray(vao);
        glEnable(GL_MULTISAMPLE);
        glEnable(GL_DEPTH_TEST);
        glDisable(GL_CULL_FACE);
        glDisable(GL_BLEND);
        glDepthFunc(GL_LESS);
        glDepthMask(GL_TRUE);
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }
};
ceres::SpatialMapPoint point(float z = -2, float confidence = 1) {
    ceres::SpatialMapPoint p;
    p.z = z;
    p.cell_size = .03f;
    p.confidence = confidence;
    p.observed_us = 1000000;
    p.weight = 8;
    return p;
}
std::vector<ceres::SpatialMapPoint> pixel_plane(int extent, int first, int last,
                                             const glm::mat4& projection, bool step = false) {
    std::vector<ceres::SpatialMapPoint> result;
    for (int y = first; y < last; ++y)
        for (int x = first; x < last; ++x) {
            const float depth = step && x >= (first + last) / 2 ? 3.f : 2.f;
            auto sample = point(-depth);
            sample.x = (2.f * (float(x) + .5f) / extent - 1.f) * depth / projection[0][0];
            sample.y = (2.f * (float(y) + .5f) / extent - 1.f) * depth / projection[1][1];
            result.push_back(sample);
        }
    return result;
}
bool close_colour(Pixel a, Pixel b, int tolerance = 1) {
    for (size_t channel = 0; channel < a.size(); ++channel)
        if (std::abs(int(a[channel]) - int(b[channel])) > tolerance) return false;
    return true;
}
size_t coverage(const std::vector<Pixel>& pixels) {
    return size_t(std::count_if(pixels.begin(), pixels.end(), [](const Pixel& p) {
        return p[0] || p[1] || p[2];
    }));
}
Pixel colour(const std::vector<Pixel>& pixels) {
    for (const auto& p : pixels)
        if (p[0] || p[1] || p[2])
            return p;
    throw std::runtime_error("No visible point");
}
void write_image(const std::filesystem::path& path, const std::vector<Pixel>& pixels, int width) {
    std::ofstream out(path, std::ios::binary);
    out << "P6\n" << width << ' ' << width << "\n255\n";
    for (int y = width - 1; y >= 0; --y)
        for (int x = 0; x < width; ++x)
            out.write(reinterpret_cast<const char*>(pixels[size_t(y) * width + x].data()), 3);
    require(bool(out), "Cannot write pixel proof");
}
} // namespace

int main(int argc, char** argv) {
    try {
        Context context;
        ceres::detail::SpatialMapProgram shader;
        Points points;
        Occluder occluder;
        const auto projection = glm::perspective(glm::radians(48.f), 1.f, .01f, 100.f);
        size_t footprint_cases = 0;
        for (const int samples : {1, 4}) {
            for (const int extent : {64, 128, 256}) {
                Target target(extent, samples);
                for (const int size : {1, 2, 4}) {
                    for (const float distance : {.025f, 2.f, 50.f}) {
                        for (const float cell_size : {.01f, 1.28f}) {
                            auto p = point(-distance);
                            p.cell_size = cell_size;
                            points.upload({p});
                            target.clear();
                            shader.draw(points.vao, points.count, projection, float(size), 1,
                                        glm::vec3(0), 0, 10);
                            const auto image = target.read();
                            require(coverage(image) == size_t(size * size), "Point footprint is not physical pixel width squared");
                            const auto solid = colour(image);
                            for (const auto& pixel : image)
                                require(pixel == Pixel{} || pixel == solid, "Point contains partial sample coverage");
                            require(glIsEnabled(GL_MULTISAMPLE), "Map draw did not restore MSAA");
                            ++footprint_cases;
                        }
                    }
                }
            }
        }
        Target target(128, 4);
        auto p = point(-2);
        p.observed_us = int64_t(0xffffffffu) - 500000;
        points.upload({p});
        const auto original = points.read();
        auto render = [&](const glm::mat4& vp, glm::vec3 head, ceres::SpatialMapShader mode,
                          int64_t now = 0, float density = 1.f) {
            target.clear();
            shader.draw(points.vao, points.count, vp, 1, 1, head, 0, 10, mode, now, density, 2.f);
            return target.read();
        };
        const auto near_head = render(projection, glm::vec3(0, 0, -1.9f), ceres::SpatialMapShader::distance);
        const auto far_head = render(projection, glm::vec3(0, 0, 8), ceres::SpatialMapShader::distance);
        require(colour(near_head) != colour(far_head), "Frozen world point did not recolour with current headset");
        const auto orbit = render(projection * glm::lookAt(glm::vec3(.5f, 0, 0), glm::vec3(0, 0, -2),
                                                            glm::vec3(0, 1, 0)),
                                  glm::vec3(0, 0, 8), ceres::SpatialMapShader::distance);
        require(colour(orbit) == colour(far_head), "Orbit camera changed distance colour");
        const auto recent = render(projection, {}, ceres::SpatialMapShader::recency, p.observed_us);
        const auto old = render(projection, {}, ceres::SpatialMapShader::recency, p.observed_us + 2000000);
        require(colour(recent) != colour(old), "Frozen observation did not age in recency shader");
        const auto middle = colour(render(projection, {}, ceres::SpatialMapShader::recency,
                                           p.observed_us + 1000000));
        const auto expected_middle = ceres::spectral_depth_colour(.5f);
        require(std::abs(int(middle[0]) - int(std::lround(expected_middle.r * 255))) <= 1 &&
                std::abs(int(middle[1]) - int(std::lround(expected_middle.g * 255))) <= 1 &&
                std::abs(int(middle[2]) - int(std::lround(expected_middle.b * 255))) <= 1,
                "Timestamp low-word borrow changed the observation age");
        const auto future = render(projection, {}, ceres::SpatialMapShader::recency, p.observed_us - 1);
        require(colour(future) == colour(recent), "Future observation age did not clamp to zero");
        require(coverage(render(projection, {}, ceres::SpatialMapShader::confidence, 0, 0)) == 0,
                "Zero density displayed geometry");
        const auto unchanged = points.read();
        require(std::memcmp(original.data(), unchanged.data(), sizeof(p)) == 0,
                "Presentation altered stored map vertices");

        const auto render_gradient = [&](ceres::DepthGradient gradient, ceres::SpatialMapStyle style,
                                         const glm::mat4& transform = glm::mat4(1.f),
                                         bool placed = true, float opacity = 1.f) {
            target.clear();
            shader.draw(points.vao, points.count, projection, 1, opacity, glm::vec3(0), 0, 10,
                        ceres::SpatialMapShader::distance, 0, 1, 30, style, 1, transform, placed,
                        0, 0, gradient);
            return target.read();
        };
        const auto default_gradient = render(projection, {}, ceres::SpatialMapShader::distance);
        require(render_gradient(ceres::DepthGradient::spectral, ceres::SpatialMapStyle::points) ==
                    default_gradient,
                "Explicit spectrum changed the default rendered colours");
        size_t gradient_cases = 0;
        for (const auto style : {ceres::SpatialMapStyle::points, ceres::SpatialMapStyle::shape}) {
            for (int palette = 0; palette < 5; ++palette) {
                const auto gradient = static_cast<ceres::DepthGradient>(palette);
                for (int layer = 0; layer < 3; ++layer) {
                    const auto transform = layer ? glm::translate(glm::mat4(1.f), glm::vec3(.15f, 0, 0))
                                                 : glm::mat4(1.f);
                    const bool placed = layer != 2;
                    const float opacity = placed ? 1.f : .12f;
                    const auto image = render_gradient(gradient, style, transform, placed, opacity);
                    const auto reference = render_gradient(ceres::DepthGradient::spectral, style,
                                                           transform, placed, opacity);
                    require(coverage(image) == 1, "Depth gradient changed the point footprint");
                    const float fraction = glm::length(glm::vec3(transform * glm::vec4(0, 0, -2, 1))) / 10.f;
                    const auto expected = ceres::depth_gradient_colour(gradient, fraction);
                    const auto pixel = colour(image);
                    const float channels[] = {expected.r, expected.g, expected.b};
                    for (size_t channel = 0; channel < 3; ++channel)
                        require(std::abs(int(pixel[channel]) -
                                         int(std::lround(channels[channel] * opacity * 255))) <= 1,
                                "Rendered depth gradient differs from the shared palette");
                    if (palette)
                        require(pixel != colour(reference),
                                "Selected gradient did not change live or saved map colours");
                    ++gradient_cases;
                }
            }
        }
        require(std::memcmp(original.data(), points.read().data(), sizeof(p)) == 0,
                "Gradient selection altered stored map vertices");

        // New evidence fades over one source update interval. The source birth
        // stays fixed when observations refresh its timestamp or support.
        auto arriving = point(-2);
        points.upload({arriving}, {10.f});
        const auto fade = [&](float age, float interval) {
            target.clear();
            shader.draw(points.vao, points.count, projection, 1, 1, {}, 0, 10,
                        ceres::SpatialMapShader::neutral, 0, 1, 30,
                        ceres::SpatialMapStyle::points, 1, glm::mat4(1.f), true, 10.f + age, interval);
            return target.read();
        };
        require(coverage(fade(0, .5f)) == 0, "New evidence appeared before its fade began");
        const auto fade_middle = colour(fade(.25f, .5f));
        const auto fade_complete = colour(fade(.5f, .5f));
        for (size_t channel = 0; channel < 3; ++channel)
            require(std::abs(int(fade_middle[channel]) * 2 - int(fade_complete[channel])) <= 2,
                    "Evidence did not fade linearly over one update interval");
        require(colour(fade(.05f, .1f)) == fade_middle && colour(fade(.1f, .1f)) == fade_complete,
                "Fade duration did not follow the inverse update frequency");
        arriving.observed_us += 500000;
        ++arriving.weight;
        points.upload({arriving}, {10.f});
        require(colour(fade(.75f, .5f)) == fade_complete,
                "A later supporting sweep restarted an established point's fade");
        require(colour(fade(20.f, .5f)) == fade_complete,
                "Stopped acquisition made completed evidence fade again");
        points.upload({arriving});
        require(colour(fade(0, .5f)) == fade_complete,
                "A deliberately imported map acquired a new-data fade");
        points.upload({point(-2), point(-1)}, {-1.f, 10.f});
        const auto fading_foreground = colour(fade(.25f, .5f));
        for (size_t channel = 0; channel < 3; ++channel)
            require(std::abs(int(fading_foreground[channel]) - int(fade_complete[channel])) <= 1,
                    "A partially faded point occluded established geometry before becoming opaque");

        // A weak rear point must not leak through the supported surface, even
        // when it is submitted first. The depth and colour footprints coincide.
        auto rear = point(-3, .5f);
        auto front = point(-1, 1);
        points.upload({front});
        const auto foreground = render(projection, {}, ceres::SpatialMapShader::distance);
        points.upload({rear, front});
        const auto occluded = render(projection, {}, ceres::SpatialMapShader::distance);
        require(occluded == foreground, "Weak rear point leaked through supported foreground");
        points.upload({rear});
        const auto weak = render(projection, {}, ceres::SpatialMapShader::confidence);
        require(coverage(weak) == 1, "Confidence altered point footprint");
        rear.weight = 0;
        points.upload({rear});
        require(coverage(render(projection, {}, ceres::SpatialMapShader::distance)) == 0,
                "Unused map slot produced a fragment");

        // Density selects an invariant subset from measured world positions,
        // retaining repeated reliable observations ahead of tentative samples.
        std::vector<ceres::SpatialMapPoint> grid;
        for (int y = -4; y <= 4; ++y)
            for (int x = -4; x <= 4; ++x) {
                auto sample = point(-2);
                sample.x = (float(x * 4) + .5f) * .03f;
                sample.y = (float(y * 4) + .5f) * .03f;
                grid.push_back(sample);
            }
        points.upload(grid);
        const auto full = render(projection, {}, ceres::SpatialMapShader::distance);
        const auto half = render(projection, {}, ceres::SpatialMapShader::distance, 0, .5f);
        const auto repeated = render(projection, {}, ceres::SpatialMapShader::distance, 0, .5f);
        require(coverage(full) == grid.size() && coverage(half) > 0 && coverage(half) < grid.size(),
                "Density did not reduce the displayed subset");
        require(half == repeated, "Density subset flickered without a geometry change");
        const auto established_count = coverage(half);
        const auto stable_cells = render(projection, {}, ceres::SpatialMapShader::neutral, 0, .5f);
        for (auto& sample : grid) {
            sample.x += .001f;
            sample.y += .001f;
        }
        points.upload(grid);
        const auto compensated = projection * glm::translate(glm::mat4(1.f), glm::vec3(-.001f, -.001f, 0));
        require(render(compensated, {}, ceres::SpatialMapShader::neutral, 0, .5f) == stable_cells,
                "Subvoxel position refinement changed density selection within unchanged evidence cells");
        for (auto& sample : grid) {
            sample.confidence = .2f;
            sample.weight = 1;
        }
        points.upload(grid);
        const auto tentative_full = render(projection, {}, ceres::SpatialMapShader::neutral);
        const auto tentative_half = render(projection, {}, ceres::SpatialMapShader::neutral, 0, .5f);
        require(coverage(tentative_full) == grid.size(), "Full density discarded tentative measured geometry");
        require(established_count > coverage(tentative_half) * 3,
                "Density did not prioritise repeatedly supported reliable geometry");
        for (auto& sample : grid)
            sample.confidence = 1.f;
        points.upload(grid);
        const auto one_observation = render(projection, {}, ceres::SpatialMapShader::neutral, 0, .5f);
        require(established_count > coverage(one_observation),
                "A single confident observation received the same priority as repeated evidence");
        const auto tentative_original = points.read();
        for (const auto density : {.1f, .25f, .75f, 1.f})
            (void)render(projection, {}, ceres::SpatialMapShader::confidence, 0, density);
        const auto tentative_unchanged = points.read();
        require(std::memcmp(tentative_original.data(), tentative_unchanged.data(),
                            tentative_original.size() * sizeof(ceres::SpatialMapPoint)) == 0,
                "Confidence density changed stored geometry or supporting evidence");

        // Relief uses measured depth differences, not distance palette changes.
        // A constant-depth plane, its gaps and its boundary remain unshaded.
        std::vector<Pixel> shape_flat, shape_step, plain_step;
        size_t shape_cases = 0;
        for (const int samples : {0, 4}) {
            Target shape_target(128, samples);
            auto draw_shape = [&](float opacity = 1.f, float relief = 1.f) {
                shader.draw(points.vao, points.count, projection, 1, opacity, {}, 0, 10,
                            ceres::SpatialMapShader::neutral, 0, 1, 30,
                            ceres::SpatialMapStyle::shape, relief);
            };
            points.upload(pixel_plane(128, 32, 96, projection));
            shape_target.clear();
            draw_shape();
            shape_flat = shape_target.read();
            require(coverage(shape_flat) == 64 * 64, "Shape style filled an unmeasured pixel");
            const auto flat_colour = shape_flat[64 * 128 + 64];
            require(close_colour(flat_colour, Pixel{189, 199, 209, 255}),
                    "Flat neutral surface acquired artificial shading");
            for (const auto& pixel : shape_flat)
                require(pixel == Pixel{} || pixel == flat_colour,
                        "Empty neighbours cast a shadow on the flat plane");

            // Premultiplied colour is composited once. In particular, alpha
            // must remain 0.5 rather than becoming 0.25 in an empty framebuffer.
            shape_target.clear();
            draw_shape(.5f);
            const auto translucent = shape_target.read()[64 * 128 + 64];
            require(close_colour(translucent, Pixel{94, 99, 105, 128}),
                    "Shape opacity was multiplied twice");

            points.upload(pixel_plane(128, 32, 96, projection, true));
            shape_target.clear();
            draw_shape();
            shape_step = shape_target.read();
            require(coverage(shape_step) == 64 * 64, "Shape relief changed point coverage");
            require(int(shape_step[64 * 128 + 65][0]) + 30 < int(shape_step[64 * 128 + 85][0]),
                    "Same-colour depth edge has no geometric relief");
            require(shape_step[64 * 128 + 48] == flat_colour,
                    "Front face changed colour away from a depth discontinuity");
            shape_target.clear();
            draw_shape(1.f, 0.f);
            plain_step = shape_target.read();
            require(plain_step[64 * 128 + 65] == plain_step[64 * 128 + 85],
                    "Zero relief did not disable geometric shading");

            // Scene geometry in front of the map must remain unchanged. Its
            // depth is copied at the same sample count before map colouring.
            shape_target.clear();
            glEnable(GL_SCISSOR_TEST);
            glScissor(32, 32, 32, 64);
            glClearColor(.1f, .4f, .2f, 1);
            const auto foreground_clip = projection * glm::vec4(0, 0, -1, 1);
            glClearDepth(double(foreground_clip.z / foreground_clip.w) * .5 + .5);
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            glDisable(GL_SCISSOR_TEST);
            draw_shape();
            const auto scene_occluded = shape_target.read();
            require(close_colour(scene_occluded[64 * 128 + 48], Pixel{26, 102, 51, 255}),
                    "Shape style painted over scene foreground geometry");
            require(scene_occluded[64 * 128 + 85] == flat_colour,
                    "Scene depth copy removed visible map geometry");

            // A slanted triangle leaves genuinely partial MSAA coverage.
            // Shape with relief disabled must match the original point draw
            // sample for sample, including the foreground silhouette.
            points.upload(pixel_plane(128, 32, 96, projection));
            shape_target.clear();
            occluder.draw();
            shader.draw(points.vao, points.count, projection, 1, 1, {}, 0, 10,
                        ceres::SpatialMapShader::neutral);
            const auto point_silhouette = shape_target.read();
            shape_target.clear();
            occluder.draw();
            draw_shape(1.f, 0.f);
            const auto shape_silhouette = shape_target.read();
            for (size_t pixel = 0; pixel < point_silhouette.size(); ++pixel)
                require(close_colour(point_silhouette[pixel], shape_silhouette[pixel]),
                        "Shape changed partial scene sample coverage");

            shape_target.clear();
            points.upload({point(-2)});
            draw_shape();
            const auto before_trail = shape_target.read();
            shape_target.clear();
            points.upload({point(-3, .5f), point(-2)});
            draw_shape();
            require(shape_target.read() == before_trail,
                    "Weak rear point leaked through supported shape foreground");
            points.upload({point(-3)});
            shader.draw(points.vao, points.count, projection, 1, 1, {}, 0, 10,
                        ceres::SpatialMapShader::recency);
            require(shape_target.read() == before_trail,
                    "Supported shape surface did not retain scene depth for later trails");

            // The offscreen image is local to the scene viewport, which may
            // sit above replay controls and beside the settings panel.
            shape_target.clear();
            glViewport(16, 24, 64, 64);
            points.upload(pixel_plane(64, 16, 48, projection));
            draw_shape();
            const auto offset = shape_target.read();
            require(coverage(offset) == 32 * 32, "Viewport offset changed shape coverage");
            for (int y = 0; y < 128; ++y)
                for (int x = 0; x < 128; ++x)
                    require(offset[size_t(y) * 128 + x] ==
                                (x >= 32 && x < 64 && y >= 40 && y < 72 ? flat_colour : Pixel{}),
                            "Shape compositing escaped the scene viewport");
            shape_target.clear();
            glViewport(16, 24, 64, 64);
            glEnable(GL_SCISSOR_TEST);
            glScissor(40, 48, 16, 16);
            draw_shape();
            require(coverage(shape_target.read()) == 16 * 16,
                    "Shape compositing did not preserve the scene scissor");
            glDisable(GL_SCISSOR_TEST);
            require(glGetError() == GL_NO_ERROR, "Shape rendering reported an OpenGL error");
            ++shape_cases;
        }

        // The ordinary window framebuffer has a different depth attachment
        // format from the floating-point test target above.
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glViewport(0, 0, 128, 128);
        glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        glDepthMask(GL_TRUE);
        glClearDepth(1);
        glClearColor(0, 0, 0, 0);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        points.upload({point(-2)});
        shader.draw(points.vao, points.count, projection, 1, 1, {}, 0, 10,
                    ceres::SpatialMapShader::neutral, 0, 1, 30, ceres::SpatialMapStyle::shape);
        require(glGetError() == GL_NO_ERROR, "Default framebuffer shape rendering failed");

        target.clear();
        glUseProgram(0);
        glBindVertexArray(0);
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_BLEND);
        glDisable(GL_PROGRAM_POINT_SIZE);
        glDepthFunc(GL_GREATER);
        glDepthMask(GL_FALSE);
        glColorMask(GL_TRUE, GL_FALSE, GL_TRUE, GL_FALSE);
        GLuint retained_textures[2]{}, retained_sampler = 0;
        glGenTextures(2, retained_textures);
        glGenSamplers(1, &retained_sampler);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, retained_textures[0]);
        glBindSampler(0, retained_sampler);
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D_MULTISAMPLE, retained_textures[1]);
        glEnable(GL_CULL_FACE);
        glEnable(GL_SCISSOR_TEST);
        glScissor(3, 5, 119, 113);
        glViewport(7, 9, 96, 96);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, target.resolved);
        glBlendFuncSeparatei(1, GL_ONE, GL_ZERO, GL_ZERO, GL_ONE);
        glColorMaski(1, GL_FALSE, GL_TRUE, GL_FALSE, GL_TRUE);
        shader.draw(points.vao, points.count, projection, 1, 1, glm::vec3(0), 0, 10,
                    ceres::SpatialMapShader::neutral, 0, 1, 30, ceres::SpatialMapStyle::shape);
        GLint value = 0;
        GLboolean mask[4]{};
        glGetIntegerv(GL_CURRENT_PROGRAM, &value);
        require(value == 0, "Program state leaked");
        glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &value);
        require(value == 0, "VAO state leaked");
        glGetIntegerv(GL_DEPTH_FUNC, &value);
        require(value == GL_GREATER && !glIsEnabled(GL_DEPTH_TEST), "Depth state leaked");
        glGetBooleanv(GL_DEPTH_WRITEMASK, mask);
        require(!mask[0], "Depth write state leaked");
        glGetBooleanv(GL_COLOR_WRITEMASK, mask);
        require(mask[0] && !mask[1] && mask[2] && !mask[3], "Colour write state leaked");
        require(!glIsEnabled(GL_BLEND) && !glIsEnabled(GL_PROGRAM_POINT_SIZE) && glIsEnabled(GL_MULTISAMPLE),
                "Raster state leaked");
        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &value);
        require(value == GLint(target.framebuffer), "Shape draw framebuffer state leaked");
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &value);
        require(value == GLint(target.resolved), "Shape read framebuffer state leaked");
        GLint rectangle[4]{};
        glGetIntegerv(GL_VIEWPORT, rectangle);
        require(rectangle[0] == 7 && rectangle[1] == 9 && rectangle[2] == 96 && rectangle[3] == 96,
                "Shape viewport state leaked");
        glGetIntegerv(GL_SCISSOR_BOX, rectangle);
        require(glIsEnabled(GL_CULL_FACE) && glIsEnabled(GL_SCISSOR_TEST) && rectangle[0] == 3 &&
                    rectangle[1] == 5 && rectangle[2] == 119 && rectangle[3] == 113,
                "Shape scissor or cull state leaked");
        glGetIntegerv(GL_ACTIVE_TEXTURE, &value);
        require(value == GL_TEXTURE1, "Shape active texture state leaked");
        glGetIntegerv(GL_TEXTURE_BINDING_2D_MULTISAMPLE, &value);
        require(value == GLint(retained_textures[1]), "Shape multisample texture state leaked");
        glActiveTexture(GL_TEXTURE0);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &value);
        require(value == GLint(retained_textures[0]), "Shape texture state leaked");
        glGetIntegeri_v(GL_SAMPLER_BINDING, 0, &value);
        require(value == GLint(retained_sampler), "Shape sampler state leaked");
        glGetIntegeri_v(GL_BLEND_SRC_RGB, 1, &value);
        require(value == GL_ONE, "Shape indexed blend state leaked");
        glGetBooleani_v(GL_COLOR_WRITEMASK, 1, mask);
        require(!mask[0] && mask[1] && !mask[2] && mask[3], "Shape indexed colour mask state leaked");
        glDeleteTextures(2, retained_textures);
        glDeleteSamplers(1, &retained_sampler);
        require(glGetError() == GL_NO_ERROR, "OpenGL reported an error");
        if (argc > 1) {
            const std::filesystem::path output(argv[1]);
            std::filesystem::create_directories(output);
            write_image(output / "head-near.ppm", near_head, target.width);
            write_image(output / "head-far.ppm", far_head, target.width);
            write_image(output / "density-full.ppm", full, target.width);
            write_image(output / "density-half.ppm", half, target.width);
            write_image(output / "density-tentative-half.ppm", tentative_half, target.width);
            write_image(output / "shape-flat.ppm", shape_flat, target.width);
            write_image(output / "shape-depth-step.ppm", shape_step, target.width);
            write_image(output / "shape-zero-relief.ppm", plain_step, target.width);
            std::ofstream proof(output / "pixel-proof.json");
            proof << "{\"footprint_cases\":" << footprint_cases
                  << ",\"point_widths_px\":[1,2,4],\"samples\":[1,4],\"framebuffer_extents\":[64,128,256],"
                     "\"frozen_vertex_recolour\":true,\"orbit_invariant_colour\":true,"
                     "\"recency_low_word_borrow\":true,\"same_depth_colour_footprint\":true,"
                     "\"stable_density\":true,\"confidence_prioritised_density\":true,\"update_interval_fade\":true,\"state_restored\":true,"
                     "\"shape_flat_neutral\":true,\"shape_depth_relief\":true,"
                     "\"shape_scene_occlusion\":true,\"shape_trail_depth\":true,"
                     "\"shape_viewport_scissor\":true,\"shape_premultiplied_alpha\":true,"
                     "\"shape_sample_cases\":" << shape_cases
                  << ",\"gradient_cases\":" << gradient_cases
                  << ",\"gradient_default_preserved\":true,\"gradient_shared_palette\":true}\n";
        }
        std::cout << "Spatial map rendering passed: " << footprint_cases
                  << " pixel-footprint cases, " << gradient_cases
                  << " gradient cases, frozen recolouring, orbit invariance, recency, density, occlusion and shape relief\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
