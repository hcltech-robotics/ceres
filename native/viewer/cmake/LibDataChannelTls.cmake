# The pinned libdatachannel source disables all WebSocket TLS verification on
# Windows. Its Mbed TLS backend supports our explicitly supplied PEM trust roots.
# Compile a build-local copy with that bypass removed, leaving fetched sources intact.
if(WIN32)
  set(ceres_websocket_source "${libdatachannel_SOURCE_DIR}/src/impl/websocket.cpp")
  file(READ "${ceres_websocket_source}" ceres_websocket_content)
  set(ceres_windows_tls_bypass [=[#ifdef _WIN32
		if (std::exchange(verify, false)) {
			PLOG_WARNING << "TLS certificate verification with root CA is not supported on Windows";
		}
#endif]=])
  string(FIND "${ceres_websocket_content}" "${ceres_windows_tls_bypass}" ceres_bypass_position)
  if(ceres_bypass_position EQUAL -1 OR NOT USE_MBEDTLS)
    message(FATAL_ERROR "The pinned WebSocket TLS verification patch needs updating")
  endif()
  string(REPLACE "${ceres_windows_tls_bypass}" "" ceres_websocket_content "${ceres_websocket_content}")
  # Preserve the original source directory's precedence over public headers
  # with the same name, such as rtc/websocket.hpp.
  string(REGEX MATCHALL "#include \"[^\"]+\"" ceres_local_includes "${ceres_websocket_content}")
  foreach(ceres_include IN LISTS ceres_local_includes)
    string(REGEX REPLACE "#include \"([^\"]+)\"" "\\1" ceres_header "${ceres_include}")
    if(EXISTS "${libdatachannel_SOURCE_DIR}/src/impl/${ceres_header}")
      string(REPLACE "${ceres_include}" "#include \"${libdatachannel_SOURCE_DIR}/src/impl/${ceres_header}\""
        ceres_websocket_content "${ceres_websocket_content}")
    endif()
  endforeach()
  set(ceres_verified_websocket "${CMAKE_CURRENT_BINARY_DIR}/ceres-tls/websocket.cpp")
  file(CONFIGURE OUTPUT "${ceres_verified_websocket}" CONTENT "${ceres_websocket_content}" @ONLY)
  foreach(ceres_datachannel_target datachannel datachannel-static)
    get_target_property(ceres_datachannel_sources ${ceres_datachannel_target} SOURCES)
    list(FIND ceres_datachannel_sources "${ceres_websocket_source}" ceres_source_position)
    if(ceres_source_position EQUAL -1)
      message(FATAL_ERROR "Cannot locate the pinned WebSocket implementation")
    endif()
    list(REMOVE_AT ceres_datachannel_sources ${ceres_source_position})
    list(APPEND ceres_datachannel_sources "${ceres_verified_websocket}")
    set_property(TARGET ${ceres_datachannel_target} PROPERTY SOURCES "${ceres_datachannel_sources}")
  endforeach()
endif()
