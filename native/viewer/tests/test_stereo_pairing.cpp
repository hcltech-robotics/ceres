#include "ceres/detail/stereo_pairing.hpp"
#include <iostream>
#include <stdexcept>
using namespace ceres;
void check(bool value, const char* reason) {
    if (!value)
        throw std::runtime_error(reason);
}
SessionEvent sample(const char* side, int64_t stamp, uint32_t sequence = 0) {
    SessionEvent e;
    e.kind = EventKind::Video;
    e.epoch = e.space_epoch = 1;
    e.sequence = sequence;
    e.attributes = {{"camera_side", side}, {"sender_ntp_us", stamp}};
    return e;
}
int main() {
    try {
        detail::StereoPairQueue<int> q;
        auto left = sample("left", 1000000), right = sample("right", 1004000);
        left.rtp_timestamp = 0xfffffff0;
        right.rtp_timestamp = 500;
        left.time_us = 9000000;
        right.time_us = 8000000;
        check(q.push(1, left) && q.push(2, right), "Independent RTP origins accepted");
        auto pair = q.take(8000);
        check(pair && pair->left == 1 && pair->right == 2 && pair->skew_us == 4000,
              "Pairs on sender clock, independent of arrival anchors");
        check(!q.push(3, left) && !q.take(8000), "Cannot reuse a source image");
        q.clear();
        left.attributes.erase("sender_ntp_us");
        check(!q.push(1, left), "No arrival-time fallback");
        q.push(1, sample("left", 1000000));
        q.push(2, sample("right", 1033333));
        check(!q.take(8000), "Reject excessive source skew");
        q.push(3, sample("left", 1035000, 1));
        pair = q.take(8000);
        check(pair && pair->left == 3 && pair->right == 2, "Nearest unused observation wins");
        q.clear();
        q.push(1, sample("left", 1000000));
        right = sample("right", 1000000);
        right.space_epoch = 2;
        q.push(2, right);
        check(!q.take(8000), "No cross-reference-space pairing");
        q.clear();
        q.push(1, sample("left", 1000000));
        right = sample("right", 1000000);
        right.attributes["replay_generation"] = 2;
        q.push(2, right);
        check(!q.take(8000), "No cross-seek pairing");
        q.clear();
        q.push(1, sample("left", 1000000, 0xffffffffu));
        check(q.push(2, sample("left", 1033333, 0)), "Sequence wrap");
        check(!q.push(3, sample("left", 1030000, 1)), "Clock regression rejected");
        for (uint32_t i = 1; i < 1000; ++i)
            q.push(int(i), sample("left", 1033333 + i * 33333, i));
        check(q.queued() <= q.capacity, "Bounded history with one camera absent");
        q.clear();
        q.push(1, sample("left", 1000000));
        q.push(2, sample("right", 999000));
        q.push(3, sample("right", 1001000, 1));
        pair = q.take(1000);
        check(pair && pair->right == 2, "Equal distance selects earlier source image");
        std::cout << "Stereo pairing checks passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
