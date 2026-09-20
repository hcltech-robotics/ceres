include_guard(GLOBAL)

function(ceres_add_native_exporter viewer_target)
  get_filename_component(source_root "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/../../.." ABSOLUTE)
  set(exporter_manifest "${source_root}/native/lerobot-exporter/Cargo.toml")
  if(NOT EXISTS "${exporter_manifest}")
    message(FATAL_ERROR "The sibling native/lerobot-exporter source is required")
  endif()
  find_program(CARGO_EXECUTABLE cargo REQUIRED)
  set(exporter_target "${CMAKE_CURRENT_BINARY_DIR}/exporter-target")
  set(exporter_name "ceres-native-exporter${CMAKE_EXECUTABLE_SUFFIX}")
  set(exporter_output "${exporter_target}/release/${exporter_name}")
  set(exporter_staged "$<TARGET_FILE_DIR:${viewer_target}>/${exporter_name}")

  # Cargo tracks source files, path dependencies, build scripts and release
  # metadata. Check it on every viewer build and let Cargo reuse fresh outputs.
  # Staging also runs when the viewer does not relink or the helper was deleted.
  add_custom_target(ceres-native-exporter
    COMMAND "${CARGO_EXECUTABLE}" build --locked --release
      --manifest-path "${exporter_manifest}" --target-dir "${exporter_target}"
      --bin ceres-native-exporter
    COMMAND "${CMAKE_COMMAND}" -E make_directory "$<TARGET_FILE_DIR:${viewer_target}>"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${exporter_output}" "${exporter_staged}"
    BYPRODUCTS "${exporter_output}"
    WORKING_DIRECTORY "${source_root}"
    COMMENT "Building and staging the native LeRobot exporter"
    USES_TERMINAL
    VERBATIM)
  add_dependencies("${viewer_target}" ceres-native-exporter)
  install(PROGRAMS "${exporter_staged}" DESTINATION . COMPONENT ViewerRuntime)
endfunction()
