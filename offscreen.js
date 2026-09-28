// The math engine lives in background.js as the single source of truth.
// This document exists only as a host for GPU/canvas work; it computes nothing
// itself and forwards any request so the two paths cannot drift apart.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'COMPUTE_MATRIX') {
    chrome.runtime.sendMessage({
      type: 'COMPUTE_MATRIX',
      payload: message.payload
    }, sendResponse);
  }

  return true;
});
