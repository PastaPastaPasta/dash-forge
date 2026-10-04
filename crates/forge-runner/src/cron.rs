//! `on.schedule` cron expressions, read as GitHub reads them: five fields (minute, hour, day of
//! the month, month, day of the week), in UTC, each `*`, a value, a range `a-b`, a step `/n` on
//! either, or a comma-separated list of those. Months and days may be named (`JAN`, `MON`), and a
//! day of the week of 7 is Sunday. When both day fields are restricted (neither starts with
//! `*`), a day matches if either does, as in POSIX cron.

/// A parsed expression: each field as a bit set of the values it matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minute: u64,
    hour: u64,
    dom: u64,
    month: u64,
    dow: u64,
    /// Both day fields restricted: either matching is enough.
    either_day: bool,
}

const MONTHS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];
const DAYS: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/// The most minutes [`Cron::fires_in`] looks back over: a runner that was down longer runs a
/// missed schedule at most once, for its last week.
const MAX_SCAN_MINUTES: u64 = 7 * 24 * 60;

impl Cron {
    /// Parse `expr`, or say why it is not a cron expression this runner reads.
    pub fn parse(expr: &str) -> Result<Self, String> {
        let f: Vec<&str> = expr.split_whitespace().collect();
        let [minute, hour, dom, month, dow] = f[..] else {
            return Err(format!("{expr:?} does not have five fields"));
        };
        Ok(Cron {
            minute: field(minute, 0, 59, &[])?,
            hour: field(hour, 0, 23, &[])?,
            dom: field(dom, 1, 31, &[])?,
            month: field(month, 1, 12, &MONTHS)?,
            // 0–7, 7 folded onto Sunday (0).
            dow: {
                let b = field(dow, 0, 7, &DAYS)?;
                (b | (b >> 7)) & 0x7f
            },
            either_day: !dom.starts_with('*') && !dow.starts_with('*'),
        })
    }

    /// Whether the expression fires at `minute` (whole minutes since 1970, UTC).
    pub fn matches(&self, minute: u64) -> bool {
        let (_, month, day) = civil_from_days(minute / 1440);
        let weekday = (minute / 1440 + 4) % 7; // 1970-01-01 was a Thursday.
        let has = |set: u64, v: u64| set & (1 << v) != 0;
        let dom = has(self.dom, day);
        let dow = has(self.dow, weekday);
        has(self.minute, minute % 60)
            && has(self.hour, minute / 60 % 24)
            && has(self.month, month)
            && if self.either_day {
                dom || dow
            } else {
                dom && dow
            }
    }

    /// Whether it fires at a minute after `after_ms` and at or before `upto_ms` (ms since 1970).
    /// Only the last [`MAX_SCAN_MINUTES`] of a longer window are looked at.
    pub fn fires_in(&self, after_ms: u64, upto_ms: u64) -> bool {
        let last = upto_ms / 60_000;
        let first = (after_ms / 60_000 + 1).max(last.saturating_sub(MAX_SCAN_MINUTES - 1));
        (first..=last).any(|m| self.matches(m))
    }
}

/// One field's values in `lo..=hi` as a bit set.
fn field(text: &str, lo: u64, hi: u64, names: &[&str]) -> Result<u64, String> {
    let value = |s: &str| -> Result<u64, String> {
        let v = names
            .iter()
            .position(|n| n.eq_ignore_ascii_case(s))
            .map(|i| i as u64 + u64::from(names.len() == 12))
            .map_or_else(
                || {
                    s.parse::<u64>()
                        .map_err(|_| format!("{s:?} is not a value"))
                },
                Ok,
            )?;
        if (lo..=hi).contains(&v) {
            Ok(v)
        } else {
            Err(format!("{v} is outside {lo}-{hi}"))
        }
    };
    let mut bits = 0u64;
    for item in text.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((r, s)) => {
                let s: u64 = s.parse().map_err(|_| format!("{s:?} is not a step"))?;
                if s == 0 {
                    return Err("a step of 0".into());
                }
                (r, s)
            }
            None => (item, 1),
        };
        let (a, b) = if range == "*" {
            (lo, hi)
        } else if let Some((a, b)) = range.split_once('-') {
            (value(a)?, value(b)?)
        } else {
            let a = value(range)?;
            // `a/n` runs from a to the end, as in vixie cron (and GitHub).
            (a, if item.contains('/') { hi } else { a })
        };
        if a > b {
            return Err(format!("{range:?} runs backwards"));
        }
        for v in (a..=b).step_by(usize::try_from(step).unwrap_or(usize::MAX)) {
            bits |= 1 << v;
        }
    }
    Ok(bits)
}

