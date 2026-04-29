/// Basic 3D vector for molecular coordinates.
/// Designed for high performance without external dependencies.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vec3(pub f64, pub f64, pub f64);

impl Vec3 {
    pub const ZERO: Self = Vec3(0.0, 0.0, 0.0);

    pub fn add(self, other: Self) -> Self {
        Vec3(self.0 + other.0, self.1 + other.1, self.2 + other.2)
    }

    pub fn sub(self, other: Self) -> Self {
        Vec3(self.0 - other.0, self.1 - other.1, self.2 - other.2)
    }

    pub fn mul(self, scalar: f64) -> Self {
        Vec3(self.0 * scalar, self.1 * scalar, self.2 * scalar)
    }

    pub fn dot(self, other: Self) -> f64 {
        self.0 * other.0 + self.1 * other.1 + self.2 * other.2
    }

    pub fn cross(self, other: Self) -> Self {
        Vec3(
            self.1 * other.2 - self.2 * other.1,
            self.2 * other.0 - self.0 * other.2,
            self.0 * other.1 - self.1 * other.0,
        )
    }

    pub fn length_squared(self) -> f64 {
        self.dot(self)
    }

    pub fn length(self) -> f64 {
        self.length_squared().sqrt()
    }

    pub fn normalize(self) -> Self {
        let len = self.length();
        if len > 0.0 {
            self.mul(1.0 / len)
        } else {
            // Default to X-axis if normalization fails to avoid NaN.
            Vec3(1.0, 0.0, 0.0)
        }
    }

    pub fn dist(self, other: Self) -> f64 {
        self.sub(other).length()
    }

    /// Calculates the angle (in radians) between this vector and another.
    pub fn angle(self, other: Self) -> f64 {
        let dot = self.normalize().dot(other.normalize());
        // Clamp to avoid NaN from floating point precision issues.
        dot.clamp(-1.0, 1.0).acos()
    }
}

impl From<[f64; 3]> for Vec3 {
    fn from(p: [f64; 3]) -> Self {
        Vec3(p[0], p[1], p[2])
    }
}

impl From<Vec3> for [f64; 3] {
    fn from(v: Vec3) -> Self {
        [v.0, v.1, v.2]
    }
}