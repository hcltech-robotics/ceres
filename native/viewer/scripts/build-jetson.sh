#!/usr/bin/env bash
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
viewer_root=$(dirname -- "$script_dir")
build_dir="${BUILD_DIRECTORY:-$viewer_root/build-jetson}"
if [[ $(uname -m) != aarch64 ]] || [[ ! -r /etc/nv_tegra_release ]] ||
   ! grep -q '^# R36 ' /etc/nv_tegra_release; then
    printf '%s\n' 'This build requires Jetson Orin with JetPack 6 (Jetson Linux R36).' >&2
    exit 1
fi
api_root="${JETSON_API_ROOT:-/usr/src/jetson_multimedia_api}"
if [[ ! -f "$api_root/include/NvVideoDecoder.h" ]]; then
    printf '%s\n' 'Install nvidia-l4t-jetson-multimedia-api from the matching JetPack repository.' >&2
    exit 1
fi
cmake -S "$viewer_root" -B "$build_dir" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCERES_VIDEO_BACKEND=JETSON -DCMAKE_CUDA_ARCHITECTURES=87 \
    "-DCERES_JETSON_API_ROOT=$api_root" "$@"
cmake --build "$build_dir" --parallel "${BUILD_JOBS:-1}"
