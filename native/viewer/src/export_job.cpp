#include "ceres/export_job.hpp"
#include "ceres/lerobot_import.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif

namespace ceres {
namespace {
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
fs::path from_utf8(std::string_view value) {
    return fs::path(std::u8string(value.begin(), value.end()));
}
std::string utf8(const fs::path& path) {
    const auto value = path.u8string();
    return {value.begin(), value.end()};
}
fs::path executable_directory() {
#ifdef _WIN32
    std::vector<wchar_t> buffer(32768);
    const auto count =
        GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!count || count == buffer.size())
        throw std::runtime_error("Cannot locate application executable");
    return fs::path(std::wstring(buffer.data(), count)).parent_path();
#else
    std::array<char, 4096> buffer{};
    const auto count = readlink("/proc/self/exe", buffer.data(), buffer.size() - 1);
    if (count <= 0)
        throw std::runtime_error("Cannot locate application executable");
    return fs::path(std::string(buffer.data(), static_cast<size_t>(count))).parent_path();
#endif
}
bool executable_file(const fs::path& path) {
    std::error_code error;
    if (!fs::is_regular_file(path, error))
        return false;
#ifdef _WIN32
    return true;
#else
    return access(path.c_str(), X_OK) == 0;
#endif
}
fs::path find_executable(const fs::path& requested, bool prefer_packaged) {
    if (requested.has_parent_path() || requested.is_absolute()) {
        return executable_file(requested) ? fs::absolute(requested) : fs::path{};
    }
    auto name = requested;
#ifdef _WIN32
    if (name.extension().empty())
        name += L".exe";
#endif
    if (prefer_packaged) {
        const auto directory = executable_directory();
        for (const auto& candidate : {directory / name, directory / "bin" / name}) {
            if (executable_file(candidate))
                return candidate;
        }
    }
#ifdef _WIN32
    const auto* environment = _wgetenv(L"PATH");
    const std::wstring paths = environment ? environment : L"";
    constexpr wchar_t separator = L';';
#else
    const auto* environment = std::getenv("PATH");
    const std::string paths = environment ? environment : "";
    constexpr char separator = ':';
#endif
    size_t begin = 0;
    while (begin <= paths.size()) {
        const auto end = paths.find(separator, begin);
        auto directory = paths.substr(begin, end == std::string::npos ? end : end - begin);
        if (directory.size() >= 2 && directory.front() == '"' && directory.back() == '"')
            directory = directory.substr(1, directory.size() - 2);
        if (!directory.empty()) {
#ifdef _WIN32
            const auto candidate = fs::path(directory) / name;
#else
            const auto candidate = from_utf8(directory) / name;
#endif
            if (executable_file(candidate))
                return fs::absolute(candidate);
        }
        if (end == std::string::npos)
            break;
        begin = end + 1;
    }
    return {};
}

class Process {
  public:
    Process(const fs::path& executable, const std::vector<std::string>& arguments) {
#ifdef _WIN32
        SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE out_write = nullptr, err_write = nullptr, input = INVALID_HANDLE_VALUE;
        auto close = [](HANDLE& handle) {
            if (handle && handle != INVALID_HANDLE_VALUE)
                CloseHandle(handle);
            handle = nullptr;
        };
        try {
            if (!CreatePipe(&out_read_, &out_write, &attributes, 0) ||
                !CreatePipe(&err_read_, &err_write, &attributes, 0))
                throw std::runtime_error("Cannot create exporter pipes");
            SetHandleInformation(out_read_, HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(err_read_, HANDLE_FLAG_INHERIT, 0);
            input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                &attributes, OPEN_EXISTING, 0, nullptr);
            STARTUPINFOW startup{};
            startup.cb = sizeof(startup);
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = input;
            startup.hStdOutput = out_write;
            startup.hStdError = err_write;
            std::wstring command = quote(executable.wstring());
            for (const auto& argument : arguments)
                command += L" " + quote(from_utf8(argument).wstring());
            PROCESS_INFORMATION info{};
            if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                                CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP,
                                nullptr, nullptr, &startup, &info)) {
                throw std::runtime_error("Cannot start exporter process (Windows error " +
                                         std::to_string(GetLastError()) + ")");
            }
            process_ = info.hProcess;
            thread_ = info.hThread;
            group_ = CreateJobObjectW(nullptr, nullptr);
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!group_ ||
                !SetInformationJobObject(group_, JobObjectExtendedLimitInformation, &limits,
                                         sizeof(limits)) ||
                !AssignProcessToJobObject(group_, process_))
                throw std::runtime_error("Cannot create exporter process group");
            ResumeThread(thread_);
            close(thread_);
            close(out_write);
            close(err_write);
            close(input);
        } catch (...) {
            close(out_write);
            close(err_write);
            close(input);
            terminate();
            release();
            throw;
        }
