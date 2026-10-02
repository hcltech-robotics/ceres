#pragma once
#include <filesystem>
#include <string>

namespace ceres::platform {
// Independent of the working directory, including Finder/app-translocation launches.
std::filesystem::path executable_path();
std::filesystem::path executable_directory();
std::filesystem::path resource_directory();
std::filesystem::path config_directory();
std::filesystem::path data_directory();
std::filesystem::path cache_directory(const std::filesystem::path& config);
#ifdef __APPLE__
std::string system_certificates();
#endif
} // namespace ceres::platform
