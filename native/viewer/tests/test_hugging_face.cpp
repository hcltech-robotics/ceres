#include "ceres/hugging_face.hpp"
#include <mbedtls/base64.h>
#include <mbedtls/sha1.h>
#include <mbedtls/sha256.h>
#include <atomic>
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>
#ifndef _WIN32
#include <sys/stat.h>
#endif

namespace {
using namespace ceres;
using namespace std::chrono_literals;
const std::string revision(40, 'a'), next_revision(40, 'b');
const std::string access = "fixture-access-value-for-unit-testing";
const std::string refreshed = "fixture-refreshed-value-for-unit-testing";
const std::string mcap = std::string("\x89MCAP0\r\n", 8) + "recorded fixture content";

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
void write(const std::filesystem::path& path, const std::string& bytes) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary);
    file.write(bytes.data(), bytes.size());
    check(bool(file), "Cannot write test fixture");
}
std::string read(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(file), {});
}
std::string hash(std::string bytes, bool git = false) {
    if (git) bytes = "blob " + std::to_string(bytes.size()) + '\0' + bytes;
    unsigned char digest[32]{};
    if (git) check(mbedtls_sha1(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size(), digest) == 0, "SHA1");
    else check(mbedtls_sha256(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size(), digest, 0) == 0, "SHA256");
    const char* digits = "0123456789abcdef";
    std::string result;
    for (size_t i = 0; i < (git ? 20 : 32); ++i) {
        result += digits[digest[i] >> 4]; result += digits[digest[i] & 15];
    }
    return result;
}
std::string decode(const std::string& encoded) {
    std::string result(encoded.size(), '\0'); size_t length = 0;
    check(mbedtls_base64_decode(reinterpret_cast<unsigned char*>(result.data()), result.size(), &length,
          reinterpret_cast<const unsigned char*>(encoded.data()), encoded.size()) == 0, "Invalid commit encoding");
    result.resize(length); return result;
}
hf::Response json(Json body, long status = 200) { return {status, body.dump(), {}}; }
HuggingFaceStatus wait(HuggingFaceClient& client, bool success = true) {
    const auto deadline = std::chrono::steady_clock::now() + 12s;
    for (;;) {
        auto state = client.status();
        if (!state.running) {
            if (success && !state.error.empty()) throw std::runtime_error(state.error);
            return state;
        }
        check(std::chrono::steady_clock::now() < deadline, "Hugging Face test timed out");
        std::this_thread::sleep_for(10ms);
    }
}
void fails(HuggingFaceClient& client, std::string_view expected) {
    const auto state = wait(client, false);
    check(state.error.find(expected) != std::string::npos, "Expected Hugging Face error was not reported");
    check(state.error.find(access) == std::string::npos, "A credential entered a user-facing error");
}
template<class Action> void rejects(Action action) {
    try { action(); } catch (const std::exception&) { return; }
    throw std::runtime_error("Invalid repository input was accepted");
}

struct Hub {
    struct File { std::string bytes; bool lfs = true; };
    std::map<std::string, File> files;
    std::map<std::string, std::string> large_files;
    std::string repository = "tester/captures";
    std::string upload_oid, uploaded, auth_error, last_commit_auth, selected_revision;
    bool exists = true, created_private = false, multipart = false, bad_checksum = false,
         malicious_page = false, paginate = false, delayed_upload = false, mutate_upload = false,
         foreign_verify = false, malformed_header = false;
    int expires_in = 3600, device_expiry = 60;
    std::atomic<int> browser_calls{0}, token_polls{0}, refreshes{0}, downloads{0}, puts{0}, commits{0}, pages{0};
    std::filesystem::path mutate_path;

