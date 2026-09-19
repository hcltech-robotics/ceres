#include "ceres/hugging_face.hpp"
#include <curl/curl.h>
#include <mbedtls/base64.h>
#include <mbedtls/sha1.h>
#include <mbedtls/sha256.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <fstream>
#include <mutex>
#include <regex>
#include <set>
#include <thread>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wincrypt.h>
#else
#include <fcntl.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif

namespace ceres {
namespace {
using namespace std::chrono_literals;
constexpr const char* origin = "https://huggingface.co";
constexpr const char* client_id = "https://ceres.cam/.well-known/oauth-cimd";
constexpr const char* scopes = "openid profile read-repos write-repos contribute-repos read-memberships";
constexpr uint64_t maximum_recording = uint64_t{1} << 40;
void require(bool valid, const char* message) {
    if (!valid)
        throw std::runtime_error(message);
}
void cancelled(std::stop_token stop) {
    require(!stop.stop_requested(), "Hugging Face operation cancelled");
}
int64_t epoch_seconds() {
    return std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}
std::string hex(const unsigned char* bytes, size_t size) {
    constexpr char digits[] = "0123456789abcdef";
    std::string result(size * 2, '0');
    for (size_t i = 0; i < size; ++i) {
        result[i * 2] = digits[bytes[i] >> 4];
        result[i * 2 + 1] = digits[bytes[i] & 15];
    }
    return result;
}
bool hash_string(const std::string& value, size_t size) {
    return value.size() == size && std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}
bool file_metadata(uint64_t bytes, const std::string& sha, const std::string& git, uint64_t maximum) {
    return bytes > 0 && bytes <= maximum && (sha.empty() ? hash_string(git, 40) : hash_string(sha, 64));
}
std::string base64(std::string_view bytes) {
    if (bytes.empty())
        return {};
    std::string output((bytes.size() + 2) / 3 * 4 + 1, '\0');
    size_t written = 0;
    require(mbedtls_base64_encode(reinterpret_cast<unsigned char*>(output.data()), output.size(),
                                 &written, reinterpret_cast<const unsigned char*>(bytes.data()),
                                 bytes.size()) == 0, "Cannot encode Hugging Face upload");
    output.resize(written);
    return output;
}
Json parse_json(const std::string& body) {
    auto result = Json::parse(body, nullptr, false);
    require(!result.is_discarded(), "Hugging Face returned invalid JSON");
    return result;
}
std::string form(const std::map<std::string, std::string>& fields) {
    std::string body;
    for (const auto& [key, value] : fields) {
        if (!body.empty())
            body += '&';
        body += hf::url_encode(key) + '=' + hf::url_encode(value);
    }
    return body;
}
std::string trim(std::string text) {
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back())))
        text.pop_back();
    const auto begin = text.find_first_not_of(" \t\r\n");
    return begin == std::string::npos ? std::string{} : text.substr(begin);
}
std::string lower(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) {
        return char(std::tolower(c));
    });
    return text;
}
std::map<std::string, std::string> action_headers(const Json& value) {
    require(value.is_object(), "Hugging Face returned invalid upload headers");
    std::map<std::string, std::string> result;
    for (const auto& [name, entry] : value.items()) {
        require(!name.empty() && entry.is_string(), "Hugging Face returned invalid upload headers");
        const auto text = entry.get<std::string>();
        require(name.find_first_of("\r\n:") == name.npos && text.find_first_of("\r\n") == text.npos,
                "Hugging Face returned invalid upload headers");
        result[lower(name)] = text;
    }
    return result;
}
void successful(const hf::Response& response) {
    if (response.status == 401 || response.status == 403)
        throw std::runtime_error("Hugging Face access was denied. Sign in and grant access to this organisation");
    if (response.status == 404)
        throw std::runtime_error("Hugging Face repository or recording was not found");
    if (response.status == 409)
        throw std::runtime_error("The repository changed during upload. Refresh it and try again");
    if (response.status < 200 || response.status >= 300)
        throw std::runtime_error("Hugging Face returned HTTP " + std::to_string(response.status));
}
std::string read_file(const std::filesystem::path& file, uint64_t limit) {
    require(std::filesystem::is_regular_file(file) && std::filesystem::file_size(file) <= limit,
            "Hugging Face local file is missing or too large");
    std::ifstream input(file, std::ios::binary);
    require(bool(input), "Cannot read Hugging Face local file");
    std::string result((std::istreambuf_iterator<char>(input)), {});
    require(!input.bad(), "Cannot read Hugging Face local file");
    return result;
}
std::string file_hash(const std::filesystem::path& path, bool git_blob, std::stop_token stop) {
    std::ifstream input(path, std::ios::binary);
    require(bool(input), "Cannot read the recording for verification");
    mbedtls_sha256_context sha256;
    mbedtls_sha1_context sha1;
    mbedtls_sha256_init(&sha256);
    mbedtls_sha1_init(&sha1);
    struct Free {
        mbedtls_sha256_context* a;
        mbedtls_sha1_context* b;
        ~Free() { mbedtls_sha256_free(a); mbedtls_sha1_free(b); }
    } free{&sha256, &sha1};
    require((git_blob ? mbedtls_sha1_starts(&sha1) : mbedtls_sha256_starts(&sha256, 0)) == 0,
            "Cannot initialise recording verification");
    if (git_blob) {
        auto header = "blob " + std::to_string(std::filesystem::file_size(path));
        header.push_back('\0');
        require(mbedtls_sha1_update(&sha1, reinterpret_cast<const unsigned char*>(header.data()),
                                   header.size()) == 0, "Cannot verify the recording");
    }
    std::array<unsigned char, 256 * 1024> buffer{};
    while (input) {
        cancelled(stop);
        input.read(reinterpret_cast<char*>(buffer.data()), buffer.size());
        const auto size = static_cast<size_t>(input.gcount());
        require((git_blob ? mbedtls_sha1_update(&sha1, buffer.data(), size)
                          : mbedtls_sha256_update(&sha256, buffer.data(), size)) == 0,
                "Cannot verify the recording");
    }
    require(!input.bad(), "Cannot read the recording for verification");
    unsigned char digest[32]{};
    require((git_blob ? mbedtls_sha1_finish(&sha1, digest)
                      : mbedtls_sha256_finish(&sha256, digest)) == 0,
            "Cannot finish recording verification");
    return hex(digest, git_blob ? 20 : 32);
}
void save_credential(const std::filesystem::path& directory, const Json& credential) {
    std::filesystem::create_directories(directory);
    const auto file = directory / "hugging-face.credential";
    std::string bytes = credential.dump();
#ifdef _WIN32
    DATA_BLOB input{static_cast<DWORD>(bytes.size()), reinterpret_cast<BYTE*>(bytes.data())}, output{};
    require(CryptProtectData(&input, L"Ceres Hugging Face", nullptr, nullptr, nullptr,
                             CRYPTPROTECT_UI_FORBIDDEN, &output) != 0,
            "Cannot protect the Hugging Face credential");
    bytes.assign(reinterpret_cast<char*>(output.pbData), output.cbData);
    LocalFree(output.pbData);
    std::ofstream stream(file, std::ios::binary | std::ios::trunc);
    stream.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    stream.close();
    require(bool(stream), "Cannot save the Hugging Face credential");
#else
    require(chmod(directory.c_str(), S_IRWXU) == 0, "Cannot secure the Hugging Face credential directory");
    const int fd = open(file.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, S_IRUSR | S_IWUSR);
    require(fd >= 0, "Cannot save the Hugging Face credential");
    size_t offset = 0;
    while (offset < bytes.size()) {
        const auto written = write(fd, bytes.data() + offset, bytes.size() - offset);
        if (written <= 0) { close(fd); throw std::runtime_error("Cannot save the Hugging Face credential"); }
        offset += static_cast<size_t>(written);
    }
    const bool protected_file = fchmod(fd, S_IRUSR | S_IWUSR) == 0;
    close(fd);
    require(protected_file, "Cannot secure the Hugging Face credential");
#endif
}
Json load_credential(const std::filesystem::path& directory) {
    const auto file = directory / "hugging-face.credential";
    if (!std::filesystem::exists(file))
        return Json::object();
#ifndef _WIN32
    struct stat info{};
    require(lstat(file.c_str(), &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == getuid() &&
                (info.st_mode & (S_IRWXG | S_IRWXO)) == 0,
            "Hugging Face credential permissions must be private");
#endif
    auto bytes = read_file(file, 128 * 1024);
#ifdef _WIN32
    DATA_BLOB input{static_cast<DWORD>(bytes.size()), reinterpret_cast<BYTE*>(bytes.data())}, output{};
    require(CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
                               CRYPTPROTECT_UI_FORBIDDEN, &output) != 0,
            "Sign in to Hugging Face again on this computer");
    bytes.assign(reinterpret_cast<char*>(output.pbData), output.cbData);
    LocalFree(output.pbData);
#endif
    auto result = parse_json(bytes);
    require(result.is_object(), "Hugging Face credential is invalid. Sign in again");
    return result;
}
} // namespace

