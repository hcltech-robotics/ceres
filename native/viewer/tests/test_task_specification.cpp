#include "ceres/task_specification.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
using namespace ceres;

void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

template <class Action> void rejects(Action action, const char* message) {
    bool rejected = false;
    try {
        action();
    } catch (const std::exception&) {
        rejected = true;
    }
    check(rejected, message);
}

Json document() {
    return {{"schema", "ceres-task-specification"},
            {"version", 1},
            {"runTitle", "Assembly"},
            {"runDescription", "Assemble and inspect the part."},
            {"cycleCount", 2},
            {"tasks", Json::array({
                {{"id", "pick"}, {"type", "timed"}, {"label", "Pick"},
                 {"instructions", "Pick up the part."}, {"durationS", 2},
                 {"repeatCount", 2}, {"resetTimeS", 0}},
                {{"id", "rest"}, {"type", "pause"}, {"label", "Rest"},
                 {"instructions", "Put the part down."}, {"durationS", 3}},
                {{"id", "inspect"}, {"type", "open"}, {"label", "Inspect"},
                 {"instructions", "Inspect the part."}, {"repeatCount", 1},
                 {"resetTimeS", 5}}})}};
}

void canonical_import() {
    auto raw = document();
    const auto specification = parse_task_specification(raw);
    check(specification.tasks.size() == 3 && specification.tasks[0].type == TaskType::timed &&
              specification.tasks[1].type == TaskType::pause &&
              specification.tasks[2].type == TaskType::open,
          "Canonical task types changed");
    check(specification.to_json() == raw && Json(specification) == raw,
          "Canonical task specification did not round trip");
    check(specification.tasks[0].reset_time_s == 0,
          "Canonical reset preference was replaced by the execution minimum");
    raw["runTitle"] = "  Assembly \n";
    raw["runDescription"] = " \t";
    raw["tasks"][0]["id"] = " pick ";
    raw["tasks"][0]["label"] = " Pick ";
    const auto trimmed = parse_task_specification(raw);
    check(trimmed.run_title == "Assembly" && trimmed.run_description.empty() &&
              !trimmed.to_json().contains("runDescription") && trimmed.tasks[0].id == "pick" &&
              trimmed.tasks[0].label == "Pick",
          "Canonical whitespace normalisation differs");
    raw["runTitle"] = "\xc2\xa0" "Assembly" "\xe3\x80\x80";
    check(parse_task_specification(raw).run_title == "Assembly",
          "ECMAScript Unicode whitespace was not trimmed");
    raw["tasks"][0]["durationS"] = -0.0;
    const auto zero = parse_task_specification(raw);
    check(zero.tasks[0].duration_s == 0 && !std::signbit(zero.tasks[0].duration_s),
          "Negative zero was not canonicalised");

    const auto invalid = [&](auto mutate) {
        auto value = document();
        mutate(value);
        rejects([&] { parse_task_specification(value); }, "Invalid task specification was accepted");
    };
    invalid([](Json& value) { value["schema"] = "unknown"; });
    invalid([](Json& value) { value["version"] = 2; });
    invalid([](Json& value) { value["version"] = true; });
    invalid([](Json& value) { value["extra"] = 1; });
    invalid([](Json& value) { value["runDescription"] = nullptr; });
    invalid([](Json& value) { value["runTitle"] = " "; });
    invalid([](Json& value) { value["tasks"] = Json::array(); });
    invalid([](Json& value) { value["cycleCount"] = 1.5; });
    invalid([](Json& value) { value["cycleCount"] = 9007199254740992ULL; });
    invalid([](Json& value) { value["tasks"][1]["id"] = " pick "; });
    invalid([](Json& value) { value["tasks"][0]["enabled"] = false; });
    invalid([](Json& value) { value["tasks"][0]["repeatCount"] = 0; });
    invalid([](Json& value) { value["tasks"][0]["durationS"] = -1; });
    invalid([](Json& value) { value["tasks"][0]["durationS"] = "2"; });
    invalid([](Json& value) {
        value["tasks"][0]["durationS"] = std::numeric_limits<double>::infinity();
    });
    invalid([](Json& value) { value["tasks"][1]["repeatCount"] = 1; });
    invalid([](Json& value) { value["tasks"][2]["durationS"] = 1; });
    invalid([](Json& value) { value["tasks"][0].erase("instructions"); });
    rejects([] { parse_task_specification(Json::array()); }, "Array document was accepted");
}

