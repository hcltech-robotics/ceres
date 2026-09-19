#pragma once
#include "ceres/types.hpp"
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace ceres {
struct ReplayTask {
    std::int64_t start_us = 0, end_us = 0;
    std::string title, description, run_title, run_description, task_id;
    std::optional<std::uint64_t> task_number, task_count, repetition, repeat_count, take, cycle,
        cycle_count;
    Json attributes = Json::object();
};

struct ReplayTaskSpan {
    std::int64_t start_us = 0, end_us = 0;
    std::size_t task_index = 0;
};

class ReplayTaskTimeline {
  public:
    static ReplayTaskTimeline from_events(const std::vector<SessionEvent>& events,
                                         const Json& task_specification = Json());
    // Intervals include their start and exclude their end. Overlaps select the
    // latest start, with the last source event taking precedence for equal starts.
    const ReplayTask* at(std::int64_t position_us) const;
    const std::vector<ReplayTask>& tasks() const;
    // Non-overlapping intervals with the same task priority as at(). Gaps are absent.
    const std::vector<ReplayTaskSpan>& visible_spans() const;
    // Returns null when the position is outside every recorded task interval.
    Json to_json(std::int64_t position_us) const;

  private:
    std::vector<ReplayTask> tasks_;
    std::vector<ReplayTaskSpan> visible_spans_;
};
} // namespace ceres
