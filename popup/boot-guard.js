// Boot guard.
//
// Two failure modes previously produced an identical, completely silent
// symptom: a popup that looks fine but where nothing responds.
//
//   1. popup.js (a deferred ES module) never executing, so its listeners are
//      never attached.
//   2. The service worker failing to start, so every runtime.sendMessage
//      rejects and no preview or apply ever completes.
//
// Neither is visible without this file, which is exactly the problem. It must
// be a real script rather than inline, because extension pages run under a
// strict CSP of script-src 'self'.

(function () {
  var BOOT_TIMEOUT = 1500;
  // An MV3 worker is torn down after ~30s idle, so the first PING after any pause
  // pays a full cold start: extension load, worker thread spawn, module
  // evaluation. The old 1200ms budget was inside that startup's variance on a
  // loaded machine, so a healthy worker was reported dead. 5s is comfortably
  // above any realistic cold start while still bounding a genuinely broken one.
  var PING_TIMEOUT = 5000;

  function fail(title, detail) {
    var view = document.getElementById('intakeView');
    if (!view) return;
    // The confirm view holds the operator's in-flight work; leaving it visible
    // next to an error card produces two half-screens with no clear precedence.
    var confirm = document.getElementById('confirmView');
    if (confirm) confirm.hidden = true;
    view.hidden = false;
    view.innerHTML = '';

    var box = document.createElement('div');
    box.className = 'group';
    box.style.margin = '18px';

    var row = document.createElement('div');
    row.className = 'row';
    row.style.flexDirection = 'column';
    row.style.alignItems = 'flex-start';
    row.style.gap = '6px';

    var h = document.createElement('span');
    h.className = 't-title';
    h.style.fontSize = '15px';
    h.textContent = title;

    var d = document.createElement('span');
    d.className = 't-cap';
    d.style.lineHeight = '1.45';
    d.textContent = detail;

    row.appendChild(h);
    row.appendChild(d);
    box.appendChild(row);
    view.appendChild(box);
  }

  // 1. Did the UI script run at all?
  setTimeout(function () {
    if (window.__chromaBooted) return;
    fail(
      'Chroma failed to start',
      'The popup script did not run. Reload the extension from chrome://extensions ' +
      '(the manifest and script layout changed recently), then reopen the popup.'
    );
  }, BOOT_TIMEOUT);

  // 2. Is the service worker answering?
  //
  // One timeout is not conclusive. A worker that was idle-torn-down races the
  // PING while it is still spinning up, and a single slow cold start would
  // otherwise destroy the popup for a worker that is in fact healthy. Retry
  // once before concluding anything; two failures back to back is a real fault.
  function ping(attempt) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      if (attempt < 2) {
        ping(attempt + 1);
        return;
      }
      fail(
        'Engine not responding',
        'The background service worker did not reply. Reload the extension from ' +
        'chrome://extensions and check its error console.'
      );
    }, PING_TIMEOUT);

    Promise.resolve()
      .then(function () { return chrome.runtime.sendMessage({ type: 'PING' }); })
      .then(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
      })
      .catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A rejected send means no listener answered at all, which is a hard
        // failure rather than a slow start -- no point spending another window.
        fail('Engine not responding', String((err && err.message) || err));
      });
  }

  if (window.__chromaBooted) ping(1);
  else setTimeout(function () { ping(1); }, BOOT_TIMEOUT);
})();
