#pragma once
#include "ceres/types.hpp"
#include <filesystem>
#include <memory>

namespace ceres {
struct ExportStatus {
    bool running = false;
    float progress = 0.0f;
    std::string error, message;
    std::filesystem::path output;
};

class ExportJob {
  public:
    explicit ExportJob(std::filesystem::path helper = {}, std::filesystem::path ffmpeg = {});
    ~ExportJob();
    ExportJob(const ExportJob&) = delete;
    ExportJob& operator=(const ExportJob&) = delete;
    // Checks current executable presence without starting a process. UI callers
    // can refresh periodically, while start always resolves the executable again.
    bool exporter_available() const noexcept;
    bool start(Json job, const std::filesystem::path& job_path);
    void cancel();
    ExportStatus status() const;
    ExportStatus snapshot() const {
        return status();
    }
    static std::filesystem::path discover_helper();
    static std::filesystem::path discover_ffmpeg();

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace ceres
