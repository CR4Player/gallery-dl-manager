import tempfile
import unittest
from pathlib import Path

from app.auth import AuthManager
from app.db import Database


class AuthTests(unittest.TestCase):
    def test_setup_login_change_password_and_reset(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "app.db")
            db.init_schema()
            auth = AuthManager(db)

            token = auth.ensure_initialized()
            self.assertIsNotNone(token)
            self.assertFalse(auth.complete_setup("wrong-token", "password123"))
            self.assertTrue(auth.complete_setup(token, "password123"))
            self.assertTrue(auth.is_configured())
            self.assertIsNone(auth.ensure_initialized())

            self.assertTrue(auth.verify_login("password123"))
            self.assertFalse(auth.verify_login("wrong"))

            cookie = auth.create_session_cookie()
            self.assertTrue(auth.verify_session_cookie(cookie))

            # Changing password bumps session version and invalidates old cookie
            self.assertTrue(auth.change_password("password123", "newpass456"))
            self.assertFalse(auth.verify_session_cookie(cookie))
            new_cookie = auth.create_session_cookie()
            self.assertTrue(auth.verify_session_cookie(new_cookie))

            # Reset auth clears password and issues a new setup token
            new_token = auth.reset_web_auth()
            self.assertFalse(auth.is_configured())
            self.assertFalse(auth.verify_session_cookie(new_cookie))
            self.assertTrue(auth.complete_setup(new_token, "resetpass789"))


if __name__ == "__main__":
    unittest.main()