#else
        int output[2]{-1, -1}, errors[2]{-1, -1};
        if (pipe2(output, O_CLOEXEC) != 0 || pipe2(errors, O_CLOEXEC) != 0) {
            for (const int fd : {output[0], output[1], errors[0], errors[1]})
                if (fd >= 0)
                    close(fd);
            throw std::runtime_error("Cannot create exporter pipes");
        }
        posix_spawn_file_actions_t actions;
        posix_spawnattr_t attributes;
        posix_spawn_file_actions_init(&actions);
        posix_spawnattr_init(&attributes);
        posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
        posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO);
        posix_spawn_file_actions_adddup2(&actions, errors[1], STDERR_FILENO);
        posix_spawn_file_actions_addclose(&actions, output[0]);
        posix_spawn_file_actions_addclose(&actions, errors[0]);
        posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP);
        posix_spawnattr_setpgroup(&attributes, 0);
        std::vector<std::string> strings{executable.string()};
        strings.insert(strings.end(), arguments.begin(), arguments.end());
        std::vector<char*> argv;
        for (auto& value : strings)
            argv.push_back(value.data());
        argv.push_back(nullptr);
        const int result =
            posix_spawn(&pid_, executable.c_str(), &actions, &attributes, argv.data(), environ);
        posix_spawn_file_actions_destroy(&actions);
        posix_spawnattr_destroy(&attributes);
        close(output[1]);
        close(errors[1]);
        if (result != 0) {
            close(output[0]);
            close(errors[0]);
            pid_ = -1;
            throw std::runtime_error("Cannot start exporter process (error " +
                                     std::to_string(result) + ")");
        }
        out_read_ = output[0];
        err_read_ = errors[0];
        fcntl(out_read_, F_SETFL, fcntl(out_read_, F_GETFL) | O_NONBLOCK);
        fcntl(err_read_, F_SETFL, fcntl(err_read_, F_GETFL) | O_NONBLOCK);
#endif
    }
    ~Process() {
        terminate();
        release();
    }
    Process(const Process&) = delete;
    Process& operator=(const Process&) = delete;
    bool running() {
        if (done_)
            return false;
#ifdef _WIN32
        if (WaitForSingleObject(process_, 0) == WAIT_TIMEOUT)
            return true;
        DWORD code = 1;
        GetExitCodeProcess(process_, &code);
        exit_code_ = static_cast<int>(code);
#else
        int status = 0;
        const auto result = waitpid(pid_, &status, WNOHANG);
        if (result == 0 || (result < 0 && errno == EINTR))
            return true;
        exit_code_ = result < 0          ? 1
                     : WIFEXITED(status) ? WEXITSTATUS(status)
                                         : 128 + WTERMSIG(status);
#endif
        done_ = true;
        return false;
    }
    int exit_code() const {
        return exit_code_;
    }
    void drain(const std::function<void(const std::string&, bool)>& line) {
        drain_one(out_read_, buffers_[0], false, line);
        drain_one(err_read_, buffers_[1], true, line);
    }
    void finish_lines(const std::function<void(const std::string&, bool)>& line) {
        drain(line);
        for (size_t i = 0; i < buffers_.size(); ++i) {
            if (!buffers_[i].empty())
                line(buffers_[i], i == 1);
            buffers_[i].clear();
        }
    }
    void terminate() {
#ifdef _WIN32
        if (process_ && !done_) {
            if (group_)
                TerminateJobObject(group_, 1);
            else
                TerminateProcess(process_, 1);
            WaitForSingleObject(process_, 5000);
            done_ = true;
        }
#else
        if (pid_ > 0 && !done_) {
            kill(-pid_, SIGKILL);
            while (waitpid(pid_, nullptr, 0) < 0 && errno == EINTR) {
            }
            done_ = true;
        }
#endif
    }

  private:
