// lib/version.js — the build tag that lands in every run record.
//
// package.json is the single source of truth; a test asserts this constant
// agrees with it, so the two cannot drift. The tag exists because the run
// history outlives the code: without it, "batch mode is worse than step mode"
// cannot be told apart from "the app was different three revisions ago".

export const APP_VERSION = '0.4.0';
