#pragma once
#include "ceres/types.hpp"
#include <cstdint>
#include <filesystem>
#include <optional>
#include <stop_token>
#include <string>
#include <string_view>
#include <vector>

namespace ceres {
inline constexpr const char* task_specification_schema = "ceres-task-specification";
inline constexpr int task_specification_version = 1;
inline constexpr size_t task_import_max_bytes = 1000000;
inline constexpr int64_t minimum_task_reset_us = 5000000;
inline constexpr int64_t cycle_pause_us = 15000000;

enum class TaskType { timed, open, pause };

struct TaskDefinition {
    std::string id, label, instructions;
    TaskType type = TaskType::open;
    double duration_s = 0, reset_time_s = 5;
    uint64_t repeat_count = 1;
};

struct TaskSpecification {
    std::string run_title, run_description;
    uint64_t cycle_count = 1;
    std::vector<TaskDefinition> tasks;

    Json to_json() const;
};

TaskSpecification parse_task_specification(const Json& value);
TaskSpecification load_task_specification(const std::filesystem::path& path);
bool is_task_specification_url(std::string_view source);
// Performs file or HTTP/HTTPS I/O synchronously. Call from a worker to keep the UI responsive.
TaskSpecification load_task_specification_source(const std::string& source,
                                               std::stop_token cancel = {});
void to_json(Json& value, const TaskSpecification& specification);

enum class TaskRunPhase { stopped, active_task, post_task_pause, task_pause, cycle_pause, complete };

struct TaskRunProgress {
    TaskRunPhase phase = TaskRunPhase::stopped;
    bool paused = false;
    size_t task_index = 0, task_count = 0;
    uint64_t repetition = 1, repeat_count = 1, cycle = 1, cycle_count = 1;
    int64_t elapsed_us = 0, phase_elapsed_us = 0;
    std::optional<int64_t> phase_remaining_us;
};

struct TaskTransition {
    int64_t time_us = 0;
    TaskRunProgress before, after;
};

class TaskRun {
  public:
    std::vector<TaskTransition> start(const TaskSpecification& specification, int64_t now_us);
    std::vector<TaskTransition> update(int64_t now_us);
    std::vector<TaskTransition> advance(int64_t now_us);
    std::vector<TaskTransition> pause(int64_t now_us);
    std::vector<TaskTransition> resume(int64_t now_us);
    std::vector<TaskTransition> stop(int64_t now_us);
    TaskRunProgress progress(int64_t now_us) const;
    const TaskDefinition* current_task() const;

  private:
    TaskSpecification specification_;
    TaskRunPhase phase_ = TaskRunPhase::stopped;
    bool paused_ = false;
    size_t task_index_ = 0;
    uint64_t repetition_ = 1, cycle_ = 1;
    int64_t elapsed_us_ = 0, phase_started_us_ = 0, last_time_us_ = 0;

    bool running() const;
    std::optional<int64_t> phase_duration() const;
    TaskRunProgress snapshot(int64_t elapsed_us) const;
    void next_phase();
};
} // namespace ceres
