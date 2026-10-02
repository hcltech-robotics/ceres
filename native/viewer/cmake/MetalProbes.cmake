if(CERES_BUILD_TESTS)
  add_executable(test_videotoolbox tests/test_videotoolbox.mm)
  target_compile_definitions(test_videotoolbox PRIVATE CERES_METAL)
  target_compile_options(test_videotoolbox PRIVATE -fobjc-arc)
  target_link_libraries(test_videotoolbox PRIVATE ceres_video)
  set_target_properties(test_videotoolbox PROPERTIES OBJCXX_STANDARD 20 OBJCXX_STANDARD_REQUIRED ON)
  add_test(NAME videotoolbox COMMAND test_videotoolbox --run-gpu
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/nvdec" "${CMAKE_CURRENT_BINARY_DIR}/videotoolbox-check.json")
  set_tests_properties(videotoolbox PROPERTIES LABELS "gpu" TIMEOUT 60)
endif()

find_program(CERES_XCRUN xcrun REQUIRED)
set(ceres_probe_air "${CMAKE_CURRENT_BINARY_DIR}/map-reduction.air")
set(ceres_probe_library "${CMAKE_CURRENT_BINARY_DIR}/ceres-probes.metallib")
add_custom_command(OUTPUT "${ceres_probe_library}"
  COMMAND "${CERES_XCRUN}" -sdk macosx metal -std=metal3.0 -fno-fast-math
    -mmacosx-version-min=${CMAKE_OSX_DEPLOYMENT_TARGET}
    -c "${CMAKE_CURRENT_SOURCE_DIR}/src/metal/map_reduction.metal" -o "${ceres_probe_air}"
  COMMAND "${CERES_XCRUN}" -sdk macosx metallib "${ceres_probe_air}" -o "${ceres_probe_library}"
  DEPENDS src/metal/map_reduction.metal VERBATIM)
add_custom_target(ceres-metal-probe-shaders DEPENDS "${ceres_probe_library}")
if(CERES_BUILD_TESTS)
  add_executable(test_metal_reduction tests/test_metal_reduction.mm)
  target_compile_options(test_metal_reduction PRIVATE -fobjc-arc)
  target_link_libraries(test_metal_reduction PRIVATE ceres_core "-framework Metal" "-framework Foundation")
  set_target_properties(test_metal_reduction PROPERTIES OBJCXX_STANDARD 20 OBJCXX_STANDARD_REQUIRED ON)
  add_dependencies(test_metal_reduction ceres-metal-probe-shaders)
  add_test(NAME metal_reduction COMMAND test_metal_reduction "${ceres_probe_library}"
    "${CMAKE_CURRENT_BINARY_DIR}/metal-reduction-check.json")
  set_tests_properties(metal_reduction PROPERTIES LABELS "gpu" TIMEOUT 60)
endif()
