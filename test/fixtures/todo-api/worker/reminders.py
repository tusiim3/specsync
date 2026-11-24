"""Background job that emails reminders for todos that are due soon."""
from datetime import datetime, timedelta


def send_due_reminders(todos, mailer, now=None):
    """Email the owner of every todo due within the next 24 hours.

    Runs every 15 minutes from cron.
    """
    now = now or datetime.utcnow()
    window_end = now + timedelta(hours=24)
    sent = 0
    for todo in todos:
        due = todo.get("due_at")
        if due and now <= due <= window_end:
            mailer.send(
                to=todo["owner_email"],
                subject=f"Reminder: {todo['title']} is due soon",
            )
            sent += 1
    return sent


def _format_due(due):
    return due.strftime("%Y-%m-%d %H:%M")
