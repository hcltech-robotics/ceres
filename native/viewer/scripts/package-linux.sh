#!/usr/bin/env bash
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
viewer_root=$(dirname -- "$script_dir")
build_dir="${BUILD_DIRECTORY:-$viewer_root/build-native}"
output_dir="${OUTPUT_DIRECTORY:-$viewer_root/dist}"
platform="${PACKAGE_PLATFORM:-}"
if [[ -z "$platform" ]]; then
    if grep -q '^CERES_SELECTED_VIDEO_BACKEND:INTERNAL=JETSON$' "$build_dir/CMakeCache.txt"; then
        platform=linux-arm64-jetpack6
    elif [[ $(uname -m) == aarch64 ]]; then
        platform=linux-arm64
    else
        platform=linux-x64
    fi
fi
version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$viewer_root/../../package.json")
package_name="${PACKAGE_NAME:-ceres-viewer-$version-$platform}"
ffmpeg_root="${FFMPEG_ROOT:?Set FFMPEG_ROOT to the FFmpeg distribution directory}"
if [[ ! "$package_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]+$ ]]; then
    printf '%s\n' 'PACKAGE_NAME must be a directory name' >&2
    exit 1
fi
mkdir -p -- "$output_dir"
output_dir=$(realpath -- "$output_dir")
package_dir="$output_dir/$package_name"
archive="$output_dir/$package_name.tar.gz"
if [[ -e "$package_dir" || -e "$archive" ]]; then
    printf '%s\n' 'Package or archive already exists' >&2
    exit 1
fi
args=("-DVIEWER_BUILD_DIR=$build_dir" "-DPACKAGE_DIR=$package_dir" "-DFFMPEG_ROOT=$ffmpeg_root" "-DBUILD_CONFIG=${BUILD_CONFIG:-Release}" "-DPACKAGE_PLATFORM=$platform")
[[ -z "${FFMPEG_LICENCES:-}" ]] || args+=("-DFFMPEG_LICENCES=$FFMPEG_LICENCES")
[[ -z "${CUDA_ROOT:-}" ]] || args+=("-DCUDA_ROOT=$CUDA_ROOT")
cmake "${args[@]}" -P "$script_dir/package.cmake"
archive_epoch="${SOURCE_DATE_EPOCH:-946684800}"
[[ "$archive_epoch" =~ ^[0-9]+$ ]] || { printf '%s\n' 'SOURCE_DATE_EPOCH must be an integer' >&2; exit 1; }
tar --sort=name --format=gnu --mtime="@$archive_epoch" --owner=0 --group=0 --numeric-owner \
    -cf - -C "$output_dir" "$package_name" | gzip -n > "$archive"
(cd -- "$output_dir" && sha256sum -- "$package_name.tar.gz" > "$package_name.tar.gz.sha256")
cp -- "$package_dir/MANIFEST.json" "$archive.manifest.json"
cp -- "$package_dir/SBOM.spdx.json" "$archive.spdx.json"
printf 'Archive ready: %s\n' "$archive"
