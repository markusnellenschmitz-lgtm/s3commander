//! Anwendungsfälle. Sprechen nur über Ports mit der Außenwelt.

pub mod cancel;
pub mod connection;
pub mod connections;
pub mod copy;
pub mod deletion;
pub mod details;
pub mod download;
pub mod error;
pub mod folders;
pub mod listing;
pub mod local_browse;
pub mod naming;
pub mod parts;
pub mod relay;
pub mod settings;
pub mod share;
pub mod sync;
pub mod transfers;
pub mod upload;
pub mod windows;

#[cfg(test)]
pub(crate) mod test_support;