namespace hf {
std::string repository_id(std::string_view organisation, std::string_view repository) {
    const std::regex part("[A-Za-z0-9][A-Za-z0-9_.-]{0,95}");
    const auto valid = [&](std::string_view value) {
        return std::regex_match(value.begin(), value.end(), part) && value.find("..") == value.npos &&
               value.find("--") == value.npos && value.back() != '.' && value.back() != '-';
    };
    require(valid(organisation) && valid(repository), "Enter an organisation or username and a repository name");
    return std::string(organisation) + '/' + std::string(repository);
}
std::string repository_path(std::string_view value) {
    require(!value.empty() && value.size() <= 1024 && value.front() != '/' && value.back() != '/',
            "Repository path must be a relative file or folder path");
    size_t first = 0;
    while (first < value.size()) {
        const auto last = value.find('/', first);
        const auto part = value.substr(first, last == value.npos ? value.size() - first : last - first);
        require(!part.empty() && part != "." && part != ".." && lower(std::string(part)) != ".git" &&
                    part.back() != '.' && part.back() != ' ', "Repository path contains an invalid component");
        const auto stem = lower(std::string(part.substr(0, part.find('.'))));
        const bool device = stem == "con" || stem == "prn" || stem == "aux" || stem == "nul" ||
            (stem.size() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) &&
             stem.back() >= '1' && stem.back() <= '9');
        require(!device, "Repository path contains a reserved filename");
        for (const unsigned char c : part)
            require(c >= 32 && c != 127 && c != '\\' && c != ':' && c != '?' && c != '*' &&
                        c != '"' && c != '<' && c != '>' && c != '|', "Repository path contains an invalid character");
        if (last == value.npos)
            break;
        first = last + 1;
    }
    return std::string(value);
}
std::string url_encode(std::string_view value, bool keep_slashes) {
    constexpr char digits[] = "0123456789ABCDEF";
    std::string result;
    for (unsigned char c : value) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~' || (keep_slashes && c == '/'))
            result += char(c);
        else { result += '%'; result += digits[c >> 4]; result += digits[c & 15]; }
    }
    return result;
}
std::string sha256_file(const std::filesystem::path& path, std::stop_token cancel) {
    return file_hash(path, false, cancel);
}

