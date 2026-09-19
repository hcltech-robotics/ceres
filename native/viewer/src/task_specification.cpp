#include "ceres/task_specification.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <set>
#include <stdexcept>
#include <string_view>

namespace ceres {
namespace {
constexpr double maximum_safe_integer = 9007199254740991.0;

std::string trim(std::string value) {
    // Match the ECMAScript trim used by the canonical task specification.
    static constexpr std::string_view whitespace[]{
        " ", "\t", "\n", "\r", "\f", "\v", "\xc2\xa0", "\xe1\x9a\x80",
        "\xe2\x80\x80", "\xe2\x80\x81", "\xe2\x80\x82", "\xe2\x80\x83",
        "\xe2\x80\x84", "\xe2\x80\x85", "\xe2\x80\x86", "\xe2\x80\x87",
        "\xe2\x80\x88", "\xe2\x80\x89", "\xe2\x80\x8a", "\xe2\x80\xa8",
        "\xe2\x80\xa9", "\xe2\x80\xaf", "\xe2\x81\x9f", "\xe3\x80\x80",
        "\xef\xbb\xbf"};
    size_t first = value.size(), last = 0;
    for (size_t position = 0; position < value.size();) {
        size_t width = 0;
        for (const auto space : whitespace)
            if (std::string_view(value).substr(position).starts_with(space)) {
                width = space.size();
                break;
            }
        if (width)
            position += width;
        else {
            first = std::min(first, position);
            last = ++position;
        }
    }
    return first < last ? value.substr(first, last - first) : std::string{};
}

const Json& object(const Json& value, const std::string& label) {
    if (!value.is_object())
        throw std::runtime_error(label + " must be an object");
    return value;
}

const Json& field(const Json& value, const char* name) {
    static const Json missing;
    const auto found = value.find(name);
    return found == value.end() ? missing : *found;
}

void exact_keys(const Json& value, std::initializer_list<std::string_view> keys,
                const std::string& label) {
    for (const auto& [key, unused] : value.items()) {
        (void)unused;
        if (std::find(keys.begin(), keys.end(), key) == keys.end())
            throw std::runtime_error(label + " contains unknown field " + key);
    }
}

std::string required_text(const Json& value, const std::string& label) {
    if (!value.is_string())
        throw std::runtime_error(label + " must be a non-empty string");
    auto result = trim(value.get<std::string>());
    if (result.empty())
        throw std::runtime_error(label + " must be a non-empty string");
    return result;
}

double non_negative(const Json& value, const std::string& label) {
    if (!value.is_number())
        throw std::runtime_error(label + " must be a non-negative finite number");
    const auto result = value.get<double>();
    if (!std::isfinite(result) || result < 0 || result > maximum_safe_integer)
        throw std::runtime_error(label + " must be a non-negative finite number no greater than "
                                          "Number.MAX_SAFE_INTEGER");
    return result == 0 ? 0 : result;
}

uint64_t positive_integer(const Json& value, const std::string& label) {
    if (!value.is_number())
        throw std::runtime_error(label + " must be a positive safe integer");
    const auto result = value.get<double>();
    if (!std::isfinite(result) || result < 1 || result > maximum_safe_integer ||
        std::floor(result) != result)
        throw std::runtime_error(label + " must be a positive safe integer");
    return static_cast<uint64_t>(result);
}

const char* type_name(TaskType type) {
    switch (type) {
    case TaskType::timed:
        return "timed";
    case TaskType::open:
        return "open";
    case TaskType::pause:
        return "pause";
    }
    throw std::runtime_error("Task type is invalid");
}

TaskSpecification parse_canonical(const Json& value) {
    object(value, "Task specification");
    exact_keys(value, {"schema", "version", "runTitle", "runDescription", "cycleCount", "tasks"},
               "Task specification");
    if (field(value, "schema") != task_specification_schema)
        throw std::runtime_error("Task specification schema must be ceres-task-specification");
    if (field(value, "version") != task_specification_version ||
        !field(value, "version").is_number())
        throw std::runtime_error("Task specification version must be 1");
    TaskSpecification result;
    result.run_title = required_text(field(value, "runTitle"), "Task specification runTitle");
    if (value.contains("runDescription")) {
        if (!value["runDescription"].is_string())
            throw std::runtime_error("Task specification runDescription must be a string when present");
        result.run_description = trim(value["runDescription"].get<std::string>());
    }
    result.cycle_count = positive_integer(field(value, "cycleCount"), "Task specification cycleCount");
    const auto& tasks = field(value, "tasks");
    if (!tasks.is_array() || tasks.empty())
        throw std::runtime_error("Task specification tasks must contain at least one task");
    std::set<std::string> ids;
    result.tasks.reserve(tasks.size());
    for (size_t index = 0; index < tasks.size(); ++index) {
        const auto label = "Task specification task " + std::to_string(index);
        const auto& raw = object(tasks[index], label);
        const auto& type = field(raw, "type");
        TaskDefinition task;
        if (type == "timed") {
            task.type = TaskType::timed;
            exact_keys(raw, {"id", "type", "label", "instructions", "durationS", "repeatCount",
                             "resetTimeS"}, label);
        } else if (type == "open") {
            task.type = TaskType::open;
            exact_keys(raw, {"id", "type", "label", "instructions", "repeatCount", "resetTimeS"},
                       label);
        } else if (type == "pause") {
            task.type = TaskType::pause;
            exact_keys(raw, {"id", "type", "label", "instructions", "durationS"}, label);
        } else {
            throw std::runtime_error(label + " type is invalid");
        }
        task.id = required_text(field(raw, "id"), label + " id");
        if (!ids.insert(task.id).second)
            throw std::runtime_error("Task specification task id " + task.id + " is duplicated");
        task.label = required_text(field(raw, "label"), label + " label");
        task.instructions = required_text(field(raw, "instructions"), label + " instructions");
        if (task.type != TaskType::open)
            task.duration_s = non_negative(field(raw, "durationS"), label + " durationS");
        if (task.type != TaskType::pause) {
            task.repeat_count = positive_integer(field(raw, "repeatCount"), label + " repeatCount");
            task.reset_time_s = non_negative(field(raw, "resetTimeS"), label + " resetTimeS");
        }
        result.tasks.push_back(std::move(task));
    }
    return result;
}

std::string legacy_text(const Json& value, const std::string& fallback) {
    if (value.is_string()) {
        auto result = trim(value.get<std::string>());
        if (!result.empty())
            return result;
    }
    return fallback;
}

double legacy_non_negative(const Json& value, double fallback) {
    if (!value.is_number())
        return fallback;
    const auto result = value.get<double>();
    return std::isfinite(result) && result >= 0 ? result : fallback;
}

double legacy_positive_integer(const Json& value, double fallback) {
    const auto number = legacy_non_negative(value, fallback);
    return number > 0 ? std::max(1.0, std::floor(number)) : fallback;
}

TaskSpecification parse_legacy(const Json& value) {
    const auto& supplied = field(value, "configuration");
    if (supplied.is_null() || supplied == false || supplied == 0 || supplied == "")
        throw std::runtime_error("The CERES run file has no configuration");
    const auto configuration = supplied.is_object() ? supplied : Json::object();
    TaskSpecification result;
    result.run_title = legacy_text(field(configuration, "runTitle"), "Open capture");
    const auto& description = field(configuration, "runDescription");
    result.run_description = description.is_string()
                                 ? trim(description.get<std::string>())
                                 : legacy_text(field(configuration, "taskDescription"), "");
    const auto cycles = legacy_positive_integer(field(configuration, "totalCycles"), 1);
    result.cycle_count = positive_integer(Json(cycles), "Task specification cycleCount");
    const auto& source_tasks = field(configuration, "tasks");
    if (!source_tasks.is_array()) {
        result.tasks.push_back({"task-001", "Open task", "--", TaskType::open, 0, 5, 1});
    } else {
        std::set<std::string> ids;
        size_t generated_id = 1;
        for (size_t index = 0; index < source_tasks.size(); ++index) {
            const auto raw = source_tasks[index].is_object() ? source_tasks[index] : Json::object();
            TaskDefinition task;
            task.id = legacy_text(field(raw, "id"), "");
            if (task.id.empty() || ids.contains(task.id)) {
                do {
                    task.id = "task-import-" + std::to_string(generated_id++);
                } while (ids.contains(task.id));
            }
            ids.insert(task.id);
            const auto number = std::to_string(index + 1);
            task.label = legacy_text(field(raw, "label"),
                                     std::string("Task ") + (index < 9 ? "0" : "") + number);
            task.instructions = legacy_text(field(raw, "instructions"), "--");
            const auto& type = field(raw, "type");
            task.type = type == "open" ? TaskType::open : type == "pause" ? TaskType::pause
                                                                             : TaskType::timed;
            if (task.type != TaskType::open)
                task.duration_s = legacy_non_negative(field(raw, "durationS"),
                                                      task.type == TaskType::pause ? 15 : 60);
            if (task.type != TaskType::pause) {
                const auto repeats = legacy_positive_integer(field(raw, "repeatCount"), 1) *
                                     legacy_positive_integer(field(raw, "setCount"), 1);
                task.repeat_count = positive_integer(Json(repeats), "Task specification repeatCount");
                task.reset_time_s = std::max(5.0, legacy_non_negative(field(raw, "resetTimeS"), 5));
            }
            result.tasks.push_back(std::move(task));
        }
    }
    return parse_canonical(result.to_json());
}

int64_t add_time(int64_t first, int64_t second) {
    return second > std::numeric_limits<int64_t>::max() - first
               ? std::numeric_limits<int64_t>::max()
               : first + second;
}

int64_t seconds_us(double seconds) {
    const auto value = static_cast<long double>(seconds) * 1000000;
    if (value >= std::numeric_limits<int64_t>::max())
        return std::numeric_limits<int64_t>::max();
    return static_cast<int64_t>(std::round(value));
}
} // namespace

Json TaskSpecification::to_json() const {
    Json result = {{"schema", task_specification_schema},
                   {"version", task_specification_version},
                   {"runTitle", run_title},
                   {"cycleCount", cycle_count},
                   {"tasks", Json::array()}};
    if (!run_description.empty())
        result["runDescription"] = run_description;
    for (const auto& task : tasks) {
        Json entry = {{"id", task.id}, {"type", type_name(task.type)}, {"label", task.label},
                      {"instructions", task.instructions}};
        if (task.type != TaskType::open)
            entry["durationS"] = task.duration_s;
        if (task.type != TaskType::pause) {
            entry["repeatCount"] = task.repeat_count;
            entry["resetTimeS"] = task.reset_time_s;
        }
        result["tasks"].push_back(std::move(entry));
    }
    return result;
}

void to_json(Json& value, const TaskSpecification& specification) {
    value = specification.to_json();
}

TaskSpecification parse_task_specification(const Json& value) {
    object(value, "Imported task document");
    const auto& schema = field(value, "schema");
    if (schema == task_specification_schema)
        return parse_canonical(value);
    if (schema == "ceres-run-v1" || schema == "ceres-run-v2" || schema == "ceres-run-v5")
        return parse_legacy(value);
    throw std::runtime_error("The file is not a supported CERES task specification or run file");
}

TaskSpecification load_task_specification(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input)
        throw std::runtime_error("Cannot open the task specification");
    const auto length = input.tellg();
    if (length < 0 || length > static_cast<std::streamoff>(task_import_max_bytes))
        throw std::runtime_error("The task file is larger than 1 MB");
    std::string text(static_cast<size_t>(length), '\0');
    input.seekg(0);
    if (!text.empty() && !input.read(text.data(), static_cast<std::streamsize>(text.size())))
        throw std::runtime_error("Cannot read the task specification");
    Json value;
    try {
        value = Json::parse(text);
    } catch (const Json::parse_error&) {
        throw std::runtime_error("The task file is not valid JSON");
    }
    return parse_task_specification(value);
}

