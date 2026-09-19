#include "ceres/session.hpp"
#include "ceres/task_specification.hpp"
#include "depth_fixture.hpp"
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <fstream>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
#ifdef __linux__
#include <cerrno>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <poll.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

using namespace ceres;
namespace {
void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}
void put32(std::vector<uint8_t>& b, size_t p, uint32_t n) {
    for (int i = 0; i < 4; ++i)
        b[p + i] = uint8_t(n >> (8 * i));
}
SessionEvent video(int sequence, int64_t time) {
    SessionEvent event;
    event.kind = EventKind::Video;
    event.stream = "camera";
    event.receive_us = event.time_us = time;
    event.epoch = 7;
    event.sequence = sequence;
    event.keyframe = sequence % 20 == 0;
    event.payload.resize(512, uint8_t(sequence));
    event.payload[0] = event.payload[1] = event.payload[2] = 0;
    event.payload[3] = 1;
    event.payload[4] = event.keyframe ? 0x65 : 0x41;
    event.attributes = {{"codec", "h264"}, {"pts_us", time}};
    return event;
}
SessionEvent head(int64_t time) {
    SessionEvent event;
    event.kind = EventKind::Pose;
    event.receive_us = event.time_us = time;
    event.epoch = 7;
    event.sequence = 77;
    event.payload.resize(68);
    event.payload[0] = 'C';
    event.payload[1] = 'B';
    event.payload[2] = 'R';
    event.payload[3] = '1';
    event.payload[4] = 1;
    event.payload[5] = 1;
    event.payload[6] = 1;
    put32(event.payload, 8, 7);
    put32(event.payload, 16, 77);
    put32(event.payload, 20, 28);
    put32(event.payload, 24, uint32_t(time));
    put32(event.payload, 32, uint32_t(time));
    put32(event.payload, 64, 0x3f800000);
    return event;
}
uint64_t read64(std::istream& input) {
    uint8_t b[8];
    input.read(reinterpret_cast<char*>(b), 8);
    uint64_t n = 0;
    for (int i = 0; i < 8; ++i)
        n |= uint64_t(b[i]) << (8 * i);
    return n;
}
void replay_task_specification_tests(const std::filesystem::path& directory) {
    const auto path = directory / "task-setup.mcap";
    SessionEvent setup;
    setup.kind = EventKind::Asset;
    setup.stream = "task-specification";
    setup.time_us = setup.receive_us = 1000;
    setup.attributes = {{"schema", "ceres-task-specification"}, {"version", 1},
                        {"runTitle", "Wash dishes"},
                        {"runDescription", "Clean the prepared set."},
                        {"tasks", Json::array({{{"id", "wash"}, {"label", "Wash dishes"},
                            {"instructions", "Wash and rinse.\nLeave no residue."}}})}};
    Recorder recorder;
    auto malformed = setup;
    malformed.attributes["schema"] = 42;
    recorder.start(path, {malformed, setup});
    recorder.stop();
    ReplaySource replay(path);
    require(replay.task_specification() == setup.attributes,
            "Replay task setup did not preserve recorded labels and instructions");
    require(replay.episodes().empty(), "Task setup was mixed into repetition intervals");

    const auto plain_path = directory / "no-task-setup.mcap";
    recorder.start(plain_path, {video(0, 1000)});
    recorder.stop();
    require(ReplaySource(plain_path).task_specification().is_null(),
            "A recording without task setup invented a specification");
}
void recorder_capture_window_tests(const std::filesystem::path& directory) {
    SessionEvent epoch;
    epoch.kind = EventKind::Epoch;
    epoch.receive_us = epoch.time_us = 1000;
    epoch.epoch = 7;
    epoch.attributes = {{"reason", "record-start"}};
    const auto path = directory / "capture-window.mcap";
    Recorder recorder;
    recorder.start(path, {epoch});
    recorder.set_capture_window(2000, 4000);
    bool invalid = false;
    try {
        recorder.set_capture_window(4000, 3999);
    } catch (const std::invalid_argument&) {
        invalid = true;
    }
    require(invalid, "An inverted capture interval was accepted");
    std::vector<SessionEvent> expected;
    uint32_t sequence = 0;
    for (const auto kind : {EventKind::Pose, EventKind::Video, EventKind::Depth}) {
        for (const int64_t received : {1999, 2000, 3999, 4000, 5000}) {
            SessionEvent event;
            if (kind == EventKind::Pose)
                event = head(received - 123);
            else if (kind == EventKind::Video)
                event = video(0, received - 123);
            else {
                auto header = depth_fixture::header(sequence, 7, 0);
                header["observed_us"] = received - 123;
                header["target_us"] = received;
                event = make_depth_event(depth_fixture::encode(header), received, {});
            }
            event.kind = kind;
            event.sequence = sequence++;
            event.receive_us = received;
            event.time_us = received - 123;
            if (kind == EventKind::Depth) {
                // The protocol sequence belongs to the same observation as its envelope.
                auto header = depth_fixture::header(event.sequence, 7, 0);
                header["observed_us"] = event.time_us;
                header["target_us"] = event.receive_us;
                event.payload = depth_fixture::encode(header);
            }
            const bool within = received >= 2000 && received < 4000;
            require(recorder.push(event) == within,
                    "Capture interval did not enforce inclusive start and exclusive end");
            if (within)
                expected.push_back(event);
        }
    }
    for (const int64_t received : {1500, 4500}) {
        auto control = epoch;
        control.kind = EventKind::Calibration;
        control.receive_us = received;
        control.time_us = received - 50;
        control.attributes = {{"capture_boundary", received}};
        require(recorder.push(control), "Capture interval rejected a control event");
    }
    recorder.set_capture_window(4000, 4000);
    require(!recorder.push(head(4000)), "An empty capture interval admitted an observation");
    recorder.set_capture_window(5000);
    auto unbounded = head(5000);
    require(recorder.push(unbounded), "An unbounded capture interval rejected its start");
    expected.push_back(unbounded);
    auto finish = epoch;
    finish.kind = EventKind::Episode;
    finish.receive_us = finish.time_us = 6000;
    finish.attributes = {{"name", "Capture boundary complete"}};
    require(recorder.push(finish), "Capture interval rejected the final episode control");
    recorder.stop();
    require(!recorder.status().failed, "A capture-window omission failed the recorder");

    ReplaySource replay(path);
    std::mutex mutex;
    std::condition_variable received;
    std::vector<SessionEvent> delivered;
    bool complete = false;
    replay.set_speed(16);
    replay.set_event_sink([&](const SessionEvent& event) {
        std::lock_guard lock(mutex);
        delivered.push_back(event);
        if (event.kind == EventKind::Episode) {
            complete = true;
            received.notify_all();
        }
    });
    replay.start();
    {
        std::unique_lock lock(mutex);
        require(received.wait_for(lock, std::chrono::seconds(3), [&] { return complete; }),
                "Capture-window recording did not replay to its final control");
    }
    replay.stop();
    require(replay.snapshot().error.empty(), "Capture-window replay failed");
    size_t observations = 0, controls = 0;
    for (const auto& event : delivered) {
        if (event.kind == EventKind::Pose || event.kind == EventKind::Video ||
            event.kind == EventKind::Depth) {
            ++observations;
            const auto match = std::find_if(expected.begin(), expected.end(), [&](const auto& raw) {
                return raw.kind == event.kind && raw.sequence == event.sequence;
            });
            require(match != expected.end() && event.payload == match->payload &&
                        event.attributes.at("recorded_receive_us") == match->receive_us &&
                        event.attributes.at("recorded_time_us") == match->time_us,
                    "Capture-window filtering changed payloads or source timestamps");
        } else if (event.kind == EventKind::Calibration) {
            ++controls;
            const int64_t boundary = event.attributes.at("capture_boundary");
            require(event.attributes.at("recorded_receive_us") == boundary &&
                        event.attributes.at("recorded_time_us") == boundary - 50,
                    "Capture-window filtering changed a control timestamp");
        }
    }
    require(observations == expected.size() && controls == 2,
            "Capture-window recording lost observations or control continuity");
    recorder.start(directory / "capture-window-reset.mcap", {epoch});
    require(recorder.push(head(1500)), "Starting a new recording retained the previous window");
    recorder.stop();
}
void recorder_task_restart_tests(const std::filesystem::path& directory) {
    for (const std::string pause : {"manual", "reset", "task", "cycle"}) {
        for (const bool whole_task : {false, true}) {
            TaskSpecification specification;
            specification.run_title = "Restart recording";
            TaskDefinition task;
            task.id = "pick";
            task.label = task.instructions = "Pick up the object";
            task.repeat_count = 2;
            specification.tasks.push_back(task);
            if (pause == "task") {
                TaskDefinition rest;
                rest.id = "rest";
                rest.label = rest.instructions = "Rest";
                rest.type = TaskType::pause;
                rest.duration_s = 30;
                specification.tasks.push_back(rest);
            }
            const auto path = directory / ("restart-" + pause + (whole_task ? "-task.mcap" : "-rep.mcap"));
            const auto origin = monotonic_us();
            TaskRun run;
            run.start(specification, origin);
            run.advance(origin);
            run.advance(origin);
            require(run.progress(origin).repetition == 2, "Restart fixture did not reach repetition two");
            SessionEvent epoch;
            epoch.kind = EventKind::Epoch;
            epoch.receive_us = epoch.time_us = origin;
            epoch.epoch = 7;
            epoch.attributes = {{"reason", "record-start"}};
            Recorder recorder;
            recorder.start(path, {epoch});
            recorder.set_capture_window(origin);
            require(recorder.add_episode(task.instructions, {{"action", "start"}, {"start_us", 0},
                        {"task_index", 0}, {"repetition", 2}, {"cycle", 1}}),
                    "The original attempt start was not recorded");
            const auto first_observation = monotonic_us();
            require(recorder.push(head(first_observation)), "The original attempt lost its observation");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            const auto paused_at = monotonic_us();
            if (pause == "manual")
                run.pause(paused_at);
            else {
                run.advance(paused_at);
                if (pause == "task" || pause == "cycle")
                    run.advance(paused_at);
            }
            require(recorder.add_episode(task.instructions, {{"action", "stop"}, {"start_us", 0},
                        {"end_us", paused_at - origin}, {"repetition", 2}, {"cycle", 1}}),
                    "The original attempt end was not recorded");
            recorder.set_capture_window(paused_at, paused_at);
            recorder.set_paused(true);
            const auto paused_status = recorder.status();
            require(paused_status.paused && !recorder.push(head(monotonic_us())),
                    "The pause admitted a task observation");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            require(recorder.status().active_duration_us == paused_status.active_duration_us,
                    "The recorded clock advanced during the task pause");
            const auto restart_at = monotonic_us();
            const auto transitions = whole_task ? run.restart_task(restart_at)
                                                : run.restart_repetition(restart_at);
            const auto expected_pause = pause == "manual" ? TaskRunPhase::active_task
                                        : pause == "reset" ? TaskRunPhase::post_task_pause
                                        : pause == "task" ? TaskRunPhase::task_pause
                                                          : TaskRunPhase::cycle_pause;
            require(transitions.size() == 1 && transitions.front().time_us == restart_at &&
                        transitions.front().before.phase == expected_pause &&
                        transitions.front().before.paused == (pause == "manual") &&
                        transitions.front().after.phase == TaskRunPhase::active_task &&
                        !transitions.front().after.paused,
                    "Restart did not resume a task at the current capture time");
            const auto& restarted = transitions.front();
            require(restarted.after.repetition == (whole_task ? 1 : 2) &&
                        restarted.after.cycle == 1 && restarted.after.task_index == 0 &&
                        restarted.after.elapsed_us >= restarted.before.elapsed_us,
                    "Restart changed the wrong repetition, cycle or elapsed run time");
            const char* action = whole_task ? "restart-task" : "restart-repetition";
            const auto reason = whole_task ? TaskTransitionReason::restart_task
                                           : TaskTransitionReason::restart_repetition;
            require(restarted.reason == reason, "Restart lost the user action reason");

            // Exercise the recorder contract directly. The UI owns transition ordering.
            recorder.set_capture_window(restart_at);
            recorder.set_paused(false);
            require(recorder.status().active_duration_us >= paused_status.active_duration_us &&
                        !recorder.push(head(restart_at - 1)),
                    "Restart rewound the recording clock or accepted a pre-restart observation");
            require(recorder.add_episode("Task control", {{"action", action},
                        {"at_us", restart_at - origin}, {"task_index", 0},
                        {"repetition", restarted.after.repetition}, {"cycle", 1}}),
                    "Restart control was lost while resuming capture");
            require(recorder.add_episode(task.instructions, {{"action", "start"},
                        {"start_us", restart_at - origin}, {"task_index", 0},
                        {"repetition", restarted.after.repetition}, {"cycle", 1}}),
                    "The restarted attempt start was not recorded");
            const auto second_observation = monotonic_us();
            require(recorder.push(head(second_observation)), "The restarted attempt lost its observation");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            const auto finished_at = monotonic_us();
            const bool success = !whole_task;
            require(recorder.add_episode(task.instructions, {{"action", "stop"},
                        {"start_us", restart_at - origin}, {"end_us", finished_at - origin},
                        {"task_index", 0}, {"repetition", restarted.after.repetition}, {"cycle", 1},
                        {"completion", "done"}, {"outcome", success ? "pass" : "fail"},
                        {"success", success}}),
                    "The attempt outcome was not recorded");
            const auto completed = run.advance(finished_at);
            require(completed.size() == 1 && completed.front().after.phase == TaskRunPhase::post_task_pause,
                    "Completing the judged attempt did not advance to its reset");
            recorder.set_capture_window(finished_at, finished_at);
            recorder.set_paused(true);
            recorder.stop();
            require(!recorder.status().failed &&
                        recorder.status().active_duration_us > paused_status.active_duration_us,
                    "Restart failed the recording or reduced recorded time");

            ReplaySource replay(path);
            const auto events = replay.episodes();
            require(events.size() == 5 && events[0].attributes.at("action") == "start" &&
                        events[1].attributes.at("action") == "stop" &&
                        events[2].attributes.at("action") == action &&
                        events[3].attributes.at("action") == "start" &&
                        events[4].attributes.at("action") == "stop",
                    "Saved restart controls or attempt boundaries were lost or reordered");
            for (size_t index = 1; index < events.size(); ++index)
                require(events[index].receive_us >= events[index - 1].receive_us,
                        "Saved attempt control timestamps moved backwards");
            require(events[1].attributes.at("end_us") == paused_at - origin &&
                        events[2].attributes.at("at_us") == restart_at - origin &&
                        events[3].attributes.at("start_us") == restart_at - origin &&
                        events[4].attributes.at("start_us") == restart_at - origin &&
                        events[4].attributes.at("end_us") == finished_at - origin &&
                        paused_at <= restart_at && restart_at < finished_at,
                    "Saved attempt boundaries rewound or overlapped the recording");
            require(events[4].attributes.at("completion") == "done" &&
                        events[4].attributes.at("outcome") == (success ? "pass" : "fail") &&
                        events[4].attributes.at("success") == success &&
                        events[4].attributes.at("repetition") == restarted.after.repetition &&
                        events[4].attributes.at("cycle") == 1,
                    "Saved pass/fail attributes were lost or attached to the wrong attempt");
            const auto observations = replay.pose_history(0, replay.duration_us());
            require(observations.size() == 2 && observations[0].time_us == first_observation &&
                        observations[1].time_us == second_observation,
                    "Restart discarded prior recording or admitted observations from its pause");
        }
    }
}
void recorder_active_clock_tests(const std::filesystem::path& directory) {
    SessionEvent epoch;
    epoch.kind = EventKind::Epoch;
    epoch.receive_us = epoch.time_us = monotonic_us();
    epoch.epoch = 7;
    epoch.attributes = {{"reason", "record-start"}};
    Recorder recorder;
    recorder.start(directory / "capture-clock.mcap", {epoch});
    recorder.set_paused(true);
    const auto baseline = recorder.status().active_duration_us;
    recorder.set_capture_window(0, monotonic_us());
    recorder.set_paused(false);
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
    require(recorder.status().active_duration_us == baseline,
            "A completed capture interval continued adding active time");
    recorder.set_capture_window(monotonic_us());
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
    require(recorder.status().active_duration_us > baseline,
            "Opening a capture interval did not resume the active clock");
    recorder.set_capture_window(0, monotonic_us() + 2000);
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
    const auto bounded = recorder.status().active_duration_us;
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
    require(recorder.status().active_duration_us == bounded,
            "UI delay beyond the capture deadline advanced the active clock");
    recorder.set_capture_window(monotonic_us());
    require(recorder.status().active_duration_us >= bounded,
            "Changing capture intervals lost the previous active contribution");
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
    const auto before_empty = recorder.status().active_duration_us;
    const auto empty = monotonic_us();
    recorder.set_capture_window(empty, empty);
    const auto frozen = recorder.status().active_duration_us;
    require(frozen >= before_empty && frozen > bounded,
            "Closing a capture interval lost its active contribution");
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
    require(recorder.status().active_duration_us == frozen,
            "An empty capture interval advanced the active clock");
    recorder.stop();
    require(!recorder.status().failed && recorder.status().active_duration_us == frozen,
            "Finalising a bounded recording changed its active clock");
}
void recorder_pause_tests(const std::filesystem::path& directory) {
    const auto path = directory / "paused-recording.mcap";
    SessionEvent epoch;
    epoch.kind = EventKind::Epoch;
    epoch.receive_us = epoch.time_us = monotonic_us();
    epoch.epoch = 7;
    epoch.attributes = {{"reason", "record-start"}};
    Recorder recorder;
    recorder.set_paused(true);
    require(!recorder.status().paused, "An idle recorder became paused");
    recorder.start(path, {epoch});
    auto before = head(monotonic_us());
    require(recorder.push(before) && recorder.push(video(0, monotonic_us())),
            "Initial pause fixture observations were rejected");
    recorder.set_paused(true);
    const auto paused = recorder.status();
    require(paused.recording && paused.paused && !paused.failed,
            "Pausing did not retain the open recording");
    recorder.set_paused(true);
    require(recorder.status().accepted_events == paused.accepted_events,
            "Repeated pause created another boundary");
    auto omitted_pose = head(monotonic_us());
    require(!recorder.push(omitted_pose) && !recorder.push(video(20, monotonic_us())) &&
                !recorder.add_episode("Omitted pause marker"),
            "Paused observations or episodes were captured");
    SessionEvent omitted_depth;
    omitted_depth.kind = EventKind::Depth;
    omitted_depth.receive_us = omitted_depth.time_us = monotonic_us();
    omitted_depth.epoch = 7;
    omitted_depth.payload = {1, 2, 3};
    require(!recorder.push(omitted_depth), "Paused depth was captured");

    auto connection = epoch;
    connection.receive_us = connection.time_us = monotonic_us();
    connection.epoch = 8;
    connection.space_epoch = 2;
    connection.attributes = {{"reason", "connection"}};
    require(!recorder.push(connection), "Paused connection state was written early");
    std::ifstream fixture(std::filesystem::path(__FILE__).parent_path() / "fixtures" /
                          "bridge-cameras.json");
    auto description = connection;
    description.kind = EventKind::Metadata;
    description.receive_us = description.time_us = monotonic_us();
    description.attributes = Json::parse(fixture).at("description");
    description.attributes["epoch"] = 8;
    description.attributes["pause_revision"] = 1;
    require(!recorder.push(description), "Paused metadata was written early");
    description.receive_us = description.time_us = monotonic_us();
    description.attributes["pause_revision"] = 2;
    require(!recorder.push(description), "Updated paused metadata was written early");
    auto clock = connection;
    clock.kind = EventKind::Clock;
    clock.receive_us = clock.time_us = monotonic_us();
    clock.attributes = {{"offset_us", 123.0}, {"rate", 1.2}, {"valid", true}};
    auto calibration = connection;
    calibration.kind = EventKind::Calibration;
    calibration.receive_us = calibration.time_us = monotonic_us();
    calibration.attributes = {{"name", "changed while paused"}};
    auto asset = connection;
    asset.kind = EventKind::Asset;
    asset.stream = "hand-rig";
    asset.receive_us = asset.time_us = monotonic_us();
    asset.attributes = {{"type", "pause-test"}};
    asset.payload.assign(32, 'P');
    require(!recorder.push(clock) && !recorder.push(calibration) && !recorder.push(asset),
            "Paused controls were written early");
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    require(recorder.status().active_duration_us == paused.active_duration_us &&
                recorder.status().accepted_events == paused.accepted_events,
            "The paused clock advanced or retained controls entered the writer");

    recorder.set_paused(false);
    require(recorder.status().recording && !recorder.status().paused && !recorder.status().failed,
            "Recording did not resume");
    const auto resumed_count = recorder.status().accepted_events;
    recorder.set_paused(false);
    require(recorder.status().accepted_events == resumed_count,
            "Repeated resume created another boundary");
    auto frame = [&](int sequence, const char* stream) {
        auto event = video(sequence, monotonic_us());
        event.stream = stream;
        event.epoch = 8;
        event.space_epoch = 2;
        return event;
    };
    require(!recorder.push(frame(21, "camera")) &&
                !recorder.push(frame(21, "camera-left")),
            "Resumed video accepted a broken prediction chain");
    const auto right_key = frame(40, "camera");
    require(recorder.push(right_key) && recorder.push(frame(41, "camera")) &&
                !recorder.push(frame(22, "camera-left")),
            "A resumed camera keyframe opened another camera's prediction chain");
    const auto left_key = frame(60, "camera-left");
    require(recorder.push(left_key), "The secondary camera did not resume at its keyframe");
    auto after = head(monotonic_us());
    after.epoch = 8;
    after.space_epoch = 2;
    put32(after.payload, 8, 8);
    put32(after.payload, 12, 2);
    require(recorder.push(after), "Resumed pose was rejected");
    require(recorder.add_episode("End of pause fixture"), "Final pause fixture marker failed");
    recorder.stop();
    const auto stopped = recorder.status();
    require(!stopped.recording && !stopped.paused && !stopped.failed &&
                stopped.active_duration_us > paused.active_duration_us &&
                stopped.written_events == stopped.accepted_events,
            "Resumed recording did not finish with its active duration");
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    require(recorder.status().active_duration_us == stopped.active_duration_us,
            "Stopped active duration continued advancing");

    ReplaySource replay(path);
    const auto poses = replay.pose_history(0, std::numeric_limits<int64_t>::max());
    require(poses.size() == 2 && poses[0].payload == before.payload &&
                poses[0].receive_us == before.receive_us && poses[0].time_us == before.time_us &&
                poses[1].payload == after.payload && poses[1].receive_us == after.receive_us &&
                poses[1].time_us == after.time_us,
            "Pause changed source observations or retained a paused pose");
    require(replay.episodes().size() == 1,
            "An episode created during the pause was retained");
    std::mutex mutex;
    std::condition_variable received;
    std::vector<SessionEvent> events;
    bool complete = false;
    replay.set_speed(16);
    replay.set_event_sink([&](const SessionEvent& event) {
        std::lock_guard lock(mutex);
        events.push_back(event);
        if (event.kind == EventKind::Episode &&
            event.attributes.value("name", std::string{}) == "End of pause fixture") {
            complete = true;
            received.notify_all();
        }
    });
    replay.start();
    {
        std::unique_lock lock(mutex);
        require(received.wait_for(lock, std::chrono::seconds(3), [&] { return complete; }),
                "Paused session did not replay through its final marker");
    }
    replay.stop();
    require(replay.snapshot().error.empty() && replay.snapshot().epoch == 8 &&
                replay.snapshot().space_epoch == 2 && replay.snapshot().camera.cameras.size() == 2 &&
                replay.snapshot().clock.valid && replay.snapshot().clock.rate == 1.2 / 16,
            "Resume lost the current stream, clock or reference space");
    size_t video_count = 0, pause_count = 0, resume_count = 0, descriptions = 0;
    bool restored_clock = false, restored_calibration = false, restored_asset = false;
    for (const auto& event : events) {
        const auto reason = event.attributes.value("reason", std::string{});
        pause_count += reason == "record-pause";
        resume_count += reason == "record-resume";
        if (event.kind == EventKind::Video) {
            ++video_count;
            require(event.sequence == 0 || event.sequence == 40 || event.sequence == 41 ||
                        event.sequence == 60,
                    "Paused video or an undecodable resumed frame reached replay");
            if (event.sequence == 40 || event.sequence == 60) {
                const auto& original = event.sequence == 40 ? right_key : left_key;
                require(event.payload == original.payload &&
                            event.attributes.at("recorded_receive_us") == original.receive_us &&
                            event.attributes.at("recorded_time_us") == original.time_us &&
                            event.attributes.at("pts_us") == original.attributes.at("pts_us"),
                        "Resuming changed encoded video or its source timestamps");
            }
        }
        if (event.kind == EventKind::Metadata && event.attributes.contains("pause_revision")) {
            ++descriptions;
            require(event.attributes.at("pause_revision") == 2 &&
                        event.attributes.at("recorded_receive_us") == description.receive_us &&
                        event.attributes.at("recorded_time_us") == description.time_us,
                    "Resume retained stale metadata or changed its timestamps");
        }
        if (event.kind == EventKind::Clock)
            restored_clock = event.attributes.at("recorded_receive_us") == clock.receive_us &&
                             event.attributes.at("rate") == 1.2 &&
                             event.attributes.at("offset_us") == 123.0;
        if (event.kind == EventKind::Calibration)
            restored_calibration = event.attributes.at("name") == "changed while paused" &&
                                   event.attributes.at("recorded_time_us") == calibration.time_us;
        if (event.kind == EventKind::Asset)
            restored_asset = event.payload == asset.payload &&
                             event.attributes.at("recorded_receive_us") == asset.receive_us;
    }
    require(video_count == 4 && pause_count == 1 && resume_count == 1 && descriptions == 1 &&
                restored_clock && restored_calibration && restored_asset,
            "Pause boundaries or retained controls were missing or duplicated");

    const auto paused_path = directory / "stop-while-paused.mcap";
    epoch.receive_us = epoch.time_us = monotonic_us();
    recorder.start(paused_path, {epoch});
    require(recorder.push(head(monotonic_us())), "Stop-paused fixture pose failed");
    recorder.set_paused(true);
    const auto final_pause = recorder.status();
    require(!recorder.push(head(monotonic_us())), "Stop-paused fixture captured a paused pose");
    recorder.stop();
    require(!recorder.status().failed && !recorder.status().paused &&
                recorder.status().active_duration_us == final_pause.active_duration_us &&
                std::filesystem::exists(paused_path) &&
                !std::filesystem::exists(paused_path.string() + ".partial"),
            "Stopping while paused did not finalise the session");
    ReplaySource stopped_paused(paused_path);
    require(stopped_paused.pose_history(0, std::numeric_limits<int64_t>::max()).size() == 1,
            "Stopping while paused added omitted observations");
}
void replay_space_tests(const std::filesystem::path& directory) {
    const auto pose = [](int64_t time, uint32_t epoch, uint32_t space) {
        auto event = head(time);
        event.epoch = epoch;
        event.space_epoch = space;
        put32(event.payload, 8, epoch);
        put32(event.payload, 12, space);
        return event;
    };
    const auto frame = [](int sequence, int64_t time, uint32_t epoch, uint32_t space) {
        auto event = video(sequence, time);
        event.epoch = epoch;
        event.space_epoch = space;
        event.attributes["head_pose"] = {0, 1.6, 0, 0, 0, 0, 1};
        return event;
    };
    SessionEvent initial;
    initial.kind = EventKind::Epoch;
    initial.receive_us = initial.time_us = 1000;
    initial.epoch = 7;
    initial.attributes = {{"reason", "record-start"}};
    const auto path = directory / "initial-space.mcap";
    Recorder recorder;
    recorder.start(path, {initial});
    require(recorder.push(pose(2000, 7, 1)) && recorder.push(frame(0, 3000, 7, 1)),
            "Initial reference-space observations were rejected");
    auto reset = initial;
    reset.receive_us = reset.time_us = 5000;
    reset.space_epoch = 2;
    reset.attributes = {{"reason", "reference-space"}};
    require(recorder.push(reset) && recorder.push(frame(1, 6500, 7, 2)) &&
                recorder.push(pose(7000, 7, 2)) && recorder.push(frame(2, 7500, 7, 2)),
            "Reference-space reset fixture was rejected");
    reset.receive_us = reset.time_us = 9000;
    reset.epoch = 8;
    reset.space_epoch = 0;
    reset.attributes = {{"reason", "connection"}};
    require(recorder.push(reset) && recorder.push(pose(10000, 8, 4)) &&
                recorder.push(frame(20, 11000, 8, 4)),
            "Connection-space fixture was rejected");
    recorder.stop();
    require(!recorder.status().failed, "Reference-space fixture recording failed");

    ReplaySource replay(path);
    replay.set_playing(false);
    std::mutex mutex;
    std::condition_variable received;
    uint64_t delivered_generation = 0, expected_generation = 0;
    ReceiverSnapshot restored;
    bool pose_adopted_before_video = false;
    replay.set_event_sink([&](const SessionEvent& event) {
        const auto snapshot = replay.snapshot();
        std::lock_guard lock(mutex);
        if (event.kind == EventKind::Pose && event.epoch == 7 && event.space_epoch == 1)
            pose_adopted_before_video =
                snapshot.epoch == 7 && snapshot.space_epoch == 1 && snapshot.poses[0].has_value();
        if (event.kind == EventKind::Video && !event.attributes.value("replay_preroll", false)) {
            delivered_generation = event.attributes.at("replay_generation").get<uint64_t>();
            restored = snapshot;
            received.notify_all();
        }
    });
    const auto seek = [&](int64_t target, uint32_t epoch, uint32_t space, bool head_present) {
        ++expected_generation;
        replay.seek(target);
        if (expected_generation == 1)
            replay.start();
        std::unique_lock lock(mutex);
        require(received.wait_for(lock, std::chrono::seconds(3),
                                  [&] { return delivered_generation == expected_generation; }),
                "Reference-space seek did not restore its final video");
        require(restored.epoch == epoch && restored.space_epoch == space &&
                    restored.poses[0].has_value() == head_present,
                "Replay observations retained or restored the wrong reference space");
        if (head_present)
            require(restored.poses[0]->epoch == epoch && restored.poses[0]->space_epoch == space,
                    "Replay retained a pose from another reference space");
    };
    seek(2000, 7, 1, true);
    require(pose_adopted_before_video,
            "The first valid pose did not replace stale record-start space");
    // The target is after the real reset but before a new video. The final old AU
    // must remain available for decoding without changing the restored space.
    seek(4500, 7, 2, false);
    seek(5500, 7, 2, false);
    seek(6500, 7, 2, true);
    seek(10000, 8, 4, true);
    seek(2000, 7, 1, true);
    replay.stop();
    require(replay.snapshot().error.empty(), "Reference-space replay failed");

    // Video can arrive before the first pose, and a stale non-zero initial space
    // is possible when asset preparation overlaps a real reference-space change.
    const auto video_path = directory / "video-first-space.mcap";
    initial.space_epoch = 3;
    Recorder video_recorder;
    video_recorder.start(video_path, {initial});
    require(video_recorder.push(frame(0, 2000, 7, 4)), "Video-first fixture was rejected");
    video_recorder.stop();
    require(!video_recorder.status().failed, "Video-first recording failed");
    ReplaySource video_replay(video_path);
    video_replay.set_playing(false);
    bool video_ready = false;
    video_replay.set_event_sink([&](const SessionEvent& event) {
        if (event.kind != EventKind::Video)
            return;
        const auto snapshot = video_replay.snapshot();
        std::lock_guard lock(mutex);
        restored = snapshot;
        video_ready = true;
        received.notify_all();
    });
    video_replay.seek(1000);
    video_replay.start();
    {
        std::unique_lock lock(mutex);
        require(received.wait_for(lock, std::chrono::seconds(3), [&] { return video_ready; }),
                "Video-first replay did not deliver a frame");
        require(restored.epoch == 7 && restored.space_epoch == 4 && !restored.poses[0],
                "Video headers did not replace stale initial space without inventing a pose");
    }
    video_replay.stop();
    std::cout << "Replay reference-space adoption, reset and seek checks passed\n";
}