    Json entries() const {
        auto result = Json::array();
        for (const auto& [path, file] : files) {
            Json entry{{"type", "file"}, {"path", path}, {"size", file.bytes.size()}, {"oid", hash(file.bytes, true)}};
            if (file.lfs) entry["lfs"] = {{"oid", hash(file.bytes)}, {"size", file.bytes.size()}};
            result.push_back(std::move(entry));
        }
        return result;
    }
    hf::Response operator()(const hf::Request& request, std::stop_token stop, const hf::Progress& progress) {
        check(!stop.stop_requested(), "Unexpected cancelled fixture request");
        if (request.url.ends_with("/oauth/device")) {
            check(request.body.find("https%3A%2F%2Fceres.cam") != std::string::npos, "Wrong OAuth client");
            return json({{"device_code", "fixture-device-value"}, {"user_code", "TEST-CODE"},
                         {"verification_uri", "https://hf.co/oauth/device"},
                         {"verification_uri_complete", "https://hf.co/oauth/device?code=TEST-CODE"},
                         {"expires_in", device_expiry}, {"interval", 1}});
        }
        if (request.url.ends_with("/oauth/token")) {
            if (request.body.find("grant_type=refresh_token") != std::string::npos) {
                ++refreshes;
                return json({{"access_token", refreshed}, {"expires_in", 3600}});
            }
            ++token_polls;
            if (!auth_error.empty()) return json({{"error", auth_error}}, 400);
            return json({{"access_token", access}, {"refresh_token", "fixture-refresh-value"}, {"expires_in", expires_in}});
        }
        if (request.url.ends_with("/oauth/userinfo")) return json({{"preferred_username", "tester"}});
        if (request.url.ends_with("/api/repos/create")) {
            const auto value = Json::parse(request.body);
            check(value.at("private") == true && value.at("type") == "dataset", "New dataset is not private");
            check(!value.contains("organization"), "Personal repository incorrectly treated as organisation");
            exists = created_private = true; return json({{"url", "https://huggingface.co/datasets/tester/captures"}});
        }
        if (request.url.ends_with("/api/datasets/" + repository))
            return exists ? json({{"sha", commits ? next_revision : revision}}) : json({{"error", "missing"}}, 404);
        if (request.url.find("/tree/") != request.url.npos) {
            ++pages;
            auto value = entries();
            hf::Response response = json(value);
            if (malicious_page) response.headers["link"] = "<https://external.invalid/steal>; rel=\"next\"";
            else if (paginate && request.url.find("cursor=") == request.url.npos && value.size() >= 2) {
                response = json(Json::array({value[0]}));
                response.headers["link"] = '<' + request.url + "&cursor=second>; rel=\"next\"";
            } else if (paginate && request.url.find("cursor=") != request.url.npos) {
                value.erase(value.begin()); response = json(value);
            }
            return response;
        }
        if (request.url.find("/resolve/") != request.url.npos) {
            ++downloads;
            const auto first = request.url.find("/resolve/") + 9;
            selected_revision = request.url.substr(first, 40);
            auto path = request.url.substr(first + 41);
            path = path.substr(0, path.find('?'));
            check(files.contains(path), "Unexpected recording download");
            auto bytes = files.at(path).bytes;
            if (bad_checksum && !bytes.empty()) bytes.back() ^= 1;
            check(request.maximum_bytes == bytes.size(), "Download is not bounded by the manifest");
            write(request.download, bytes);
            if (progress) progress(bytes.size(), bytes.size());
            return {200, "", {}};
        }
        if (request.url.ends_with("/preupload/main")) {
            auto result = Json::array();
            const auto body = Json::parse(request.body);
            for (const auto& file : body.at("files")) {
                const auto path = file.at("path").get<std::string>();
                result.push_back({{"path", path}, {"uploadMode", path.ends_with(".mcap") ? "lfs" : "regular"}});
            }
            return json({{"files", result}});
        }
        if (request.url.ends_with("/objects/batch")) {
            check(request.headers.at("Accept") == "application/vnd.git-lfs+json" &&
                  request.headers.at("Content-Type") == "application/vnd.git-lfs+json", "LFS media type missing");
            const auto item = Json::parse(request.body).at("objects").at(0);
            upload_oid = item.at("oid").get<std::string>(); uploaded.clear();
            Json upload{{"href", "https://upload.invalid/object"},
                        {"header", {{"x-upload-proof", malformed_header ? "bad\r\nHeader: leak" : "fixture-proof"}}}};
            if (multipart) upload = {{"href", "https://upload.invalid/complete"},
                {"header", {{"chunk_size", "16"}, {"00001", "https://upload.invalid/part1"},
                            {"00002", "https://upload.invalid/part2"}}}};
            Json verify{{"href", foreign_verify ? "https://upload.invalid/verify" : "https://huggingface.co/verify"},
                        {"header", {{"x-verify-proof", "fixture-verify"}}}};
            Json object{{"oid", upload_oid}, {"size", item.at("size")},
                        {"actions", {{"upload", upload}, {"verify", verify}}}};
            return json({{"objects", Json::array({object})}});
        }
        if (request.method == "PUT") {
            ++puts;
            check(!request.headers.contains("Authorization") && !request.headers.contains("authorization"),
                  "Bearer token forwarded to upload origin");
            if (!multipart) check(request.headers.at("x-upload-proof") == "fixture-proof", "Upload action header missing");
            auto bytes = read(request.upload).substr(request.offset, request.length);
            check(bytes.size() == request.length, "Upload slice has wrong length");
            uploaded += bytes;
            if (delayed_upload) std::this_thread::sleep_for(2100ms);
            if (mutate_upload) write(mutate_path, mcap + "changed");
            large_files[upload_oid] = uploaded;
            return {200, "", {{"etag", "fixture-etag"}}};
        }
        if (request.url.ends_with("/complete")) {
            check(Json::parse(request.body).at("parts").size() == 2, "Multipart upload did not complete both slices");
            return {200, "", {}};
        }
        if (request.url.ends_with("/verify")) {
            check(request.headers.at("x-verify-proof") == "fixture-verify", "Verification action header missing");
            if (foreign_verify) check(!request.headers.contains("authorization"), "Bearer token forwarded to foreign verification");
            else check(request.headers.contains("authorization"), "Hub verification is not authenticated");
            return {200, "", {}};
        }
        if (request.url.ends_with("/commit/main")) {
            ++commits;
            last_commit_auth = request.headers.at("Authorization");
            std::istringstream lines(request.body); std::string line;
            while (std::getline(lines, line)) {
                const auto item = Json::parse(line); const auto& value = item.at("value");
                if (item.at("key") == "header") {
                    check(value.at("parentCommit") == revision, "Commit is not guarded by its parent revision");
                } else if (item.at("key") == "file") {
                    files[value.at("path").get<std::string>()] = {decode(value.at("content").get<std::string>()), false};
                } else {
                    files[value.at("path").get<std::string>()] = {large_files.at(value.at("oid").get<std::string>()), true};
                }
            }
            return json({{"commitOid", next_revision}});
        }
        throw std::runtime_error("Unexpected fixture request");
    }
    hf::Transport transport() { return [this](const auto& request, auto stop, const auto& progress) {
        return (*this)(request, stop, progress);
    }; }
    hf::OpenBrowser browser() { return [this](const std::string& url) {
        check(url == "https://hf.co/oauth/device?code=TEST-CODE", "Complete device verification URL not used");
        ++browser_calls; return true;
    }; }
};

