# Quest volumetric reconstruction

The optional Quest Mapper reconstructs a signed-distance volume from Quest sensor depth. It runs in its own Python process, reads CED1 packets from a recording or pipe and writes a world-space surface, a raycast preview and resumable cuRobo TSDF checkpoints. The native viewer has no Python dependency.

## Environment

Use Linux x64 or WSL with Python 3.12 and an NVIDIA GPU. Keep the helper environment, cuRobo source and Warp cache on the Linux filesystem. Install the versions in `quest-mapper-requirements.txt` into a dedicated virtual environment. An existing CUDA PyTorch environment can be reused through a virtual environment created with `--system-site-packages`.

Download the cuRobo archive named in `quest-mapper-source.json`, verify its SHA-256 and extract it into a dedicated source directory. Set `PYTHONPATH` to that directory. The adapter checks the complete pinned Python/CUDA source tree before importing Mapper. The current cuRobo Mapper uses its own block-sparse TSDF and Warp kernels.

On WSL, set `LD_LIBRARY_PATH=/usr/lib/wsl/lib` for the helper process so Warp uses the Windows-provided CUDA driver. Set `WARP_CACHE_PATH` to a dedicated writable Linux directory. The first run compiles its Warp kernels and subsequent runs reuse that cache.

With the helper environment and pinned source in `~/ceres-quest-mapper`, the WSL invocation is:

```sh
PYTHONPATH="$HOME/ceres-quest-mapper/source" \
WARP_CACHE_PATH="$HOME/ceres-quest-mapper/cache/warp" \
LD_LIBRARY_PATH=/usr/lib/wsl/lib OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
"$HOME/ceres-quest-mapper/venv/bin/python" quest_mapper.py \
  --input capture.mcap --output reconstruction --max-frames 120 \
  --max-blocks 8192 --gpu-budget-mib 768 --voxel-size 0.02 --mesh
```

## Recording input

```sh
python quest_mapper.py --input capture.mcap --output reconstruction \
  --max-frames 120 --voxel-size 0.02 --max-blocks 8192 \
  --gpu-budget-mib 768 --checkpoint-every 30 --mesh
```

The helper accepts uncompressed or compressed MCAP recordings containing Ceres `environment_depth` events. It also accepts one `.ced1` file. For a live producer, pass `--input -` and write each complete CED1 packet to standard input preceded by its byte length as an unsigned little-endian 32-bit integer. This interface consumes the existing sensor packets and does not connect to or control the headset.

Depth is measured along the camera's forward axis in metres. The adapter rectifies each frame through its own `norm_depth_from_norm_view` matrix and uses its own acquisition `world_from_view` pose. Normalised WebXR view coordinates start at the top left. World coordinates retain WebXR's Y-up convention. Mapper's right/down/forward camera basis is converted at the pose boundary, with the half-pixel centres used by the pinned Mapper kernels.

Zero and out-of-range depth remains invalid. Empty frames count towards the input bound but do not initialise or update the map. An acquisition-space change stops the run rather than combining different world frames. No pose from a later frame is substituted.

For a known legacy GPU recording with reversed packed rows, select `--legacy-flip-rows` explicitly. The selected option is recorded in `report.json`. To compare interpretations, use the same `--grid-centre X Y Z`, extent, voxel size, block count and frame bound for both outputs. Without an explicit centre, the first usable frame determines the map centre.

## Outputs and bounds

`surface-world-metres.npy` contains extracted world-space samples. `raycast-depth-metres.npy`, `raycast-normals.ppm` and `raycast-shaded.ppm` show the integrated volume from the first usable camera view. `--mesh` also writes `surface.ply`. Preview colours describe the surface normals or shading and do not alter the geometry.

`report.json` records input and output hashes, the upstream source identity, acquisition-space identity, exact options, integration times, block statistics and GPU allocation measurements. It also verifies that loading the saved TSDF checkpoint produces the same depth and validity mask.

The default pool contains at most 8,192 blocks of 8x8x8 voxels. The PyTorch allocator is capped at the selected GPU budget and allocation checks run after map creation, periodic saves, extraction, raycasting and checkpoint restore. The helper requires an additional 1 GiB of free device memory before starting. ESDF computation is not required for the reconstruction output.

The owned `checkpoints` directory retains the three most recently saved complete `quest-tsdf-*.pt` checkpoints. Each checkpoint is committed before older complete files are pruned. A failed save preserves the previous three. A directory with unrelated existing files is rejected and symbolic-link destinations are rejected.

## Coordinate fixture

```sh
python quest_mapper_fixture.py asymmetric-room.mcap --frames 48
python -m unittest discover -s ../tests -p test_quest_mapper.py
```

The fixture contains a low wide block on the left and a high narrow block on the right against a stationary wall. The camera translates and rotates while the depth and acquisition transform remain paired. Its complete Ceres session envelopes can be replayed in the native viewer.

The coordinate tests independently compare WebXR inverse projection with the pinned Mapper kernel's pixel-centre formula. They also cover axial depth, row mapping, moving poses, invalid metadata and checkpoint retention.

Source references: [cuRobo volumetric mapping](https://nvlabs.github.io/curobo/latest/getting-started/volumetric_mapping.html), [pinned camera integration kernel](https://github.com/NVlabs/curobo/blob/78fd485fa82d9b9a063fb4985e371814587e666a/curobo/_src/perception/mapper/kernel/builder/builder_camera_integrate.py) and [pinned Mapper API](https://github.com/NVlabs/curobo/blob/78fd485fa82d9b9a063fb4985e371814587e666a/curobo/_src/perception/mapper/mapper.py).
