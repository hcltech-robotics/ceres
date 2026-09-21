#include "ceres/bridge.hpp"
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>

int main(int argc, char** argv) {
    try {
        if (argc != 5)
            throw std::runtime_error("Expected origin, CA file, identity and registration marker");
        ceres::BridgeOptions options;
        options.app_origin = options.relay = argv[1];
        if (std::string_view(argv[2]) != "-")
            options.ca_certificate = argv[2];
        options.identity_path = argv[3];
        ceres::BridgeClient client(options);
        client.start();
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
        while (std::chrono::steady_clock::now() < deadline) {
            if (std::filesystem::exists(argv[4])) {
                client.stop();
                return 0;
            }
            const auto snapshot = client.snapshot();
            if (!snapshot.error.empty())
                throw std::runtime_error(snapshot.error);
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        throw std::runtime_error("Timed out before secure WebSocket registration");
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