bool TaskRun::running() const {
    return phase_ != TaskRunPhase::stopped && phase_ != TaskRunPhase::complete;
}

const TaskDefinition* TaskRun::current_task() const {
    return task_index_ < specification_.tasks.size() ? &specification_.tasks[task_index_] : nullptr;
}

std::optional<int64_t> TaskRun::phase_duration() const {
    const auto* task = current_task();
    switch (phase_) {
    case TaskRunPhase::active_task:
        if (task && task->type == TaskType::timed)
            return seconds_us(task->duration_s);
        break;
    case TaskRunPhase::post_task_pause:
        return std::max(minimum_task_reset_us, seconds_us(task->reset_time_s));
    case TaskRunPhase::task_pause:
        return seconds_us(task->duration_s);
    case TaskRunPhase::cycle_pause:
        return cycle_pause_us;
    default:
        break;
    }
    return std::nullopt;
}

TaskRunProgress TaskRun::snapshot(int64_t elapsed_us) const {
    TaskRunProgress result;
    result.phase = phase_;
    result.paused = paused_;
    result.task_index = task_index_;
    result.task_count = specification_.tasks.size();
    result.repetition = repetition_;
    const auto* task = current_task();
    result.repeat_count = task ? task->repeat_count : 1;
    result.cycle = cycle_;
    result.cycle_count = specification_.cycle_count;
    result.elapsed_us = elapsed_us;
    result.phase_elapsed_us = std::max<int64_t>(0, elapsed_us - phase_started_us_);
    if (const auto duration = phase_duration())
        result.phase_remaining_us = std::max<int64_t>(0, *duration - result.phase_elapsed_us);
    return result;
}

