#include "ceres/detail/video_backend.hpp"
#include <algorithm>
#include <dynlink_nvcuvid.h>
#include <utility>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace ceres::detail {
namespace {
using detail::cuda_check;
void check(CUresult result, const char* operation) {
    cuda_check(result, operation);
}
struct DecodeApi {
#ifdef _WIN32
    HMODULE library = LoadLibraryA("nvcuvid.dll");
    void* symbol(const char* name) {
        return reinterpret_cast<void*>(GetProcAddress(library, name));
    }
    void release() {
        if (library)
            FreeLibrary(library);
        library = nullptr;
    }
#else
    void* library = dlopen("libnvcuvid.so.1", RTLD_NOW);
    void* symbol(const char* name) {
        return dlsym(library, name);
    }
    void release() {
        if (library)
            dlclose(library);
        library = nullptr;
    }
#endif
    tcuvidCreateVideoParser* create_parser = nullptr;
    tcuvidDestroyVideoParser* destroy_parser = nullptr;
    tcuvidParseVideoData* parse = nullptr;
    tcuvidCreateDecoder* create_decoder = nullptr;
    tcuvidDestroyDecoder* destroy_decoder = nullptr;
    tcuvidDecodePicture* decode = nullptr;
    tcuvidMapVideoFrame64* map = nullptr;
    tcuvidUnmapVideoFrame64* unmap = nullptr;
    DecodeApi() {
        try {
            if (!library) {
#ifdef _WIN32
                const auto reason = "Windows loader error " + std::to_string(GetLastError());
#else
                const char* loader_error = dlerror();
                const std::string reason = loader_error ? loader_error : "unknown loader error";
#endif
                throw std::runtime_error("CUVID decoder unavailable: " + reason +
                                         ". Install the NVIDIA video driver. Jetson Orin requires "
                                         "the JetPack viewer build.");
            }
#define LOAD(field, type, name)                                                                    \
    field = reinterpret_cast<type*>(symbol(name));                                                 \
    if (!field)                                                                                    \
    throw std::runtime_error(std::string("Missing NVIDIA API ") + name)
            LOAD(create_parser, tcuvidCreateVideoParser, "cuvidCreateVideoParser");
            LOAD(destroy_parser, tcuvidDestroyVideoParser, "cuvidDestroyVideoParser");
            LOAD(parse, tcuvidParseVideoData, "cuvidParseVideoData");
            LOAD(create_decoder, tcuvidCreateDecoder, "cuvidCreateDecoder");
            LOAD(destroy_decoder, tcuvidDestroyDecoder, "cuvidDestroyDecoder");
            LOAD(decode, tcuvidDecodePicture, "cuvidDecodePicture");
            LOAD(map, tcuvidMapVideoFrame64, "cuvidMapVideoFrame64");
            LOAD(unmap, tcuvidUnmapVideoFrame64, "cuvidUnmapVideoFrame64");
#undef LOAD
        } catch (...) {
            release();
            throw;
        }
    }
    ~DecodeApi() {
        release();
    }
};

class CuvidBackend final : public VideoBackend {
    DecodeApi api;
    CUstream stream;
    PresentVideo present;
    CUvideoparser parser = nullptr;
    CUvideodecoder decoder = nullptr;
    int width = 0, height = 0;
    bool full_range = false, bt709 = false;
    std::string callback_error;

  public:
    CuvidBackend(CUstream copy_stream, PresentVideo callback)
        : stream(copy_stream), present(std::move(callback)) {
        reset();
    }
    ~CuvidBackend() override {
        if (parser)
            api.destroy_parser(parser);
        if (decoder)
            api.destroy_decoder(decoder);
    }
    bool submit(std::span<const uint8_t> bytes, int64_t serial) override {
        callback_error.clear();
        CUVIDSOURCEDATAPACKET packet{};
        packet.flags = CUVID_PKT_TIMESTAMP | CUVID_PKT_ENDOFPICTURE;
        packet.payload = bytes.data();
        packet.payload_size = static_cast<unsigned long>(bytes.size());
        packet.timestamp = serial;
        const auto result = api.parse(parser, &packet);
        if (result != CUDA_SUCCESS) {
            if (!callback_error.empty())
                throw std::runtime_error(callback_error);
            check(result, "Parse H.264 access unit");
        }
        return true;
    }
    void poll() override {}
    void reset() override {
        callback_error.clear();
        if (parser) {
            api.destroy_parser(parser);
            parser = nullptr;
        }
        if (decoder) {
            api.destroy_decoder(decoder);
            decoder = nullptr;
        }
        width = height = 0;
        CUVIDPARSERPARAMS parameters{};
        parameters.CodecType = cudaVideoCodec_H264;
        parameters.ulMaxNumDecodeSurfaces = 1;
        parameters.ulClockRate = 1000000;
        parameters.ulMaxDisplayDelay = 0;
        parameters.pUserData = this;
        parameters.pfnSequenceCallback = [](void* user, CUVIDEOFORMAT* format) -> int {
            auto* self = static_cast<CuvidBackend*>(user);
            try {
                return self->sequence(format);
            } catch (const std::exception& error) {
                self->callback_error = error.what();
                return 0;
            }
        };
        parameters.pfnDecodePicture = [](void* user, CUVIDPICPARAMS* picture) -> int {
            auto* self = static_cast<CuvidBackend*>(user);
            try {
                check(self->api.decode(self->decoder, picture), "Decode H.264 picture");
                return 1;
            } catch (const std::exception& error) {
                self->callback_error = error.what();
                return 0;
            }
        };
        parameters.pfnDisplayPicture = [](void* user, CUVIDPARSERDISPINFO* picture) -> int {
            auto* self = static_cast<CuvidBackend*>(user);
            try {
                self->display(picture);
                return 1;
            } catch (const std::exception& error) {
                self->callback_error = error.what();
                return 0;
            }
        };
        check(api.create_parser(&parser, &parameters), "Create H.264 parser");
    }

