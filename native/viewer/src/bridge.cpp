#include "ceres/bridge.hpp"
#include "ceres/depth.hpp"
#include "ceres/detail/receive_queue.hpp"
#include "ceres/protocol.hpp"
#include "ceres/rtcp_clock.hpp"
#include <rtc/rtc.hpp>
#include <curl/curl.h>
#include <mbedtls/threading.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <charconv>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <fstream>
#include <map>
#include <mutex>
#include <stdexcept>
#include <sstream>
#include <thread>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <sddl.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace ceres {
namespace {
struct RelayError : std::runtime_error {
    long status;
    std::string reason;
    int64_t retry_after_seconds;
    explicit RelayError(long value, std::string detail = {}, int64_t retry_after = 60)
        : std::runtime_error("Pairing service returned HTTP " + std::to_string(value) +
                             (detail.empty() ? "" : ": " + detail)),
          status(value), reason(std::move(detail)), retry_after_seconds(retry_after) {}
};
std::string relay_error_reason(const Json& response) {
    if (!response.is_object() || !response.contains("error") || !response["error"].is_string())
        return {};
    const auto& reason = response["error"].get_ref<const std::string&>();
    // Service errors enter the status/event stream. Never copy arbitrary remote
    // text, which could contain a reflected receiver credential.
    if (reason.size() > 128)
        return {};
    for (const std::string_view known : {
             "Invalid Bridge invitation", "Invalid Bridge identity", "Invalid Bridge JSON",
             "Invalid Bridge request", "Origin is not allowed", "Bridge request is too large",
             "Bridge code is already allocated", "Bridge identity is already registered",
             "Bridge pairing was not found", "Bridge invitation expired",
             "Bridge pairing is unavailable or revoked", "Bridge pairing was revoked",
             "Bridge connection limit reached", "Invalid Bridge session generation"})
        if (reason == known)
            return std::string(known);
    return {};
}
int64_t retry_after_seconds(std::string_view header) {
    while (!header.empty() && (header.front() == ' ' || header.front() == '\t'))
        header.remove_prefix(1);
    while (!header.empty() && (header.back() == ' ' || header.back() == '\t' ||
                               header.back() == '\r' || header.back() == '\n'))
        header.remove_suffix(1);
    if (header.empty() || header.size() > 128)
        return 60;
    int64_t seconds = 0;
    const auto parsed = std::from_chars(header.data(), header.data() + header.size(), seconds);
    if (parsed.ec == std::errc{} && parsed.ptr == header.data() + header.size() && seconds >= 0)
        return std::clamp<int64_t>(seconds, 1, 2147483647);
    const auto date = curl_getdate(std::string(header).c_str(), nullptr);
    if (date < 0)
        return 60;
    return std::clamp<int64_t>(int64_t(date) - int64_t(std::time(nullptr)), 1, 2147483647);
}
double unix_seconds() {
    return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}
std::string rate_limit_message(int64_t seconds) {
    return "Pairing is temporarily rate limited. Retrying automatically in " +
           std::to_string(seconds / 60) + ":" + (seconds % 60 < 10 ? "0" : "") +
           std::to_string(seconds % 60) + ".";
}
std::string trusted_certificates() {
#ifdef _WIN32
    auto store = CertOpenSystemStoreA(0, "ROOT");
    if (!store)
        throw std::runtime_error("Cannot open the trusted certificate store");
    std::string pem;
    PCCERT_CONTEXT certificate = nullptr;
    while ((certificate = CertEnumCertificatesInStore(store, certificate))) {
        DWORD size = 0;
        if (!CryptBinaryToStringA(certificate->pbCertEncoded, certificate->cbCertEncoded,
                                  CRYPT_STRING_BASE64HEADER, nullptr, &size))
            continue;
        std::string encoded(size, '\0');
        if (CryptBinaryToStringA(certificate->pbCertEncoded, certificate->cbCertEncoded,
                                 CRYPT_STRING_BASE64HEADER, encoded.data(), &size)) {
            if (!encoded.empty() && encoded.back() == '\0')
                encoded.pop_back();
            pem += encoded;
        }
    }
    CertCloseStore(store, 0);
    if (pem.empty())
        throw std::runtime_error("The trusted certificate store is empty");
    return pem;
#else
    for (const auto* path :
         {"/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt",
          "/etc/ssl/ca-bundle.pem", "/etc/ssl/cert.pem"}) {
        if (std::filesystem::is_regular_file(path))
            return path;
    }
    throw std::runtime_error("Cannot locate the system certificate bundle");
#endif
}
std::string origin(std::string value) {
    while (!value.empty() && value.back() == '/')
        value.pop_back();
    auto* url = curl_url();
    if (!url)
        throw std::runtime_error("Cannot initialise URL parser");
    std::unique_ptr<CURLU, decltype(&curl_url_cleanup)> guard(url, curl_url_cleanup);
    if (curl_url_set(url, CURLUPART_URL, value.c_str(), 0) != CURLUE_OK)
        throw std::invalid_argument("Invalid service origin");
    auto part = [url](CURLUPart field) {
        char* raw = nullptr;
        if (curl_url_get(url, field, &raw, 0) != CURLUE_OK)
            return std::string();
        std::string result(raw);
        curl_free(raw);
        return result;
    };
    const auto scheme = part(CURLUPART_SCHEME), host = part(CURLUPART_HOST),
               path = part(CURLUPART_PATH);
    const bool loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    if (host.empty() || (scheme != "https" && !(scheme == "http" && loopback)) ||
        !part(CURLUPART_USER).empty() || !part(CURLUPART_PASSWORD).empty() ||
        !part(CURLUPART_QUERY).empty() || !part(CURLUPART_FRAGMENT).empty() ||
        (!path.empty() && path != "/"))
        throw std::invalid_argument("Service origin must use HTTPS, or HTTP on loopback");
    return value;
}
void random_bytes(std::span<uint8_t> bytes) {
#ifdef _WIN32
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
        throw std::runtime_error("Cannot obtain secure random bytes");
#else
    size_t at = 0;
    while (at < bytes.size()) {
        const auto count = getrandom(bytes.data() + at, bytes.size() - at, 0);
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0)
            throw std::runtime_error("Cannot obtain secure random bytes");
        at += static_cast<size_t>(count);
    }
#endif
}
std::string secret() {
    std::array<uint8_t, 32> bytes{};
    random_bytes(bytes);
    constexpr char hex[] = "0123456789abcdef";
    std::string result;
    result.reserve(64);
    for (auto b : bytes) {
        result.push_back(hex[b >> 4]);
        result.push_back(hex[b & 15]);
    }
    return result;
}
std::string pairing_code(size_t length = 9) {
    constexpr std::string_view alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ";
    constexpr auto accepted_bytes = 256 / alphabet.size() * alphabet.size();
    std::array<uint8_t, 9> bytes{};
    std::string result;
    result.reserve(length);
    while (result.size() < length) {
        random_bytes(bytes);
        for (auto b : bytes) {
            // Discard the incomplete alphabet block so every letter is equally likely.
            if (b >= accepted_bytes)
                continue;
            result.push_back(alphabet[b % alphabet.size()]);
            if (result.size() == length)
                break;
        }
    }
    return result;
}
bool valid_identity_text(const Json& value) {
    if (!value.is_string())
        return false;
    const auto& text = value.get_ref<const std::string&>();
    return text.size() >= 20 && text.size() <= 128 &&
           std::all_of(text.begin(), text.end(), [](unsigned char c) {
               return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                      c == '_' || c == '-';
           });
}
std::filesystem::path default_identity_path() {
#ifdef _WIN32
    wchar_t* raw = nullptr;
    size_t count = 0;
    if (_wdupenv_s(&raw, &count, L"LOCALAPPDATA") != 0 || !raw)
        throw std::runtime_error("LOCALAPPDATA is unavailable");
    std::unique_ptr<wchar_t, decltype(&std::free)> base(raw, std::free);
    return std::filesystem::path(base.get()) / "CeresViewer" / "receiver.identity";
#else
    if (const char* base = std::getenv("XDG_STATE_HOME"))
        return std::filesystem::path(base) / "ceres-viewer" / "receiver.json";
    const char* base = std::getenv("HOME");
    if (!base)
        throw std::runtime_error("HOME is unavailable");
    return std::filesystem::path(base) / ".local" / "state" / "ceres-viewer" / "receiver.json";
#endif
}

