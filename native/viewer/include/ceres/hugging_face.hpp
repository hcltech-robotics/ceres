#pragma once
#include "types.hpp"
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <stop_token>
#include <string_view>

namespace ceres {
struct HuggingFaceRecording {
    std::string repository, revision, path, sha256, git_oid;
    uint64_t bytes = 0;
    std::string episodes_sha256, episodes_git_oid;
    uint64_t episodes_bytes = 0;
};
struct HuggingFaceStatus {
    bool running = false, authenticating = false;
    int seconds_remaining = 0;
    float progress = 0;
    std::string username, message, error, user_code, verification_url, repository, revision,
        commit_url;
    std::shared_ptr<const std::vector<HuggingFaceRecording>> recordings =
        std::make_shared<const std::vector<HuggingFaceRecording>>();
};
namespace hf {
struct Request {
    std::string method = "GET", url, body;
    std::map<std::string, std::string> headers;
    std::filesystem::path upload, download;
    uint64_t offset = 0, length = 0, maximum_bytes = 16 * 1024 * 1024;
};
struct Response {
    long status = 0;
    std::string body;
    std::map<std::string, std::string> headers;
};
using Progress = std::function<void(uint64_t, uint64_t)>;
using Transport = std::function<Response(const Request&, std::stop_token, const Progress&)>;
using OpenBrowser = std::function<bool(const std::string&)>;
std::string repository_id(std::string_view organisation, std::string_view repository);
std::string repository_path(std::string_view value);
std::string url_encode(std::string_view value, bool keep_slashes = false);
std::string sha256_file(const std::filesystem::path& path, std::stop_token cancel = {});
Response request(const Request&, std::stop_token, const Progress& = {});
bool open_browser(const std::string& url);
} // namespace hf

// Authentication has separate private storage and never enters recordings, export jobs or metrics.
class HuggingFaceClient {
  public:
    explicit HuggingFaceClient(std::filesystem::path private_directory,
                              hf::Transport transport = hf::request,
                              hf::OpenBrowser browser = hf::open_browser);
    ~HuggingFaceClient();
    HuggingFaceClient(const HuggingFaceClient&) = delete;
    HuggingFaceClient& operator=(const HuggingFaceClient&) = delete;
    bool sign_in();
    bool sign_out();
    bool browse(std::string repository);
    bool download(HuggingFaceRecording recording, std::filesystem::path cache_directory);
    // A LeRobot directory accompanies its source MCAP so every uploaded capture can be replayed.
    bool upload(std::string repository, std::filesystem::path recording,
                std::filesystem::path lerobot_directory = {}, std::string prefix = {},
                bool create_private = true);
    void cancel();
    HuggingFaceStatus status() const;
    std::filesystem::path take_download();

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace ceres
