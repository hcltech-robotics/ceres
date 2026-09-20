#include "ceres/detail/tracking_visibility.hpp"
#include <cmath>
#include <iostream>
#include <stdexcept>

using ceres::detail::TrackingVisibility;
namespace {
void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
bool close(float a, float b) {
    return std::abs(a - b) < 1e-5f;
}
void lifecycle() {
    TrackingVisibility visible;
    check(visible.update(0, false, 1, 2) == 0 && !visible.retained(),
          "Invalid initial tracking manufactured geometry");
    check(visible.update(1000, true, 1, 2) == 1 && visible.retained(),
          "Initial tracking did not appear");
    check(visible.update(51000, false, 1, 2) == 1 && visible.update(201000, false, 1, 2) == 1,
          "Brief tracking gap flickered during its grace period");
    check(close(visible.update(701000, false, 1, 2), .5f),
          "Tracking fade did not follow the bounded smooth curve");
    check(visible.update(1200999, false, 1, 2) < .0001f && visible.retained(),
          "Tracking faded outside its hold budget");
    check(visible.update(1201000, false, 1, 2) == 0 && !visible.retained(),
          "Tracking geometry survived its two-hundred millisecond hold and one-second fade");
    check(close(visible.update(2000000, true, 1, 2), .16f) && visible.retained(),
          "Reacquired tracking was invisible on its first frame");
    check(close(visible.update(2040000, true, 1, 2), .58f) &&
              visible.update(2080000, true, 1, 2) == 1,
          "Tracking recovery did not finish smoothly in eighty milliseconds");
}
void intermittent() {
    TrackingVisibility visible;
    visible.update(0, true, 1, 1);
    const auto lost = visible.update(700000, false, 1, 1);
    check(close(lost, .5f), "Intermittent fade setup failed");
    check(visible.update(740000, true, 1, 1) == lost,
          "Reacquisition changed alpha at its transition boundary");
    const auto recovered = visible.update(780000, true, 1, 1);
    check(close(recovered, .75f), "Partial recovery did not interpolate from held alpha");
    check(visible.update(790000, false, 1, 1) == recovered &&
              visible.update(840000, false, 1, 1) == recovered,
          "Repeated tracking loss brightened or flickered the held geometry");
    check(visible.update(840000, true, 1, 1) == recovered &&
              visible.update(920000, true, 1, 1) == 1,
          "Intermittent recovery did not reach full opacity");
    for (int64_t t = 930000; t <= 990000; t += 10000)
        check(visible.update(t, t % 20000 == 0, 1, 1) == 1,
              "Short alternating tracking loss flickered");
}
void context_and_clock() {
    TrackingVisibility visible;
    visible.update(1000000, true, 1, 1);
    visible.update(1400000, false, 1, 1);
    const auto frozen = visible.alpha();
    for (int i = 0; i < 100; ++i)
        check(visible.update(1400000, false, 1, 1) == frozen,
              "Paused presentation clock continued fading");
    check(visible.update(1400001, false, 2, 1) == 0 && !visible.retained(),
          "Tracking appearance leaked across connection epochs");
    visible.update(1500000, true, 2, 1);
    check(visible.update(1500001, false, 2, 2) == 0 && !visible.retained(),
          "Tracking appearance leaked across reference spaces");
    visible.update(2000000, true, 2, 2);
    check(visible.update(1900000, false, 2, 2) == 0 && !visible.retained(),
          "Backward time retained later tracking geometry");
    visible.update(2000000, true, 2, 2);
    check(visible.update(-1, true, 2, 2) == 0 && !visible.retained(),
          "Invalid presentation time created visibility");
    visible.update(3000000, true, 2, 2);
    visible.reset();
    check(visible.alpha() == 0 && !visible.retained(), "Explicit source reset retained visibility");
}
void headset_hold() {
    TrackingVisibility visible;
    const auto hold = TrackingVisibility::LossPolicy::Hold;
    check(visible.update(0, false, 1, 1, hold) == 0 && !visible.retained(),
          "Unobserved headset manufactured a held pose");
    check(visible.update(1000, true, 1, 1, hold) == 1 && visible.retained(),
          "Tracked headset did not appear");
    for (const int64_t time : {51000LL, 1001000LL, 5000000LL, 3600000000LL})
        check(visible.update(time, false, 1, 1, hold) == 1 && visible.retained(),
              "Headset tracking loss expired or faded the last observed pose");
    check(visible.update(3600001000LL, true, 1, 1, hold) == 1 && visible.retained(),
          "Headset recovery changed visibility");
    check(visible.update(3600002000LL, false, 1, 1, hold) == 1 && visible.retained(),
          "Repeated headset loss discarded the recovered pose");
    check(visible.update(3600003000LL, false, 2, 1, hold) == 0 && !visible.retained(),
          "Held headset crossed a connection epoch");
    visible.update(3600004000LL, true, 2, 1, hold);
    check(visible.update(3600005000LL, false, 2, 2, hold) == 0 && !visible.retained(),
          "Held headset crossed a reference-space reset");
    visible.update(3600006000LL, true, 2, 2, hold);
    check(visible.update(1000, false, 2, 2, hold) == 0 && !visible.retained(),
          "Backward seek retained a future headset pose");
    visible.update(2000, true, 2, 2, hold);
    visible.reset();
    check(visible.update(3000, false, 2, 2, hold) == 0 && !visible.retained(),
          "Explicit source reset retained a headset pose");
}
} // namespace
int main() {
    try {
        lifecycle();
        intermittent();
        context_and_clock();
        headset_hold();
        std::cout << "Tracking grace, headset hold, recovery and context resets passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
