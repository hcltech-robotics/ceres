#include "ceres/replay_task.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
using namespace ceres;

void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

SessionEvent episode(std::int64_t start, std::int64_t end, const std::string& title,
                     std::uint64_t repetition = 2) {
    SessionEvent event;
    event.kind = EventKind::Episode;
    event.attributes = {{"schema", "ceres-replay-task"}, {"version", 1}, {"action", "stop"},
                        {"start_us", start}, {"end_us", end}, {"title", title},
                        {"name", title}, {"repetition", repetition}};
    return event;
}

Json specification() {
    return {{"schema", "ceres-task-specification"}, {"version", 1},
            {"runTitle", "  Assembly run  "}, {"runDescription", "Keep the original wording.\n"},
            {"cycleCount", 3},
            {"tasks", Json::array({
                {{"id", "inspect"}, {"label", "  Inspect the assembly  "},
                 {"instructions", "Inspect each face.\nKeep both hands visible.  "},
                 {"datasetTaskIndex", 9}, {"repeatCount", 5}}})}};
}

void boundaries_gaps_and_seeking() {
    auto first = episode(10, 20, "First", 2);
    auto second = episode(20, 30, "Second", 4);
    auto third = episode(40, 50, "Third", 8);
    auto start = first;
    start.attributes["action"] = "start";
    const auto timeline = ReplayTaskTimeline::from_events({third, second, start, first});
    check(timeline.tasks().size() == 3 && timeline.tasks()[0].title == "First" &&
              timeline.tasks()[1].title == "Second" && timeline.tasks()[2].title == "Third",
          "Intervals were not sorted or a start marker became a second task");
    check(!timeline.at(-1) && !timeline.at(0) && !timeline.at(9),
          "A task was shown before its interval");
    check(timeline.at(10)->title == "First" && timeline.at(19)->title == "First" &&
              timeline.at(20)->title == "Second" && timeline.at(29)->title == "Second",
          "Task intervals are not half-open");
    check(!timeline.at(30) && !timeline.at(39) && timeline.at(40)->title == "Third" &&
              !timeline.at(50),
          "A gap or completed interval retained a task");
    check(timeline.at(45)->repetition == 8 && timeline.at(11)->repetition == 2 &&
              timeline.at(21)->repetition == 4 && timeline.at(10)->repetition == 2,
          "Reverse seeking changed task identity or renumbered recorded repetitions");
    check(timeline.to_json(31).is_null() && timeline.to_json(21).at("repetition") == 4 &&
              timeline.to_json(21).at("cycle").is_null(),
          "Timeline JSON omitted a gap or fabricated a missing cycle");
    const auto& spans = timeline.visible_spans();
    check(spans.size() == 3 && spans[0].start_us == 10 && spans[0].end_us == 20 &&
              spans[0].task_index == 0 && spans[1].start_us == 20 && spans[1].end_us == 30 &&
              spans[1].task_index == 1 && spans[2].start_us == 40 && spans[2].end_us == 50 &&
              spans[2].task_index == 2,
          "Visible spans changed task boundaries or filled an unrecorded gap");
}

void descriptions_and_dataset_identity() {
    auto event = episode(0, 100, "  Exact segment title  ");
    event.attributes.update({{"description", "  Do this precisely.\nThen stop.  "},
                             {"task_index", 9}, {"take", 4},
                             {"task_specification", specification()}});
    const auto timeline = ReplayTaskTimeline::from_events({event});
    const auto* task = timeline.at(0);
    check(task && task->title == "  Exact segment title  " &&
              task->description == "  Do this precisely.\nThen stop.  " &&
              task->run_title == "  Assembly run  " &&
              task->run_description == "Keep the original wording.\n",
          "Recorded task or run strings were normalised");
    check(task->task_number == 1 && task->task_count == 1 && task->task_id == "inspect" &&
              task->repeat_count == 5 && task->take == 4 && task->cycle_count == 3 && !task->cycle,
          "Dataset task identity was used as a run ordinal or missing counters were fabricated");
    check(task->attributes == event.attributes,
          "Original replay task attributes were changed");

    auto matched_by_id = event;
    matched_by_id.attributes["task_id"] = "inspect";
    matched_by_id.attributes["task_index"] = 900;
    check(ReplayTaskTimeline::from_events({matched_by_id}).tasks()[0].task_number == 1,
          "Task id did not match the specification independently of dataset indexing");

    auto unmatched = event;
    unmatched.attributes["task_index"] = 0;
    const auto unknown = ReplayTaskTimeline::from_events({unmatched});
    check(!unknown.tasks()[0].task_number && !unknown.tasks()[0].task_count &&
              !unknown.tasks()[0].repeat_count,
          "An unmatched dataset task index was treated as specification order");
}