void replay_camera_tests(const std::filesystem::path& directory) {
    std::ifstream fixture(std::filesystem::path(__FILE__).parent_path() / "fixtures" /
                          "bridge-cameras.json");
    const auto dual = Json::parse(fixture).at("description");
    constexpr int64_t origin = 1000000;
    SessionEvent metadata;
    metadata.kind = EventKind::Metadata;
    metadata.receive_us = metadata.time_us = origin;
    metadata.epoch = 7;
    metadata.attributes = dual;
    metadata.attributes["epoch"] = 7;
    const auto path = directory / "two-cameras.mcap";
    Recorder recorder;
    recorder.start(path, {metadata});
    auto frame = [&](bool left, int sequence, int64_t relative, uint32_t epoch = 7) {
        auto event = video(sequence, origin + relative);
        event.epoch = epoch;
        event.stream = left ? "passthrough_left" : "passthrough";
        event.attributes["camera_side"] = left ? "left" : "right";
        event.attributes["camera_mid"] = left ? "1" : "0";
        event.attributes["camera_primary"] = !left;
        event.attributes["video_time_domain"] = "receiver-arrival-anchored-rtp";
        event.attributes["sender_ntp_us"] = 3900000000000000ll + relative;
        event.attributes["capture_synchronised"] = false;
        require(recorder.push(event), "Dual camera frame was not recorded");
    };
    frame(false, 0, 1000);
    frame(true, 0, 1500);
    frame(false, 1, 2000);
    frame(true, 1, 2500);
    frame(false, 20, 3000);
    frame(true, 2, 3500);
    frame(false, 21, 4000);
    frame(true, 20, 4500);
    frame(false, 22, 5000);
    frame(true, 21, 5500);
    SessionEvent connection;
    connection.kind = EventKind::Epoch;
    connection.receive_us = connection.time_us = origin + 6000;
    connection.epoch = 8;
    connection.attributes = {{"reason", "connection"}};
    require(recorder.push(connection), "Connection reset was not recorded");
    metadata.receive_us = metadata.time_us = origin + 6100;
    metadata.epoch = 8;
    metadata.attributes["epoch"] = 8;
    metadata.attributes.erase("cameras");
    require(recorder.push(metadata), "Mono camera description was not recorded");
    frame(false, 0, 6200, 8);
    recorder.stop();
    require(!recorder.status().failed, "Dual camera recording failed");

    ReplaySource replay(path);
    replay.set_playing(false);
    std::mutex mutex;
    std::condition_variable delivered;
    std::vector<SessionEvent> frames;
    uint64_t generation = 0;
    replay.set_event_sink([&](const SessionEvent& event) {
        std::lock_guard lock(mutex);
        if (event.kind == EventKind::Epoch &&
            event.attributes.value("reason", std::string{}) == "seek") {
            frames.clear();
            generation = event.attributes.at("replay_generation");
        } else if (event.kind == EventKind::Video) {
            frames.push_back(event);
            delivered.notify_all();
        }
    });
    replay.start();
    auto seek = [&](int64_t target, size_t count) {
        uint64_t before;
        {
            std::lock_guard lock(mutex);
            before = generation;
        }
        replay.seek(target);
        std::unique_lock lock(mutex);
        require(delivered.wait_for(lock, std::chrono::seconds(2),
                                   [&] { return generation > before && frames.size() == count; }),
                "Both camera keyframe chains were not restored");
        return frames;
    };
    auto restored = seek(5000, 4);
    require(replay.snapshot().camera.cameras.size() == 2, "Replay lost the stereo description");
    std::vector<uint32_t> right, left;
    size_t displayed = 0;
    for (const auto& event : restored) {
        (event.stream == "passthrough" ? right : left).push_back(event.sequence);
        displayed += !event.attributes.at("replay_preroll").get<bool>();
        require(event.attributes.at("camera_mid") == (event.stream == "passthrough" ? "0" : "1") &&
                    event.attributes.at("sender_ntp_us").get<int64_t>() ==
                        3900000000000000ll + event.attributes.at("session_time_us").get<int64_t>(),
                "Replay changed recorded camera identity or source timing");
    }
    require(right == std::vector<uint32_t>{20, 21, 22} && left == std::vector<uint32_t>{20} &&
                displayed == 2,
            "Camera seek dependencies or final presentation frames were conflated");
    restored = seek(2500, 4);
    require(restored[0].sequence == 0 && restored[1].sequence == 0 && restored[2].sequence == 1 &&
                restored[3].sequence == 1,
            "Backward stereo seek did not restore both earlier keyframes");
    require(replay.step_frame(1) == 3000, "Frame stepping used the secondary camera cadence");
    restored = seek(6200, 1);
    require(restored[0].epoch == 8 && restored[0].stream == "passthrough" &&
                restored[0].sequence == 0 && replay.snapshot().camera.cameras.size() == 1,
            "Camera tracks or decode history leaked across connection epochs");
    replay.stop();
}
void replay_asset_tests(const std::filesystem::path& directory) {
    const auto path = directory / "asset-changes.mcap";
    SessionEvent epoch;
    epoch.kind = EventKind::Epoch;
    epoch.receive_us = epoch.time_us = 1000;
    epoch.epoch = 7;
    epoch.attributes = {{"reason", "connection"}};
    auto asset = epoch;
    asset.kind = EventKind::Asset;
    asset.stream = "headset-rig";
    asset.sequence = 10;
    asset.attributes = {{"type", "model-a"}};
    asset.payload.assign(256 * 1024, 'A');
    auto hand_asset = asset;
    hand_asset.stream = "hand-rig";
    hand_asset.sequence = 1;
    hand_asset.payload.assign(16 * 1024, 'H');
    auto calibration = epoch;
    calibration.kind = EventKind::Calibration;
    calibration.attributes = {{"name", "initial"}};
    Recorder recorder;
    recorder.start(path, {epoch, asset, hand_asset, calibration});
    require(recorder.push(head(2000)) && recorder.push(video(0, 5000)),
            "Asset fixture initial state was rejected");
    auto replacement = asset;
    replacement.receive_us = replacement.time_us = 11000;
    replacement.sequence = 20;
    replacement.attributes["type"] = "model-b";
    replacement.payload.assign(256 * 1024, 'B');
    require(recorder.push(replacement), "Asset fixture replacement was rejected");
    calibration.receive_us = calibration.time_us = 12000;
    calibration.attributes["name"] = "updated";
    require(recorder.push(calibration) && recorder.push(head(13000)) &&
                recorder.push(video(20, 15000)),
            "Asset fixture changed state was rejected");
    replacement = asset;
    replacement.receive_us = replacement.time_us = 21000;
    replacement.sequence = 30;
    require(recorder.push(replacement) && recorder.push(video(40, 25000)),
            "Asset fixture final state was rejected");
    recorder.stop();
    require(!recorder.status().failed, "Asset fixture recording failed");

    std::mutex mutex;
    std::condition_variable received;
    std::vector<uint32_t> headset_assets;
    int hand_assets = 0, frames = 0, final_sequence = -1, calibrations = 0, epochs = 0, poses = 0;
    bool block_reset = false, block_asset = false, blocked = false, release = false;
    bool barrier_timed_out = false;
    ReplaySource replay(path);
    replay.set_playing(false);
    EventSink sink = [&](const SessionEvent& event) {
        std::unique_lock lock(mutex);
        bool wait = false;
        if (event.kind == EventKind::Asset) {
            if (event.stream == "headset-rig") {
                headset_assets.push_back(event.sequence);
                if (block_asset && event.sequence == 20) {
                    block_asset = false;
                    wait = true;
                }
            } else if (event.stream == "hand-rig")
                ++hand_assets;
        }
        if (event.kind == EventKind::Calibration)
            ++calibrations;
        if (event.kind == EventKind::Pose)
            ++poses;
        if (event.kind == EventKind::Epoch) {
            ++epochs;
            if (block_reset && event.attributes.value("reason", std::string{}) == "seek") {
                block_reset = false;
                wait = true;
            }
        }
        if (event.kind == EventKind::Video && !event.attributes.value("replay_preroll", false)) {
            ++frames;
            final_sequence = int(event.sequence);
        }
        if (wait) {
            blocked = true;
            received.notify_all();
            if (!received.wait_for(lock, std::chrono::seconds(5), [&] { return release; }))
                barrier_timed_out = true;
        }
        received.notify_all();
    };
    replay.set_event_sink(sink);
    int expected_frames = 0;
    const auto await_frame = [&](int sequence) {
        ++expected_frames;
        std::unique_lock lock(mutex);
        require(received.wait_for(lock, std::chrono::seconds(3),
                                  [&] { return frames >= expected_frames; }),
                "Asset replay did not finish restoring its target frame");
        require(final_sequence == sequence && !barrier_timed_out,
                "Asset replay restored the wrong target or timed out at its cancellation barrier");
        require(replay.snapshot().error.empty(), "Asset replay reported an unexpected read error");
    };
    const auto seek = [&](int64_t time, int sequence) {
        replay.seek(time);
        await_frame(sequence);
    };
    replay.seek(4000);
    replay.start();
    await_frame(0);
    {
        std::lock_guard lock(mutex);
        require(headset_assets == std::vector<uint32_t>{10} && hand_assets == 1,
                "New replay source did not deliver both initial assets exactly once");
    }

    // Poison the already delivered asset's envelope on disk. A repeated seek must not
    // even reread that envelope, while all smaller state and video records still restore.
    const auto encoded_asset = encode_session_event(asset, 1000);
    std::ifstream input(path, std::ios::binary);
    std::vector<uint8_t> file_bytes(static_cast<size_t>(std::filesystem::file_size(path)));
    input.read(reinterpret_cast<char*>(file_bytes.data()), std::streamsize(file_bytes.size()));
    require(bool(input), "Cannot inspect the asset fixture");
    input.close();
    const auto location = std::search(file_bytes.begin(), file_bytes.end(), encoded_asset.begin(),
                                      encoded_asset.end());
    require(location != file_bytes.end(), "Cannot locate the initial asset envelope");
    const auto offset = std::streamoff(location - file_bytes.begin());
    const auto replace_magic = [&](char byte) {
        std::fstream file(path, std::ios::in | std::ios::out | std::ios::binary);
        file.seekp(offset);
        file.put(byte);
        file.flush();
        require(bool(file), "Cannot update the asset fixture read sentinel");
    };
    replace_magic('!');
    for (int i = 0; i < 3; ++i)
        seek(4000, 0);
    replace_magic('C');
    {
        std::lock_guard lock(mutex);
        require(headset_assets == std::vector<uint32_t>{10} && hand_assets == 1,
                "Repeated seeks delivered unchanged assets again");
        require(calibrations == 4 && poses == 4 && epochs == 8,
                "Asset deduplication skipped calibration, pose or epoch restoration");
    }
    seek(14000, 20);
    seek(4000, 0);
    seek(24000, 40);
    seek(24000, 40);
    {
        std::lock_guard lock(mutex);
        require(headset_assets == std::vector<uint32_t>({10, 20, 10, 30}) && hand_assets == 1,
                "A->B->A asset changes or independent stream identities were lost");
    }
    seek(4000, 0);
    size_t before_cancel;
    {
        std::lock_guard lock(mutex);
        before_cancel = headset_assets.size();
        block_reset = true;
        blocked = release = false;
    }
    const auto await_barrier = [&] {
        std::unique_lock lock(mutex);
        require(received.wait_for(lock, std::chrono::seconds(3), [&] { return blocked; }),
                "Asset cancellation barrier was not reached");
    };
    const auto release_barrier = [&] {
        {
            std::lock_guard lock(mutex);
            release = true;
        }
        received.notify_all();
    };
    replay.seek(14000);
    await_barrier();
    replay.seek(4000);
    release_barrier();
    await_frame(0);
    {
        std::lock_guard lock(mutex);
        require(headset_assets.size() == before_cancel,
                "A seek cancelled before asset delivery invalidated the installed identity");
        block_asset = true;
        blocked = release = false;
    }
    replay.seek(14000);
    await_barrier();
    replay.seek(4000);
    release_barrier();
    await_frame(0);
    {
        std::lock_guard lock(mutex);
        require(headset_assets.size() == before_cancel + 2 && headset_assets[before_cancel] == 20 &&
                    headset_assets.back() == 10,
                "A cancelled B callback left A cached while B was installed");
        before_cancel = headset_assets.size();
    }
    replay.stop();
    replay.start();
    await_frame(0);
    replay.set_event_sink(sink);
    await_frame(0);
    {
        std::lock_guard lock(mutex);
        require(headset_assets.size() == before_cancel + 2 && headset_assets.back() == 10 &&
                    hand_assets == 3,
                "Source restart or sink replacement failed to deliver its assets");
    }
    replay.stop();
    std::cout << "Replay asset identity, read skipping and seek cancellation tests passed\n";
}
#ifdef __linux__
constexpr int checkpoint_poses = 32;
struct ChildReport {
    uint64_t checkpoint_bytes = 0, written_events = 0;
    bool failed = false, recording = false, start_threw = false;
    char error[160]{};
};
void send_report(int descriptor, const ChildReport& report) {
    const auto* bytes = reinterpret_cast<const char*>(&report);
    size_t sent = 0;
    while (sent != sizeof(report)) {
        const auto count = ::write(descriptor, bytes + sent, sizeof(report) - sent);
        if (count < 0 && errno == EINTR)
            continue;
        require(count > 0, "Child could not report recorder state");
        sent += size_t(count);
    }
}
void limit_file_size(rlim_t bytes) {
    struct sigaction ignored {};
    ignored.sa_handler = SIG_IGN;
    sigemptyset(&ignored.sa_mask);
    require(sigaction(SIGXFSZ, &ignored, nullptr) == 0, "Cannot ignore SIGXFSZ");
    struct rlimit limit {};
    require(getrlimit(RLIMIT_FSIZE, &limit) == 0, "Cannot read the file size limit");
    limit.rlim_cur = bytes;
    require(setrlimit(RLIMIT_FSIZE, &limit) == 0, "Cannot set the file size limit");
}
int constructor_failure_child(const std::filesystem::path& path, int report_descriptor) {
    try {
        limit_file_size(0);
        ChildReport report;
        {
            Recorder recorder;
            try {
                recorder.start(path, {head(1000)});
            } catch (const std::exception& error) {
                report.start_threw = true;
                std::strncpy(report.error, error.what(), sizeof(report.error) - 1);
            }
            const auto status = recorder.status();
            report.written_events = status.written_events;
            report.recording = status.recording;
        }
        // Reporting after destruction proves both constructor unwind and cleanup completed.
        send_report(report_descriptor, report);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Recorder constructor child: " << error.what() << '\n';
        return 1;
    }
}
void durable_checkpoint(Recorder& recorder, const std::filesystem::path& path) {
    SessionEvent epoch;
    epoch.kind = EventKind::Epoch;
    epoch.epoch = 7;
    epoch.receive_us = epoch.time_us = 1000;
    recorder.start(path, {epoch}, {1024 * 1024, 2048, 10});
    for (int i = 0; i < checkpoint_poses; ++i)
        require(recorder.push(head(2000 + i * 1000)), "Child checkpoint pose was rejected");
    const auto partial = path.string() + ".partial";
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    for (;;) {
        require(!recorder.status().failed, "Recorder failed before its durable checkpoint");
        if (recorder.status().written_events == checkpoint_poses + 1) {
            try {
                ReplaySource snapshot(partial);
                if (snapshot.pose_history(0, std::numeric_limits<int64_t>::max()).size() ==
                    checkpoint_poses)
                    break;
            } catch (const std::exception&) {
                // A chunk can still be in flight while the checkpoint is written.
            }
        }
        require(std::chrono::steady_clock::now() < deadline,
                "Recorder did not expose its complete checkpoint");
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    // Synchronise the observed complete prefix before notifying the parent.
    const int descriptor = ::open(partial.c_str(), O_RDONLY);
    require(descriptor >= 0, "Cannot open the checkpoint for synchronisation");
    const int synced = ::fsync(descriptor);
    ::close(descriptor);
    require(synced == 0, "Could not make the observed checkpoint durable");
}
int recorder_child(int failure_kind, const std::filesystem::path& path, int report_descriptor) {
    try {
        ChildReport report;
        {
            Recorder recorder;
            durable_checkpoint(recorder, path);
            report.checkpoint_bytes = std::filesystem::file_size(path.string() + ".partial");
            if (!failure_kind) {
                send_report(report_descriptor, report);
                for (;;)
                    ::pause();
            }
            limit_file_size(report.checkpoint_bytes + (failure_kind == 1 ? 1024 : 16));
            auto input = failure_kind == 1 ? video(100, 40000) : head(40000);
            if (failure_kind == 1)
                input.payload.resize(64 * 1024, 0x5a);
            require(recorder.push(input), "Write-failure input was rejected before I/O");
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
            while (!recorder.status().failed) {
                require(std::chrono::steady_clock::now() < deadline,
                        "The file size limit did not become a recorder failure");
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
            recorder.stop();
            const auto status = recorder.status();
            report.written_events = status.written_events;
            report.failed = status.failed;
            report.recording = status.recording;
            std::strncpy(report.error, status.error.c_str(), sizeof(report.error) - 1);
        }
        // Reaching this report also verifies that failure cleanup did not terminate.
        send_report(report_descriptor, report);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Recorder child: " << error.what() << '\n';
        return 1;
    }
}
class RecorderChild {
  public:
    RecorderChild(const char* mode, const std::filesystem::path& path) {
        int descriptors[2];
        require(::pipe(descriptors) == 0, "Cannot create recorder child pipe");
        process_ = ::fork();
        if (process_ == 0) {
            ::close(descriptors[0]);
            const auto descriptor = std::to_string(descriptors[1]);
            ::execl("/proc/self/exe", "test_session", mode, path.c_str(), descriptor.c_str(),
                    static_cast<char*>(nullptr));
            ::_exit(127);
        }
        ::close(descriptors[1]);
        if (process_ < 0) {
            ::close(descriptors[0]);
            throw std::runtime_error("Cannot start recorder child");
        }
        descriptor_ = descriptors[0];
    }
    ~RecorderChild() {
        if (descriptor_ >= 0)
            ::close(descriptor_);
        if (process_ > 0) {
            ::kill(process_, SIGKILL);
            while (::waitpid(process_, nullptr, 0) < 0 && errno == EINTR) {
            }
        }
    }
    ChildReport report() const {
        ChildReport result;
        auto* bytes = reinterpret_cast<char*>(&result);
        size_t received = 0;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (received != sizeof(result)) {
            const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                                       deadline - std::chrono::steady_clock::now())
                                       .count();
            require(remaining > 0, "Recorder child report timed out");
            struct pollfd readable {
                descriptor_, POLLIN, 0
            };
            const int ready = ::poll(&readable, 1, int(remaining));
            if (ready < 0 && errno == EINTR)
                continue;
            require(ready > 0, "Recorder child did not report its checkpoint or failure");
            const auto count = ::read(descriptor_, bytes + received, sizeof(result) - received);
            if (count < 0 && errno == EINTR)
                continue;
            require(count > 0, "Recorder child terminated before reporting its state");
            received += size_t(count);
        }
        return result;
    }
    void kill() const {
        require(::kill(process_, SIGKILL) == 0, "Could not interrupt the recorder with SIGKILL");
    }
    int finish() {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        int status = 0;
        for (;;) {
            const auto result = ::waitpid(process_, &status, WNOHANG);
            if (result == process_) {
                process_ = -1;
                return status;
            }
            if (result < 0 && errno == EINTR)
                continue;
            require(result >= 0, "Could not collect the recorder child status");
            require(std::chrono::steady_clock::now() < deadline, "Recorder child did not exit");
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }

  private:
    pid_t process_ = -1;
    int descriptor_ = -1;
};
void verify_checkpoint_recovery(const std::filesystem::path& path) {
    const auto partial = std::filesystem::path(path.string() + ".partial");
    require(!std::filesystem::exists(path) && std::filesystem::exists(partial),
            "Interrupted recording did not retain its partial file");
    auto output = path;
    output.replace_extension("recovered.mcap");
    const auto recovered = recover_session(partial, output);
    require(recovered.truncated && recovered.recovered_events == checkpoint_poses + 1,
            "Recovery did not preserve exactly the durable completed events");
    ReplaySource replay(output);
    const auto poses = replay.pose_history(0, std::numeric_limits<int64_t>::max());
    require(poses.size() == checkpoint_poses, "Recovered checkpoint lost poses");
    for (int i = 0; i < checkpoint_poses; ++i) {
        const auto expected = head(2000 + i * 1000);
        require(poses[i].payload == expected.payload && poses[i].time_us == expected.time_us &&
                    poses[i].receive_us == expected.receive_us,
                "Recovery changed a completed observation or its source timestamps");
    }
    require(std::filesystem::exists(partial), "Recovery removed the interrupted source");
}
void process_failure_tests(const std::filesystem::path& directory) {
    const auto constructor_path = directory / "constructor-failure.mcap";
    RecorderChild constructor("--constructor-failure-child", constructor_path);
    const auto constructor_report = constructor.report();
    const int constructor_status = constructor.finish();
    require(WIFEXITED(constructor_status) && WEXITSTATUS(constructor_status) == 0,
            "Recorder constructor I/O failure terminated the child process");
    require(constructor_report.start_threw && !constructor_report.recording &&
                constructor_report.written_events == 0 &&
                std::string(constructor_report.error) == "Session flush failed",
            "Zero-byte limit did not reject the initial header/metadata output");
    require(!std::filesystem::exists(constructor_path) &&
                std::filesystem::exists(constructor_path.string() + ".partial") &&
                std::filesystem::file_size(constructor_path.string() + ".partial") == 0,
            "Constructor failure produced a completed recording or unexpected output bytes");
    std::cout
        << "Constructor header/metadata failure: exception caught without process termination\n";

    const auto verify_failure = [&](const char* mode, const char* name, const char* expected) {
        const auto failure_path = directory / name;
        RecorderChild failure(mode, failure_path);
        const auto reported = failure.report();
        const int failed_status = failure.finish();
        require(WIFEXITED(failed_status) && WEXITSTATUS(failed_status) == 0,
                "Recorder I/O failure terminated the child process");
        require(reported.failed && !reported.recording &&
                    reported.written_events >= checkpoint_poses + 1 &&
                    std::string(reported.error) == expected,
                "Actual file I/O failure did not become the expected recorder failure");
        require(std::filesystem::file_size(failure_path.string() + ".partial") >=
                    reported.checkpoint_bytes,
                "Write failure damaged the durable prefix");
        verify_checkpoint_recovery(failure_path);
        std::cout << expected << ": recovered " << checkpoint_poses + 1
                  << " durable events without process termination\n";
    };
    verify_failure("--write-failure-child", "disk-failure.mcap", "Session write failed");
    verify_failure("--flush-failure-child", "flush-failure.mcap", "Session flush failed");

    const auto killed_path = directory / "killed.mcap";
    RecorderChild killed("--kill-checkpoint-child", killed_path);
    require(killed.report().checkpoint_bytes > 0, "Killed child had no durable checkpoint");
    killed.kill();
    const int killed_status = killed.finish();
    require(WIFSIGNALED(killed_status) && WTERMSIG(killed_status) == SIGKILL,
            "Recorder process was not interrupted by SIGKILL");
    verify_checkpoint_recovery(killed_path);
    std::cout << "SIGKILL: recovered " << checkpoint_poses + 1 << " durable events\n";
}
#endif
} // namespace
int main(int argc, char** argv) {
#ifdef __linux__
    if (argc == 4 && std::string(argv[1]) == "--constructor-failure-child")
        return constructor_failure_child(argv[2], std::stoi(argv[3]));
    if (argc == 4 && (std::string(argv[1]) == "--write-failure-child" ||
                      std::string(argv[1]) == "--flush-failure-child" ||
                      std::string(argv[1]) == "--kill-checkpoint-child"))
        return recorder_child(std::string(argv[1]) == "--write-failure-child"   ? 1
                              : std::string(argv[1]) == "--flush-failure-child" ? 2
                                                                                : 0,
                              argv[2], std::stoi(argv[3]));
#else
    (void)argc;
    (void)argv;
#endif
    const auto directory = std::filesystem::temp_directory_path() /
                           ("ceres-session-test-" + std::to_string(monotonic_us()));
    try {
        std::filesystem::create_directories(directory);
#ifdef __linux__
        process_failure_tests(directory);
#endif
        replay_asset_tests(directory);
        replay_task_specification_tests(directory);
        replay_space_tests(directory);
        replay_camera_tests(directory);
        recorder_capture_window_tests(directory);
        recorder_task_restart_tests(directory);
        recorder_active_clock_tests(directory);
        recorder_pause_tests(directory);
        const auto input = video(2, 12000);
        const auto encoded = encode_session_event(input, 1000);
        const auto decoded = decode_session_event(encoded);
        require(decoded.payload == input.payload && decoded.attributes == input.attributes,
                "Binary event envelope did not round trip");
        bool rejected = false;
        try {
            decode_session_event(std::span(encoded).first(7));
        } catch (const std::exception&) {
            rejected = true;
        }
        require(rejected, "Truncated envelope was accepted");

        const auto path = directory / "recording.mcap";
        SessionEvent epoch;
        epoch.kind = EventKind::Epoch;
        epoch.epoch = 7;
        epoch.receive_us = epoch.time_us = 1000;
        epoch.attributes = {{"reason", "connection"}};
        SessionEvent calibration = epoch;
        calibration.kind = EventKind::Calibration;
        calibration.attributes = {{"name", "initial"}};
        Recorder recorder;
        recorder.start(path, {epoch, calibration}, {1024 * 1024, 2048, 20});
        int displayed = 0;
        for (int i = 0; i < 100; ++i) {
            require(recorder.push(video(i, 1000 + i * 5000)), "Recorder rejected input");
            if (i % 10 == 0)
                ++displayed;
            if (i == 2)
                require(recorder.push(head(11000)), "Pose recording failed");
            if (i == 10) {
                calibration.receive_us = calibration.time_us = 51000;
                calibration.attributes["name"] = "updated";
                require(recorder.push(calibration), "Calibration recording failed");
            }
        }
        recorder.stop();
        const auto status = recorder.status();
        require(!status.failed && status.written_events == 104, "Recorder lost events");
        require(status.duration_us == 495000, "Recorder duration differs from its last event");
        require(displayed == 10 && status.written_events > uint64_t(displayed),
                "Recording followed presentation drops");
        require(std::filesystem::exists(path) &&
                    !std::filesystem::exists(path.string() + ".partial"),
                "Session was not finalised");

        std::mutex mutex;
        std::condition_variable received;
        int final_sequence = -1;
        std::string calibration_name;
        uint64_t last_generation = 0;
        ReplaySource replay(path);
        require(replay.duration_us() == 495000, "Incorrect replay duration");
        replay.set_playing(false);
        replay.set_event_sink([&](const SessionEvent& event) {
            std::lock_guard lock(mutex);
            last_generation = event.attributes.value("replay_generation", uint64_t(0));
            if (event.kind == EventKind::Video && !event.attributes.value("replay_preroll", false))
                final_sequence = int(event.sequence);
            if (event.kind == EventKind::Calibration)
                calibration_name = event.attributes.value("name", "");
            received.notify_all();
        });
        replay.start();
        replay.seek(65000);
        {
            std::unique_lock lock(mutex);
            require(received.wait_for(lock, std::chrono::seconds(3),
                                      [&] { return final_sequence == 13; }),
                    "Seek did not decode through its target frame");
            require(calibration_name == "updated", "Seek did not restore calibration");
        }
        require(replay.snapshot().poses[0].has_value() &&
                    replay.snapshot().poses[0]->sequence == 77,
                "Seek did not restore the head pose in its correct slot");
        for (int i = 0; i < 30; ++i)
            replay.seek(i * 1000);
        replay.seek(420000);
        {
            std::unique_lock lock(mutex);
            require(received.wait_for(lock, std::chrono::seconds(3),
                                      [&] { return final_sequence == 84; }),
                    "Superseding seeks did not reach the last target");
            require(last_generation >= 32, "Seek cancellation generation was not advanced");
        }
        replay.set_speed(4);
        replay.set_playing(true);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        require(replay.position_us() == replay.duration_us(), "Timed playback did not advance");
        replay.stop();

        const auto partial = directory / "interrupted.mcap.partial";
        std::filesystem::copy_file(path, partial);
        std::ifstream scan(partial, std::ios::binary);
        scan.seekg(8);
        uint64_t final_chunk = 0;
        while (scan.good()) {
            const auto offset = uint64_t(scan.tellg());
            const int opcode = scan.get();
            if (opcode < 0)
                break;
            const uint64_t length = read64(scan);
            if (!scan || length > std::filesystem::file_size(partial))
                break;
            if (opcode == 6)
                final_chunk = offset;
            scan.seekg(std::streamoff(length), std::ios::cur);
        }
        scan.close();
        require(final_chunk > 0, "No MCAP chunk was written");
        std::filesystem::resize_file(partial, final_chunk + 20);
        const auto recovered = recover_session(partial, directory / "recovered.mcap");
        require(recovered.truncated && recovered.recovered_events > 0 &&
                    recovered.recovered_events < 104,
                "Partial chunk recovery did not preserve the complete prefix");
        require(std::filesystem::exists(partial), "Recovery changed the source file");
        ReplaySource recovered_replay(recovered.path);
        require(recovered_replay.duration_us() > 0, "Recovered session cannot be replayed");

        const auto history_path = directory / "history.mcap";
        auto later_sample = head(40000);
        later_sample.receive_us = 50000;
        auto earlier_sample = head(20000);
        earlier_sample.receive_us = 60000;
        SessionEvent episode_start;
        episode_start.kind = EventKind::Episode;
        episode_start.receive_us = episode_start.time_us = 15000;
        episode_start.attributes = {{"name", "Pick up"}, {"action", "start"}, {"start_us", 14000}};
        auto episode_stop = episode_start;
        episode_stop.receive_us = episode_stop.time_us = 70000;
        episode_stop.attributes = {
            {"name", "Pick up"}, {"action", "stop"}, {"start_us", 14000}, {"end_us", 69000}};
        Recorder history_recorder;
        history_recorder.start(history_path, {epoch, episode_start});
        require(history_recorder.push(later_sample) && history_recorder.push(earlier_sample) &&
                    history_recorder.push(episode_stop),
                "Inspection fixture recording failed");
        history_recorder.stop();
        ReplaySource history_replay(history_path);
        const auto markers = history_replay.episodes();
        require(markers.size() == 2 && markers[0].attributes.at("action") == "start" &&
                    markers[1].attributes.at("end_us") == 69000 &&
                    markers[0].attributes.at("session_receive_us") == 14000,
                "Recorded episode markers were not restored");
        const auto poses = history_replay.pose_history(19000, 39000);
        require(poses.size() == 2 && poses[0].time_us == 20000 && poses[1].time_us == 40000 &&
                    poses[0].payload == earlier_sample.payload &&
                    poses[1].payload == later_sample.payload,
                "Pose inspection did not preserve and sort raw observations by sample time");
        require(poses[0].attributes.at("session_time_us") == 19000 &&
                    poses[0].attributes.at("session_receive_us") == 59000 &&
                    poses[0].receive_us == 60000,
                "Inspection changed original timestamps or lost their session mapping");
        require(history_replay.pose_history(19000, 19000).size() == 1 &&
                    history_replay.pose_history(19001, 38999).empty() &&
                    history_replay.pose_history(50000, 10000).empty(),
                "Pose inspection range boundaries differ");
        require(history_replay.position_us() == 0 && history_replay.snapshot().received == 0,
                "Inspection mutated playback state");
        require(history_recorder.status().duration_us == history_replay.duration_us(),
                "Final recorder duration differs from reopened session duration");
        require(history_replay.step_frame(1) == 0 && !history_replay.playing(),
                "Frame stepping without video did not retain its position and pause");

        const auto step_path = directory / "variable-cadence.mcap";
        Recorder step_recorder;
        step_recorder.start(step_path, {epoch});
        const int64_t frame_times[] = {9000, 26000, 60000, 139000};
        for (int i = 0; i < 4; ++i) {
            auto frame = video(i, 1000 + frame_times[i]);
            frame.time_us -= 3000;
            require(step_recorder.push(frame), "Frame stepping fixture recording failed");
        }
        auto end_marker = episode_stop;
        end_marker.receive_us = end_marker.time_us = 200000;
        require(step_recorder.push(end_marker), "Frame stepping final marker failed");
        step_recorder.stop();
        ReplaySource step_replay(step_path);
        require(step_replay.step_frame(-1) == 9000 && !step_replay.playing(),
                "Previous frame did not clamp to the first video timestamp");
        require(step_replay.step_frame(1) == 26000 && step_replay.step_frame(1) == 60000 &&
                    step_replay.step_frame(-1) == 26000,
                "Frame stepping assumed a fixed cadence");
        step_replay.seek(30000);
        require(step_replay.step_frame(1) == 60000,
                "Next frame from a gap selected the wrong frame");
        step_replay.seek(30000);
        require(step_replay.step_frame(-1) == 26000,
                "Previous frame from a gap selected the wrong frame");
        step_replay.seek(step_replay.duration_us());
        require(step_replay.step_frame(1) == 139000 && step_replay.step_frame(1) == 139000,
                "Next frame did not clamp to the last video timestamp");
        step_replay.seek(0);
        require(step_replay.step_frame(-1) == 9000,
                "Frame stepping before video moved outside the frame index");
        step_replay.set_playing(true);
        require(step_replay.step_frame(1) == 26000 && !step_replay.playing(),
                "Frame stepping did not pause playback");
        rejected = false;
        try {
            step_replay.step_frame(0);
        } catch (const std::invalid_argument&) {
            rejected = true;
        }
        require(rejected && step_replay.position_us() == 26000,
                "Invalid frame direction changed playback");
        final_sequence = -1;
        last_generation = 0;
        step_replay.set_event_sink([&](const SessionEvent& event) {
            if (event.kind != EventKind::Video || event.attributes.value("replay_preroll", false))
                return;
            std::lock_guard lock(mutex);
            final_sequence = int(event.sequence);
            last_generation = event.attributes.value("replay_generation", uint64_t(0));
            received.notify_all();
        });
        step_replay.start();
        uint64_t starting_generation = 0;
        {
            std::unique_lock lock(mutex);
            require(received.wait_for(lock, std::chrono::seconds(3),
                                      [&] { return final_sequence == 1; }),
                    "Frame stepping did not restore the indexed target frame");
            starting_generation = last_generation;
        }
        for (int i = 0; i < 30; ++i)
            step_replay.step_frame(i % 2 ? -1 : 1);
        require(step_replay.step_frame(1) == 60000, "Rapid frame stepping lost the latest target");
        {
            std::unique_lock lock(mutex);
            require(received.wait_for(lock, std::chrono::seconds(3),
                                      [&] {
                                          return final_sequence == 2 &&
                                                 last_generation >= starting_generation + 31;
                                      }),
                    "Superseded frame steps did not preserve the final generation");
        }
        step_replay.stop();

        Recorder overflow;
        overflow.start(directory / "overflow.mcap", {}, {64, 1024, 1000});
        require(!overflow.push(video(0, monotonic_us())), "Oversized queue item was accepted");
        overflow.stop();
        require(overflow.status().failed && overflow.status().accepted_events == 0,
                "Storage backpressure did not report failure");
        require(directory.is_absolute() &&
                    std::filesystem::weakly_canonical(directory).parent_path() ==
                        std::filesystem::weakly_canonical(std::filesystem::temp_directory_path()) &&
                    directory.filename().string().starts_with("ceres-session-test-"),
                "Unexpected test cleanup path");
        std::filesystem::remove_all(directory);
        std::cout << "Session tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << "\nTest files: " << directory.string() << "\n";
        return 1;
    }
}
