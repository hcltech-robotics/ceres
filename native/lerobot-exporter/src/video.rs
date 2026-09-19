use crate::ExportJob;
use anyhow::{Context, Result, ensure};
use std::{
    fs::File,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

struct ManagedChild(Child);
fn ffmpeg_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    command.args([
        "-threads",
        "2",
        "-filter_threads",
        "2",
        "-filter_complex_threads",
        "2",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = &mut command;
    command
}
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub struct Decoder {
    child: ManagedChild,
    stdout: BufReader<ChildStdout>,
    next: usize,
    errors: PathBuf,
    dimensions: (u32, u32),
}
impl Decoder {
    pub fn source_dimensions(
        job: &ExportJob,
        input: &Path,
        errors: &Path,
        byte_offset: u64,
    ) -> Result<(u32, u32)> {
        let mut decoder = Self::new(job, input, errors, 0, byte_offset)?;
        decoder.image_dimensions().map_err(|error| {
            let detail = std::fs::read_to_string(errors).unwrap_or_default();
            anyhow::anyhow!("read encoded camera dimensions: {error}: {}", detail.trim())
        })
    }

    pub fn new(
        job: &ExportJob,
        input: &Path,
        errors: &Path,
        first_frame: usize,
        byte_offset: u64,
    ) -> Result<Self> {
        let mut child = ffmpeg_command(&job.ffmpeg)
            .args(["-skip_initial_bytes", &byte_offset.to_string()])
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-xerror",
                "-err_detect",
                "explode",
                "-f",
                "h264",
                "-i",
            ])
            .arg(input)
            .args(["-an", "-fps_mode", "passthrough", "-noautoscale"])
            .args([
                "-threads",
                "2",
                "-pix_fmt",
                "rgb24",
                "-c:v",
                "ppm",
                "-f",
                "image2pipe",
                "pipe:1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(File::create(errors)?)
            .spawn()
            .context("start FFmpeg decoder")?;
        let stdout = child.stdout.take().context("open FFmpeg decoder pipe")?;
        Ok(Self {
            child: ManagedChild(child),
            stdout: BufReader::with_capacity(64 * 1024, stdout),
            next: first_frame,
            errors: errors.to_owned(),
            dimensions: (job.video.width, job.video.height),
        })
    }
    pub fn read_frame(&mut self, index: usize, frame: &mut [u8]) -> Result<()> {
        ensure!(
            index >= self.next,
            "video samples cannot be reused or reordered"
        );
        while self.next <= index {
            if let Err(error) = self.read_image(if self.next == index {
                Some(&mut *frame)
            } else {
                None
            }) {
                let _ = self.child.0.try_wait();
                let detail = std::fs::read_to_string(&self.errors).unwrap_or_default();
                anyhow::bail!(
                    "decode video frame {}: {error}: {}",
                    self.next,
                    detail.trim()
                );
            }
            self.next += 1;
        }
        Ok(())
    }
    fn read_image(&mut self, destination: Option<&mut [u8]>) -> Result<()> {
        // Each PPM image carries its own dimensions, including discarded pre-roll.
        let (width, height) = self.image_dimensions()?;
        let bytes = u64::from(width) * u64::from(height) * 3;
        if let Some(frame) = destination {
            ensure!(
                (width, height) == self.dimensions,
                "selected source image is {width}x{height}, but the export requests {}x{}; select ranges at a single source resolution and use those exact dimensions",
                self.dimensions.0,
                self.dimensions.1
            );
            ensure!(
                bytes == frame.len() as u64,
                "RGB destination length differs from the source image"
            );
            self.stdout.read_exact(frame)?;
        } else {
            let copied =
                std::io::copy(&mut self.stdout.by_ref().take(bytes), &mut std::io::sink())?;
            ensure!(copied == bytes, "truncated decoded pre-roll image");
        }
        Ok(())
    }
    fn image_dimensions(&mut self) -> Result<(u32, u32)> {
        ensure!(
            image_token(&mut self.stdout)? == "P6",
            "FFmpeg did not emit an RGB image"
        );
        let width: u32 = image_token(&mut self.stdout)?.parse()?;
        let height: u32 = image_token(&mut self.stdout)?.parse()?;
        ensure!(
            (1..=16384).contains(&width) && (1..=16384).contains(&height),
            "invalid decoded image dimensions"
        );
        ensure!(
            image_token(&mut self.stdout)? == "255",
            "FFmpeg did not emit 8-bit RGB pixels"
        );
        Ok((width, height))
    }
}

fn image_token(reader: &mut impl Read) -> Result<String> {
    let mut token = Vec::with_capacity(16);
    let mut byte = [0];
    for _ in 0..128 {
        reader.read_exact(&mut byte)?;
        if byte[0].is_ascii_whitespace() {
            if !token.is_empty() {
                return Ok(String::from_utf8(token)?);
            }
        } else {
            token.push(byte[0]);
        }
    }
    anyhow::bail!("invalid decoded image header")
}

pub struct Encoder {
    child: ManagedChild,
    stdin: Option<ChildStdin>,
    errors: PathBuf,
}
impl Encoder {
    pub fn new(job: &ExportJob, output: &Path, errors: &Path) -> Result<Self> {
        let mut child = ffmpeg_command(&job.ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-video_size",
            ])
            .arg(format!("{}x{}", job.video.width, job.video.height))
            .args([
                "-framerate",
                &job.fps.to_string(),
                "-i",
                "pipe:0",
                "-an",
                "-c:v",
                "libx264",
                "-threads",
                "2",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-bf",
                "0",
                "-g",
                &job.fps.to_string(),
                "-movflags",
                "+faststart",
                "-video_track_timescale",
                &(job.fps * 1000).to_string(),
            ])
            .arg(output)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(File::create(errors)?)
            .spawn()
            .context("start FFmpeg encoder")?;
        let stdin = child.stdin.take().context("open FFmpeg encoder pipe")?;
        Ok(Self {
            child: ManagedChild(child),
            stdin: Some(stdin),
            errors: errors.to_owned(),
        })
    }
    pub fn write_frame(&mut self, frame: &[u8]) -> Result<()> {
        self.stdin
            .as_mut()
            .context("FFmpeg encoder already closed")?
            .write_all(frame)
            .context("write video frame")
    }
    pub fn finish(mut self) -> Result<()> {
        self.stdin.take();
        let status = self.child.0.wait()?;
        ensure!(
            status.success(),
            "FFmpeg encoding failed: {}",
            std::fs::read_to_string(&self.errors)
                .unwrap_or_default()
                .trim()
        );
        Ok(())
    }
}
