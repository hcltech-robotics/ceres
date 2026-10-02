#include "ceres/detail/h264_sample.hpp"
#include <iostream>
#include <stdexcept>
using namespace ceres::detail;
void require(bool value) {
    if (!value)
        throw std::runtime_error("H.264 sample assertion failed");
}
int main() {
    try {
        const std::vector<uint8_t> input{0, 0,    0,    1, 0x67, 0x42, 0, 0x80, 0,    0,
                                         1, 0x68, 0x12, 0, 0,    0,    1, 0x09, 0xf0, 0,
                                         0, 1,    0x65, 0, 0,    3,    1, 0x80, 0,    0};
        auto sample = h264_sample(input);
        require(sample.idr && sample.has_picture);
        require(sample.sps == std::vector<uint8_t>({0x67, 0x42, 0, 0x80}));
        require(sample.pps == std::vector<uint8_t>({0x68, 0x12}));
        require(sample.bytes == std::vector<uint8_t>({0, 0, 0, 6, 0x65, 0, 0, 3, 1, 0x80}));
        sample = h264_sample(std::vector<uint8_t>{0, 0, 1, 0x41, 0x80});
        require(!sample.idr && sample.sps.empty() && sample.pps.empty());
        for (const auto& invalid : std::vector<std::vector<uint8_t>>{
                 {}, {1, 2, 3}, {0, 0, 1}, {0, 0, 1, 0xe5, 0x80}, {0, 0, 1, 0x09, 0xf0}}) {
            bool rejected = false;
            try {
                (void)h264_sample(invalid);
            } catch (const std::runtime_error&) {
                rejected = true;
            }
            require(rejected);
        }
        std::cout << "Annex B framing and AVCC conversion passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