TaskRunProgress TaskRun::progress(int64_t now_us) const {
    const auto extra = running() && !paused_ ? std::max<int64_t>(0, now_us - last_time_us_) : 0;
    return snapshot(add_time(elapsed_us_, extra));
}

std::vector<TaskTransition> TaskRun::start(const TaskSpecification& specification, int64_t now_us) {
    if (now_us < 0)
        throw std::runtime_error("Task run clock must be non-negative");
    auto normalised = parse_canonical(specification.to_json());
    const auto before = progress(now_us);
    specification_ = std::move(normalised);
    task_index_ = 0;
    repetition_ = cycle_ = 1;
    elapsed_us_ = phase_started_us_ = 0;
    last_time_us_ = now_us;
    paused_ = false;
    phase_ = current_task()->type == TaskType::pause ? TaskRunPhase::task_pause
                                                    : TaskRunPhase::active_task;
    return {{now_us, before, snapshot(elapsed_us_)}};
}

void TaskRun::next_phase() {
    if (phase_ == TaskRunPhase::active_task) {
        phase_ = TaskRunPhase::post_task_pause;
    } else if (phase_ == TaskRunPhase::cycle_pause) {
        if (cycle_ < specification_.cycle_count) {
            ++cycle_;
            task_index_ = 0;
            repetition_ = 1;
            phase_ = current_task()->type == TaskType::pause ? TaskRunPhase::task_pause
                                                            : TaskRunPhase::active_task;
        } else {
            phase_ = TaskRunPhase::complete;
        }
    } else {
        const auto* task = current_task();
        if (task && task->type != TaskType::pause && repetition_ < task->repeat_count)
            ++repetition_;
        else {
            ++task_index_;
            repetition_ = 1;
        }
        if (!current_task())
            phase_ = TaskRunPhase::cycle_pause;
        else
            phase_ = current_task()->type == TaskType::pause ? TaskRunPhase::task_pause
                                                            : TaskRunPhase::active_task;
    }
    phase_started_us_ = elapsed_us_;
}

