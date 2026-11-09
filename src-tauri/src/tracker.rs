//! Reading goals, schedules, reminders (native notifications) and detailed stats.
use crate::db::Db;
use crate::error::AppResult;
use chrono::{Datelike, Local, NaiveDate, NaiveTime, Timelike};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Goal { pub id: i64, pub kind: String, pub target: i64, pub active: bool }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schedule {
    pub id: i64,
    pub label: String,
    /// bit 0 = Monday … bit 6 = Sunday
    pub weekdays: i64,
    pub time: String,
    pub book_id: Option<i64>,
    pub minutes: i64,
    pub enabled: bool,
}

pub fn list_goals(c: &Connection) -> AppResult<Vec<Goal>> {
    Ok(c.prepare("SELECT id, kind, target, active FROM goals ORDER BY id")?
        .query_map([], |r| Ok(Goal { id: r.get(0)?, kind: r.get(1)?, target: r.get(2)?, active: r.get::<_, i64>(3)? != 0 }))?
        .collect::<Result<_, _>>()?)
}

pub fn save_goal(c: &Connection, g: &Goal) -> AppResult<i64> {
    if g.id > 0 {
        c.execute("UPDATE goals SET kind=?, target=?, active=? WHERE id=?", params![g.kind, g.target, g.active as i64, g.id])?;
        Ok(g.id)
    } else {
        // one goal per kind
        c.execute("DELETE FROM goals WHERE kind = ?", [&g.kind])?;
        c.execute("INSERT INTO goals (kind, target, active) VALUES (?, ?, ?)", params![g.kind, g.target, g.active as i64])?;
        Ok(c.last_insert_rowid())
    }
}

pub fn list_schedules(c: &Connection) -> AppResult<Vec<Schedule>> {
    Ok(c.prepare("SELECT id, label, weekdays, time, book_id, minutes, enabled FROM schedules ORDER BY time")?
        .query_map([], |r| Ok(Schedule { id: r.get(0)?, label: r.get(1)?, weekdays: r.get(2)?, time: r.get(3)?, book_id: r.get(4)?, minutes: r.get(5)?, enabled: r.get::<_, i64>(6)? != 0 }))?
        .collect::<Result<_, _>>()?)
}

pub fn save_schedule(c: &Connection, s: &Schedule) -> AppResult<i64> {
    if s.id > 0 {
        c.execute("UPDATE schedules SET label=?, weekdays=?, time=?, book_id=?, minutes=?, enabled=? WHERE id=?", params![s.label, s.weekdays, s.time, s.book_id, s.minutes, s.enabled as i64, s.id])?;
        Ok(s.id)
    } else {
        c.execute("INSERT INTO schedules (label, weekdays, time, book_id, minutes, enabled) VALUES (?, ?, ?, ?, ?, ?)", params![s.label, s.weekdays, s.time, s.book_id, s.minutes, s.enabled as i64])?;
        Ok(c.last_insert_rowid())
    }
}

/// Is the schedule due at `now` (same minute or up to 5 minutes late, to survive sleep/ticks)?
pub fn is_due(s: &Schedule, now: chrono::NaiveDateTime) -> bool {
    if !s.enabled { return false; }
    let wd = now.weekday().num_days_from_monday() as i64;
    if s.weekdays & (1 << wd) == 0 { return false; }
    let Ok(t) = NaiveTime::parse_from_str(&s.time, "%H:%M") else { return false };
    let mins_now = now.hour() as i64 * 60 + now.minute() as i64;
    let mins_t = t.hour() as i64 * 60 + t.minute() as i64;
    (0..=5).contains(&(mins_now - mins_t))
}

#[derive(Debug, Serialize, Default)]
pub struct DayStat { pub date: String, pub seconds: i64 }
#[derive(Debug, Serialize, Default)]
pub struct BookStat { pub book_id: i64, pub title: String, pub seconds: i64, pub percent: f64, pub sessions: i64, pub sec_per_percent: Option<f64> }
#[derive(Debug, Serialize, Default)]
pub struct GoalProgress { pub kind: String, pub target: i64, pub current: i64 }

#[derive(Debug, Serialize, Default)]
pub struct DetailedStats {
    pub days: Vec<DayStat>,
    pub books: Vec<BookStat>,
    pub today_seconds: i64,
    pub week_seconds: i64,
    pub total_seconds: i64,
    pub finished_this_year: i64,
    pub finished_total: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub goals: Vec<GoalProgress>,
}

