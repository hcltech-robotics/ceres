#include "ceres/hugging_face.hpp"
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

namespace {
std::filesystem::path credentials() {
#ifdef _WIN32
    const char* base = std::getenv("LOCALAPPDATA");
    if (!base) throw std::runtime_error("LOCALAPPDATA is unavailable");
    return std::filesystem::path(base) / "Ceres viewer" / "private";
#else
    const char* base = std::getenv("XDG_CONFIG_HOME");
    const char* home = std::getenv("HOME");
    if (!base && !home) throw std::runtime_error("HOME is unavailable");
    return (base ? std::filesystem::path(base) : std::filesystem::path(home) / ".config") /
           "ceres-viewer" / "private";
#endif
}
ceres::HuggingFaceStatus wait(ceres::HuggingFaceClient& client) {
    std::string previous;
    while (true) {
        auto status = client.status();
        const auto line = status.user_code.empty() ? status.message :
            "Sign-in code: " + status.user_code + " at " + status.verification_url;
        if (!line.empty() && line != previous) {
            std::cout << line << '\n' << std::flush;
            previous = line;
        }
        if (!status.running) {
            if (!status.error.empty()) throw std::runtime_error(status.error);
            return status;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}
}
int main(int argc, char** argv) {
    try {
        if (argc < 2) throw std::runtime_error("Usage: ceres-hf-tool signin | list REPO | upload REPO MCAP [LEROBOT] [PREFIX] | download REPO PATH CACHE");
        ceres::HuggingFaceClient client(credentials());
        const std::string command = argv[1];
        if (command == "signin" && argc == 2) {
            client.sign_in(); const auto status = wait(client);
            std::cout << "Account: " << status.username << '\n';
        } else if (command == "list" && argc == 3) {
            client.browse(argv[2]); const auto status = wait(client);
            for (const auto& recording : *status.recordings)
                std::cout << recording.path << '\t' << recording.bytes << '\t' << recording.revision << '\n';
        } else if (command == "upload" && argc >= 4 && argc <= 6) {
            client.upload(argv[2], std::filesystem::u8path(argv[3]),
                          argc > 4 ? std::filesystem::u8path(argv[4]) : std::filesystem::path{},
                          argc > 5 ? argv[5] : "", true);
            const auto status = wait(client); std::cout << status.commit_url << '\n';
        } else if (command == "download" && argc == 5) {
            client.browse(argv[2]); const auto status = wait(client);
            bool found = false;
            for (const auto& recording : *status.recordings) if (recording.path == argv[3]) {
                client.download(recording, std::filesystem::u8path(argv[4])); wait(client);
                std::cout << "Downloaded: " << client.take_download().string() << '\n'; found = true; break;
            }
            if (!found) throw std::runtime_error("Recording was not found");
        } else throw std::runtime_error("Invalid Hugging Face test helper arguments");
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
