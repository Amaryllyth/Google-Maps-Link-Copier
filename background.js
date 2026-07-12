chrome.action.onClicked.addListener((tab) => {
    // Ensure it only runs on Google Maps pages
    if (tab.url.includes("google.com") && tab.url.includes("maps")) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: getShortLinkAndCopy
      });
    }
  });
  
  // This function will be injected and executed in the current web page
  async function getShortLinkAndCopy() {
    // 1. Get the title (prioritize the original name in h2)
    let h1 = document.querySelector("h1");
    let name = h1 ? h1.innerText.trim() : document.title.split(" - ")[0].trim();
    if (h1) {
      let p = h1.parentElement;
      let h2 = p.querySelector("h2") || (p.parentElement && p.parentElement.querySelector("h2"));
      if (h2 && h2.innerText.trim() !== "") {
        name = h2.innerText.trim();
      }
    }
  
    // 2. Click the share button (Prefer language-agnostic, fallback to aria-labels)
    let shareBtn = document.querySelector('button[jslog^="13534"],button[aria-label="分享"],button[aria-label="Share"],button[aria-label="共有"]');
    if (!shareBtn) {
      alert("Share button not found. Please make sure the place details are expanded.");
      return;
    }
    shareBtn.click();
  
    // 3. Wait for the short link to be generated (max 4 seconds)
    let shortUrl = "";
    let retries = 20; 
    while (retries > 0) {
      await new Promise(res => setTimeout(res, 200));
      let input = document.querySelector("input[readonly]");
      if (input && input.value.match(/goo\.gl/)) {
        shortUrl = input.value;
        break;
      }
      retries--;
    }
  
    // 4. Close the share dialog (Prefer language-agnostic, fallback to aria-labels)
    let closeBtn = document.querySelector('button[jsaction="modal.close"],button[aria-label="關閉"],button[aria-label="Close"],button[aria-label="閉じる"]');
    if (closeBtn) closeBtn.click();
  
    // 5. Copy to clipboard
    if (shortUrl) {
      // Escape markdown characters in the name
      let safeName = name.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
      let markdownText = `[${safeName}](${shortUrl})`;
      
      // Fallback for when document is not focused
      const copyFallback = (text) => {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";  // Prevent scrolling
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

      navigator.clipboard.writeText(markdownText).then(() => {
        alert(`Copied:\n${markdownText}`);
      }).catch(() => {
        copyFallback(markdownText);
      });
    } else {
      alert("Failed to get short link, please try again.");
    }
  }