void authenticate(HuggingFaceClient& client) {
    check(client.sign_in(), "Sign-in did not start");
    check(wait(client).username == "tester", "Authenticated account missing");
}

void test_auth(const std::filesystem::path& root) {
    Hub hub;
    HuggingFaceClient client(root / "credentials", hub.transport(), hub.browser());
    authenticate(client);
    check(hub.browser_calls == 1 && hub.token_polls == 1, "Device flow did not reach the browser and token endpoints");
#ifdef _WIN32
    check(read(root / "credentials/hugging-face.credential").find(access) == std::string::npos,
          "Windows credential was saved without encryption");
#else
    struct stat info{};
    check(stat((root / "credentials/hugging-face.credential").c_str(), &info) == 0 &&
          (info.st_mode & 0777) == 0600, "Credential permissions are not private");
#endif
    HuggingFaceClient restored(root / "credentials", hub.transport(), hub.browser());
    check(restored.status().username == "tester", "Persisted sign-in was not restored");
    check(restored.sign_out(), "Sign-out did not start"); wait(restored);
    check(!std::filesystem::exists(root / "credentials/hugging-face.credential"), "Sign-out retained the credential");

    hub.auth_error = "access_denied";
    client.sign_in(); fails(client, "declined");
    hub.auth_error = "authorization_pending";
    client.sign_in();
    while (client.status().user_code.empty()) std::this_thread::sleep_for(10ms);
    check(client.status().seconds_remaining > 0, "Device expiry countdown missing");
    check(!client.sign_in(), "Parallel stale sign-in grant started");
    client.cancel(); wait(client);
    check(client.status().user_code.empty(), "Cancelled grant left a stale code");
    hub.device_expiry = 1;
    client.sign_in(); fails(client, "expired");
    hub.auth_error.clear(); hub.device_expiry = 60;
    authenticate(client);
}