Response request(const Request& request, std::stop_token stop, const Progress& progress) {
    static const int initialised = [] { return curl_global_init(CURL_GLOBAL_DEFAULT); }();
    require(initialised == CURLE_OK, "Cannot initialise Hugging Face networking");
    require(request.url.starts_with("https://"), "Hugging Face requires a secure connection");
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), curl_easy_cleanup);
    require(bool(curl), "Cannot initialise Hugging Face networking");
    struct Transfer {
        Response response;
        std::stop_token stop;
        Progress progress;
        std::ifstream input;
        std::ofstream output;
        uint64_t received = 0, remaining = 0, maximum = 0;
        bool failed = false;
    } transfer{{}, stop, progress, {}, {}, 0, request.length, request.maximum_bytes};
    if (!request.upload.empty()) {
        transfer.input.open(request.upload, std::ios::binary);
        transfer.input.seekg(static_cast<std::streamoff>(request.offset));
        require(bool(transfer.input), "Cannot read the Hugging Face upload");
    }
    if (!request.download.empty()) {
        transfer.output.open(request.download, std::ios::binary | std::ios::trunc);
        require(bool(transfer.output), "Cannot save the Hugging Face recording");
    }
    curl_slist* raw_headers = nullptr;
    for (const auto& [name, value] : request.headers) {
        require(name.find_first_of("\r\n") == name.npos && value.find_first_of("\r\n") == value.npos,
                "Invalid Hugging Face request header");
        raw_headers = curl_slist_append(raw_headers, (name + ": " + value).c_str());
    }
    std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> headers(raw_headers, curl_slist_free_all);
    const auto option = [&](CURLoption key, auto value) {
        require(curl_easy_setopt(curl.get(), key, value) == CURLE_OK, "Cannot configure Hugging Face networking");
    };
    option(CURLOPT_URL, request.url.c_str());
    option(CURLOPT_PROTOCOLS_STR, "https");
    option(CURLOPT_REDIR_PROTOCOLS_STR, "https");
    // Only file GETs follow signed CDN redirects. OAuth bodies and upload action headers stay at their origin.
    option(CURLOPT_FOLLOWLOCATION, request.method == "GET" && !request.download.empty() ? 1L : 0L);
    option(CURLOPT_MAXREDIRS, 8L);
    option(CURLOPT_UNRESTRICTED_AUTH, 0L);
    option(CURLOPT_CONNECTTIMEOUT, 10L);
    option(CURLOPT_TIMEOUT, request.upload.empty() && request.download.empty() ? 30L : 0L);
    option(CURLOPT_LOW_SPEED_LIMIT, 1L);
    option(CURLOPT_LOW_SPEED_TIME, 60L);
    option(CURLOPT_NOSIGNAL, 1L);
    option(CURLOPT_SSL_VERIFYPEER, 1L);
    option(CURLOPT_SSL_VERIFYHOST, 2L);
    option(CURLOPT_HTTPHEADER, headers.get());
    option(CURLOPT_USERAGENT, "CeresViewer/1");
    option(CURLOPT_ACCEPT_ENCODING, "identity");
    option(CURLOPT_WRITEFUNCTION, +[](char* data, size_t size, size_t count, void* context) noexcept -> size_t {
        auto& t = *static_cast<Transfer*>(context);
        if (t.stop.stop_requested() || (size && count > SIZE_MAX / size)) return 0;
        const auto bytes = size * count;
        if (bytes > t.maximum - t.received) { t.failed = true; return 0; }
        try {
            if (t.output.is_open()) t.output.write(data, static_cast<std::streamsize>(bytes));
            else t.response.body.append(data, bytes);
            t.received += bytes;
            if (t.output.is_open() && !t.output) { t.failed = true; return 0; }
            return bytes;
        } catch (...) { t.failed = true; return 0; }
    });
    option(CURLOPT_WRITEDATA, &transfer);
    option(CURLOPT_HEADERFUNCTION, +[](char* data, size_t size, size_t count, void* context) noexcept -> size_t {
        auto& t = *static_cast<Transfer*>(context);
        const auto bytes = size * count;
        try {
            std::string line(data, bytes);
            if (line.starts_with("HTTP/")) t.response.headers.clear();
            const auto colon = line.find(':');
            if (colon != line.npos) t.response.headers[lower(trim(line.substr(0, colon)))] = trim(line.substr(colon + 1));
            return bytes;
        } catch (...) { return 0; }
    });
    option(CURLOPT_HEADERDATA, &transfer);
    option(CURLOPT_NOPROGRESS, 0L);
    option(CURLOPT_XFERINFOFUNCTION, +[](void* context, curl_off_t total, curl_off_t current,
                                       curl_off_t upload_total, curl_off_t uploaded) noexcept -> int {
        auto& t = *static_cast<Transfer*>(context);
        if (t.stop.stop_requested()) return 1;
        try { if (t.progress) t.progress(static_cast<uint64_t>(current + uploaded),
                                         static_cast<uint64_t>(total + upload_total)); }
        catch (...) { return 1; }
        return 0;
    });
    option(CURLOPT_XFERINFODATA, &transfer);
    if (!request.upload.empty()) {
        option(CURLOPT_UPLOAD, 1L);
        option(CURLOPT_INFILESIZE_LARGE, static_cast<curl_off_t>(request.length));
        option(CURLOPT_READFUNCTION, +[](char* bytes, size_t size, size_t count, void* context) noexcept -> size_t {
            auto& t = *static_cast<Transfer*>(context);
            if (t.stop.stop_requested()) return CURL_READFUNC_ABORT;
            const auto length = std::min<uint64_t>(size * count, t.remaining);
            t.input.read(bytes, static_cast<std::streamsize>(length));
            const auto read = static_cast<size_t>(t.input.gcount());
            t.remaining -= read;
            return t.input.bad() || (!read && length) ? CURL_READFUNC_ABORT : read;
        });
        option(CURLOPT_READDATA, &transfer);
    } else if (request.method != "GET") {
        option(CURLOPT_CUSTOMREQUEST, request.method.c_str());
        option(CURLOPT_POSTFIELDS, request.body.data());
        option(CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(request.body.size()));
    }
    cancelled(stop);
    const auto result = curl_easy_perform(curl.get());
    cancelled(stop);
    if (transfer.output.is_open()) {
        transfer.output.close();
        require(bool(transfer.output), "Cannot save the downloaded recording");
    }
    require(!transfer.failed, "Hugging Face response exceeded its size limit or could not be saved");
    require(result == CURLE_OK, "Hugging Face transfer failed. Check the connection and try again");
    curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &transfer.response.status);
    return transfer.response;
}
bool open_browser(const std::string& url) {
    if (!(url.starts_with("https://huggingface.co/") || url.starts_with("https://hf.co/")))
        return false;
#ifdef _WIN32
    const auto wide = std::filesystem::u8path(url).wstring();
    return reinterpret_cast<intptr_t>(ShellExecuteW(nullptr, L"open", wide.c_str(), nullptr, nullptr,
                                                    SW_SHOWNORMAL)) > 32;
#else
    pid_t child = 0;
    std::array<char*, 3> arguments{const_cast<char*>("xdg-open"), const_cast<char*>(url.c_str()), nullptr};
    if (posix_spawnp(&child, "xdg-open", nullptr, nullptr, arguments.data(), environ) != 0)
        return false;
    std::thread([child] { int status = 0; while (waitpid(child, &status, 0) < 0 && errno == EINTR) {} }).detach();
    return true;
#endif
}
} // namespace hf