#ifdef _WIN32
    HANDLE process_ = nullptr, thread_ = nullptr, group_ = nullptr, out_read_ = nullptr,
           err_read_ = nullptr;
    static std::wstring quote(const std::wstring& value) {
        std::wstring result = L"\"";
        size_t slashes = 0;
        for (const auto character : value) {
            if (character == L'\\') {
                ++slashes;
                continue;
            }
            if (character == L'\"') {
                result.append(slashes * 2 + 1, L'\\');
                result += character;
            } else {
                result.append(slashes, L'\\');
                result += character;
            }
            slashes = 0;
        }
        result.append(slashes * 2, L'\\');
        result += L'\"';
        return result;
    }
    void release() {
        for (auto* handle : {&thread_, &process_, &group_, &out_read_, &err_read_}) {
            if (*handle)
                CloseHandle(*handle);
            *handle = nullptr;
        }
    }
    static void drain_one(HANDLE pipe, std::string& buffer, bool is_error,
                          const std::function<void(const std::string&, bool)>& line) {
#else
    pid_t pid_ = -1;
    int out_read_ = -1, err_read_ = -1;
    void release() {
        for (auto* fd : {&out_read_, &err_read_}) {
            if (*fd >= 0)
                close(*fd);
            *fd = -1;
        }
    }
    static void drain_one(int pipe, std::string& buffer, bool is_error,
                          const std::function<void(const std::string&, bool)>& line) {
#endif
        std::array<char, 4096> bytes{};
        for (;;) {
#ifdef _WIN32
            DWORD available = 0, read = 0;
            if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) || !available)
                break;
            if (!ReadFile(pipe, bytes.data(),
                          std::min<DWORD>(available, static_cast<DWORD>(bytes.size())), &read,
                          nullptr) ||
                !read)
                break;
            const auto count = static_cast<size_t>(read);
#else
            const auto read = ::read(pipe, bytes.data(), bytes.size());
            if (read <= 0)
                break;
            const auto count = static_cast<size_t>(read);
#endif
            buffer.append(bytes.data(), count);
            size_t end = 0;
            while ((end = buffer.find('\n')) != std::string::npos) {
                auto text = buffer.substr(0, end);
                if (!text.empty() && text.back() == '\r')
                    text.pop_back();
                line(text, is_error);
                buffer.erase(0, end + 1);
            }
            if (buffer.size() > 262144) {
                line(buffer.substr(0, 262144), is_error);
                buffer.clear();
            }
        }
    }
    std::array<std::string, 2> buffers_;
    bool done_ = false;
    int exit_code_ = 1;
};
void require_replay_importer(const fs::path& executable, std::stop_token stop) {
    Json capabilities;
    Process probe(executable, {"--capabilities"});
    const auto started = Clock::now();
    const auto line = [&](const std::string& text, bool is_error) {
        if (is_error) return;
        auto value = Json::parse(text, nullptr, false);
        if (value.is_object()) capabilities = std::move(value);
    };
    while (probe.running()) {
        probe.drain(line);
        if (stop.stop_requested())
            throw std::runtime_error("Replay import cancelled");
        if (Clock::now() - started > std::chrono::seconds(5))
            throw std::runtime_error("Dataset importer capability check timed out");
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    probe.finish_lines(line);
    if (stop.stop_requested())
        throw std::runtime_error("Replay import cancelled");
    if (probe.exit_code() != 0 || !capabilities.is_object() ||
        capabilities.value("schema", Json{}) != "ceres-native-export-capabilities" ||
        capabilities.value("replay_import_version", Json{}) != 1 ||
        capabilities.value("replay_task_schema", Json{}) != "ceres-replay-task" ||
        capabilities.value("replay_task_version", Json{}) != 1)
        throw std::runtime_error("Update the bundled dataset importer to replay tasks and repetitions");
}
} // namespace

struct ExportJob::Impl {
    fs::path helper, ffmpeg, cancel_path;
    mutable std::mutex mutex;
    std::mutex lifecycle;
    ExportStatus state;
    std::atomic<bool> cancelled{false};
    std::thread worker;

    fs::path resolve_helper() const {
        return helper.empty() ? ExportJob::discover_helper() : find_executable(helper, false);
    }

