use crate::error::{ExportError, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScalarStats {
    pub count: u64,
    pub mean: f64,
    pub m2: f64,
    pub min: f64,
    pub max: f64,
}

impl Default for ScalarStats {
    fn default() -> Self {
        Self {
            count: 0,
            mean: 0.0,
            m2: 0.0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
        }
    }
}

impl ScalarStats {
    pub fn update(&mut self, value: f64) {
        debug_assert!(value.is_finite());
        self.count += 1;
        let delta = value - self.mean;
        self.mean += delta / self.count as f64;
        let delta_after = value - self.mean;
        self.m2 += delta * delta_after;
        self.min = self.min.min(value);
        self.max = self.max.max(value);
    }

    pub fn merge(&mut self, other: Self) {
        if other.count == 0 {
            return;
        }
        if self.count == 0 {
            *self = other;
            return;
        }
        let combined_count = self.count + other.count;
        let delta = other.mean - self.mean;
        self.mean += delta * other.count as f64 / combined_count as f64;
        self.m2 += other.m2
            + delta * delta * self.count as f64 * other.count as f64 / combined_count as f64;
        self.count = combined_count;
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
    }

    pub fn std(&self) -> f64 {
        if self.count == 0 {
            0.0
        } else {
            (self.m2 / self.count as f64).max(0.0).sqrt()
        }
    }
}

#[derive(Debug, Clone)]
pub struct FeatureStats {
    dimensions: Vec<ScalarStats>,
}

impl FeatureStats {
    pub fn new(dimensions: usize) -> Self {
        Self {
            dimensions: vec![ScalarStats::default(); dimensions],
        }
    }

    pub fn update_scalar(&mut self, value: f64) {
        debug_assert_eq!(self.dimensions.len(), 1);
        self.dimensions[0].update(value);
    }

    pub fn merge_partial(&mut self, partial: &[ScalarStats]) -> Result<()> {
        if partial.len() != self.dimensions.len() {
            return Err(ExportError::InvalidFrame(
                "partial statistics dimension mismatch".to_owned(),
            ));
        }
        for (stats, other) in self.dimensions.iter_mut().zip(partial) {
            stats.merge(*other);
        }
        Ok(())
    }

    pub fn dimensions(&self) -> &[ScalarStats] {
        &self.dimensions
    }

    pub fn count(&self) -> u64 {
        self.dimensions.first().map_or(0, |stats| stats.count)
    }
}

pub fn reduce_row_major(
    values: &[f32],
    rows: usize,
    dimensions: usize,
) -> Result<Vec<ScalarStats>> {
    if values.len() != rows.saturating_mul(dimensions) {
        return Err(ExportError::InvalidFrame(
            "reduction buffer shape does not match its values".to_owned(),
        ));
    }
    let mut output = vec![ScalarStats::default(); dimensions];
    for row in values.chunks_exact(dimensions) {
        for (stats, value) in output.iter_mut().zip(row) {
            stats.update(f64::from(*value));
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn welford_remains_stable_for_large_offsets() {
        let mut stats = ScalarStats::default();
        for value in [1_000_000_000.0, 1_000_000_001.0, 1_000_000_002.0] {
            stats.update(value);
        }
        assert_eq!(stats.mean, 1_000_000_001.0);
        assert!((stats.std() - (2.0_f64 / 3.0).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn parallel_merge_matches_a_single_pass() {
        let values = [1.0, 10.0, 2.0, 20.0, 3.0, 30.0, 4.0, 40.0];
        let all = reduce_row_major(&values, 4, 2).unwrap();
        let left = reduce_row_major(&values[..4], 2, 2).unwrap();
        let right = reduce_row_major(&values[4..], 2, 2).unwrap();
        let mut merged = FeatureStats::new(2);
        merged.merge_partial(&left).unwrap();
        merged.merge_partial(&right).unwrap();
        for (actual, expected) in merged.dimensions().iter().zip(all) {
            assert!((actual.mean - expected.mean).abs() < 1e-12);
            assert!((actual.m2 - expected.m2).abs() < 1e-12);
        }
    }
}