void native_metadata_and_specification_priority() {
    auto event = episode(0, 100, "Unused imported title");
    event.attributes.erase("schema");
    event.attributes.erase("version");
    event.attributes.erase("title");
    event.attributes["name"] = " Exact recorded instructions.\n";
    event.attributes["task_id"] = "inspect";
    event.attributes["task_index"] = 0;
    event.attributes["cycle"] = 2;
    const auto fallback = specification();
    const auto timeline = ReplayTaskTimeline::from_events({event}, fallback);
    const auto& task = timeline.tasks()[0];
    check(task.title == "  Inspect the assembly  " &&
              task.description == " Exact recorded instructions.\n" &&
              task.task_number == 1 && task.task_count == 1 && task.repetition == 2 &&
              task.repeat_count == 5 && task.cycle == 2 && task.cycle_count == 3,
          "Native episode metadata did not use the recorded instructions and specification label");

    event.attributes.erase("task_id");
    check(ReplayTaskTimeline::from_events({event}, fallback).tasks()[0].task_number == 1,
          "Native specification-order task index was not recognised");

    auto embedded = fallback;
    embedded["runTitle"] = "Embedded run";
    embedded["tasks"][0]["label"] = "Embedded label";
    event.attributes["task_specification"] = embedded;
    const auto preferred = ReplayTaskTimeline::from_events({event}, fallback);
    check(preferred.tasks()[0].run_title == "Embedded run" &&
              preferred.tasks()[0].title == "Embedded label",
          "Fallback specification replaced embedded task metadata");
    event.attributes["task_specification"] = {{"tasks", "invalid"}};
    check(ReplayTaskTimeline::from_events({event}, fallback).tasks()[0].title ==
              "  Inspect the assembly  ",
          "Malformed embedded metadata prevented a valid native specification fallback");
}

void missing_and_invalid_metadata() {
    const auto valid = episode(0, 10, "Valid");
    std::vector<SessionEvent> invalid;
    const auto reject_field = [&](const char* key, Json value) {
        auto event = valid;
        event.attributes[key] = std::move(value);
        invalid.push_back(std::move(event));
    };
    reject_field("start_us", -1);
    reject_field("start_us", 1.5);
    reject_field("start_us", true);
    reject_field("end_us", 0);
    reject_field("end_us", "10");
    reject_field("end_us", std::numeric_limits<std::uint64_t>::max());
    reject_field("schema", "future-task-schema");
    reject_field("schema", 1);
    reject_field("version", 2);
    reject_field("version", true);
    reject_field("action", "restart-task");
    auto wrong_kind = valid;
    wrong_kind.kind = EventKind::Metadata;
    invalid.push_back(wrong_kind);
    auto wrong_attributes = valid;
    wrong_attributes.attributes = Json::array({1, 2});
    invalid.push_back(wrong_attributes);
    auto missing_end = valid;
    missing_end.attributes.erase("end_us");
    invalid.push_back(missing_end);
    invalid.push_back(valid);
    check(ReplayTaskTimeline::from_events(invalid).tasks().size() == 1,
          "Invalid task metadata was accepted or prevented valid intervals from loading");

    auto missing = valid;
    missing.attributes.erase("repetition");
    missing.attributes["task_specification"] = specification();
    missing.attributes["task_id"] = "inspect";
    missing.attributes["task_specification"]["cycleCount"] = 1;
    missing.attributes.update({{"take", 0}, {"cycle", -2}, {"repeat_count", "5"}});
    const auto timeline = ReplayTaskTimeline::from_events({missing});
    const auto& task = timeline.tasks()[0];
    check(!task.repetition && !task.take && !task.cycle && task.cycle_count == 1 &&
              task.repeat_count == 5,
          "Invalid optional counters were accepted or missing observations were inferred");

    auto empty = valid;
    empty.attributes.update({{"title", ""}, {"description", ""},
                             {"name", "Fallback must not replace explicit strings"}});
    const auto preserved = ReplayTaskTimeline::from_events({empty});
    check(preserved.tasks()[0].title.empty() && preserved.tasks()[0].description.empty(),
          "An explicitly empty string was replaced");
}

