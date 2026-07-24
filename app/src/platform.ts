// platform.ts — platform detection (`IS_MAC`), used for the End-chat button's
// shortcut hint. jam runs in a plain browser, so it sniffs the user agent
// (`navigator.platform` is deprecated, hence `userAgent`). Just the one split jam
// needs.

export const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
