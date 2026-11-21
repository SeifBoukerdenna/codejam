"""Who is making the request.

DECISION: no real login for the demo. The UI's user switcher sends the chosen user_id in an X-User-Id header.
Step 3 adds can(user, action, resource) here, the single place where permissions are checked.
"""

from fastapi import Depends, Header

from app.db import get_conn


def current_user(x_user_id: str | None = Header(default=None), conn=Depends(get_conn)) -> dict | None:
    """The user row for the X-User-Id header, or None when nobody is picked yet."""
    if not x_user_id:
        return None
    return conn.execute("SELECT * FROM users WHERE user_id = %s", (x_user_id,)).fetchone()
