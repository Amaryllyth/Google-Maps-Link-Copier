chrome.action.onClicked.addListener((tab) => {
  // Ensure it only runs on Google Maps pages (any country domain: .com, .co.jp, .com.tw ...)
  if (tab.url && /^https?:\/\/(www\.)?google\.[^/]+\/maps/.test(tab.url)) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: getShortLinkAndCopy
    });
  }
});

// This function will be injected and executed in the current web page
async function getShortLinkAndCopy() {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const DIALOG = '[role="dialog"],[role="alertdialog"],[aria-modal="true"]';

  // Headings that belong to Maps' own chrome, never to a place.
  const NOT_A_NAME = [
    "共有", "共有する", "分享", "分享地圖", "Share", "공유",
    "Compartir", "Partager", "Teilen", "Condividi", "Compartilhar", "Поделиться",
    "Google マップ", "Google 地圖", "Google 地图", "Google Maps", "Google 지도"
  ];

  const text = (el) => (el ? (el.innerText != null ? el.innerText : el.textContent || "").trim() : "");
  const isName = (t) => !!t && t.length <= 150 && !NOT_A_NAME.includes(t);

  // Excluding content is cheap and safe, so this matches *any* dialog ancestor,
  // hidden ones included.
  const inDialog = (el) => !!(el && el.closest(DIALOG));

  // ...but acting on a dialog must only ever target a visible one. Maps parks
  // hidden dialog nodes in the DOM permanently; treating those as an open share
  // dialog made every run burn the full close-retry budget and made the link
  // poll watch the wrong element until it timed out.
  const isVisible = (el) => {
    if (!el || el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (el.getClientRects && el.getClientRects().length) return true;
    const view = el.ownerDocument.defaultView;
    const cs = view && view.getComputedStyle(el);
    return !cs || (cs.display !== "none" && cs.visibility !== "hidden");
  };

  const openDialog = () => [...document.querySelectorAll(DIALOG)].find(isVisible) || null;

  const CLOSE_BTN =
    'button[jsaction*="modal.close"],button[aria-label="關閉"],button[aria-label="关闭"],' +
    'button[aria-label="Close"],button[aria-label="閉じる"],button[aria-label="닫기"]';

  // One synchronous attempt. Returns true when nothing is left to close.
  const closeOnce = () => {
    const dialog = openDialog();
    if (!dialog) return true;
    const btn = dialog.querySelector(CLOSE_BTN);
    if (btn) {
      btn.click();
    } else {
      for (const type of ["keydown", "keyup"]) {
        document.dispatchEvent(
          new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })
        );
      }
    }
    return false;
  };

  // Bounded sweep, so a dialog we cannot close costs ~400ms instead of stalling.
  const closeDialogs = async (budgetMs = 400) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (closeOnce()) return true;
      if (Date.now() >= deadline) return !openDialog();
      await sleep(50);
    }
  };

  // A leftover share dialog poisons everything: its "共有" heading gets picked up
  // as the place name, and its readonly input still holds the *previous* place's
  // short link. Costs nothing on the normal path, where no dialog is open.
  if (openDialog()) await closeDialogs();

  // 1. Get the title (prioritize the original name in h2)
  const mainPane =
    document.querySelector('div[role="main"][aria-label]:not([aria-label=""])') ||
    document.querySelector('div[role="main"]');

  let h1 =
    (mainPane && [...mainPane.querySelectorAll("h1")].find((el) => text(el))) ||
    [...document.querySelectorAll("h1")].find((el) => !inDialog(el) && text(el)) ||
    null;

  let name = text(h1);

  if (h1) {
    // The local-language original name sits in an h2 immediately after the h1.
    // Search only h1's own parent/grandparent and require the h2 to *follow* the
    // h1 — the old unbounded subtree search matched unrelated headings on
    // coordinate pins, which have no original-name h2 at all.
    const scopes = [h1.parentElement, h1.parentElement && h1.parentElement.parentElement].filter(Boolean);
    for (const scope of scopes) {
      const h2 = [...scope.querySelectorAll("h2")].find(
        (el) =>
          !inDialog(el) &&
          h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING &&
          isName(text(el))
      );
      if (h2) {
        name = text(h2);
        break;
      }
    }
  }

  // Fallbacks, most specific first.
  if (!isName(name)) name = ((mainPane && mainPane.getAttribute("aria-label")) || "").trim();
  if (!isName(name)) name = document.title.replace(/\s+[-–]\s+Google.*$/, "").trim();
  if (!isName(name)) {
    const at = location.pathname.match(/\/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    name = at ? `${at[1]}, ${at[2]}` : "Google Maps";
  }

  // 2. Click the share button (Prefer language-agnostic, fallback to aria-labels)
  const shareCandidates = [
    ...document.querySelectorAll(
      'button[jslog^="13534"],button[aria-label="分享"],button[aria-label="Share"],' +
      'button[aria-label="共有"],button[aria-label="공유"]'
    )
  ].filter((btn) => !inDialog(btn));
  // Prefer a visible button (Maps keeps hidden panes around), but never let the
  // visibility probe be the reason we find nothing.
  const shareBtn = shareCandidates.find(isVisible) || shareCandidates[0];

  if (!shareBtn) {
    alert("Share button not found. Please make sure the place details are expanded.");
    return;
  }
  // Snapshot the readonly inputs already on the page. Anything that is still
  // showing its pre-click value is a leftover from a previous run, not our link.
  const before = new Map();
  for (const el of document.querySelectorAll("input[readonly]")) before.set(el, el.value);
  const isFresh = (el) => !before.has(el) || before.get(el) !== el.value;

  shareBtn.click();

  // 3. Wait for the short link to be generated (poll every 100ms, max 6 seconds).
  //    Prefer the dialog's own input, but fall back to a page-wide search in case
  //    Maps renders the share panel without a dialog role — timing out here would
  //    be far worse than a slightly wider search, and isFresh keeps it honest.
  let shortUrl = "";
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await sleep(100);
    const dialog = openDialog();
    const pool = [
      ...(dialog ? dialog.querySelectorAll("input[readonly]") : []),
      ...document.querySelectorAll("input[readonly]")
    ];
    const input = pool.find((el) => /goo\.gl/.test(el.value) && isFresh(el));
    if (input) {
      shortUrl = input.value.trim();
      break;
    }
  }

  // 4. Close the share dialog. The first attempt is synchronous so focus is back
  //    on the page before the clipboard write; any retries run in the background,
  //    because the copy must not wait on them.
  closeOnce();
  closeDialogs();

  // 5. Copy to clipboard
  if (!shortUrl) {
    alert("Failed to get short link, please try again.");
    return;
  }

  // Escape markdown characters in the name
  const safeName = name.replace(/([\[\]])/g, "\\$1");
  const markdownText = `[${safeName}](${shortUrl})`;

  // Fallback for when document is not focused
  const copyFallback = (text) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed"; // Prevent scrolling
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand("copy");
      alert(`Copied:\n${text}`);
    } catch (err) {
      prompt("Copy failed, please copy manually:", text);
    }
    document.body.removeChild(textArea);
  };

  navigator.clipboard
    .writeText(markdownText)
    .then(() => {
      alert(`Copied:\n${markdownText}`);
    })
    .catch(() => {
      copyFallback(markdownText);
    });
}
