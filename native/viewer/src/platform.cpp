#include "ceres/platform.hpp"
#include <array>
#include <cstdlib>
#include <stdexcept>
#include <vector>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <mach-o/dyld.h>
#else
#include <unistd.h>
#endif

namespace ceres::platform {
namespace fs = std::filesystem;
namespace {
fs::path user_home() {
    const auto* value = std::getenv("HOME");
    return value && *value ? fs::path(value) : fs::temp_directory_path();
}
} // namespace
fs::path executable_path() {
#ifdef _WIN32
    std::vector<wchar_t> buffer(32768);
    const auto size = GetModuleFileNameW(nullptr, buffer.data(), DWORD(buffer.size()));
    if (!size || size >= buffer.size())
        throw std::runtime_error("Cannot locate application executable");
    return fs::path(std::wstring(buffer.data(), size));
#elif defined(__APPLE__)
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> buffer(size);
    if (_NSGetExecutablePath(buffer.data(), &size) != 0)
        throw std::runtime_error("Cannot locate application executable");
    return fs::canonical(buffer.data());
#else
    std::vector<char> buffer(4096);
    for (;;) {
        const auto size = readlink("/proc/self/exe", buffer.data(), buffer.size());
        if (size < 0)
            throw std::runtime_error("Cannot locate application executable");
        if (size_t(size) < buffer.size())
            return fs::path(std::string(buffer.data(), size_t(size)));
        buffer.resize(buffer.size() * 2);
    }
#endif
}
fs::path executable_directory() {
    return executable_path().parent_path();
}
fs::path resource_directory() {
    const auto directory = executable_directory();
#ifdef __APPLE__
    if (directory.filename() == "MacOS" && directory.parent_path().filename() == "Contents")
        return directory.parent_path() / "Resources";
#endif
    return directory;
}
fs::path config_directory() {
#ifdef _WIN32
    const auto* base = std::getenv("LOCALAPPDATA");
    return (base ? fs::path(base) : fs::temp_directory_path()) / "Ceres viewer";
#elif defined(__APPLE__)
    return user_home() / "Library/Application Support/Ceres Viewer";
#else
    const auto* xdg = std::getenv("XDG_CONFIG_HOME");
    return (xdg && *xdg ? fs::path(xdg) : user_home() / ".config") / "ceres-viewer";
#endif
}
fs::path data_directory() {
#ifdef _WIN32
    return "D:/data/ceres-viewer";
#elif defined(__APPLE__)
    return user_home() / "Movies/Ceres Viewer";
#else
    return user_home() / "ceres-viewer";
#endif
}
fs::path cache_directory(const fs::path& config) {
#ifdef __APPLE__
    if (fs::absolute(config).lexically_normal() ==
        fs::absolute(config_directory()).lexically_normal())
        return user_home() / "Library/Caches/Ceres Viewer";
#endif
    return config / "cache";
}
#ifdef __APPLE__
std::string system_certificates() {
    CFArrayRef certificates = nullptr;
    if (SecTrustCopyAnchorCertificates(&certificates) != errSecSuccess || !certificates)
        throw std::runtime_error("Cannot read macOS trust anchors");
    std::string pem;
    // SecItemExport retains certificate encoding and avoids a second crypto dependency.
    for (CFIndex i = 0; i < CFArrayGetCount(certificates); ++i) {
        auto certificate = static_cast<SecCertificateRef>(
            const_cast<void*>(CFArrayGetValueAtIndex(certificates, i)));
        CFDataRef encoded = nullptr;
        if (SecItemExport(certificate, kSecFormatX509Cert, kSecItemPemArmour, nullptr, &encoded) ==
                errSecSuccess &&
            encoded) {
            pem.append(reinterpret_cast<const char*>(CFDataGetBytePtr(encoded)),
                       size_t(CFDataGetLength(encoded)));
            CFRelease(encoded);
        }
    }
    CFRelease(certificates);
    if (pem.empty())
        throw std::runtime_error("The macOS trust anchor store is empty");
    return pem;
}
#endif
} // namespace ceres::platform
