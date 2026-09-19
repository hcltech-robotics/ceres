# Quest 3 native asset

model.json uses ceres-static-model version 1. All vertex and index files
are little-endian without a header. vertices.bin has one 32-byte record
per vertex, containing float32 position[3], normal[3] and UV[2].
indices.bin has uint32 indices in the original triangle order. Positions
are metres with the USD hierarchy and documented scale correction baked.

The three texture files contain tightly packed RGBA8, 2048 x 2048 pixels,
with the bottom row first. Use repeat wrapping. base-colour.rgba is sRGB.
normal.rgba and orm.rgba are linear. ORM channels are R=occlusion,
G=roughness, B=metallic and A=255. Decode tangent-space normal RGB as
2 * sample - 1. Tangents can be reconstructed from positions and UVs.
No texture resizing, UV inversion or channel gamma conversion is applied.

model_to_head is a 16-value column-major rigid matrix. Multiply a source
vertex by model_to_head, then the tracked head transform. It rotates the
model by 180 degrees around Y and places the measured lens-surface
midpoint at the head origin. This is a geometric proxy because the
artist asset supplies no eye-relief or tracking-origin calibration.

Source hashes, mesh landmarks, material provenance, original transforms
and scale correction are preserved in model.json. NOTICE accompanies
the model and its textures whenever this local asset is redistributed.
