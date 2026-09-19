#include "ceres/replay_task.hpp"
#include <algorithm>
#include <limits>

namespace ceres {
namespace {
const Json* field(const Json& object, const char* key) {
    if (!object.is_object())
        return nullptr;
    const auto found = object.find(key);
    return found == object.end() ? nullptr : &*found;
}

std::optional<std::string> text(const Json& object, const char* key) {
    const auto* value = field(object, key);
    if (!value || !value->is_string())
        return std::nullopt;
    return value->get<std::string>();
}

std::optional<std::uint64_t> integer(const Json& object, const char* key,
                                     std::uint64_t minimum = 0) {
    const auto* value = field(object, key);
    if (!value || !value->is_number_integer())
        return std::nullopt;
    if (value->is_number_unsigned()) {
        const auto number = value->get<std::uint64_t>();
        return number >= minimum ? std::optional(number) : std::nullopt;
    }
    const auto number = value->get<std::int64_t>();
    if (number < 0 || static_cast<std::uint64_t>(number) < minimum)
        return std::nullopt;
    return static_cast<std::uint64_t>(number);
}

std::optional<std::int64_t> timestamp(const Json& object, const char* key) {
    const auto value = integer(object, key);
    if (!value || *value > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()))
        return std::nullopt;
    return static_cast<std::int64_t>(*value);
}

const Json* specification(const Json& value) {
    if (!value.is_object())
        return nullptr;
    const auto* tasks = field(value, "tasks");
    if (!tasks || !tasks->is_array() || tasks->empty())
        return nullptr;
    if (const auto* schema = field(value, "schema"); schema &&
        (!schema->is_string() || *schema != "ceres-task-specification"))
        return nullptr;
    if (field(value, "version") && integer(value, "version") != 1)
        return nullptr;
    return &value;
}

const Json* task_specification(const Json& attributes, const Json& fallback) {
    if (const auto* embedded = field(attributes, "task_specification"))
        if (const auto* valid = specification(*embedded))
            return valid;
    return specification(fallback);
}

template <class Predicate>
std::optional<std::size_t> unique_task(const Json& tasks, Predicate matches) {
    std::optional<std::size_t> result;
    for (std::size_t i = 0; i < tasks.size(); ++i) {
        if (!tasks[i].is_object() || !matches(tasks[i]))
            continue;
        if (result)
            return std::nullopt;
        result = i;
    }
    return result;
}

std::optional<std::size_t> matching_task(const Json& attributes, const Json& tasks,
                                        bool imported) {
    if (const auto id = text(attributes, "task_id"); id && !id->empty()) {
        const auto matched = unique_task(tasks, [&](const Json& task) {
            return text(task, "id") == id;
        });
        if (matched)
            return matched;
    }
    if (const auto index = integer(attributes, "task_index")) {
        if (imported) {
            return unique_task(tasks, [&](const Json& task) {
                return integer(task, "datasetTaskIndex") == index;
            });
        }
        if (*index < tasks.size() && tasks[static_cast<std::size_t>(*index)].is_object())
            return static_cast<std::size_t>(*index);
    }
    return std::nullopt;
}

std::string first_text(const std::optional<std::string>& first,
                       const std::optional<std::string>& second = std::nullopt,
                       const std::optional<std::string>& third = std::nullopt) {
    if (first)
        return *first;
    if (second)
        return *second;
    return third.value_or(std::string{});
}

void describe(ReplayTask& result, const Json& fallback, bool imported) {
    const auto& attributes = result.attributes;
    const auto* spec = task_specification(attributes, fallback);
    const Json* task = nullptr;
    if (spec) {
        const auto& tasks = spec->at("tasks");
        if (const auto matched = matching_task(attributes, tasks, imported)) {
            task = &tasks[*matched];
            result.task_number = static_cast<std::uint64_t>(*matched) + 1;
            result.task_count = static_cast<std::uint64_t>(tasks.size());
        }
    }
    const auto label = task ? text(*task, "label") : std::nullopt;
    const auto instructions = task ? text(*task, "instructions") : std::nullopt;
    const auto name = text(attributes, "name");
    result.title = imported ? first_text(text(attributes, "title"), name, label)
                            : first_text(text(attributes, "title"), label, name);
    result.description = imported ? first_text(text(attributes, "description"), instructions)
                                  : first_text(text(attributes, "description"), name, instructions);
    result.task_id = first_text(text(attributes, "task_id"),
                                task ? text(*task, "id") : std::nullopt);
    result.run_title = first_text(text(attributes, "run_title"),
                                  spec ? text(*spec, "runTitle") : std::nullopt);
    result.run_description = first_text(text(attributes, "run_description"),
                                        spec ? text(*spec, "runDescription") : std::nullopt);
    result.repetition = integer(attributes, "repetition", 1);
    result.take = integer(attributes, "take", 1);
    result.cycle = integer(attributes, "cycle", 1);
    result.repeat_count = integer(attributes, "repeat_count", 1);
    if (!result.repeat_count && task)
        result.repeat_count = integer(*task, "repeatCount", 1);
    result.cycle_count = integer(attributes, "cycle_count", 1);
    if (!result.cycle_count && spec)
        result.cycle_count = integer(*spec, "cycleCount", 1);
}
} // namespace