std::vector<TaskTransition> TaskRun::update(int64_t now_us) {
    if (now_us < 0 || now_us < last_time_us_)
        throw std::runtime_error("Task run clock moved backwards");
    std::vector<TaskTransition> result;
    if (!running())
        return result;
    if (paused_) {
        last_time_us_ = now_us;
        return result;
    }
    const auto previous_elapsed = elapsed_us_;
    const auto target = add_time(elapsed_us_, now_us - last_time_us_);
    while (running()) {
        const auto duration = phase_duration();
        if (!duration)
            break;
        if (*duration > std::numeric_limits<int64_t>::max() - phase_started_us_)
            break;
        const auto deadline = add_time(phase_started_us_, *duration);
        if (deadline > target)
            break;
        elapsed_us_ = deadline;
        const auto before = snapshot(elapsed_us_);
        next_phase();
        result.push_back({add_time(last_time_us_, deadline - previous_elapsed), before,
                          snapshot(elapsed_us_)});
    }
    if (running())
        elapsed_us_ = target;
    last_time_us_ = now_us;
    return result;
}

std::vector<TaskTransition> TaskRun::advance(int64_t now_us) {
    auto result = update(now_us);
    if (running() && !paused_) {
        const auto before = snapshot(elapsed_us_);
        next_phase();
        result.push_back({now_us, before, snapshot(elapsed_us_)});
    }
    return result;
}