#ifdef _WIN32
struct PrivateSecurity {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
    PrivateSecurity() {
        HANDLE token = nullptr;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
            throw std::runtime_error("Cannot read current user identity");
        DWORD needed = 0;
        GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
        std::vector<uint8_t> storage(needed);
        const BOOL valid = GetTokenInformation(token, TokenUser, storage.data(), needed, &needed);
        CloseHandle(token);
        if (!valid)
            throw std::runtime_error("Cannot read current user identity");
        LPWSTR sid = nullptr;
        if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(storage.data())->User.Sid, &sid))
            throw std::runtime_error("Cannot construct private credential permissions");
        const std::wstring sddl = L"D:P(A;;FA;;;SY)(A;;FA;;;" + std::wstring(sid) + L")";
        LocalFree(sid);
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                                  &descriptor, nullptr))
            throw std::runtime_error("Cannot construct private credential permissions");
        attributes.lpSecurityDescriptor = descriptor;
    }
    ~PrivateSecurity() {
        if (descriptor)
            LocalFree(descriptor);
    }
};
#endif

void prepare_identity_directory(const std::filesystem::path& file) {
    const auto parent = file.parent_path();
    if (parent.empty())
        throw std::invalid_argument("Receiver identity must have a parent directory");
    if (std::filesystem::is_symlink(std::filesystem::symlink_status(parent)))
        throw std::runtime_error("Receiver identity directory must not be a symbolic link");
    const bool made = std::filesystem::create_directories(parent);
#ifndef _WIN32
    if (made && chmod(parent.c_str(), 0700) != 0)
        throw std::runtime_error("Cannot protect receiver identity directory");
    struct stat status {};
    if (lstat(parent.c_str(), &status) != 0 || !S_ISDIR(status.st_mode) ||
        status.st_uid != getuid() || (status.st_mode & 0077))
        throw std::runtime_error("Receiver identity directory must be private to this user");
#else
    (void)made;
    const auto attrs = GetFileAttributesW(parent.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT))
        throw std::runtime_error("Receiver identity directory must not be a reparse point");
#endif
}

Json read_identity(const std::filesystem::path& file) {
    if (!std::filesystem::exists(file))
        return Json();
    std::string clear;
#ifdef _WIN32
    HANDLE handle = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
        throw std::runtime_error("Cannot read receiver identity");
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle, &info) ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
        info.nFileSizeHigh || info.nFileSizeLow > 65536) {
        CloseHandle(handle);
        throw std::runtime_error("Invalid receiver identity file");
    }
    std::vector<uint8_t> bytes(info.nFileSizeLow);
    DWORD count = 0;
    const BOOL read =
        ReadFile(handle, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr);
    CloseHandle(handle);
    if (!read || count != bytes.size())
        throw std::runtime_error("Cannot read receiver identity");
    DATA_BLOB encrypted{count, bytes.data()}, decrypted{};
    if (!CryptUnprotectData(&encrypted, nullptr, nullptr, nullptr, nullptr,
                            CRYPTPROTECT_UI_FORBIDDEN, &decrypted))
        throw std::runtime_error(
            "Receiver identity belongs to another Windows account or is damaged");
    clear.assign(reinterpret_cast<char*>(decrypted.pbData), decrypted.cbData);
    SecureZeroMemory(decrypted.pbData, decrypted.cbData);
    LocalFree(decrypted.pbData);
#else
    const int fd = open(file.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0)
        throw std::runtime_error("Cannot read receiver identity");
    struct stat info {};
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() ||
        (info.st_mode & 0077) || info.st_size > 65536) {
        close(fd);
        throw std::runtime_error("Receiver identity must be private to this user");
    }
    clear.resize(static_cast<size_t>(info.st_size));
    size_t at = 0;
    while (at < clear.size()) {
        const auto count = read(fd, clear.data() + at, clear.size() - at);
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0) {
            close(fd);
            throw std::runtime_error("Cannot read receiver identity");
        }
        at += static_cast<size_t>(count);
    }
    close(fd);
#endif
    auto value = Json::parse(clear, nullptr, false);
    std::fill(clear.begin(), clear.end(), '\0');
    if (!value.is_object() || value.value("version", 0) != 1 ||
        !valid_identity_text(value.value("bindingId", Json())) ||
        !valid_identity_text(value.value("deviceId", Json())) ||
        !valid_identity_text(value.value("secret", Json())) || !value.contains("relay") ||
        !value["relay"].is_string())
        throw std::runtime_error("Invalid saved receiver identity");
    value["relay"] = origin(value["relay"].get<std::string>());
    value["appOrigin"] = origin(value.value("appOrigin", std::string("https://ceres.cam")));
    if (value.contains("retry_after") &&
        (!value["retry_after"].is_number() ||
         !std::isfinite(value["retry_after"].get<double>()) ||
         value["retry_after"].get<double>() < 0))
        throw std::runtime_error("Invalid saved pairing retry deadline");
    return value;
}

void write_identity(const std::filesystem::path& file, const Json& value) {
    std::string clear = value.dump();
    const auto temporary =
        file.parent_path() / (file.filename().string() + "." + secret().substr(0, 12) + ".pending");
#ifdef _WIN32
    DATA_BLOB input{static_cast<DWORD>(clear.size()), reinterpret_cast<BYTE*>(clear.data())},
        encrypted{};
    if (!CryptProtectData(&input, L"Ceres viewer receiver", nullptr, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &encrypted))
        throw std::runtime_error("Cannot protect receiver identity");
    std::fill(clear.begin(), clear.end(), '\0');
    PrivateSecurity security;
    HANDLE handle = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, &security.attributes,
                                CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        LocalFree(encrypted.pbData);
        throw std::runtime_error("Cannot save receiver identity");
    }
    DWORD count = 0;
    const BOOL written = WriteFile(handle, encrypted.pbData, encrypted.cbData, &count, nullptr);
    const bool complete = written && count == encrypted.cbData && FlushFileBuffers(handle);
    CloseHandle(handle);
    LocalFree(encrypted.pbData);
    if (!complete || !MoveFileExW(temporary.c_str(), file.c_str(),
                                  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(temporary.c_str());
        throw std::runtime_error("Cannot commit receiver identity");
    }
#else
    const int fd =
        open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0)
        throw std::runtime_error("Cannot save receiver identity");
    size_t at = 0;
    bool success = true;
    while (at < clear.size()) {
        const auto count = write(fd, clear.data() + at, clear.size() - at);
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0) {
            success = false;
            break;
        }
        at += static_cast<size_t>(count);
    }
    success = success && fsync(fd) == 0;
    close(fd);
    std::fill(clear.begin(), clear.end(), '\0');
    if (!success || rename(temporary.c_str(), file.c_str()) != 0) {
        unlink(temporary.c_str());
        throw std::runtime_error("Cannot commit receiver identity");
    }
    const int directory = open(file.parent_path().c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY);
    if (directory >= 0) {
        fsync(directory);
        close(directory);
    }
#endif
}

struct IdentityLock {
#ifdef _WIN32
    HANDLE handle = INVALID_HANDLE_VALUE;
    explicit IdentityLock(const std::filesystem::path& file) {
        PrivateSecurity security;
        const auto path = std::filesystem::path(file.wstring() + L".lock");
        handle = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, &security.attributes,
                             OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (handle == INVALID_HANDLE_VALUE)
            throw std::runtime_error("This receiver identity is already in use");
        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(handle, &info) ||
            (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
            CloseHandle(handle);
            handle = INVALID_HANDLE_VALUE;
            throw std::runtime_error("Invalid receiver lock file");
        }
    }
    ~IdentityLock() {
        if (handle != INVALID_HANDLE_VALUE)
            CloseHandle(handle);
    }
#else
    int handle = -1;
    explicit IdentityLock(const std::filesystem::path& file) {
        handle = open((file.string() + ".lock").c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW,
                      0600);
        if (handle < 0 || flock(handle, LOCK_EX | LOCK_NB) != 0) {
            if (handle >= 0)
                close(handle);
            handle = -1;
            throw std::runtime_error("This receiver identity is already in use");
        }
    }
    ~IdentityLock() {
        if (handle >= 0)
            close(handle);
    }
#endif
};

struct CurlRuntime {
    CurlRuntime() {
#ifdef _WIN32
        mbedtls_threading_set_alt(
            +[](mbedtls_threading_mutex_t* value) {
                InitializeSRWLock(&value->lock);
                value->valid = 1;
            },
            +[](mbedtls_threading_mutex_t* value) { value->valid = 0; },
            +[](mbedtls_threading_mutex_t* value) -> int {
                if (!value || !value->valid)
                    return MBEDTLS_ERR_THREADING_BAD_INPUT_DATA;
                AcquireSRWLockExclusive(&value->lock);
                return 0;
            },
            +[](mbedtls_threading_mutex_t* value) -> int {
                if (!value || !value->valid)
                    return MBEDTLS_ERR_THREADING_BAD_INPUT_DATA;
                ReleaseSRWLockExclusive(&value->lock);
                return 0;
            });
#endif
        if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK)
            throw std::runtime_error("Cannot initialise HTTPS");
    }
    ~CurlRuntime() {
        curl_global_cleanup();
    }
};
} // namespace

