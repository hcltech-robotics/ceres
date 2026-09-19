#include "ceres/detail/accordion_motion.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>

using ceres::detail::AccordionMotion;
namespace {
void check(bool value, const char* reason) {
    if (!value)
        throw std::runtime_error(reason);
}
void near(float actual, float expected, const char* reason) {
    check(std::abs(actual - expected) < .005f, reason);
}
void advance(AccordionMotion& motion, int requested, const std::array<float, 5>& heights,
             float available, float seconds, float frame = .01f) {
    while (seconds > .000001f) {
        const float step = std::min(seconds, frame);
        motion.update(requested, heights, available, step);
        seconds -= step;
        check(std::isfinite(motion.height()) && motion.height() >= 0.f &&
                  motion.height() <= available,
              "Every animation frame remains within the available height");
    }
}
void opening_and_closing() {
    AccordionMotion motion;
    const std::array<float, 5> heights{240.f, 180.f, 320.f, 120.f, 96.f};
    motion.update(-1, heights, 400.f, 0.f);
    check(motion.displayed() == -1 && motion.height() == 0.f && !motion.moving(),
          "No selection starts closed");
    motion.update(1, heights, 400.f, 0.f);
    check(motion.displayed() == 1 && motion.height() == 0.f && motion.moving(),
          "A new body expands from zero");
    advance(motion, 1, heights, 400.f, .08f, .04f);
    near(motion.height(), 180.f * .875f, "Opening uses cubic ease-out");
    advance(motion, 1, heights, 400.f, .08f, .04f);
    check(motion.height() == 180.f && !motion.moving(), "Opening settles after 160 ms");
    advance(motion, -1, heights, 400.f, .06f, .03f);
    check(motion.displayed() == 1, "Closing retains the displayed body");
    near(motion.height(), 180.f * .125f, "Closing uses cubic ease-out");
    advance(motion, -1, heights, 400.f, .06f, .03f);
    check(motion.displayed() == -1 && motion.height() == 0.f && !motion.moving(),
          "Closing settles after 120 ms");
}
void latest_selection_and_reversal() {
    AccordionMotion motion;
    const std::array<float, 5> heights{240.f, 180.f, 320.f, 120.f, 96.f};
    motion.update(0, heights, 400.f, 0.f, false);
    motion.update(1, heights, 400.f, .04f);
    check(motion.displayed() == 0 && motion.moving(), "The outgoing body closes first");
    motion.update(2, heights, 400.f, .04f);
    check(motion.displayed() == 0, "A newer selection does not replace a closing body");
    motion.update(2, heights, 400.f, .04f);
    check(motion.displayed() == 2 && motion.height() < .005f && motion.moving(),
          "The latest selection opens without showing an obsolete selection");
    advance(motion, 2, heights, 400.f, .16f);
    check(motion.height() == 320.f && !motion.moving(), "The latest body reaches its own height");

    motion.update(0, heights, 400.f, 0.f, false);
    motion.update(1, heights, 400.f, .04f);
    const float closing_height = motion.height();
    motion.update(0, heights, 400.f, 0.f);
    check(motion.displayed() == 0 && motion.height() == closing_height && motion.moving(),
          "Reselecting the outgoing body reverses without a height jump");
    motion.update(0, heights, 400.f, .04f);
    check(motion.height() > closing_height && motion.height() < 240.f,
          "A reversed body grows smoothly from its current height");
    const float opening_height = motion.height();
    motion.update(3, heights, 400.f, 0.f);
    check(motion.height() == opening_height, "Reversing an expansion is also continuous");
    advance(motion, 3, heights, 400.f, .28f);
    check(motion.displayed() == 3 && motion.height() == 120.f && !motion.moving(),
          "A reversed transition reaches the final selection");
}
void resize_and_measurement() {
    AccordionMotion motion;
    std::array<float, 5> heights{240.f, 180.f, 0.f, -1.f, 96.f};
    motion.update(0, heights, 400.f, 0.f, false);
    motion.update(0, heights, 0.f, 0.f);
    check(motion.displayed() == 0 && motion.height() == 0.f && !motion.moving(),
          "Zero available space keeps the selection without visible geometry");
    advance(motion, 0, heights, 100.f, .16f);
    check(motion.height() == 100.f, "Restoring space reopens the selected body");
    motion.update(0, heights, 40.f, 0.f);
    check(motion.height() == 40.f && !motion.moving(),
          "Shrinking space bounds the body immediately");
    advance(motion, 0, heights, 400.f, .16f);
    check(motion.height() == 240.f, "Growing space restores the natural height");

    motion.update(1, heights, 400.f, .04f);
    motion.update(1, heights, 30.f, 0.f);
    check(motion.displayed() == 0 && motion.height() == 30.f,
          "Resizing during collapse retains the outgoing body and respects the bound");
    advance(motion, 1, heights, 30.f, .28f);
    check(motion.displayed() == 1 && motion.height() == 30.f && !motion.moving(),
          "A resized transition reaches the requested body");

    motion.update(2, heights, 350.f, 0.f, false);
    check(motion.height() == 350.f, "An unmeasured body uses available space");
    heights[2] = 160.f;
    motion.update(2, heights, 350.f, 0.f);
    check(motion.height() == 350.f && motion.moving(),
          "Measuring content starts a continuous resize");
    advance(motion, 2, heights, 350.f, .12f);
    check(motion.height() == 160.f && !motion.moving(),
          "Measured content reaches its natural height");
    motion.update(3, heights, 350.f, 0.f, false);
    check(motion.height() == 350.f, "A negative measurement is treated as unknown");
}
void refresh_rates_and_invalid_input() {
    const std::array<float, 5> heights{240.f, 200.f, 320.f, 120.f, 96.f};
    for (const float rate : {24.f, 60.f, 144.f}) {
        AccordionMotion motion;
        motion.update(0, heights, 400.f, 0.f, false);
        advance(motion, 1, heights, 400.f, .22f, 1.f / rate);
        check(motion.displayed() == 1, "Refresh rate does not delay the body switch");
        near(motion.height(), 200.f * (1.f - .375f * .375f * .375f),
             "Transition progress is consistent across refresh rates");
        advance(motion, 1, heights, 400.f, .06f, 1.f / rate);
        check(motion.height() == 200.f && !motion.moving(),
              "All refresh rates complete the same transition in 280 ms");
    }

    AccordionMotion stalled, clamped;
    stalled.update(0, heights, 400.f, 10.f);
    clamped.update(0, heights, 400.f, .05f);
    near(stalled.height(), clamped.height(), "A long stall advances at most 50 ms");
    const float height = stalled.height();
    stalled.update(0, heights, 400.f, -1.f);
    stalled.update(0, heights, 400.f, std::numeric_limits<float>::quiet_NaN());
    stalled.update(0, heights, 400.f, std::numeric_limits<float>::infinity());
    check(stalled.height() == height, "Invalid elapsed time does not advance motion");
    stalled.update(2, heights, 250.f, 0.f, false);
    check(stalled.displayed() == 2 && stalled.height() == 250.f && !stalled.moving(),
          "Disabling animation snaps to the bounded requested body");
    stalled.update(4, heights, 400.f, 0.f, false);
    check(stalled.displayed() == 4 && stalled.height() == 96.f && !stalled.moving(),
          "The fifth section has independent measured content");
    stalled.update(9, heights, 400.f, 0.f, false);
    check(stalled.displayed() == -1 && stalled.height() == 0.f && !stalled.moving(),
          "An invalid section is treated as no selection");
    stalled.update(0, heights, std::numeric_limits<float>::quiet_NaN(), .02f);
    check(stalled.height() == 0.f && !stalled.moving(),
          "Invalid available space produces zero height");
    const std::array<float, 6> task_heights{240.f, 200.f, 180.f, 320.f, 120.f, 96.f};
    stalled.update(5, task_heights, 400.f, 0.f, false);
    check(stalled.displayed() == 5 && stalled.height() == 96.f,
          "Adding the Task section must leave Calibration accessible");
}
} // namespace
int main() {
    try {
        opening_and_closing();
        latest_selection_and_reversal();
        resize_and_measurement();
        refresh_rates_and_invalid_input();
        std::cout << "Accordion motion checks passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
