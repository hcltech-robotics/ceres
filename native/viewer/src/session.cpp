#include "ceres/session.hpp"
#include "ceres/protocol.hpp"
#include "ceres/depth.hpp"
#define MCAP_IMPLEMENTATION
#define MCAP_PUBLIC
#ifndef MCAP_COMPRESSION_NO_LZ4
#define MCAP_COMPRESSION_NO_LZ4
#endif
#ifndef MCAP_COMPRESSION_NO_ZSTD
#define MCAP_COMPRESSION_NO_ZSTD
#endif
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable : 4996)
#endif
#include <mcap/writer.hpp>
#ifdef _MSC_VER
#pragma warning(pop)
#endif
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <map>
#include <mutex>
#include <stdexcept>
#include <thread>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

namespace ceres {
namespace {
constexpr uint8_t magic[] = {0x89, 'M', 'C', 'A', 'P', '0', '\r', '\n'};
constexpr size_t max_header = 1024 * 1024;
constexpr uint64_t max_payload = 128ULL * 1024 * 1024;
const char* kind_name(EventKind kind) {
    switch (kind) {
    case EventKind::Pose:
        return "pose";
    case EventKind::Video:
        return "video";
    case EventKind::Depth:
        return "depth";
    case EventKind::Clock:
        return "clock";
    case EventKind::Epoch:
        return "epoch";
    case EventKind::Calibration:
        return "calibration";
    case EventKind::Episode:
        return "episode";
    case EventKind::Asset:
        return "asset";
    default:
        return "metadata";
    }
}
EventKind parse_kind(const std::string& value) {
    for (const auto kind : {EventKind::Pose, EventKind::Video, EventKind::Depth,
                            EventKind::Metadata, EventKind::Clock, EventKind::Epoch,
                            EventKind::Calibration, EventKind::Episode, EventKind::Asset})
        if (value == kind_name(kind))
            return kind;
    throw std::runtime_error("Unknown session event kind: " + value);
}
uint32_t read32(const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
uint64_t read64(const uint8_t* p) {
    return uint64_t(read32(p)) | uint64_t(read32(p + 4)) << 32;
}
Json event_header(std::span<const uint8_t> bytes) {
    if (bytes.size() < 8 || std::memcmp(bytes.data(), "CSE1", 4) != 0)
        throw std::runtime_error("Invalid Ceres session envelope");
    const auto size = read32(bytes.data() + 4);
    if (size > max_header || size > bytes.size() - 8)
        throw std::runtime_error("Invalid Ceres session header length");
    auto header = Json::parse(bytes.begin() + 8, bytes.begin() + 8 + size);
    if (header.value("version", 0) != 1 || !header.value("attributes", Json::object()).is_object())
        throw std::runtime_error("Unsupported Ceres session header");
    return header;
}
SessionEvent from_header(const Json& h) {
    SessionEvent e;
    e.kind = parse_kind(h.at("kind").get<std::string>());
    e.receive_us = h.at("receive_us").get<int64_t>();
    e.time_us = h.at("time_us").get<int64_t>();
    e.epoch = h.value("epoch", 0U);
    e.space_epoch = h.value("space_epoch", 0U);
    e.sequence = h.value("sequence", 0U);
    e.rtp_timestamp = h.value("rtp_timestamp", 0U);
    e.keyframe = h.value("keyframe", false);
    e.stream = h.value("stream", std::string{});
    e.attributes = h.value("attributes", Json::object());
    return e;
}
void check(const mcap::Status& status) {
    if (!status.ok())
        throw std::runtime_error(status.message);
}
class DurableFile final : public mcap::IWritable {
  public:
    explicit DurableFile(const std::filesystem::path& path) {
#ifdef _WIN32
        if (_wfopen_s(&file_, path.c_str(), L"wb") != 0)
            file_ = nullptr;
#else
        file_ = std::fopen(path.c_str(), "wb");
#endif
        if (!file_)
            throw std::runtime_error("Cannot create session file: " + path.string());
    }
    ~DurableFile() override {
        if (file_)
            std::fclose(file_);
    }
    uint64_t size() const override {
        return size_;
    }
    void flush() override {
        if (file_ && std::fflush(file_) != 0)
            throw std::runtime_error("Session flush failed");
    }
    void sync() {
        flush();
#ifdef _WIN32
        if (_commit(_fileno(file_)) != 0)
            throw std::runtime_error("Session sync failed");
#else
        if (::fsync(fileno(file_)) != 0)
            throw std::runtime_error("Session sync failed");
#endif
    }
    void end() override {
        sync();
    }
    void close() {
        if (!file_)
            return;
        auto* file = file_;
        file_ = nullptr;
        if (std::fclose(file) != 0)
            throw std::runtime_error("Session close failed");
    }

  protected:
    void handleWrite(const std::byte* data, uint64_t size) override {
        if (std::fwrite(data, 1, size_t(size), file_) != size)
            throw std::runtime_error("Session write failed");
        size_ += size;
    }

  private:
    std::FILE* file_ = nullptr;
    uint64_t size_ = 0;
};
struct Encoded {
    std::vector<uint8_t> bytes;
    int64_t receive = 0, time = 0;
    uint32_t sequence = 0;
    bool keyframe = false;
    std::string stream, kind;
};
Encoded encoded(const SessionEvent& e, int64_t origin) {
    return {encode_session_event(e, origin),
            std::max<int64_t>(0, e.receive_us - origin),
            std::max<int64_t>(0, e.time_us - origin),
            e.sequence,
            e.keyframe,
            e.stream,
            kind_name(e.kind)};
}
class SessionWriter {
  public:
    SessionWriter(const std::filesystem::path& path, size_t chunk_bytes, int64_t origin)
        : file(path) {
        try {
            mcap::McapWriterOptions options("ceres-session-v1");
            options.compression = mcap::Compression::None;
            options.chunkSize = chunk_bytes;
            writer.open(file, options);
            mcap::Metadata metadata;
            metadata.name = "ceres.session";
            metadata.metadata = {{"version", "1"},
                                 {"origin_us", std::to_string(origin)},
                                 {"encoding", "ceres-session-v1"},
                                 {"time_unit", "microseconds"}};
            check(writer.write(metadata));
            // Detect header/metadata output failure before accepting recording events.
            file.flush();
        } catch (...) {
            // This destructor is skipped on construction failure, but MCAP's is not.
            // Detach the sink before MCAP can attempt another close during unwinding.
            writer.terminate();
            throw;
        }
    }
    ~SessionWriter() {
        writer.terminate();
    }
    void write(const Encoded& e) {
        const std::string topic = "/ceres/" + e.kind + (e.stream.empty() ? "" : "/" + e.stream);
        auto it = channels.find(topic);
        if (it == channels.end()) {
            mcap::Channel channel(topic, "ceres-session-v1", 0);
            writer.addChannel(channel);
            it = channels.emplace(topic, channel.id).first;
        }
        mcap::Message message;
        message.channelId = it->second;
        message.sequence = e.sequence;
        message.logTime = uint64_t(e.receive) * 1000;
        message.publishTime = uint64_t(e.time) * 1000;
        message.data = reinterpret_cast<const std::byte*>(e.bytes.data());
        message.dataSize = e.bytes.size();
        check(writer.write(message));
        if (e.kind == "video" && e.keyframe) {
            const auto header = event_header(e.bytes);
            keyframes.push_back({{"stream", e.stream},
                                 {"receive_us", e.receive},
                                 {"time_us", e.time},
                                 {"sequence", e.sequence},
                                 {"epoch", header.value("epoch", 0U)},
                                 {"space_epoch", header.value("space_epoch", 0U)}});
        }
        ++count;
    }
    void checkpoint() {
        writer.closeLastChunk();
        file.sync();
    }
    void close() {
        const auto data = Json{{"version", 1}, {"keyframes", keyframes}}.dump();
        mcap::Attachment attachment;
        attachment.name = "ceres.keyframes.json";
        attachment.mediaType = "application/json";
        attachment.data = reinterpret_cast<const std::byte*>(data.data());
        attachment.dataSize = data.size();
        check(writer.write(attachment));
        writer.close();
        file.close();
    }
    uint64_t size() const {
        return file.size();
    }
    uint64_t count = 0;

  private:
    DurableFile file;
    mcap::McapWriter writer;
    std::map<std::string, mcap::ChannelId> channels;
    Json keyframes = Json::array();
};
struct Entry {
    uint64_t offset = 0, size = 0;
    int64_t receive = 0, time = 0;
    EventKind kind{};
    bool keyframe = false, camera_primary = true;
    uint32_t epoch = 0, space_epoch = 0;
    int pose_kind = -1;
    std::string stream, subtype;
};
struct Index {
    std::vector<Entry> entries;
    int64_t origin = 0, duration = 0;
    bool complete = false;
    uint64_t complete_bytes = 8, file_bytes = 0;
};
void read_at(std::ifstream& file, uint64_t at, uint8_t* data, size_t size) {
    file.clear();
    file.seekg(std::streamoff(at));
    file.read(reinterpret_cast<char*>(data), std::streamsize(size));
    if (size_t(file.gcount()) != size)
        throw std::runtime_error("Truncated session record");
}
Index index_file(const std::filesystem::path& path) {
    Index index;
    index.file_bytes = std::filesystem::file_size(path);
    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("Cannot open session: " + path.string());
    uint8_t prefix[8];
    read_at(file, 0, prefix, 8);
    if (std::memcmp(prefix, magic, 8))
        throw std::runtime_error("Not an MCAP session");
    auto read_messages = [&](uint64_t begin, uint64_t end) {
        while (begin + 9 <= end) {
            uint8_t record[9];
            read_at(file, begin, record, 9);
            const auto size = read64(record + 1);
            if (size > end - begin - 9)
                throw std::runtime_error("Truncated chunk record");
            if (record[0] == 5 && size >= 30) {
                const uint64_t envelope = begin + 9 + 22;
                uint8_t header[8];
                read_at(file, envelope, header, 8);
                if (std::memcmp(header, "CSE1", 4) == 0) {
                    const auto length = read32(header + 4);
                    if (length > max_header || length > size - 30 || size - 22 > max_payload)
                        throw std::runtime_error("Invalid session envelope size");
                    std::vector<uint8_t> bytes(8 + length);
                    std::copy(header, header + 8, bytes.begin());
                    read_at(file, envelope + 8, bytes.data() + 8, length);
                    const auto h = event_header(bytes);
                    const auto event = from_header(h);
                    Entry entry;
                    entry.offset = envelope;
                    entry.size = size - 22;
                    entry.receive = h.at("session_receive_us").get<int64_t>();
                    entry.time = h.at("session_time_us").get<int64_t>();
                    if (entry.receive < 0 || entry.time < 0)
                        throw std::runtime_error("Negative session time");
                    entry.kind = event.kind;
                    entry.stream = event.stream;
                    entry.subtype = event.attributes.value(
                        "type", event.attributes.value("reason", std::string{}));
                    entry.keyframe = event.keyframe;
                    entry.camera_primary = event.attributes.value("camera_primary", true);
                    entry.epoch = event.epoch;
                    entry.space_epoch = event.space_epoch;
                    entry.pose_kind = h.value("pose_kind", -1);
                    if (index.entries.empty())
                        index.origin = event.receive_us - entry.receive;
                    index.duration = std::max(index.duration, entry.receive);
                    index.entries.push_back(std::move(entry));
                }
            }
            begin += 9 + size;
        }
        if (begin != end)
            throw std::runtime_error("Incomplete MCAP chunk");
    };
    uint64_t position = 8;
    bool footer = false;
    while (position + 9 <= index.file_bytes) {
        uint8_t record[9];
        read_at(file, position, record, 9);
        const auto size = read64(record + 1);
        if (size > index.file_bytes - position - 9)
            break;
        const uint64_t body = position + 9;
        if (record[0] == 6) {
            if (size < 40)
                break;
            uint8_t chunk[32];
            read_at(file, body, chunk, 32);
            const auto compression_size = read32(chunk + 28);
            if (compression_size != 0)
                throw std::runtime_error("Compressed sessions are not supported");
            uint8_t data_length[8];
            read_at(file, body + 32, data_length, 8);
            const auto data_size = read64(data_length);
            if (data_size != size - 40 || read64(chunk + 16) != data_size)
                throw std::runtime_error("Invalid MCAP chunk length");
            read_messages(body + 40, body + size);
        } else if (record[0] == 5) {
            read_messages(position, position + 9 + size);
        } else if (record[0] == 2)
            footer = true;
        position += 9 + size;
        index.complete_bytes = position;
    }
    if (footer && position + 8 == index.file_bytes) {
        read_at(file, position, prefix, 8);
        index.complete = std::memcmp(prefix, magic, 8) == 0;
        if (index.complete)
            index.complete_bytes = index.file_bytes;
    }
    std::stable_sort(index.entries.begin(), index.entries.end(),
                     [](const Entry& a, const Entry& b) { return a.receive < b.receive; });
    return index;
}
SessionEvent load_event(std::ifstream& file, const Entry& entry) {
    std::vector<uint8_t> bytes(size_t(entry.size));
    read_at(file, entry.offset, bytes.data(), bytes.size());
    return decode_session_event(bytes);
}
} // namespace

std::vector<uint8_t> encode_session_event(const SessionEvent& e, int64_t origin) {
    Json header{{"version", 1},
                {"kind", kind_name(e.kind)},
                {"receive_us", e.receive_us},
                {"time_us", e.time_us},
                {"session_receive_us", std::max<int64_t>(0, e.receive_us - origin)},
                {"session_time_us", std::max<int64_t>(0, e.time_us - origin)},
                {"epoch", e.epoch},
                {"space_epoch", e.space_epoch},
                {"sequence", e.sequence},
                {"rtp_timestamp", e.rtp_timestamp},
                {"keyframe", e.keyframe},
                {"stream", e.stream},
                {"attributes", e.attributes}};
    if (e.kind == EventKind::Pose && !e.payload.empty()) {
        try {
            header["pose_kind"] = decode_pose(e.payload, e.receive_us).kind;
        } catch (const std::exception&) {
            header["pose_kind"] = -1;
        }
    }
    const auto text = header.dump();
    if (text.size() > max_header || e.payload.size() > max_payload - 8 - text.size())
        throw std::runtime_error("Session event exceeds size limit");
    std::vector<uint8_t> bytes(8 + text.size() + e.payload.size());
    std::memcpy(bytes.data(), "CSE1", 4);
    for (int i = 0; i < 4; ++i)
        bytes[4 + i] = uint8_t(text.size() >> (8 * i));
    std::memcpy(bytes.data() + 8, text.data(), text.size());
    std::copy(e.payload.begin(), e.payload.end(), bytes.begin() + 8 + text.size());
    return bytes;
}
SessionEvent decode_session_event(std::span<const uint8_t> bytes) {
    auto event = from_header(event_header(bytes));
    const auto start = size_t(8 + read32(bytes.data() + 4));
    event.payload.assign(bytes.begin() + start, bytes.end());
    return event;
}

struct Recorder::Impl {
    mutable std::mutex mutex;
    std::condition_variable changed;
    std::thread worker;
    std::deque<Encoded> queue;
    RecorderStatus state;
    RecorderOptions options;
    std::filesystem::path partial;
    int64_t origin = 0, active_since_us = 0, capture_start_us = 0;
    std::optional<int64_t> capture_end_us;
    uint32_t source_epoch = 0, source_space_epoch = 0;
    bool stopping = false, resume_video_gate = false;
    std::map<std::string, uint32_t> resumed_video_epochs;
    std::map<std::string, Encoded> paused_controls;
    size_t paused_control_bytes = 0;
    std::unique_ptr<SessionWriter> writer;
    int64_t active_contribution(int64_t now) const {
        if (!state.recording || state.paused)
            return 0;
        const auto end = capture_end_us ? std::min(now, *capture_end_us) : now;
        return std::max<int64_t>(0, end - std::max(active_since_us, capture_start_us));
    }
    void freeze_active_clock(int64_t now) {
        state.active_duration_us += active_contribution(now);
        active_since_us = now;
    }
    void fail(const std::exception& error) {
        freeze_active_clock(monotonic_us());
        state.failed = true;
        state.recording = state.paused = false;
        state.error = error.what();
        stopping = true;
        paused_controls.clear();
        paused_control_bytes = 0;
        changed.notify_one();
    }
    void observe_identity(const SessionEvent& event) {
        if (event.kind == EventKind::Epoch || event.kind == EventKind::Pose ||
            event.kind == EventKind::Video || event.kind == EventKind::Depth) {
            source_epoch = event.epoch;
            source_space_epoch = event.space_epoch;
        }
        if (event.kind == EventKind::Epoch && resume_video_gate)
            resumed_video_epochs.clear();
    }
    void enqueue(Encoded item) {
        if (item.bytes.size() > options.queue_bytes - state.queued_bytes)
            throw std::runtime_error("Recording stopped because the storage queue is full");
        state.queued_bytes += item.bytes.size();
        queue.push_back(std::move(item));
        ++state.accepted_events;
    }
    void retain_control(const SessionEvent& event) {
        if (event.kind == EventKind::Pose || event.kind == EventKind::Video ||
            event.kind == EventKind::Depth || event.kind == EventKind::Episode)
            return;
        auto item = encoded(event, origin);
        const auto subtype = event.attributes.value(
            "type", event.attributes.value("reason", std::string{}));
        const auto key = std::string(kind_name(event.kind)) + "/" + event.stream + "/" + subtype;
        const auto previous = paused_controls.find(key);
        const auto previous_bytes = previous == paused_controls.end() ? 0 : previous->second.bytes.size();
        const auto remaining_bytes = paused_control_bytes - previous_bytes;
        if (item.bytes.size() > options.queue_bytes - remaining_bytes)
            throw std::runtime_error("Paused recording state exceeds recorder buffer");
        paused_control_bytes = remaining_bytes + item.bytes.size();
        paused_controls.insert_or_assign(key, std::move(item));
    }
    SessionEvent pause_marker(bool paused, int64_t now) const {
        SessionEvent event;
        event.kind = EventKind::Epoch;
        event.receive_us = event.time_us = now;
        event.epoch = source_epoch;
        event.space_epoch = source_space_epoch;
        event.attributes = {{"reason", paused ? "record-pause" : "record-resume"},
                            {"reset_decoder", true},
                            {"active_duration_us", state.active_duration_us}};
        return event;
    }
    void run() {
        try {
            auto deadline = std::chrono::steady_clock::now() +
                            std::chrono::milliseconds(options.flush_interval_ms);
            for (;;) {
                Encoded item;
                bool have = false, finish = false;
                {
                    std::unique_lock lock(mutex);
                    changed.wait_until(lock, deadline, [&] { return stopping || !queue.empty(); });
                    if (!queue.empty()) {
                        item = std::move(queue.front());
                        queue.pop_front();
                        state.queued_bytes -= item.bytes.size();
                        have = true;
                    } else
                        finish = stopping;
                }
                if (have) {
                    writer->write(item);
                    std::lock_guard lock(mutex);
                    state.written_events = writer->count;
                    state.written_bytes = writer->size();
                    state.duration_us = std::max(state.duration_us, item.receive);
                }
                if (std::chrono::steady_clock::now() >= deadline) {
                    writer->checkpoint();
                    deadline = std::chrono::steady_clock::now() +
                               std::chrono::milliseconds(options.flush_interval_ms);
                }
                if (finish)
                    break;
            }
            writer->close();
            {
                std::lock_guard lock(mutex);
                state.written_bytes = writer->size();
                freeze_active_clock(monotonic_us());
                state.recording = state.paused = false;
            }
            std::filesystem::rename(partial, state.path);
        } catch (const std::exception& error) {
            std::lock_guard lock(mutex);
            fail(error);
            queue.clear();
            state.queued_bytes = 0;
        }
        writer.reset();
    }
};
Recorder::Recorder() : impl_(std::make_unique<Impl>()) {}
Recorder::~Recorder() {
    stop();
}
void Recorder::start(const std::filesystem::path& path, const std::vector<SessionEvent>& initial,
                     RecorderOptions options) {
    stop();
    if (options.queue_bytes == 0 || options.chunk_bytes == 0 || options.flush_interval_ms <= 0)
        throw std::invalid_argument("Invalid recorder buffer configuration");
    auto& p = *impl_;
    std::lock_guard lock(p.mutex);
    p.state = {};
    p.state.path = path;
    p.partial = path.string() + ".partial";
    if (std::filesystem::exists(path) || std::filesystem::exists(p.partial))
        throw std::runtime_error("Session destination already exists");
    if (!path.parent_path().empty())
        std::filesystem::create_directories(path.parent_path());
    p.options = options;
    p.origin = monotonic_us();
    for (const auto& e : initial)
        if (e.receive_us > 0)
            p.origin = std::min(p.origin, e.receive_us);
    p.queue.clear();
    p.stopping = false;
    p.source_epoch = p.source_space_epoch = 0;
    p.capture_start_us = 0;
    p.capture_end_us.reset();
    p.resume_video_gate = false;
    p.resumed_video_epochs.clear();
    p.paused_controls.clear();
    p.paused_control_bytes = 0;
    for (auto event : initial) {
        if (!event.receive_us)
            event.receive_us = p.origin;
        if (!event.time_us)
            event.time_us = event.receive_us;
        p.observe_identity(event);
        auto item = encoded(event, p.origin);
        if (p.state.queued_bytes + item.bytes.size() > options.queue_bytes)
            throw std::runtime_error("Initial session state exceeds recorder buffer");
        p.state.queued_bytes += item.bytes.size();
        p.queue.push_back(std::move(item));
        ++p.state.accepted_events;
    }
    p.writer = std::make_unique<SessionWriter>(p.partial, options.chunk_bytes, p.origin);
    p.active_since_us = monotonic_us();
    p.state.recording = true;
    p.worker = std::thread([&p] { p.run(); });
}
bool Recorder::push(const SessionEvent& event) {
    auto& p = *impl_;
    std::lock_guard lock(p.mutex);
    if (!p.state.recording || p.stopping)
        return false;
    try {
        p.observe_identity(event);
        if (p.state.paused) {
            p.retain_control(event);
            return false;
        }
        if ((event.kind == EventKind::Pose || event.kind == EventKind::Video ||
             event.kind == EventKind::Depth) &&
            (event.receive_us < p.capture_start_us ||
             (p.capture_end_us && event.receive_us >= *p.capture_end_us)))
            return false;
        if (event.kind == EventKind::Video && p.resume_video_gate) {
            const auto resumed = p.resumed_video_epochs.find(event.stream);
            if (!event.keyframe &&
                (resumed == p.resumed_video_epochs.end() || resumed->second != event.epoch))
                return false;
            if (event.keyframe)
                p.resumed_video_epochs[event.stream] = event.epoch;
        }
        p.enqueue(encoded(event, p.origin));
        p.changed.notify_one();
        return true;
    } catch (const std::exception& error) {
        p.fail(error);
        return false;
    }
}
void Recorder::set_capture_window(int64_t start_us, std::optional<int64_t> end_us) {
    if (start_us < 0 || (end_us && *end_us < start_us))
        throw std::invalid_argument("Invalid recording capture interval");
    auto& p = *impl_;
    std::lock_guard lock(p.mutex);
    if (p.capture_start_us == start_us && p.capture_end_us == end_us)
        return;
    p.freeze_active_clock(monotonic_us());
    p.capture_start_us = start_us;
    p.capture_end_us = end_us;
}
void Recorder::set_paused(bool paused) {
    auto& p = *impl_;
    std::lock_guard lock(p.mutex);
    if (!p.state.recording || p.stopping || p.state.paused == paused)
        return;
    try {
        const auto now = monotonic_us();
        if (paused) {
            p.freeze_active_clock(now);
            p.enqueue(encoded(p.pause_marker(true, now), p.origin));
            p.state.paused = true;
        } else {
            auto marker = encoded(p.pause_marker(false, now), p.origin);
            if (p.paused_control_bytes > p.options.queue_bytes - p.state.queued_bytes ||
                marker.bytes.size() >
                    p.options.queue_bytes - p.state.queued_bytes - p.paused_control_bytes)
                throw std::runtime_error("Recording stopped because the storage queue is full");
            std::vector<Encoded> controls;
            controls.reserve(p.paused_controls.size());
            for (auto& [key, item] : p.paused_controls)
                controls.push_back(std::move(item));
            std::stable_sort(controls.begin(), controls.end(),
                             [](const Encoded& a, const Encoded& b) { return a.receive < b.receive; });
            for (auto& item : controls)
                p.enqueue(std::move(item));
            p.paused_controls.clear();
            p.paused_control_bytes = 0;
            p.enqueue(std::move(marker));
            p.active_since_us = now;
            p.state.paused = false;
        }
        p.resume_video_gate = true;
        p.resumed_video_epochs.clear();
        p.changed.notify_one();
    } catch (const std::exception& error) {
        p.fail(error);
    }
}
void Recorder::stop() {
    auto& p = *impl_;
    {
        std::lock_guard lock(p.mutex);
        p.freeze_active_clock(monotonic_us());
        p.stopping = true;
        p.state.recording = p.state.paused = false;
        p.paused_controls.clear();
        p.paused_control_bytes = 0;
    }
    p.changed.notify_one();
    if (p.worker.joinable())
        p.worker.join();
}
RecorderStatus Recorder::status() const {
    std::lock_guard lock(impl_->mutex);
    auto state = impl_->state;
    state.active_duration_us += impl_->active_contribution(monotonic_us());
    return state;
}
bool Recorder::add_episode(const std::string& name, const Json& attributes) {
    SessionEvent event;
    event.kind = EventKind::Episode;
    event.receive_us = event.time_us = monotonic_us();
    event.attributes = attributes;
    event.attributes["name"] = name;
    return push(event);
}

RecoveryResult recover_session(const std::filesystem::path& input,
                               const std::filesystem::path& output) {
    if (std::filesystem::exists(output) || std::filesystem::exists(output.string() + ".partial"))
        throw std::runtime_error("Recovery destination already exists");
    const auto index = index_file(input);
    if (index.entries.empty())
        throw std::runtime_error("No complete session events to recover");
    if (!output.parent_path().empty())
        std::filesystem::create_directories(output.parent_path());
    const auto temporary = std::filesystem::path(output.string() + ".partial");
    SessionWriter writer(temporary, 4 * 1024 * 1024, index.origin);
    std::ifstream file(input, std::ios::binary);
    for (const auto& entry : index.entries)
        writer.write(encoded(load_event(file, entry), index.origin));
    writer.close();
    std::filesystem::rename(temporary, output);
    return {output, index.entries.size(), index.file_bytes - index.complete_bytes, !index.complete};
}

struct ReplaySource::Impl {
    std::filesystem::path source_path;
    Index index;
    std::vector<size_t> pose_entries, episode_entries, video_entries;
    std::map<std::string, size_t> delivered_assets;
    mutable std::mutex mutex;
    std::condition_variable changed;
    std::thread worker;
    EventSink sink;
    ReceiverSnapshot state;
    std::optional<int64_t> space_receive_us;
    int64_t anchor_position = 0, anchor_wall = 0;
    double multiplier = 1;
    bool active = false, playing = true, pending_seek = true, stopping = false;
    bool contains_depth_frames = false;
    uint64_t generation = 0;
    size_t cursor = 0;
    explicit Impl(const std::filesystem::path& path) : source_path(path), index(index_file(path)) {
        state.connection = "Replay ready";
        anchor_wall = monotonic_us();
        for (size_t i = 0; i < index.entries.size(); ++i) {
            if (index.entries[i].kind == EventKind::Pose)
                pose_entries.push_back(i);
            else if (index.entries[i].kind == EventKind::Episode)
                episode_entries.push_back(i);
            else if (index.entries[i].kind == EventKind::Video && index.entries[i].camera_primary)
                video_entries.push_back(i);
            else if (index.entries[i].kind == EventKind::Depth)
                contains_depth_frames = true;
        }
        std::stable_sort(pose_entries.begin(), pose_entries.end(), [&](size_t a, size_t b) {
            return index.entries[a].time < index.entries[b].time;
        });
    }
    int64_t position_locked() const {
        if (!active || !playing || pending_seek)
            return anchor_position;
        return std::clamp(anchor_position + int64_t((monotonic_us() - anchor_wall) * multiplier),
                          int64_t(0), index.duration);
    }
    bool cancelled(uint64_t token) {
        std::lock_guard lock(mutex);
        return stopping || generation != token;
    }
    void adopt_space(const SessionEvent& e) {
        // A seek restores controls and poses before decoding older video. Those
        // older observations must not undo the reference space at the seek target.
        if (space_receive_us && e.receive_us < *space_receive_us)
            return;
        if (state.epoch != e.epoch || state.space_epoch != e.space_epoch)
            state.poses = {};
        state.epoch = e.epoch;
        state.space_epoch = e.space_epoch;
        space_receive_us = e.receive_us;
    }
    void apply(const SessionEvent& e, bool preroll) {
        if (e.kind == EventKind::Pose) {
            const auto pose = decode_pose(e.payload, e.receive_us);
            adopt_space(e);
            if (e.epoch == state.epoch && e.space_epoch == state.space_epoch && pose.kind >= 1 &&
                pose.kind <= state.poses.size())
                state.poses[pose.kind - 1] = pose;
            ++state.received;
        } else if (e.kind == EventKind::Video) {
            if (!preroll)
                adopt_space(e);
            ++state.video_frames;
            state.video_bytes += e.payload.size();
        } else if (e.kind == EventKind::Depth) {
            const auto depth = decode_depth(e.payload);
            if (depth.epoch != e.epoch || depth.space_epoch != e.space_epoch ||
                depth.sequence != e.sequence)
                throw std::runtime_error("Recorded depth identity differs from its envelope");
            if (!space_receive_us)
                adopt_space(e);
            if (e.epoch == state.epoch && e.space_epoch == state.space_epoch) {
                ++state.depth_frames;
                state.depth_bytes += e.payload.size();
                state.depth_status = "streaming";
                state.depth_usage = depth.usage;
            }
        } else if (e.kind == EventKind::Epoch) {
            state.epoch = e.epoch;
            state.space_epoch = e.space_epoch;
            space_receive_us = e.receive_us;
            state.poses = {};
            state.depth_status = "waiting";
            if (e.attributes.value("reason", std::string{}) == "connection")
                state.camera = {};
        } else if (e.kind == EventKind::Clock) {
            state.clock = {e.attributes.value("offset_us", 0.0),
                           e.attributes.value("uncertainty_us", 0.0),
                           e.attributes.value("rate", 1.0), e.attributes.value("valid", false)};
        } else if (e.kind == EventKind::Metadata &&
                   e.attributes.value("type", std::string{}) == "depth-status") {
            state.depth_status = e.attributes.value("status", std::string{"unsupported"});
            if (const auto usage = e.attributes.find("usage"); usage != e.attributes.end())
                state.depth_usage = usage->is_string() ? usage->get<std::string>() : "";
        } else if (e.kind == EventKind::Metadata &&
                   e.attributes.value("type", std::string{}) != "connection") {
            try {
                state.camera = parse_description(e.attributes);
            } catch (const std::exception&) {
            }
        }
    }
    void deliver(SessionEvent e, const Entry* entry, uint64_t token, bool preroll = false) {
        EventSink callback;
        {
            std::lock_guard lock(mutex);
            if (generation != token || stopping)
                return;
            if (entry)
                apply(e, preroll);
            if (e.kind == EventKind::Depth &&
                (e.epoch != state.epoch || e.space_epoch != state.space_epoch))
                return;
            const auto now = monotonic_us();
            const auto position = position_locked();
            e.attributes["recorded_receive_us"] = e.receive_us;
            e.attributes["recorded_time_us"] = e.time_us;
            e.attributes["session_receive_us"] = entry ? entry->receive : position;
            e.attributes["session_time_us"] = entry ? entry->time : position;
            e.attributes["replay_generation"] = token;
            e.attributes["replay_preroll"] = preroll;
            e.attributes["replay_delivery_us"] = now;
            if (entry) {
                e.receive_us = now + int64_t((entry->receive - position) / multiplier);
                e.time_us = now + int64_t((entry->time - position) / multiplier);
            } else
                e.receive_us = e.time_us = now;
            callback = sink;
        }
        if (callback) {
            callback(e);
            if (entry && entry->kind == EventKind::Asset) {
                std::lock_guard lock(mutex);
                // A cancelled callback may already have installed its asset. Invalidate the
                // old identity so the next generation restores its own asset even on A->B->A.
                if (generation == token && !stopping)
                    delivered_assets[entry->stream] = size_t(entry - index.entries.data());
                else
                    delivered_assets.erase(entry->stream);
            }
        }
    }
    void deliver_entry(std::ifstream& file, size_t i, uint64_t token, bool preroll = false) {
        const auto& entry = index.entries[i];
        {
            std::lock_guard lock(mutex);
            if (generation != token || stopping)
                return;
            if (entry.kind == EventKind::Asset) {
                const auto previous = delivered_assets.find(entry.stream);
                if (previous != delivered_assets.end() && previous->second == i)
                    return;
            }
        }
        deliver(load_event(file, entry), &entry, token, preroll);
    }
    void restore(std::ifstream& file, int64_t target, uint64_t token) {
        std::map<std::string, size_t> latest, keys, final_video;
        size_t after = 0;
        for (; after < index.entries.size() && index.entries[after].receive <= target; ++after) {
            if ((after & 255) == 0 && cancelled(token))
                return;
            const auto& e = index.entries[after];
            if (e.kind == EventKind::Epoch) {
                for (auto it = latest.begin(); it != latest.end();)
                    if (it->first.starts_with("pose/") || it->first.starts_with("depth/"))
                        it = latest.erase(it);
                    else
                        ++it;
                if (e.subtype == "connection" || e.subtype == "record-pause" ||
                    e.subtype == "record-resume") {
                    keys.clear();
                    final_video.clear();
                }
            }
            if (e.kind == EventKind::Video) {
                if (e.keyframe)
                    keys[e.stream] = after;
                final_video[e.stream] = after;
            } else if (e.kind == EventKind::Asset) {
                latest["asset/" + e.stream] = after;
            } else if (e.kind != EventKind::Episode) {
                const auto key = std::string(kind_name(e.kind)) + "/" + e.stream + "/" + e.subtype +
                                 (e.kind == EventKind::Pose ? std::to_string(e.pose_kind) : "");
                latest[key] = after;
            }
        }
        {
            std::lock_guard lock(mutex);
            if (generation != token || stopping)
                return;
            state = {};
            space_receive_us.reset();
            state.connection = "Replay";
            state.connected = true;
        }
        SessionEvent reset;
        reset.kind = EventKind::Epoch;
        reset.attributes = {{"reason", "seek"}, {"reset_decoder", true}};
        deliver(reset, nullptr, token);
        std::vector<size_t> restored;
        for (const auto& [key, i] : latest)
            restored.push_back(i);
        std::sort(restored.begin(), restored.end());
        for (const auto i : restored) {
            if (cancelled(token))
                return;
            deliver_entry(file, i, token);
        }
        for (size_t i = 0; i < after; ++i) {
            const auto& e = index.entries[i];
            if (e.kind != EventKind::Video)
                continue;
            const auto key = keys.find(e.stream);
            if (key == keys.end() || i < key->second)
                continue;
            if (cancelled(token))
                return;
            deliver_entry(file, i, token, i != final_video[e.stream]);
        }
        {
            std::lock_guard lock(mutex);
            if (generation != token || stopping)
                return;
            cursor = after;
            anchor_position = target;
            anchor_wall = monotonic_us();
            pending_seek = false;
        }
    }
    void run() {
        try {
            std::ifstream file(source_path, std::ios::binary);
            for (;;) {
                size_t next = 0;
                int64_t target = 0;
                uint64_t token;
                bool restoring;
                {
                    std::unique_lock lock(mutex);
                    changed.wait(lock, [&] { return stopping || pending_seek || playing; });
                    if (stopping)
                        break;
                    token = generation;
                    restoring = pending_seek;
                    target = anchor_position;
                    if (!restoring) {
                        if (cursor >= index.entries.size()) {
                            anchor_position = index.duration;
                            playing = false;
                            state.connection = "Replay complete";
                            continue;
                        }
                        const auto position = position_locked();
                        const auto delay = index.entries[cursor].receive - position;
                        if (delay > 0) {
                            changed.wait_for(
                                lock,
                                std::chrono::microseconds(std::min<int64_t>(
                                    50000, std::max<int64_t>(1, int64_t(delay / multiplier)))));
                            continue;
                        }
                        next = cursor++;
                    }
                }
                if (restoring)
                    restore(file, target, token);
                else
                    deliver_entry(file, next, token);
            }
        } catch (const std::exception& error) {
            std::lock_guard lock(mutex);
            state.error = error.what();
            state.connection = "Replay error";
            playing = false;
        }
    }
};
ReplaySource::ReplaySource(const std::filesystem::path& path)
    : impl_(std::make_unique<Impl>(path)) {}
ReplaySource::~ReplaySource() {
    stop();
}
void ReplaySource::start() {
    auto& p = *impl_;
    std::lock_guard lock(p.mutex);
    if (p.active)
        return;
    p.active = true;
    p.stopping = false;
    p.pending_seek = true;
    p.delivered_assets.clear();
    p.anchor_wall = monotonic_us();
    p.worker = std::thread([&p] { p.run(); });
}
void ReplaySource::stop() {
    auto& p = *impl_;
    {
        std::lock_guard lock(p.mutex);
        p.anchor_position = p.position_locked();
        p.active = false;
        p.stopping = true;
        ++p.generation;
    }
    p.changed.notify_all();
    if (p.worker.joinable())
        p.worker.join();
}
ReceiverSnapshot ReplaySource::snapshot() const {
    auto& p = *impl_;
    std::lock_guard lock(p.mutex);
    auto state = p.state;
    const auto now = monotonic_us();
    const auto position = p.position_locked();
    state.now_us = now;
    for (auto& pose : state.poses)
        if (pose)
            pose->received_us =
                now + int64_t((pose->received_us - p.index.origin - position) / p.multiplier);
    state.clock.offset_us =
        now + (state.clock.offset_us - p.index.origin - position) / p.multiplier;
    state.clock.rate /= p.multiplier;
    return state;
}
void ReplaySource::set_event_sink(EventSink sink) {
    auto& p = *impl_;
    {
        std::lock_guard lock(p.mutex);
        p.sink = std::move(sink);
        p.delivered_assets.clear();
        if (p.active) {
            p.anchor_position = p.position_locked();
            p.anchor_wall = monotonic_us();
            p.pending_seek = true;
            ++p.generation;
        }
    }
    p.changed.notify_all();
}
void ReplaySource::seek(int64_t value) {
    auto& p = *impl_;
    {
        std::lock_guard lock(p.mutex);
        p.anchor_position = std::clamp(value, int64_t(0), p.index.duration);
        p.anchor_wall = monotonic_us();
        p.pending_seek = true;
        ++p.generation;
    }
    p.changed.notify_all();
}
int64_t ReplaySource::step_frame(int direction) {
    if (direction != -1 && direction != 1)
        throw std::invalid_argument("Frame direction must be -1 or 1");
    auto& p = *impl_;
    int64_t target;
    {
        std::lock_guard lock(p.mutex);
        target = p.position_locked();
        if (!p.video_entries.empty()) {
            if (direction > 0) {
                auto next = std::upper_bound(
                    p.video_entries.begin(), p.video_entries.end(), target,
                    [&](int64_t time, size_t i) { return time < p.index.entries[i].receive; });
                if (next == p.video_entries.end())
                    --next;
                target = p.index.entries[*next].receive;
            } else {
                auto previous = std::lower_bound(
                    p.video_entries.begin(), p.video_entries.end(), target,
                    [&](size_t i, int64_t time) { return p.index.entries[i].receive < time; });
                if (previous != p.video_entries.begin())
                    --previous;
                target = p.index.entries[*previous].receive;
            }
        }
        p.playing = false;
        p.anchor_position = target;
        p.anchor_wall = monotonic_us();
        p.pending_seek = true;
        ++p.generation;
    }
    p.changed.notify_all();
    return target;
}
void ReplaySource::set_playing(bool playing) {
    auto& p = *impl_;
    {
        std::lock_guard lock(p.mutex);
        p.anchor_position = p.position_locked();
        p.anchor_wall = monotonic_us();
        p.playing = playing;
    }
    p.changed.notify_all();
}
void ReplaySource::set_speed(double speed) {
    if (!std::isfinite(speed) || speed <= 0 || speed > 16)
        throw std::invalid_argument("Replay speed must be in (0, 16]");
    auto& p = *impl_;
    {
        std::lock_guard lock(p.mutex);
        p.anchor_position = p.position_locked();
        p.anchor_wall = monotonic_us();
        p.multiplier = speed;
    }
    p.changed.notify_all();
}
double ReplaySource::speed() const {
    std::lock_guard lock(impl_->mutex);
    return impl_->multiplier;
}
bool ReplaySource::playing() const {
    std::lock_guard lock(impl_->mutex);
    return impl_->playing;
}
int64_t ReplaySource::duration_us() const {
    return impl_->index.duration;
}
int64_t ReplaySource::position_us() const {
    std::lock_guard lock(impl_->mutex);
    return impl_->position_locked();
}
bool ReplaySource::has_depth_frames() const {
    return impl_->contains_depth_frames;
}
const std::filesystem::path& ReplaySource::path() const {
    return impl_->source_path;
}
std::vector<SessionEvent> ReplaySource::episodes() const {
    const auto& p = *impl_;
    std::ifstream file(p.source_path, std::ios::binary);
    std::vector<SessionEvent> events;
    events.reserve(p.episode_entries.size());
    for (const auto i : p.episode_entries) {
        const auto& entry = p.index.entries[i];
        auto event = load_event(file, entry);
        event.attributes["session_time_us"] = entry.time;
        event.attributes["session_receive_us"] = entry.receive;
        events.push_back(std::move(event));
    }
    return events;
}
Json ReplaySource::task_specification() const {
    std::ifstream file(impl_->source_path, std::ios::binary);
    for (const auto& entry : impl_->index.entries) {
        if (entry.kind != EventKind::Asset || entry.stream != "task-specification")
            continue;
        const auto event = load_event(file, entry);
        if (event.attributes.is_object() &&
            event.attributes.value("schema", Json{}) == "ceres-task-specification")
            return event.attributes;
    }
    return {};
}
std::vector<SessionEvent> ReplaySource::pose_history(int64_t start_us, int64_t end_us) const {
    const auto& p = *impl_;
    std::vector<SessionEvent> events;
    if (start_us > end_us || end_us < 0)
        return events;
    const auto begin =
        std::lower_bound(p.pose_entries.begin(), p.pose_entries.end(), start_us,
                         [&](size_t i, int64_t time) { return p.index.entries[i].time < time; });
    const auto end =
        std::upper_bound(begin, p.pose_entries.end(), end_us,
                         [&](int64_t time, size_t i) { return time < p.index.entries[i].time; });
    events.reserve(size_t(end - begin));
    std::ifstream file(p.source_path, std::ios::binary);
    for (auto it = begin; it != end; ++it) {
        const auto& entry = p.index.entries[*it];
        auto event = load_event(file, entry);
        event.attributes["session_time_us"] = entry.time;
        event.attributes["session_receive_us"] = entry.receive;
        events.push_back(std::move(event));
    }
    return events;
}
} // namespace ceres