struct BridgeClient::Impl : std::enable_shared_from_this<BridgeClient::Impl> {
    enum class InputKind {
        Signal,
        SignalOpen,
        SignalClosed,
        Failure,
        LocalDescription,
        Candidate,
        Gathering,
        PeerState,
        Channel,
        Pose,
        Metadata,
        Video,
        Depth
    };
    struct Input {
        InputKind kind = InputKind::Failure;
        uint64_t generation = 0;
        int64_t received_us = 0;
        std::string text, detail;
        rtc::binary bytes;
        int number = 0;
        std::shared_ptr<rtc::DataChannel> channel;
    };
    BridgeOptions options;
    mutable std::mutex state_mutex, sink_mutex, queue_mutex, lifecycle_mutex;
    std::condition_variable wake;
    ReceiverSnapshot current;
    int64_t rate_limit_deadline_us = 0;
    EventSink sink;
    detail::ReceiveQueue<Input> inputs;
    std::atomic<bool> running = false, new_pairing = false, overflow = false,
                      external_keyframe = false;
    std::atomic<bool> depth_enabled = true;
    std::thread thread;
    Json identity;
    std::string legacy_code_relay;
    uint64_t generation = 0;
    std::shared_ptr<rtc::PeerConnection> peer;
    std::shared_ptr<rtc::WebSocket> socket;
    std::shared_ptr<rtc::DataChannel> pose_channel, metadata_channel, depth_channel;
    DepthAssembler depth_assembler;
    struct CameraInput {
        std::shared_ptr<rtc::Track> track;
        std::shared_ptr<RtcpCameraSession> rtcp;
        H264Assembler assembler;
        std::optional<CameraDescription> description;
        uint32_t sequence = 0;
        int64_t last_pli = 0;
        std::optional<uint32_t> assembler_ssrc;
        bool force_keyframe = true;
    };
    std::map<std::string, CameraInput> video_inputs;
    std::vector<std::shared_ptr<rtc::Track>> tracks;
    std::map<std::string, int> mid_indices;
    std::vector<std::string> remote_mids;
    std::vector<Json> pending_candidates;
    ClockMap clock;
    std::map<uint32_t, int64_t> pings;
    std::deque<PoseSample> head_history;
    uint32_t ping_id = 0;
    int64_t last_ping = 0, started = 0, disconnected = 0;
    bool description_received = false, remote_set = false, local_end = false, remote_end = false,
         signal_done = false, signal_open = false;
    bool depth_control_supported = false;
    std::optional<bool> sent_depth_enabled;
    std::optional<uint32_t> space_epoch;

