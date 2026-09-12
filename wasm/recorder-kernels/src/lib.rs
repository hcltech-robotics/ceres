use std::fmt;
use wasm_bindgen::prelude::*;

const RECORD_MAGIC: [u8; 4] = *b"CRB1";
const RECORD_VERSION: u16 = 1;
const RECORD_HEADER_LEN: usize = 48;
const RECORD_CHECKSUM_OFFSET: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
struct KernelError(String);

impl KernelError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for KernelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn js_error(error: KernelError) -> JsValue {
    JsValue::from_str(&error.0)
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("checked frame"))
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("checked frame"))
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("checked frame"))
}

fn crc32c_update(mut state: u32, bytes: &[u8]) -> u32 {
    for &byte in bytes {
        state ^= u32::from(byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(state & 1);
            state = (state >> 1) ^ (0x82f6_3b78 & mask);
        }
    }
    state
}

fn crc32c_parts(parts: &[&[u8]]) -> u32 {
    let mut state = u32::MAX;
    for part in parts {
        state = crc32c_update(state, part);
    }
    !state
}

fn crc32_ieee_update(mut state: u32, bytes: &[u8]) -> u32 {
    for &byte in bytes {
        state ^= u32::from(byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(state & 1);
            state = (state >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    state
}

fn crc32_ieee_parts(parts: &[&[u8]]) -> u32 {
    let mut state = u32::MAX;
    for part in parts {
        state = crc32_ieee_update(state, part);
    }
    !state
}

#[wasm_bindgen]
pub fn crc32c(data: &[u8]) -> u32 {
    crc32c_parts(&[data])
}

#[wasm_bindgen]
pub fn crc32_ieee(data: &[u8]) -> u32 {
    crc32_ieee_parts(&[data])
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecordData {
    session_id: String,
    episode_id: String,
    sequence: u64,
    recorder_frame_index: u64,
    source_timestamp_us: u64,
    flags: u32,
    checksum: u32,
    payload: Vec<u8>,
}

fn encode_record_inner(
    session_id: &str,
    episode_id: &str,
    sequence: u64,
    recorder_frame_index: u64,
    source_timestamp_us: u64,
    flags: u32,
    payload: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let session_bytes = session_id.as_bytes();
    let episode_bytes = episode_id.as_bytes();
    if session_bytes.is_empty() || session_bytes.len() > u16::MAX as usize {
        return Err(KernelError::new(
            "record session identifier length is invalid",
        ));
    }
    if episode_bytes.is_empty() || episode_bytes.len() > u16::MAX as usize {
        return Err(KernelError::new(
            "record episode identifier length is invalid",
        ));
    }
    if flags > u16::MAX.into() {
        return Err(KernelError::new("record flags exceed the u16 field"));
    }
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| KernelError::new("record payload exceeds the u32 frame limit"))?;
    let total_len = RECORD_HEADER_LEN
        .checked_add(session_bytes.len())
        .and_then(|length| length.checked_add(episode_bytes.len()))
        .and_then(|length| length.checked_add(payload.len()))
        .ok_or_else(|| KernelError::new("record frame length overflow"))?;
    let mut frame = vec![0; total_len];

    frame[0..4].copy_from_slice(&RECORD_MAGIC);
    frame[4] = RECORD_VERSION as u8;
    frame[5] = RECORD_HEADER_LEN as u8;
    frame[6..8].copy_from_slice(&(flags as u16).to_le_bytes());
    frame[8..16].copy_from_slice(&sequence.to_le_bytes());
    frame[16..24].copy_from_slice(&recorder_frame_index.to_le_bytes());
    frame[24..32].copy_from_slice(&source_timestamp_us.to_le_bytes());
    frame[32..36].copy_from_slice(&payload_len.to_le_bytes());
    frame[36..38].copy_from_slice(&(session_bytes.len() as u16).to_le_bytes());
    frame[38..40].copy_from_slice(&(episode_bytes.len() as u16).to_le_bytes());

    let mut offset = RECORD_HEADER_LEN;
    frame[offset..offset + session_bytes.len()].copy_from_slice(session_bytes);
    offset += session_bytes.len();
    frame[offset..offset + episode_bytes.len()].copy_from_slice(episode_bytes);
    offset += episode_bytes.len();
    frame[offset..].copy_from_slice(payload);

    let checksum = crc32_ieee_parts(&[
        &frame[..RECORD_CHECKSUM_OFFSET],
        &[0, 0, 0, 0],
        &frame[RECORD_CHECKSUM_OFFSET + 4..RECORD_HEADER_LEN],
        &frame[RECORD_HEADER_LEN..],
    ]);
    frame[RECORD_CHECKSUM_OFFSET..RECORD_CHECKSUM_OFFSET + 4]
        .copy_from_slice(&checksum.to_le_bytes());
    Ok(frame)
}

fn decode_record_inner(frame: &[u8]) -> Result<RecordData, KernelError> {
    if frame.len() < RECORD_HEADER_LEN {
        return Err(KernelError::new("record frame is shorter than its header"));
    }
    if frame[..4] != RECORD_MAGIC {
        return Err(KernelError::new("record frame magic is invalid"));
    }
    if u16::from(frame[4]) != RECORD_VERSION {
        return Err(KernelError::new("record frame version is unsupported"));
    }
    if usize::from(frame[5]) != RECORD_HEADER_LEN {
        return Err(KernelError::new("record frame header length is invalid"));
    }
    if read_u32(frame, 44) != 0 {
        return Err(KernelError::new("record frame reserved field must be zero"));
    }
    let payload_len = read_u32(frame, 32) as usize;
    let session_len = read_u16(frame, 36) as usize;
    let episode_len = read_u16(frame, 38) as usize;
    let expected_len = RECORD_HEADER_LEN
        .checked_add(session_len)
        .and_then(|length| length.checked_add(episode_len))
        .and_then(|length| length.checked_add(payload_len))
        .ok_or_else(|| KernelError::new("record frame length overflow"))?;
    if frame.len() != expected_len {
        return Err(KernelError::new(
            "record frame payload length does not match",
        ));
    }
    let expected_checksum = read_u32(frame, RECORD_CHECKSUM_OFFSET);
    let actual_checksum = crc32_ieee_parts(&[
        &frame[..RECORD_CHECKSUM_OFFSET],
        &[0, 0, 0, 0],
        &frame[RECORD_CHECKSUM_OFFSET + 4..RECORD_HEADER_LEN],
        &frame[RECORD_HEADER_LEN..],
    ]);
    if actual_checksum != expected_checksum {
        return Err(KernelError::new("record frame checksum does not match"));
    }

    let session_offset = RECORD_HEADER_LEN;
    let episode_offset = session_offset + session_len;
    let payload_offset = episode_offset + episode_len;
    let session_id = std::str::from_utf8(&frame[session_offset..episode_offset])
        .map_err(|_| KernelError::new("record session identifier is not valid UTF-8"))?;
    let episode_id = std::str::from_utf8(&frame[episode_offset..payload_offset])
        .map_err(|_| KernelError::new("record episode identifier is not valid UTF-8"))?;
    if session_id.is_empty() || episode_id.is_empty() {
        return Err(KernelError::new("record identifiers must not be empty"));
    }

    Ok(RecordData {
        session_id: session_id.to_owned(),
        episode_id: episode_id.to_owned(),
        sequence: read_u64(frame, 8),
        recorder_frame_index: read_u64(frame, 16),
        source_timestamp_us: read_u64(frame, 24),
        flags: u32::from(read_u16(frame, 6)),
        checksum: expected_checksum,
        payload: frame[payload_offset..].to_vec(),
    })
}

#[wasm_bindgen]
pub fn encode_record(
    session_id: &str,
    episode_id: &str,
    sequence: u64,
    recorder_frame_index: u64,
    source_timestamp_us: u64,
    flags: u32,
    payload: &[u8],
) -> Result<Vec<u8>, JsValue> {
    encode_record_inner(
        session_id,
        episode_id,
        sequence,
        recorder_frame_index,
        source_timestamp_us,
        flags,
        payload,
    )
    .map_err(js_error)
}

#[wasm_bindgen]
pub struct DecodedRecord {
    data: RecordData,
}

#[wasm_bindgen]
impl DecodedRecord {
    #[wasm_bindgen(getter)]
    pub fn session_id(&self) -> String {
        self.data.session_id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn episode_id(&self) -> String {
        self.data.episode_id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn sequence(&self) -> u64 {
        self.data.sequence
    }

    #[wasm_bindgen(getter)]
    pub fn recorder_frame_index(&self) -> u64 {
        self.data.recorder_frame_index
    }

    #[wasm_bindgen(getter)]
    pub fn source_timestamp_us(&self) -> u64 {
        self.data.source_timestamp_us
    }

    #[wasm_bindgen(getter)]
    pub fn flags(&self) -> u32 {
        self.data.flags
    }

    #[wasm_bindgen(getter)]
    pub fn checksum(&self) -> u32 {
        self.data.checksum
    }

    pub fn payload(&self) -> Vec<u8> {
        self.data.payload.clone()
    }
}

#[wasm_bindgen]
pub fn decode_record(frame: &[u8]) -> Result<DecodedRecord, JsValue> {
    decode_record_inner(frame)
        .map(|data| DecodedRecord { data })
        .map_err(js_error)
}

#[wasm_bindgen]
pub struct FixedF32Ring {
    values: Vec<f32>,
    write_index: usize,
    len: usize,
}

#[wasm_bindgen]
impl FixedF32Ring {
    #[wasm_bindgen(constructor)]
    pub fn new(capacity: u32) -> Result<FixedF32Ring, JsValue> {
        if capacity == 0 {
            return Err(JsValue::from_str("ring capacity must be greater than zero"));
        }
        Ok(Self {
            values: vec![0.0; capacity as usize],
            write_index: 0,
            len: 0,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn capacity(&self) -> u32 {
        self.values.len() as u32
    }

    #[wasm_bindgen(getter)]
    pub fn len(&self) -> u32 {
        self.len as u32
    }

    #[wasm_bindgen(getter)]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn push(&mut self, value: f32) {
        self.values[self.write_index] = value;
        self.write_index = (self.write_index + 1) % self.values.len();
        self.len = (self.len + 1).min(self.values.len());
    }

    pub fn push_many(&mut self, input: &[f32]) {
        for &value in input {
            self.push(value);
        }
    }

    pub fn clear(&mut self) {
        self.write_index = 0;
        self.len = 0;
    }

    pub fn copy_chronological(&self) -> Vec<f32> {
        if self.len == 0 {
            return Vec::new();
        }
        let start = if self.len == self.values.len() {
            self.write_index
        } else {
            0
        };
        (0..self.len)
            .map(|offset| self.values[(start + offset) % self.values.len()])
            .collect()
    }

    pub fn mean(&self) -> f32 {
        if self.len == 0 {
            return 0.0;
        }
        let start = if self.len == self.values.len() {
            self.write_index
        } else {
            0
        };
        let total = (0..self.len)
            .map(|offset| self.values[(start + offset) % self.values.len()])
            .sum::<f32>();
        total / self.len as f32
    }

    pub fn rms(&self) -> f32 {
        if self.len == 0 {
            return 0.0;
        }
        let start = if self.len == self.values.len() {
            self.write_index
        } else {
            0
        };
        let total = (0..self.len)
            .map(|offset| {
                let value = self.values[(start + offset) % self.values.len()];
                value * value
            })
            .sum::<f32>();
        (total / self.len as f32).sqrt()
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn quaternion_norm_squared(values: &[f32]) -> f32 {
    use core::arch::wasm32::{f32x4_extract_lane, f32x4_mul, v128_load};

    let vector = unsafe { v128_load(values.as_ptr().cast()) };
    let squared = f32x4_mul(vector, vector);
    f32x4_extract_lane::<0>(squared)
        + f32x4_extract_lane::<1>(squared)
        + f32x4_extract_lane::<2>(squared)
        + f32x4_extract_lane::<3>(squared)
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn quaternion_norm_squared(values: &[f32]) -> f32 {
    values.iter().map(|value| value * value).sum()
}

fn normalise_quaternions_inner(values: &[f32]) -> Result<Vec<f32>, KernelError> {
    if !values.len().is_multiple_of(4) {
        return Err(KernelError::new(
            "quaternion input length must be a multiple of four",
        ));
    }
    let mut output = Vec::with_capacity(values.len());
    for quaternion in values.chunks_exact(4) {
        let norm_squared = quaternion_norm_squared(quaternion);
        if !norm_squared.is_finite() || norm_squared <= f32::EPSILON {
            output.extend_from_slice(&[0.0, 0.0, 0.0, 1.0]);
            continue;
        }
        let inverse_norm = norm_squared.sqrt().recip();
        output.extend(quaternion.iter().map(|value| value * inverse_norm));
    }
    Ok(output)
}

#[wasm_bindgen]
pub fn normalise_quaternions(values: &[f32]) -> Result<Vec<f32>, JsValue> {
    normalise_quaternions_inner(values).map_err(js_error)
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn sum_squares(values: &[f32]) -> f32 {
    use core::arch::wasm32::{f32x4_add, f32x4_extract_lane, f32x4_mul, f32x4_splat, v128_load};

    let chunks = values.chunks_exact(4);
    let remainder = chunks.remainder();
    let mut accumulator = f32x4_splat(0.0);
    for chunk in chunks {
        let vector = unsafe { v128_load(chunk.as_ptr().cast()) };
        accumulator = f32x4_add(accumulator, f32x4_mul(vector, vector));
    }
    f32x4_extract_lane::<0>(accumulator)
        + f32x4_extract_lane::<1>(accumulator)
        + f32x4_extract_lane::<2>(accumulator)
        + f32x4_extract_lane::<3>(accumulator)
        + remainder.iter().map(|value| value * value).sum::<f32>()
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn sum_squares(values: &[f32]) -> f32 {
    values.iter().map(|value| value * value).sum()
}

fn signal_rms_windows_inner(values: &[f32], window_size: usize) -> Result<Vec<f32>, KernelError> {
    if window_size == 0 {
        return Err(KernelError::new(
            "signal RMS window size must be greater than zero",
        ));
    }
    Ok(values
        .chunks(window_size)
        .map(|window| (sum_squares(window) / window.len() as f32).sqrt())
        .collect())
}

#[wasm_bindgen]
pub fn signal_rms_windows(values: &[f32], window_size: u32) -> Result<Vec<f32>, JsValue> {
    signal_rms_windows_inner(values, window_size as usize).map_err(js_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32c_matches_the_standard_vector() {
        assert_eq!(crc32c_parts(&[b"123456789"]), 0xe306_9283);
    }

    #[test]
    fn crc32_ieee_matches_the_standard_vector() {
        assert_eq!(crc32_ieee_parts(&[b"123456789"]), 0xcbf4_3926);
    }

    #[test]
    fn record_round_trip_preserves_every_accounting_field() {
        let frame = encode_record_inner(
            "session-7",
            "episode-11",
            13,
            17,
            19_000_000,
            0x21,
            b"telemetry",
        )
        .expect("record encodes");
        let decoded = decode_record_inner(&frame).expect("record decodes");
        assert_eq!(
            decoded,
            RecordData {
                session_id: "session-7".to_owned(),
                episode_id: "episode-11".to_owned(),
                sequence: 13,
                recorder_frame_index: 17,
                source_timestamp_us: 19_000_000,
                flags: 0x21,
                checksum: read_u32(&frame, RECORD_CHECKSUM_OFFSET),
                payload: b"telemetry".to_vec(),
            }
        );
    }

    #[test]
    fn record_checksum_covers_header_and_payload() {
        let mut frame = encode_record_inner("session", "episode", 3, 4, 5, 6, b"payload")
            .expect("record encodes");
        frame[24] ^= 1;
        assert_eq!(
            decode_record_inner(&frame).unwrap_err().0,
            "record frame checksum does not match"
        );
        let last = frame.len() - 1;
        frame[24] ^= 1;
        frame[last] ^= 1;
        assert_eq!(
            decode_record_inner(&frame).unwrap_err().0,
            "record frame checksum does not match"
        );
    }

    #[test]
    fn record_layout_matches_the_server_protocol() {
        let frame = encode_record_inner("s", "ep", 3, 5, 7, 9, &[11, 13]).expect("record encodes");
        assert_eq!(&frame[0..4], b"CRB1");
        assert_eq!(frame[4], 1);
        assert_eq!(frame[5], 48);
        assert_eq!(read_u16(&frame, 6), 9);
        assert_eq!(read_u64(&frame, 8), 3);
        assert_eq!(read_u64(&frame, 16), 5);
        assert_eq!(read_u64(&frame, 24), 7);
        assert_eq!(read_u32(&frame, 32), 2);
        assert_eq!(read_u16(&frame, 36), 1);
        assert_eq!(read_u16(&frame, 38), 2);
        assert_eq!(read_u32(&frame, 44), 0);
        assert_eq!(&frame[48..], &[b's', b'e', b'p', 11, 13]);
    }

    #[test]
    fn fixed_ring_retains_chronological_tail() {
        let mut ring = FixedF32Ring::new(3).expect("ring constructs");
        ring.push_many(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(ring.copy_chronological(), vec![3.0, 4.0, 5.0]);
        assert_eq!(ring.mean(), 4.0);
        assert!((ring.rms() - (50.0f32 / 3.0).sqrt()).abs() < 1e-6);
    }

    #[test]
    fn quaternion_kernel_normalises_and_repairs_zero_values() {
        let values = normalise_quaternions_inner(&[0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0])
            .expect("quaternions normalise");
        assert_eq!(values, vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn signal_kernel_emits_deterministic_partial_window_rms() {
        let values =
            signal_rms_windows_inner(&[3.0, 4.0, 0.0, 12.0, 5.0], 2).expect("signal processes");
        assert_eq!(values, vec![(12.5f32).sqrt(), (72.0f32).sqrt(), 5.0]);
    }
}
