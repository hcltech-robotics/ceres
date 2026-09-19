#pragma once

#include <filesystem>
#include <stop_token>

namespace ceres {

// Prepare an indexed replay from a downloaded CERES LeRobot v3 dataset.
// The destination is published only when import completes successfully.
void import_lerobot_replay(const std::filesystem::path& dataset_directory,
                           const std::filesystem::path& output_mcap,
                           std::stop_token stop);

} // namespace ceres