    explicit Impl(BridgeOptions value) : options(std::move(value)) {
        static CurlRuntime runtime;
        options.app_origin = origin(options.app_origin);
        options.relay = origin(options.relay);
        if (options.relay == options.app_origin && (options.app_origin == "https://ceres.cam" ||
                                                    options.app_origin == "https://ceres.wtf"))
            options.relay = "https://ceres.ceres-relay.workers.dev";
        if (options.name.empty() || options.name.size() > 80)
            throw std::invalid_argument("Receiver name must contain 1 to 80 bytes");
        if (options.identity_path.empty())
            options.identity_path = default_identity_path();
        options.identity_path = std::filesystem::absolute(options.identity_path);
    }
    ~Impl() = default;
    void emit(SessionEvent event) {
        EventSink callback;
        {
            std::lock_guard lock(sink_mutex);
            callback = sink;
        }
        if (callback)
            callback(event);
    }
    void status(std::string connection, std::string error = {}) {
        bool changed = false, connected = false;
        uint32_t epoch = 0, reference = 0;
        {
            std::lock_guard lock(state_mutex);
            changed = current.connection != connection || current.error != error;
            current.connection = connection;
            current.error = error;
            if (connection != "Streaming")
                current.connected = false;
            connected = current.connected;
            epoch = current.epoch;
            reference = current.space_epoch;
        }
        if (changed) {
            const auto now = monotonic_us();
            SessionEvent event;
            event.kind = EventKind::Metadata;
            event.receive_us = event.time_us = now;
            event.epoch = epoch;
            event.space_epoch = reference;
            event.attributes = {{"type", "connection"},
                                {"connection", connection},
                                {"connected", connected},
                                {"error", error}};
            emit(std::move(event));
        }
    }
    void enqueue(Input input) {
        if (!running.load())
            return;
        {
            std::lock_guard lock(queue_mutex);
            const size_t bytes = input.text.size() + input.detail.size() + input.bytes.size();
            const auto kind = input.kind;
            const auto priority = kind == InputKind::Pose ? detail::ReceivePriority::Pose
                : kind == InputKind::Video ? detail::ReceivePriority::Video
                : kind == InputKind::Depth ? detail::ReceivePriority::Depth
                : detail::ReceivePriority::Control;
            if (!inputs.push(priority, std::move(input), bytes)) {
                if (kind == InputKind::Depth)
                    return;
                if (kind == InputKind::Video) {
                    external_keyframe = true;
                    wake.notify_all();
                    return;
                }
                overflow = true;
                wake.notify_all();
                return;
            }
        }
        wake.notify_all();
    }
    static Input input(InputKind kind, uint64_t generation) {
        Input result;
        result.kind = kind;
        result.generation = generation;
        result.received_us = monotonic_us();
        return result;
    }
    Json request(const std::string& path, const Json& body) {
        std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> handle(curl_easy_init(),
                                                                   curl_easy_cleanup);
        if (!handle)
            throw std::runtime_error("Cannot initialise pairing request");
        const auto base =
            identity.is_object() ? identity.value("relay", options.relay) : options.relay;
        const std::string url = base + "/api/bridge/v1" + path, payload = body.dump();
        if (payload.size() > 8192)
            throw std::runtime_error("Pairing request exceeds its budget");
        std::string response, retry_after;
        auto* raw_headers = curl_slist_append(nullptr, "Content-Type: application/json");
        std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> headers(raw_headers,
                                                                            curl_slist_free_all);
        curl_easy_setopt(handle.get(), CURLOPT_URL, url.c_str());
        curl_easy_setopt(handle.get(), CURLOPT_HTTPHEADER, headers.get());
        curl_easy_setopt(handle.get(), CURLOPT_POSTFIELDS, payload.c_str());
        curl_easy_setopt(handle.get(), CURLOPT_POSTFIELDSIZE, static_cast<long>(payload.size()));
        curl_easy_setopt(handle.get(), CURLOPT_TIMEOUT_MS, 10000L);
        curl_easy_setopt(handle.get(), CURLOPT_CONNECTTIMEOUT_MS, 5000L);
        curl_easy_setopt(handle.get(), CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(handle.get(), CURLOPT_FOLLOWLOCATION, 0L);
        curl_easy_setopt(handle.get(), CURLOPT_SSL_VERIFYPEER, 1L);
        curl_easy_setopt(handle.get(), CURLOPT_SSL_VERIFYHOST, 2L);
        curl_easy_setopt(handle.get(), CURLOPT_USERAGENT, "CeresViewer/1");
        curl_easy_setopt(
            handle.get(), CURLOPT_WRITEFUNCTION,
            +[](char* data, size_t size, size_t count, void* destination) -> size_t {
                auto& text = *static_cast<std::string*>(destination);
                const size_t bytes = size * count;
                if (bytes > 8192 || text.size() + bytes > 8192)
                    return 0;
                text.append(data, bytes);
                return bytes;
            });
        curl_easy_setopt(handle.get(), CURLOPT_WRITEDATA, &response);
        curl_easy_setopt(
            handle.get(), CURLOPT_HEADERFUNCTION,
            +[](char* data, size_t size, size_t count, void* destination) -> size_t {
                const size_t bytes = size * count;
                const std::string_view line(data, bytes);
                auto& retry = *static_cast<std::string*>(destination);
                if (line.starts_with("HTTP/"))
                    retry.clear();
                constexpr std::string_view field = "retry-after:";
                if (line.size() >= field.size() &&
                    std::equal(field.begin(), field.end(), line.begin(), [](char expected, char actual) {
                        return expected == (actual >= 'A' && actual <= 'Z' ? actual + ('a' - 'A') : actual);
                    })) {
                    const auto value = line.substr(field.size());
                    retry = value.size() <= 128 ? std::string(value) : std::string();
                }
                return bytes;
            });
        curl_easy_setopt(handle.get(), CURLOPT_HEADERDATA, &retry_after);
        curl_easy_setopt(handle.get(), CURLOPT_NOPROGRESS, 0L);
        curl_easy_setopt(
            handle.get(), CURLOPT_XFERINFOFUNCTION,
            +[](void* owner, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int {
                return static_cast<Impl*>(owner)->running.load() ? 0 : 1;
            });
        curl_easy_setopt(handle.get(), CURLOPT_XFERINFODATA, this);
        const auto result = curl_easy_perform(handle.get());
        char* content_type = nullptr;
        curl_easy_getinfo(handle.get(), CURLINFO_CONTENT_TYPE, &content_type);
        long status_code = 0;
        curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &status_code);
        // A truncated or oversized error body must not turn a received retry
        // deadline or terminal rejection into a transient transport retry.
        if (result != CURLE_OK && !(status_code >= 400 && status_code < 500))
            throw std::runtime_error("Pairing service connection failed (curl " +
                                     std::to_string(int(result)) +
                                     "): " + curl_easy_strerror(result));
        const bool json_response = !content_type ||
            std::string_view(content_type).find("application/json") != std::string_view::npos;
        auto value = result == CURLE_OK && json_response ? Json::parse(response, nullptr, false) : Json();
        if (status_code < 200 || status_code >= 300)
            throw RelayError(status_code, relay_error_reason(value), retry_after_seconds(retry_after));
        if (!json_response)
            throw std::runtime_error("Pairing service did not return JSON, check the relay origin");
        if (!value.is_object())
            throw std::runtime_error("Invalid pairing response");
        return value;
    }
    Json auth() const {
        return {{"role", "receiver"},
                {"deviceId", identity["deviceId"]},
                {"secret", identity["secret"]}};
    }
    std::string binding_path() const {
        return "/bindings/" + identity.at("bindingId").get<std::string>();
    }
    void update_invitation() {
        std::lock_guard lock(state_mutex);
        const bool visible = identity.value("invitation_expires", 0.0) > unix_seconds() &&
                             !identity.value("paired", false);
        current.code = visible ? identity.value("code", std::string()) : std::string();
        current.pairing_url =
            current.code.empty()
                ? std::string()
                : identity.value("appOrigin", options.app_origin) + "/bridge/?code=" + current.code;
    }
    void validate_session(const Json& session) {
        if (!session.contains("epoch") || !session["epoch"].is_number_integer() ||
            session["epoch"].get<double>() < 1 || session["epoch"].get<double>() > 4294967295.0 ||
            !session.contains("paired") || !session["paired"].is_boolean())
            throw std::runtime_error("Invalid pairing session");
    }
    void remember_code_format() {
        if (identity.value("legacy_code_length", 0) == 8)
            legacy_code_relay = identity.value("relay", options.relay);
    }
    Json register_pending_identity() {
        try {
            return request("/bindings", identity);
        } catch (const RelayError& error) {
            const auto code = identity.value("code", std::string());
            if (error.status != 400 || error.reason != "Invalid Bridge invitation" ||
                !identity.value("pending_creation", false) || identity.value("paired", false) ||
                code.size() != 9 || code.find_first_not_of("ABCDEFGHJKMNPQRSTUVWXYZ") != std::string::npos)
                throw;
            // An explicit rejection proves that the nine-letter invitation was
            // not created. Keep its exclusive identities for one legacy retry.
            identity["code"] = pairing_code(8);
            identity["legacy_code_length"] = 8;
            write_identity(options.identity_path, identity);
            // Lost responses and server faults retain the attempted code for recovery.
            try {
                return request("/bindings", identity);
            } catch (const RelayError& retry_error) {
                if (retry_error.status >= 400 && retry_error.status < 500) {
                    identity["code"] = code;
                    identity.erase("legacy_code_length");
                    write_identity(options.identity_path, identity);
                }
                throw;
            }
        }
    }
    bool wait_for_rate_limit() {
        if (!identity.is_object() || !identity.contains("retry_after"))
            return running;
        const double remaining = identity["retry_after"].get<double>() - unix_seconds();
        if (remaining > 2147483647.0)
            throw std::runtime_error("Invalid saved pairing retry deadline");
        if (remaining > 0) {
            const auto wait_us = int64_t(std::ceil(remaining * 1000000.0));
            {
                std::lock_guard lock(state_mutex);
                rate_limit_deadline_us = monotonic_us() + wait_us;
            }
            status("Rate limited", rate_limit_message(int64_t(std::ceil(remaining))));
            std::unique_lock queue_lock(queue_mutex);
            wake.wait_for(queue_lock, std::chrono::microseconds(wait_us),
                          [this] { return !running; });
            if (!running)
                return false;
        }
        identity.erase("retry_after");
        write_identity(options.identity_path, identity);
        {
            std::lock_guard lock(state_mutex);
            rate_limit_deadline_us = 0;
        }
        return running;
    }
    void create_identity() {
        for (int attempt = 0; attempt < 5; ++attempt) {
            identity = {{"version", 1},
                        {"bindingId", secret()},
                        {"deviceId", secret()},
                        {"secret", secret()},
                        {"invitationSecret", secret()},
                        {"code", pairing_code(legacy_code_relay == options.relay ? 8 : 9)},
                        {"label", options.name},
                        {"appOrigin", options.app_origin},
                        {"relay", options.relay},
                        {"invitation_expires", unix_seconds() + 300},
                        {"pending_creation", true},
                        {"paired", false}};
            if (legacy_code_relay == options.relay)
                identity["legacy_code_length"] = 8;
            write_identity(options.identity_path, identity);
            try {
                const auto session = register_pending_identity();
                validate_session(session);
                remember_code_format();
                identity["epoch"] = session["epoch"];
                identity["pending_creation"] = false;
                write_identity(options.identity_path, identity);
                update_invitation();
                return;
            } catch (const RelayError& error) {
                if (error.status != 409)
                    throw;
            }
        }
        throw RelayError(409, "Cannot allocate a receiver code");
    }
    void revoke_identity() {
        if (!identity.is_object())
            return;
        identity["revoked"] = true;
        write_identity(options.identity_path, identity);
        try {
            request(binding_path() + "/revoke", auth());
        } catch (const RelayError& error) {
            if (error.status != 403 && error.status != 404 && error.status != 410)
                throw;
        }
        std::filesystem::remove(options.identity_path);
        identity = Json();
    }
    void send_signal(const Json& signal) {
        if (!socket || !socket->isOpen())
            throw std::runtime_error("Pairing connection closed before setup completed");
        socket->send(
            Json{{"type", "signal"}, {"epoch", identity["epoch"]}, {"signal", signal}}.dump());
    }
    void close_connection() {
        ++generation;
        if (pose_channel) {
            pose_channel->resetCallbacks();
            pose_channel->close();
        }
        if (metadata_channel) {
            metadata_channel->resetCallbacks();
            metadata_channel->close();
        }
        if (depth_channel) {
            depth_channel->resetCallbacks();
            depth_channel->close();
        }
        for (auto& track : tracks) {
            track->resetCallbacks();
            track->close();
        }
        if (peer) {
            peer->resetCallbacks();
            peer->close();
        }
        if (socket) {
            socket->resetCallbacks();
            socket->forceClose();
        }
        pose_channel.reset();
        metadata_channel.reset();
        depth_channel.reset();
        depth_assembler.reset(0, 0);
        video_inputs.clear();
        tracks.clear();
        peer.reset();
        socket.reset();
        {
            std::lock_guard lock(queue_mutex);
            inputs.clear();
        }
        {
            std::lock_guard lock(state_mutex);
            current.connected = false;
            current.poses = {};
            current.clock = {};
            current.depth_status = "unsupported";
            current.depth_usage.clear();
            clock.reset();
        }
    }
    void begin_connection(uint32_t epoch) {
        close_connection();
        description_received = remote_set = local_end = remote_end = signal_done = signal_open =
            false;
        depth_control_supported = false;
        sent_depth_enabled.reset();
        pending_candidates.clear();
        mid_indices.clear();
        remote_mids.clear();
        pings.clear();
        space_epoch.reset();
        depth_assembler.reset(epoch, 0);
        last_ping = 0;
        head_history.clear();
        started = monotonic_us();
        disconnected = 0;
        {
            std::lock_guard lock(state_mutex);
            current.epoch = epoch;
            current.space_epoch = 0;
            current.camera = StreamDescription{};
        }
        SessionEvent event;
        event.kind = EventKind::Epoch;
        event.receive_us = event.time_us = started;
        event.epoch = epoch;
        event.attributes = {{"reason", "connection"}};
        emit(std::move(event));
        status("Pairing");
        update_invitation();
        rtc::Configuration config;
        config.disableAutoNegotiation = true;
        config.enableIceTcp = false;
        config.maxMessageSize = depth_fragment_bytes;
        peer = std::make_shared<rtc::PeerConnection>(config);
        const auto weak = weak_from_this();
        const auto gen = generation;
        peer->onLocalDescription([weak, gen](rtc::Description description) {
            if (auto self = weak.lock()) {
                auto message = input(InputKind::LocalDescription, gen);
                message.text = std::string(description);
                message.detail = description.typeString();
                self->enqueue(std::move(message));
            }
        });
        peer->onLocalCandidate([weak, gen](rtc::Candidate candidate) {
            if (auto self = weak.lock()) {
                auto message = input(InputKind::Candidate, gen);
                message.text = std::string(candidate);
                message.detail = candidate.mid();
                self->enqueue(std::move(message));
            }
        });
        peer->onGatheringStateChange([weak, gen](rtc::PeerConnection::GatheringState state) {
            if (state == rtc::PeerConnection::GatheringState::Complete)
                if (auto self = weak.lock())
                    self->enqueue(input(InputKind::Gathering, gen));
        });
        peer->onStateChange([weak, gen](rtc::PeerConnection::State state) {
            if (auto self = weak.lock()) {
                auto message = input(InputKind::PeerState, gen);
                message.number = static_cast<int>(state);
                self->enqueue(std::move(message));
            }
        });
        peer->onDataChannel([weak, gen](std::shared_ptr<rtc::DataChannel> channel) {
            if (auto self = weak.lock()) {
                auto message = input(InputKind::Channel, gen);
                message.channel = std::move(channel);
                self->enqueue(std::move(message));
            }
        });
        rtc::WebSocket::Configuration ws_config;
        ws_config.connectionTimeout = std::chrono::seconds(10);
        ws_config.maxMessageSize = 32768;
        if (identity.value("relay", options.relay).starts_with("https://"))
            ws_config.caCertificatePemFile = trusted_certificates();
        socket = std::make_shared<rtc::WebSocket>(ws_config);
        socket->onOpen([weak, gen]() {
            if (auto self = weak.lock())
                self->enqueue(input(InputKind::SignalOpen, gen));
        });
        socket->onClosed([weak, gen]() {
            if (auto self = weak.lock())
                self->enqueue(input(InputKind::SignalClosed, gen));
        });
        socket->onError([weak, gen](std::string) {
            if (auto self = weak.lock()) {
                auto message = input(InputKind::Failure, gen);
                message.text = "Pairing connection failed";
                self->enqueue(std::move(message));
            }
        });
        socket->onMessage([weak, gen](rtc::message_variant value) {
            if (auto self = weak.lock()) {
                auto message = input(InputKind::Signal, gen);
                if (auto* text = std::get_if<std::string>(&value))
                    message.text = std::move(*text);
                else {
                    message.kind = InputKind::Failure;
                    message.text = "Unexpected binary pairing message";
                }
                self->enqueue(std::move(message));
            }
        });
        auto url = identity.value("relay", options.relay);
        url.replace(0, url.starts_with("https:") ? 5 : 4, url.starts_with("https:") ? "wss" : "ws");
        socket->open(url + "/api/bridge/v1" + binding_path() + "/signal");
    }
    void add_candidate(const Json& value) {
        if (value.is_null()) {
            remote_end = true;
            return;
        }
        if (!value.is_object() || !value.contains("candidate") || !value["candidate"].is_string() ||
            value["candidate"].get_ref<const std::string&>().size() > 2048 ||
            !value.contains("sdpMLineIndex") || !value["sdpMLineIndex"].is_number_integer())
            throw std::runtime_error("Invalid remote ICE candidate");
        const auto index = value["sdpMLineIndex"].get<int>();
        if (index < 0 || size_t(index) >= remote_mids.size())
            throw std::runtime_error("Invalid remote ICE media index");
        peer->addRemoteCandidate(
            rtc::Candidate(value["candidate"].get<std::string>(), remote_mids[size_t(index)]));
    }
    void offer(const std::string& sdp) {
        if (remote_set || sdp.size() > 30000)
            throw std::runtime_error("Invalid Bridge offer");
        rtc::Description remote(sdp, "offer");
        if (remote.mediaCount() > 9)
            throw std::runtime_error("Bridge offer has too many media sections");
        size_t videos = 0;
        for (int i = 0; i < remote.mediaCount(); ++i) {
            auto entry = remote.media(i);
            if (auto* media = std::get_if<rtc::Description::Media*>(&entry)) {
                auto local = (*media)->reciprocate();
                remote_mids.push_back((*media)->mid());
                mid_indices[local.mid()] = i;
                if ((*media)->type() == "video") {
                    if (++videos > 2 || video_inputs.contains(local.mid()))
                        throw std::runtime_error(
                            "Bridge accepts at most two distinct camera tracks");
                    int selected = -1;
                    for (int pt : local.payloadTypes()) {
                        const auto* codec = local.rtpMap(pt);
                        if (codec && (codec->format == "H264" || codec->format == "h264") &&
                            std::any_of(
                                codec->fmtps.begin(), codec->fmtps.end(), [](const auto& p) {
                                    return p.find("packetization-mode=1") != std::string::npos;
                                })) {
                            selected = pt;
                            break;
                        }
                    }
                    if (selected < 0)
                        throw std::runtime_error(
                            "The sender did not offer H.264 packetisation mode 1");
                    RtcpCameraSession::Feedback feedback;
                    feedback.media_payload = selected;
                    const auto* media_codec = local.rtpMap(selected);
                    feedback.nack = std::find(media_codec->rtcpFbs.begin(), media_codec->rtcpFbs.end(),
                                              "nack") != media_codec->rtcpFbs.end();
                    feedback.remb = std::find(media_codec->rtcpFbs.begin(), media_codec->rtcpFbs.end(),
                                              "goog-remb") != media_codec->rtcpFbs.end();
                    for (int pt : local.payloadTypes()) {
                        const auto* codec = local.rtpMap(pt);
                        if (!feedback.nack || !codec || (codec->format != "rtx" && codec->format != "RTX"))
                            continue;
                        for (const auto& fmtp : codec->fmtps) {
                            std::istringstream parameters(fmtp);
                            for (std::string parameter; std::getline(parameters, parameter, ';');) {
                                const auto begin = parameter.find_first_not_of(" \t");
                                if (begin == std::string::npos || parameter.compare(begin, 4, "apt=") != 0)
                                    continue;
                                int associated = -1;
                                const auto result = std::from_chars(parameter.data() + begin + 4,
                                                                     parameter.data() + parameter.size(), associated);
                                if (result.ec == std::errc{} && associated == selected &&
                                    std::all_of(result.ptr, static_cast<const char*>(parameter.data()) + parameter.size(),
                                                [](char c) { return c == ' ' || c == '\t'; }))
                                    feedback.rtx_payload = pt;
                            }
                        }
                    }
                    for (const auto& attribute : (*media)->attributes()) {
                        if (!attribute.starts_with("ssrc-group:FID "))
                            continue;
                        std::istringstream sources(attribute.substr(15));
                        uint32_t primary = 0, repair = 0;
                        if (sources >> primary >> repair) {
                            feedback.media_ssrc = primary;
                            feedback.rtx_ssrc = repair;
                        }
                    }
                    // The pinned receiver supports receiver reports, REMB,
                    // generic NACK and PLI. Do not advertise unsupported TWCC.
                    std::erase_if(local.rtpMap(selected)->rtcpFbs, [](const std::string& value) {
                        return value != "nack" && value != "nack pli" && value != "goog-remb";
                    });
                    for (int id : local.extIds())
                        if (local.extMap(id)->uri.find("transport-wide-cc") != std::string::npos)
                            local.removeExtMap(id);
                    for (int pt : local.payloadTypes())
                        if (pt != selected && pt != feedback.rtx_payload)
                            local.removeRtpMap(pt);
                    local.setDirection(rtc::Description::Direction::RecvOnly);
                    auto track = peer->addTrack(local);
                    auto& camera_input = video_inputs[local.mid()];
                    camera_input.track = track;
                    camera_input.rtcp = std::make_shared<RtcpCameraSession>(feedback);
                    tracks.push_back(track);
                    track->setMediaHandler(camera_input.rtcp);
                    const auto weak = weak_from_this();
                    const auto gen = generation;
                    track->onMessage([weak, gen, mid = local.mid()](rtc::message_variant value) {
                        if (auto* bytes = std::get_if<rtc::binary>(&value))
                            if (auto self = weak.lock()) {
                                auto message = input(InputKind::Video, gen);
                                message.detail = mid;
                                message.bytes = std::move(*bytes);
                                self->enqueue(std::move(message));
                            }
                    });
                } else {
                    // This acquisition viewer negotiates the unused audio section inactive.
                    local.setDirection(rtc::Description::Direction::Inactive);
                    tracks.push_back(peer->addTrack(local));
                }
            } else {
                const auto* application = std::get<rtc::Description::Application*>(entry);
                remote_mids.push_back(application->mid());
                mid_indices[application->mid()] = i;
            }
        }
        if (!remote.hasApplication())
            throw std::runtime_error("Bridge offer requires data channels");
        peer->setRemoteDescription(remote);
        remote_set = true;
        for (const auto& value : pending_candidates)
            add_candidate(value);
        pending_candidates.clear();
        peer->setLocalDescription(rtc::Description::Type::Answer);
    }
    void channel(std::shared_ptr<rtc::DataChannel> value) {
        const auto reliability = value->reliability();
        InputKind kind;
        if (value->label() == "ceres.pose.v1" && reliability.unordered &&
            reliability.maxRetransmits == 0u && !pose_channel) {
            pose_channel = value;
            kind = InputKind::Pose;
        } else if (value->label() == "ceres.meta.v1" && !reliability.unordered &&
                   !reliability.maxRetransmits && !reliability.maxPacketLifeTime &&
                   !metadata_channel) {
            metadata_channel = value;
            kind = InputKind::Metadata;
        } else if (value->label() == "ceres-depth-v1" && reliability.unordered &&
                   reliability.maxRetransmits == 0u && !reliability.maxPacketLifeTime &&
                   !depth_channel) {
            depth_channel = value;
            kind = InputKind::Depth;
        } else {
            value->close();
            // Optional future channels must not invalidate the base Bridge session.
            return;
        }
        const auto weak = weak_from_this();
        const auto gen = generation;
        value->onMessage([weak, gen, kind](rtc::message_variant payload) {
            if (auto self = weak.lock()) {
                auto message = input(kind, gen);
                if (auto* text = std::get_if<std::string>(&payload))
                    message.text = std::move(*text);
                else
                    message.bytes = std::move(std::get<rtc::binary>(payload));
                self->enqueue(std::move(message));
            }
        });
        value->onClosed([weak, gen, kind]() {
            if (auto self = weak.lock()) {
                if (kind == InputKind::Depth)
                    return;
                auto message = input(InputKind::Failure, gen);
                message.text = "Bridge data channel closed";
                self->enqueue(std::move(message));
            }
        });
    }
    void metadata(const Input& message) {
        if (!message.bytes.empty())
            throw std::runtime_error("Unexpected binary Bridge metadata");
        const auto value = parse_metadata(message.text);
        if (value["epoch"] != identity["epoch"])
            throw std::runtime_error("Foreign Bridge metadata epoch");
        const auto type = value.value("type", std::string());
        if (type == "description") {
            auto description = parse_description(value);
            std::vector<std::string> video_mids;
            for (const auto& [mid, input] : video_inputs)
                video_mids.push_back(mid);
            description.cameras = camera_tracks(description, video_mids);
            {
                std::lock_guard lock(state_mutex);
                if (description_received && current.camera.raw != value)
                    throw std::runtime_error("Bridge description changed within one epoch");
                current.camera = description;
                current.depth_status =
                    value.contains("environment_depth") ? "waiting" : "unsupported";
            }
            if (!description_received)
                for (const auto& camera : description.cameras) {
                    auto& input = video_inputs.at(camera.mid);
                    input.description = camera;
                    // Frames before metadata have no declared identity. Restart each
                    // dependency chain and time anchor once the identity is accepted.
                    input.assembler.reset();
                    input.force_keyframe = true;
                }
            description_received = true;
            SessionEvent event;
            event.kind = EventKind::Metadata;
            event.receive_us = event.time_us = message.received_us;
            event.epoch = identity["epoch"].get<uint32_t>();
            event.space_epoch = space_epoch.value_or(0);
            event.attributes = value;
            event.payload.assign(message.text.begin(), message.text.end());
            emit(std::move(event));
            depth_control_supported = value.contains("environment_depth") &&
                value.contains("depth_control_version") &&
                value["depth_control_version"].is_number_integer() &&
                value["depth_control_version"] == 1;
            Json acknowledgement{{"type", "ack"}, {"version", 1}, {"epoch", identity["epoch"]},
                                 {"depth_metadata_version", 2}};
            if (depth_control_supported) {
                const bool enabled = depth_enabled.load();
                acknowledgement["depth_control_version"] = 1;
                acknowledgement["depth_enabled"] = enabled;
                sent_depth_enabled = enabled;
            }
            metadata_channel->send(acknowledgement.dump());
        } else if (type == "depth-status") {
            {
                std::lock_guard lock(state_mutex);
                if (!description_received || !current.camera.raw.contains("environment_depth"))
                    return;
                current.depth_status = value.at("status").get<std::string>();
                current.depth_usage =
                    value.at("usage").is_string() ? value.at("usage").get<std::string>() : "";
            }
            SessionEvent event;
            event.kind = EventKind::Metadata;
            event.receive_us = event.time_us = message.received_us;
            event.epoch = identity["epoch"].get<uint32_t>();
            event.space_epoch = space_epoch.value_or(0);
            event.attributes = value;
            emit(std::move(event));
        } else if (type == "pong") {
            const auto id = value["id"].get<uint32_t>();
            const auto found = pings.find(id);
            if (found == pings.end() || found->second != value["t0"].get<int64_t>())
                return;
            const auto t0 = found->second, t1 = value["t1"].get<int64_t>(),
                       t2 = value["t2"].get<int64_t>();
            pings.erase(found);
            ClockMapping mapping;
            {
                std::lock_guard lock(state_mutex);
                if (!clock.add(t0, t1, t2, message.received_us))
                    return;
                mapping = clock.mapping(message.received_us);
                current.clock = mapping;
            }
            SessionEvent event;
            event.kind = EventKind::Clock;
            event.receive_us = event.time_us = message.received_us;
            event.epoch = identity["epoch"].get<uint32_t>();
            event.space_epoch = space_epoch.value_or(0);
            event.attributes = {{"offset_us", mapping.offset_us},
                                {"uncertainty_us", mapping.uncertainty_us},
                                {"rate", mapping.rate},
                                {"valid", mapping.valid},
                                {"t0", t0},
                                {"t1", t1},
                                {"t2", t2},
                                {"t3", message.received_us}};
            emit(std::move(event));
        } else
            throw std::runtime_error("Unexpected receiver metadata message");
    }
    void pose(const Input& message) {
        if (!message.text.empty())
            throw std::runtime_error("Unexpected text on Bridge pose channel");
        const auto bytes = std::span<const uint8_t>(
            reinterpret_cast<const uint8_t*>(message.bytes.data()), message.bytes.size());
        PoseSample sample;
        try {
            sample = decode_pose(bytes, message.received_us);
        } catch (const std::exception&) {
            std::lock_guard lock(state_mutex);
            ++current.rejected;
            return;
        }
        ClockMapping mapping;
        bool new_space = false;
        {
            std::lock_guard lock(state_mutex);
            if (!description_received || sample.epoch != current.epoch ||
                (space_epoch && sample.space_epoch != *space_epoch &&
                 !newer_sequence(sample.space_epoch, *space_epoch))) {
                ++current.rejected;
                return;
            }
            if (!space_epoch || sample.space_epoch != *space_epoch) {
                space_epoch = sample.space_epoch;
                current.space_epoch = sample.space_epoch;
                current.poses = {};
                new_space = true;
                head_history.clear();
            }
            const auto& previous = current.poses[sample.kind - 1];
            if (previous && !newer_sequence(sample.sequence, previous->sequence)) {
                ++current.rejected;
                return;
            }
            mapping = clock.mapping(message.received_us);
        }
        if (new_space) {
            depth_assembler.reset(sample.epoch, sample.space_epoch);
            SessionEvent event;
            event.kind = EventKind::Epoch;
            event.receive_us = event.time_us = message.received_us;
            event.epoch = sample.epoch;
            event.space_epoch = sample.space_epoch;
            event.attributes = {{"reason", "reference-space"}};
            emit(std::move(event));
        }
        SessionEvent event;
        event.kind = EventKind::Pose;
        event.receive_us = message.received_us;
        event.time_us = mapping.valid
                            ? static_cast<int64_t>(double(sample.observed_us) * mapping.rate +
                                                   mapping.offset_us)
                            : message.received_us;
        event.epoch = sample.epoch;
        event.space_epoch = sample.space_epoch;
        event.sequence = sample.sequence;
        event.stream = sample.kind == 1 ? "head" : sample.kind == 2 ? "left" : "right";
        event.payload.assign(bytes.begin(), bytes.end());
        event.attributes = {{"clock_valid", mapping.valid},
                            {"clock_uncertainty_us", mapping.uncertainty_us}};
        emit(std::move(event));
        if (sample.kind == 1) {
            head_history.push_back(sample);
            while (head_history.size() > 256)
                head_history.pop_front();
        }
        {
            std::lock_guard lock(state_mutex);
            current.poses[sample.kind - 1] = sample;
            ++current.received;
        }
    }
    void depth(const Input& message) {
        try {
            if (!message.text.empty())
                throw std::runtime_error("Unexpected text on Bridge depth channel");
            ClockMapping mapping;
            {
                std::lock_guard lock(state_mutex);
                if (!description_received || !space_epoch ||
                    !current.camera.raw.contains("environment_depth"))
                    return;
                mapping = clock.mapping(message.received_us);
            }
            const auto bytes = std::span<const uint8_t>(
                reinterpret_cast<const uint8_t*>(message.bytes.data()), message.bytes.size());
            auto frame = depth_assembler.push(bytes, message.received_us);
            if (!frame)
                return;
            auto event = make_depth_event(std::move(*frame), message.received_us, mapping);
            const auto size = event.payload.size();
            const auto usage = event.attributes.at("usage").get<std::string>();
            // The sink records every complete frame before presentation may replace it.
            emit(std::move(event));
            std::lock_guard lock(state_mutex);
            ++current.depth_frames;
            current.depth_bytes += size;
            current.depth_status = "streaming";
            current.depth_usage = usage;
        } catch (const std::exception&) {
            std::lock_guard lock(state_mutex);
            ++current.depth_rejected;
        }
    }
    void video(CameraInput& input, std::vector<H264AccessUnit> frames) {
        if (!input.description)
            return;
        const auto& camera = *input.description;
        for (auto& frame : frames) {
            SessionEvent event;
            event.kind = EventKind::Video;
            event.receive_us = frame.received_us;
            event.time_us = frame.time_us;
            event.epoch = identity["epoch"].get<uint32_t>();
            event.space_epoch = space_epoch.value_or(0);
            event.sequence = input.sequence++;
            event.rtp_timestamp = frame.rtp_timestamp;
            event.keyframe = frame.keyframe;
            event.stream = camera.stream;
            event.attributes = {{"codec", "h264"},
                                {"rtp_clock_hz", 90000},
                                {"rtp_extended_timestamp", frame.extended_timestamp},
                                {"camera_side", camera.side},
                                {"camera_mid", camera.mid},
                                {"camera_primary", camera.primary},
                                {"video_time_domain", "receiver-arrival-anchored-rtp"},
                                {"capture_synchronised", false},
                                {"pts_us", frame.time_us}};
            if (input.assembler_ssrc) {
                event.attributes["rtp_ssrc"] = *input.assembler_ssrc;
                if (const auto report =
                        input.rtcp->clock.report(*input.assembler_ssrc, frame.received_us))
                    if (const auto sender_time = sender_media_time_us(
                            frame.rtp_timestamp, report->rtp_timestamp, report->ntp_timestamp)) {
                        event.attributes["sender_ntp_us"] = *sender_time;
                        event.attributes["sender_report_ntp"] = report->ntp_timestamp;
                        event.attributes["sender_report_rtp"] = report->rtp_timestamp;
                        event.attributes["sender_report_seen_us"] = report->received_us;
                        event.attributes["sender_time_domain"] = "rtcp-sender-report-ntp";
                    }
            }
            ClockMapping mapping;
            {
                std::lock_guard lock(state_mutex);
                mapping = clock.mapping(frame.received_us);
            }
            if (mapping.valid) {
                const PoseSample* nearest = nullptr;
                double age = 50000.0;
                for (const auto& head : head_history) {
                    if (!head.valid || head.epoch != event.epoch ||
                        head.space_epoch != event.space_epoch)
                        continue;
                    const double distance = std::abs(double(head.observed_us) * mapping.rate +
                                                     mapping.offset_us - double(frame.time_us));
                    if (distance + mapping.uncertainty_us <= age) {
                        nearest = &head;
                        age = distance + mapping.uncertainty_us;
                    }
                }
                if (nearest) {
                    event.attributes["head_pose"] =
                        std::vector<float>(nearest->values.begin(), nearest->values.begin() + 7);
                    event.attributes["head_sequence"] = nearest->sequence;
                    event.attributes["head_age_us"] = age;
                }
            }
            event.payload = std::move(frame.bytes);
            const auto bytes = event.payload.size();
            emit(std::move(event));
            {
                std::lock_guard lock(state_mutex);
                ++current.video_frames;
                current.video_bytes += bytes;
            }
        }
    }
    void handle(const Input& message) {
        switch (message.kind) {
        case InputKind::SignalOpen: {
            signal_open = true;
            auto registration = auth();
            registration.update(
                {{"type", "register"}, {"version", 1}, {"epoch", identity["epoch"]}});
            socket->send(registration.dump());
            break;
        }
        case InputKind::SignalClosed:
            if (!signal_done)
                throw std::runtime_error("Pairing connection closed before setup completed");
            break;
        case InputKind::Failure:
            if (!signal_done || message.text != "Pairing connection failed")
                throw std::runtime_error(message.text);
            break;
        case InputKind::Signal: {
            if (message.text.size() > 32768)
                throw std::runtime_error("Pairing message exceeds its budget");
            const auto value = Json::parse(message.text, nullptr, false);
            if (value.is_discarded())
                throw std::runtime_error("Invalid Bridge signalling JSON");
            if (!value.is_object() || value.value("epoch", Json()) != identity["epoch"])
                break;
            if (value.value("type", std::string()) == "signal") {
                const auto& signal = value.at("signal");
                if (signal.value("type", std::string()) == "offer")
                    offer(signal.at("sdp").get<std::string>());
                else if (signal.contains("candidate")) {
                    if (remote_set)
                        add_candidate(signal["candidate"]);
                    else if (pending_candidates.size() < 64)
                        pending_candidates.push_back(signal["candidate"]);
                    else
                        throw std::runtime_error("Too many remote ICE candidates");
                } else
                    throw std::runtime_error("Unexpected Bridge signal");
            }
            break;
        }
        case InputKind::LocalDescription:
            send_signal({{"type", message.detail}, {"sdp", message.text}});
            break;
        case InputKind::Candidate: {
            const auto it = mid_indices.find(message.detail);
            if (it == mid_indices.end())
                throw std::runtime_error("Invalid local ICE media index");
            send_signal({{"candidate",
                          {{"candidate", message.text},
                           {"sdpMid", message.detail},
                           {"sdpMLineIndex", it->second}}}});
            break;
        }
        case InputKind::Gathering:
            send_signal({{"candidate", nullptr}});
            local_end = true;
            break;
        case InputKind::PeerState: {
            const auto state = static_cast<rtc::PeerConnection::State>(message.number);
            if (state == rtc::PeerConnection::State::Connected) {
                disconnected = 0;
                {
                    std::lock_guard lock(state_mutex);
                    current.connected = true;
                }
                if (signal_done)
                    status("Streaming");
            } else if (state == rtc::PeerConnection::State::Disconnected) {
                disconnected = message.received_us;
                status("Reconnecting");
            } else if (state == rtc::PeerConnection::State::Failed ||
                       state == rtc::PeerConnection::State::Closed)
                throw std::runtime_error("Bridge media connection ended");
            break;
        }
        case InputKind::Channel:
            channel(message.channel);
            break;
        case InputKind::Pose:
            pose(message);
            break;
        case InputKind::Metadata:
            metadata(message);
            break;
        case InputKind::Depth:
            depth(message);
            break;
        case InputKind::Video: {
            const auto found = video_inputs.find(message.detail);
            if (found == video_inputs.end())
                throw std::runtime_error("Video arrived on an undeclared camera track");
            auto& input = found->second;
            const auto packet = std::span<const uint8_t>(
                reinterpret_cast<const uint8_t*>(message.bytes.data()), message.bytes.size());
            if (const auto ssrc = rtp_source(packet))
                input.assembler_ssrc = *ssrc;
            video(input, input.assembler.push(packet, message.received_us));
            break;
        }
        }
    }
    void pump() {
        while (running && !new_pairing) {
            {
                std::unique_lock lock(queue_mutex);
                wake.wait_for(lock, std::chrono::milliseconds(5), [this] {
                    return !inputs.empty() || !running || new_pairing || overflow;
                });
            }
            if (overflow.exchange(false))
                throw std::runtime_error("Receiver input queue exceeded its bounded capacity");
            // Recheck the priority lanes between every media packet. Swapping
            // a whole video burst into a local batch delays hands arriving later.
            const auto service_until = monotonic_us() + 2000;
            for (size_t count = 0; count < 256 && running && !new_pairing; ++count) {
                std::optional<Input> message;
                {
                    std::lock_guard lock(queue_mutex);
                    message = inputs.pop();
                }
                if (!message)
                    break;
                if (message->generation == generation)
                    handle(*message);
                if (monotonic_us() >= service_until)
                    break;
            }
            const auto now = monotonic_us();
            depth_assembler.expire(now);
            for (auto& [mid, input] : video_inputs)
                video(input, input.assembler.flush(now));
            const bool connected = peer && peer->state() == rtc::PeerConnection::State::Connected;
            if (!signal_done && connected && description_received && local_end && remote_end) {
                signal_done = true;
                identity["paired"] = true;
                identity.erase("code");
                identity.erase("invitationSecret");
                identity.erase("invitation_expires");
                write_identity(options.identity_path, identity);
                update_invitation();
                {
                    std::lock_guard lock(state_mutex);
                    current.connected = true;
                }
                status("Streaming");
                socket->close();
            }
            if (description_received && depth_control_supported && metadata_channel &&
                metadata_channel->isOpen()) {
                const bool enabled = depth_enabled.load();
                if (sent_depth_enabled != enabled) {
                    metadata_channel->send(Json{{"type", "depth-control"}, {"version", 1},
                                               {"epoch", identity["epoch"]},
                                               {"enabled", enabled}}.dump());
                    sent_depth_enabled = enabled;
                }
            }
            if (description_received && metadata_channel && metadata_channel->isOpen() &&
                now - last_ping >= 250000) {
                last_ping = now;
                ++ping_id;
                pings[ping_id] = now;
                while (pings.size() > 8)
                    pings.erase(pings.begin());
                metadata_channel->send(Json{
                    {"type", "ping"},
                    {"version", 1},
                    {"epoch", identity["epoch"]},
                    {"id", ping_id},
                    {"t0", now}}.dump());
            }
            const bool request_all = external_keyframe.exchange(false);
            for (auto& [mid, input] : video_inputs) {
                input.rtcp->tick(now);
                input.force_keyframe |= request_all;
                if (input.track->isOpen() && now - input.last_pli >= 200000 &&
                    (input.force_keyframe || input.assembler.take_keyframe_request())) {
                    input.force_keyframe = false;
                    input.assembler.take_keyframe_request();
                    input.last_pli = now;
                    input.track->requestKeyframe();
                }
            }
            if (disconnected && now - disconnected >= 3000000)
                throw std::runtime_error("Bridge connection was interrupted");
            if (!signal_done && now - started > 30000000)
                throw std::runtime_error("Waiting for the headset to connect");
            if (!identity.value("paired", false) &&
                identity.value("invitation_expires", 0.0) <= unix_seconds())
                return;
        }
    }
    void run() {
        try {
            prepare_identity_directory(options.identity_path);
            IdentityLock lock(options.identity_path);
            identity = read_identity(options.identity_path);
            legacy_code_relay.clear();
            if (identity.is_object() && !identity.value("pending_creation", false))
                remember_code_format();
            if (identity.is_object() && identity.value("pending_creation", false) &&
                (identity.value("relay", std::string()) == "https://ceres.cam" ||
                 identity.value("relay", std::string()) == "https://ceres.wtf") &&
                options.relay == "https://ceres.ceres-relay.workers.dev") {
                identity["relay"] = options.relay;
                write_identity(options.identity_path, identity);
            }
            int64_t retry_delay_seconds = 3;
            while (running) {
                // The persisted deadline applies before revocation, fresh pairing
                // and session recovery, including after a process restart.
                if (!wait_for_rate_limit())
                    break;
                int64_t wait_seconds = 0;
                bool terminal = false;
                try {
                    const bool fresh_pairing = new_pairing.exchange(false);
                    if (fresh_pairing) {
                        legacy_code_relay.clear();
                        if (identity.is_object())
                            identity.erase("legacy_code_length");
                    }
                    if (fresh_pairing || (identity.is_object() && identity.value("revoked", false)))
                        revoke_identity();
                    if (!identity.is_object())
                        create_identity();
                    Json session;
                    auto request_body = auth();
                    if (identity.contains("epoch"))
                        request_body["restartAfter"] = identity["epoch"];
                    try {
                        session = request(binding_path() + "/session", request_body);
                    } catch (const RelayError& error) {
                        if (error.status == 403 || error.status == 404 || error.status == 410) {
                            // Recover an invitation whose create response was lost, or one that
                            // expired.
                            if (identity.value("pending_creation", false) && error.status == 404) {
                                if (identity.value("invitation_expires", 0.0) <= unix_seconds()) {
                                    identity["invitation_expires"] = unix_seconds() + 300;
                                    write_identity(options.identity_path, identity);
                                }
                                session = register_pending_identity();
                            } else {
                                identity = Json();
                                create_identity();
                                session = request(binding_path() + "/session", auth());
                            }
                        } else
                            throw;
                    }
                    validate_session(session);
                    remember_code_format();
                    retry_delay_seconds = 3;
                    identity["pending_creation"] = false;
                    identity["epoch"] = session["epoch"];
                    identity["paired"] = session["paired"];
                    if (!session["paired"].get<bool>() &&
                        identity.value("invitation_expires", 0.0) <= unix_seconds()) {
                        revoke_identity();
                        create_identity();
                        continue;
                    }
                    if (session["paired"].get<bool>()) {
                        identity.erase("code");
                        identity.erase("invitationSecret");
                        identity.erase("invitation_expires");
                    }
                    write_identity(options.identity_path, identity);
                    begin_connection(session["epoch"].get<uint32_t>());
                    pump();
                    close_connection();
                    if (new_pairing)
                        continue;
                } catch (const RelayError& error) {
                    close_connection();
                    if (error.status == 429) {
                        identity["retry_after"] = unix_seconds() + error.retry_after_seconds;
                        write_identity(options.identity_path, identity);
                        continue;
                    } else if (error.status >= 400 && error.status < 500) {
                        terminal = true;
                        if (running)
                            status("Error", error.what());
                    } else {
                        wait_seconds = retry_delay_seconds;
                        retry_delay_seconds = std::min<int64_t>(60, retry_delay_seconds * 2);
                        if (running)
                            status("Reconnecting", error.what());
                    }
                } catch (const std::exception& error) {
                    close_connection();
                    wait_seconds = retry_delay_seconds;
                    retry_delay_seconds = std::min<int64_t>(60, retry_delay_seconds * 2);
                    if (running)
                        status("Reconnecting", error.what());
                }
                std::unique_lock queue_lock(queue_mutex);
                if (terminal)
                    wake.wait(queue_lock, [this] { return !running || new_pairing; });
                else
                    wake.wait_for(queue_lock, std::chrono::seconds(wait_seconds),
                                  [this] { return !running || new_pairing; });
            }
            close_connection();
            status("Disconnected");
        } catch (const std::exception& error) {
            try {
                close_connection();
                status("Error", error.what());
            } catch (...) {
            }
        }
        running = false;
    }
};

BridgeClient::BridgeClient(BridgeOptions options)
    : impl_(std::make_shared<Impl>(std::move(options))) {}
BridgeClient::~BridgeClient() {
    stop();
}
void BridgeClient::start() {
    std::lock_guard lock(impl_->lifecycle_mutex);
    if (impl_->running.exchange(true))
        return;
    if (impl_->thread.joinable())
        impl_->thread.join();
    auto owner = impl_;
    impl_->thread = std::thread([owner] { owner->run(); });
}
void BridgeClient::stop() {
    std::lock_guard lock(impl_->lifecycle_mutex);
    impl_->running = false;
    impl_->wake.notify_all();
    if (impl_->thread.joinable() && impl_->thread.get_id() != std::this_thread::get_id())
        impl_->thread.join();
}
ReceiverSnapshot BridgeClient::snapshot() const {
    std::lock_guard lock(impl_->state_mutex);
    auto result = impl_->current;
    result.now_us = monotonic_us();
    if (result.connection == "Rate limited")
        result.error = rate_limit_message(
            std::max<int64_t>(0, (impl_->rate_limit_deadline_us - result.now_us + 999999) / 1000000));
    result.clock = impl_->clock.mapping(result.now_us);
    return result;
}
void BridgeClient::set_event_sink(EventSink sink) {
    std::lock_guard lock(impl_->sink_mutex);
    impl_->sink = std::move(sink);
}
void BridgeClient::fresh_pairing() {
    impl_->new_pairing = true;
    impl_->wake.notify_all();
}
void BridgeClient::request_keyframe() {
    impl_->external_keyframe = true;
    impl_->wake.notify_all();
}
void BridgeClient::set_depth_enabled(bool enabled) {
    if (impl_->depth_enabled.exchange(enabled) != enabled)
        impl_->wake.notify_all();
}
std::string BridgeClient::state() const {
    return snapshot().connection;
}
} // namespace ceres
