#include "ceres/bridge.hpp"
#include "ceres/protocol.hpp"
#include "ceres/rtcp_clock.hpp"
#include "depth_fixture.hpp"
#include <rtc/rtc.hpp>
#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstring>
#include <ctime>
#include <fstream>
#include <iostream>
#include <mutex>
#include <thread>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wincrypt.h>
#include <aclapi.h>
using Socket = SOCKET;
constexpr auto no_socket = INVALID_SOCKET;
static void close_socket(Socket value) {
    closesocket(value);
}
#else
#include <arpa/inet.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
using Socket = int;
constexpr auto no_socket = -1;
static void close_socket(Socket value) {
    close(value);
}
#endif
using ceres::Json;
using namespace std::chrono_literals;
namespace {
void check(bool condition, const char* error) {
    if (!condition)
        throw std::runtime_error(error);
}
template <class F> void until(F condition, const char* error, std::chrono::seconds timeout = 12s) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (!condition()) {
        if (std::chrono::steady_clock::now() >= deadline)
            throw std::runtime_error(error);
        std::this_thread::sleep_for(5ms);
    }
}
bool send_all(Socket socket, const char* bytes, size_t size) {
#ifdef _WIN32
    constexpr int flags = 0;
#else
    constexpr int flags = MSG_NOSIGNAL;
#endif
    while (size) {
        const int sent = ::send(socket, bytes, static_cast<int>(size), flags);
        if (sent <= 0)
            return false;
        bytes += sent;
        size -= size_t(sent);
    }
    return true;
}
Socket listener(uint16_t& port) {
    Socket socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    check(socket != no_socket, "Cannot create fixture listener");
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(port);
    check(bind(socket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0,
          "Cannot bind fixture listener");
    check(listen(socket, 8) == 0, "Cannot listen for fixture requests");
#ifdef _WIN32
    int length = sizeof(address);
#else
    socklen_t length = sizeof(address);
#endif
    check(getsockname(socket, reinterpret_cast<sockaddr*>(&address), &length) == 0,
          "Cannot read fixture port");
    port = ntohs(address.sin_port);
    return socket;
}
std::string header(std::string text, std::string key) {
    std::transform(text.begin(), text.end(), text.begin(),
                   [](unsigned char c) { return char(std::tolower(c)); });
    const auto begin = text.find("\r\n" + key + ":");
    if (begin == std::string::npos)
        return {};
    const auto at = begin + key.size() + 3, end = text.find("\r\n", at);
    return text.substr(at, end - at);
}
rtc::binary binary(const std::vector<uint8_t>& value) {
    rtc::binary result(value.size());
    std::memcpy(result.data(), value.data(), value.size());
    return result;
}
void put(std::vector<uint8_t>& bytes, size_t at, uint64_t value, int count) {
    for (int i = 0; i < count; ++i)
        bytes[at + size_t(i)] = uint8_t(value >> (8 * i));
}
std::vector<uint8_t> packet(const Json& fixtures, int kind, uint32_t epoch, uint32_t space,
                            uint32_t sequence) {
    const auto hex = fixtures.at(size_t(kind * 2 - 1)).at("hex").get<std::string>();
    std::vector<uint8_t> bytes;
    for (size_t i = 0; i < hex.size(); i += 2)
        bytes.push_back(uint8_t(std::stoul(hex.substr(i, 2), nullptr, 16)));
    put(bytes, 8, epoch, 4);
    put(bytes, 12, space, 4);
    put(bytes, 16, sequence, 4);
    const auto now = ceres::monotonic_us() + 4000000;
    put(bytes, 24, uint64_t(now), 8);
    put(bytes, 32, uint64_t(now + 20000), 8);
    return bytes;
}
Json description(uint32_t epoch, int fps = 30, bool dual = false) {
    Json joints = Json::array();
    for (const auto joint : ceres::bridge_joints)
        joints.push_back(joint);
    Json value{
        {"type", "description"},
        {"version", 1},
        {"epoch", epoch},
        {"clock",
         {{"id", "fixture-clock"}, {"units", "microseconds"}, {"domain", "sender-monotonic"}}},
        {"referenceSpace", "local-floor"},
        {"axes", "right-handed-x-right-y-up-z-back"},
        {"units", "metres"},
        {"quaternion", "xyzw"},
        {"joints", joints},
        {"camera",
         {{"side", "left"},
          {"width", 640},
          {"height", 480},
          {"requestedWidth", 640},
          {"fps", fps},
          {"calibration", nullptr}}}};
    if (dual) {
        value["camera"]["side"] = "right";
        auto right = value["camera"], left = right;
        right["mid"] = "camera";
        left["mid"] = "camera-left";
        left["side"] = "left";
        value["cameras"] = {right, left};
    }
    return value;
}
struct Sender {
    std::shared_ptr<rtc::PeerConnection> peer;
    std::shared_ptr<rtc::DataChannel> pose, meta, depth;
    std::shared_ptr<rtc::Track> video, secondary;
    std::shared_ptr<rtc::WebSocket> socket;
    std::shared_ptr<rtc::RtpPacketizationConfig> rtp, secondary_rtp;
    uint32_t epoch = 0;
    std::atomic<bool> answered = false, ready = false, request_intra = false;
    std::atomic<bool> request_secondary_intra = false;
    std::mutex mutex;
    std::vector<Json> pending;
    std::vector<Json> received_metadata;
    std::vector<Json> metadata_messages() {
        std::lock_guard lock(mutex);
        return received_metadata;
    }
    void close() {
        if (pose) {
            pose->resetCallbacks();
            pose->close();
        }
        if (meta) {
            meta->resetCallbacks();
            meta->close();
        }
        if (depth) {
            depth->resetCallbacks();
            depth->close();
        }
        if (video) {
            video->resetCallbacks();
            video->close();
        }
        if (secondary) {
            secondary->resetCallbacks();
            secondary->close();
        }
        if (peer) {
            peer->resetCallbacks();
            peer->close();
        }
        if (socket) {
            socket->resetCallbacks();
            socket->forceClose();
        }
    }
    void signal(Json value) {
        if (socket->isOpen())
            socket->send(
                Json{{"type", "signal"}, {"epoch", epoch}, {"signal", std::move(value)}}.dump());
    }
};
// The HTTP fixture forwards only upgraded sockets to libdatachannel's WebSocket server.
// Both ends still negotiate real ICE, DTLS, SCTP and SRTP on loopback.
class Relay {
  public:
    explicit Relay(uint16_t requested_port = 0, int stream_fps = 0, bool dual_camera = false,
                   bool native_depth = false, bool depth_demand = false)
        : port(requested_port), fps(stream_fps), dual(dual_camera), depth_only(native_depth),
          depth_control(depth_demand) {
#ifdef _WIN32
        WSADATA data{};
        check(WSAStartup(MAKEWORD(2, 2), &data) == 0, "Cannot initialise fixture sockets");
#endif
        listen_socket = listener(port);
    }
    ~Relay() {
        stop();
#ifdef _WIN32
        WSACleanup();
#endif
    }
    std::string origin() const {
        return "http://127.0.0.1:" + std::to_string(port);
    }
    void start() {
        rtc::WebSocketServer::Configuration config;
        config.port = 0;
        config.bindAddress = "127.0.0.1";
        websockets = std::make_unique<rtc::WebSocketServer>(config);
        websockets->onClient([this](auto socket) {
            {
                std::lock_guard lock(mutex);
                sockets.push_back(socket);
            }
            socket->onMessage([this, weak = std::weak_ptr(socket)](rtc::message_variant data) {
                try {
                    if (auto ws = weak.lock())
                        if (auto* text = std::get_if<std::string>(&data))
                            signalling(ws, Json::parse(*text));
                } catch (const std::exception& e) {
                    std::lock_guard lock(mutex);
                    failure = e.what();
                }
            });
        });
        accepting = std::thread([this] {
            while (running) {
                auto socket = accept(listen_socket, nullptr, nullptr);
                if (socket == no_socket)
                    break;
                connections.emplace_back([this, socket] {
                    serve(socket);
                    close_socket(socket);
                });
            }
        });
    }
    void stop() {
        if (!running.exchange(false))
            return;
#ifdef _WIN32
        shutdown(listen_socket, SD_BOTH);
#else
        shutdown(listen_socket, SHUT_RDWR);
#endif
        close_socket(listen_socket);
        listen_socket = no_socket;
        if (accepting.joinable())
            accepting.join();
        for (auto& thread : connections)
            if (thread.joinable())
                thread.join();
        if (websockets) {
            websockets->onClient({});
            websockets->stop();
        }
        std::vector<std::shared_ptr<Sender>> peers;
        std::vector<std::shared_ptr<rtc::WebSocket>> old_sockets;
        {
            std::lock_guard lock(mutex);
            peers = senders;
            old_sockets = sockets;
        }
        for (auto& peer : peers)
            peer->close();
        for (auto& socket : old_sockets) {
            socket->resetCallbacks();
            socket->forceClose();
        }
    }
    std::shared_ptr<Sender> current_sender() {
        std::lock_guard lock(mutex);
        return senders.empty() ? nullptr : senders.back();
    }
    Json current_identity() {
        std::lock_guard lock(mutex);
        return identity;
    }
    int created_count() {
        std::lock_guard lock(mutex);
        return creates;
    }
    void reject_next_creation() {
        std::lock_guard lock(mutex);
        reject_creation = true;
    }
    int creation_attempt_count() {
        std::lock_guard lock(mutex);
        return creation_attempts;
    }
    std::vector<Json> attempted_identities() {
        std::lock_guard lock(mutex);
        return creation_requests;
    }
    int http_request_count() {
        std::lock_guard lock(mutex);
        return http_requests;
    }
    void legacy_codes_only(bool enabled = true) {
        std::lock_guard lock(mutex);
        legacy_codes = enabled;
    }
    void unpair() {
        std::lock_guard lock(mutex);
        paired = false;
    }
    void creation_failure(int status, std::string reason = {}, std::string retry = {},
                          bool malformed = false) {
        std::lock_guard lock(mutex);
        failure_status = status;
        failure_reason = std::move(reason);
        retry_after = std::move(retry);
        malformed_response = malformed;
    }
    int revoked_count() {
        std::lock_guard lock(mutex);
        return revokes;
    }
    int registration_count() {
        std::lock_guard lock(mutex);
        return registrations;
    }
    std::string error() {
        std::lock_guard lock(mutex);
        return failure;
    }

  private:
    Socket listen_socket = no_socket;
    uint16_t port = 0;
    int fps = 0;
    bool dual = false;
    bool depth_only = false;
    bool depth_control = false;
    std::atomic<bool> running = true;
    std::unique_ptr<rtc::WebSocketServer> websockets;
    std::thread accepting;
    std::vector<std::thread> connections;
    std::mutex mutex;
    std::vector<std::shared_ptr<rtc::WebSocket>> sockets;
    std::vector<std::shared_ptr<Sender>> senders;
    Json identity;
    uint32_t epoch = 1;
    bool paired = false;
    bool reject_creation = false;
    bool legacy_codes = false, malformed_response = false;
    int failure_status = 0, http_requests = 0;
    std::string failure_reason, retry_after;
    std::vector<Json> creation_requests;
    int creation_attempts = 0;
    int creates = 0, revokes = 0, registrations = 0;
    std::string failure;
    Json request(const std::string& path, const Json& body) {
        std::lock_guard lock(mutex);
        ++http_requests;
        if (path == "/api/bridge/v1/bindings") {
            const auto code = body.at("code").get<std::string>();
            check((code.size() == 9 || code.size() == 8) &&
                      code.find_first_not_of("ABCDEFGHJKMNPQRSTUVWXYZ") == std::string::npos,
                  "Invitation code must contain unambiguous letters");
            const auto now = std::chrono::duration<double>(
                                 std::chrono::system_clock::now().time_since_epoch())
                                 .count();
            const auto lifetime = body.at("invitation_expires").get<double>() - now;
            check(lifetime > 290 && lifetime <= 300, "Invitation expiry differs");
            ++creation_attempts;
            creation_requests.push_back(body);
            if (failure_status) {
                Json response{{"status", failure_status},
                              {"error", failure_reason == "reflect-secret" ? body.at("secret") :
                                            failure_reason == "oversized" ? Json(std::string(9000, 'x')) :
                                            Json(failure_reason)},
                              {"_retry_after", retry_after}};
                if (malformed_response)
                    response["_raw"] = "{invalid-json";
                return response;
            }
            if (code.size() != (legacy_codes ? 8u : 9u))
                return {{"error", "Invalid Bridge invitation"}, {"status", 400}};
            if (reject_creation) {
                reject_creation = false;
                return {{"error", "Code already allocated"}, {"status", 409}};
            }
            identity = body;
            epoch = 1;
            paired = false;
            ++creates;
        } else {
            if (identity.is_null())
                return {{"error", "Binding not found"}, {"status", 404}};
            check(path.starts_with("/api/bridge/v1/bindings/" +
                                   identity.at("bindingId").get<std::string>() + "/"),
                  "Wrong persistent binding path");
            check(body.at("secret") == identity.at("secret") &&
                      body.at("deviceId") == identity.at("deviceId") &&
                      body.at("role") == "receiver",
                  "Receiver authentication differs");
            if (path.ends_with("/revoke")) {
                ++revokes;
                return {{"ok", true}};
            }
            check(path.ends_with("/session"), "Unexpected relay route");
            if (body.contains("restartAfter") && body.at("restartAfter").get<uint32_t>() >= epoch)
                ++epoch;
        }
        return {{"version", 1},
                {"bindingId", identity.at("bindingId")},
                {"epoch", epoch},
                {"paired", paired}};
    }
    void serve(Socket socket) {
        try {
            std::string incoming;
            std::array<char, 8192> bytes{};
            while (running && incoming.find("\r\n\r\n") == std::string::npos) {
                const int count = recv(socket, bytes.data(), int(bytes.size()), 0);
                if (count <= 0)
                    return;
                incoming.append(bytes.data(), size_t(count));
                check(incoming.size() <= 16384, "Oversized HTTP fixture request");
            }
            const auto end = incoming.find("\r\n\r\n");
            if (end == std::string::npos)
                return;
            if (header(incoming.substr(0, end + 2), "upgrade").find("websocket") !=
                std::string::npos) {
                Socket target = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
                check(target != no_socket, "Cannot create WebSocket proxy");
                sockaddr_in address{};
                address.sin_family = AF_INET;
                address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
                address.sin_port = htons(websockets->port());
                if (connect(target, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
                    close_socket(target);
                    return;
                }
                send_all(target, incoming.data(), incoming.size());
                while (running) {
                    fd_set reads;
                    FD_ZERO(&reads);
                    FD_SET(socket, &reads);
                    FD_SET(target, &reads);
                    timeval timeout{0, 100000};
                    const int result = select(int(std::max(socket, target) + 1), &reads, nullptr,
                                              nullptr, &timeout);
                    if (result < 0)
                        break;
                    if (!result)
                        continue;
                    bool active = true;
                    for (const auto from : {socket, target})
                        if (FD_ISSET(from, &reads)) {
                            const int count = recv(from, bytes.data(), int(bytes.size()), 0);
                            if (count <= 0 || !send_all(from == socket ? target : socket,
                                                        bytes.data(), size_t(count))) {
                                active = false;
                                break;
                            }
                        }
                    if (!active)
                        break;
                }
                close_socket(target);
                return;
            }
            const auto length = header(incoming.substr(0, end + 2), "content-length");
            const size_t size = length.empty() ? 0 : std::stoul(length);
            check(size <= 8192, "Oversized fixture body");
            while (incoming.size() < end + 4 + size) {
                const int count = recv(socket, bytes.data(), int(bytes.size()), 0);
                if (count <= 0)
                    return;
                incoming.append(bytes.data(), size_t(count));
            }
            const auto first = incoming.find(' '), last = incoming.find(' ', first + 1);
            const auto path = incoming.substr(first + 1, last - first - 1);
            auto response_json = request(path, Json::parse(incoming.substr(end + 4, size)));
            const auto status = response_json.value("status", 200);
            const auto retry = response_json.value("_retry_after", std::string());
            const auto raw = response_json.value("_raw", std::string());
            response_json.erase("status");
            response_json.erase("_retry_after");
            response_json.erase("_raw");
            const auto response = raw.empty() ? response_json.dump() : raw;
            const auto reply =
                std::string("HTTP/1.1 ") + std::to_string(status) + " Fixture response\r\n" +
                (retry.empty() ? std::string() : "Retry-After: " + retry + "\r\n") +
                "Content-Type: application/json\r\nConnection: close\r\nContent-Length: " +
                std::to_string(response.size()) + "\r\n\r\n" + response;
            send_all(socket, reply.data(), reply.size());
        } catch (const std::exception& e) {
            std::lock_guard lock(mutex);
            failure = e.what();
        }
    }
    void signalling(const std::shared_ptr<rtc::WebSocket>& socket, const Json& message) {
        if (message.at("type") == "register") {
            auto sender = std::make_shared<Sender>();
            sender->socket = socket;
            {
                std::lock_guard lock(mutex);
                check(message.at("version") == 1 && message.at("epoch") == epoch &&
                          message.at("secret") == identity.at("secret") &&
                          message.at("deviceId") == identity.at("deviceId"),
                      "WebSocket authentication differs");
                sender->epoch = epoch;
                paired = true;
                ++registrations;
                senders.push_back(sender);
            }
            socket->send(Json{{"type", "registered"}, {"epoch", sender->epoch}}.dump());
            rtc::Configuration config;
            config.disableAutoNegotiation = true;
            config.bindAddress = "127.0.0.1";
            config.maxMessageSize = ceres::depth_fragment_bytes;
            sender->peer = std::make_shared<rtc::PeerConnection>(config);
            const auto weak = std::weak_ptr(sender);
            sender->peer->onLocalDescription([weak](rtc::Description value) {
                if (auto self = weak.lock())
                    self->signal({{"type", value.typeString()}, {"sdp", std::string(value)}});
            });
            sender->peer->onLocalCandidate(
                [weak, dual = dual, depth_only = depth_only](rtc::Candidate value) {
                    if (auto self = weak.lock())
                        self->signal({{"candidate",
                                       {{"candidate", std::string(value)},
                                        {"sdpMid", value.mid()},
                                        {"sdpMLineIndex", depth_only                     ? 0
                                                          : value.mid() == "camera"      ? 0
                                                          : value.mid() == "camera-left" ? 1
                                                          : dual                         ? 2
                                                                                         : 1}}}});
                });
            sender->peer->onGatheringStateChange([weak](rtc::PeerConnection::GatheringState value) {
                if (value == rtc::PeerConnection::GatheringState::Complete)
                    if (auto self = weak.lock())
                        self->signal({{"candidate", nullptr}});
            });
            if (!depth_only) {
                rtc::Description::Video video("camera", rtc::Description::Direction::SendOnly);
                video.addH264Codec(96);
                video.addSSRC(42, "fixture", "fixture", "camera");
                sender->video = sender->peer->addTrack(video);
            }
            if (dual) {
                rtc::Description::Video left("camera-left", rtc::Description::Direction::SendOnly);
                left.addH264Codec(96);
                left.addSSRC(43, "fixture", "fixture-left", "camera-left");
                sender->secondary = sender->peer->addTrack(left);
            }
            if (fps) {
                sender->rtp =
                    std::make_shared<rtc::RtpPacketizationConfig>(42, "fixture", 96, 90000);
                auto packetiser = std::make_shared<rtc::H264RtpPacketizer>(
                    rtc::NalUnit::Separator::LongStartSequence, sender->rtp);
                packetiser->addToChain(std::make_shared<rtc::RtcpSrReporter>(sender->rtp));
                packetiser->addToChain(std::make_shared<rtc::RtcpNackResponder>());
                packetiser->addToChain(std::make_shared<rtc::PliHandler>([weak] {
                    if (auto self = weak.lock())
                        self->request_intra = true;
                }));
                sender->video->setMediaHandler(packetiser);
                if (dual) {
                    sender->secondary_rtp =
                        std::make_shared<rtc::RtpPacketizationConfig>(43, "fixture", 96, 90000);
                    auto secondary = std::make_shared<rtc::H264RtpPacketizer>(
                        rtc::NalUnit::Separator::LongStartSequence, sender->secondary_rtp);
                    secondary->addToChain(
                        std::make_shared<rtc::RtcpSrReporter>(sender->secondary_rtp));
                    secondary->addToChain(std::make_shared<rtc::RtcpNackResponder>());
                    secondary->addToChain(std::make_shared<rtc::PliHandler>([weak] {
                        if (auto self = weak.lock())
                            self->request_secondary_intra = true;
                    }));
                    sender->secondary->setMediaHandler(secondary);
                }
            }
            rtc::DataChannelInit unreliable;
            unreliable.reliability.unordered = true;
            unreliable.reliability.maxRetransmits = 0;
            sender->pose = sender->peer->createDataChannel("ceres.pose.v1", unreliable);
            sender->meta = sender->peer->createDataChannel("ceres.meta.v1");
            if (depth_only)
                sender->depth = sender->peer->createDataChannel("ceres-depth-v1", unreliable);
            sender->meta->onOpen(
                [weak, rate = fps ? fps : 30, dual = dual, depth_only = depth_only,
                 depth_control = depth_control] {
                    if (auto self = weak.lock()) {
                        auto metadata = description(self->epoch, rate, dual);
                        if (depth_only) {
                            metadata.erase("camera");
                            metadata["environment_depth"] = {{"version", 1},
                                                             {"channel", "ceres-depth-v1"},
                                                             {"format", "uint16-mm"},
                                                             {"max_width", 256},
                                                             {"max_height", 256}};
                            if (depth_control)
                                metadata["depth_control_version"] = 1;
                        }
                        self->meta->send(metadata.dump());
                    }
                });
            sender->meta->onMessage([weak](rtc::message_variant data) {
                if (auto self = weak.lock())
                    if (auto* text = std::get_if<std::string>(&data)) {
                        const auto message = Json::parse(*text);
                        {
                            std::lock_guard lock(self->mutex);
                            self->received_metadata.push_back(message);
                        }
                        if (message.at("type") == "ping") {
                            const auto now = ceres::monotonic_us() + 4000000;
                            self->meta->send(Json{
                                {"type", "pong"},
                                {"version", 1},
                                {"epoch", self->epoch},
                                {"id", message.at("id")},
                                {"t0", message.at("t0")},
                                {"t1", now},
                                {"t2", now}}.dump());
                        }
                    }
            });
            sender->peer->setLocalDescription(rtc::Description::Type::Offer);
            sender->ready = true;
            return;
        }
        std::shared_ptr<Sender> sender;
        {
            std::lock_guard lock(mutex);
            for (const auto& candidate : senders)
                if (candidate->socket == socket)
                    sender = candidate;
        }
        check(bool(sender), "Signal arrived before receiver registration");
        const auto& signal = message.at("signal");
        std::lock_guard lock(sender->mutex);
        auto candidate = [&](const Json& value) {
            if (!value.is_null())
                sender->peer->addRemoteCandidate(
                    rtc::Candidate(value.at("candidate").get<std::string>(),
                                   value.at("sdpMid").get<std::string>()));
        };
        if (signal.value("type", std::string()) == "answer") {
            sender->peer->setRemoteDescription(
                rtc::Description(signal.at("sdp").get<std::string>(), "answer"));
            sender->answered = true;
            for (const auto& value : sender->pending)
                candidate(value);
            sender->pending.clear();
        } else if (signal.contains("candidate")) {
            if (sender->answered)
                candidate(signal.at("candidate"));
            else
                sender->pending.push_back(signal.at("candidate"));
        }
    }
};
Json identity_protected(const std::filesystem::path& path, const Json& expected) {
    std::ifstream input(path, std::ios::binary);
    check(bool(input), "Receiver identity was not persisted");
    const std::string bytes(std::istreambuf_iterator<char>(input), {});
#ifdef _WIN32
    check(bytes.find(expected.at("secret").get<std::string>()) == std::string::npos,
          "Receiver secret is present in clear text");
    DATA_BLOB encrypted{DWORD(bytes.size()),
                        reinterpret_cast<BYTE*>(const_cast<char*>(bytes.data()))},
        clear{};
    check(CryptUnprotectData(&encrypted, nullptr, nullptr, nullptr, nullptr,
                             CRYPTPROTECT_UI_FORBIDDEN, &clear) != 0,
          "Identity is not protected by Windows DPAPI");
    const auto decoded = Json::parse(clear.pbData, clear.pbData + clear.cbData);
    SecureZeroMemory(clear.pbData, clear.cbData);
    LocalFree(clear.pbData);
    check(decoded.at("secret") == expected.at("secret"), "Protected receiver secret differs");
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL acl = nullptr;
    check(GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
                                nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS,
          "Cannot inspect receiver permissions");
    SECURITY_DESCRIPTOR_CONTROL control{};
    DWORD revision = 0;
    const bool protected_acl = GetSecurityDescriptorControl(descriptor, &control, &revision) &&
                               (control & SE_DACL_PROTECTED);
    const bool private_acl = acl && acl->AceCount == 2;
    LocalFree(descriptor);
    check(protected_acl && private_acl, "Receiver ACL is not private");
#else
    struct stat status {};
    check(stat(path.c_str(), &status) == 0 && (status.st_mode & 0777) == 0600 &&
              status.st_uid == getuid(),
          "Receiver identity mode is not private");
    const auto decoded = Json::parse(bytes);
    check(decoded.at("secret") == expected.at("secret"),
          "Private receiver secret differs");
#endif
    return decoded;
}

void write_test_identity(const std::filesystem::path& path, const Json& identity) {
    auto clear = identity.dump();
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    check(bool(output), "Cannot update fixture identity");
#ifdef _WIN32
    DATA_BLOB input{DWORD(clear.size()), reinterpret_cast<BYTE*>(clear.data())}, encrypted{};
    check(CryptProtectData(&input, L"Ceres viewer receiver fixture", nullptr, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &encrypted) != 0,
          "Cannot protect fixture identity");
    output.write(reinterpret_cast<const char*>(encrypted.pbData), encrypted.cbData);
    LocalFree(encrypted.pbData);
#else
    output << clear;
#endif
    std::fill(clear.begin(), clear.end(), '\0');
    output.close();
    check(bool(output), "Cannot save fixture identity");
}

struct ReceiverStop {
    ceres::BridgeClient& receiver;
    ~ReceiverStop() {
        receiver.stop();
    }
};

void remove_test_identity(const std::filesystem::path& path) {
    std::filesystem::remove(path);
    std::filesystem::remove(std::filesystem::path(path.string() + ".lock"));
}

void pairing_compatibility_tests(const std::filesystem::path& directory) {
    for (const bool pending : {false, true}) {
        Relay relay;
        relay.legacy_codes_only();
        ceres::BridgeOptions options;
        options.app_origin = options.relay = relay.origin();
        options.identity_path = directory / (pending ? "legacy-pending.identity" : "legacy.identity");
        relay.start();
        if (pending) {
            relay.creation_failure(400, "Invalid Bridge JSON");
            ceres::BridgeClient interrupted(options);
            ReceiverStop stopped{interrupted};
            interrupted.start();
            until([&] { return interrupted.snapshot().connection == "Error"; },
                  "Pending invitation did not stop after a terminal rejection");
            interrupted.stop();
            check(relay.creation_attempt_count() == 1,
                  "Unrelated rejection attempted legacy registration");
            identity_protected(options.identity_path, relay.attempted_identities().front());
            relay.creation_failure(0);
        }
        ceres::BridgeClient receiver(options);
        ReceiverStop stopped{receiver};
        receiver.start();
        until([&] { return receiver.snapshot().connected; },
              "Legacy service did not accept the compatible invitation");
        const auto attempts = relay.attempted_identities();
        const size_t first = pending ? 1 : 0;
        check(attempts.size() == first + 2 && attempts[first].at("code").get<std::string>().size() == 9 &&
                  attempts[first + 1].at("code").get<std::string>().size() == 8,
              "Legacy negotiation did not make exactly one eight-letter retry");
        for (const char* field : {"bindingId", "deviceId", "secret", "invitationSecret", "invitation_expires"}) {
            check(attempts[first].at(field) == attempts[first + 1].at(field),
                  "Legacy negotiation replaced an exclusive identity or its expiry");
            if (pending)
                check(attempts.front().at(field) == attempts[first].at(field),
                      "Pending recovery discarded its saved identity");
        }
        identity_protected(options.identity_path, relay.current_identity());
        if (!pending) {
            relay.legacy_codes_only(false);
            receiver.fresh_pairing();
            until([&] { return relay.created_count() == 2 && receiver.snapshot().connected; },
                  "Fresh pairing did not retry the current service format");
            const auto refreshed = relay.attempted_identities();
            check(refreshed.size() == 3 && refreshed.back().at("code").get<std::string>().size() == 9,
                  "Legacy negotiation permanently downgraded new invitations");
        }
        check(relay.error().empty(), "Legacy service fixture rejected receiver behaviour");
        receiver.stop();
        relay.stop();
        remove_test_identity(options.identity_path);
    }
}

void pairing_rotation_tests(const std::filesystem::path& directory) {
    for (const bool negotiated : {true, false}) {
        Relay relay;
        relay.legacy_codes_only();
        ceres::BridgeOptions options;
        options.app_origin = options.relay = relay.origin();
        options.identity_path = directory / (negotiated ? "legacy-rotation.identity" : "old-legacy.identity");
        relay.start();
        ceres::BridgeClient receiver(options);
        ReceiverStop stopped{receiver};
        receiver.start();
        until([&] { return receiver.snapshot().connected; }, "Rotation fixture did not pair");
        receiver.stop();
        const auto invitation = relay.current_identity();
        auto saved = identity_protected(options.identity_path, invitation);
        check(saved.value("legacy_code_length", 0) == 8,
              "Successful legacy negotiation was not persisted");
        saved["paired"] = false;
        saved["code"] = invitation.at("code");
        saved["invitationSecret"] = invitation.at("invitationSecret");
        saved["invitation_expires"] = 1;
        if (!negotiated) {
            saved.erase("legacy_code_length");
            relay.legacy_codes_only(false);
        }
        write_test_identity(options.identity_path, saved);
        relay.unpair();
        receiver.start();
        until([&] { return relay.created_count() == 2 && receiver.snapshot().connected; },
              "Expired invitation did not rotate");
        const auto attempts = relay.attempted_identities();
        check(attempts.size() == 3 &&
                  attempts.back().at("code").get<std::string>().size() == (negotiated ? 8u : 9u),
              "Automatic rotation ignored negotiated format or inferred it from an old code");
        check(relay.revoked_count() == 1 && relay.error().empty(),
              "Automatic rotation made unnecessary registrations");
        receiver.stop();
        relay.stop();
        remove_test_identity(options.identity_path);
    }

    Relay relay;
    relay.creation_failure(400, "Invalid Bridge JSON");
    ceres::BridgeOptions options;
    options.app_origin = options.relay = relay.origin();
    options.identity_path = directory / "expired-pending.identity";
    relay.start();
    ceres::BridgeClient receiver(options);
    ReceiverStop stopped{receiver};
    receiver.start();
    until([&] { return receiver.snapshot().connection == "Error"; },
          "Pending expiry fixture did not save an identity");
    receiver.stop();
    const auto attempted = relay.attempted_identities().front();
    auto saved = identity_protected(options.identity_path, attempted);
    saved["invitation_expires"] = 1;
    write_test_identity(options.identity_path, saved);
    relay.creation_failure(0);
    receiver.start();
    until([&] { return receiver.snapshot().connected; }, "Expired pending identity did not recover");
    const auto attempts = relay.attempted_identities();
    check(attempts.size() == 2 && relay.created_count() == 1 && relay.revoked_count() == 0,
          "Expired pending identity consumed additional registrations");
    for (const char* field : {"bindingId", "deviceId", "secret", "invitationSecret", "code"})
        check(attempts[0].at(field) == attempts[1].at(field),
              "Pending expiry recovery discarded a saved identity");
    check(relay.error().empty(), "Pending expiry recovery did not renew the invitation lifetime");
    receiver.stop();
    relay.stop();
    remove_test_identity(options.identity_path);
}

void pairing_error_tests(const std::filesystem::path& directory) {
    struct Rejection { int status; const char* reason; bool malformed; int attempts; };
    const Rejection cases[] = {{400, "Invalid Bridge JSON", false, 1},
                               {400, "Invalid Bridge invitation", true, 1},
                               {401, "Invalid Bridge invitation", false, 1},
                               {403, "Invalid Bridge invitation", false, 1},
                               {400, "reflect-secret", false, 1},
                               {400, "Invalid Bridge invitation", false, 2},
                               {409, "Bridge code is already allocated", false, 5},
                               {400, "oversized", false, 1}};
    for (size_t index = 0; index < std::size(cases); ++index) {
        const auto rejection = cases[index];
        Relay relay;
        relay.creation_failure(rejection.status, rejection.reason, {}, rejection.malformed);
        ceres::BridgeOptions options;
        options.app_origin = options.relay = relay.origin();
        options.identity_path = directory / ("rejected-" + std::to_string(index) + ".identity");
        relay.start();
        ceres::BridgeClient receiver(options);
        ReceiverStop stopped{receiver};
        receiver.start();
        until([&] { return receiver.snapshot().connection == "Error"; },
              "Terminal pairing rejection did not stop automatic retries");
        check(relay.creation_attempt_count() == rejection.attempts && relay.created_count() == 0,
              "A terminal rejection exceeded its bounded registration attempts");
        const auto error = receiver.snapshot().error;
        for (const auto& attempted : relay.attempted_identities()) {
            check(error.find(attempted.at("secret").get<std::string>()) == std::string::npos,
                  "A reflected service credential entered receiver status");
            if (index != 5)
                check(attempted.at("code").get<std::string>().size() == 9,
                      "An unrelated service rejection downgraded the code");
        }
        if (index == 0) {
            std::this_thread::sleep_for(3200ms);
            check(relay.http_request_count() == 1, "Terminal HTTP 400 retried after three seconds");
            check(error.find("Invalid Bridge JSON") != std::string::npos,
                  "Known service error reason was omitted");
        }
        receiver.stop();
        relay.stop();
        remove_test_identity(options.identity_path);
    }

    Relay relay;
    relay.creation_failure(500, "Invalid Bridge invitation");
    ceres::BridgeOptions options;
    options.app_origin = options.relay = relay.origin();
    options.identity_path = directory / "backoff.identity";
    relay.start();
    ceres::BridgeClient receiver(options);
    ReceiverStop stopped{receiver};
    receiver.start();
    until([&] { return relay.creation_attempt_count() >= 2; },
          "Transient service failure did not retry");
    std::this_thread::sleep_for(3200ms);
    check(relay.creation_attempt_count() == 2,
          "Repeated server failures did not increase the retry delay");
    for (const auto& attempted : relay.attempted_identities())
        check(attempted.at("code").get<std::string>().size() == 9,
              "Server failure selected the legacy format");
    receiver.stop();
    relay.stop();
    remove_test_identity(options.identity_path);
}

void pairing_rate_limit_tests(const std::filesystem::path& directory) {
    const auto countdown_seconds = [](const std::string& error) {
        const std::string prefix = "Retrying automatically in ";
        const auto at = error.find(prefix);
        check(at != std::string::npos, "Rate-limit status omitted its automatic retry countdown");
        const auto start = at + prefix.size(), colon = error.find(':', start);
        check(colon != std::string::npos, "Rate-limit countdown omitted minutes and seconds");
        return std::stoll(error.substr(start, colon - start)) * 60 +
               std::stoll(error.substr(colon + 1));
    };
    const auto deadline = std::time(nullptr) + 30;
    const auto utc = *std::gmtime(&deadline);
    char date[64]{};
    check(std::strftime(date, sizeof(date), "%a, %d %b %Y %H:%M:%S GMT", &utc) != 0,
          "Cannot format retry date fixture");
    const std::array<std::string, 5> retry_headers{"30", date, "not-a-delay", "", "60"};
    std::vector<std::unique_ptr<Relay>> relays;
    std::vector<std::unique_ptr<ceres::BridgeClient>> receivers;
    std::vector<std::filesystem::path> paths;
    std::vector<int64_t> initial_seconds;
    for (size_t index = 0; index < retry_headers.size(); ++index) {
        auto relay = std::make_unique<Relay>();
        relay->creation_failure(429, index == 4 ? "oversized" : "Too many requests", retry_headers[index]);
        ceres::BridgeOptions options;
        options.app_origin = options.relay = relay->origin();
        options.identity_path = directory / ("rate-" + std::to_string(index) + ".identity");
        paths.push_back(options.identity_path);
        relay->start();
        auto receiver = std::make_unique<ceres::BridgeClient>(options);
        receiver->start();
        until([&] { return receiver->snapshot().connection == "Rate limited"; },
              "HTTP 429 did not enter the rate-limit cooldown");
        const auto error = receiver->snapshot().error;
        const auto seconds = countdown_seconds(error);
        initial_seconds.push_back(seconds);
        check(index == 0 ? seconds == 30 : index == 1 ? seconds >= 20 && seconds <= 30 : seconds == 60,
              "Retry-After seconds, HTTP date or fallback delay differs");
        receiver->fresh_pairing();
        relays.push_back(std::move(relay));
        receivers.push_back(std::move(receiver));
    }
    for (size_t index = 0; index < 2; ++index) {
        const auto saved = identity_protected(paths[index], relays[index]->attempted_identities().front());
        check(saved.contains("retry_after") && saved.at("retry_after").get<double>() > std::time(nullptr),
              "Rate-limit deadline was not saved in the protected identity");
        receivers[index]->stop();
        if (index == 1) {
            ceres::BridgeOptions options;
            options.app_origin = options.relay = relays[index]->origin();
            options.identity_path = paths[index];
            receivers[index] = std::make_unique<ceres::BridgeClient>(options);
        }
        receivers[index]->start();
        until([&] { return receivers[index]->snapshot().connection == "Rate limited"; },
              "Reconnect or restart did not restore the saved cooldown");
        receivers[index]->fresh_pairing();
    }
    std::this_thread::sleep_for(3200ms);
    for (size_t index = 0; index < relays.size(); ++index) {
        check(relays[index]->http_request_count() == 1,
              "Cooldown allowed a new-pairing, reconnect or restart bypass");
        const auto error = receivers[index]->snapshot().error;
        check(countdown_seconds(error) < initial_seconds[index],
              "Rate-limit countdown did not advance");
        const auto before = std::chrono::steady_clock::now();
        receivers[index]->stop();
        check(std::chrono::steady_clock::now() - before < 500ms,
              "Stopping the receiver did not interrupt its cooldown");
        relays[index]->stop();
        remove_test_identity(paths[index]);
    }

    Relay relay;
    relay.creation_failure(429, "Too many requests", "2");
    ceres::BridgeOptions options;
    options.app_origin = options.relay = relay.origin();
    options.identity_path = directory / "rate-recover.identity";
    relay.start();
    ceres::BridgeClient receiver(options);
    ReceiverStop stopped{receiver};
    const auto started = std::chrono::steady_clock::now();
    receiver.start();
    until([&] { return receiver.snapshot().connection == "Rate limited"; },
          "Short cooldown did not begin");
    std::this_thread::sleep_for(300ms);
    check(relay.http_request_count() == 1, "Request preceded Retry-After deadline");
    relay.creation_failure(0);
    until([&] { return receiver.snapshot().connected; }, "Receiver did not recover after Retry-After");
    check(std::chrono::steady_clock::now() - started >= 1900ms,
          "Receiver resumed before Retry-After elapsed");
    check(relay.created_count() == 1 && relay.error().empty(), "Cooldown recovery changed pairing");
    receiver.stop();
    relay.stop();
    remove_test_identity(options.identity_path);
}

struct AccessUnit {
    std::vector<uint8_t> bytes;
    bool keyframe = false;
};
std::vector<AccessUnit> read_stream(const std::filesystem::path& path) {
    check(std::filesystem::file_size(path) <= 64 * 1024 * 1024,
          "The stream fixture exceeds 64 MiB");
    std::ifstream input(path, std::ios::binary);
    check(bool(input), "Cannot open stream fixture");
    const std::vector<uint8_t> bytes(std::istreambuf_iterator<char>(input), {});
    std::vector<std::pair<size_t, size_t>> nals;
    for (size_t i = 0; i + 3 < bytes.size();) {
        const size_t prefix = bytes[i] == 0 && bytes[i + 1] == 0
                                  ? (bytes[i + 2] == 1                        ? 3
                                     : bytes[i + 2] == 0 && bytes[i + 3] == 1 ? 4
                                                                              : 0)
                                  : 0;
        if (prefix) {
            check(i + prefix < bytes.size(), "Empty H.264 NAL unit");
            nals.emplace_back(i, i + prefix);
            i += prefix;
        } else
            ++i;
    }
    check(!nals.empty(), "The fixture is not an Annex B H.264 stream");
    std::vector<AccessUnit> result;
    AccessUnit unit;
    bool aud = false, slice = false, sps = false, pps = false;
    auto finish = [&] {
        check(aud && slice, "Every fixture access unit requires an AUD and a coded picture");
        check(unit.bytes.size() <= 2 * 1024 * 1024,
              "A fixture access unit exceeds the receiver limit");
        result.push_back(std::move(unit));
        unit = {};
        aud = slice = false;
    };
    for (size_t i = 0; i < nals.size(); ++i) {
        const auto begin = nals[i].second,
                   end = i + 1 < nals.size() ? nals[i + 1].first : bytes.size();
        check(begin < end, "Empty H.264 NAL unit");
        const auto type = bytes[begin] & 31;
        if (type == 9 && slice)
            finish();
        aud |= type == 9;
        slice |= type == 1 || type == 5;
        unit.keyframe |= type == 5;
        sps |= type == 7;
        pps |= type == 8;
        unit.bytes.insert(unit.bytes.end(), {0, 0, 0, 1});
        unit.bytes.insert(unit.bytes.end(), bytes.begin() + ptrdiff_t(begin),
                          bytes.begin() + ptrdiff_t(end));
    }
    if (!unit.bytes.empty())
        finish();
    check(!result.empty() && result.front().keyframe && sps && pps,
          "The stream must start at an IDR and include SPS/PPS");
    return result;
}

// Deliberately independent of the renderer, these original joint positions describe
// a stationary head and two articulated hands in the sender's local-floor space.
std::vector<uint8_t> stream_pose(int kind, uint32_t epoch, uint32_t sequence, int64_t observed,
                                 double seconds) {
    std::vector<uint8_t> result(kind == 1 ? 68 : 844, 0);
    std::memcpy(result.data(), "CBR1", 4);
    result[4] = 1;
    result[5] = uint8_t(kind);
    put(result, 6, 1, 2);
    put(result, 8, epoch, 4);
    put(result, 12, 1, 4);
    put(result, 16, sequence, 4);
    put(result, 20, result.size() - 40, 4);
    put(result, 24, uint64_t(observed), 8);
    put(result, 32, uint64_t(observed + 11111), 8);
    auto value = [&](size_t at, float f) { put(result, at, std::bit_cast<uint32_t>(f), 4); };
    if (kind == 1) {
        value(44, 1.6f);
        value(64, 1.f);
        return result;
    }
    constexpr std::array<std::array<float, 2>, 25> rest{
        {{{0, 0}},          {{-.029f, .020f}}, {{-.047f, .037f}}, {{-.064f, .055f}},
         {{-.075f, .071f}}, {{-.027f, .066f}}, {{-.030f, .105f}}, {{-.030f, .132f}},
         {{-.030f, .152f}}, {{-.030f, .166f}}, {{-.007f, .070f}}, {{-.007f, .115f}},
         {{-.007f, .145f}}, {{-.007f, .168f}}, {{-.007f, .182f}}, {{.014f, .065f}},
         {{.015f, .107f}},  {{.016f, .135f}},  {{.016f, .155f}},  {{.016f, .168f}},
         {{.033f, .055f}},  {{.036f, .087f}},  {{.038f, .109f}},  {{.039f, .127f}},
         {{.039f, .140f}}}};
    put(result, 40, 0x1ffffff, 4);
    const bool left = kind == 2;
    const float curl = .5f + .45f * std::sin(float(seconds) * 1.7f + (left ? 0.f : 1.f));
    for (size_t joint = 0; joint < rest.size(); ++joint) {
        const float t = std::max(0.f, (rest[joint][1] - .07f) / .12f),
                    bend = joint > 1 ? curl * t * t : 0;
        const size_t at = 44 + joint * 32;
        value(at, (left ? -.14f : .14f) + (left ? rest[joint][0] : -rest[joint][0]));
        value(at + 4, 1.35f + rest[joint][1] - bend * .048f);
        value(at + 8, -.48f - bend * .095f);
        value(at + 24, 1.f);
        value(at + 28, .008f);
    }
    return result;
}

void rtcp_clock_tests() {
    const uint64_t ntp = (uint64_t(3900000000) << 32) | 0x80000000u;
    auto big32 = [](std::vector<uint8_t>& bytes, size_t at, uint32_t value) {
        for (size_t i = 0; i < 4; ++i)
            bytes[at + i] = uint8_t(value >> (24 - i * 8));
    };
    auto report = [&](uint32_t ssrc, uint32_t timestamp) {
        std::vector<uint8_t> bytes(28);
        bytes[0] = 0x80;
        bytes[1] = 200;
        bytes[3] = 6;
        big32(bytes, 4, ssrc);
        big32(bytes, 8, uint32_t(ntp >> 32));
        big32(bytes, 12, uint32_t(ntp));
        big32(bytes, 16, timestamp);
        return rtc::make_message(binary(bytes), rtc::Message::Control);
    };
    auto video = [&](uint32_t ssrc, uint32_t timestamp) {
        std::vector<uint8_t> bytes{0x80, 0xe0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x65, 1};
        big32(bytes, 4, timestamp);
        big32(bytes, 8, ssrc);
        return rtc::make_message(binary(bytes), rtc::Message::Binary);
    };
    ceres::RtcpCameraSession session;
    const auto send = [](rtc::message_ptr) {};
    rtc::message_vector messages{report(42, 90000)};
    session.incoming_at(messages, send, 1000);
    check(!session.clock.report(42, 1000), "Unknown RTP source received a sender clock");
    messages = {video(42, 90000)};
    session.incoming_at(messages, send, 2000);
    auto mapped = session.clock.report(42, 2000);
    check(mapped && mapped->received_us == 1000 && mapped->rtp_timestamp == 90000 &&
              mapped->ntp_timestamp == ntp,
          "Sender-report arrival was replaced by video arrival");
    check(session.clock.report(42, 5001000).has_value() && !session.clock.report(42, 5001001) &&
              !session.clock.report(42, 999),
          "Sender-report freshness exceeded its arrival-time boundary");
    messages = {report(42, 90000)};
    session.incoming_at(messages, send, 2000000);
    // The report arrived while video was paused. Resuming must not refresh it.
    messages = {video(42, 90000)};
    session.incoming_at(messages, send, 7000001);
    check(!session.clock.report(42, 7000001),
          "Resumed video renewed an expired report from the pause");
    // Video deliberately precedes RTCP in the batch. Its report must be available
    // before the remaining video is forwarded to the receiver event worker.
    messages = {video(43, 90000), report(43, 90000)};
    session.incoming_at(messages, send, 8000000);
    mapped = session.clock.report(43, 8000000);
    check(mapped && mapped->ssrc == 43 && mapped->received_us == 8000000 && messages.size() == 1 &&
              messages[0]->type == rtc::Message::Binary && !session.clock.report(42, 8000000),
          "A changed RTP source inherited the previous sender report");
    messages = {video(44, 90000)};
    session.incoming_at(messages, send, 8100000);
    check(!session.clock.report(44, 8100000), "New SSRC retained the old RTCP mapping");
    messages = {report(43, 90000)};
    session.incoming_at(messages, send, 8200000);
    check(!session.clock.report(44, 8200000), "Foreign SSRC report installed a media clock");
    messages = {report(44, 90000)};
    session.incoming_at(messages, send, 8300000);
    check(session.clock.report(44, 8300000).has_value(),
          "Fresh matching SSRC report did not restore timing");
    messages = {video(42, 90000)};
    session.incoming_at(messages, send, 8400000);
    check(!session.clock.report(42, 8400000), "Returning SSRC resurrected an earlier report");
    ceres::RtcpCameraSession next_epoch;
    messages = {video(44, 90000)};
    next_epoch.incoming_at(messages, send, 8500000);
    check(!next_epoch.clock.report(44, 8500000), "A new connection inherited a sender report");
}

void dual_camera_test(const std::filesystem::path& directory) {
    Relay relay(0, 0, true);
    ceres::BridgeOptions options;
    options.app_origin = options.relay = relay.origin();
    options.identity_path = directory / "dual.identity";
    ceres::BridgeClient receiver(options);
    std::mutex mutex;
    std::vector<ceres::SessionEvent> frames;
    receiver.set_event_sink([&](const ceres::SessionEvent& event) {
        if (event.kind == ceres::EventKind::Video) {
            std::lock_guard lock(mutex);
            frames.push_back(event);
        }
    });
    ReceiverStop stop_before_callback_state{receiver};
    relay.start();
    receiver.start();
    until([&] { return receiver.snapshot().connection == "Streaming"; },
          "Dual camera negotiation failed");
    auto sender = relay.current_sender();
    check(sender && sender->secondary && sender->secondary->isOpen(),
          "Secondary video track did not open");
    const auto cameras = receiver.snapshot().camera.cameras;
    check(cameras.size() == 2 && cameras[0].side == "right" && cameras[0].primary &&
              cameras[1].side == "left" && cameras[1].mid == "camera-left",
          "Dual camera snapshot identity differs");
    auto send = [&](bool left, uint16_t sequence, uint32_t timestamp, bool keyframe) {
        std::vector<uint8_t> bytes{0x80,
                                   0xe0,
                                   uint8_t(sequence >> 8),
                                   uint8_t(sequence),
                                   uint8_t(timestamp >> 24),
                                   uint8_t(timestamp >> 16),
                                   uint8_t(timestamp >> 8),
                                   uint8_t(timestamp),
                                   0,
                                   0,
                                   0,
                                   uint8_t(left ? 43 : 42),
                                   uint8_t(keyframe ? 0x65 : 0x61),
                                   uint8_t(left ? 0x11 : 0x22)};
        (left ? sender->secondary : sender->video)->send(binary(bytes));
    };
    auto received = [&](size_t count) {
        until(
            [&] {
                std::lock_guard lock(mutex);
                return frames.size() >= count;
            },
            "Independent camera access units were not delivered");
    };
    send(true, 100, 900000, true);
    send(false, 65535, 0xfffff000u, true);
    received(2);
    send(true, 101, 903000, false);
    send(false, 0, 0x00000770u, false);
    received(4);
    // A lost packet in the primary must not stall or corrupt the other camera.
    send(false, 2, 0x00001ee0u, false);
    send(true, 102, 906000, false);
    received(5);
    std::this_thread::sleep_for(20ms);
    send(false, 3, 0x00002a98u, true);
    received(6);
    {
        std::lock_guard lock(mutex);
        check(frames.size() == 6, "A dependent camera frame escaped packet-loss recovery");
        std::array<uint32_t, 2> sequences{};
        std::array<int64_t, 2> anchors{};
        for (const auto& event : frames) {
            const bool left = event.attributes.at("camera_side") == "left";
            const size_t i = left ? 1 : 0;
            check(event.stream == (left ? "passthrough_left" : "passthrough") &&
                      event.attributes.at("camera_mid") == (left ? "camera-left" : "camera") &&
                      event.attributes.at("camera_primary") == !left &&
                      event.payload.back() == (left ? 0x11 : 0x22) &&
                      event.sequence == sequences[i]++,
                  "Camera identity, payload or sequence crossed streams");
            check(event.attributes.at("video_time_domain") == "receiver-arrival-anchored-rtp" &&
                      event.attributes.at("capture_synchronised") == false,
                  "Receiver arrival timing was labelled as synchronised exposure");
            if (event.sequence == 0) {
                anchors[i] = event.time_us;
                check(event.time_us == event.receive_us, "Each camera needs its own time anchor");
            } else if (event.sequence == 1)
                check(event.time_us - anchors[i] == (left ? 33333 : 66666),
                      "Independent RTP clocks were conflated");
        }
        check(sequences[0] == 3 && sequences[1] == 3, "A camera stream disappeared after loss");
    }
    const auto previous_epoch = receiver.snapshot().epoch;
    auto changed = description(previous_epoch, 30, true);
    changed["cameras"][1]["mid"] = "undeclared";
    sender->meta->send(changed.dump());
    until(
        [&] {
            const auto state = receiver.snapshot();
            return state.epoch > previous_epoch && state.connection == "Streaming";
        },
        "Undeclared camera metadata did not restart the connection");
    sender = relay.current_sender();
    send(true, 1, 123000, true);
    send(false, 1, 456000, true);
    received(8);
    {
        std::lock_guard lock(mutex);
        check(frames[6].sequence == 0 && frames[7].sequence == 0 &&
                  frames[6].epoch > previous_epoch && frames[7].epoch > previous_epoch,
              "Camera epoch retained old sequence or timing state");
    }
    receiver.stop();
    relay.stop();
    check(relay.error().empty(), "Dual camera relay rejected the native contract");
    std::filesystem::remove(options.identity_path);
    std::filesystem::remove(std::filesystem::path(options.identity_path.string() + ".lock"));
}

void depth_channel_test(const std::filesystem::path& directory) {
    Relay relay(0, 0, false, true);
    ceres::BridgeOptions options;
    options.app_origin = options.relay = relay.origin();
    options.identity_path = directory / "depth.identity";
    ceres::BridgeClient receiver(options);
    std::mutex mutex;
    std::vector<ceres::SessionEvent> frames;
    receiver.set_event_sink([&](const ceres::SessionEvent& event) {
        if (event.kind == ceres::EventKind::Depth) {
            std::lock_guard lock(mutex);
            frames.push_back(event);
        }
    });
    ReceiverStop stop_before_callback_state{receiver};
    relay.start();
    receiver.start();
    until([&] { return receiver.snapshot().connection == "Streaming"; },
          "Depth-only negotiation failed");
    auto sender = relay.current_sender();
    check(sender && sender->depth && !sender->video && receiver.snapshot().camera.cameras.empty(),
          "Depth-only session created a video track");
    until([&] { return sender->depth->isOpen() && receiver.snapshot().clock.valid; },
          "Depth channel or sender clock did not become available");
    sender->pose->send(
        binary(stream_pose(1, sender->epoch, 1, ceres::monotonic_us() + 4000000, 0)));
    until([&] { return receiver.snapshot().space_epoch == 1; }, "Depth reference space missing");
    auto unknown = sender->peer->createDataChannel("future-optional-channel");
    until([&] { return unknown->isClosed(); }, "Unknown optional channel was not closed");
    check(receiver.snapshot().connected, "Optional channel disconnected legacy Bridge streams");
    const auto sent_at = ceres::monotonic_us();
    auto h = depth_fixture::header(0xffffffffu, sender->epoch, 1, 256, 256);
    h["observed_us"] = sent_at + 4000000;
    h["target_us"] = sent_at + 4011111;
    const auto original = depth_fixture::encode(h);
    const auto parts = depth_fixture::fragment(original, h);
    for (auto it = parts.rbegin(); it != parts.rend(); ++it)
        sender->depth->send(binary(*it));
    until([&] { return receiver.snapshot().depth_frames == 1; },
          "Fragmented native depth did not reach the event sink");
    {
        std::lock_guard lock(mutex);
        check(frames.size() == 1 && frames[0].payload == original &&
                  frames[0].attributes.at("clock_valid") == true &&
                  frames[0].attributes.at("target_us") == sent_at + 4011111 &&
                  std::abs(frames[0].time_us - (sent_at + 11111)) < 10000,
              "Native depth identity, raw bytes or sender clock changed");
    }
    sender->depth->send(binary(parts[0]));
    h["sequence"] = 0;
    for (const auto& part : depth_fixture::fragment(depth_fixture::encode(h), h))
        sender->depth->send(binary(part));
    until([&] { return receiver.snapshot().depth_frames == 2; },
          "Native depth sequence wrap failed");
    auto bad = parts[0];
    bad.pop_back();
    sender->depth->send(binary(bad));
    until([&] { return receiver.snapshot().depth_rejected >= 1; },
          "Malformed native depth was not rejected");
    auto pose = stream_pose(1, sender->epoch, 2, ceres::monotonic_us() + 4000000, 0);
    put(pose, 12, 2, 4);
    sender->pose->send(binary(pose));
    until([&] { return receiver.snapshot().space_epoch == 2; }, "Depth space did not advance");
    sender->depth->send(binary(parts[0]));
    until([&] { return receiver.snapshot().depth_rejected >= 2; }, "Old-space depth was accepted");
    h["space_epoch"] = 2;
    h["sequence"] = 1;
    for (const auto& part : depth_fixture::fragment(depth_fixture::encode(h), h))
        sender->depth->send(binary(part));
    until([&] { return receiver.snapshot().depth_frames == 3; }, "New-space depth did not recover");
    sender->meta->send(Json{{"type", "depth-status"},
                            {"version", 1},
                            {"epoch", sender->epoch},
                            {"status", "paused"},
                            {"usage", "cpu-optimized"},
                            {"source_format", "luminance-alpha"}}
                           .dump());
    until([&] { return receiver.snapshot().depth_status == "paused"; }, "Depth status was lost");
    sender->depth->close();
    std::this_thread::sleep_for(20ms);
    check(receiver.snapshot().connected && receiver.snapshot().depth_usage == "cpu-optimized",
          "Closing optional depth disconnected the acquisition session");
    receiver.stop();
    relay.stop();
    check(relay.error().empty(), "Depth fixture relay rejected the contract");
    std::filesystem::remove(options.identity_path);
    std::filesystem::remove(std::filesystem::path(options.identity_path.string() + ".lock"));
}

void depth_control_test(const std::filesystem::path& directory) {
    for (const bool supported : {false, true}) {
        Relay relay(0, 0, false, true, supported);
        ceres::BridgeOptions options;
        options.app_origin = options.relay = relay.origin();
        options.identity_path = directory / (supported ? "depth-control.identity" : "depth-legacy.identity");
        ceres::BridgeClient receiver(options);
        const auto acknowledgement = [](const std::shared_ptr<Sender>& sender) {
            if (sender)
                for (const auto& message : sender->metadata_messages())
                    if (message.at("type") == "ack")
                        return message;
            return Json();
        };
        const auto controls = [](const std::shared_ptr<Sender>& sender) {
            std::vector<Json> result;
            if (sender)
                for (const auto& message : sender->metadata_messages())
                    if (message.at("type") == "depth-control")
                        result.push_back(message);
            return result;
        };
        relay.start();
        receiver.start();
        until([&] { return receiver.snapshot().connection == "Streaming" &&
                           !acknowledgement(relay.current_sender()).is_null(); },
              "Depth demand negotiation failed");
        auto sender = relay.current_sender();
        const auto ack = acknowledgement(sender);
        if (supported)
            check(ack.at("depth_control_version") == 1 && ack.at("depth_enabled") == true,
                  "Depth acquisition did not default to enabled");
        else
            check(!ack.contains("depth_control_version") && !ack.contains("depth_enabled"),
                  "Legacy sender received unnegotiated depth acknowledgement");
        receiver.set_depth_enabled(false);
        if (supported) {
            until([&] { return controls(sender).size() == 1; }, "Depth disable demand was not sent");
            check(controls(sender)[0] == Json{{"type", "depth-control"}, {"version", 1},
                                             {"epoch", sender->epoch}, {"enabled", false}},
                  "Depth demand did not retain its epoch and boolean state");
            receiver.set_depth_enabled(false);
            std::this_thread::sleep_for(30ms);
            check(controls(sender).size() == 1, "Unchanged depth demand was retransmitted");
            receiver.set_depth_enabled(true);
            until([&] { return controls(sender).size() == 2; }, "Depth enable demand was not sent");
            check(controls(sender)[1].at("enabled") == true, "Depth enable state changed");
            receiver.set_depth_enabled(false);
            until([&] { return controls(sender).size() == 3; }, "Second depth disable demand was not sent");
        } else {
            std::this_thread::sleep_for(30ms);
            receiver.set_depth_enabled(true);
            std::this_thread::sleep_for(30ms);
            check(controls(sender).empty() && receiver.snapshot().connected,
                  "Legacy sender received an unknown depth control");
            receiver.set_depth_enabled(false);
        }
        const auto previous_epoch = sender->epoch;
        sender->meta->close();
        until([&] { return receiver.snapshot().connection == "Streaming" &&
                           receiver.snapshot().epoch > previous_epoch &&
                           !acknowledgement(relay.current_sender()).is_null(); },
              "Depth demand did not reconnect");
        sender = relay.current_sender();
        const auto resumed = acknowledgement(sender);
        if (supported)
            check(resumed.at("depth_enabled") == false && resumed.at("epoch") == sender->epoch,
                  "Reconnection lost disabled depth demand");
        else
            check(!resumed.contains("depth_enabled") && controls(sender).empty(),
                  "Legacy reconnect received depth control metadata");
        check(controls(sender).empty(), "Reconnect sent a transient depth demand after acknowledgement");
        receiver.stop();
        receiver.set_depth_enabled(false);
        receiver.start();
        until([&] { return receiver.snapshot().connection == "Streaming" &&
                           receiver.snapshot().epoch > sender->epoch &&
                           !acknowledgement(relay.current_sender()).is_null(); },
              "Depth demand did not survive stop/start");
        if (supported)
            check(acknowledgement(relay.current_sender()).at("depth_enabled") == false,
                  "Demand set before start was lost");
        receiver.stop();
        relay.stop();
        check(relay.error().empty(), "Depth demand fixture rejected the contract");
        std::filesystem::remove(options.identity_path);
        std::filesystem::remove(std::filesystem::path(options.identity_path.string() + ".lock"));
    }
}

int stream_fixture(int argc, char** argv) {
    std::filesystem::path input, secondary_input, capture;
    int seconds = 60, fps = 30;
    uint16_t port = 8765;
    bool self_test = false;
    for (int i = 1; i < argc; ++i) {
        const std::string option = argv[i];
        auto argument = [&]() -> std::string {
            check(i + 1 < argc, "Missing stream fixture option value");
            return argv[++i];
        };
        auto number = [&]() {
            const auto text = argument();
            size_t consumed = 0;
            const int n = std::stoi(text, &consumed);
            check(consumed == text.size(), "Invalid numeric stream fixture option");
            return n;
        };
        if (option == "--stream-fixture")
            input = argument();
        else if (option == "--second-stream")
            secondary_input = argument();
        else if (option == "--seconds") {
            seconds = number();
            check(seconds >= 2 && seconds <= 86400,
                  "Stream duration must be between 2 and 86400 seconds");
        } else if (option == "--port") {
            const auto n = number();
            check(n >= 0 && n <= 65535, "Invalid fixture port");
            port = uint16_t(n);
        } else if (option == "--fps") {
            fps = number();
            check(fps == 30 || fps == 60, "Stream fixture frame rate must be 30 or 60");
        } else if (option == "--self-test")
            self_test = true;
        else if (option == "--capture")
            capture = argument();
        else
            throw std::runtime_error("Unknown stream fixture option");
    }
    check(!input.empty(), "A stream fixture file is required");
    check(capture.empty() || self_test, "Capture requires the fixture self-test receiver");
    const auto units = read_stream(input);
    const auto secondary_units =
        secondary_input.empty() ? std::vector<AccessUnit>{} : read_stream(secondary_input);
    const bool dual = !secondary_units.empty();
    const auto directory = std::filesystem::current_path() /
                           ("bridge-stream-test-" + std::to_string(ceres::monotonic_us()));
    Relay relay(port, fps, dual);
    ceres::BridgeOptions options;
    options.app_origin = options.relay = relay.origin();
    options.identity_path = directory / "receiver.identity";
    // Initialising the receiver runtime also configures Windows Mbed TLS threading
    // before the fixture's first WebSocket or PeerConnection is constructed.
    ceres::BridgeClient receiver(options);
    std::atomic<uint64_t> received_video = 0, received_pose = 0, associated_video = 0,
                          received_bytes = 0;
    std::atomic<uint64_t> received_primary = 0, received_secondary = 0, sender_timed = 0;
    std::ofstream recording;
    if (!capture.empty()) {
        recording.open(capture, std::ios::binary);
        check(bool(recording), "Cannot open received H.264 capture");
    }
    if (self_test)
        receiver.set_event_sink([&](const ceres::SessionEvent& event) {
            if (event.kind == ceres::EventKind::Pose)
                ++received_pose;
            if (event.kind == ceres::EventKind::Video) {
                ++received_video;
                if (event.attributes.value("camera_primary", true))
                    ++received_primary;
                else
                    ++received_secondary;
                if (event.attributes.contains("sender_ntp_us"))
                    ++sender_timed;
                received_bytes += event.payload.size();
                if (event.attributes.contains("head_pose"))
                    ++associated_video;
                if (recording && event.attributes.value("camera_primary", true))
                    recording.write(reinterpret_cast<const char*>(event.payload.data()),
                                    std::streamsize(event.payload.size()));
            }
        });
    ReceiverStop stop_before_callback_state{receiver};
    relay.start();
    if (self_test)
        receiver.start();
    std::cout << "READY: " << relay.origin() << " | " << fps
              << " fps video | 90 Hz head and hands | " << units.size() << " source frames"
              << std::endl;
    const auto start = ceres::monotonic_us(), finish = start + int64_t(seconds) * 1000000;
    int64_t anchor = 0, pose_slot = -1, video_slot = -1, next_status = start + 10000000;
    size_t frame = 0, secondary_frame = 0;
    uint64_t sent_video = 0, sent_pose = 0, recoveries = 0;
    std::shared_ptr<Sender> active;
    auto next_idr = [](const auto& stream, size_t& frame) {
        for (size_t i = 0; i < stream.size(); ++i) {
            const auto at = (frame + i) % stream.size();
            if (stream[at].keyframe) {
                frame = at;
                return;
            }
        }
    };
    while (ceres::monotonic_us() < finish) {
        const auto now = ceres::monotonic_us();
        const auto sender = relay.current_sender();
        if (sender && sender->ready && sender->answered && sender->pose->isOpen() &&
            sender->meta->isOpen() && sender->video->isOpen() &&
            (!dual || sender->secondary->isOpen())) {
            if (sender != active) {
                active = sender;
                anchor = now;
                pose_slot = video_slot = -1;
                frame = 0;
                secondary_frame = 0;
                std::cout << "CONNECTED: epoch=" << sender->epoch << std::endl;
            }
            const auto current_pose = (now - anchor) * 90 / 1000000;
            if (current_pose > pose_slot) {
                pose_slot = current_pose;
                for (int kind = 1; kind <= 3; ++kind) {
                    sender->pose->send(
                        binary(stream_pose(kind, sender->epoch, uint32_t(current_pose),
                                           now + 4000000, double(now - start) / 1000000.0)));
                    ++sent_pose;
                }
            }
            const auto current_video = (now - anchor) * fps / 1000000;
            if (current_video > video_slot) {
                const bool skipped = current_video > video_slot + 1;
                if (sender->request_intra.exchange(false) || skipped) {
                    next_idr(units, frame);
                    ++recoveries;
                }
                video_slot = current_video;
                sender->rtp->timestamp =
                    sender->rtp->startTimestamp + uint32_t(current_video * (90000 / fps));
                sender->video->send(binary(units[frame].bytes));
                frame = (frame + 1) % units.size();
                ++sent_video;
                if (dual) {
                    if (sender->request_secondary_intra.exchange(false) || skipped) {
                        next_idr(secondary_units, secondary_frame);
                        ++recoveries;
                    }
                    sender->secondary_rtp->timestamp = sender->secondary_rtp->startTimestamp +
                                                       uint32_t(current_video * (90000 / fps));
                    sender->secondary->send(binary(secondary_units[secondary_frame].bytes));
                    secondary_frame = (secondary_frame + 1) % secondary_units.size();
                    ++sent_video;
                }
            }
        }
        const auto error = relay.error();
        if (!error.empty())
            throw std::runtime_error("Stream relay: " + error);
        if (now >= next_status) {
            std::cout << "STREAM: seconds=" << (now - start) / 1000000 << " video=" << sent_video
                      << " poses=" << sent_pose << " recoveries=" << recoveries << std::endl;
            next_status = now + 10000000;
        }
        std::this_thread::sleep_for(1ms);
    }
    std::this_thread::sleep_for(50ms);
    const auto snapshot = receiver.snapshot();
    receiver.stop();
    relay.stop();
    if (recording) {
        recording.flush();
        check(bool(recording), "Cannot finish received H.264 capture");
        recording.close();
    }
    std::cout << "COMPLETE: video=" << sent_video << " poses=" << sent_pose
              << " recoveries=" << recoveries << std::endl;
    if (self_test) {
        check(snapshot.connected && snapshot.clock.valid,
              "The stream receiver did not maintain its clock and transport");
        check(received_video >= uint64_t(fps * (seconds - 1) / 2) &&
                  received_pose >= uint64_t(90 * (seconds - 1)),
              "The stream receiver missed its minimum media cadence");
        check(received_primary >= uint64_t(fps * (seconds - 1) / 2) &&
                  (!dual || received_secondary >= uint64_t(fps * (seconds - 1) / 2)),
              "A camera did not maintain its independent media cadence");
        check(sender_timed > received_video / 2,
              "Most camera frames have no RTCP sender media timestamp");
        check(associated_video > received_video / 2,
              "Most camera frames have no accepted head association");
        check(snapshot.rejected == 0, "The stream source generated rejected pose packets");
        std::cout << "PASS: received_video=" << received_video
                  << " received_poses=" << received_pose
                  << " head_associations=" << associated_video << " bytes=" << received_bytes
                  << " primary=" << received_primary << " secondary=" << received_secondary
                  << " sender_timed=" << sender_timed << std::endl;
        std::filesystem::remove(options.identity_path);
        std::filesystem::remove(std::filesystem::path(options.identity_path.string() + ".lock"));
        std::filesystem::remove(directory);
    }
    return 0;
}
} // namespace
int main(int argc, char** argv) {
    if (argc >= 2 && std::string(argv[1]) == "--stream-fixture") {
        try {
            return stream_fixture(argc, argv);
        } catch (const std::exception& error) {
            std::cerr << "FAIL: " << error.what() << '\n';
            return 1;
        }
    }
    if (argc == 2 && std::string(argv[1]) == "--help") {
        std::cout
            << "test_bridge [--live]\n"
               "test_bridge --stream-fixture camera.h264 [--seconds 60] [--port 8765] [--fps 30]\n"
               "            [--second-stream left.h264] [--self-test] [--capture received.h264]\n"
               "Connect the viewer with --origin http://127.0.0.1:8765 --config-dir "
               "<dedicated-directory>.\n";
        return 0;
    }
    if (argc == 2 && std::string(argv[1]) == "--live") {
        ceres::BridgeClient client;
        client.start();
        std::string previous;
        for (int i = 0; i < 160; ++i) {
            const auto snapshot = client.snapshot();
            const auto state =
                snapshot.connection + " | " + snapshot.error + " | code=" + snapshot.code;
            if (state != previous) {
                std::cout << state << std::endl;
                previous = state;
            }
            std::this_thread::sleep_for(50ms);
        }
        const bool issued = !client.snapshot().code.empty();
        client.stop();
        return issued ? 0 : 1;
    }
    if (argc != 1) {
        std::cerr << "Unknown argument. Use --help for fixture options.\n";
        return 2;
    }
    const auto directory =
        std::filesystem::current_path() / ("bridge-test-" + std::to_string(ceres::monotonic_us()));
    const auto identity_file = directory / "receiver.identity";
    try {
        rtcp_clock_tests();
        pairing_compatibility_tests(directory);
        pairing_rotation_tests(directory);
        pairing_error_tests(directory);
        pairing_rate_limit_tests(directory);
        Relay relay;
        relay.reject_next_creation();
        ceres::BridgeOptions options;
        options.app_origin = options.relay = relay.origin();
        options.identity_path = identity_file;
        ceres::BridgeClient first(options);
        relay.start();
        std::mutex event_mutex;
        std::vector<ceres::SessionEvent> events;
        ceres::BridgeClient* active = &first;
        std::atomic<bool> leaked_epoch_clock = false;
        auto sink = [&](const ceres::SessionEvent& event) {
            if (event.kind == ceres::EventKind::Epoch &&
                event.attributes.value("reason", std::string()) == "connection" &&
                active->snapshot().clock.valid)
                leaked_epoch_clock = true;
            std::lock_guard lock(event_mutex);
            events.push_back(event);
        };
        ReceiverStop stop_before_callback_state{first};
        first.set_event_sink(sink);
        first.start();
        until([&] { return first.snapshot().connected && first.snapshot().clock.valid; },
              "Initial local Bridge connection failed");
        check(relay.error().empty(), "Local relay rejected the receiver contract");
        check(relay.creation_attempt_count() == 2 && relay.created_count() == 1,
              "Invitation did not retry the code collision");
        for (const auto& attempted : relay.attempted_identities())
            check(attempted.at("code").get<std::string>().size() == 9,
                  "A current service did not receive the canonical nine-letter code");
        const auto saved = relay.current_identity();
        identity_protected(identity_file, saved);
        std::ifstream fixture_file(std::filesystem::path(__FILE__).parent_path() / "fixtures" /
                                   "bridge-poses.json");
        const auto fixtures = Json::parse(fixture_file);
        auto sender = relay.current_sender();
        const auto epoch = first.snapshot().epoch;
        for (int kind = 1; kind <= 3; ++kind)
            sender->pose->send(binary(packet(fixtures, kind, epoch, 2, 10)));
        until([&] { return first.snapshot().received >= 3; },
              "Head and both hands were not delivered");
        const std::vector<uint8_t> rtp{0x80, 0xe0, 0,    1,  0, 1,    0x5f, 0x90, 0,
                                       0,    0,    42,   24, 0, 2,    0x67, 0x11, 0,
                                       2,    0x68, 0x22, 0,  2, 0x65, 0x33};
        sender->video->send(binary(rtp));
        until([&] { return first.snapshot().video_frames == 1; },
              "H.264 access unit was not delivered");
        int64_t first_video_time = 0;
        {
            std::lock_guard lock(event_mutex);
            for (const auto& event : events)
                if (event.kind == ceres::EventKind::Video)
                    first_video_time = event.time_us;
        }
        const auto clock = first.snapshot().clock;
        auto precise = packet(fixtures, 1, epoch, 2, 11),
             latest = packet(fixtures, 1, epoch, 2, 12);
        put(precise, 24,
            uint64_t((double(first_video_time + 100000) - clock.offset_us) / clock.rate), 8);
        put(latest, 24, uint64_t((double(first_video_time + 80000) - clock.offset_us) / clock.rate),
            8);
        sender->pose->send(binary(precise));
        sender->pose->send(binary(latest));
        until([&] { return first.snapshot().received >= 5; }, "Head history was not delivered");
        auto next_video = [&](uint16_t sequence, uint32_t timestamp) {
            auto bytes = rtp;
            bytes[2] = uint8_t(sequence >> 8);
            bytes[3] = uint8_t(sequence);
            for (int i = 0; i < 4; ++i)
                bytes[4 + size_t(i)] = uint8_t(timestamp >> (24 - i * 8));
            sender->video->send(binary(bytes));
        };
        next_video(2, 99000);
        until([&] { return first.snapshot().video_frames == 2; }, "Second video was not delivered");
        next_video(3, 108000);
        until([&] { return first.snapshot().video_frames == 3; }, "Third video was not delivered");
        auto head = packet(fixtures, 1, epoch, 3, 13);
        sender->pose->send(binary(head));
        until([&] { return first.snapshot().space_epoch == 3; },
              "Reference-space transition was not delivered");
        check(!first.snapshot().poses[1] && !first.snapshot().poses[2],
              "Reference-space transition retained old hands");
        const auto accepted = first.snapshot().received;
        sender->pose->send(binary(head));
        sender->pose->send(binary(packet(fixtures, 2, epoch, 2, 20)));
        sender->pose->send(binary(packet(fixtures, 1, epoch + 1, 3, 20)));
        until([&] { return first.snapshot().rejected >= 3; },
              "Duplicate or foreign epoch poses were accepted");
        check(first.snapshot().received == accepted,
              "Rejected packets changed the accepted sequence");
        {
            std::lock_guard lock(event_mutex);
            const auto video = std::find_if(events.begin(), events.end(), [](const auto& event) {
                return event.kind == ceres::EventKind::Video;
            });
            check(video != events.end() && video->stream == "passthrough" && video->keyframe &&
                      video->payload.size() == 18 && video->space_epoch == 2,
                  "Raw video event contract differs");
            check(video->attributes.contains("head_pose"),
                  "Video has no correlated head transform");
            const auto second_video =
                std::find_if(events.begin(), events.end(), [](const auto& event) {
                    return event.kind == ceres::EventKind::Video && event.sequence == 1;
                });
            const auto third_video =
                std::find_if(events.begin(), events.end(), [](const auto& event) {
                    return event.kind == ceres::EventKind::Video && event.sequence == 2;
                });
            check(second_video != events.end() &&
                      second_video->attributes.value("head_sequence", 0u) == 11 &&
                      second_video->attributes.at("head_age_us").get<double>() <= 50000,
                  "Video did not select the nearest accepted head within 50 ms");
            check(third_video != events.end() && !third_video->attributes.contains("head_pose"),
                  "Video used a head outside the 50 ms association window");
            check(std::any_of(events.begin(), events.end(),
                              [&](const auto& event) {
                                  return event.kind == ceres::EventKind::Pose &&
                                         event.payload == head;
                              }),
                  "Pose event does not preserve the original wire packet");
            check(std::any_of(events.begin(), events.end(),
                              [](const auto& event) {
                                  return event.kind == ceres::EventKind::Clock &&
                                         event.attributes.at("valid") == true;
                              }),
                  "Clock fit event is missing");
        }
        first.stop();
        sender->close();
        ceres::BridgeClient second(options);
        active = &second;
        second.set_event_sink(sink);
        second.start();
        // Peer transport connectivity precedes the SCTP channels and description.
        // Interrupt an established metadata channel, after pairing is complete.
        until(
            [&] {
                const auto snapshot = second.snapshot();
                const auto resumed_sender = relay.current_sender();
                return snapshot.connected && snapshot.connection == "Streaming" &&
                       relay.registration_count() >= 2 && resumed_sender &&
                       resumed_sender->meta->isOpen();
            },
            "Persistent identity did not reconnect");
        check(relay.created_count() == 1 &&
                  relay.current_identity().at("bindingId") == saved.at("bindingId") &&
                  second.snapshot().code.empty(),
              "Restart did not reuse the paired identity");
        const auto reconnect_epoch = second.snapshot().epoch;
        relay.current_sender()->meta->close();
        until(
            [&] {
                const auto snapshot = second.snapshot();
                return snapshot.connected && snapshot.connection == "Streaming" &&
                       snapshot.epoch > reconnect_epoch;
            },
            "Interrupted transport did not reconnect");
        second.fresh_pairing();
        until(
            [&] {
                const auto snapshot = second.snapshot();
                return relay.created_count() == 2 && snapshot.connected &&
                       snapshot.connection == "Streaming";
            },
            "Fresh pairing did not reconnect");
        check(relay.revoked_count() == 1 &&
                  relay.current_identity().at("bindingId") != saved.at("bindingId"),
              "Fresh pairing did not revoke and replace the old identity");
        check(relay.error().empty(), "Relay contract failure occurred");
        second.stop();
        relay.stop();
        check(!leaked_epoch_clock, "A connection epoch inherited a stale clock map");
        {
            std::lock_guard lock(event_mutex);
            for (const auto& event : events) {
                const auto metadata = event.attributes.dump() +
                                      std::string(event.payload.begin(), event.payload.end());
                for (const char* key :
                     {"secret", "invitationSecret", "deviceId", "bindingId", "code"})
                    check(metadata.find(saved.at(key).get<std::string>()) == std::string::npos,
                          "A credential entered the recording event stream");
            }
        }
        dual_camera_test(directory);
        depth_channel_test(directory);
        depth_control_test(directory);
        std::filesystem::remove(identity_file);
        std::filesystem::remove(std::filesystem::path(identity_file.string() + ".lock"));
        std::filesystem::remove(directory);
        std::cout << "PASS: Native Bridge pairing, protected identity, WebRTC media, source events "
                     "and reconnection\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
