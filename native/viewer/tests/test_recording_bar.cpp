#include "ceres/detail/recording_bar.hpp"
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

using ceres::detail::HoldPress;
using ceres::detail::RateHistory;
namespace {
void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
HoldPress::Input press(double now, bool active, bool stop = true, bool hovered = true,
                       bool clicked = false) {
    return {now, clicked, active, hovered, true, stop, false};
}
void short_and_long_press() {
    using Action = HoldPress::Action;
    HoldPress button;
    check(button.update(press(0., true)) == Action::None && button.holding(),
          "A pointer press acted before release");
    check(button.update(press(.4, true)) == Action::None && button.progress() == .5f,
          "Hold progress did not use the elapsed gesture duration");
    check(button.update(press(.5, false, true, true, true)) == Action::Primary,
          "A short recording press did not pause on release");
    check(!button.holding() && button.progress() == 0.f,
          "A completed short press retained hold progress");
    button.update(press(1., true));
    check(button.update(press(1.79, true)) == Action::None,
          "A hold stopped recording before its threshold");
    check(button.update(press(1.8, true)) == Action::Stop && button.progress() == 1.f,
          "A sustained recording press did not stop at its threshold");
    check(button.update(press(2., true)) == Action::None &&
              button.update(press(2.1, false, true, true, true)) == Action::None,
          "A stop gesture repeated or activated pause on release");
    check(button.update(press(2.2, false, false, true, true)) == Action::Primary,
          "The next primary activation was suppressed after a completed hold");
    button.update(press(3., true, false));
    check(button.update(press(4., true, true)) == Action::None && button.progress() == 0.f,
          "Stop became armed midway through a gesture that began while idle");
    check(button.update(press(4.1, false, true, true, true)) == Action::Primary,
          "A long idle press did not preserve its primary action");
    button.update(press(5., true));
    check(button.update(press(5.9, false, true, true, true)) == Action::Stop &&
              button.update(press(6., false)) == Action::None,
          "A missed render frame turned a completed stop hold into a primary action");
    button.update(press(7., true));
    check(button.update(press(8., false)) == Action::None,
          "Losing activation manufactured a completed stop gesture");
}
void cancellation() {
    using Action = HoldPress::Action;
    for (int reason = 0; reason < 6; ++reason) {
        HoldPress button;
        button.update(press(10., true));
        auto cancelled = press(10.4, true);
        if (reason == 0)
            cancelled.hovered = false;
        else if (reason == 1)
            cancelled.enabled = false;
        else if (reason == 2)
            cancelled.cancel = true;
        else if (reason == 3)
            cancelled.stop_available = false;
        else if (reason == 4)
            cancelled.now = 9.;
        else
            cancelled.now = std::numeric_limits<double>::quiet_NaN();
        check(button.update(cancelled) == Action::None && button.progress() == 0.f,
              "Cancelling a gesture did not discard hold progress");
        check(button.update(press(12., true)) == Action::None &&
                  button.update(press(12.1, false, true, true, true)) == Action::None,
              "A cancelled gesture rearmed before release");
        button.update(press(13., true));
        check(button.update(press(13.1, false, true, true, true)) == Action::Primary,
              "A cancelled gesture disabled a subsequent short press");
    }
    HoldPress button;
    button.update(press(20., true));
    button.reset();
    check(button.update(press(21., true)) == Action::None &&
              button.update(press(21.1, false, true, true, true)) == Action::None,
          "Source reset allowed the old pending gesture to affect a new source");
    check(button.update(press(22., false, false, false, true)) == Action::Primary,
          "A direct keyboard activation required pointer hover");
    button.update(press(23., true));
    check(button.update(press(23.1, false, true, false, true)) == Action::None,
          "Releasing outside the cell performed its primary action");
}
void keyboard_press() {
    using Action = HoldPress::Action;
    HoldPress button;
    check(button.update(press(0., true, true, true, true)) == Action::None,
          "Keyboard activation performed a primary action on key-down");
    check(button.update(press(.3, true)) == Action::None &&
              button.update(press(.4, false)) == Action::Primary &&
              button.update(press(.5, false)) == Action::None,
          "A short keyboard gesture did not perform its primary action exactly once on release");
    button.update(press(1., true, true, true, true));
    check(button.update(press(1.8, true)) == Action::Stop &&
              button.update(press(1.9, true, true, true, true)) == Action::None &&
              button.update(press(2., false)) == Action::None,
          "A held keyboard gesture repeated its action or performed a primary action on release");
    button.update(press(3., true, true, true, true));
    check(button.update(press(3.9, false)) == Action::Stop &&
              button.update(press(4., false)) == Action::None,
          "A keyboard release lost its completed stop hold across a render-frame gap");
    button.update(press(5., true, true, true, true));
    check(button.update(press(5.4, true, true, false)) == Action::None &&
              button.update(press(5.5, false)) == Action::None,
          "Leaving a keyboard-active item retained its latched primary action");
    button.update(press(6., true, true, true, true));
    auto cancel = press(6.2, true);
    cancel.cancel = true;
    check(button.update(cancel) == Action::None &&
              button.update(press(6.4, false)) == Action::None,
          "Cancelling keyboard focus retained its latched primary action");
    button.update(press(7., true, true, true, true));
    auto disabled = press(7.2, true);
    disabled.enabled = false;
    check(button.update(disabled) == Action::None &&
              button.update(press(7.4, false)) == Action::None,
          "Disabling a keyboard-active item retained its latched primary action");
}
void rate_samples() {
    RateHistory<4> history;
    check(history.size() == 0 && history.maximum() == 0.f,
          "An empty chart contained fabricated observations");
    check(history.sample(10., 0.f) && history.size() == 1 && history.sample(0) == 0.f,
          "A valid zero-rate observation was discarded");
    check(!history.sample(10.5, 90.f) && !history.sample(10.9, 80.f),
          "The history sampled more than once per interval");
    check(history.sample(11., 72.f) && history.sample(12., 30.f) && history.sample(20., 120.f),
          "Real rate observations were not accepted at their cadence");
    check(history.size() == 4 && history.sample(0) == 0.f && history.sample(1) == 72.f &&
              history.sample(2) == 30.f && history.sample(3) == 120.f,
          "An observation gap was backfilled or samples lost chronological order");
    check(history.sample(21., 60.f) && history.size() == 4 && history.sample(0) == 72.f &&
              history.sample(3) == 60.f && history.maximum() == 120.f,
          "The bounded ring did not retain the latest observations in chronological order");
    check(!history.sample(22., -1.f) &&
              !history.sample(22., std::numeric_limits<float>::quiet_NaN()) &&
              !history.sample(std::numeric_limits<double>::infinity(), 60.f) &&
              !history.sample(22., 60.f, 0.),
          "An invalid observation changed chart history");
    check(history.sample(22., 0.f) && history.sample(3) == 0.f,
          "An invalid observation consumed the sampling interval");
    check(history.sample(1., 45.f) && history.size() == 1 && history.sample(0) == 45.f,
          "Backward time retained observations from a later source");
    history.reset();
    check(history.size() == 0 && history.maximum() == 0.f && history.sample(1., 0.f),
          "Reset did not remove prior-source samples and cadence");
}
void layout_bounds() {
    for (const float scale : {.25f, 1.f, 1.25f, 2.f, 4.f, 8.f}) {
        for (const float width : {.001f, 1.f, 80.f, 320.f, 736.f, 956.f, 1280.f, 3840.f}) {
            const auto cells = ceres::detail::recording_bar_widths(width, scale);
            float sum = 0.f;
            for (const float cell : cells) {
                check(std::isfinite(cell) && cell >= 0.f && cell <= width,
                      "The recording strip allocated a negative or overflowing cell");
                sum += cell;
            }
            check(sum == width, "The recording strip did not fill its exact available width");
        }
    }
    const auto normal = ceres::detail::recording_bar_widths(956.f);
    const auto doubled = ceres::detail::recording_bar_widths(1912.f, 2.f);
    for (std::size_t index = 0; index < normal.size(); ++index)
        check(doubled[index] == normal[index] * 2.f, "DPI scaling changed cell proportions");
    for (const float width : {-1.f, 0.f, std::numeric_limits<float>::infinity(),
                              std::numeric_limits<float>::quiet_NaN()}) {
        const auto cells = ceres::detail::recording_bar_widths(width);
        for (const float cell : cells)
            check(cell == 0.f, "An unavailable window width generated visible cells");
    }
}
} // namespace
int main() {
    try {
        short_and_long_press();
        cancellation();
        keyboard_press();
        rate_samples();
        layout_bounds();
        std::cout << "Recording hold gestures, rate history and responsive strip widths passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
