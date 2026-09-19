#include "ceres/task_specification.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <fstream>
#include <future>
#include <iostream>
#include <stdexcept>
#include <thread>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {
using namespace ceres;
using namespace std::chrono_literals;

void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

template <class Action> void rejects(Action action, std::string_view expected) {
    try {
        action();
    } catch (const std::exception& error) {
        if (std::string_view(error.what()).find(expected) != std::string_view::npos)
            return;
        throw std::runtime_error("Expected task import error containing '" + std::string(expected) +
                                 "', received: " + error.what());
    }
    throw std::runtime_error("Task import should have failed: " + std::string(expected));
}

Json document() {
    return {{"schema", "ceres-task-specification"},
            {"version", 1},
            {"runTitle", "Remote assembly"},
            {"cycleCount", 2},
            {"tasks", {{{"id", "pick"}, {"type", "open"}, {"label", "Pick"},
                        {"instructions", "Pick up the part."}, {"repeatCount", 3},
                        {"resetTimeS", 5}}}}};
}

#ifdef _WIN32
using Socket = SOCKET;
constexpr Socket no_socket = INVALID_SOCKET;
void close_socket(Socket socket) { closesocket(socket); }
struct SocketRuntime {
    SocketRuntime() {
        WSADATA data{};
        check(WSAStartup(MAKEWORD(2, 2), &data) == 0, "Cannot initialise fixture sockets");
    }
    ~SocketRuntime() { WSACleanup(); }
};
#else
using Socket = int;
constexpr Socket no_socket = -1;
void close_socket(Socket socket) { close(socket); }
struct SocketRuntime {};
#endif

struct OwnedSocket {
    Socket value = no_socket;
    ~OwnedSocket() {
        if (value != no_socket)
            close_socket(value);
    }
};

bool readable(Socket socket) {
    fd_set read{};
    FD_ZERO(&read);
    FD_SET(socket, &read);
    timeval timeout{0, 100000};
#ifdef _WIN32
    return select(0, &read, nullptr, nullptr, &timeout) > 0;
#else
    return select(socket + 1, &read, nullptr, nullptr, &timeout) > 0;
#endif
}

void send_all(Socket socket, std::string_view bytes) {
    while (!bytes.empty()) {
        const auto size = static_cast<int>(std::min<size_t>(bytes.size(), 16384));
#ifdef _WIN32
        const int sent = send(socket, bytes.data(), size, 0);
#else
        const auto sent = send(socket, bytes.data(), size, MSG_NOSIGNAL);
#endif
        if (sent <= 0)
            return;
        bytes.remove_prefix(static_cast<size_t>(sent));
    }
}