void legacy_import() {
    for (const char* schema : {"ceres-run-v1", "ceres-run-v2", "ceres-run-v5"}) {
        Json raw = {{"schema", schema},
                    {"configuration", {{"runTitle", " Old run "},
                                       {"taskDescription", " Legacy instructions "},
                                       {"totalCycles", 2.9},
                                       {"recordAudio", true},
                                       {"tasks", Json::array({
                                           {{"id", "same"}, {"label", "First"},
                                            {"repeatCount", 2.9}, {"setCount", 3},
                                            {"resetTimeS", 0}},
                                           {{"id", "same"}, {"type", "open"}},
                                           {{"type", "pause"}}, nullptr})}}}};
        const auto specification = parse_task_specification(raw);
        check(specification.run_title == "Old run" && specification.cycle_count == 2 &&
                  specification.run_description == "Legacy instructions",
              "Legacy run identity or cycle normalisation differs");
        check(specification.tasks[0].repeat_count == 6 &&
                  specification.tasks[0].reset_time_s == 5 &&
                  specification.tasks[0].duration_s == 60 &&
                  specification.tasks[0].instructions == "--",
              "Legacy repetitions, resets or timed defaults differ");
        check(specification.tasks[0].id != specification.tasks[1].id &&
                  specification.tasks[1].type == TaskType::open &&
                  specification.tasks[2].type == TaskType::pause &&
                  specification.tasks[2].duration_s == 15 &&
                  specification.tasks[3].label == "Task 04",
              "Legacy task identity or default types differ");
        check(!specification.to_json().contains("recordAudio"),
              "Capture preferences leaked into task specification");
        const auto fallback = parse_task_specification({{"schema", schema}, {"configuration", Json::object()}});
        check(fallback.run_title == "Open capture" && fallback.tasks.size() == 1 &&
                  fallback.tasks[0].type == TaskType::open,
              "Legacy default run differs");
    }
    rejects([] { parse_task_specification({{"schema", "ceres-run-v5"}}); },
            "Missing legacy configuration was accepted");
    rejects([] { parse_task_specification({{"schema", "ceres-run-v3"}, {"configuration", Json::object()}}); },
            "Unsupported legacy schema was accepted");
}

TaskSpecification timed_run(double duration, uint64_t repetitions = 1, uint64_t cycles = 1) {
    TaskSpecification result;
    result.run_title = "Timed run";
    result.cycle_count = cycles;
    result.tasks.push_back({"timed", "Timed task", "Perform the task.", TaskType::timed,
                            duration, 0, repetitions});
    return result;
}

void timed_progression() {
    TaskRun run;
    auto transitions = run.start(timed_run(1, 2, 2), 1000000);
    check(transitions.size() == 1 && transitions[0].before.phase == TaskRunPhase::stopped &&
              transitions[0].after.phase == TaskRunPhase::active_task,
          "Run did not begin with an active task transition");
    transitions = run.update(100000000);
    const std::array<int64_t, 10> expected{2000000, 7000000, 8000000, 13000000, 28000000,
                                          29000000, 34000000, 35000000, 40000000, 55000000};
    check(transitions.size() == expected.size(), "Timed repetitions or cycles lost transitions");
    for (size_t index = 0; index < expected.size(); ++index)
        check(transitions[index].time_us == expected[index], "Timed transition used frame time instead of its boundary");
    check(transitions[1].after.repetition == 2 && transitions[4].after.cycle == 2 &&
              transitions[4].after.repetition == 1 && transitions[9].after.phase == TaskRunPhase::complete,
          "Run cursor did not follow repetitions and cycles");
    const auto complete = run.progress(200000000);
    check(complete.phase == TaskRunPhase::complete && complete.elapsed_us == 54000000 &&
              run.update(200000000).empty() && run.stop(200000000).empty(),
          "Completed run clocks did not freeze at the final cycle boundary");
}