    void execute(Json job, fs::path job_path, fs::path executable) {
        std::string diagnostic, structured_error;
        bool completed = false;
        try {
            Json capabilities;
            Process probe(executable, {"--capabilities"});
            const auto probe_start = Clock::now();
            const auto probe_line = [&](const std::string& text, bool) {
                auto value = Json::parse(text, nullptr, false);
                if (value.is_object())
                    capabilities = std::move(value);
            };
            while (probe.running()) {
                probe.drain(probe_line);
                if (cancelled.load())
                    throw std::runtime_error("Export cancelled");
                if (Clock::now() - probe_start > std::chrono::seconds(5))
                    throw std::runtime_error("Exporter capability check timed out");
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
            probe.finish_lines(probe_line);
            const auto profile = job.at("profile").get<std::string>();
            const auto profiles = capabilities.is_object()
                                      ? capabilities.value("profiles", Json::array())
                                      : Json::array();
            if (probe.exit_code() != 0 || !capabilities.is_object() ||
                capabilities.value("schema", "") != "ceres-native-export-capabilities" ||
                capabilities.value("job_version", 0) != 1 ||
                capabilities.value("lerobot", "") != "v3.0" || !profiles.is_array() ||
                std::find(profiles.begin(), profiles.end(), profile) == profiles.end() ||
                (profile == "ceres-bridge-lerobot3-v1" &&
                 (!capabilities.value("actions", false) ||
                  capabilities.value("action_dimension", 0) != 2 ||
                  !capabilities.value("ceres_episode_shards", false))))
                throw std::runtime_error(
                    "Exporter does not support the requested LeRobot v3 profile");
            if (job.at("video").value("source_dimensions", false) &&
                !capabilities.value("source_video_dimensions", false))
                throw std::runtime_error(
                    "Update the bundled exporter to export at the recorded camera resolution");
            if (cancelled.load())
                throw std::runtime_error("Export cancelled");
            fs::create_directories(job_path.parent_path());
            std::ofstream manifest(job_path, std::ios::binary | std::ios::trunc);
            if (!manifest || !(manifest << job.dump(2) << '\n'))
                throw std::runtime_error("Cannot write export job file");
            manifest.close();
            if (!manifest)
                throw std::runtime_error("Cannot finish export job file");
            Process process(executable, {"--job", utf8(job_path)});
            double episode_index = 0, episode_count = 1;
            const auto line = [&](const std::string& text, bool is_error) {
                const auto value = Json::parse(text, nullptr, false);
                if (!value.is_object() || value.value("schema", "") != "ceres-export-progress") {
                    if (is_error && !text.empty()) {
                        diagnostic += text + "\n";
                        if (diagnostic.size() > 16384)
                            diagnostic.erase(0, diagnostic.size() - 16384);
                    }
                    return;
                }
                const auto stage = value.value("stage", "");
                const auto done = value.value("completed", 0.0), total = value.value("total", 0.0);
                std::lock_guard lock(mutex);
                if (stage == "exporting") {
                    episode_index = done;
                    episode_count = std::max(1.0, total);
                    state.progress = static_cast<float>(0.02 + 0.96 * done / episode_count);
                    state.message = "Exporting episode " +
                                    std::to_string(static_cast<int>(done + 1)) + " of " +
                                    std::to_string(static_cast<int>(total));
                } else if (stage == "frames") {
                    state.progress = static_cast<float>(
                        0.02 +
                        0.96 * (episode_index + (total > 0 ? done / total : 0)) / episode_count);
                } else if (stage == "complete") {
                    completed = true;
                    state.progress = 1.0f;
                    state.message = "Export complete";
                } else if (stage == "error") {
                    structured_error = value.value("message", "Export failed");
                } else if (stage == "indexing")
                    state.message = "Reading session";
                state.progress = std::clamp(state.progress, 0.0f, 1.0f);
            };
            auto cancellation_started = Clock::time_point{};
            while (process.running()) {
                process.drain(line);
                if (cancelled.load()) {
                    if (cancellation_started == Clock::time_point{}) {
                        cancellation_started = Clock::now();
                        std::ofstream signal(cancel_path, std::ios::binary);
                        signal << "cancel\n";
                    }
                    if (Clock::now() - cancellation_started > std::chrono::seconds(5)) {
                        process.terminate();
                        break;
                    }
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
            process.finish_lines(line);
            if (process.exit_code() != 0 || !completed) {
                if (cancelled.load())
                    throw std::runtime_error("Export cancelled");
                throw std::runtime_error(!structured_error.empty() ? structured_error
                                         : !diagnostic.empty()
                                             ? diagnostic
                                             : "Exporter exited without completing the dataset");
            }
            {
                std::lock_guard lock(mutex);
                if (!fs::is_directory(state.output))
                    throw std::runtime_error(
                        "Exporter completed without producing its output directory");
            }
        } catch (const std::exception& error) {
            std::lock_guard lock(mutex);
            if (cancelled.load() && !completed) {
                state.error.clear();
                state.message = "Export cancelled";
            } else {
                state.error = error.what();
                state.message = "Export failed";
            }
        }
        std::error_code ignored;
        std::lock_guard lock(mutex);
        fs::remove(cancel_path, ignored);
        state.running = false;
    }
};

ExportJob::ExportJob(fs::path helper, fs::path ffmpeg) : impl_(std::make_unique<Impl>()) {
    impl_->helper = std::move(helper);
    impl_->ffmpeg = std::move(ffmpeg);
}
ExportJob::~ExportJob() {
    cancel();
    if (impl_->worker.joinable())
        impl_->worker.join();
}
fs::path ExportJob::discover_helper() {
    return find_executable("ceres-native-exporter", true);
}
fs::path ExportJob::discover_ffmpeg() {
    return find_executable("ffmpeg", true);
}
bool ExportJob::exporter_available() const noexcept {
    try {
        return !impl_->resolve_helper().empty();
    } catch (...) {
        return false;
    }
}
void import_lerobot_replay(const fs::path& dataset_directory, const fs::path& output_mcap,
                           std::stop_token stop) {
    if (stop.stop_requested())
        throw std::runtime_error("Replay import cancelled");
    const auto helper = ExportJob::discover_helper();
    const auto ffmpeg = ExportJob::discover_ffmpeg();
    if (helper.empty())
        throw std::runtime_error("Native dataset importer executable was not found");
    if (ffmpeg.empty())
        throw std::runtime_error("FFmpeg executable was not found");
    const auto output = fs::absolute(output_mcap);
    if (fs::exists(output))
        throw std::runtime_error("Replay destination already exists");
    require_replay_importer(helper, stop);
    fs::create_directories(output.parent_path());
    static std::atomic<uint64_t> import_sequence{0};
    const auto stem = ".ceres-replay-job-" + std::to_string(monotonic_us()) + "-" +
                      std::to_string(import_sequence.fetch_add(1));
    const auto manifest_path = output.parent_path() / (stem + ".json");
    const auto cancel_path = output.parent_path() / (stem + ".cancel");
    struct TemporaryFiles {
        fs::path manifest, cancellation;
        ~TemporaryFiles() {
            std::error_code ignored;
            fs::remove(manifest, ignored);
            fs::remove(cancellation, ignored);
        }
    } cleanup{manifest_path, cancel_path};
    const Json job{{"schema", "ceres-lerobot-replay"},
                   {"version", 1},
                   {"dataset", utf8(fs::absolute(dataset_directory))},
                   {"output", utf8(output)},
                   {"ffmpeg", utf8(ffmpeg)},
                   {"cancel_file", utf8(cancel_path)}};
    {
        std::ofstream manifest(manifest_path, std::ios::binary | std::ios::trunc);
        if (!manifest || !(manifest << job.dump(2) << '\n'))
            throw std::runtime_error("Cannot write replay import job");
        manifest.close();
        if (!manifest)
            throw std::runtime_error("Cannot finish replay import job");
    }
    Process process(helper, {"--import-job", utf8(manifest_path)});
    std::string diagnostic, error;
    bool completed = false;
    const auto line = [&](const std::string& text, bool is_error) {
        const auto value = Json::parse(text, nullptr, false);
        if (value.is_object() && value.value("schema", "") == "ceres-export-progress") {
            if (value.value("stage", "") == "complete")
                completed = true;
            else if (value.value("stage", "") == "error")
                error = value.value("message", "Replay import failed");
        } else if (is_error && !text.empty()) {
            diagnostic += text + '\n';
            if (diagnostic.size() > 16384)
                diagnostic.erase(0, diagnostic.size() - 16384);
        }
    };
    auto cancellation_started = Clock::time_point{};
    while (process.running()) {
        process.drain(line);
        if (stop.stop_requested()) {
            if (cancellation_started == Clock::time_point{}) {
                cancellation_started = Clock::now();
                std::ofstream signal(cancel_path, std::ios::binary);
                signal << "cancel\n";
            }
            if (Clock::now() - cancellation_started > std::chrono::seconds(5)) {
                process.terminate();
                break;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    process.finish_lines(line);
    if (stop.stop_requested() || process.exit_code() != 0 || !completed ||
        !fs::is_regular_file(output)) {
        std::error_code ignored;
        fs::remove(output, ignored);
        if (stop.stop_requested())
            throw std::runtime_error("Replay import cancelled");
        throw std::runtime_error(!error.empty() ? error
                                 : !diagnostic.empty() ? diagnostic
                                                      : "Dataset importer did not complete replay");
    }
}
bool ExportJob::start(Json job, const fs::path& requested_path) {
    std::lock_guard lifecycle(impl_->lifecycle);
    {
        std::lock_guard lock(impl_->mutex);
        if (impl_->state.running)
            return false;
    }
    if (impl_->worker.joinable())
        impl_->worker.join();
    try {
        const auto job_path = fs::absolute(requested_path);
        if (job_path.filename().empty() || !job.is_object())
            throw std::runtime_error("Invalid export job path or manifest");
        const auto helper = impl_->resolve_helper();
        if (helper.empty())
            throw std::runtime_error("Native exporter executable was not found");
        auto ffmpeg = fs::path{};
        if (!impl_->ffmpeg.empty())
            ffmpeg = find_executable(impl_->ffmpeg, false);
        else if (job.contains("ffmpeg") && job["ffmpeg"].is_string() &&
                 !job["ffmpeg"].get<std::string>().empty())
            ffmpeg = find_executable(from_utf8(job["ffmpeg"].get<std::string>()), true);
        else
            ffmpeg = discover_ffmpeg();
        if (ffmpeg.empty())
            throw std::runtime_error("FFmpeg executable was not found");
        job["ffmpeg"] = utf8(ffmpeg);
        if (!job.contains("schema"))
            job["schema"] = "ceres-native-export";
        if (!job.contains("version"))
            job["version"] = 1;
        if (!job.contains("profile"))
            job["profile"] = "ceres-bridge-lerobot3-v1";
        if (!job.contains("video"))
            job["video"] = Json::object();
        if (!job["video"].contains("stream"))
            job["video"]["stream"] = "passthrough";
        static std::atomic<uint64_t> cancellation_sequence{0};
#ifdef _WIN32
        const auto pid = GetCurrentProcessId();
#else
        const auto pid = getpid();
#endif
        const auto cancel_path =
            job_path.parent_path() /
            (".ceres-export-cancel-" + std::to_string(pid) + "-" + std::to_string(monotonic_us()) +
             "-" + std::to_string(cancellation_sequence.fetch_add(1)) + ".flag");
        job["cancel_file"] = utf8(cancel_path);
        auto output = from_utf8(job.at("output").get<std::string>());
        if (output.is_relative())
            output = job_path.parent_path() / output;
        {
            std::lock_guard lock(impl_->mutex);
            impl_->cancel_path = cancel_path;
            impl_->cancelled.store(false);
            impl_->state = {true, 0.0f, "", "Preparing export", output};
        }
        impl_->worker = std::thread([this, job = std::move(job), job_path, helper]() mutable {
            impl_->execute(std::move(job), job_path, helper);
        });
        return true;
    } catch (const std::exception& error) {
        std::lock_guard lock(impl_->mutex);
        impl_->state = {false, 0.0f, error.what(), "Export failed", {}};
        return false;
    }
}
void ExportJob::cancel() {
    std::lock_guard lock(impl_->mutex);
    if (!impl_->state.running)
        return;
    impl_->cancelled.store(true);
    impl_->state.message = "Stopping export";
    std::ofstream signal(impl_->cancel_path, std::ios::binary);
    signal << "cancel\n";
}
ExportStatus ExportJob::status() const {
    std::lock_guard lock(impl_->mutex);
    return impl_->state;
}
} // namespace ceres