ReplayTaskTimeline ReplayTaskTimeline::from_events(const std::vector<SessionEvent>& events,
                                                  const Json& task_specification) {
    ReplayTaskTimeline result;
    for (const auto& event : events) {
        const auto& attributes = event.attributes;
        if (event.kind != EventKind::Episode || text(attributes, "action") != "stop")
            continue;
        const auto* schema = field(attributes, "schema");
        const bool imported = schema != nullptr;
        if (imported && (!schema->is_string() || *schema != "ceres-replay-task" ||
                         integer(attributes, "version") != 1))
            continue;
        const auto start = timestamp(attributes, "start_us");
        const auto end = timestamp(attributes, "end_us");
        if (!start || !end || *end <= *start)
            continue;
        ReplayTask task;
        task.start_us = *start;
        task.end_us = *end;
        task.attributes = attributes;
        describe(task, task_specification, imported);
        result.tasks_.push_back(std::move(task));
    }
    std::stable_sort(result.tasks_.begin(), result.tasks_.end(),
                     [](const ReplayTask& first, const ReplayTask& second) {
                         return first.start_us < second.start_us;
                     });
    return result;
}

const ReplayTask* ReplayTaskTimeline::at(std::int64_t position_us) const {
    auto after = std::upper_bound(tasks_.begin(), tasks_.end(), position_us,
                                  [](std::int64_t position, const ReplayTask& task) {
                                      return position < task.start_us;
                                  });
    while (after != tasks_.begin()) {
        const auto& task = *--after;
        if (position_us < task.end_us)
            return &task;
    }
    return nullptr;
}

const std::vector<ReplayTask>& ReplayTaskTimeline::tasks() const {
    return tasks_;
}

Json ReplayTaskTimeline::to_json(std::int64_t position_us) const {
    const auto* task = at(position_us);
    if (!task)
        return Json();
    Json result = {{"start_us", task->start_us}, {"end_us", task->end_us},
                   {"title", task->title}, {"description", task->description},
                   {"run_title", task->run_title}, {"run_description", task->run_description},
                   {"task_id", task->task_id}, {"attributes", task->attributes}};
    const auto counter = [&](const char* key, const std::optional<std::uint64_t>& value) {
        result[key] = value ? Json(*value) : Json();
    };
    counter("task_number", task->task_number);
    counter("task_count", task->task_count);
    counter("repetition", task->repetition);
    counter("repeat_count", task->repeat_count);
    counter("take", task->take);
    counter("cycle", task->cycle);
    counter("cycle_count", task->cycle_count);
    return result;
}
} // namespace ceres