void pause_resume_and_stop() {
    TaskRun run;
    run.start(timed_run(2, 2, 2), 1000000);
    auto transitions = run.pause(2000000);
    check(transitions.size() == 1 && transitions[0].before.phase == TaskRunPhase::active_task &&
              transitions[0].after.phase == TaskRunPhase::active_task && transitions[0].after.paused,
          "Manual pause did not retain the active task phase");
    check(run.update(5000000).empty() && run.progress(10000000).elapsed_us == 1000000 &&
              *run.progress(10000000).phase_remaining_us == 1000000,
          "Paused task clocks advanced");
    check(run.advance(10000000).empty(), "Manual advance changed a paused task");
    transitions = run.resume(11000000);
    check(transitions.size() == 1 && transitions[0].before.paused && !transitions[0].after.paused,
          "Resume did not expose an active phase transition");
    transitions = run.update(12000000);
    check(transitions.size() == 1 && transitions[0].time_us == 12000000 &&
              transitions[0].after.phase == TaskRunPhase::post_task_pause &&
              *transitions[0].after.phase_remaining_us == minimum_task_reset_us,
          "Resumed timed task boundary or minimum reset differs");
    run.pause(13000000);
    run.resume(20000000);
    transitions = run.update(24000000);
    check(transitions.size() == 1 && transitions[0].after.repetition == 2 &&
              transitions[0].after.phase == TaskRunPhase::active_task,
          "Prescribed reset did not freeze during manual pause");
    transitions = run.stop(25000000);
    check(transitions.size() == 1 && transitions[0].after.phase == TaskRunPhase::stopped &&
              run.progress(30000000).elapsed_us == 8000000,
          "Stopping the run failed to freeze its clock");
    rejects([&] { run.update(24000000); }, "A backwards task clock was accepted");
    rejects([&] { run.start(timed_run(1), -1); }, "Negative start clock was accepted");
    rejects([&] { run.start({}, 30000000); }, "An empty task run was accepted");
}

void open_tasks_and_zero_pauses() {
    TaskSpecification specification;
    specification.run_title = "Inspection";
    specification.tasks = {{"open", "Inspect", "Inspect the part.", TaskType::open, 0, 0, 2},
                           {"pause", "Wait", "Wait.", TaskType::pause, 0, 0, 1},
                           {"timed", "Touch", "Touch the part.", TaskType::timed, 0, 0, 1}};
    TaskRun run;
    run.start(specification, 0);
    check(run.update(1000000000).empty() && !run.progress(1000000000).phase_remaining_us,
          "Open task advanced without an explicit action");
    run.advance(1000000000);
    auto transitions = run.advance(1001000000);
    check(transitions.size() == 1 && transitions[0].after.repetition == 2,
          "Explicit reset completion did not advance the open task repetition");
    run.advance(1002000000);
    transitions = run.advance(1003000000);
    check(transitions.back().after.phase == TaskRunPhase::task_pause &&
              transitions.back().after.task_index == 1,
          "Pause task was treated as a recordable repetition");
    transitions = run.update(1003000000);
    check(transitions.size() == 2 && transitions[0].time_us == 1003000000 &&
              transitions[0].after.phase == TaskRunPhase::active_task &&
              transitions[1].after.phase == TaskRunPhase::post_task_pause,
          "Zero duration tasks and pauses did not settle at the same boundary");
    run.advance(1004000000);
    transitions = run.advance(1005000000);
    check(transitions.size() == 1 && transitions[0].after.phase == TaskRunPhase::complete,
          "Explicit cycle pause completion did not complete the run");

    auto huge = timed_run(9007199254740991.0);
    run.start(huge, 0);
    check(run.update(1000000000).empty() && *run.progress(1000000000).phase_remaining_us > 0,
          "Large valid task duration overflowed its clock");
}

void restart_active_repetitions() {
    TaskRun run;
    run.start(timed_run(2, 3, 2), 1000000);
    check(run.can_restart(), "An active task could not be restarted");
    auto transitions = run.restart_repetition(1750000);
    check(transitions.size() == 1 && transitions[0].time_us == 1750000 &&
              transitions[0].reason == TaskTransitionReason::restart_repetition &&
              transitions[0].before.phase == TaskRunPhase::active_task &&
              transitions[0].after.phase == TaskRunPhase::active_task &&
              transitions[0].before.phase_elapsed_us == 750000 &&
              transitions[0].after.phase_elapsed_us == 0 &&
              transitions[0].after.elapsed_us == 750000 &&
              transitions[0].after.repetition == 1 && transitions[0].after.cycle == 1,
          "Repetition restart did not expose a new episode without rewinding the run");
    check(run.update(3000000).empty(), "Restarted repetition retained its old deadline");
    transitions = run.update(3750000);
    check(transitions.size() == 1 && transitions[0].time_us == 3750000 &&
              transitions[0].reason == TaskTransitionReason::progression &&
              transitions[0].after.phase == TaskRunPhase::post_task_pause,
          "Restarted timed repetition did not receive its full duration");
    run.advance(4000000);
    check(run.progress(4250000).repetition == 2, "Restart test did not reach repetition two");
    transitions = run.restart_task(4500000);
    check(transitions.size() == 1 && transitions[0].reason == TaskTransitionReason::restart_task &&
              transitions[0].time_us == 4500000 && transitions[0].before.repetition == 2 &&
              transitions[0].after.repetition == 1 && transitions[0].after.task_index == 0 &&
              transitions[0].after.cycle == 1 && transitions[0].after.elapsed_us == 3500000 &&
              transitions[0].after.phase_elapsed_us == 0,
          "Whole-task restart changed cycle, elapsed time or the wrong repetition");
    transitions = run.restart_task(4500000);
    check(transitions.size() == 1 && transitions[0].time_us == 4500000 &&
              transitions[0].before.phase == transitions[0].after.phase &&
              transitions[0].reason == TaskTransitionReason::restart_task,
          "A restart at the same cursor silently lost its episode boundary");

    run.start(timed_run(1, 2), 10000000);
    transitions = run.restart_repetition(11250000);
    check(transitions.size() == 2 && transitions[0].time_us == 11000000 &&
              transitions[0].after.phase == TaskRunPhase::post_task_pause &&
              transitions[1].time_us == 11250000 &&
              transitions[1].before.phase == TaskRunPhase::post_task_pause &&
              transitions[1].after.phase == TaskRunPhase::active_task &&
              transitions[1].after.elapsed_us == 1250000 &&
              transitions[1].after.phase_elapsed_us == 0,
          "Late restart lost the previous timed boundary or backdated the new capture");
    transitions = run.update(12250000);
    check(transitions.size() == 1 && transitions[0].time_us == 12250000,
          "A repetition restarted during reset used the original task clock");
    rejects([&] { run.restart_repetition(12249999); },
            "Repetition restart accepted a backwards capture clock");
    rejects([&] { run.restart_task(12249999); },
            "Whole-task restart accepted a backwards capture clock");
}

