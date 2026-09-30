//! Test support shared with the other crates' tests (feature `test-support`) and built into
//! forge-core's own tests. Never part of a release build.
//!
//! - [`rc1`] — judge document properties against the generated RC1 contracts (rs-dpp
//!   document-property validation), and the conformance tests over the rc1 vectors and the
//!   Rust builders.

pub mod rc1;
