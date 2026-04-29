use chrono::{DateTime, Utc};

pub fn now() -> DateTime<Utc> {
    Utc::now()
}
