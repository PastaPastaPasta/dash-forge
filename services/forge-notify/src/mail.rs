//! Email: plain text only, with one-click unsubscribe (RFC 8058) on every notification.
//!
//! Every mail carries `Auto-Submitted: auto-generated` (RFC 3834) so autoresponders stay quiet,
//! `List-Id`, and on notifications and digests `List-Unsubscribe: <https://…/u/TOKEN>` with
//! `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so a mail client's unsubscribe button
//! works with one POST and no login (the token is the authority, [`crate::crypto::Vault`]).

use std::future::Future;
use std::pin::Pin;

use lettre::message::header::{ContentType, HeaderName, HeaderValue};
use lettre::message::Mailbox;
use lettre::{AsyncSmtpTransport, Message, Tokio1Executor};

use forge_relay::sinks::send::{smtp_send, smtp_transport, AutoSubmitted, SendError};
use forge_relay::sinks::SmtpTarget;

/// One mail to one address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mail {
    /// The recipient.
    pub to: String,
    /// The subject (one line).
    pub subject: String,
    /// The plain-text body.
    pub text: String,
    /// The one-click unsubscribe URL (notifications and digests; not the confirmation mail).
    pub unsubscribe: Option<String>,
}

/// A boxed send future.
pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), SendError>> + Send + 'a>>;

/// Sends mail.
pub trait Mailer: Send + Sync {
    /// Send one mail.
    fn send<'a>(&'a self, mail: &'a Mail) -> SendFuture<'a>;
}

/// Mail over SMTP.
pub struct SmtpMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    list_id: String,
}

impl SmtpMailer {
    /// A mailer for `target` (its `to` is unused); `operator` names the list.
    pub fn new(target: &SmtpTarget, operator: &str) -> Result<Self, String> {
        Ok(Self {
            transport: smtp_transport(target)?,
            from: target.from.clone(),
            list_id: format!("Dash Forge notifications <notify.{operator}>"),
        })
    }

    /// Whether the SMTP server answers (for readiness).
    pub async fn test_connection(&self) -> bool {
        self.transport.test_connection().await.unwrap_or(false)
    }
}

fn raw(name: &'static str, value: String) -> HeaderValue {
    HeaderValue::new(HeaderName::new_from_ascii_str(name), value)
}

/// Build the message (pure; tested offline).
pub fn build(mail: &Mail, from: &Mailbox, list_id: &str) -> Result<Message, SendError> {
    let to: Mailbox = mail
        .to
        .parse()
        .map_err(|_| SendError::Permanent("the recipient is not an address".into()))?;
    let mut b = Message::builder()
        .from(from.clone())
        .to(to)
        .subject(one_line(&mail.subject))
        .header(ContentType::TEXT_PLAIN)
        .header(AutoSubmitted)
        .raw_header(raw("List-Id", one_line(list_id)));
    if let Some(u) = &mail.unsubscribe {
        b = b
            .raw_header(raw("List-Unsubscribe", format!("<{}>", one_line(u))))
            .raw_header(raw(
                "List-Unsubscribe-Post",
                "List-Unsubscribe=One-Click".to_string(),
            ));
    }
    b.body(mail.text.clone())
        .map_err(|e| SendError::Permanent(format!("building the mail: {e}")))
}

/// `s` with every control character (CR and LF included) replaced by a space: a header value
/// can never start a new header.
pub fn one_line(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

impl Mailer for SmtpMailer {
    fn send<'a>(&'a self, mail: &'a Mail) -> SendFuture<'a> {
        Box::pin(async move {
            let message = build(mail, &self.from, &self.list_id)?;
            smtp_send(&self.transport, message).await
        })
    }
}

/// A mailer that keeps what it is given (tests and `--dry-run`).
#[derive(Default)]
pub struct CaptureMailer {
    /// The mails sent so far.
    pub sent: std::sync::Mutex<Vec<Mail>>,
}

impl Mailer for CaptureMailer {
    fn send<'a>(&'a self, mail: &'a Mail) -> SendFuture<'a> {
        self.sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(mail.clone());
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_carry_one_click_unsubscribe_and_never_a_second_header() {
        let from: Mailbox = "Dash Forge <notify@example.org>".parse().unwrap();
        let m = Mail {
            to: "a@example.org".into(),
            subject: "[x/y] title\r\nBcc: evil@example.org".into(),
            text: "body".into(),
            unsubscribe: Some("https://notify.example.org/u/TOKEN".into()),
        };
        let wire = String::from_utf8(
            build(&m, &from, "Forge <notify.example.org>")
                .unwrap()
                .formatted(),
        )
        .unwrap();
        assert!(
            wire.contains("List-Unsubscribe: <https://notify.example.org/u/TOKEN>"),
            "{wire}"
        );
        assert!(wire.contains("List-Unsubscribe-Post: List-Unsubscribe=One-Click"));
        assert!(wire.contains("Auto-Submitted: auto-generated"));
        assert!(!wire.contains("\r\nBcc:"), "{wire}");
        assert!(build(
            &Mail {
                to: "nope".into(),
                ..m
            },
            &from,
            "l"
        )
        .is_err());
    }
}