class TaskServer {
  public:
    TaskServer() {
        listener_.value = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        check(listener_.value != no_socket, "Cannot create task fixture listener");
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        check(bind(listener_.value, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0 &&
                  listen(listener_.value, 4) == 0,
              "Cannot bind task fixture listener");
#ifdef _WIN32
        int length = sizeof(address);
#else
        socklen_t length = sizeof(address);
#endif
        check(getsockname(listener_.value, reinterpret_cast<sockaddr*>(&address), &length) == 0,
              "Cannot read task fixture port");
        origin_ = "http://127.0.0.1:" + std::to_string(ntohs(address.sin_port));
        worker_ = std::jthread([this](std::stop_token stop) {
            while (!stop.stop_requested()) {
                if (!readable(listener_.value))
                    continue;
                OwnedSocket client{accept(listener_.value, nullptr, nullptr)};
                if (client.value != no_socket)
                    serve(client.value, stop);
            }
        });
    }

    std::string url(std::string_view path) const { return origin_ + std::string(path); }
    std::atomic<bool> slow_started = false;

  private:
    SocketRuntime runtime_;
    OwnedSocket listener_;
    std::string origin_;
    std::jthread worker_;

    void serve(Socket client, std::stop_token stop) {
        std::string request;
        const auto deadline = std::chrono::steady_clock::now() + 2s;
        std::array<char, 4096> buffer{};
        while (!stop.stop_requested() && std::chrono::steady_clock::now() < deadline &&
               request.find("\r\n\r\n") == std::string::npos) {
            if (!readable(client))
                continue;
            const auto count = recv(client, buffer.data(), static_cast<int>(buffer.size()), 0);
            if (count <= 0)
                return;
            request.append(buffer.data(), static_cast<size_t>(count));
            if (request.size() > 16384)
                return;
        }
        const auto end = request.find(' ', 4);
        if (!request.starts_with("GET ") || end == std::string::npos)
            return;
        const auto path = request.substr(4, end - 4);
        std::string status = "200 OK", extra, body = document().dump();
        if (path == "/redirect") {
            status = "302 Found";
            extra = "Location: /valid\r\n";
            body = "This redirect body is not JSON";
        } else if (path == "/loop") {
            status = "302 Found";
            extra = "Location: /loop\r\n";
            body.clear();
        } else if (path == "/file-redirect") {
            status = "302 Found";
            extra = "Location: file:///not-a-task.json\r\n";
            body.clear();
        } else if (path == "/missing") {
            status = "404 Not Found";
            body = "No task here";
        } else if (path == "/malformed") {
            body = "<html>Use the raw JSON link</html>";
        } else if (path == "/invalid") {
            auto invalid = document();
            invalid["cycleCount"] = 0;
            body = invalid.dump();
        } else if (path == "/legacy") {
            body = Json{{"schema", "ceres-run-v5"},
                        {"configuration", {{"runTitle", "Remote legacy"}, {"totalCycles", 4}}}}
                       .dump();
        } else if (path == "/limit") {
            body.resize(task_import_max_bytes, ' ');
        } else if (path == "/too-large") {
            send_all(client, "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: " +
                                 std::to_string(task_import_max_bytes + 1) + "\r\n\r\n");
            return;
        } else if (path == "/large-stream") {
            send_all(client, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
            send_all(client, std::string(task_import_max_bytes + 1, ' '));
            return;
        } else if (path == "/slow") {
            slow_started.store(true);
            const auto finish = std::chrono::steady_clock::now() + 3s;
            while (!stop.stop_requested() && std::chrono::steady_clock::now() < finish)
                std::this_thread::sleep_for(10ms);
            if (stop.stop_requested())
                return;
        }
        send_all(client, "HTTP/1.1 " + status + "\r\nConnection: close\r\n" + extra +
                             "Content-Type: application/json\r\nContent-Length: " +
                             std::to_string(body.size()) + "\r\n\r\n" + body);
    }
};

void source_import() {
    check(is_task_specification_url("HTTP://localhost/task.json") &&
              is_task_specification_url("https://example.test/task.json?raw=1") &&
              !is_task_specification_url("D:/tasks/task.json") &&
              !is_task_specification_url("task.json"),
          "Task source classification changed");
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto path = std::filesystem::temp_directory_path() /
                      ("ceres-task-source-" + std::to_string(nonce) + ".json");
    struct Cleanup {
        std::filesystem::path path;
        ~Cleanup() {
            std::error_code ignored;
            std::filesystem::remove(path, ignored);
        }
    } cleanup{path};
    {
        std::ofstream output(path);
        output << document().dump();
    }
    const auto utf8 = path.u8string();
    check(load_task_specification_source(std::string(utf8.begin(), utf8.end())).to_json() ==
              document(),
          "Local task source did not preserve file loading");
    rejects([] { load_task_specification_source(""); }, "Enter a task file path");
    rejects([] { load_task_specification_source("ftp://example.test/task.json"); }, "HTTP/HTTPS");
    rejects([] { load_task_specification_source("https://"); }, "URL is invalid");
    std::stop_source cancelled;
    cancelled.request_stop();
    rejects([&] { load_task_specification_source("https://example.test/task.json",
                                                cancelled.get_token()); },
            "cancelled");

    TaskServer server;
    check(load_task_specification_source(server.url("/valid?raw=1")).to_json() == document(),
          "Remote task did not use the canonical validator");
    auto authenticated = server.url("/valid");
    authenticated.insert(std::string("http://").size(), "fixture:fixture@");
    check(load_task_specification_source(authenticated).to_json() == document(),
          "Task URL credentials prevented ordinary HTTP loading");
    check(load_task_specification_source(server.url("/redirect")).to_json() == document(),
          "Redirected task did not load");
    const auto legacy = load_task_specification_source(server.url("/legacy"));
    check(legacy.run_title == "Remote legacy" && legacy.cycle_count == 4,
          "Remote CERES run files did not use the legacy validator");
    rejects([&] { load_task_specification_source(server.url("/missing")); }, "HTTP 404");
    rejects([&] { load_task_specification_source(server.url("/malformed")); }, "valid JSON");
    rejects([&] { load_task_specification_source(server.url("/invalid")); }, "cycleCount");
    rejects([&] { load_task_specification_source(server.url("/loop")); }, "too many times");
    rejects([&] { load_task_specification_source(server.url("/file-redirect")); }, "HTTP or HTTPS");
    check(load_task_specification_source(server.url("/limit")).to_json() == document(),
          "A task document at the byte limit was rejected");
    rejects([&] { load_task_specification_source(server.url("/too-large")); }, "larger than 1 MB");
    rejects([&] { load_task_specification_source(server.url("/large-stream")); }, "larger than 1 MB");
    std::stop_source stop;
    auto loading = std::async(std::launch::async, [&] {
        rejects([&] { load_task_specification_source(server.url("/slow"), stop.get_token()); },
                "cancelled");
    });
    const auto deadline = std::chrono::steady_clock::now() + 3s;
    while (!server.slow_started.load() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(10ms);
    check(server.slow_started.load(), "Task cancellation fixture did not receive a request");
    stop.request_stop();
    check(loading.wait_for(2s) == std::future_status::ready, "Task download cancellation was delayed");
    loading.get();
}
} // namespace

int main() {
    try {
        source_import();
        std::cout << "PASS: task file and URL loading, redirects, limits, validation and cancellation\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
