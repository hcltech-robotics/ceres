#include "ceres/detail/stereo_cadence.hpp"
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>

using ceres::detail::StereoCadence;
namespace {
void check(bool value, const char* reason) {
    if (!value)
        throw std::runtime_error(reason);
}
void cadence_and_window() {
    StereoCadence cadence;
    auto window = cadence.update(1000000, 2.f);
    check(window.acquire && window.opened, "The first window opens immediately");
    window = cadence.update(1119999, 2.f);
    check(window.acquire && !window.opened, "The same window lasts at most 120 ms");
    check(!cadence.update(1120000, 2.f).acquire, "An unmatched window expires at 120 ms");
    check(!cadence.update(1499999, 2.f).acquire, "No frame leases are requested during cooldown");
    window = cadence.update(1500000, 2.f);
    check(window.acquire && window.opened, "A second window opens at the configured interval");
    cadence.finish();
    check(!cadence.update(1500000, 2.f).acquire,
          "A completed attempt cannot run twice in one window");
    check(!cadence.update(1999999, 2.f).acquire, "Submitting early retains the remaining cooldown");
    check(cadence.update(2000000, 2.f).opened, "Early completion preserves the requested cadence");
}
void slow_frames_and_rate_changes() {
    StereoCadence cadence;
    cadence.update(0, 2.f);
    cadence.finish();
    auto window = cadence.update(9750000, 2.f);
    check(window.acquire && window.opened, "A stalled caller opens one current window");
    cadence.finish();
    check(!cadence.update(9750000, 2.f).acquire, "Missed intervals do not cause catch-up bursts");
    check(!cadence.update(10000000, 2.f).acquire, "A late window starts its own full cooldown");
    check(cadence.update(10250000, 2.f).opened, "The cadence resumes from the late window");

    cadence.reset();
    cadence.update(0, 2.f);
    window = cadence.update(80000, 5.f);
    check(window.acquire && !window.opened, "A rate change does not restart an open window");
    check(!cadence.update(120000, 5.f).acquire, "Changing rate does not extend the lease window");
    check(cadence.update(200000, 5.f).opened, "A faster rate adjusts the next acquisition");
    cadence.finish();
    check(!cadence.update(300000, .2f).acquire, "A slower rate extends cooldown without a burst");
    check(!cadence.update(5199999, .2f).acquire, "The lower rate preserves a five-second interval");
    check(cadence.update(5200000, .2f).opened, "The slowest supported rate eventually opens");
    cadence.finish();
    check(cadence.update(5500000, 5.f).opened, "A newly overdue faster rate opens once");
    cadence.finish();
    check(!cadence.update(5500000, 5.f).acquire, "Rate changes cannot replay overdue windows");
}
void inactive_rollback_and_bounds() {
    StereoCadence cadence;
    cadence.update(1000000, 2.f);
    check(!cadence.update(1050000, 2.f, false).acquire,
          "Inactive stereo immediately stops acquisition");
    check(!cadence.update(5000000, 2.f, false).opened, "Inactive updates cannot open a window");
    check(cadence.update(5000001, 2.f).opened, "Re-enabling opens a fresh window");
    auto window = cadence.update(4000000, 2.f);
    check(window.acquire && window.opened, "Clock rollback replaces the previous window");
    cadence.finish();
    check(!cadence.update(4499999, 2.f).acquire, "Rollback still imposes a full cooldown");
    check(cadence.update(4500000, 2.f).opened, "Acquisition recovers after clock rollback");

    cadence.reset();
    cadence.update(0, std::numeric_limits<float>::quiet_NaN());
    cadence.finish();
    check(!cadence.update(499999, std::numeric_limits<float>::quiet_NaN()).acquire,
          "A non-finite rate uses the two Hz default");
    check(cadence.update(500000, std::numeric_limits<float>::quiet_NaN()).opened,
          "The default rate remains usable after invalid input");
    cadence.reset();
    cadence.update(-100, 100.f);
    cadence.finish();
    check(!cadence.update(199999, 100.f).acquire, "Rates above five Hz are bounded");
    check(cadence.update(200000, 100.f).opened, "Negative clock values are bounded at zero");
}
void caller_releases_leases() {
    StereoCadence cadence;
    std::shared_ptr<int> queued;
    std::weak_ptr<int> lease;
    const auto poll = [&](int64_t now) {
        const auto window = cadence.update(now, 2.f);
        if (!window.acquire || window.opened)
            queued.reset();
        if (window.acquire && !queued) {
            queued = std::make_shared<int>(1);
            lease = queued;
        }
        return window;
    };
    poll(0);
    check(!lease.expired(), "An active acquisition may retain a frame lease");
    poll(120000);
    check(lease.expired(), "An unmatched frame lease is released when its window expires");
    poll(500000);
    cadence.finish();
    poll(500001);
    check(lease.expired(), "Finishing an attempt releases queued leases throughout cooldown");
    poll(1000000);
    const auto obsolete = lease;
    check(poll(2000000).opened && obsolete.expired(),
          "A stalled caller releases the obsolete window before acquiring another frame");
}
} // namespace
int main() {
    try {
        cadence_and_window();
        slow_frames_and_rate_changes();
        inactive_rollback_and_bounds();
        caller_releases_leases();
        std::cout << "Stereo cadence checks passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