void overlapping_intervals() {
    const auto long_task = episode(0, 100, "Long");
    const auto early = episode(20, 30, "Early");
    const auto later = episode(20, 40, "Later");
    const auto timeline = ReplayTaskTimeline::from_events({long_task, early, later});
    check(timeline.at(25)->title == "Later" && timeline.at(35)->title == "Later" &&
              timeline.at(40)->title == "Long" && timeline.at(5)->title == "Long" &&
              timeline.at(25)->title == "Later",
          "Overlapping task intervals were resolved inconsistently across seeks");
    const auto& spans = timeline.visible_spans();
    check(spans.size() == 3 && spans[0].start_us == 0 && spans[0].end_us == 20 &&
              spans[0].task_index == 0 && spans[1].start_us == 20 && spans[1].end_us == 40 &&
              spans[1].task_index == 2 && spans[2].start_us == 40 && spans[2].end_us == 100 &&
              spans[2].task_index == 0,
          "Overlap spans exposed an obscured task or failed to merge an unchanged visible task");
}

void equal_start_spans_and_priority() {
    const auto timeline = ReplayTaskTimeline::from_events({
        episode(0, 10, "Earlier"), episode(0, 4, "Later"),
        episode(6, 8, "Newest"), episode(12, 14, "After gap")});
    const std::vector<ReplayTaskSpan> expected = {
        {0, 4, 1}, {4, 6, 0}, {6, 8, 2}, {8, 10, 0}, {12, 14, 3}};
    const auto& spans = timeline.visible_spans();
    check(spans.size() == expected.size(), "Equal-start overlap produced unexpected visible spans");
    for (std::size_t i = 0; i < spans.size(); ++i) {
        const auto& span = spans[i];
        check(span.start_us == expected[i].start_us && span.end_us == expected[i].end_us &&
                  span.task_index == expected[i].task_index &&
                  timeline.at(span.start_us) == &timeline.tasks()[span.task_index] &&
                  timeline.at(span.end_us - 1) == &timeline.tasks()[span.task_index],
              "Visible spans disagree with the selected task at a half-open boundary");
        if (i)
            check(spans[i - 1].end_us <= span.start_us,
                  "Visible task spans overlap");
    }
    check(timeline.at(0)->title == "Later" && timeline.at(4)->title == "Earlier" &&
              timeline.at(6)->title == "Newest" && timeline.at(8)->title == "Earlier" &&
              !timeline.at(10) && !timeline.at(11) && timeline.at(12)->title == "After gap" &&
              !timeline.at(14),
          "Equal-start priority, restoration or gaps changed during span construction");
    const auto empty = ReplayTaskTimeline::from_events({});
    check(empty.visible_spans().empty() && !empty.at(0),
          "An empty timeline gained a visible task span");
}
} // namespace

int main() {
    try {
        boundaries_gaps_and_seeking();
        descriptions_and_dataset_identity();
        native_metadata_and_specification_priority();
        missing_and_invalid_metadata();
        overlapping_intervals();
        equal_start_spans_and_priority();
        std::cout << "PASS: replay task intervals, descriptions, counters and specification identity\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