struct HuggingFaceClient::Impl {
    std::filesystem::path directory, completed_download;
    hf::Transport transport;
    hf::OpenBrowser browser;
    mutable std::mutex mutex;
    HuggingFaceStatus state;
    Json credential = Json::object();
    int64_t authentication_expires_at = 0;
    std::jthread worker;

    Impl(std::filesystem::path directory, hf::Transport transport, hf::OpenBrowser browser)
        : directory(std::move(directory)), transport(std::move(transport)), browser(std::move(browser)) {
        try {
            credential = load_credential(this->directory);
            state.username = credential.value("username", std::string{});
        } catch (...) { state.error = "Sign in to Hugging Face again"; }
    }
    ~Impl() { worker.request_stop(); }
    template<class Function> bool start(const char* message, Function action, bool authenticating = false) {
        { std::lock_guard lock(mutex); if (state.running) return false; }
        if (worker.joinable()) worker.join();
        {
            std::lock_guard lock(mutex);
            state.running = true; state.authenticating = authenticating;
            state.progress = 0; state.message = message; state.error.clear();
            state.user_code.clear(); state.verification_url.clear(); state.commit_url.clear();
        }
        worker = std::jthread([this, action = std::move(action)](std::stop_token stop) {
            try { action(stop); }
            catch (const std::exception& error) {
                std::lock_guard lock(mutex);
                state.error = stop.stop_requested() ? std::string{} : error.what();
                state.message = stop.stop_requested() ? "Cancelled" : std::string{};
            }
            std::lock_guard lock(mutex);
            state.running = state.authenticating = false;
            authentication_expires_at = 0;
            state.user_code.clear(); state.verification_url.clear();
        });
        return true;
    }
    void message(std::string value, float progress = 0) {
        std::lock_guard lock(mutex); state.message = std::move(value); state.progress = progress;
    }
    hf::Response call(std::string method, std::string path, std::string body,
                      const std::string& token, std::stop_token stop, const char* type = "application/json") {
        hf::Request request;
        request.method = std::move(method); request.url = std::string(origin) + path;
        request.body = std::move(body);
        if (!token.empty()) request.headers["Authorization"] = "Bearer " + token;
        if (request.method != "GET") request.headers["Content-Type"] = type;
        return transport(request, stop, {});
    }
    Json api(std::string method, std::string path, Json body, const std::string& token, std::stop_token stop) {
        const auto response = call(std::move(method), std::move(path), body.is_null() ? "" : body.dump(), token, stop);
        successful(response); return parse_json(response.body);
    }
    void accept_token(Json token, std::stop_token stop) {
        const auto access = token.value("access_token", std::string{});
        require(access.size() >= 16 && access.find_first_of("\r\n") == access.npos,
                "Hugging Face did not issue an access token");
        const auto profile = api("GET", "/oauth/userinfo", nullptr, access, stop);
        const auto username = profile.value("preferred_username", profile.value("name", std::string{}));
        require(!username.empty(), "Hugging Face did not return an account name");
        token["username"] = username;
        token["expires_at"] = epoch_seconds() + token.value("expires_in", int64_t{28800});
        save_credential(directory, token);
        credential = std::move(token);
        std::lock_guard lock(mutex); state.username = username;
    }
    std::string token(std::stop_token stop, bool required = false) {
        auto access = credential.value("access_token", std::string{});
        if (!access.empty() && credential.value("expires_at", int64_t{0}) <= epoch_seconds() + 60) {
            const auto refresh = credential.value("refresh_token", std::string{});
            require(!refresh.empty(), "Hugging Face sign-in expired. Sign in again");
            auto response = call("POST", "/oauth/token", form({{"grant_type", "refresh_token"},
                                {"client_id", client_id}, {"refresh_token", refresh}}), "", stop,
                                "application/x-www-form-urlencoded");
            successful(response);
            auto next = parse_json(response.body);
            if (!next.contains("refresh_token")) next["refresh_token"] = refresh;
            accept_token(std::move(next), stop);
            access = credential.value("access_token", std::string{});
        }
        require(!required || !access.empty(), "Sign in to Hugging Face before uploading");
        return access;
    }
    Json repository(const std::string& repo, const std::string& token, std::stop_token stop) {
        const auto slash = repo.find('/');
        require(slash != repo.npos && hf::repository_id(repo.substr(0, slash), repo.substr(slash + 1)) == repo,
                "Invalid Hugging Face repository");
        return api("GET", "/api/datasets/" + repo, nullptr, token, stop);
    }
    std::vector<Json> tree(const std::string& repo, const std::string& revision,
                           const std::string& token, std::stop_token stop) {
        require(hash_string(revision, 40), "Hugging Face did not return an immutable repository revision");
        const auto prefix = std::string(origin) + "/api/datasets/" + repo + "/tree/" + revision;
        std::string next = prefix + "?recursive=true&expand=false";
        std::vector<Json> entries;
        std::set<std::string> visited;
        while (!next.empty()) {
            cancelled(stop);
            require(next.starts_with(prefix + '?') && visited.insert(next).second && visited.size() <= 1000,
                    "Hugging Face returned invalid repository pagination");
            hf::Request request; request.url = next;
            const auto fresh = this->token(stop);
            if (!fresh.empty()) request.headers["Authorization"] = "Bearer " + fresh;
            const auto response = transport(request, stop, {}); successful(response);
            auto page = parse_json(response.body);
            require(page.is_array() && entries.size() + page.size() <= 200000,
                    "Hugging Face repository listing is too large or invalid");
            for (auto& entry : page) entries.push_back(std::move(entry));
            next.clear();
            if (const auto found = response.headers.find("link"); found != response.headers.end()) {
                const std::regex link("<([^>]+)>;\\s*rel=\"next\"");
                std::smatch match;
                if (std::regex_search(found->second, match, link)) next = match[1];
            }
        }
        return entries;
    }
};

