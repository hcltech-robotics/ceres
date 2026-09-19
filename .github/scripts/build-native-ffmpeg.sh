#!/usr/bin/env bash
set -euo pipefail

work_dir=$(realpath -m -- "${1:?Supply an unused build directory}")
prefix=$(realpath -m -- "${2:?Supply the FFmpeg output directory}")
if [[ -e "$work_dir" || -e "$prefix" ]]; then
    printf '%s\n' 'FFmpeg build and output directories must be unused' >&2
    exit 1
fi
mkdir -p -- "$work_dir" "$prefix/doc"
script_path=$(realpath -- "${BASH_SOURCE[0]}")
ffmpeg_revision=140fd653aed8cad774f991ba083e2d01e86420c7
x264_revision=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
jobs=${CMAKE_BUILD_PARALLEL_LEVEL:-2}

checkout() {
    local repository=$1 revision=$2 destination=$3
    git init "$destination"
    git -C "$destination" remote add origin "$repository"
    git -C "$destination" fetch --depth 1 origin "$revision"
    git -C "$destination" checkout --detach FETCH_HEAD
    [[ $(git -C "$destination" rev-parse HEAD) == "$revision" ]]
}

checkout https://code.videolan.org/videolan/x264.git "$x264_revision" "$work_dir/x264"
checkout https://github.com/FFmpeg/FFmpeg.git "$ffmpeg_revision" "$work_dir/ffmpeg"
(
    cd -- "$work_dir/x264"
    ./configure --prefix="$prefix" --enable-static --disable-cli --enable-pic --disable-opencl
    make -j "$jobs"
    make install
)
(
    cd -- "$work_dir/ffmpeg"
    PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure \
        --prefix="$prefix" --disable-shared --enable-static --disable-debug \
        --disable-doc --disable-autodetect --enable-gpl --enable-libx264 \
        --pkg-config-flags=--static --extra-version=ceres-8.0
    make -j "$jobs"
    make install
)

cp "$work_dir/ffmpeg/COPYING.GPLv2" "$prefix/LICENCE.ffmpeg.txt"
cp "$work_dir/x264/COPYING" "$prefix/LICENCE.x264.txt"
cp "$script_path" "$prefix/doc/build-native-ffmpeg.sh"
git -C "$work_dir/ffmpeg" archive --format=tar HEAD | gzip -n > "$prefix/doc/ffmpeg-source.tar.gz"
git -C "$work_dir/x264" archive --format=tar HEAD | gzip -n > "$prefix/doc/x264-source.tar.gz"
cat > "$prefix/ffmpeg-source-lock.json" <<EOF
{
  "schema": "ceres-ffmpeg-sources",
  "version": 1,
  "ffmpeg": {"repository": "https://github.com/FFmpeg/FFmpeg.git", "revision": "$ffmpeg_revision", "release": "8.0"},
  "x264": {"repository": "https://code.videolan.org/videolan/x264.git", "revision": "$x264_revision"},
  "build_recipe": "doc/build-native-ffmpeg.sh",
  "source_archives": ["doc/ffmpeg-source.tar.gz", "doc/x264-source.tar.gz"]
}
EOF
cp "$prefix/ffmpeg-source-lock.json" "$prefix/doc/ffmpeg-source-lock.json"
"$prefix/bin/ffmpeg" -version
"$prefix/bin/ffprobe" -version
encoders=$("$prefix/bin/ffmpeg" -hide_banner -encoders)
[[ "$encoders" == *libx264* ]]