std::vector<TaskTransition> TaskRun::pause(int64_t now_us) {
    auto result = update(now_us);
    if (running() && !paused_) {
        const auto before = snapshot(elapsed_us_);
        paused_ = true;
        result.push_back({now_us, before, snapshot(elapsed_us_)});
    }
    return result;
}

std::vector<TaskTransition> TaskRun::resume(int64_t now_us) {
    auto result = update(now_us);
    if (running() && paused_) {
        const auto before = snapshot(elapsed_us_);
        paused_ = false;
        result.push_back({now_us, before, snapshot(elapsed_us_)});
    }
    return result;
}

std::vector<TaskTransition> TaskRun::stop(int64_t now_us) {
    auto result = update(now_us);
    if (running()) {
        const auto before = snapshot(elapsed_us_);
        phase_ = TaskRunPhase::stopped;
        paused_ = false;
        phase_started_us_ = elapsed_us_;
        result.push_back({now_us, before, snapshot(elapsed_us_)});
    }
    return result;
}

std::optional<TaskRun::RestartPoint> TaskRun::restart_point() const {
    if (!running())
        return std::nullopt;
    if (phase_ == TaskRunPhase::active_task || phase_ == TaskRunPhase::post_task_pause)
        return RestartPoint{task_index_, repetition_};
    // Tasks before a prescribed pause have finished all their repetitions.
    // The cycle cursor advances only after its pause, so this never crosses cycles.
    for (size_t index = std::min(task_index_, specification_.tasks.size()); index > 0;) {
        const auto& task = specification_.tasks[--index];
        if (task.type != TaskType::pause)
            return RestartPoint{index, task.repeat_count};
    }
    return std::nullopt;
}

bool TaskRun::can_restart() const {
    return restart_point().has_value();
}

std::vector<TaskTransition> TaskRun::restart(int64_t now_us, TaskTransitionReason reason) {
    auto result = update(now_us);
    if (const auto target = restart_point()) {
        const auto before = snapshot(elapsed_us_);
        task_index_ = target->task_index;
        repetition_ = reason == TaskTransitionReason::restart_task ? 1 : target->repetition;
        phase_ = TaskRunPhase::active_task;
        paused_ = false;
        phase_started_us_ = elapsed_us_;
        // Even an active-to-active restart is an episode boundary at the current
        // capture time. Prior recording and elapsed run time remain intact.
        result.push_back({now_us, before, snapshot(elapsed_us_), reason});
    }
    return result;
}

std::vector<TaskTransition> TaskRun::restart_repetition(int64_t now_us) {
    return restart(now_us, TaskTransitionReason::restart_repetition);
}

std::vector<TaskTransition> TaskRun::restart_task(int64_t now_us) {
    return restart(now_us, TaskTransitionReason::restart_task);
}
} // namespace ceres