/// The (year, month, day) of `days` since 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minutes since 1970 of a UTC date and time.
    fn at(y: u64, mo: u64, d: u64, h: u64, mi: u64) -> u64 {
        // Days from civil (Hinnant), the inverse of civil_from_days.
        let y = if mo <= 2 { y - 1 } else { y };
        let era = y / 400;
        let yoe = y - era * 400;
        let mp = if mo > 2 { mo - 3 } else { mo + 9 };
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        (days * 24 + h) * 60 + mi
    }

    #[test]
    fn dates_round_trip() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(at(2000, 2, 29, 0, 0) / 1440), (2000, 2, 29));
        assert_eq!(civil_from_days(at(2026, 10, 4, 0, 0) / 1440), (2026, 10, 4));
    }

    #[test]
    fn fields_match_as_github_reads_them() {
        let every15 = Cron::parse("*/15 * * * *").unwrap();
        assert!(every15.matches(at(2026, 10, 4, 3, 45)));
        assert!(!every15.matches(at(2026, 10, 4, 3, 46)));
        let nightly = Cron::parse("30 5 * * 1-5").unwrap(); // weekdays 05:30
        assert!(nightly.matches(at(2026, 10, 5, 5, 30)), "a Monday");
        assert!(!nightly.matches(at(2026, 10, 4, 5, 30)), "a Sunday");
        let named = Cron::parse("0 0 1 jan,JUL SUN").unwrap();
        // Both day fields restricted: the 1st or any Sunday, in January or July.
        assert!(named.matches(at(2026, 7, 1, 0, 0)), "the 1st, a Wednesday");
        assert!(named.matches(at(2026, 7, 5, 0, 0)), "a Sunday");
        assert!(!named.matches(at(2026, 7, 6, 0, 0)));
        assert!(!named.matches(at(2026, 8, 1, 0, 0)), "not August");
        let sunday7 = Cron::parse("0 12 * * 7").unwrap();
        assert!(sunday7.matches(at(2026, 10, 4, 12, 0)), "7 is Sunday");
        let one = Cron::parse("5/1 * * * *").unwrap();
        assert!(
            one.matches(at(2026, 1, 1, 0, 6)),
            "a/1 runs from a to the end"
        );
        let stepped = Cron::parse("5/20 * * * *").unwrap();
        assert!(stepped.matches(at(2026, 1, 1, 0, 45)) && !stepped.matches(at(2026, 1, 1, 0, 0)));
        let list = Cron::parse("0 9-17/4,23 * * *").unwrap();
        for (h, want) in [(9, true), (13, true), (17, true), (11, false), (23, true)] {
            assert_eq!(list.matches(at(2026, 1, 1, h, 0)), want, "{h}:00");
        }
    }

    #[test]
    fn bad_expressions_are_refused() {
        for bad in [
            "* * * *",
            "* * * * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * * 13 *",
            "* * * * 8",
            "*/0 * * * *",
            "5-1 * * * *",
            "@daily",
            "x * * * *",
        ] {
            assert!(Cron::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_window_fires_once_for_every_minute_in_it() {
        let hourly = Cron::parse("0 * * * *").unwrap();
        let ms = |m: u64| m * 60_000;
        let t = at(2026, 10, 4, 3, 0);
        assert!(
            hourly.fires_in(ms(t) - 1, ms(t)),
            "the minute itself counts"
        );
        assert!(
            !hourly.fires_in(ms(t), ms(t) + 59_999),
            "after it, not again"
        );
        assert!(hourly.fires_in(ms(t) - 1, ms(t) + 30_000));
        assert!(!hourly.fires_in(ms(t + 1), ms(t + 59)));
        assert!(
            hourly.fires_in(0, ms(t)),
            "a long window looks at its last week only"
        );
        let yearly = Cron::parse("0 0 1 1 *").unwrap();
        assert!(!yearly.fires_in(0, ms(at(2026, 10, 4, 0, 0))));
    }
}
