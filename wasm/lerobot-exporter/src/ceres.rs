use std::collections::BTreeMap;

use serde::Deserialize;

use crate::error::{ExportError, Result};

pub const XR_HAND_JOINTS: [&str; 25] = [
    "wrist",
    "thumb-metacarpal",
    "thumb-phalanx-proximal",
    "thumb-phalanx-distal",
    "thumb-tip",
    "index-finger-metacarpal",
    "index-finger-phalanx-proximal",
    "index-finger-phalanx-intermediate",
    "index-finger-phalanx-distal",
    "index-finger-tip",
    "middle-finger-metacarpal",
    "middle-finger-phalanx-proximal",
    "middle-finger-phalanx-intermediate",
    "middle-finger-phalanx-distal",
    "middle-finger-tip",
    "ring-finger-metacarpal",
    "ring-finger-phalanx-proximal",
    "ring-finger-phalanx-intermediate",
    "ring-finger-phalanx-distal",
    "ring-finger-tip",
    "pinky-finger-metacarpal",
    "pinky-finger-phalanx-proximal",
    "pinky-finger-phalanx-intermediate",
    "pinky-finger-phalanx-distal",
    "pinky-finger-tip",
];

pub const CERES_TELEMETRY_DIM: usize = 411;
pub const CERES_STATE_DIM: usize = CERES_TELEMETRY_DIM - 1;
pub const CERES_ACTION_NAMES: [&str; 2] = ["left_hand.pinch_distance", "right_hand.pinch_distance"];

const HEAD_OFFSET: usize = 2;
const LEFT_TRACKED_OFFSET: usize = HEAD_OFFSET + 7;
const LEFT_JOINT_OFFSET: usize = LEFT_TRACKED_OFFSET + 1;
const RIGHT_TRACKED_OFFSET: usize = LEFT_JOINT_OFFSET + XR_HAND_JOINTS.len() * 8;
const RIGHT_JOINT_OFFSET: usize = RIGHT_TRACKED_OFFSET + 1;

const TRANSFORM_NAMES: [&str; 7] = [
    "position.x",
    "position.y",
    "position.z",
    "rotation.x",
    "rotation.y",
    "rotation.z",
    "rotation.w",
];

const JOINT_NAMES: [&str; 8] = [
    "position.x",
    "position.y",
    "position.z",
    "rotation.x",
    "rotation.y",
    "rotation.z",
    "rotation.w",
    "radius",
];

pub fn state_names() -> Vec<String> {
    let mut names = Vec::with_capacity(CERES_STATE_DIM);
    names.push("head.tracked".to_owned());
    names.extend(TRANSFORM_NAMES.map(|name| format!("head.{name}")));
    for hand in ["left_hand", "right_hand"] {
        names.push(format!("{hand}.tracked"));
        for joint in XR_HAND_JOINTS {
            names.extend(JOINT_NAMES.map(|name| format!("{hand}.{joint}.{name}")));
        }
    }
    debug_assert_eq!(names.len(), CERES_STATE_DIM);
    names
}

