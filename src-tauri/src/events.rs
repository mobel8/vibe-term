//! Event name constants used to communicate from the Rust backend to the React frontend.
//! Keeping these centralised avoids typos when emitting / listening from both sides.

pub const PTY_DATA: &str = "pty://data";
pub const PTY_EXIT: &str = "pty://exit";
pub const PTY_BELL: &str = "pty://bell";
pub const PTY_CWD_CHANGE: &str = "pty://cwd_change";

pub const AI_DELTA: &str = "ai://delta";
pub const AI_MESSAGE_COMPLETE: &str = "ai://message_complete";
pub const AI_ERROR: &str = "ai://error";

pub const HOTKEY_TRIGGERED: &str = "hotkey://triggered";
pub const IMAGE_ADDED: &str = "image://added";
pub const CONFIG_CHANGED: &str = "config://changed";
