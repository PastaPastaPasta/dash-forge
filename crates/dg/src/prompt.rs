//! Interactive prompts (UX spec §7.1): asked only when stdin is a terminal and neither
//! `--yes` nor `--json` is set ([`crate::context::Ctx::interactive`]); every flow that asks
//! prints the equivalent flags afterwards, so it can be re-run without the questions.
//!
//! Flows are written against [`Prompter`] so their question → answer logic is testable with
//! scripted answers; [`TtyPrompter`] is the terminal implementation (questions on stderr,
//! answers from stdin, secrets read from the terminal without echo).

use std::io::{BufRead, Write};

use anyhow::{Context as _, Result};

use forge_core::keystore::Secret;

/// Something that can answer the questions of a prompt flow.
pub trait Prompter {
    /// A line of text. `default`: `None` means an answer is required; `Some(d)` is used for
    /// an empty answer (`Some("")` makes the field optional). `hint` says where to find the
    /// value.
    fn text(&mut self, question: &str, hint: &str, default: Option<&str>) -> Result<String>;
    /// One of `options`, as its index (`default` for an empty answer).
    fn choose(&mut self, question: &str, options: &[&str], default: usize) -> Result<usize>;
    /// A secret, never echoed.
    fn secret(&mut self, question: &str, hint: &str) -> Result<Secret>;
    /// Yes or no.
    fn confirm(&mut self, question: &str, default: bool) -> Result<bool>;
    /// A line of output between questions (why an answer was refused).
    fn say(&mut self, line: &str) {
        eprintln!("{line}");
    }
}

/// Ask `question` until `check` accepts the answer (it returns why not, shown before asking
/// again).
pub fn text_valid(
    p: &mut dyn Prompter,
    question: &str,
    hint: &str,
    default: Option<&str>,
    check: impl Fn(&str) -> std::result::Result<(), String>,
) -> Result<String> {
    loop {
        let answer = p.text(question, hint, default)?;
        match check(&answer) {
            Ok(()) => return Ok(answer),
            Err(why) => p.say(&format!("  ✗ {why}")),
        }
    }
}

/// Prompts on the terminal: questions and hints on stderr, answers from stdin.
pub struct TtyPrompter;

/// Dim text on a colour terminal.
fn dim(s: &str) -> String {
    if forge_core::user_error::stderr_color() {
        format!("\x1b[2m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

fn read_line() -> Result<String> {
    let mut line = String::new();
    let n = std::io::stdin()
        .lock()
        .read_line(&mut line)
        .context("reading an answer")?;
    if n == 0 {
        // EOF (Ctrl-D): stop the flow; nothing past this point was written.
        return Err(crate::errors::cancelled());
    }
    Ok(line.trim().to_string())
}

impl Prompter for TtyPrompter {
    fn text(&mut self, question: &str, hint: &str, default: Option<&str>) -> Result<String> {
        loop {
            if !hint.is_empty() {
                eprintln!("{}", dim(&format!("  {hint}")));
            }
            let shown = match default {
                Some("") => " (optional)".to_string(),
                Some(d) => format!(" [{d}]"),
                None => String::new(),
            };
            eprint!("? {question}{shown} › ");
            std::io::stderr().flush().ok();
            let answer = read_line()?;
            match (answer.is_empty(), default) {
                (false, _) => return Ok(answer),
                (true, Some(d)) => return Ok(d.to_string()),
                (true, None) => eprintln!("  ✗ an answer is required"),
            }
        }
    }

    fn choose(&mut self, question: &str, options: &[&str], default: usize) -> Result<usize> {
        eprintln!("? {question}");
        for (i, o) in options.iter().enumerate() {
            eprintln!("  {}) {o}", i + 1);
        }
        loop {
            eprint!("  › [{}] ", default + 1);
            std::io::stderr().flush().ok();
            let answer = read_line()?;
            if answer.is_empty() {
                return Ok(default);
            }
            match answer.parse::<usize>() {
                Ok(n) if (1..=options.len()).contains(&n) => return Ok(n - 1),
                _ => eprintln!("  ✗ type a number from 1 to {}", options.len()),
            }
        }
    }

    fn secret(&mut self, question: &str, hint: &str) -> Result<Secret> {
        if !hint.is_empty() {
            eprintln!("{}", dim(&format!("  {hint}")));
        }
        loop {
            let value = rpassword::prompt_password(format!("? {question} › "))
                .context("reading the secret from the terminal")?;
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Ok(Secret::new(value));
            }
            eprintln!("  ✗ an answer is required");
        }
    }

    fn confirm(&mut self, question: &str, default: bool) -> Result<bool> {
        let shown = if default { "[Y/n]" } else { "[y/N]" };
        loop {
            eprint!("? {question} {shown} ");
            std::io::stderr().flush().ok();
            match read_line()?.to_ascii_lowercase().as_str() {
                "" => return Ok(default),
                "y" | "yes" => return Ok(true),
                "n" | "no" => return Ok(false),
                _ => eprintln!("  ✗ answer y or n"),
            }
        }
    }
}

/// A prompter that answers from a script, for tests of prompt flows.
#[cfg(test)]
pub struct Scripted {
    answers: std::collections::VecDeque<String>,
    /// Every question asked, in order.
    pub asked: Vec<String>,
}

#[cfg(test)]
impl Scripted {
    pub fn new(answers: &[&str]) -> Self {
        Self {
            answers: answers.iter().map(|s| (*s).to_string()).collect(),
            asked: Vec::new(),
        }
    }

    fn next(&mut self, question: &str) -> Result<String> {
        self.asked.push(question.to_string());
        self.answers
            .pop_front()
            .with_context(|| format!("script ran out of answers at {question:?}"))
    }
}

#[cfg(test)]
impl Prompter for Scripted {
    fn text(&mut self, question: &str, _hint: &str, default: Option<&str>) -> Result<String> {
        let a = self.next(question)?;
        Ok(match (a.is_empty(), default) {
            (true, Some(d)) => d.to_string(),
            _ => a,
        })
    }

    fn choose(&mut self, question: &str, options: &[&str], default: usize) -> Result<usize> {
        let a = self.next(question)?;
        if a.is_empty() {
            return Ok(default);
        }
        let n: usize = a.parse().context("scripted choice")?;
        anyhow::ensure!((1..=options.len()).contains(&n), "choice {n} out of range");
        Ok(n - 1)
    }

    fn secret(&mut self, question: &str, _hint: &str) -> Result<Secret> {
        Ok(Secret::new(self.next(question)?))
    }

    fn confirm(&mut self, question: &str, default: bool) -> Result<bool> {
        let a = self.next(question)?;
        Ok(match a.as_str() {
            "" => default,
            other => other.starts_with('y'),
        })
    }
}