void test_browse_download(const std::filesystem::path& root) {
    Hub hub;
    hub.files = {{"recordings/one.mcap", {mcap, true}}, {"recordings/two.mcap", {mcap + "second", false}},
        {"recordings/one.mcap.episodes.json", {"{\"version\":1,\"episodes\":[]}", false}}, {"README.md", {"fixture", false}}};
    hub.paginate = true;
    HuggingFaceClient client(root / "public", hub.transport(), hub.browser());
    client.browse("tester/captures");
    auto state = wait(client);
    check(state.recordings->size() == 2 && hub.pages == 2, "Paginated multiple recordings not listed");
    const auto first = state.recordings->front();
    check(first.episodes_bytes > 0, "Episode sidecar not discovered");
    client.download(first, root / "downloads"); wait(client);
    const auto output = client.take_download();
    check(read(output) == mcap && hub.selected_revision == revision, "Download did not use the immutable revision");
    auto sidecar = output; sidecar += ".episodes.json";
    check(read(sidecar) == hub.files.at("recordings/one.mcap.episodes.json").bytes, "Episode sidecar did not survive download");
    check(client.take_download().empty(), "Download completion was delivered twice");
    const auto requests = hub.downloads.load();
    client.download(first, root / "downloads"); wait(client);
    check(hub.downloads == requests, "Verified cached recording was unnecessarily downloaded");
    write(output, "damaged cached recording");
    hub.bad_checksum = true;
    client.download(first, root / "downloads"); fails(client, "checksum");
    check(!std::filesystem::exists(output.string() + ".partial"), "Corrupt partial download was retained");
    auto forged = first; forged.sha256.clear(); forged.git_oid = "../../outside";
    const auto before = hub.downloads.load();
    client.download(forged, root / "downloads"); fails(client, "metadata");
    check(hub.downloads == before, "Invalid cache hash reached the network");
    forged = first; forged.path = "recordings/NUL.mcap";
    client.download(forged, root / "downloads"); fails(client, "reserved");
    hub.malicious_page = true;
    client.browse("tester/captures"); fails(client, "pagination");
}

void add_dataset(Hub& hub, const std::string& prefix, int episode) {
    hub.files[prefix + "meta/info.json"] = {
        Json{{"codebase_version", "v3.0"}, {"total_episodes", 1}, {"episode", episode}}.dump(), false};
    hub.files[prefix + "meta/tasks.parquet"] = {"recorded task metadata", true};
    hub.files[prefix + "data/chunk-000/file-000.parquet"] = {"recorded pose data " + std::to_string(episode), true};
    hub.files[prefix + "videos/observation.images.passthrough/chunk-000/file-000.mp4"] = {
        "recorded video data " + std::to_string(episode), true};
    hub.files[prefix + "ceres/episode-metadata.json"] = {"{\"schema\":\"ceres-episode-export-metadata\"}", false};
}

