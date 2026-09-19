#pragma once
#include "ceres/types.hpp"
#include <filesystem>
#include <memory>

namespace ceres {
struct BridgeOptions {
    std::string app_origin = "https://ceres.cam";
    std::string relay = "https://ceres.ceres-relay.workers.dev";
    std::string name = "Ceres viewer";
    std::filesystem::path identity_path;
};

class BridgeClient final : public SessionSource {
  public:
    explicit BridgeClient(BridgeOptions options = {});
    ~BridgeClient() override;
    BridgeClient(const BridgeClient&) = delete;
    BridgeClient& operator=(const BridgeClient&) = delete;
    void start() override;
    void stop() override;
    ReceiverSnapshot snapshot() const override;
    void set_event_sink(EventSink sink) override;
    // Revokes the current binding before publishing a new invitation.
    void fresh_pairing();
    void request_keyframe();
    std::string state() const;

  private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};
} // namespace ceres
