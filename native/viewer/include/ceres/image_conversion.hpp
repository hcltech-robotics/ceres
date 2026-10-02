#pragma once
struct ImageConversion {
    int width, height, full_range, bt709, undistort, flip_x, flip_y;
    float fx, fy, cx, cy;
    float distortion[5];
};