    int sequence(CUVIDEOFORMAT* format) {
        if (format->bit_depth_luma_minus8 || format->chroma_format != cudaVideoChromaFormat_420)
            throw std::runtime_error("Bridge video requires 8-bit H.264 4:2:0");
        const int w = format->display_area.right - format->display_area.left;
        const int h = format->display_area.bottom - format->display_area.top;
        if (w <= 0 || h <= 0 || w > 8192 || h > 8192 || (w & 1) || (h & 1) ||
            !format->coded_width || !format->coded_height || format->coded_width > 8192 ||
            format->coded_height > 8192 || format->display_area.left < 0 ||
            format->display_area.top < 0 ||
            unsigned(format->display_area.right) > format->coded_width ||
            unsigned(format->display_area.bottom) > format->coded_height ||
            format->min_num_decode_surfaces > 32)
            throw std::runtime_error("Invalid decoded video dimensions or surface count");
        if (decoder) {
            api.destroy_decoder(decoder);
            decoder = nullptr;
        }
        width = w;
        height = h;
        full_range = format->video_signal_description.video_full_range_flag != 0;
        bt709 = format->video_signal_description.matrix_coefficients == 1;
        CUVIDDECODECREATEINFO creation{};
        creation.CodecType = format->codec;
        creation.ChromaFormat = format->chroma_format;
        creation.OutputFormat = cudaVideoSurfaceFormat_NV12;
        creation.ulWidth = format->coded_width;
        creation.ulHeight = format->coded_height;
        creation.ulNumDecodeSurfaces = std::max<unsigned>(format->min_num_decode_surfaces, 4);
        creation.ulNumOutputSurfaces = 2;
        creation.ulCreationFlags = cudaVideoCreate_PreferCUVID;
        creation.DeinterlaceMode = cudaVideoDeinterlaceMode_Weave;
        creation.ulTargetWidth = static_cast<unsigned>(width);
        creation.ulTargetHeight = static_cast<unsigned>(height);
        creation.display_area.left = static_cast<short>(format->display_area.left);
        creation.display_area.top = static_cast<short>(format->display_area.top);
        creation.display_area.right = static_cast<short>(format->display_area.right);
        creation.display_area.bottom = static_cast<short>(format->display_area.bottom);
        check(api.create_decoder(&decoder, &creation), "Create NVDEC decoder");
        return static_cast<int>(creation.ulNumDecodeSurfaces);
    }

    void display(CUVIDPARSERDISPINFO* picture) {
        CUVIDPROCPARAMS parameters{};
        parameters.progressive_frame = picture->progressive_frame;
        parameters.top_field_first = picture->top_field_first;
        parameters.unpaired_field = picture->repeat_first_field < 0;
        parameters.output_stream = stream;
        unsigned long long mapped = 0;
        unsigned int pitch = 0;
        check(api.map(decoder, picture->picture_index, &mapped, &pitch, &parameters),
              "Map NVDEC surface");
        try {
            DecodedSurface surface;
            surface.width = width;
            surface.height = height;
            surface.full_range = full_range;
            surface.bt709 = bt709;
            for (int plane = 0; plane < 2; ++plane) {
                surface.planes[plane].srcMemoryType = CU_MEMORYTYPE_DEVICE;
                surface.planes[plane].srcDevice = mapped + (plane ? size_t(pitch) * height : 0);
                surface.planes[plane].srcPitch = pitch;
            }
            present(picture->timestamp, surface);
            check(cuStreamSynchronize(stream), "Complete NVDEC surface transfer");
        } catch (...) {
            cuStreamSynchronize(stream);
            api.unmap(decoder, mapped);
            throw;
        }
        check(api.unmap(decoder, mapped), "Release NVDEC surface");
    }
};
} // namespace
std::unique_ptr<VideoBackend> make_video_backend(CUstream stream, PresentVideo present) {
    return std::make_unique<CuvidBackend>(stream, std::move(present));
}
const char* video_backend_name() {
    return "CUVID";
}
} // namespace ceres::detail