pub fn build_state(telemetry: &[f64], output: &mut Vec<f32>) -> Result<f64> {
    if telemetry.len() != CERES_TELEMETRY_DIM {
        return Err(ExportError::InvalidFrame(format!(
            "expected {CERES_TELEMETRY_DIM} telemetry values, received {}",
            telemetry.len()
        )));
    }
    let source_timestamp_us = telemetry[0];
    if !source_timestamp_us.is_finite() || source_timestamp_us < 0.0 {
        return Err(ExportError::InvalidFrame(
            "source timestamp must be a finite non-negative value".to_owned(),
        ));
    }
    output.clear();
    output.reserve(CERES_STATE_DIM.saturating_sub(output.capacity()));
    output.extend(telemetry[1..].iter().map(|value| {
        if value.is_finite() {
            *value as f32
        } else {
            0.0
        }
    }));
    Ok(source_timestamp_us / 1_000_000.0)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SensorFrameInput {
    timestamp_ms: f64,
    frame_index: u64,
    gap: Option<bool>,
    head: Option<TransformInput>,
    left_hand: HandInput,
    right_hand: HandInput,
}

#[derive(Debug, Deserialize)]
struct HandInput {
    tracked: bool,
    joints: BTreeMap<String, JointInput>,
    pinch: f64,
}

#[derive(Debug, Deserialize)]
struct JointInput {
    position: VectorInput,
    rotation: QuaternionInput,
    radius: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct TransformInput {
    position: VectorInput,
    rotation: QuaternionInput,
}

#[derive(Debug, Deserialize)]
struct VectorInput {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Deserialize)]
struct QuaternionInput {
    x: f64,
    y: f64,
    z: f64,
    w: f64,
}

pub struct ParsedSensorFrame {
    pub source_frame_index: u64,
    pub source_gap: Option<bool>,
    pub telemetry: [f64; CERES_TELEMETRY_DIM],
    pub action: [f32; CERES_ACTION_NAMES.len()],
}

pub fn parse_sensor_frame_json(value: &str) -> Result<ParsedSensorFrame> {
    let frame: SensorFrameInput = serde_json::from_str(value).map_err(|error| {
        ExportError::InvalidFrame(format!("sensor frame JSON is invalid: {error}"))
    })?;
    if !frame.timestamp_ms.is_finite() || frame.timestamp_ms < 0.0 {
        return Err(ExportError::InvalidFrame(
            "sensor timestamp must be a finite non-negative value".to_owned(),
        ));
    }
    let mut telemetry = [f64::NAN; CERES_TELEMETRY_DIM];
    telemetry[0] = frame.timestamp_ms * 1_000.0;
    let is_gap = frame.gap == Some(true);
    if is_gap {
        telemetry[1] = 0.0;
        telemetry[LEFT_TRACKED_OFFSET] = 0.0;
        telemetry[RIGHT_TRACKED_OFFSET] = 0.0;
    } else {
        telemetry[1] = if frame.head.is_some() { 1.0 } else { 0.0 };
        if let Some(head) = &frame.head {
            write_transform(&mut telemetry, HEAD_OFFSET, head, f64::NAN);
        }
        write_hand(
            &mut telemetry,
            LEFT_TRACKED_OFFSET,
            LEFT_JOINT_OFFSET,
            &frame.left_hand,
        );
        write_hand(
            &mut telemetry,
            RIGHT_TRACKED_OFFSET,
            RIGHT_JOINT_OFFSET,
            &frame.right_hand,
        );
    }
    Ok(ParsedSensorFrame {
        source_frame_index: frame.frame_index,
        source_gap: frame.gap,
        telemetry,
        action: if is_gap {
            [0.0, 0.0]
        } else {
            [
                finite_f32(frame.left_hand.pinch),
                finite_f32(frame.right_hand.pinch),
            ]
        },
    })
}

fn write_hand(
    telemetry: &mut [f64; CERES_TELEMETRY_DIM],
    tracked_offset: usize,
    joint_offset: usize,
    hand: &HandInput,
) {
    telemetry[tracked_offset] = if hand.tracked { 1.0 } else { 0.0 };
    if !hand.tracked {
        return;
    }
    for (index, name) in XR_HAND_JOINTS.iter().enumerate() {
        if let Some(joint) = hand.joints.get(*name) {
            write_transform(
                telemetry,
                joint_offset + index * 8,
                &TransformInput {
                    position: VectorInput {
                        x: joint.position.x,
                        y: joint.position.y,
                        z: joint.position.z,
                    },
                    rotation: QuaternionInput {
                        x: joint.rotation.x,
                        y: joint.rotation.y,
                        z: joint.rotation.z,
                        w: joint.rotation.w,
                    },
                },
                joint.radius.unwrap_or(f64::NAN),
            );
        }
    }
}

fn write_transform(
    telemetry: &mut [f64; CERES_TELEMETRY_DIM],
    offset: usize,
    transform: &TransformInput,
    radius: f64,
) {
    telemetry[offset] = transform.position.x;
    telemetry[offset + 1] = transform.position.y;
    telemetry[offset + 2] = transform.position.z;
    telemetry[offset + 3] = transform.rotation.x;
    telemetry[offset + 4] = transform.rotation.y;
    telemetry[offset + 5] = transform.rotation.z;
    telemetry[offset + 6] = transform.rotation.w;
    if offset != HEAD_OFFSET {
        telemetry[offset + 7] = radius;
    }
}

fn finite_f32(value: f64) -> f32 {
    if value.is_finite() { value as f32 } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_ceres_recorder_layout() {
        let names = state_names();
        assert_eq!(names.len(), 410);
        assert_eq!(names[0], "head.tracked");
        assert_eq!(names[8], "left_hand.tracked");
        assert_eq!(names[209], "right_hand.tracked");
        assert_eq!(names[409], "right_hand.pinky-finger-tip.radius");
    }

    #[test]
    fn replaces_untracked_nan_slots_with_zero() {
        let mut telemetry = vec![f64::NAN; CERES_TELEMETRY_DIM];
        telemetry[0] = 2_000_000.0;
        telemetry[1] = 1.0;
        let mut output = Vec::new();
        let timestamp = build_state(&telemetry, &mut output).unwrap();
        assert_eq!(timestamp, 2.0);
        assert_eq!(output[0], 1.0);
        assert!(output[1..].iter().all(|value| *value == 0.0));
    }

    #[test]
    fn parses_server_sensor_rows_with_rust_owned_actions() {
        let parsed = parse_sensor_frame_json(
            r#"{
                "timestampMs": 1234.5,
                "frameIndex": 7,
                "head": {"position":{"x":1,"y":2,"z":3},"rotation":{"x":0,"y":0,"z":0,"w":1}},
                "leftHand": {"tracked":true,"pinch":0.02,"joints":{"wrist":{"position":{"x":4,"y":5,"z":6},"rotation":{"x":0,"y":0,"z":0,"w":1},"radius":0.01}}},
                "rightHand": {"tracked":false,"pinch":0.03,"joints":{}},
                "sceneStatus": {"planes":true,"meshes":true,"anchors":true}
            }"#,
        )
        .unwrap();
        assert_eq!(parsed.source_frame_index, 7);
        assert_eq!(parsed.source_gap, None);
        assert_eq!(parsed.telemetry[0], 1_234_500.0);
        assert_eq!(parsed.telemetry[1], 1.0);
        assert_eq!(parsed.telemetry[LEFT_TRACKED_OFFSET], 1.0);
        assert_eq!(parsed.telemetry[LEFT_JOINT_OFFSET], 4.0);
        assert_eq!(parsed.telemetry[LEFT_JOINT_OFFSET + 7], 0.01);
        assert_eq!(parsed.telemetry[RIGHT_TRACKED_OFFSET], 0.0);
        assert_eq!(parsed.action, [0.02, 0.03]);
    }

    #[test]
    fn explicit_gap_rows_are_untracked_synthetic_observations() {
        let parsed = parse_sensor_frame_json(
            r#"{
                "timestampMs": 1300,
                "frameIndex": 8,
                "gap": true,
                "head": {"position":{"x":1,"y":2,"z":3},"rotation":{"x":0,"y":0,"z":0,"w":1}},
                "leftHand": {"tracked":true,"pinch":0.8,"joints":{}},
                "rightHand": {"tracked":true,"pinch":0.9,"joints":{}}
            }"#,
        )
        .unwrap();
        assert_eq!(parsed.source_frame_index, 8);
        assert_eq!(parsed.source_gap, Some(true));
        assert_eq!(parsed.telemetry[0], 1_300_000.0);
        assert_eq!(parsed.telemetry[1], 0.0);
        assert_eq!(parsed.telemetry[LEFT_TRACKED_OFFSET], 0.0);
        assert_eq!(parsed.telemetry[RIGHT_TRACKED_OFFSET], 0.0);
        assert_eq!(parsed.action, [0.0, 0.0]);
    }
}