void restart_manually_paused_tasks() {
    TaskSpecification specification;
    specification.run_title = "Open task restart";
    specification.tasks = {
        {"open", "Inspect", "Inspect the part.", TaskType::open, 0, 5, 3}};
    TaskRun run;
    run.start(specification, 0);
    run.advance(1000000);
    run.advance(2000000);
    run.pause(3000000);
    check(run.can_restart(), "Manually paused task could not be restarted");
    auto transitions = run.restart_repetition(20000000);
    check(transitions.size() == 1 && transitions[0].time_us == 20000000 &&
              transitions[0].before.paused && !transitions[0].after.paused &&
              transitions[0].after.phase == TaskRunPhase::active_task &&
              transitions[0].after.repetition == 2 && transitions[0].after.elapsed_us == 3000000 &&
              transitions[0].after.phase_elapsed_us == 0 &&
              !transitions[0].after.phase_remaining_us,
          "Restart did not resume the paused open repetition with intact run time");
    check(run.progress(21000000).elapsed_us == 4000000 &&
              run.progress(21000000).phase_elapsed_us == 1000000,
          "Restart included manually paused wall time in the run duration");
    run.advance(22000000);
    run.pause(23000000);
    transitions = run.restart_task(40000000);
    check(transitions.size() == 1 && transitions[0].before.paused &&
              transitions[0].before.phase == TaskRunPhase::post_task_pause &&
              !transitions[0].after.paused && transitions[0].after.repetition == 1 &&
              transitions[0].after.elapsed_us == 6000000 &&
              transitions[0].after.phase_elapsed_us == 0,
          "Whole-task restart from a manually paused reset did not resume repetition one");
}

void restart_prescribed_pauses() {
    auto specification = timed_run(1, 2, 2);
    specification.tasks.push_back({"pause-a", "Rest", "Rest.", TaskType::pause, 3, 0, 1});
    specification.tasks.push_back({"pause-b", "Wait", "Wait.", TaskType::pause, 4, 0, 1});
    for (bool whole_task : {false, true}) {
        TaskRun run;
        run.start(specification, 0);
        run.update(16000000);
        check(run.can_restart() && run.progress(16000000).phase == TaskRunPhase::task_pause &&
                  run.progress(16000000).task_index == 2,
              "Restart test did not reach consecutive explicit pauses");
        const auto transitions = whole_task ? run.restart_task(17000000)
                                             : run.restart_repetition(17000000);
        check(transitions.size() == 1 && transitions[0].time_us == 17000000 &&
                  transitions[0].after.task_index == 0 &&
                  transitions[0].after.repetition == (whole_task ? 1 : 2) &&
                  transitions[0].after.phase == TaskRunPhase::active_task &&
                  transitions[0].after.cycle == 1 &&
                  transitions[0].after.elapsed_us == 17000000 &&
                  transitions[0].after.phase_elapsed_us == 0,
              "Explicit pause restart did not return to the last performed task or repetition");
        run.start(specification, 30000000);
        run.update(49000000);
        check(run.can_restart() && run.progress(49000000).phase == TaskRunPhase::cycle_pause,
              "Cycle pause did not retain a restartable task");
        const auto cycle = whole_task ? run.restart_task(50000000)
                                      : run.restart_repetition(50000000);
        check(cycle.size() == 1 && cycle[0].after.task_index == 0 &&
                  cycle[0].after.repetition == (whole_task ? 1 : 2) &&
                  cycle[0].after.cycle == 1 && cycle[0].after.elapsed_us == 20000000 &&
                  cycle[0].after.phase_elapsed_us == 0 && !cycle[0].after.paused,
              "Cycle pause restart selected a pause task or crossed the cycle boundary");
    }

    specification = parse_task_specification(document());
    TaskRun run;
    run.start(specification, 0);
    run.update(17000000);
    run.advance(18000000);
    run.update(23000000);
    const auto transitions = run.restart_repetition(24000000);
    check(transitions.size() == 1 && transitions[0].after.task_index == 2 &&
              run.current_task()->id == "inspect",
          "Cycle restart returned to the first task instead of the most recent performed task");
}

