#include "ceres/detail/video_queue.hpp"
#include <chrono>
#include <future>
#include <iostream>
#include <stdexcept>

namespace {
using ceres::detail::VideoQueue;
using Result = VideoQueue::Result;
using namespace std::chrono_literals;

void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
ceres::SessionEvent frame(uint32_t sequence, std::optional<uint64_t> generation = std::nullopt,
                          size_t bytes = 8) {
    ceres::SessionEvent event;
    event.kind = ceres::EventKind::Video;
    event.sequence = sequence;
    event.keyframe = sequence == 1;
    event.payload.resize(bytes, uint8_t(sequence));
    if (generation)
        event.attributes["replay_generation"] = *generation;
    return event;
}
ceres::SessionEvent epoch(uint64_t generation) {
    ceres::SessionEvent event;
    event.kind = ceres::EventKind::Epoch;
    event.attributes = {{"replay_generation", generation}, {"reset_decoder", true}};
    return event;
}
VideoQueue::Item take(VideoQueue& queue) {
    check(queue.state().queued != 0, "Expected a queued decoder item");
    auto item = queue.pop();
    check(item.has_value(), "Decoder queue unexpectedly closed");
    return std::move(*item);
}
Result finish(std::future<Result>& future, VideoQueue& queue) {
    const bool ready = future.wait_for(2s) == std::future_status::ready;
    if (!ready)
        queue.close();
    check(ready, "Blocked decoder producer was not woken");
    return future.get();
}
void full_replay(VideoQueue& queue, uint64_t generation) {
    check(queue.push(epoch(generation)) == Result::Accepted, "Replay epoch rejected");
    check(take(queue).event.kind == ceres::EventKind::Epoch, "Replay reset missing");
    check(queue.push(frame(1, generation)) == Result::Accepted, "Replay IDR rejected");
    check(queue.push(frame(2, generation)) == Result::Accepted, "Replay dependent frame rejected");
}
} // namespace

int main() {
    try {
        {
            VideoQueue queue(2, 16);
            full_replay(queue, 1);
            auto producer = std::async(std::launch::async, [&] { return queue.push(frame(3, 1)); });
            const bool waited = producer.wait_for(40ms) == std::future_status::timeout;
            if (!waited)
                queue.close();
            check(waited && queue.state().queued == 2, "Replay did not respect queue capacity");
            check(take(queue).event.sequence == 1, "Replay IDR was discarded under pressure");
            check(finish(producer, queue) == Result::Accepted,
                  "Replay producer failed after capacity became available");
            check(take(queue).event.sequence == 2 && take(queue).event.sequence == 3,
                  "Replay changed compressed frame order");
            check(queue.state().dropped == 0, "Replay frames were dropped under pressure");
        }
        {
            VideoQueue queue(2, 16);
            full_replay(queue, 8);
            const auto old_revision = queue.state().revision;
            auto producer = std::async(std::launch::async, [&] { return queue.push(frame(3, 8)); });
            producer.wait_for(40ms);
            queue.cancel_replay();
            check(finish(producer, queue) == Result::Cancelled,
                  "Seek did not cancel a blocked replay producer");
            check(!queue.current(old_revision), "Seek left an in-flight decoded image publishable");
            check(queue.push(frame(4, 8)) == Result::Cancelled,
                  "Cancelled seek admitted an old frame");
            check(queue.push(epoch(9)) == Result::Accepted, "New seek generation rejected");
            take(queue);
            check(queue.push(frame(1, 9)) == Result::Accepted, "New seek IDR rejected");
            check(queue.push(epoch(8)) == Result::Cancelled, "Late old epoch reset the new seek");
            check(take(queue).event.sequence == 1, "Old epoch erased the current seek frame");
            queue.cancel_replay();
            queue.begin_source();
            take(queue);
            check(queue.push(epoch(0)) == Result::Accepted,
                  "A new source could not restart its replay generation");
            take(queue);
            check(queue.push(frame(1, 0)) == Result::Accepted, "New source IDR rejected");
        }
        {
            VideoQueue queue(2, 16);
            full_replay(queue, 3);
            auto producer = std::async(std::launch::async, [&] { return queue.push(frame(3, 3)); });
            producer.wait_for(40ms);
            queue.close();
            check(finish(producer, queue) == Result::Closed,
                  "Decoder failure did not wake a blocked producer");
            check(!queue.pop(), "Closed decoder queue still delivered work");
            queue.begin_source();
            check(queue.push(frame(1)) == Result::Closed,
                  "Source switch reopened a failed consumer");
        }
        {
            VideoQueue queue(2, 16);
            check(queue.push(frame(1)) == Result::Accepted, "Live IDR rejected");
            const auto revision = queue.state().revision;
            queue.accepted_keyframe(revision);
            ceres::SessionEvent reference;
            reference.kind = ceres::EventKind::Epoch;
            reference.attributes = {{"reason", "reference-space"}};
            check(queue.push(reference) == Result::Ignored && queue.current(revision),
                  "Reference-space change invalidated video prediction");
            check(!queue.state().needs_keyframe && take(queue).event.sequence == 1,
                  "Reference-space change lost the live frame");
            reference.attributes["reset_decoder"] = true;
            check(queue.push(reference) == Result::Accepted && !queue.current(revision),
                  "Explicit decoder reset was ignored");
            check(queue.state().needs_keyframe, "Decoder reset did not request an IDR");
            take(queue);
            queue.push(frame(1));
            queue.push(frame(2));
            check(queue.push(frame(3)) == Result::Ignored,
                  "Live overflow retained a broken prediction chain");
            check(queue.state().dropped == 3 && queue.state().needs_keyframe,
                  "Live overflow did not account for discarded frames or request an IDR");
            check(take(queue).event.kind == ceres::EventKind::Epoch,
                  "Live overflow did not reset the decoder");
            check(queue.push(frame(1)) == Result::Accepted, "Live recovery IDR rejected");
            const auto recovery = take(queue);
            queue.accepted_keyframe(recovery.revision);
            check(!queue.state().needs_keyframe, "Live recovery left the IDR request active");
            queue.reset_after_error(recovery.revision);
            queue.accepted_keyframe(recovery.revision);
            check(queue.state().needs_keyframe, "A stale completion cleared the new IDR request");
        }
        {
            VideoQueue queue(10, 16);
            queue.push(epoch(2));
            take(queue);
            queue.push(frame(1, 2, 16));
            auto producer =
                std::async(std::launch::async, [&] { return queue.push(frame(2, 2, 1)); });
            const bool waited = producer.wait_for(40ms) == std::future_status::timeout;
            if (!waited)
                queue.close();
            check(waited, "Replay byte capacity was ignored");
            take(queue);
            check(finish(producer, queue) == Result::Accepted,
                  "Byte capacity did not wake replay producer");
            take(queue);
            check(queue.push(frame(3, 2, 17)) == Result::TooLarge,
                  "Oversized frame entered the queue");
        }
        {
            VideoQueue queue;
            check(!queue.pop_for(1ms) && !queue.state().closed,
                  "An idle hardware poll closed the input queue");
            auto consumer = std::async(std::launch::async, [&] { return queue.pop_for(5s); });
            queue.cancel_replay();
            check(consumer.wait_for(200ms) == std::future_status::ready,
                  "Cancellation did not wake the hardware poll");
            check(consumer.get()->event.kind == ceres::EventKind::Epoch,
                  "Cancellation did not deliver a decoder reset");
            queue.close();
            check(!queue.pop_for(5s) && queue.state().closed,
                  "Closed asynchronous queue did not finish immediately");
        }
        std::cout << "Video queue tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
