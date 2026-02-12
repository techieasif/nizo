(() => {
const chrome: any = (globalThis as any).chrome;

type NizoAction =
  | "getRawStacktracePrompt"
  | "openReplay"
  | "getUserDetails"
  | "getReplayErrors"
  | "getReplayNetworkErrors";

type ContentResponse = {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
};

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const detailsEl = document.getElementById("details") as HTMLPreElement;
const copyDetailsBtn = document.getElementById("copyDetails") as HTMLButtonElement;
const actionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".action")
);

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setDetails(value: unknown): void {
  if (!value) {
    detailsEl.textContent = "";
    copyDetailsBtn.disabled = true;
    return;
  }
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  detailsEl.textContent = rendered;
  copyDetailsBtn.disabled = rendered.trim().length === 0;
}

function setLoading(isLoading: boolean): void {
  for (const button of actionButtons) {
    button.disabled = isLoading;
  }
}

function getActiveTab(): Promise<{ id: number; url?: string }> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(
      { active: true, currentWindow: true },
      (tabs: Array<{ id?: number; url?: string }>) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) {
          reject(new Error("Open a Sentry issue tab first."));
          return;
        }
        resolve({ id: tab.id, url: tab.url });
      }
    );
  });
}

function sendMessageToTabOnce(tabId: number, action: NizoAction): Promise<ContentResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "NIZO_ACTION", action },
      (response: ContentResponse) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "Unable to message tab."));
          return;
        }
        resolve(response);
      }
    );
  });
}

function injectContentScript(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["content.js"]
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(
            new Error(
              chrome.runtime.lastError.message ||
                "Unable to inject Nizo script into this tab."
            )
          );
          return;
        }
        resolve();
      }
    );
  });
}

async function sendMessageToTab(tabId: number, action: NizoAction): Promise<ContentResponse> {
  try {
    return await sendMessageToTabOnce(tabId, action);
  } catch {
    await injectContentScript(tabId);
    return sendMessageToTabOnce(tabId, action);
  }
}

function openTab(url: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.create({ url }, () => resolve());
  });
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function isSentryTab(url?: string): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const hostLooksLikeSentry =
      parsed.hostname === "sentry.io" ||
      parsed.hostname.endsWith(".sentry.io") ||
      parsed.hostname.includes("sentry");
    const pathLooksRelevant = /\/(organizations\/[^/]+\/)?(issues|replays)\//.test(
      parsed.pathname
    );
    return hostLooksLikeSentry || pathLooksRelevant;
  } catch {
    return false;
  }
}

async function runAction(action: NizoAction): Promise<void> {
  setLoading(true);
  setDetails("");
  setStatus("Working...");
  let activeTabUrl: string | undefined;

  try {
    const tab = await getActiveTab();
    activeTabUrl = tab.url;
    if (!isSentryTab(tab.url)) {
      throw new Error("Open a Sentry issue or replay tab first.");
    }

    const response = await sendMessageToTab(tab.id, action);
    if (!response.ok) {
      throw new Error(response.error || "Action failed.");
    }

    const payload = response.data || {};
    if (action === "getRawStacktracePrompt") {
      const prompt = String(payload.prompt || "");
      if (!prompt) {
        throw new Error("Unable to generate prompt from this issue.");
      }
      await copyToClipboard(prompt);
      setStatus("Prompt copied to clipboard.");
      setDetails({
        copiedCharacters: prompt.length,
        issue: payload.issueTitle,
        eventId: payload.eventId
      });
      return;
    }

    if (action === "openReplay") {
      const replayUrl = String(payload.replayUrl || "");
      if (!replayUrl) {
        throw new Error("No replay found for this issue.");
      }
      await openTab(replayUrl);
      setStatus("Replay opened in a new tab.");
      setDetails({
        replayUrl,
        replayId: payload.replayId,
        source: payload.source
      });
      return;
    }

    if (action === "getUserDetails") {
      setStatus("User and device details loaded.");
      setDetails(payload);
      return;
    }

    if (action === "getReplayErrors") {
      const replayUrl = String(payload.replayUrl || "");
      const shouldOpenReplay = Boolean(payload.shouldOpenReplay);
      if (replayUrl && shouldOpenReplay) {
        await openTab(replayUrl);
      }
      setStatus("Replay errors loaded.");
      setDetails(payload);
      return;
    }

    if (action === "getReplayNetworkErrors") {
      const replayUrl = String(payload.replayUrl || "");
      const shouldOpenReplay = Boolean(payload.shouldOpenReplay);
      if (replayUrl && shouldOpenReplay) {
        await openTab(replayUrl);
      }
      setStatus("Replay network errors loaded.");
      setDetails(payload);
      return;
    }

    setStatus("Done.");
    setDetails(payload);
  } catch (error) {
    setStatus("Action failed.");
    setDetails({
      action,
      activeTabUrl: activeTabUrl || null,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    setLoading(false);
  }
}

copyDetailsBtn.addEventListener("click", () => {
  const text = detailsEl.textContent || "";
  if (!text.trim()) {
    return;
  }
  void copyToClipboard(text)
    .then(() => setStatus("Response copied to clipboard."))
    .catch((error) =>
      setStatus(
        `Copy failed: ${error instanceof Error ? error.message : String(error)}`
      )
    );
});
copyDetailsBtn.disabled = true;

for (const button of actionButtons) {
  button.addEventListener("click", () => {
    const action = button.dataset.action as NizoAction | undefined;
    if (!action) {
      return;
    }
    void runAction(action);
  });
}

})();
