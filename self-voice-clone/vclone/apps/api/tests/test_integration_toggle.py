import os
import unittest


@unittest.skipUnless(os.environ.get("RUN_VOXCPM_INTEGRATION") == "1", "Set RUN_VOXCPM_INTEGRATION=1 to enable integration tests.")
class IntegrationToggleTests(unittest.TestCase):
    def test_toggle_present(self):
        self.assertEqual(os.environ.get("RUN_VOXCPM_INTEGRATION"), "1")


if __name__ == "__main__":
    unittest.main()