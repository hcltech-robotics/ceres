# A distribution CUDA package can trail the system compiler and the current GPUs. Keep only the
# device architectures its nvcc builds, and give nvcc a host compiler it accepts, so the toolkit
# on the path configures without manual flags.

# Compiles a CUDA translation unit that uses the standard library the way the viewer does.
function(ceres_cuda_host_accepts nvcc compiler result)
  set(probe "${CMAKE_BINARY_DIR}/CMakeFiles/ceres-cuda-host-probe.cu")
  file(WRITE "${probe}" "#include <functional>\n__global__ void probe() {}\n"
       "int main() {\n    std::function<void(int)> call = [](int) {};\n"
       "    call(1);\n    return 0;\n}\n")
  set(command "${nvcc}" -std=c++17 -c "${probe}" -o "${probe}.o")
  if(NOT compiler STREQUAL "")
    list(APPEND command -ccbin "${compiler}")
  endif()
  execute_process(COMMAND ${command} RESULT_VARIABLE status OUTPUT_QUIET ERROR_QUIET)
  if(status EQUAL 0)
    set(${result} TRUE PARENT_SCOPE)
  else()
    set(${result} FALSE PARENT_SCOPE)
  endif()
endfunction()

# Keeps the requested architectures this nvcc builds. The newest kept architecture also carries
# PTX, so newer GPUs run the viewer through just-in-time compilation.
macro(ceres_cuda_architectures nvcc)
  execute_process(COMMAND "${nvcc}" --list-gpu-arch RESULT_VARIABLE ceres_arch_status
    OUTPUT_VARIABLE ceres_arch_listing ERROR_QUIET)
  if(ceres_arch_status EQUAL 0)
    string(REGEX MATCHALL "compute_([0-9]+)" ceres_arch_matches "${ceres_arch_listing}")
    string(REPLACE "compute_" "" ceres_arch_supported "${ceres_arch_matches}")
    set(ceres_arch_kept "")
    set(ceres_arch_dropped "")
    foreach(architecture IN LISTS CMAKE_CUDA_ARCHITECTURES)
      string(REGEX REPLACE "[^0-9]" "" ceres_arch_number "${architecture}")
      if(ceres_arch_number IN_LIST ceres_arch_supported)
        list(APPEND ceres_arch_kept "${architecture}")
      else()
        list(APPEND ceres_arch_dropped "${architecture}")
      endif()
    endforeach()
    if(ceres_arch_dropped AND NOT ceres_arch_kept)
      message(FATAL_ERROR "${nvcc} builds none of the requested CUDA architectures "
        "(${CMAKE_CUDA_ARCHITECTURES}). It supports ${ceres_arch_supported}.")
    elseif(ceres_arch_dropped)
      message(STATUS "CUDA architectures: ${ceres_arch_kept} (${nvcc} cannot build "
        "${ceres_arch_dropped}; newer GPUs run the generated PTX)")
      set(CMAKE_CUDA_ARCHITECTURES "${ceres_arch_kept}")
    endif()
  endif()
endmacro()

# Prefers the default host compiler, then the newest installed alternative that nvcc accepts.
macro(ceres_cuda_host_compiler nvcc)
  ceres_cuda_host_accepts("${nvcc}" "" ceres_host_default)
  if(NOT ceres_host_default)
    set(ceres_host_choice "")
    foreach(version 15 14 13 12 11 10 9 8 7)
      if(ceres_host_choice STREQUAL "")
        find_program(ceres_host_${version} NAMES g++-${version})
        if(ceres_host_${version})
          ceres_cuda_host_accepts("${nvcc}" "${ceres_host_${version}}" ceres_host_accepted)
          if(ceres_host_accepted)
            set(ceres_host_choice "${ceres_host_${version}}")
          endif()
        endif()
      endif()
    endforeach()
    if(ceres_host_choice STREQUAL "")
      message(WARNING "No host compiler was found that ${nvcc} accepts. Install a g++ version it "
        "supports, or set CMAKE_CUDA_HOST_COMPILER to one.")
    else()
      message(STATUS "CUDA host compiler: ${ceres_host_choice} (the default compiler and ${nvcc} "
        "disagree about the standard library)")
      # -ccbin travels in the flags rather than CMAKE_CUDA_HOST_COMPILER, which CMake reads only
      # while it first detects nvcc and ignores in an existing build directory.
      string(APPEND CMAKE_CUDA_FLAGS " -ccbin=${ceres_host_choice}")
    endif()
  endif()
endmacro()

# Sets CMAKE_CUDA_ARCHITECTURES and CMAKE_CUDA_FLAGS in the calling scope. Call before
# enable_language(CUDA): CMake resolves the host compiler when it first detects nvcc.
macro(ceres_configure_cuda_host)
  if(CMAKE_CUDA_COMPILER)
    set(ceres_nvcc "${CMAKE_CUDA_COMPILER}")
  else()
    find_program(ceres_nvcc NAMES nvcc HINTS ENV CUDAToolkit_ROOT ENV CUDA_PATH
      PATHS /usr/local/cuda PATH_SUFFIXES bin)
  endif()
  if(ceres_nvcc)
    ceres_cuda_architectures("${ceres_nvcc}")
    if(NOT MSVC AND NOT CMAKE_CUDA_HOST_COMPILER AND NOT CMAKE_CUDA_FLAGS MATCHES "-ccbin")
      ceres_cuda_host_compiler("${ceres_nvcc}")
    endif()
  endif()
endmacro()