HuggingFaceClient::HuggingFaceClient(std::filesystem::path directory, hf::Transport transport,
                                   hf::OpenBrowser browser)
    : impl_(std::make_unique<Impl>(std::move(directory), std::move(transport), std::move(browser))) {}
HuggingFaceClient::~HuggingFaceClient() = default;
void HuggingFaceClient::cancel() { impl_->worker.request_stop(); }
HuggingFaceStatus HuggingFaceClient::status() const {
    std::lock_guard lock(impl_->mutex);
    auto result = impl_->state;
    result.seconds_remaining = static_cast<int>(std::max<int64_t>(0, impl_->authentication_expires_at - epoch_seconds()));
    return result;
}
std::filesystem::path HuggingFaceClient::take_download() {
    std::lock_guard lock(impl_->mutex); auto result = std::move(impl_->completed_download);
    impl_->completed_download.clear(); return result;
}
bool HuggingFaceClient::sign_out() {
    return impl_->start("Signing out", [this](std::stop_token) {
        std::filesystem::remove(impl_->directory / "hugging-face.credential");
        impl_->credential = Json::object();
        std::lock_guard lock(impl_->mutex);
        impl_->state.username.clear(); impl_->state.message = "Signed out";
        impl_->state.recordings = std::make_shared<const std::vector<HuggingFaceRecording>>();
    });
}
bool HuggingFaceClient::sign_in() {
    return impl_->start("Opening Hugging Face sign-in", [this](std::stop_token stop) {
        auto response = impl_->call("POST", "/oauth/device", form({{"client_id", client_id}, {"scope", scopes}}),
                                    "", stop, "application/x-www-form-urlencoded");
        successful(response);
        const auto device = parse_json(response.body);
        const auto code = device.value("device_code", std::string{});
        const auto user_code = device.value("user_code", std::string{});
        const auto url = device.value("verification_uri_complete", device.value("verification_uri", std::string{}));
        const auto expires_in = std::clamp(device.value("expires_in", 300), 1, 900);
        require(!code.empty() && !user_code.empty() && user_code.size() <= 32 &&
                    (url.starts_with("https://huggingface.co/") || url.starts_with("https://hf.co/")),
                "Hugging Face returned invalid sign-in instructions");
        {
            std::lock_guard lock(impl_->mutex);
            impl_->state.user_code = user_code; impl_->state.verification_url = url;
            impl_->authentication_expires_at = epoch_seconds() + expires_in;
        }
        impl_->message(impl_->browser(url) ? "Enter this code in the browser to sign in" :
                                             "Open Hugging Face and enter this code to sign in");
        auto interval = std::chrono::seconds(std::clamp(device.value("interval", 5), 1, 30));
        const auto deadline = std::chrono::steady_clock::now() +
                              std::chrono::seconds(expires_in);
        while (std::chrono::steady_clock::now() < deadline) {
            const auto next = std::chrono::steady_clock::now() + interval;
            while (std::chrono::steady_clock::now() < next && std::chrono::steady_clock::now() < deadline) {
                cancelled(stop); std::this_thread::sleep_for(50ms);
            }
            if (std::chrono::steady_clock::now() >= deadline) break;
            response = impl_->call("POST", "/oauth/token", form({{"client_id", client_id},
                        {"grant_type", "urn:ietf:params:oauth:grant-type:device_code"}, {"device_code", code}}),
                        "", stop, "application/x-www-form-urlencoded");
            auto token = parse_json(response.body);
            if (response.status == 200) {
                impl_->accept_token(std::move(token), stop); impl_->message("Signed in", 1); return;
            }
            const auto error = token.value("error", std::string{});
            if (error == "authorization_pending") continue;
            if (error == "slow_down") { interval += 5s; continue; }
            if (error == "access_denied") throw std::runtime_error("Hugging Face sign-in was declined");
            if (error == "expired_token") break;
            successful(response);
            throw std::runtime_error("Hugging Face sign-in could not be completed");
        }
        throw std::runtime_error("Hugging Face sign-in expired. Open sign-in again");
    }, true);
}
bool HuggingFaceClient::browse(std::string repository) {
    return impl_->start("Loading recordings", [this, repo = std::move(repository)](std::stop_token stop) {
        const auto token = impl_->token(stop);
        const auto metadata = impl_->repository(repo, token, stop);
        const auto revision = metadata.value("sha", std::string{});
        const auto entries = impl_->tree(repo, revision, token, stop);
        std::map<std::string, const Json*> sidecars;
        for (const auto& entry : entries)
            if (entry.value("type", std::string{}) == "file" &&
                lower(entry.value("path", std::string{})).ends_with(".mcap.episodes.json"))
                sidecars[entry.value("path", std::string{})] = &entry;
        auto recordings = std::make_shared<std::vector<HuggingFaceRecording>>();
        for (const auto& entry : entries) {
            if (entry.value("type", std::string{}) != "file") continue;
            const auto path = entry.value("path", std::string{});
            if (!lower(path).ends_with(".mcap")) continue;
            HuggingFaceRecording recording{repo, revision, hf::repository_path(path)};
            recording.bytes = entry.value("size", uint64_t{0});
            recording.git_oid = entry.value("oid", std::string{});
            if (entry.contains("lfs") && entry["lfs"].is_object())
                recording.sha256 = entry["lfs"].value("oid", std::string{});
            require(recording.bytes >= 8 && file_metadata(recording.bytes, recording.sha256, recording.git_oid, maximum_recording),
                     "Hugging Face returned invalid recording metadata");
            if (const auto found = sidecars.find(path + ".episodes.json"); found != sidecars.end()) {
                const auto& sidecar = *found->second;
                recording.episodes_bytes = sidecar.value("size", uint64_t{0});
                recording.episodes_git_oid = sidecar.value("oid", std::string{});
                if (sidecar.contains("lfs") && sidecar["lfs"].is_object())
                    recording.episodes_sha256 = sidecar["lfs"].value("oid", std::string{});
                require(file_metadata(recording.episodes_bytes, recording.episodes_sha256,
                                      recording.episodes_git_oid, 16 * 1024 * 1024),
                        "Hugging Face returned invalid episode metadata");
            }
            recordings->push_back(std::move(recording));
        }
        std::sort(recordings->begin(), recordings->end(), [](const auto& a, const auto& b) { return a.path < b.path; });
        std::lock_guard lock(impl_->mutex);
        impl_->state.repository = repo; impl_->state.revision = revision;
        impl_->state.recordings = recordings;
        impl_->state.message = recordings->empty() ? "No MCAP recordings in this repository" :
                                    std::to_string(recordings->size()) + " recordings";
        impl_->state.progress = 1;
    });
}
bool HuggingFaceClient::download(HuggingFaceRecording recording, std::filesystem::path cache) {
    return impl_->start("Downloading recording", [this, recording = std::move(recording), cache = std::move(cache)](std::stop_token stop) {
        const auto slash = recording.repository.find('/');
        require(slash != recording.repository.npos && hf::repository_id(recording.repository.substr(0, slash),
                    recording.repository.substr(slash + 1)) == recording.repository,
                "Invalid Hugging Face repository");
        require(hash_string(recording.revision, 40) && recording.bytes >= 8 &&
                    file_metadata(recording.bytes, recording.sha256, recording.git_oid, maximum_recording),
                "Recording metadata is invalid");
        require((recording.episodes_bytes == 0 && recording.episodes_sha256.empty() && recording.episodes_git_oid.empty()) ||
                    file_metadata(recording.episodes_bytes, recording.episodes_sha256,
                                  recording.episodes_git_oid, 16 * 1024 * 1024),
                "Recording episode metadata is invalid");
        const auto path = hf::repository_path(recording.path);
        require(lower(path).ends_with(".mcap"), "Choose an MCAP recording to download");
        const auto target = cache / recording.revision /
                            (hash_string(recording.sha256, 64) ? recording.sha256 : recording.git_oid) /
                            std::filesystem::u8path(path).filename();
        const auto fetch = [&](const std::string& remote, const std::filesystem::path& local,
                               uint64_t bytes, const std::string& sha, const std::string& git, bool mcap) {
          const auto valid = [&](const std::filesystem::path& file) {
              return std::filesystem::is_regular_file(file) && std::filesystem::file_size(file) == bytes &&
                  file_hash(file, sha.empty(), stop) == (sha.empty() ? git : sha);
          };
          if (!valid(local)) {
            std::filesystem::create_directories(target.parent_path());
            const auto available = std::filesystem::space(target.parent_path()).available;
            require(available >= bytes + 64 * 1024 * 1024, "There is not enough disk space for this recording");
            auto partial = local; partial += ".partial";
            struct Cleanup { std::filesystem::path path; ~Cleanup() { std::error_code ignored; std::filesystem::remove(path, ignored); } } cleanup{partial};
            hf::Request request;
            request.url = std::string(origin) + "/datasets/" + recording.repository + "/resolve/" +
                           recording.revision + '/' + hf::url_encode(remote, true) + "?download=true";
            request.download = partial; request.maximum_bytes = bytes;
            const auto token = impl_->token(stop);
            if (!token.empty()) request.headers["Authorization"] = "Bearer " + token;
            const auto response = impl_->transport(request, stop, [this](uint64_t current, uint64_t total) {
                impl_->message("Downloading recording", total ? float(double(current) / total) : 0);
            });
            successful(response);
            impl_->message("Verifying recording");
            require(valid(partial), "The downloaded recording failed its checksum. Download it again");
            if (mcap) {
                std::ifstream input(partial, std::ios::binary); std::array<char, 8> magic{};
                input.read(magic.data(), magic.size());
                require(std::string(magic.data(), magic.size()) == std::string("\x89MCAP0\r\n", 8),
                        "The selected file is not an MCAP recording");
            } else {
                require(parse_json(read_file(partial, 16 * 1024 * 1024)).is_object(),
                        "The recording episode metadata is invalid");
            }
            std::error_code ignored; std::filesystem::remove(local, ignored);
            std::filesystem::rename(partial, local);
          }
        };
        fetch(path, target, recording.bytes, recording.sha256, recording.git_oid, true);
        if (recording.episodes_bytes) {
            auto sidecar = target; sidecar += ".episodes.json";
            fetch(path + ".episodes.json", sidecar, recording.episodes_bytes,
                  recording.episodes_sha256, recording.episodes_git_oid, false);
        }
        std::lock_guard lock(impl_->mutex);
        impl_->completed_download = target; impl_->state.message = "Recording ready"; impl_->state.progress = 1;
    });
}

