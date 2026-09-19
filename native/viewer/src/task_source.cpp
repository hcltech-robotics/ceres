#include "ceres/task_specification.hpp"
#include <curl/curl.h>
#include <algorithm>
#include <cctype>
#include <memory>
#include <stdexcept>

namespace ceres {
namespace {
constexpr long connect_timeout_ms = 5000;
constexpr long total_timeout_ms = 15000;
constexpr long maximum_redirects = 3;

bool starts_with_scheme(std::string_view source, std::string_view scheme) {
    return source.size() >= scheme.size() &&
           std::equal(scheme.begin(), scheme.end(), source.begin(), [](char expected, char value) {
               return expected == std::tolower(static_cast<unsigned char>(value));
           });
}

void check_cancelled(std::stop_token cancel) {
    if (cancel.stop_requested())
        throw std::runtime_error("Task loading cancelled");
}

struct CurlRuntime {
    CurlRuntime() {
        if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK)
            throw std::runtime_error("Cannot initialise task downloads");
    }
    ~CurlRuntime() {
        curl_global_cleanup();
    }
};

struct Response {
    std::string text;
    std::stop_token cancel;
    bool too_large = false;
    bool failed = false;
};

size_t receive_body(char* bytes, size_t size, size_t count, void* context) noexcept {
    auto& response = *static_cast<Response*>(context);
    if (response.cancel.stop_requested())
        return 0;
    if (size != 0 && count > task_import_max_bytes / size) {
        response.too_large = true;
        return 0;
    }
    const auto length = size * count;
    if (length > task_import_max_bytes - response.text.size()) {
        response.too_large = true;
        return 0;
    }
    try {
        response.text.append(bytes, length);
        return length;
    } catch (...) {
        response.failed = true;
        return 0;
    }
}

std::string download(const std::string& source, std::stop_token cancel) {
    static CurlRuntime runtime;
    (void)runtime;
    std::unique_ptr<CURLU, decltype(&curl_url_cleanup)> url(curl_url(), curl_url_cleanup);
    if (!url || source.find('\0') != std::string::npos ||
        curl_url_set(url.get(), CURLUPART_URL, source.c_str(), 0) != CURLUE_OK)
        throw std::runtime_error("The task URL is invalid");
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> handle(curl_easy_init(), curl_easy_cleanup);
    if (!handle)
        throw std::runtime_error("Cannot initialise the task download");
    Response response{{}, cancel};
    const auto option = [&](CURLoption name, auto value) {
        if (curl_easy_setopt(handle.get(), name, value) != CURLE_OK)
            throw std::runtime_error("Cannot configure the task download");
    };
    option(CURLOPT_URL, source.c_str());
    option(CURLOPT_PROTOCOLS_STR, "http,https");
    option(CURLOPT_REDIR_PROTOCOLS_STR, "http,https");
    option(CURLOPT_FOLLOWLOCATION, 1L);
    option(CURLOPT_MAXREDIRS, maximum_redirects);
    option(CURLOPT_CONNECTTIMEOUT_MS, connect_timeout_ms);
    option(CURLOPT_TIMEOUT_MS, total_timeout_ms);
    option(CURLOPT_NOSIGNAL, 1L);
    option(CURLOPT_SSL_VERIFYPEER, 1L);
    option(CURLOPT_SSL_VERIFYHOST, 2L);
    option(CURLOPT_FAILONERROR, 1L);
    option(CURLOPT_USERAGENT, "CeresViewer/1");
    option(CURLOPT_ACCEPT_ENCODING, "identity");
    option(CURLOPT_MAXFILESIZE_LARGE, static_cast<curl_off_t>(task_import_max_bytes));
    option(CURLOPT_WRITEFUNCTION, receive_body);
    option(CURLOPT_WRITEDATA, &response);
    option(CURLOPT_NOPROGRESS, 0L);
    option(CURLOPT_XFERINFOFUNCTION,
           +[](void* context, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int {
               return static_cast<Response*>(context)->cancel.stop_requested() ? 1 : 0;
           });
    option(CURLOPT_XFERINFODATA, &response);
    check_cancelled(cancel);
    const auto result = curl_easy_perform(handle.get());
    check_cancelled(cancel);
    if (response.too_large || result == CURLE_FILESIZE_EXCEEDED)
        throw std::runtime_error("The task download is larger than 1 MB");
    if (response.failed)
        throw std::runtime_error("Cannot store the downloaded task specification");
    if (result == CURLE_OPERATION_TIMEDOUT)
        throw std::runtime_error("The task download timed out. Check the URL and try again");
    if (result == CURLE_TOO_MANY_REDIRECTS)
        throw std::runtime_error("The task URL redirects too many times");
    if (result == CURLE_UNSUPPORTED_PROTOCOL)
        throw std::runtime_error("The task URL and its redirects must use HTTP or HTTPS");
    if (result == CURLE_URL_MALFORMAT)
        throw std::runtime_error("The task URL or a redirect is invalid. Use HTTP or HTTPS");
    long status = 0;
    curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &status);
    if (status >= 400)
        throw std::runtime_error("The task server returned HTTP " + std::to_string(status));
    if (result != CURLE_OK)
        throw std::runtime_error(std::string("Cannot download the task specification: ") +
                                 curl_easy_strerror(result));
    if (status < 200 || status >= 300)
        throw std::runtime_error("The task server returned HTTP " + std::to_string(status));
    return response.text;
}
} // namespace

bool is_task_specification_url(std::string_view source) {
    return starts_with_scheme(source, "http://") || starts_with_scheme(source, "https://");
}

TaskSpecification load_task_specification_source(const std::string& source, std::stop_token cancel) {
    check_cancelled(cancel);
    if (source.empty())
        throw std::runtime_error("Enter a task file path or an HTTP/HTTPS URL");
    if (!is_task_specification_url(source)) {
        if (source.find("://") != std::string::npos)
            throw std::runtime_error("Use a local task file or an HTTP/HTTPS URL");
        auto result = load_task_specification(std::filesystem::u8path(source));
        check_cancelled(cancel);
        return result;
    }
    const auto text = download(source, cancel);
    Json value;
    try {
        value = Json::parse(text);
    } catch (const Json::parse_error&) {
        throw std::runtime_error("The task URL did not return valid JSON");
    }
    check_cancelled(cancel);
    return parse_task_specification(value);
}
} // namespace ceres