pub fn streaks(dates: &[NaiveDate], today: NaiveDate) -> (i64, i64) {
    let mut d: Vec<NaiveDate> = dates.to_vec();
    d.sort();
    d.dedup();
    let (mut longest, mut run) = (0i64, 0i64);
    for (i, x) in d.iter().enumerate() {
        run = if i > 0 && *x == d[i - 1].succ_opt().unwrap() { run + 1 } else { 1 };
        longest = longest.max(run);
    }
    // current: ends today or yesterday
    let mut current = 0;
    let mut expect = today;
    if !d.contains(&today) { expect = today.pred_opt().unwrap(); }
    while d.contains(&expect) { current += 1; expect = expect.pred_opt().unwrap(); }
    (current, longest)
}

pub fn detailed(c: &Connection) -> AppResult<DetailedStats> {
    let mut s = DetailedStats::default();
    s.days = c.prepare("SELECT date(started_at,'localtime') d, sum(seconds) FROM reading_sessions WHERE started_at >= date('now','-370 days') GROUP BY d ORDER BY d")?
        .query_map([], |r| Ok(DayStat { date: r.get(0)?, seconds: r.get(1)? }))?
        .collect::<Result<_, _>>()?;
    s.books = c.prepare(
        "SELECT b.id, b.title, sum(r.seconds), COALESCE(p.percent,0), count(*),
                sum(r.seconds) / NULLIF(sum(MAX(0, COALESCE(r.end_percent,0) - COALESCE(r.start_percent,0))) * 100, 0)
         FROM reading_sessions r JOIN books b ON b.id = r.book_id LEFT JOIN progress p ON p.book_id = b.id
         GROUP BY b.id ORDER BY max(r.started_at) DESC LIMIT 50",
    )?
    .query_map([], |r| Ok(BookStat { book_id: r.get(0)?, title: r.get(1)?, seconds: r.get(2)?, percent: r.get(3)?, sessions: r.get(4)?, sec_per_percent: r.get(5)? }))?
    .collect::<Result<_, _>>()?;
    let q = |sql: &str| -> AppResult<i64> { Ok(c.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))?.unwrap_or(0)) };
    s.today_seconds = q("SELECT sum(seconds) FROM reading_sessions WHERE date(started_at,'localtime') = date('now','localtime')")?;
    s.week_seconds = q("SELECT sum(seconds) FROM reading_sessions WHERE date(started_at,'localtime') >= date('now','localtime','weekday 1','-7 days')")?;
    s.total_seconds = q("SELECT sum(seconds) FROM reading_sessions")?;
    s.finished_total = q("SELECT count(*) FROM books WHERE status = 'finished'")?;
    s.finished_this_year = q("SELECT count(*) FROM books WHERE status = 'finished' AND strftime('%Y', updated_at) = strftime('%Y','now')")?;
    let dates: Vec<NaiveDate> = s.days.iter().filter_map(|d| NaiveDate::parse_from_str(&d.date, "%Y-%m-%d").ok()).collect();
    (s.current_streak, s.longest_streak) = streaks(&dates, Local::now().date_naive());
    let pages_today = q("SELECT sum(pages) FROM reading_sessions WHERE date(started_at,'localtime') = date('now','localtime')")?;
    for g in list_goals(c)?.into_iter().filter(|g| g.active) {
        let current = match g.kind.as_str() {
            "daily_minutes" => s.today_seconds / 60,
            "weekly_minutes" => s.week_seconds / 60,
            "yearly_books" => s.finished_this_year,
            "daily_pages" => pages_today,
            "daily_reviews" => q("SELECT count(*) FROM reviews WHERE date(reviewed_at,'localtime') = date('now','localtime')")?,
            _ => 0,
        };
        s.goals.push(GoalProgress { kind: g.kind, target: g.target, current });
    }
    Ok(s)
}

fn once(c: &Connection, key: &str) -> AppResult<bool> {
    let seen: Option<String> = c.query_row("SELECT key FROM reminders_log WHERE key = ?", [key], |r| r.get(0)).optional()?;
    if seen.is_some() { return Ok(false); }
    c.execute("INSERT INTO reminders_log (key, sent_at) VALUES (?, datetime('now'))", [key])?;
    Ok(true)
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[Tracker] notification failed: {e}");
    }
}

