#include "ceres/export_job.hpp"
#include "ceres/lerobot_import.hpp"
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace fs = std::filesystem;
using ceres::Json;
fs::path from_utf8(std::string_view value) {
    return fs::path(std::u8string(value.begin(), value.end()));
}
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
ceres::ExportStatus wait(ceres::ExportJob& job) {
    const auto start = std::chrono::steady_clock::now();
    while (job.status().running &&
           std::chrono::steady_clock::now() - start < std::chrono::seconds(10))
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    auto status = job.status();
    require(!status.running, "Export job did not finish");
    return status;
}
Json export_capabilities(bool source_dimensions = true) {
    return {{"schema", "ceres-native-export-capabilities"},
            {"job_version", 1}, {"lerobot", "v3.0"}, {"actions", true},
            {"action_dimension", 2}, {"ceres_episode_shards", true},
            {"source_video_dimensions", source_dimensions},
            {"profiles", {"ceres-bridge-lerobot3-v1", "ceres-bridge-observation-v1"}}};
}
void set_search_path(const fs::path& directory) {
#ifdef _WIN32
    require(_wputenv_s(L"PATH", directory.c_str()) == 0, "Cannot set fixture search path");
#else
    require(setenv("PATH", directory.c_str(), 1) == 0, "Cannot set fixture search path");
#endif
}
void availability_tests(const fs::path& self) {
    // This runs in a copied fixture process with an isolated executable directory.
    const auto root = self.parent_path();
    const auto first_directory = root / "first path";
    const auto second_directory = root / "second path";
    fs::create_directories(first_directory);
    fs::create_directories(second_directory);
    const auto name = "ceres-native-exporter" + self.extension().string();
    const auto first = first_directory / name;
    const auto second = second_directory / name;
    const auto packaged = root / name;
    const auto packaged_bin = root / "bin" / name;
    const Json manifest{{"output", (root / "dataset").string()}};
    set_search_path(first_directory);
    ceres::ExportJob discovered({}, self);
    require(ceres::ExportJob::discover_helper().empty() && !discovered.exporter_available(),
            "Absent exporter was reported as available");
    require(!discovered.start(manifest, root / "missing.json") &&
                !fs::exists(root / "missing.json"),
            "Absent exporter started or wrote an export job");
    fs::create_directory(first);
    require(!discovered.exporter_available(), "An exporter directory was treated as executable");
    fs::remove(first);
    fs::copy_file(self, first);
#ifndef _WIN32
    fs::permissions(first, fs::perms::owner_exec | fs::perms::group_exec | fs::perms::others_exec,
                    fs::perm_options::remove);
    require(!discovered.exporter_available(), "A non-executable exporter was accepted");
    fs::permissions(first, fs::perms::owner_exec, fs::perm_options::add);
#endif
    const auto probe_marker = first_directory / "availability-probed";
    std::ofstream(first_directory / "availability-watch").put('\n');
    for (int check = 0; check < 3; ++check)
        require(discovered.exporter_available(), "Exporter installation was not detected");
    require(ceres::ExportJob::discover_helper() == first && !fs::exists(probe_marker),
            "Availability did not use discovery or started an exporter process");
    require(discovered.start(manifest, root / "installed.json") && wait(discovered).error.empty() &&
                fs::is_regular_file(probe_marker),
            "Installed exporter could not complete an export");
    fs::remove(first);
    require(!discovered.exporter_available() &&
                !discovered.start(manifest, root / "removed.json") &&
                !fs::exists(root / "removed.json"),
            "Removed exporter left a stale executable path");
    fs::copy_file(self, second);
    set_search_path(second_directory);
    require(discovered.exporter_available() && ceres::ExportJob::discover_helper() == second &&
                discovered.start(manifest, root / "reinstalled.json") &&
                wait(discovered).error.empty(),
            "Exporter relocation did not recover after removal");
    fs::copy_file(self, packaged);
    require(ceres::ExportJob::discover_helper() == packaged && discovered.exporter_available(),
            "Packaged exporter did not take precedence over PATH");
    fs::remove(packaged);
    fs::create_directory(packaged_bin.parent_path());
    fs::copy_file(self, packaged_bin);
    require(ceres::ExportJob::discover_helper() == packaged_bin && discovered.exporter_available(),
            "Packaged bin exporter was not discovered");
    fs::remove(packaged_bin);
    require(ceres::ExportJob::discover_helper() == second && discovered.exporter_available(),
            "Removing the packaged exporter did not restore PATH discovery");

    const auto explicit_path = root / ("explicit exporter" + self.extension().string());
    ceres::ExportJob explicit_job(explicit_path, self);
    require(!explicit_job.exporter_available(), "Missing explicit exporter fell back to PATH");
    fs::copy_file(self, explicit_path);
    require(explicit_job.exporter_available() &&
                explicit_job.start(manifest, root / "explicit.json") &&
                wait(explicit_job).error.empty(),
            "Explicit exporter installation was not detected");
    fs::remove(explicit_path);
    require(!explicit_job.exporter_available() &&
                !explicit_job.start(manifest, root / "explicit-removed.json"),
            "Removed explicit exporter remained available or fell back to PATH");
}
int helper(int argc, char** argv) {
    const auto executable = from_utf8(argv[0]);
    if (std::string(argv[1]) == "--capabilities") {
        if (fs::exists(executable.parent_path() / "availability-watch"))
            std::ofstream(executable.parent_path() / "availability-probed").put('\n');
        auto capabilities = export_capabilities(executable.filename().string().find("legacy") == std::string::npos);
        if (executable.stem() == "ceres-native-exporter") {
            std::ifstream file(executable.parent_path() / "replay-capabilities.json");
            if (file) capabilities = Json::parse(file);
        }
        std::cout << capabilities.dump() << '\n';
        return capabilities.value("fixture_exit", 0);
    }
    if (argc == 3 && std::string(argv[1]) == "--import-job") {
        std::ofstream marker(executable.parent_path() / "import-started");
        marker << "started\n";
        std::ifstream input(from_utf8(argv[2]));
        const auto job = Json::parse(input);
        std::ofstream output(from_utf8(job.at("output").get<std::string>()), std::ios::binary);
        output << "replay with task metadata";
        output.close();
        std::cout << Json{{"schema", "ceres-export-progress"}, {"stage", "complete"}}.dump() << '\n';
        return 0;
    }
    require(argc == 3 && std::string(argv[1]) == "--job", "Invalid helper invocation");
    std::ifstream input(from_utf8(argv[2]));
    const auto job = Json::parse(input);
    const auto scenario = job.value("test_scenario", "success");
    if (scenario == "availability")
        availability_tests(executable);
    if (scenario == "replay-capability") {
        try {
            ceres::import_lerobot_replay(from_utf8(job.at("dataset").get<std::string>()),
                                       from_utf8(job.at("replay_output").get<std::string>()), {});
        } catch (const std::exception& error) {
            std::cout << Json{{"schema", "ceres-export-progress"}, {"stage", "error"},
                               {"message", error.what()}}.dump() << '\n';
            return 17;
        }
    }
    if (scenario == "failure") {
        std::cerr << Json{{"schema", "ceres-export-progress"},
                          {"version", 1},
                          {"stage", "error"},
                          {"message", "Expected exporter failure"}}
                         .dump()
                  << '\n';
        return 17;
    }
    if (scenario == "cancel") {
        const auto start = std::chrono::steady_clock::now();
        while (!fs::exists(from_utf8(job.at("cancel_file").get<std::string>()))) {
            if (std::chrono::steady_clock::now() - start > std::chrono::seconds(9))
                return 18;
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        return 1;
    }
    if (scenario == "ignore_cancel") {
        std::this_thread::sleep_for(std::chrono::seconds(20));
        return 19;
    }
    std::cout << Json{{"schema", "ceres-export-progress"},
                      {"version", 1},
                      {"stage", "exporting"},
                      {"completed", 0},
                      {"total", 1}}
                     .dump()
              << '\n';
    fs::create_directories(from_utf8(job.at("output").get<std::string>()));
    std::cout << Json{{"schema", "ceres-export-progress"},
                      {"version", 1},
                      {"stage", "complete"},
                      {"completed", 1},
                      {"total", 1}}
                     .dump()
              << '\n';
    return 0;
}
void replay_capability_tests(const fs::path& root, const fs::path& self) {
    fs::create_directories(root);
    const auto importer = root / ("ceres-native-exporter" + self.extension().string());
    const auto ffmpeg = root / ("ffmpeg" + self.extension().string());
    const auto driver = root / ("replay driver" + self.extension().string());
    for (const auto& executable : {importer, ffmpeg, driver}) fs::copy_file(self, executable);
    const auto capability_file = root / "replay-capabilities.json";
    const auto set_capabilities = [&](const Json& value) {
        std::ofstream file(capability_file);
        require(bool(file << value.dump() << '\n'), "Cannot write fixture capabilities");
    };
    const auto legacy = export_capabilities();
    set_capabilities(legacy);
    ceres::ExportJob normal_export(importer, ffmpeg);
    require(normal_export.start(Json{{"output", (root / "normal-export").string()}}, root / "export.json"),
            "Could not start normal export with an older helper");
    require(wait(normal_export).error.empty(), "Replay capability requirements changed normal export support");

    const auto replay = root / "imported.mcap";
    const auto marker = root / "import-started";
    const Json job{{"output", (root / "driver-output").string()}, {"dataset", (root / "dataset").string()},
                   {"replay_output", replay.string()}, {"test_scenario", "replay-capability"}};
    ceres::ExportJob runner(driver, ffmpeg);
    auto current = legacy;
    current["replay_import_version"] = 1;
    current["replay_task_schema"] = "ceres-replay-task";
    current["replay_task_version"] = 1;
    auto wrong_schema = current; wrong_schema["replay_task_schema"] = "another-schema";
    auto wrong_version = current; wrong_version["replay_task_version"] = 0;
    auto wrong_type = current; wrong_type["replay_task_version"] = "1";
    auto failed_probe = current; failed_probe["fixture_exit"] = 9;
    for (const auto& unsupported : {legacy, wrong_schema, wrong_version, wrong_type, failed_probe}) {
        set_capabilities(unsupported);
        require(runner.start(job, root / "driver-job.json"), "Could not start replay capability fixture");
        require(wait(runner).error.find("replay tasks and repetitions") != std::string::npos &&
                    !fs::exists(marker) && !fs::exists(replay),
                "Unsupported importer started replay conversion");
    }
    set_capabilities(current);
    require(runner.start(job, root / "driver-job.json"), "Could not start current replay importer");
    require(wait(runner).error.empty() && fs::is_regular_file(marker) && fs::is_regular_file(replay),
            "Current task metadata importer was rejected");
}
int main(int argc, char** argv) {
    if (argc > 1)
        return helper(argc, argv);
    const auto root = fs::temp_directory_path() /
                      ("ceres-export-process-test-" + std::to_string(ceres::monotonic_us()));
    try {
        fs::create_directories(root);
        const auto self = fs::absolute(from_utf8(argv[0]));
        replay_capability_tests(root / "replay capabilities", self);
        const auto discovery_directory = root / "exporter discovery";
        fs::create_directory(discovery_directory);
        const auto discovery_driver = discovery_directory / ("driver" + self.extension().string());
        fs::copy_file(self, discovery_driver);
        ceres::ExportJob discovery(discovery_driver, self);
        require(discovery.start(Json{{"output", (root / "discovery output").string()},
                                     {"test_scenario", "availability"}}, root / "discovery.json"),
                "Could not start exporter availability tests");
        const auto discovery_status = wait(discovery);
        if (!discovery_status.error.empty())
            throw std::runtime_error(discovery_status.error);
#ifdef _WIN32
        const auto executable = root / "helper with spaces.exe";
#else
        const auto executable = root / "helper with spaces";
#endif
        fs::copy_file(self, executable);
        ceres::ExportJob job(executable, executable);
        const auto output = root / "output with spaces";
        require(job.start(Json{{"output", output.string()}}, root / "job with spaces.json"),
                "Could not start export");
        require(!job.start(Json{{"output", output.string()}}, root / "duplicate.json"),
                "Concurrent export was accepted");
        auto status = wait(job);
        require(status.error.empty() && status.progress == 1.0f && fs::is_directory(output),
                "Successful export status is incorrect");
        {
            std::ifstream manifest(root / "job with spaces.json");
            require(Json::parse(manifest).at("profile") == "ceres-bridge-lerobot3-v1",
                    "Default export is not CERES-compatible LeRobot v3");
        }
        {
            std::ifstream manifest(root / "job with spaces.json");
            require(Json::parse(manifest).at("video").at("stream") == "passthrough",
                    "Default export must select the primary camera explicitly");
        }
        require(job.start(Json{{"output", output.string()}, {"profile", "unknown-profile"}},
                          root / "unsupported.json"),
                "Could not probe unsupported profile");
        status = wait(job);
        require(!status.error.empty() && !fs::exists(root / "unsupported.json"),
                "Unsupported export profile was accepted");
        require(
            job.start(Json{{"output", output.string()}, {"profile", "ceres-bridge-observation-v1"}},
                      root / "observations.json"),
            "Could not start explicit observation export");
        require(wait(job).error.empty(), "Explicit observation profile was rejected");
        require(job.start(Json{{"output", output.string()},
                               {"video", {{"source_dimensions", true}}}},
                          root / "source-dimensions.json"),
                "Could not start source-resolution export");
        require(wait(job).error.empty(), "Source-resolution export was rejected");
        const auto legacy_executable = root / ("legacy-" + executable.filename().string());
        fs::copy_file(executable, legacy_executable);
        ceres::ExportJob legacy(legacy_executable, executable);
        require(legacy.start(Json{{"output", output.string()},
                                  {"video", {{"source_dimensions", true}}}},
                             root / "legacy-source-dimensions.json"),
                "Could not probe legacy exporter capabilities");
        require(wait(legacy).error.find("recorded camera resolution") != std::string::npos &&
                    !fs::exists(root / "legacy-source-dimensions.json"),
                "Source-resolution export was submitted to an incompatible helper");
        require(job.start(Json{{"output", output.string()}, {"test_scenario", "failure"}},
                          root / "failure.json"),
                "Could not start failing export");
        status = wait(job);
        require(status.error == "Expected exporter failure", "Structured stderr error was lost");
        require(job.start(Json{{"output", output.string()}, {"test_scenario", "cancel"}},
                          root / "cancel.json"),
                "Could not start cancellable export");
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        job.cancel();
        status = wait(job);
        require(status.error.empty() && status.message == "Export cancelled",
                "Cancellation status is incorrect");
        require(job.start(Json{{"output", output.string()}, {"test_scenario", "ignore_cancel"}},
                          root / "force cancel.json"),
                "Could not start unresponsive export");
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        job.cancel();
        status = wait(job);
        require(status.error.empty() && status.message == "Export cancelled",
                "Unresponsive exporter was not terminated");
        ceres::ExportJob missing(root / "missing-helper", executable);
        require(!missing.start(Json{{"output", output.string()}}, root / "missing.json"),
                "Missing helper was accepted");
        require(!missing.status().error.empty(), "Missing helper has no error");
        const auto* real_helper = std::getenv("CERES_TEST_EXPORTER");
        const auto* real_job = std::getenv("CERES_TEST_EXPORT_JOB");
        if (real_helper && real_job) {
            const auto source_job = fs::absolute(from_utf8(real_job));
            std::ifstream input(source_job);
            auto manifest = Json::parse(input);
            auto source = from_utf8(manifest.at("session").get<std::string>());
            if (source.is_relative())
                source = source_job.parent_path() / source;
            manifest["session"] = source.string();
            manifest["output"] = (root / "real dataset").string();
            ceres::ExportJob actual(from_utf8(real_helper));
            require(actual.start(manifest, root / "real job.json"),
                    "Could not start actual native exporter");
            status = wait(actual);
            if (!status.error.empty())
                throw std::runtime_error(status.error);
            std::ifstream info_file(status.output / "meta/info.json");
            const auto info = Json::parse(info_file);
            const bool ceres_profile =
                manifest.value("profile", "ceres-bridge-lerobot3-v1") == "ceres-bridge-lerobot3-v1";
            require(info.at("total_frames") == 7 &&
                        info.at("features").contains("action") == ceres_profile,
                    "Actual native export differs from fixture");
        }
        fs::remove_all(root);
        std::cout << "Export process tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        std::error_code ignored;
        fs::remove_all(root, ignored);
        return 1;
    }
}