bool HuggingFaceClient::upload(std::string repository, std::filesystem::path recording,
                               std::filesystem::path lerobot, std::string prefix, bool create_private) {
    return impl_->start("Preparing upload", [this, repo = std::move(repository), recording = std::move(recording),
                         lerobot = std::move(lerobot), prefix = std::move(prefix), create_private](std::stop_token stop) {
        const auto slash = repo.find('/');
        require(slash != repo.npos && hf::repository_id(repo.substr(0, slash), repo.substr(slash + 1)) == repo,
                "Invalid Hugging Face repository");
        const auto destination = prefix.empty() ? std::string{} : hf::repository_path(prefix) + '/';
        require(lower(recording.extension().string()) == ".mcap" && std::filesystem::is_regular_file(recording),
                "Choose a completed MCAP recording to upload");
        struct File { std::filesystem::path source; std::string path, sha, git_oid, mode; uint64_t bytes; };
        std::vector<File> files;
        const auto add = [&](const std::filesystem::path& source, std::string path) {
            require(!std::filesystem::is_symlink(std::filesystem::symlink_status(source)),
                    "Symbolic links cannot be included in a Hugging Face export");
            files.push_back({source, hf::repository_path(path), {}, {}, {}, std::filesystem::file_size(source)});
            require(files.size() <= 10000, "The Hugging Face export contains too many files");
        };
        const auto recording_name = recording.filename().generic_string();
        add(recording, destination + "recordings/" + recording_name);
        auto sidecar = recording; sidecar += ".episodes.json";
        if (std::filesystem::is_regular_file(sidecar))
            add(sidecar, destination + "recordings/" + recording_name + ".episodes.json");
        if (!lerobot.empty()) {
            require(std::filesystem::is_regular_file(lerobot / "meta" / "info.json"),
                    "Choose a completed LeRobot export directory");
            const std::set<std::string> extensions{".json", ".jsonl", ".parquet", ".mp4", ".md", ".txt"};
            for (const auto& entry : std::filesystem::recursive_directory_iterator(lerobot)) {
                cancelled(stop);
                require(!entry.is_symlink(), "Symbolic links cannot be included in a Hugging Face export");
                if (!entry.is_regular_file()) continue;
                const auto relative = entry.path().lexically_relative(lerobot).generic_string();
                require(extensions.contains(lower(entry.path().extension().string())) &&
                            !relative.starts_with('.') && relative.find("/." ) == relative.npos,
                        "The LeRobot export directory contains an unexpected file");
                add(entry.path(), destination + relative);
            }
        }
        uint64_t total = 0;
        for (auto& file : files) {
            require(file.bytes <= maximum_recording && total <= maximum_recording - file.bytes,
                    "The Hugging Face export exceeds the supported size");
            total += file.bytes;
            impl_->message("Verifying " + file.path);
            file.sha = hf::sha256_file(file.source, stop);
            file.git_oid = file_hash(file.source, true, stop);
        }
        auto token = impl_->token(stop, true);
        auto response = impl_->call("GET", "/api/datasets/" + repo, "", token, stop);
        if (response.status == 404 && create_private) {
            Json create{{"type", "dataset"}, {"name", repo.substr(slash + 1)}, {"private", true}};
            if (repo.substr(0, slash) != impl_->credential.value("username", std::string{}))
                create["organization"] = repo.substr(0, slash);
            impl_->api("POST", "/api/repos/create", std::move(create), token, stop);
            response = impl_->call("GET", "/api/datasets/" + repo, "", token, stop);
        }
        successful(response);
        const auto metadata = parse_json(response.body);
        const auto parent = metadata.value("sha", std::string{});
        require(hash_string(parent, 40), "Hugging Face did not return a repository commit");
        const auto existing = impl_->tree(repo, parent, token, stop);
        std::map<std::string, Json> occupied;
        for (const auto& entry : existing)
            if (entry.value("type", std::string{}) == "file") occupied[entry.value("path", std::string{})] = entry;
        std::vector<File> pending;
        for (auto& file : files) {
            if (const auto found = occupied.find(file.path); found != occupied.end()) {
                const auto& entry = found->second;
                const auto lfs = entry.value("lfs", Json::object());
                const bool same = entry.value("size", uint64_t{0}) == file.bytes &&
                    (lfs.is_object() && lfs.value("oid", std::string{}) == file.sha ||
                     entry.value("oid", std::string{}) == file.git_oid);
                require(same, "The upload would replace an existing recording or dataset file. Choose another repository or folder");
            } else pending.push_back(file);
        }
        if (pending.empty()) { impl_->message("These files are already on Hugging Face", 1); return; }
        for (size_t offset = 0; offset < pending.size(); offset += 256) {
            token = impl_->token(stop, true);
            Json batch = Json::array();
            const auto end = std::min(offset + 256, pending.size());
            for (size_t i = offset; i < end; ++i) {
                std::ifstream input(pending[i].source, std::ios::binary);
                std::string sample(512, '\0'); input.read(sample.data(), sample.size());
                sample.resize(static_cast<size_t>(input.gcount()));
                batch.push_back({{"path", pending[i].path}, {"sample", base64(sample)}, {"size", pending[i].bytes}});
            }
            const auto modes = impl_->api("POST", "/api/datasets/" + repo + "/preupload/main", {{"files", batch}}, token, stop);
            require(modes.contains("files") && modes["files"].is_array(), "Hugging Face returned invalid upload instructions");
            for (size_t i = offset; i < end; ++i) {
                for (const auto& mode : modes["files"])
                    if (mode.value("path", std::string{}) == pending[i].path) {
                        require(!mode.value("shouldIgnore", false), "Hugging Face repository rules exclude an export file");
                        pending[i].mode = mode.value("uploadMode", std::string{});
                    }
                require(pending[i].mode == "regular" || pending[i].mode == "lfs", "Hugging Face returned an unsupported upload mode");
            }
        }
        std::string commit = Json{{"key", "header"}, {"value", {{"summary", "Upload Ceres recording"},
            {"description", "Recording and selected LeRobot export from Ceres viewer"}, {"parentCommit", parent}}}}.dump() + '\n';
        uint64_t uploaded = 0;
        for (const auto& file : pending) {
            cancelled(stop);
            impl_->message("Uploading " + file.path, total ? float(double(uploaded) / total) : 0);
            if (file.mode == "regular") {
                require(file.bytes <= 16 * 1024 * 1024, "Hugging Face requires large export files to use LFS");
                commit += Json{{"key", "file"}, {"value", {{"path", file.path}, {"encoding", "base64"},
                              {"content", base64(read_file(file.source, 16 * 1024 * 1024))}}}}.dump() + '\n';
            } else {
                token = impl_->token(stop, true);
                hf::Request lfs_request;
                lfs_request.method = "POST";
                lfs_request.url = std::string(origin) + "/datasets/" + repo + ".git/info/lfs/objects/batch";
                lfs_request.headers = {{"Authorization", "Bearer " + token},
                    {"Content-Type", "application/vnd.git-lfs+json"}, {"Accept", "application/vnd.git-lfs+json"}};
                lfs_request.body = Json{{"operation", "upload"}, {"transfers", {"basic", "multipart"}},
                    {"hash_algo", "sha256"}, {"objects", {{{"oid", file.sha}, {"size", file.bytes}}}},
                    {"ref", {{"name", "main"}}}}.dump();
                const auto lfs_response = impl_->transport(lfs_request, stop, {});
                successful(lfs_response);
                const auto batch = parse_json(lfs_response.body);
                require(batch.contains("objects") && batch["objects"].is_array() && batch["objects"].size() == 1,
                        "Hugging Face returned invalid large-file instructions");
                const auto& object = batch["objects"][0];
                require(!object.contains("error") && object.value("oid", std::string{}) == file.sha,
                        "Hugging Face could not accept the recording upload");
                if (object.contains("actions")) {
                    const auto& actions = object["actions"];
                    const auto& upload = actions.at("upload");
                    const auto headers = upload.value("header", Json::object());
                    const auto put = [&](const std::string& url, uint64_t offset, uint64_t size,
                                         std::map<std::string, std::string> action_headers) {
                        hf::Request request; request.method = "PUT"; request.url = url;
                        request.upload = file.source; request.offset = offset; request.length = size;
                        request.headers = std::move(action_headers);
                        auto result = impl_->transport(request, stop, [&, offset](uint64_t current, uint64_t) {
                            impl_->message("Uploading " + file.path, total ? float(double(uploaded + offset + current) / total) : 0);
                        });
                        successful(result); return result;
                    };
                    if (headers.contains("chunk_size")) {
                        const auto chunk = std::stoull(headers.at("chunk_size").get<std::string>());
                        require(chunk > 0 && chunk <= maximum_recording, "Hugging Face returned an invalid upload chunk size");
                        std::map<uint64_t, std::string> part_urls;
                        for (const auto& [key, value] : headers.items()) {
                            if (key == "chunk_size") continue;
                            require(!key.empty() && key.size() <= 10 && value.is_string() &&
                                        std::all_of(key.begin(), key.end(), [](char c) { return c >= '0' && c <= '9'; }),
                                    "Hugging Face returned invalid multipart instructions");
                            require(part_urls.emplace(std::stoull(key), value.get<std::string>()).second,
                                    "Hugging Face repeated an upload part");
                        }
                        require(part_urls.size() == (file.bytes + chunk - 1) / chunk,
                                "Hugging Face omitted an upload part");
                        Json parts = Json::array();
                        for (uint64_t offset = 0, part = 1; offset < file.bytes; offset += chunk, ++part) {
                            require(part_urls.contains(part), "Hugging Face omitted an upload part");
                            const auto result = put(part_urls.at(part), offset,
                                                     std::min(chunk, file.bytes - offset), {});
                            const auto etag = result.headers.find("etag");
                            require(etag != result.headers.end() && !etag->second.empty(), "Hugging Face did not acknowledge an upload part");
                            parts.push_back({{"partNumber", part}, {"etag", etag->second}});
                        }
                        hf::Request complete; complete.method = "POST";
                        complete.url = upload.at("href").get<std::string>();
                        complete.headers["Content-Type"] = "application/vnd.git-lfs+json";
                        complete.headers["Accept"] = "application/vnd.git-lfs+json";
                        complete.body = Json{{"oid", file.sha}, {"parts", parts}}.dump();
                        successful(impl_->transport(complete, stop, {}));
                    } else put(upload.at("href").get<std::string>(), 0, file.bytes, action_headers(headers));
                    if (actions.contains("verify")) {
                        hf::Request verify; verify.method = "POST";
                        verify.url = actions["verify"].at("href").get<std::string>();
                        require(verify.url.starts_with("https://"), "Hugging Face returned an invalid verification endpoint");
                        verify.headers = action_headers(actions["verify"].value("header", Json::object()));
                        if (verify.url.starts_with(std::string(origin) + '/') && !verify.headers.contains("authorization"))
                            verify.headers["authorization"] = "Bearer " + impl_->token(stop, true);
                        if (!verify.headers.contains("content-type"))
                            verify.headers["content-type"] = "application/vnd.git-lfs+json";
                        verify.body = Json{{"oid", file.sha}, {"size", file.bytes}}.dump();
                        successful(impl_->transport(verify, stop, {}));
                    }
                }
                commit += Json{{"key", "lfsFile"}, {"value", {{"path", file.path}, {"algo", "sha256"},
                                  {"oid", file.sha}, {"size", file.bytes}}}}.dump() + '\n';
            }
            require(commit.size() <= 64 * 1024 * 1024, "Hugging Face commit metadata is too large");
            uploaded += file.bytes;
        }
        for (const auto& file : pending)
            require(hf::sha256_file(file.source, stop) == file.sha, "A local export file changed during upload. Try again after saving finishes");
        impl_->message("Saving Hugging Face commit", .99f);
        token = impl_->token(stop, true);
        response = impl_->call("POST", "/api/datasets/" + repo + "/commit/main", std::move(commit), token,
                              stop, "application/x-ndjson");
        successful(response);
        const auto result = parse_json(response.body);
        const auto revision = result.value("commitOid", std::string{});
        require(hash_string(revision, 40), "Hugging Face did not return a completed commit");
        const auto committed = impl_->tree(repo, revision, token, stop);
        for (const auto& file : pending) {
            bool verified = false;
            for (const auto& entry : committed) {
                if (entry.value("path", std::string{}) != file.path) continue;
                const auto lfs = entry.value("lfs", Json::object());
                verified = entry.value("size", uint64_t{0}) == file.bytes &&
                    (file.mode == "lfs" ? lfs.is_object() && lfs.value("oid", std::string{}) == file.sha :
                                         entry.value("oid", std::string{}) == file.git_oid);
            }
            require(verified, "The Hugging Face commit did not match the uploaded files. Refresh the repository before retrying");
        }
        std::lock_guard lock(impl_->mutex);
        impl_->state.commit_url = std::string(origin) + "/datasets/" + repo + "/commit/" + revision;
        impl_->state.message = "Upload complete"; impl_->state.progress = 1;
    });
}
} // namespace ceres