void restart_availability() {
    TaskRun run;
    check(!run.can_restart() && run.restart_repetition(0).empty() && run.restart_task(0).empty(),
          "An unstarted run offered a restart");
    auto specification = timed_run(1, 1, 2);
    specification.tasks.insert(specification.tasks.begin(),
                               {"intro", "Wait", "Wait.", TaskType::pause, 2, 0, 1});
    run.start(specification, 0);
    check(!run.can_restart() && run.restart_repetition(1000000).empty() &&
              run.restart_task(1000000).empty() && run.progress(1000000).task_index == 0,
          "Leading pause fabricated a previously performed repetition");
    run.pause(1000000);
    check(!run.can_restart() && run.restart_task(5000000).empty() && run.progress(5000000).paused,
          "Restart from an initial manual pause changed an unavailable target");
    run.resume(5000000);
    run.update(27000000);
    check(!run.can_restart() && run.progress(27000000).phase == TaskRunPhase::task_pause &&
              run.progress(27000000).cycle == 2 && run.restart_task(27000000).empty(),
          "Leading pause in a new cycle restarted a task from the previous cycle");
    run.update(29000000);
    check(run.can_restart(), "A performed task in the new cycle could not be restarted");
    run.stop(29500000);
    check(!run.can_restart() && run.restart_repetition(30000000).empty() &&
              run.restart_task(30000000).empty(),
          "Stopped run restarted capture");
    run.start(timed_run(1), 40000000);
    const auto completed = run.restart_task(70000000);
    check(!run.can_restart() && run.progress(70000000).phase == TaskRunPhase::complete &&
              run.progress(70000000).elapsed_us == 21000000 && completed.size() == 3 &&
              std::all_of(completed.begin(), completed.end(), [](const TaskTransition& transition) {
                  return transition.reason == TaskTransitionReason::progression;
              }) &&
              run.restart_repetition(71000000).empty(),
          "Restart revived an already completed run or changed its elapsed duration");
    TaskSpecification pauses;
    pauses.run_title = "Rest only";
    pauses.tasks = {{"rest", "Rest", "Rest.", TaskType::pause, 1, 0, 1}};
    run.start(pauses, 80000000);
    run.update(82000000);
    check(run.progress(82000000).phase == TaskRunPhase::cycle_pause && !run.can_restart() &&
              run.restart_repetition(82000000).empty(),
          "A pause-only cycle fabricated a recordable restart target");
}

void file_import() {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto path = std::filesystem::temp_directory_path() /
                      ("ceres-task-import-" + std::to_string(nonce) + ".json");
    struct Cleanup {
        std::filesystem::path path;
        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove(path, error);
        }
    } cleanup{path};
    {
        std::ofstream output(path, std::ios::binary);
        output << document().dump();
    }
    check(load_task_specification(path).tasks.size() == 3, "Task file import failed");
    {
        std::ofstream output(path, std::ios::binary | std::ios::trunc);
        output << "not json";
    }
    rejects([&] { load_task_specification(path); }, "Malformed task JSON was accepted");
    {
        std::ofstream output(path, std::ios::binary | std::ios::trunc);
        output << std::string(task_import_max_bytes + 1, ' ');
    }
    rejects([&] { load_task_specification(path); }, "Oversized task file was accepted");
}
} // namespace

int main() {
    try {
        canonical_import();
        legacy_import();
        timed_progression();
        pause_resume_and_stop();
        open_tasks_and_zero_pauses();
        restart_active_repetitions();
        restart_manually_paused_tasks();
        restart_prescribed_pauses();
        restart_availability();
        file_import();
        std::cout << "PASS: CERES task imports, timing, repetitions, pauses and cycles\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
