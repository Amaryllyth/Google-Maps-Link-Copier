chrome.action.onClicked.addListener((tab) => {
  // Ensure it only runs on Google Maps pages (any country domain: .com, .co.jp, .com.tw ...)
  if (tab.url && /^https?:\/\/(www\.)?google\.[^/]+\/maps/.test(tab.url)) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // MAIN world: the new share dialog never puts the short link in the DOM, it
      // only hands it to navigator.clipboard. Catching that call means patching
      // the page's own Clipboard.prototype, which the isolated world can't see.
      world: "MAIN",
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

  // Visible is not enough either: Maps keeps a few role="dialog" nodes on screen
  // at all times (the zoom control, the 0×0 map "reveal" card). Only a modal one
  // — which the share dialog is, old and new — counts as open.
  const SHARE_DIALOG =
    '[aria-modal="true"],[role="alertdialog"],[jslog*="sharekitweb"],:has(button[jsaction*="modal.close"])';
  const openDialog = () =>
    [...document.querySelectorAll(DIALOG)].find((el) => isVisible(el) && el.matches(SHARE_DIALOG)) || null;

  const CLOSE_BTN =
    '#header-close-button,button[jsaction*="modal.close"],button[aria-label="關閉"],button[aria-label="关闭"],' +
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
  // With the search results list open beside the place, the list has its own
  // "分享" button (shares the whole list) that comes first in DOM order. Rank the
  // place's own button (jslog 13534, inside the place pane) ahead of it. Prefer a
  // visible button (Maps keeps hidden panes around), but never let the
  // visibility probe be the reason we find nothing.
  const rank = (btn) =>
    (isVisible(btn) ? 0 : 4) +
    (btn.matches('[jslog^="13534"]') ? 0 : 2) +
    (mainPane && mainPane.contains(btn) ? 0 : 1);
  const shareBtn = shareCandidates.sort((a, b) => rank(a) - rank(b))[0];

  if (!shareBtn) {
    alert("Share button not found. Please make sure the place details are expanded.");
    return;
  }
  // Snapshot the readonly inputs already on the page. Anything that is still
  // showing its pre-click value is a leftover from a previous run, not our link.
  const before = new Map();
  for (const el of document.querySelectorAll("input[readonly]")) before.set(el, el.value);
  const isFresh = (el) => !before.has(el) || before.get(el) !== el.value;

  // The new share dialog ("sharekit") shows only the domain of the short link.
  // The link itself exists only in what its "Copy Link" button passes to the
  // clipboard, so catch those calls (and swallow them — the clipboard is about to
  // get the Markdown link anyway). Restored as soon as the poll below ends.
  const SHORT_URL = /https?:\/\/(?:maps\.app\.)?goo\.gl\/[^\s"'<>]+/;
  let copied = "";
  const clip = window.Clipboard && Clipboard.prototype;
  const origClip = clip && { write: clip.write, writeText: clip.writeText };
  const onCopy = (e) => {
    // execCommand("copy") path: the page fills clipboardData or selects a field.
    const el = document.activeElement;
    copied =
      (e.clipboardData && e.clipboardData.getData("text/plain")) ||
      (el && el.value != null ? el.value.slice(el.selectionStart, el.selectionEnd) : "") ||
      String(getSelection());
  };
  if (clip) {
    clip.writeText = async function (data) {
      copied = String(data);
    };
    clip.write = async function (items) {
      for (const item of items || []) {
        if (item.types.includes("text/plain")) copied = await (await item.getType("text/plain")).text();
      }
    };
  }
  window.addEventListener("copy", onCopy);

  const COPY_LINK = /copy|複製|复制|コピー|복사|copiar|copier|kopieren|copia|копир/i;
  let copyClickedAt = 0;

  shareBtn.click();

  // 3. Wait for the short link to be generated (poll every 100ms, max 6 seconds).
  //    New UI: click the dialog's "Copy Link" and read what it copies. Old UI:
  //    read the dialog's readonly input — prefer the dialog's own, but fall back
  //    to a page-wide search in case Maps renders the share panel without a
  //    dialog role; timing out would be far worse, and isFresh keeps it honest.
  let shortUrl = "";
  try {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(100);

      const hit = copied.match(SHORT_URL);
      if (hit) {
        shortUrl = hit[0];
        break;
      }

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

      // Re-click only if a copy produced no short link (e.g. clicked before the
      // link was generated), and not more often than every 500ms.
      if (Date.now() - copyClickedAt < 500) continue;
      const copyBtn = [
        ...(dialog || document).querySelectorAll('[data-skw-id="app-sharing"] [role="button"]')
      ].find((el) => COPY_LINK.test(`${el.id} ${text(el)}`));
      if (copyBtn) {
        copied = "";
        copyClickedAt = Date.now();
        copyBtn.click();
      }
    }
  } finally {
    if (clip) Object.assign(clip, origClip);
    window.removeEventListener("copy", onCopy);
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
