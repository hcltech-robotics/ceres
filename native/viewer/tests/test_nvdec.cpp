#include "ceres/video.hpp"
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <thread>

using namespace ceres;
namespace {
void require(bool condition, const std::string& message) {
    if (!condition)
        throw std::runtime_error(message);
}
void cuda_check(CUresult result, const char* operation) {
    if (result == CUDA_SUCCESS)
        return;
    const char* description = nullptr;
    cuGetErrorString(result, &description);
    throw std::runtime_error(std::string(operation) + ": " +
                             (description ? description : "CUDA error"));
}
struct AccessUnit {
    std::vector<uint8_t> bytes;
    bool idr = false, sps = false, pps = false;
};
std::vector<AccessUnit> read_units(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    require(bool(input), "Cannot open input: " + path.string());
    const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(input)), {});
    struct Nal {
        size_t start;
        uint8_t type;
    };
    std::vector<Nal> nals;
    for (size_t i = 0; i + 3 < bytes.size();) {
        size_t prefix = 0;
        if (!bytes[i] && !bytes[i + 1]) {
            if (bytes[i + 2] == 1)
                prefix = 3;
            else if (!bytes[i + 2] && bytes[i + 3] == 1)
                prefix = 4;
        }
        if (prefix && i + prefix < bytes.size()) {
            nals.push_back({i, uint8_t(bytes[i + prefix] & 31)});
            i += prefix;
        } else
            ++i;
    }
    std::vector<size_t> boundaries;
    for (const auto& nal : nals)
        if (nal.type == 9)
            boundaries.push_back(nal.start);
    require(boundaries.size() == 6 && boundaries.front() == 0,
            "Expected six AUD-framed access units");
    boundaries.push_back(bytes.size());
    std::vector<AccessUnit> units;
    for (size_t i = 0; i + 1 < boundaries.size(); ++i) {
        AccessUnit unit;
        unit.bytes.assign(bytes.begin() + boundaries[i], bytes.begin() + boundaries[i + 1]);
        for (const auto& nal : nals) {
            if (nal.start < boundaries[i] || nal.start >= boundaries[i + 1])
                continue;
            unit.idr |= nal.type == 5;
            unit.sps |= nal.type == 7;
            unit.pps |= nal.type == 8;
        }
        units.push_back(std::move(unit));
    }
    require(units.front().idr && units.front().sps && units.front().pps,
            "Initial AU lacks SPS/PPS/IDR");
    require(!units[1].idr && !units[1].sps && !units[1].pps,
            "Dependency-loss input is not a P-frame AU");
    return units;
}
std::vector<uint8_t> copy_nv12(const VideoFrameLease& lease) {
    require(bool(lease) && lease.image->data && lease.image->context_owner,
            "Frame has no owned GPU surface");
    const auto& image = *lease.image;
    std::vector<uint8_t> bytes(size_t(image.width) * size_t(image.height) * 3 / 2);
    cuda_check(cuCtxPushCurrent(image.context), "Activate leased frame context");
    try {
        CUDA_MEMCPY2D copy{};
        copy.srcMemoryType = CU_MEMORYTYPE_DEVICE;
        copy.srcDevice = image.data;
        copy.srcPitch = image.pitch;
        copy.dstMemoryType = CU_MEMORYTYPE_HOST;
        copy.dstHost = bytes.data();
        copy.dstPitch = size_t(image.width);
        copy.WidthInBytes = size_t(image.width);
        copy.Height = size_t(image.height) * 3 / 2;
        cuda_check(cuMemcpy2D(&copy), "Read leased NV12 surface");
    } catch (...) {
        CUcontext previous = nullptr;
        cuCtxPopCurrent(&previous);
        throw;
    }
    CUcontext previous = nullptr;
    cuda_check(cuCtxPopCurrent(&previous), "Restore caller context");
    const auto luma_end = bytes.begin() + size_t(image.width) * size_t(image.height);
    const auto range = std::minmax_element(bytes.begin(), luma_end);
    require(int(*range.second) - int(*range.first) > 32,
            "Decoded test pattern has no luma variation");
    return bytes;
}
std::string content_hash(const std::vector<uint8_t>& bytes) {
    uint64_t hash = 14695981039346656037ULL;
    for (const auto byte : bytes) {
        hash ^= byte;
        hash *= 1099511628211ULL;
    }
    std::ostringstream output;
    output << std::hex << std::setfill('0') << std::setw(16) << hash;
    return output.str();
}
Json read_reference(const std::filesystem::path& inputs) {
    std::ifstream input(inputs / "nvdec-cpu-reference.json");
    require(
        bool(input),
        "Generate nvdec-cpu-reference.json with scripts/nvdec-reference.py before GPU execution");
    Json reference;
    input >> reference;
    require(reference.at("schema") == "ceres-viewer-nvdec-cpu-reference" &&
                reference.at("version") == 2 && reference.at("sources").size() == 3,
            "Unexpected CPU reference schema");
    for (const auto& source : reference.at("sources")) {
        const std::filesystem::path name = source.at("file").get<std::string>();
        require(name == name.filename(), "CPU reference input must be a basename");
        std::ifstream encoded(inputs / name, std::ios::binary);
        require(bool(encoded), "Missing CPU reference input");
        const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(encoded)), {});
        require(bytes.size() == source.at("input_bytes").get<size_t>() &&
                    content_hash(bytes) == source.at("input_fnv1a64").get<std::string>(),
                "CPU reference belongs to different H.264 bytes");
        require(source.at("cpu_nv12_fnv1a64").size() == 6, "Expected six CPU reference frames");
    }
    return reference;
}
SessionEvent event_for(const AccessUnit& unit, uint32_t sequence, uint64_t generation) {
    SessionEvent event;
    event.kind = EventKind::Video;
    event.stream = "passthrough";
    event.epoch = 1;
    event.sequence = sequence;
    event.receive_us = event.time_us = monotonic_us();
    event.keyframe = unit.idr;
    event.payload = unit.bytes;
    event.attributes = {{"codec", "h264"}, {"replay_generation", generation}};
    return event;
}
VideoFrameLease wait_frame(NvDecoder& decoder, uint32_t sequence, int width, int height,
                           uint64_t expected_count, int64_t global_deadline) {
    const auto deadline = std::min(global_deadline, monotonic_us() + 3000000);
    while (monotonic_us() < deadline) {
        const auto status = decoder.status();
        require(!status.failed, "Decoder worker failed: " + status.error);
        require(status.decoded <= expected_count, "Decoder published an unexpected extra frame");
        auto lease = decoder.latest();
        if (lease && lease.image->event.sequence == sequence && status.decoded == expected_count &&
            !status.needs_keyframe && status.error.empty()) {
            require(lease.image->width == width && lease.image->height == height,
                    "Decoded dimensions differ from the submitted segment");
            return lease;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const auto status = decoder.status();
    throw std::runtime_error("Timed out waiting for sequence " + std::to_string(sequence) +
                             ", decoded=" + std::to_string(status.decoded) +
                             ", queued=" + std::to_string(status.queued) + ", needs_keyframe=" +
                             std::to_string(status.needs_keyframe) + ", error=" + status.error);
}
void write_report(const std::filesystem::path& path, const Json& report) {
    std::ofstream output(path);
    require(bool(output), "Cannot write probe report");
    output << report.dump(2) << '\n';
}
} // namespace
int main(int argc, char** argv) {
    if (argc != 4 || std::string(argv[1]) != "--run-gpu") {
        std::cerr << "Usage: test_nvdec --run-gpu INPUT_DIRECTORY REPORT_JSON\n";
        return 2;
    }
    const std::filesystem::path inputs = argv[2], report_path = argv[3];
    Json report{{"passed", false},
                {"gpu_execution_requested", true},
                {"cuda_initialised", false},
                {"frames", Json::array()},
                {"transitions", Json::array()}};
    try {
        const auto reference = read_reference(inputs);
        report["cpu_reference"] = reference;
        const auto small_a = read_units(inputs / "nvdec-resolution-640x480-a.h264");
        const auto large = read_units(inputs / "nvdec-resolution-1280x960-b.h264");
        const auto small_c = read_units(inputs / "nvdec-resolution-640x480-c.h264");
        auto decoder = std::make_unique<NvDecoder>(0);
        report["cuda_initialised"] = true;
        const int64_t deadline = monotonic_us() + 30000000;
        report["gpu"] = decoder->status().gpu;
        int driver_version = 0;
        cuda_check(cuDriverGetVersion(&driver_version), "Read CUDA driver version");
        report["cuda_driver_version"] = driver_version;
        uint32_t sequence = 0;
        uint64_t decoded = 0;
        VideoFrameLease retained;
        std::vector<uint8_t> retained_bytes;
        auto submit_segment = [&](const std::vector<AccessUnit>& units, int width, int height,
                                  const char* label, size_t reference_index) {
            const auto& expected = reference.at("sources").at(reference_index);
            require(expected.at("width") == width && expected.at("height") == height,
                    "CPU reference dimensions disagree");
            size_t frame_index = 0;
            for (const auto& unit : units) {
                decoder->submit(event_for(unit, ++sequence, 1));
                auto lease = wait_frame(*decoder, sequence, width, height, ++decoded, deadline);
                const auto bytes = copy_nv12(lease);
                if (retained)
                    require(lease.image->data != retained.image->data,
                            "Decoder reused a leased old surface");
                const auto actual_hash = content_hash(bytes);
                const auto expected_hash =
                    expected.at("cpu_nv12_fnv1a64").at(frame_index++).get<std::string>();
                report["frames"].push_back({{"sequence", sequence},
                                            {"width", width},
                                            {"height", height},
                                            {"nv12_fnv1a64", actual_hash},
                                            {"cpu_nv12_fnv1a64", expected_hash},
                                            {"bit_exact_match", actual_hash == expected_hash},
                                            {"idr", unit.idr}});
                require(actual_hash == expected_hash,
                        "NV12 pixels differ from software decode at sequence " +
                            std::to_string(sequence));
                if (!retained) {
                    retained = lease;
                    retained_bytes = bytes;
                }
            }
            require(copy_nv12(retained) == retained_bytes,
                    "Retained frame changed during resolution transition");
            report["transitions"].push_back({{"segment", label},
                                             {"width", width},
                                             {"height", height},
                                             {"decoded_total", decoded},
                                             {"old_lease_unchanged", true}});
            std::cout << "Decoded " << label << ": " << units.size() << " frames\n" << std::flush;
        };
        submit_segment(small_a, 640, 480, "640x480-a", 0);
        submit_segment(large, 1280, 960, "1280x960-b", 1);
        submit_segment(small_c, 640, 480, "640x480-c", 2);

        SessionEvent reset;
        reset.kind = EventKind::Epoch;
        reset.epoch = 1;
        reset.attributes = {{"reason", "acceptance-dependency-loss"},
                            {"reset_decoder", true},
                            {"replay_generation", uint64_t(2)}};
        decoder->submit(reset);
        decoder->submit(event_for(small_c[1], ++sequence, 2));
        const auto quiet_until = monotonic_us() + 200000;
        while (monotonic_us() < quiet_until) {
            const auto status = decoder->status();
            require(!status.failed && status.decoded == decoded && status.needs_keyframe &&
                        !decoder->latest(),
                    "A dependency frame was presented without decode history");
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        for (size_t i = 0; i < 2; ++i) {
            decoder->submit(event_for(small_c[i], ++sequence, 2));
            auto lease = wait_frame(*decoder, sequence, 640, 480, ++decoded, deadline);
            const auto actual_hash = content_hash(copy_nv12(lease));
            const auto expected_hash =
                reference.at("sources").at(2).at("cpu_nv12_fnv1a64").at(i).get<std::string>();
            report["frames"].push_back({{"sequence", sequence},
                                        {"width", 640},
                                        {"height", 480},
                                        {"nv12_fnv1a64", actual_hash},
                                        {"cpu_nv12_fnv1a64", expected_hash},
                                        {"bit_exact_match", actual_hash == expected_hash},
                                        {"idr", small_c[i].idr}});
            require(actual_hash == expected_hash,
                    "Recovery NV12 pixels differ from software decode");
        }
        const auto status = decoder->status();
        require(status.decoded == 20 && status.dropped == 0 && !status.failed &&
                    status.error.empty(),
                "Unexpected final decoder status");
        report["dependency_recovery"] = {{"method", "explicit history reset followed by P-frame, "
                                                    "then real SPS/PPS/IDR and dependent frame"},
                                         {"dependent_frame_suppressed_without_idr", true},
                                         {"quiet_check_ms", 200},
                                         {"recovered_decoded_frames", 2}};
        report["submitted_access_units"] = sequence;
        report["decoded_frames"] = status.decoded;
        report["dropped_frames"] = status.dropped;
        report["retained_dimensions"] = {retained.image->width, retained.image->height};
        report["retained_nv12_fnv1a64"] = content_hash(retained_bytes);
        decoder.reset();
        require(copy_nv12(retained) == retained_bytes,
                "Old lease or CUDA context did not survive decoder destruction");
        report["old_lease_survived_decoder_destruction"] = true;
        report["all_frames_bit_exact_match"] = true;
        retained = {};
        report["passed"] = true;
        write_report(report_path, report);
        std::cout << "NVDEC resolution and lease checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        report["error"] = error.what();
        try {
            write_report(report_path, report);
        } catch (...) {
        }
        std::cerr << error.what() << '\n';
        return 1;
    }
}