/// Background loop: schedules → "time to read" notifications; evening nudge if the daily goal is unmet.
pub fn start(app: AppHandle, db: Db) {
    tauri::async_runtime::spawn(async move {
        loop {
            let now = Local::now().naive_local();
            let today = now.date().to_string();
            let res: AppResult<()> = (|| {
                let (schedules, nudge_time, stats) = db.with(|c| Ok((list_schedules(c)?, c.query_row("SELECT value FROM kv WHERE key='nudge_time'", [], |r| r.get::<_, String>(0)).optional()?, detailed(c)?)))?;
                for s in schedules.iter().filter(|s| is_due(s, now)) {
                    if !db.with(|c| once(c, &format!("schedule:{}:{today}", s.id)))? { continue; }
                    let title = match s.book_id {
                        Some(b) => db.with(|c| Ok(c.query_row("SELECT title FROM books WHERE id = ?", [b], |r| r.get::<_, String>(0)).optional()?))?,
                        None => None,
                    };
                    let body = match &title {
                        Some(t) => format!("{} min with “{t}”", s.minutes),
                        None => format!("{} minutes of reading{}", s.minutes, if s.label.is_empty() { String::new() } else { format!(" · {}", s.label) }),
                    };
                    notify(&app, "Time to read 📖", &body);
                    let _ = app.emit("reading_reminder", serde_json::json!({ "book_id": s.book_id, "schedule_id": s.id }));
                }
                // Evening nudge (default 20:30) for an unmet daily goal.
                let nt = nudge_time.unwrap_or_else(|| "20:30".into());
                let probe = Schedule { id: 0, label: String::new(), weekdays: 127, time: nt, book_id: None, minutes: 0, enabled: true };
                if is_due(&probe, now) {
                    let due_cards: i64 = db.with(|c| Ok(c.query_row("SELECT count(*) FROM cards WHERE suspended = 0 AND is_new = 0 AND due <= strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| r.get(0))?)).unwrap_or(0);
                    let reading = stats.goals.iter().find(|g| g.kind == "daily_minutes" && g.current < g.target);
                    if (reading.is_some() || due_cards > 0) && db.with(|c| once(c, &format!("nudge:{today}")))? {
                        let mut parts = vec![];
                        if let Some(g) = reading { parts.push(format!("{} of {} reading minutes today", g.current, g.target)); }
                        if due_cards > 0 { parts.push(format!("{due_cards} flashcards due")); }
                        notify(&app, "Before the day ends", &parts.join(" · "));
                    }
                }
                Ok(())
            })();
            if let Err(e) = res { eprintln!("[Tracker] {e}"); }
            tokio::time::sleep(std::time::Duration::from_secs(60 - (Local::now().second() as u64).min(59))).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_logic() {
        let s = Schedule { id: 1, label: "".into(), weekdays: 0b0011111, time: "21:00".into(), book_id: None, minutes: 30, enabled: true };
        let fri = NaiveDate::from_ymd_opt(2026, 11, 6).unwrap(); // Friday
        let sat = NaiveDate::from_ymd_opt(2026, 11, 7).unwrap();
        assert!(is_due(&s, fri.and_hms_opt(21, 0, 0).unwrap()));
        assert!(is_due(&s, fri.and_hms_opt(21, 4, 0).unwrap()));
        assert!(!is_due(&s, fri.and_hms_opt(21, 7, 0).unwrap()));
        assert!(!is_due(&s, fri.and_hms_opt(20, 59, 0).unwrap()));
        assert!(!is_due(&s, sat.and_hms_opt(21, 0, 0).unwrap()), "weekends excluded");
    }

    #[test]
    fn streak_counting() {
        let d = |x: u32| NaiveDate::from_ymd_opt(2026, 11, x).unwrap();
        assert_eq!(streaks(&[d(1), d(2), d(3), d(5), d(6)], d(7)), (2, 3));
        assert_eq!(streaks(&[d(1), d(2), d(7)], d(7)), (1, 2));
        assert_eq!(streaks(&[], d(7)), (0, 0));
    }

    #[test]
    fn stats_and_goals() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let b = crate::library::store::insert_book(c, "B", &[], None)?;
            c.execute("INSERT INTO reading_sessions (book_id, started_at, ended_at, seconds, start_percent, end_percent, pages) VALUES (?, datetime('now'), datetime('now'), 1200, 0.1, 0.2, 12)", [b])?;
            save_goal(c, &Goal { id: 0, kind: "daily_minutes".into(), target: 30, active: true })?;
            let s = detailed(c)?;
            assert_eq!(s.today_seconds, 1200);
            assert_eq!(s.goals[0].current, 20);
            assert_eq!(s.current_streak, 1);
            assert!(s.books[0].sec_per_percent.unwrap() > 0.0);
            Ok(())
        }).unwrap();
    }
}