void test_dataset_replay(const std::filesystem::path& root) {
    Hub hub;
    hub.repository = "chrisvoncsefalvay/ceres-demos";
    for (int episode = 0; episode < 8; ++episode)
        add_dataset(hub, "shards/episode-00000" + std::to_string(episode) + '/', episode);
    hub.files["README.md"] = {"reference dataset", false};
    hub.paginate = true;
    std::atomic<int> imports{0};
    std::atomic<bool> await_cancel{false}, importing{false};
    std::filesystem::path dataset;
    HuggingFaceClient client(root / "credentials", hub.transport(), hub.browser(),
        [&](const auto& source, const auto& output, std::stop_token stop) {
            ++imports;
            dataset = source;
            check(read(source / "data/chunk-000/file-000.parquet") == "recorded pose data 6",
                  "Dataset importer received another shard's poses");
            check(read(source / "videos/observation.images.passthrough/chunk-000/file-000.mp4") == "recorded video data 6",
                  "Dataset importer received another shard's video");
            check(read(source / "meta/info.json") == hub.files.at("shards/episode-000006/meta/info.json").bytes &&
                      std::filesystem::is_regular_file(source / "ceres/episode-metadata.json"),
                  "Dataset importer is missing metadata");
            write(output, mcap);
            if (await_cancel.load()) {
                importing.store(true);
                while (!stop.stop_requested()) std::this_thread::sleep_for(5ms);
                throw std::runtime_error("Import cancelled");
            }
        });
    check(client.browse("hf:chrisvoncsefalvay/ceres-demos"), "Reference repository browse did not start");
    const auto listed = wait(client);
    check(listed.repository == hub.repository && listed.recordings->size() == 8 && hub.pages == 2,
          "Reference repository shards were not discovered");
    const auto selected = listed.recordings->at(6);
    check(selected.is_dataset() && selected.dataset_root == "shards/episode-000006" &&
              selected.path == "shards/episode-000006/meta/info.json" && selected.files.size() == 5,
          "Dataset selection has the wrong root or dependency closure");
    client.download(selected, root / "cache"); wait(client);
    const auto output = client.take_download();
    check(read(output) == mcap && hub.selected_revision == revision && imports == 1 && hub.downloads == 5,
          "Dataset replay was not imported from verified immutable files");
    const auto requests = hub.downloads.load();
    client.download(selected, root / "cache"); wait(client);
    check(client.take_download() == output && imports == 1 && hub.downloads == requests,
          "Verified dataset replay cache was not reused");
    write(output, mcap + "corrupted replay");
    client.download(selected, root / "cache"); wait(client);
    check(client.take_download() == output && imports == 2 && hub.downloads == requests,
          "Corrupted replay cache was not regenerated from verified sources");
    const auto video = dataset / "videos/observation.images.passthrough/chunk-000/file-000.mp4";
    write(video, "damaged source");
    hub.bad_checksum = true;
    client.download(selected, root / "cache"); fails(client, "checksum");
    check(imports == 2 && !std::filesystem::exists(video.string() + ".partial") && client.take_download().empty(),
          "Corrupt source bytes reached the importer or retained partial state");
    hub.bad_checksum = false;
    client.download(selected, root / "cache"); wait(client); client.take_download();
    check(imports == 2, "Restored source forced an unnecessary replay conversion");

    auto forged = selected;
    forged.files.back().path = "other-shard/video.mp4";
    const auto before = hub.downloads.load();
    client.download(forged, root / "cache"); fails(client, "metadata");
    check(hub.downloads == before, "A dataset file outside the selected root reached the network");
    forged = selected;
    forged.files.front().path = "shards/episode-000006/../outside.json";
    client.download(forged, root / "cache"); fails(client, "component");
    forged = selected; forged.files.front().sha256 = "wrong";
    client.download(forged, root / "cache"); fails(client, "metadata");

    write(output, mcap + "force conversion");
    await_cancel.store(true);
    client.download(selected, root / "cache");
    const auto deadline = std::chrono::steady_clock::now() + 3s;
    while (!importing.load() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(5ms);
    check(importing.load(), "Cancellable dataset import did not start");
    client.cancel();
    check(wait(client).message == "Cancelled" && client.take_download().empty() &&
              !std::filesystem::exists(output.string() + ".partial"),
          "Cancelled import published a replay or retained temporary files");
    await_cancel.store(false);
    client.download(selected, root / "cache"); wait(client);
    check(client.take_download() == output && read(output) == mcap,
          "Dataset replay could not restart after cancellation");
}

void test_root_dataset(const std::filesystem::path& root) {
    Hub hub;
    add_dataset(hub, "", 0);
    hub.files["recordings/original.mcap"] = {mcap, true};
    HuggingFaceClient client(root, hub.transport(), hub.browser());
    client.browse("https://huggingface.co/datasets/tester/captures/");
    const auto listed = wait(client);
    check(listed.recordings->size() == 2 && listed.recordings->front().is_dataset() &&
              listed.recordings->front().dataset_root.empty() &&
              listed.recordings->front().files.size() == 5 && !listed.recordings->back().is_dataset(),
          "Root dataset and original MCAP were not both retained");
}

void test_dataset_cache_identity(const std::filesystem::path& root) {
    Hub hub;
    add_dataset(hub, "shards/episode-000000/", 0);
    add_dataset(hub, "shards/episode-000001/", 1);
    hub.files["shards/episode-000001/meta/info.json"] = hub.files.at("shards/episode-000000/meta/info.json");
    HuggingFaceClient client(root / "credentials", hub.transport(), hub.browser(),
        [&](const auto& source, const auto& output, std::stop_token) {
            write(output, mcap + read(source / "data/chunk-000/file-000.parquet"));
        });
    client.browse(hub.repository);
    const auto listed = wait(client);
    check(listed.recordings->size() == 2 &&
              listed.recordings->at(0).git_oid == listed.recordings->at(1).git_oid,
          "Identical-metadata dataset fixture is invalid");
    client.download(listed.recordings->at(0), root / "cache"); wait(client);
    const auto first = client.take_download();
    const auto original = read(first);
    client.download(listed.recordings->at(1), root / "cache"); wait(client);
    const auto second = client.take_download();
    check(first != second && read(first) == original && read(first) != read(second),
          "Loading a shard with identical metadata overwrote another replay");
    auto forged = listed.recordings->at(0); forged.files.clear();
    client.download(listed.recordings->at(1), root / "cache"); wait(client);
    client.download(forged, root / "cache"); fails(client, "Choose an MCAP");
    check(client.take_download().empty(), "A failed load returned a previous unconsumed replay");
    client.browse("not-a-repository"); fails(client, "owner/name");
    check(client.status().recordings->empty(), "A failed browse retained another repository's recordings");
}

void test_dataset_cache_upgrade(const std::filesystem::path& root) {
    Hub hub;
    add_dataset(hub, "shards/episode-000000/", 0);
    std::atomic<int> imports{0};
    HuggingFaceClient client(root / "credentials", hub.transport(), hub.browser(),
        [&](const auto& source, const auto& output, std::stop_token) {
            ++imports;
            check(read(source / "data/chunk-000/file-000.parquet") == "recorded pose data 0",
                  "Replay cache upgrade lost its verified source files");
            write(output, mcap + "with task metadata");
        });
    client.browse(hub.repository);
    const auto selected = wait(client).recordings->front();
    client.download(selected, root / "cache"); wait(client);
    const auto current = client.take_download();
    auto current_receipt = current; current_receipt.replace_extension(".json");
    const auto receipt = Json::parse(read(current_receipt));
    check(receipt.at("replay_contract") == Json{{"schema", "ceres-lerobot-replay-cache"}, {"version", 2},
                                                {"task_schema", "ceres-replay-task"}, {"task_version", 1}},
          "Replay cache receipt does not identify its task metadata contract");

    const auto legacy = current.parent_path() / "replay.mcap";
    const auto legacy_receipt = current.parent_path() / "replay.json";
    const auto legacy_bytes = mcap + "without task metadata";
    write(legacy, legacy_bytes);
    write(legacy_receipt, Json{{"source", receipt.at("source")}, {"sha256", hash(legacy_bytes)}}.dump());
    std::filesystem::remove(current);
    std::filesystem::remove(current_receipt);
    const auto downloads = hub.downloads.load();
    client.download(selected, root / "cache"); wait(client);
    check(client.take_download() == current && current != legacy && imports == 2 &&
              hub.downloads == downloads && read(current) == mcap + "with task metadata" &&
              read(legacy) == legacy_bytes,
          "Legacy replay was reused or its verified sources were downloaded again");

    auto stale = Json::parse(read(current_receipt));
    stale["replay_contract"]["task_version"] = 0;
    write(current_receipt, stale.dump());
    client.download(selected, root / "cache"); wait(client);
    check(client.take_download() == current && imports == 3 && hub.downloads == downloads,
          "A mismatched task metadata contract did not regenerate the replay");
    client.download(selected, root / "cache"); wait(client);
    check(client.take_download() == current && imports == 3 && hub.downloads == downloads,
          "Current replay contract did not reuse its verified cache");
}

void test_upload(const std::filesystem::path& root, bool multipart) {
    Hub hub; hub.exists = false; hub.multipart = multipart; hub.foreign_verify = multipart;
    hub.expires_in = multipart ? 3600 : 61; hub.delayed_upload = !multipart;
    const auto source = root / "capture.mcap";
    const auto episode_json = "{\"version\":1,\"episodes\":[{\"attributes\":{\"outcome\":\"pass\"}}]}";
    write(source, mcap); write(source.string() + ".episodes.json", episode_json);
    write(root / "dataset/meta/info.json", "{\"codebase_version\":\"v3.0\"}");
    write(root / "dataset/data/chunk-000/file-000.parquet", "fixture parquet bytes");
    HuggingFaceClient client(root / "credentials", hub.transport(), hub.browser());
    authenticate(client);
    client.upload("tester/captures", source, root / "dataset", "session-one"); wait(client);
    check(hub.created_private && hub.commits == 1 && hub.puts == (multipart ? 2 : 1), "Upload/create did not complete");
    check(hub.files.at("session-one/recordings/capture.mcap").bytes == mcap, "Uploaded recording bytes changed");
    check(hub.files.at("session-one/recordings/capture.mcap.episodes.json").bytes == episode_json,
          "Uploaded episode annotations changed");
    check(hub.files.contains("session-one/meta/info.json") && hub.files.contains("session-one/data/chunk-000/file-000.parquet"),
          "LeRobot export is incomplete");
    if (!multipart) check(hub.refreshes >= 1 && hub.last_commit_auth == "Bearer " + refreshed,
                          "Long upload did not refresh its access token before committing");
    client.upload("tester/captures", source, root / "dataset", "session-one"); wait(client);
    check(hub.commits == 1, "Retry duplicated an already committed upload");
    write(source, mcap + "changed");
    client.upload("tester/captures", source, {}, "session-one"); fails(client, "replace");
    check(hub.commits == 1, "Conflicting upload replaced an existing recording");
    hub.files.clear(); write(source, mcap); hub.mutate_upload = true; hub.mutate_path = source;
    client.upload("tester/captures", source, {}, "session-two"); fails(client, "changed during upload");
    check(hub.commits == 1, "Mutated local recording was committed");
    hub.mutate_upload = false; hub.multipart = false; hub.malformed_header = true; write(source, mcap);
    client.upload("tester/captures", source, {}, "session-three"); fails(client, "invalid upload headers");
}
} // namespace

int main() {
    const auto root = std::filesystem::temp_directory_path() /
        ("ceres-hugging-face-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    try {
        check(hf::repository_id("tester", "captures") == "tester/captures", "Repository validation failed");
        check(hf::repository_id("  hf:chrisvoncsefalvay/ceres-demos\n") == "chrisvoncsefalvay/ceres-demos",
              "Hugging Face replay shorthand was rejected");
        rejects([] { hf::repository_id("hf:owner/repo/extra"); });
        rejects([] { hf::repository_id("https://external.invalid/datasets/owner/repo"); });
        rejects([] { hf::repository_id("../tester", "captures"); });
        rejects([] { hf::repository_path("folder/../escape"); });
        rejects([] { hf::repository_path("folder/CON.mcap"); });
        rejects([] { hf::repository_path("folder/.GIT/config"); });
        check(hf::url_encode("a b/c", true) == "a%20b/c", "Repository URL encoding changed");
        test_auth(root / "auth");
        test_browse_download(root / "browse");
        test_dataset_replay(root / "datasets");
        test_root_dataset(root / "root-dataset");
        test_dataset_cache_identity(root / "dataset-cache");
        test_dataset_cache_upgrade(root / "cache-upgrade");
        test_upload(root / "basic", false);
        test_upload(root / "multipart", true);
        std::filesystem::remove_all(root);
        std::cout << "Hugging Face authentication, browsing, verified replay and upload tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::error_code ignored; std::filesystem::remove_all(root, ignored);
        std::cerr << error.what() << '\n'; return 1;
    }
}
